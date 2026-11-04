/**
 * csharp.js
 *
 * The C# adapter. detectProject parses a .sln (which may reference multiple .csproj —
 * a class library + a test project + a console app is a common student layout) or falls
 * back to loose .csproj files; there is no "no project file at all" case the way Python
 * has, since `dotnet new console` always scaffolds a .csproj. Diagnostics come from
 * `dotnet build`'s plain-text MSBuild output (regex-parsed — no XML/binlog dependency
 * needed) and test results from `dotnet test`'s console summary line (same reasoning as
 * the Python adapter's pytest text-summary parsing: no extra TRX/XML parser dependency
 * required for what's fundamentally a "how many passed" question).
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
const execFileAsync = util.promisify(execFile);
import { getAllFiles as sharedGetAllFiles } from '../lib/file_walker.js';
import { makeCommentStripper, makeCommentExtractor } from '../lib/comment_stripper.js';
import { aggregateDiagnostics } from '../lib/diagnostics_aggregator.js';

const DEFAULT_EXCLUSIONS = ['.git', 'bin', 'obj'];

function dotnetBin(config) {
    return (config && config.toolchains && config.toolchains.csharp && config.toolchains.csharp.dotnet) || 'dotnet';
}

// ---------- Comment stripping ----------
// C# shares JS's // and /* */ syntax, but also has verbatim strings (@"..." where ""
// is an escaped quote, NOT the end of the string — a plain quote-matching regex would
// end the match early) and C# 11 raw string literals ("""..."""). Both must be protected
// before the generic quoted-string pass runs, the same ordering principle as cpp.js's
// raw-string handling.
const COMMENT_GRAMMAR = {
    blockComment: /\/\*[\s\S]*?\*\//g,
    lineComment: /\/\/[^\n]*/g,
    protectPatterns: [
        /"""[\s\S]*?"""/g,                                     // raw string literals (C# 11+)
        /[$@]{1,2}"(?:""|[^"])*"/g,                             // verbatim / interpolated-verbatim strings
        /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g,          // ordinary strings and char literals
    ],
};
const stripComments = makeCommentStripper(COMMENT_GRAMMAR);
const extractComments = makeCommentExtractor(COMMENT_GRAMMAR);

// ---------- File collection ----------
// bin/ and obj/ (MSBuild output dirs) are excluded by path SEGMENT, not substring — see
// cpp.js's getAllFiles for why substring matching is the wrong choice here (a submission
// folder literally named "Combinator" would otherwise be excluded for containing "bin").
function getAllFiles(dirPath, exclusions = DEFAULT_EXCLUSIONS) {
    return sharedGetAllFiles(dirPath, exclusions);
}

// ---------- Project detection ----------

// Extracts .csproj paths referenced by a solution file — either the classic .sln text
// format ("Project(...) = ..., "path.csproj", ...") or the newer .slnx XML format
// (<Project Path="path.csproj" />, the .NET SDK's default as of .NET 9/10).
function parseSlnProjects(slnFile) {
    let content;
    try { content = fs.readFileSync(slnFile, 'utf8'); } catch (e) { return []; }
    const slnDir = path.dirname(slnFile);

    const isSlnx = slnFile.toLowerCase().endsWith('.slnx');
    const re = isSlnx
        ? /<Project\s+Path="([^"]+\.csproj)"/g
        : /Project\("\{[^}]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+\.csproj)"/g;

    const matches = [...content.matchAll(re)];
    return matches
        .map(m => path.resolve(slnDir, m[1].replace(/\\/g, path.sep)))
        .filter(p => fs.existsSync(p));
}

function detectProject(dir) {
    const allFiles = getAllFiles(dir);
    const slnFile = allFiles.find(f => /\.slnx?$/i.test(f));

    let csprojFiles;
    if (slnFile) {
        csprojFiles = parseSlnProjects(slnFile);
        if (csprojFiles.length === 0) csprojFiles = allFiles.filter(f => f.toLowerCase().endsWith('.csproj'));
    } else {
        csprojFiles = allFiles.filter(f => f.toLowerCase().endsWith('.csproj'));
    }
    if (csprojFiles.length === 0) return [];

    // `dotnet run --project <csproj>` builds on demand and resolves the output DLL path
    // internally — no need to predict bin/Debug/net{X}.0/{Name}.dll ourselves.
    return csprojFiles.map(csprojPath => ({
        dir: path.dirname(csprojPath),
        type: 'csproj',
        buildCommand: null,
        runCommand: ['dotnet', 'run', '--project', csprojPath],
        artifactPath: null,
        csprojPath,
        // The "class library + console app + test project" layout this adapter's header
        // comment documents means not every .csproj is runnable — a class library or test
        // project has no entry point and `dotnet run` on it fails. run_check picks the
        // first project with executable:true (falling back to projects[0] only when none
        // is tagged, so a solution this can't classify doesn't silently break).
        executable: isExecutableCsproj(csprojPath),
    }));
}

