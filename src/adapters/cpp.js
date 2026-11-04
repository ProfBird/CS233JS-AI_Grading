/**
 * cpp.js
 *
 * The C++ adapter. detectProject prefers CMake, then a Makefile, then falls back to
 * compiling loose .cpp/.cc/.cxx files directly — the common case for intro-level
 * submissions with no build system at all. Only the "loose" path gets structured
 * compiler diagnostics (SARIF from g++/clang, normalized to the shared Diagnostics
 * shape); CMake/Makefile builds are scored on success/failure only, since this adapter
 * doesn't control the compiler flags a student's own build files pass.
 *
 * Execution of the compiled artifact (run_check/test_check) always routes through
 * src/lib/sandbox.js's runStudentArtifact() chokepoint — this adapter never spawns the
 * artifact itself.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
const execFileAsync = util.promisify(execFile);
import { getAllFiles as sharedGetAllFiles } from '../lib/file_walker.js';
import { makeCommentStripper, makeCommentExtractor } from '../lib/comment_stripper.js';
import { aggregateDiagnostics } from '../lib/diagnostics_aggregator.js';

const SOURCE_EXTENSIONS = ['.cpp', '.cc', '.cxx', '.c++'];
const HEADER_EXTENSIONS = ['.h', '.hpp', '.hh'];
const DEFAULT_EXCLUSIONS = ['.git', 'build', 'cmake-build-debug', 'cmake-build-release'];

function compilerBin(config) {
    return (config && config.toolchains && config.toolchains.cpp && config.toolchains.cpp.compiler) || 'g++';
}

function exeName(base) {
    return process.platform === 'win32' ? `${base}.exe` : base;
}

// ---------- Comment stripping ----------
// C++ shares JS's // and /* */ comment syntax and single/double-quoted string literals,
// but ALSO has raw string literals R"delim(...)delim" whose content is arbitrary text —
// a naive quote-matching regex (as used for JS) would misparse quotes/parens inside one.
// Raw strings must be protected before the generic string-literal pass runs.
// Block comments are stripped first (unambiguous delimiters), same rationale as the JS
// adapter. Raw string literals (R"delim(...)delim" — delim is 0-16 chars, excluding
// whitespace/parens/backslash per the C++11 grammar) are protected before ordinary
// single/double-quoted strings and char literals.
const COMMENT_GRAMMAR = {
    blockComment: /\/\*[\s\S]*?\*\//g,
    lineComment: /\/\/[^\n]*/g,
    protectPatterns: [
        /R"([^\s()\\]{0,16})\(([\s\S]*?)\)\1"/g,
        /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g,
    ],
};
const stripComments = makeCommentStripper(COMMENT_GRAMMAR);
const extractComments = makeCommentExtractor(COMMENT_GRAMMAR);

// ---------- File collection ----------
// Matches exclusions against whole path SEGMENTS ("build" as a directory component), not
// a substring anywhere in the path — a submission directory literally named "MyBuildTool"
// (or, as it turns out, a test fixture named "cppbuild-ok-...") must not be excluded just
// because "build" appears somewhere in its name.
function getAllFiles(dirPath, exclusions = DEFAULT_EXCLUSIONS) {
    return sharedGetAllFiles(dirPath, exclusions);
}

// ---------- Project detection ----------
// Header files are scanned for features/lint but are never independently compiled as
// translation units — only .cpp/.cc/.cxx files are passed to the compiler.
function detectProject(dir) {
    const allFiles = getAllFiles(dir);

    const cmakeFile = allFiles.find(f => path.basename(f) === 'CMakeLists.txt');
    if (cmakeFile) {
        const projDir = path.dirname(cmakeFile);
        return [{ dir: projDir, type: 'cmake', buildCommand: null, runCommand: null, artifactPath: null }];
    }

    const makefile = allFiles.find(f => /^(makefile|gnumakefile)$/i.test(path.basename(f)));
    if (makefile) {
        const projDir = path.dirname(makefile);
        return [{ dir: projDir, type: 'makefile', buildCommand: null, runCommand: null, artifactPath: null }];
    }

    const sourceFiles = allFiles.filter(f => SOURCE_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext)));
    if (sourceFiles.length === 0) return [];

    // runCommand is intentionally null — the artifact at artifactPath doesn't exist until
    // build() compiles it. run_check's strategy builds first when runCommand is null and
    // an artifactPath is available, then executes that path — see runtime_check.js.
    const artifactPath = path.join(dir, exeName('a_out'));
    return [{ dir, type: 'loose', buildCommand: null, runCommand: null, artifactPath, sourceFiles }];
}