// An SDK-style project defaults to OutputType=Library when the tag is absent (the case for
// class libraries and, conventionally, test projects); a console app template always emits
// an explicit <OutputType>Exe</OutputType> (or WinExe for a GUI app).
function isExecutableCsproj(csprojPath) {
    try {
        const content = fs.readFileSync(csprojPath, 'utf8');
        return /<OutputType>\s*(Exe|WinExe)\s*<\/OutputType>/i.test(content);
    } catch (e) {
        return false;
    }
}

// ---------- Build (MSBuild plain-text diagnostics) ----------

const MSBUILD_DIAG_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Za-z]+\d+):\s+(.+?)\s+\[.+\]$/gm;

function parseMsBuildOutput(output) {
    MSBUILD_DIAG_RE.lastIndex = 0;
    const matches = [...output.matchAll(MSBUILD_DIAG_RE)];
    return aggregateDiagnostics(matches, {
        code: m => m[5],
        isError: m => m[4] !== 'warning',
    });
}

async function runDotnetBuild(project, config) {
    try {
        const { stdout } = await execFileAsync(dotnetBin(config), ['build', '--nologo', project.csprojPath], { cwd: project.dir, timeout: 60000 });
        return { success: true, output: stdout || '' };
    } catch (err) {
        return { success: false, output: (err.stdout || err.stderr || err.message || '').toString() };
    }
}

async function build(project, config) {
    const { success, output } = await runDotnetBuild(project, config);
    if (success) return { success: true, errors: [], artifacts: [] };

    const diagnostics = parseMsBuildOutput(output);
    const errors = diagnostics.errorMessages.length
        ? diagnostics.errorMessages
        : [output.trim().slice(0, 500) || 'dotnet build failed'];
    return { success: false, errors, artifacts: [] };
}

// ---------- Lint (MSBuild warnings, via the same build path) ----------
// Like cpp.js, C# has no separate linter in this adapter — compiler/analyzer warnings
// from `dotnet build` ARE the diagnostics signal.
const EMPTY_DIAGNOSTICS = { errors: 0, warnings: 0, messages: [], errorMessages: [], warningMessages: [], ruleCounts: {} };

async function lint(files, cwd, configOverride, config) {
    if (files.length === 0) return { ...EMPTY_DIAGNOSTICS };
    const projects = detectProject(cwd);
    if (projects.length === 0) return { ...EMPTY_DIAGNOSTICS };

    const { output } = await runDotnetBuild(projects[0], config);
    return parseMsBuildOutput(output);
}

// ---------- Tests (dotnet test console summary) ----------

function parseDotnetTestSummary(output) {
    const summaryMatch = output.match(/Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/);
    if (!summaryMatch) return { total: 0, passed: 0, failures: [] };
    const [, failed, passed, , total] = summaryMatch.map(Number);
    const failures = [...output.matchAll(/^\s*Failed\s+(\S+)\s+\[/gm)].map(m => m[1]);
    return { total, passed, failures, _failed: failed };
}

async function runTests(project, config) {
    try {
        const { stdout } = await execFileAsync(dotnetBin(config), ['test', '--nologo', project.csprojPath], { cwd: project.dir, timeout: 60000 });
        return parseDotnetTestSummary(stdout);
    } catch (err) {
        const output = (err.stdout || '').toString();
        if (/Failed:|Passed:/.test(output)) return parseDotnetTestSummary(output); // failures exit non-zero
        return { total: 0, passed: 0, failures: [], error: 'dotnet test not installed or failed to run' };
    }
}

async function preflight(config) {
    try {
        await execFileAsync(dotnetBin(config), ['--version'], { timeout: 5000 });
        return { available: true, hint: '' };
    } catch (e) {
        return {
            available: false,
            hint: `.NET SDK not found (tried "${dotnetBin(config)}"). Install the .NET SDK and set config.toolchains.csharp.dotnet if it's not on PATH.`,
        };
    }
}

export default {
    language: 'csharp',
    sourceExtensions: ['.cs'],
    stripComments,
    extractComments,
    checkManifest: null,        // NuGet package validation not implemented — .csproj/PackageReference parsing is a future extension
    extractUsedPackages: null,
    lint,
    lintConfigCandidates: null,
    detectProject,
    install: null,              // `dotnet build`/`dotnet run` restore packages implicitly
    build,
    runScript: null,
    runTests,
    preflight,
};

export { stripComments, detectProject, parseMsBuildOutput, parseDotnetTestSummary };