// ---------- Build ----------

function friendlyRuleName(ruleId) {
    return ruleId && ruleId.startsWith('-W') ? ruleId.slice(2).replace(/-/g, ' ') : (ruleId || 'error');
}

// Parses g++/clang SARIF diagnostics (-fdiagnostics-format=sarif-stderr / =sarif) into the
// shared Diagnostics shape. Falls back to a minimal shape if the output isn't valid SARIF
// (e.g. an older compiler that doesn't support the flag) — success/failure still comes from
// the exit code either way, this only affects whether per-rule detail is available.
function parseSarif(output) {
    // clang wraps the JSON in plain text (a -Wsarif-format-unstable notice before,
    // "N warnings generated." after) — parse just the outermost { ... } span.
    const start = output.indexOf('{'), end = output.lastIndexOf('}');
    if (start === -1 || end < start) return null;
    let doc;
    try { doc = JSON.parse(output.slice(start, end + 1)); } catch (e) { return null; }
    const results = (doc.runs && doc.runs[0] && doc.runs[0].results) || [];

    // "error" and "fatal" both count as errors; "note" isn't emitted as a top-level result.
    return aggregateDiagnostics(results, {
        code: r => r.ruleId || 'error',
        isError: r => r.level !== 'warning',
        friendlyName: friendlyRuleName,
    });
}

// Runs the compiler for a "loose" project and returns BOTH shapes a caller might want:
// { success, diagnostics } where diagnostics is the full Diagnostics object (or null if
// SARIF parsing failed) — build() and lint() each format their own return value from
// this instead of merging the two shapes together (Diagnostics.errors is a *count*;
// the build-result shape's errors is a *string[]* — spreading one into the other would
// silently clobber whichever came second).
// GCC and clang spell the SARIF-to-stderr format value differently: GCC 13+ takes
// "sarif-stderr", clang takes plain "sarif" (and rejects "sarif-stderr" outright, which
// would fail every compile — notably on macOS, where g++ is clang in disguise). Probe
// the compiler's --version once and cache the answer per compiler command.
const sarifFlagCache = new Map();
async function sarifFormatValue(compiler) {
    if (!sarifFlagCache.has(compiler)) {
        let value = 'sarif-stderr';
        try {
            const { stdout } = await execFileAsync(compiler, ['--version'], { timeout: 5000 });
            if (/clang/i.test(stdout)) value = 'sarif';
        } catch (e) { /* missing compiler is preflight()'s job to report; keep the GCC default */ }
        sarifFlagCache.set(compiler, value);
    }
    return sarifFlagCache.get(compiler);
}

// `syntaxOnly` runs -fsyntax-only instead of a full compile+link: it produces the same
// compiler diagnostics without emitting any object file or executable. Used by lint()
// (see below) so a diagnostics-only pass never links a real artifact into the student's
// submission directory — link errors (missing main, unresolved symbols) are a build
// concern, not a lint one, and shouldn't masquerade as lint findings.
async function compileLoose(project, config, { syntaxOnly = false } = {}) {
    const compiler = compilerBin(config);
    const args = syntaxOnly
        ? ['-std=c++17', '-Wall', '-fsyntax-only', `-fdiagnostics-format=${await sarifFormatValue(compiler)}`, ...project.sourceFiles]
        : ['-std=c++17', '-Wall', `-fdiagnostics-format=${await sarifFormatValue(compiler)}`, ...project.sourceFiles, '-o', project.artifactPath];
    try {
        const { stderr } = await execFileAsync(compiler, args, { cwd: project.dir, timeout: 20000 });
        // A successful compile can still emit -Wall warnings on stderr with exit code 0.
        return { success: true, diagnostics: parseSarif((stderr || '').toString()), rawOutput: stderr || '' };
    } catch (err) {
        const rawOutput = (err.stderr || '').toString();
        return { success: false, diagnostics: parseSarif(rawOutput), rawOutput: rawOutput || err.message || 'Compilation failed' };
    }
}

async function build(project, config) {
    if (project.type === 'loose') {
        const { success, diagnostics, rawOutput } = await compileLoose(project, config);
        if (success) {
            return { success: true, errors: [], artifacts: [project.artifactPath], artifactPath: project.artifactPath };
        }
        const errors = diagnostics && diagnostics.errorMessages.length
            ? diagnostics.errorMessages
            : [rawOutput.trim().slice(0, 500) || 'Compilation failed'];
        return { success: false, errors, artifacts: [] };
    }

    if (project.type === 'cmake') {
        const buildDir = path.join(project.dir, 'build');
        try {
            fs.mkdirSync(buildDir, { recursive: true });
            await execFileAsync('cmake', ['-S', project.dir, '-B', buildDir], { timeout: 30000 });
            await execFileAsync('cmake', ['--build', buildDir], { timeout: 30000 });
            return { success: true, errors: [], artifacts: [] };
        } catch (err) {
            return { success: false, errors: [(err.stderr || err.message || 'cmake build failed').toString().trim().slice(0, 500)], artifacts: [] };
        }
    }

    if (project.type === 'makefile') {
        try {
            await execFileAsync('make', [], { cwd: project.dir, timeout: 30000 });
            return { success: true, errors: [], artifacts: [] };
        } catch (err) {
            return { success: false, errors: [(err.stderr || err.message || 'make failed').toString().trim().slice(0, 500)], artifacts: [] };
        }
    }

    return { success: false, errors: [`Unknown project type "${project.type}"`], artifacts: [] };
}

// ---------- Lint (compiler warnings, via the same SARIF path as build) ----------
// C++ has no separate linter in this adapter — compiler warnings ARE the diagnostics
// signal, so lint() re-runs the same compile step build() does (loose projects only)
// and returns its Diagnostics. This lets a lab's "lint" mapping type score compiler
// warnings the same way ESLint warnings are scored for JS.
const EMPTY_DIAGNOSTICS = { errors: 0, warnings: 0, messages: [], errorMessages: [], warningMessages: [], ruleCounts: {} };

async function lint(files, cwd, configOverride, config) {
    if (files.length === 0) return { ...EMPTY_DIAGNOSTICS };
    const sourceFiles = files.filter(f => SOURCE_EXTENSIONS.some(ext => f.toLowerCase().endsWith(ext)));
    if (sourceFiles.length === 0) return { ...EMPTY_DIAGNOSTICS };

    const project = { dir: cwd, type: 'loose', sourceFiles };
    const { diagnostics } = await compileLoose(project, config, { syntaxOnly: true });

    return diagnostics || { ...EMPTY_DIAGNOSTICS };
}

function preflightSync(config) {
    return compilerBin(config);
}

async function preflight(config) {
    try {
        await execFileAsync(preflightSync(config), ['--version'], { timeout: 5000 });
        return { available: true, hint: '' };
    } catch (e) {
        return {
            available: false,
            hint: `C++ compiler not found (tried "${preflightSync(config)}"). Install a compiler (e.g. MSYS2/MinGW-w64 g++) and set config.toolchains.cpp.compiler if it's not on PATH.`,
        };
    }
}

export default {
    language: 'cpp',
    sourceExtensions: [...SOURCE_EXTENSIONS, ...HEADER_EXTENSIONS],
    stripComments,
    extractComments,
    checkManifest: null,        // no dependency-manifest concept for these submissions
    extractUsedPackages: null,  // no package ecosystem to check usage against
    lint,
    lintConfigCandidates: null, // no separate lint config — see the lint() doc comment above
    detectProject,
    install: null,              // nothing to install
    build,
    runScript: null,            // no named-script concept
    runTests: null,             // CTest/GoogleTest integration not implemented yet
    preflight,
};

export { stripComments, detectProject, parseSarif };
