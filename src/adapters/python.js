/**
 * python.js
 *
 * The Python adapter. Two project styles:
 *   - uv projects (pyproject.toml — CS212's standard, created with `uv init`): dependencies
 *     are installed by `uv sync` into a grader-owned environment cached per distinct
 *     dependency set (see install()), and programs/tests run with that environment's Python.
 *   - loose scripts / requirements.txt: the system interpreter (config.toolchains.python),
 *     with requirements.txt installed by pip.
 * Manifest checking reads pyproject.toml's [project].dependencies (+ [dependency-groups]) or
 * requirements.txt. Lint is ruff (JSON output normalized to the shared diagnostics shape).
 * Build is a syntax-only check via py_compile (Python has no separate compile step; this is
 * the closest equivalent to "does this parse"). Tests run through the sandbox, either via
 * pytest or by running a student's own test script and counting PASS/FAIL lines.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import util from 'util';
const execFileAsync = util.promisify(execFile);
import { getAllFiles as sharedGetAllFiles } from '../lib/file_walker.js';
import { makeCommentStripper, makeCommentExtractor } from '../lib/comment_stripper.js';
import { aggregateDiagnostics } from '../lib/diagnostics_aggregator.js';
import { runStudentArtifact, scrubEnv } from '../lib/sandbox.js';

const DEFAULT_EXCLUSIONS = ['__pycache__', '.venv', 'venv', '.git'];

// Resolves the Python interpreter: config.toolchains.python overrides the per-OS default
// (Windows ships the "py" launcher; POSIX systems conventionally have "python3" on PATH).
function pythonBin(config) {
    return (config && config.toolchains && config.toolchains.python)
        || (process.platform === 'win32' ? 'py' : 'python3');
}

// ---------- Comment stripping ----------
// Python has no block-comment syntax; triple-quoted strings are just string literals
// (sometimes used as docstrings) that must be protected before stripping "#" comments,
// the same way JS's stripComments protects string/template literals before stripping "//".
const COMMENT_GRAMMAR = {
    lineComment: /#[^\n]*/g,
    protectPatterns: [
        /("""[\s\S]*?"""|'''[\s\S]*?''')/g,           // triple-quoted first (may span lines, contain # or quotes)
        /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g, // then single-line quoted strings
    ],
};
const stripComments = makeCommentStripper(COMMENT_GRAMMAR);
// Docstrings count as comment text for comments-only checks (file-header "Author:" blocks).
const extractComments = makeCommentExtractor({ ...COMMENT_GRAMMAR, docPatterns: [COMMENT_GRAMMAR.protectPatterns[0]] });

// ---------- File collection ----------
function getAllFiles(dirPath, exclusions = DEFAULT_EXCLUSIONS) {
    return sharedGetAllFiles(dirPath, exclusions);
}

// ---------- Manifest (requirements.txt) ----------

function parseRequirementsTxt(content) {
    const names = [];
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('-')) continue; // blank/comment/-r,-e flags
        const match = line.match(/^([A-Za-z0-9_.\-]+)/);
        if (match) names.push(match[1].toLowerCase());
    }
    return names;
}

function findRequirementsFiles(dir) {
    return getAllFiles(dir).filter(f => path.basename(f).toLowerCase() === 'requirements.txt');
}

// PEP 503 name normalization: "Scikit_Learn" and "scikit.learn" are both "scikit-learn".
const normalizeDist = name => name.toLowerCase().replace(/[-_.]+/g, '-');

// Distribution (pip/uv) name -> the module name(s) code imports. Anything not listed is
// assumed to import as its name with "-" -> "_" (tensorflow-datasets -> tensorflow_datasets).
// Extend per lab/course with packageCheck.importAliases.
const IMPORT_ALIASES = {
    'scikit-learn': ['sklearn'],
    'scikit-image': ['skimage'],
    'z3-solver': ['z3'],
    'google-genai': ['google'],
    'google-generativeai': ['google'],
    'protobuf': ['google'],
    'python-dotenv': ['dotenv'],
    'python-dateutil': ['dateutil'],
    'beautifulsoup4': ['bs4'],
    'pillow': ['pil'],
    'pyyaml': ['yaml'],
    'opencv-python': ['cv2'],
    'opencv-python-headless': ['cv2'],
    'attrs': ['attr', 'attrs'],
    'mcp': ['mcp'],
};

function importNamesFor(dist, extraAliases = {}) {
    const key = normalizeDist(dist);
    const extra = Object.entries(extraAliases).find(([k]) => normalizeDist(k) === key);
    const names = extra ? [].concat(extra[1]) : (IMPORT_ALIASES[key] || [key.replace(/-/g, '_')]);
    return names.map(n => n.toLowerCase());
}

// The package name at the start of a PEP 508 requirement ("numpy>=2; python_version>'3.9'").
function requirementName(req) {
    const m = req.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    return m ? normalizeDist(m[1]) : null;
}

// Every quoted string inside the TOML array that starts at `text[openIdx]` ("["), honoring
// quotes so a bracket inside a string (an extra like "httpx[cli]") doesn't end the array.
function tomlArrayStrings(text, openIdx) {
    const out = [];
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        const c = text[i];
        if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < text.length && text[j] !== c) { if (text[j] === '\\' && c === '"') j++; j++; }
            out.push(text.slice(i + 1, j));
            i = j;
            continue;
        }
        if (c === '[') depth++;
        else if (c === ']' && --depth === 0) break;
    }
    return out;
}

// Splits TOML text into { "table.name": bodyText } by its [table] headers.
function tomlTables(content) {
    const tables = {};
    let name = '';
    for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*\[{1,2}\s*([^\]]+?)\s*\]{1,2}\s*(#.*)?$/);
        if (m) { name = m[1]; tables[name] = tables[name] || ''; continue; }
        tables[name] = (tables[name] || '') + line + '\n';
    }
    return tables;
}

/**
 * Reads a pyproject.toml's dependency lists — a small reader for exactly these keys, not a
 * general TOML parser.
 * @returns {{ dependencies: string[], devDependencies: string[] }} normalized package names:
 *   [project].dependencies, and everything in [dependency-groups] / [project.optional-dependencies]
 *   (dev tools and extras — declared, but not expected to be imported).
 */
function parsePyprojectDependencies(content) {
    const tables = tomlTables(content);
    const arraysIn = (body, keyRe) => {
        const found = [];
        const re = new RegExp(`^\\s*(${keyRe})\\s*=\\s*\\[`, 'gm');
        let m;
        while ((m = re.exec(body)) !== null) found.push(...tomlArrayStrings(body, m.index + m[0].length - 1));
        return found;
    };
    const names = list => [...new Set(list.map(requirementName).filter(Boolean))];
    const dependencies = names(arraysIn(tables.project || '', 'dependencies'));
    const devDependencies = names([
        ...arraysIn(tables['dependency-groups'] || '', '[A-Za-z0-9_.-]+'),
        ...arraysIn(tables['project.optional-dependencies'] || '', '[A-Za-z0-9_.-]+'),
    ]);
    return { dependencies, devDependencies };
}

// The shallowest pyproject.toml under dir, or null.
function findPyproject(dir) {
    return getAllFiles(dir)
        .filter(f => path.basename(f).toLowerCase() === 'pyproject.toml')
        .sort(byDepthThenName)[0] || null;
}

/**
 * Validates a project's declared dependencies against packageCheckConfig:
 *   dependencies[]   — packages that must be declared
 *   allowedExtras[]  — declared runtime packages that needn't be imported
 *   importAliases{}  — extra distribution -> import-name mappings (see IMPORT_ALIASES)
 * Reads pyproject.toml when there is one (uv projects), else requirements.txt. Runtime
 * dependencies that no source file imports are flagged; dev groups/extras are not.
 */
function checkManifest(dir, packageCheckConfig = {}) {
    let declared, devDeclared = [], manifestName;
    const pyproject = findPyproject(dir);
    if (pyproject) {
        manifestName = 'pyproject.toml';
        try {
            ({ dependencies: declared, devDependencies: devDeclared } = parsePyprojectDependencies(fs.readFileSync(pyproject, 'utf8')));
        } catch (e) {
            return { found: true, passed: false, issues: [`Could not read pyproject.toml: ${e.message}`] };
        }
    } else {
        const reqFiles = findRequirementsFiles(dir);
        if (reqFiles.length === 0) {
            return { found: false, passed: false, issues: ['No pyproject.toml or requirements.txt found'] };
        }
        manifestName = 'requirements.txt';
        declared = [];
        for (const f of reqFiles) {
            try { declared.push(...parseRequirementsTxt(fs.readFileSync(f, 'utf8')).map(normalizeDist)); } catch (e) { /* skip unreadable */ }
        }
        declared = [...new Set(declared)];
    }

    const issues = [];
    const allDeclared = new Set([...declared, ...devDeclared]);
    for (const pkg of packageCheckConfig.dependencies || []) {
        if (!allDeclared.has(normalizeDist(pkg))) issues.push(`"${pkg}" not found in ${manifestName}`);
    }

    const allowedExtras = new Set((packageCheckConfig.allowedExtras || []).map(normalizeDist));
    const aliases = packageCheckConfig.importAliases || {};
    const used = extractUsedPackages(dir);
    for (const pkg of declared) {
        if (allowedExtras.has(pkg)) continue;
        if (!importNamesFor(pkg, aliases).some(n => used.has(n))) {
            issues.push(`extra package "${pkg}" in ${manifestName} is never imported`);
        }
    }

    return { found: true, passed: issues.length === 0, issues };
}

// Extracts top-level module names referenced via "import X" / "from X import Y".
function extractUsedPackages(dir) {
    const pyFiles = getAllFiles(dir).filter(f => f.toLowerCase().endsWith('.py'));
    const used = new Set();
    const patterns = [
        /^\s*import\s+([A-Za-z0-9_]+)/gm,
        /^\s*from\s+([A-Za-z0-9_]+)(?:\.[A-Za-z0-9_.]+)?\s+import\s+/gm,
    ];
    for (const file of pyFiles) {
        let content;
        try { content = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        for (const re of patterns) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(content)) !== null) used.add(m[1].toLowerCase());
        }
    }
    return used;
}

// ---------- Lint (ruff) ----------

// ruff has no built-in ESLint-style error/warning tiering; classify pyflakes issues (F,
// real correctness problems — undefined names, unused imports/vars) and syntax errors
// (E9) as errors, everything else (style/complexity) as warnings — mirroring the JS
// adapter's "no-undef = error, style = warning" split.
function isErrorCode(code) {
    return /^F/.test(code) || /^E9/.test(code);
}

function friendlyRuffName(name, code) {
    return name ? name.replace(/-/g, ' ') : code;
}

async function lint(files, cwd, configOverride, config) {
    if (files.length === 0) return { errors: 0, warnings: 0, messages: [], errorMessages: [], warningMessages: [], ruleCounts: {} };

    const args = ['-m', 'ruff', 'check', '--output-format', 'json'];
    if (configOverride) args.push('--config', configOverride);
    args.push(...files);

    let stdout;
    try {
        const result = await execFileAsync(pythonBin(config), args, { cwd, timeout: 20000 });
        stdout = result.stdout;
    } catch (err) {
        // ruff exits non-zero when it finds issues — that's success, not failure; the
        // diagnostics are still on stdout. A genuine invocation failure has no JSON stdout.
        stdout = err.stdout;
        if (!stdout) {
            return { errors: 0, warnings: 0, messages: ['ruff not installed or failed to run'], errorMessages: [], warningMessages: [], ruleCounts: {}, toolError: 'ruff not installed or failed to run' };
        }
    }

    let issues;
    try { issues = JSON.parse(stdout); } catch (e) {
        return { errors: 0, warnings: 0, messages: ['Could not parse ruff output'], errorMessages: [], warningMessages: [], ruleCounts: {}, toolError: 'Could not parse ruff output' };
    }

    const nameByCode = {};
    for (const issue of issues) nameByCode[issue.code] = issue.name;

    return aggregateDiagnostics(issues, {
        code: issue => issue.code || 'unknown',
        isError: issue => isErrorCode(issue.code || 'unknown'),
        friendlyName: code => friendlyRuffName(nameByCode[code], code),
    });
}

function lintConfigCandidates(configsDir, labName, parentName, courseName = null, repoRootOverride = null) {
    const repoRoot = repoRootOverride || path.join(configsDir, '..');
    const labConfigsDir = courseName ? path.join(configsDir, courseName) : configsDir;
    const candidates = [];
    if (parentName) candidates.push(path.join(labConfigsDir, parentName, labName, 'ruff.toml'));
    candidates.push(path.join(labConfigsDir, labName, 'ruff.toml'));
    // Course-wide ruleset (configs/{Course}/ruff.toml), e.g. CS212's naming/import-order rules.
    if (courseName) candidates.push(path.join(labConfigsDir, 'ruff.toml'));
    candidates.push(path.join(repoRoot, 'python', 'student.ruff.toml'));
    return candidates;
}

// ---------- Project detection / install / build ----------

// Shallowest-first, then alphabetical — deterministic regardless of directory-walk order.
const byDepthThenName = (a, b) =>
    a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b);

/**
 * Picks the program to run. `entry` (config.runCheck.entry / testCheck.entry) is a path
 * relative to the project folder ("src/main.py"), a bare filename found anywhere under it
 * ("scheduler.py"), or a list of those tried in order — for when students name the same
 * program differently (["shipping_calculator.py", "shipping_cost.py"]). Without one:
 * main.py (exact filename — not e.g. "domain.py"), else the only .py file, else the
 * shallowest .py file, flagged as a guess.
 * @returns {{ path: string|null, guessed: boolean, error?: string }}
 */
function resolveEntry(projectDir, pyFiles, entry) {
    const sorted = [...pyFiles].sort(byDepthThenName);
    const findOne = candidate => {
        if (/[\\/]/.test(candidate)) {
            const p = path.join(projectDir, candidate);
            return fs.existsSync(p) ? p : null;
        }
        return sorted.find(f => path.basename(f).toLowerCase() === candidate.toLowerCase()) || null;
    };
    if (entry) {
        const candidates = Array.isArray(entry) ? entry : [entry];
        for (const c of candidates) {
            const found = findOne(c);
            if (found) return { path: found, guessed: false };
        }
        const error = candidates.length === 1
            ? `Entry file "${candidates[0]}" not found`
            : `None of the entry files were found (${candidates.map(c => `"${c}"`).join(', ')})`;
        return { path: null, guessed: false, error };
    }
    const main = sorted.find(f => path.basename(f).toLowerCase() === 'main.py');
    if (main) return { path: main, guessed: false };
    return { path: sorted[0] || null, guessed: sorted.length > 1 };
}

// A Python "project" is any directory containing .py files, whether or not it has a
// requirements.txt or pyproject.toml — plenty of intro-level submissions are loose scripts
// with no packaging at all. The project folder (what a program's relative paths like
// "Data/x.csv" are relative to) is the folder holding pyproject.toml (uv projects, CS212's
// standard), else the folder holding the entry file.
function detectProject(dir, config = {}) {
    const allPy = getAllFiles(dir).filter(f => f.toLowerCase().endsWith('.py'));
    if (allPy.length === 0) return [];

    const pyprojects = getAllFiles(dir)
        .filter(f => path.basename(f).toLowerCase() === 'pyproject.toml')
        .sort(byDepthThenName);
    const uvRoot = pyprojects.length ? path.dirname(pyprojects[0]) : null;
    // Within a uv project, only its own .py files are candidates for the entry point.
    const pyFiles = uvRoot ? allPy.filter(f => f.startsWith(uvRoot + path.sep)) : allPy;

    const entryInfo = resolveEntry(uvRoot || dir, pyFiles.length ? pyFiles : allPy, config.runCheck && config.runCheck.entry);
    const projectDir = uvRoot || (entryInfo.path ? path.dirname(entryInfo.path) : dir);
    const reqFiles = findRequirementsFiles(dir);

    return [{
        dir: projectDir,
        type: uvRoot ? 'python-uv' : (reqFiles.length ? 'python-requirements' : 'python-loose'),
        buildCommand: null, // build() runs py_compile per-file; no single "build" argv
        // The interpreter (argv[0]) is replaced by install() with the project's own
        // environment's Python when it builds one (uv projects).
        runCommand: entryInfo.path ? [pythonBin(config), entryInfo.path] : null,
        entry: entryInfo.path ? path.relative(projectDir, entryInfo.path) : null,
        entryGuessed: entryInfo.guessed,
        entryError: entryInfo.error || null,
        artifactPath: null, // interpreted — no build artifact to point at
    }];
}

// ---------- uv environments ----------

// uv: config.toolchains.uv (a command or full path) overrides "uv" on PATH.
function uvBin(config) {
    return (config && config.toolchains && config.toolchains.uv) || 'uv';
}

// A virtual environment's own interpreter — Scripts\python.exe on Windows, bin/python elsewhere.
function envPython(envDir, platform = process.platform) {
    return platform === 'win32'
        ? path.join(envDir, 'Scripts', 'python.exe')
        : path.join(envDir, 'bin', 'python');
}

// The files that decide what `uv sync` installs. Two students with identical copies share one
// environment (most of a class submits the instructor's pyproject.toml unchanged).
const UV_ENV_FILES = ['pyproject.toml', 'uv.lock', '.python-version'];

function uvEnvKey(projectDir) {
    const hash = crypto.createHash('sha256');
    for (const name of UV_ENV_FILES) {
        const p = path.join(projectDir, name);
        hash.update(`\0${name}\0`);
        if (fs.existsSync(p)) hash.update(fs.readFileSync(p));
    }
    return hash.digest('hex').slice(0, 16);
}

const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000; // TensorFlow-sized installs take minutes
const ENV_READY_MARKER = '.grader-env-ready';

/**
 * Builds (or reuses) the environment for a uv project. `uv sync --no-install-project` runs in
 * a scratch folder holding only UV_ENV_FILES, never in the student's submission — syncing there
 * would write uv.lock/.venv into it (and an untracked uv.lock can break --regrade's git pull).
 * The environment lives at <envCacheDir>/<hash of UV_ENV_FILES>, set via
 * UV_PROJECT_ENVIRONMENT; a marker file records a completed sync so later students with the
 * same files reuse it. Not --locked: students' uv.lock files are often stale, and refreshing
 * the scratch copy is harmless.
 *   config.execution.envCacheDir     — cache root (default: <tmp>/grader-python-envs)
 *   config.execution.installTimeoutMs — uv sync timeout (default 10 minutes)
 * @returns {Promise<{success: boolean, errors: string[], python?: string}>}
 */
async function installUvEnv(project, config = {}) {
    const execution = config.execution || {};
    const cacheRoot = execution.envCacheDir || path.join(os.tmpdir(), 'grader-python-envs');
    const envDir = path.join(cacheRoot, uvEnvKey(project.dir));
    const python = envPython(envDir);
    if (fs.existsSync(path.join(envDir, ENV_READY_MARKER)) && fs.existsSync(python)) {
        return { success: true, errors: [], python };
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'grader-uv-sync-'));
    try {
        for (const name of UV_ENV_FILES) {
            const p = path.join(project.dir, name);
            if (fs.existsSync(p)) fs.copyFileSync(p, path.join(scratch, name));
        }
        fs.mkdirSync(cacheRoot, { recursive: true });
        await execFileAsync(uvBin(config), ['sync', '--no-install-project'], {
            cwd: scratch,
            env: { ...scrubEnv(process.env), UV_PROJECT_ENVIRONMENT: envDir },
            timeout: execution.installTimeoutMs || DEFAULT_INSTALL_TIMEOUT_MS,
            maxBuffer: 20 * 1024 * 1024,
        });
        fs.writeFileSync(path.join(envDir, ENV_READY_MARKER), new Date().toISOString());
        return { success: true, errors: [], python };
    } catch (err) {
        if (err.code === 'ENOENT') {
            return { success: false, errors: [`uv not found (tried "${uvBin(config)}") — install uv or set toolchains.uv`] };
        }
        const detail = (err.killed ? 'timed out' : (err.stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' | ')).slice(0, 400);
        return { success: false, errors: [`uv sync failed: ${detail}`] };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

async function install(project, config) {
    if (project.type === 'python-uv') {
        const result = await installUvEnv(project, config);
        if (result.success) {
            // Run programs/tests with the project's own environment from here on.
            project.python = result.python;
            if (project.runCommand) project.runCommand = [result.python, ...project.runCommand.slice(1)];
        }
        return result;
    }
    const reqFiles = findRequirementsFiles(project.dir);
    if (reqFiles.length === 0) return { success: true, errors: [] }; // nothing to install
    try {
        await execFileAsync(pythonBin(config), ['-m', 'pip', 'install', '-r', reqFiles[0]], { cwd: project.dir, timeout: 60000 });
        return { success: true, errors: [] };
    } catch (err) {
        return { success: false, errors: ['pip install failed or timed out'] };
    }
}

// Syntax-only check (py_compile does not execute the module). This is the closest
// Python equivalent to a "build" — there is no compilation step to run instead.
async function build(project, config) {
    const pyFiles = getAllFiles(project.dir).filter(f => f.toLowerCase().endsWith('.py'));
    if (pyFiles.length === 0) return { success: false, errors: ['No .py files found'], artifacts: [] };

    const errors = [];
    for (const file of pyFiles) {
        try {
            await execFileAsync(pythonBin(config), ['-m', 'py_compile', file], { cwd: project.dir, timeout: 10000 });
        } catch (err) {
            const msg = (err.stderr || err.message || '').toString().trim().slice(0, 300);
            errors.push(`${path.relative(project.dir, file)}: ${msg}`);
        }
    }
    return { success: errors.length === 0, errors, artifacts: [] };
}

// ---------- Tests (pytest) ----------

// Parses pytest's default text summary line, e.g. "3 passed, 1 failed in 0.42s" or
// "5 passed in 0.10s". No pytest-json-report dependency required.
function parsePytestSummary(output) {
    const passedMatch = output.match(/(\d+)\s+passed/);
    const failedMatch = output.match(/(\d+)\s+failed/);
    const errorMatch = output.match(/(\d+)\s+error/);
    const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    const failed = (failedMatch ? parseInt(failedMatch[1], 10) : 0) + (errorMatch ? parseInt(errorMatch[1], 10) : 0);
    const failures = [...output.matchAll(/^FAILED\s+(.+)$/gm)].map(m => m[1].trim());
    return { total: passed + failed, passed, failures };
}

// ---------- Tests ----------

// Default PASS/FAIL line patterns for testCheck.mode "script" — the format CS212's Lab02
// test-driver example prints ("PASS: test_name" / "FAIL: test_name").
const DEFAULT_PASS_PATTERN = '^\\s*PASS\\b';
const DEFAULT_FAIL_PATTERN = '^\\s*FAIL\\b';

const lastLine = text => (text || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';

/**
 * Scores a student's own test script from its output: one passed test per line matching
 * passPattern, one failure per line matching failPattern. A run that crashes (a Python
 * traceback), times out, or exits non-zero without printing any FAIL line counts as one more
 * failure, since tests after the crash never ran. With no PASS/FAIL lines at all, the script
 * counts as a single test: passed if it exited 0.
 */
function parseScriptTestOutput(result, testCheck = {}) {
    if (result.setupError) return { total: 0, passed: 0, failures: [], error: result.stderr };
    const stdout = result.stdout || '';
    const lines = stdout.split(/\r?\n/);
    const passRe = new RegExp(testCheck.passPattern || DEFAULT_PASS_PATTERN);
    const failRe = new RegExp(testCheck.failPattern || DEFAULT_FAIL_PATTERN);
    const passed = lines.filter(l => passRe.test(l)).length;
    const failures = lines.filter(l => failRe.test(l)).map(l => l.trim());

    let crash = null;
    if (result.timedOut) crash = 'Test run timed out';
    else if (result.code !== 0 && (/Traceback \(most recent call last\)/.test(result.stderr || '') || failures.length === 0)) {
        crash = `Test run ended with an error (exit code ${result.code})${lastLine(result.stderr) ? `: ${lastLine(result.stderr).slice(0, 200)}` : ''}`;
    }

    if (passed + failures.length === 0) {
        return crash ? { total: 1, passed: 0, failures: [crash] } : { total: 1, passed: 1, failures: [] };
    }
    if (crash) failures.push(crash);
    return { total: passed + failures.length, passed, failures };
}

// pytest isn't usually one of a student's own dependencies; add it to a uv project's (grader-
// owned, cached) environment the first time pytest mode needs it.
async function ensurePytest(project, config) {
    const python = project.python || pythonBin(config);
    try {
        await execFileAsync(python, ['-c', 'import pytest'], { timeout: 30000 });
        return null;
    } catch (e) { /* not installed */ }
    if (project.type !== 'python-uv') return `pytest is not installed for ${python}`;
    try {
        await execFileAsync(uvBin(config), ['pip', 'install', '--python', python, 'pytest'], {
            env: scrubEnv(process.env),
            timeout: (config.execution && config.execution.installTimeoutMs) || DEFAULT_INSTALL_TIMEOUT_MS,
        });
        return null;
    } catch (e) {
        return `Could not install pytest: ${lastLine(e.stderr || e.message)}`;
    }
}

/**
 * Runs a project's tests through the sandbox, in a copy of the project folder (tests always
 * need their own files around them). config.testCheck:
 *   mode:        "pytest" (default) or "script" — run a student's own test script (entry)
 *                and count its PASS/FAIL lines (see parseScriptTestOutput)
 *   entry:       the test script for "script" mode (path or bare filename, like runCheck.entry)
 *   passPattern / failPattern: regex sources for "script" mode's line counting
 *   timeoutMs:   default execution.timeoutMs, else 60 s
 * @param {object} execOptions - sandbox options from runtime_check.js (mode, support files, env)
 */
async function runTests(project, config = {}, execOptions = {}) {
    const testCheck = config.testCheck || {};
    const python = project.python || pythonBin(config);
    const sandboxOptions = {
        ...execOptions,
        cwdSource: project.dir,
        timeoutMs: testCheck.timeoutMs || (config.execution && config.execution.timeoutMs) || 60000,
    };

    if (testCheck.mode === 'script') {
        const pyFiles = getAllFiles(project.dir).filter(f => f.toLowerCase().endsWith('.py'));
        const entry = resolveEntry(project.dir, pyFiles, testCheck.entry);
        // A missing test script may just be named differently — the grader should look.
        if (!entry.path) return { total: 0, passed: 0, failures: [], error: `NEEDS MANUAL CHECK: ${entry.error || 'no test script found'}` };
        const result = await runStudentArtifact([python, path.relative(project.dir, entry.path)], sandboxOptions);
        return parseScriptTestOutput(result, testCheck);
    }

    const pytestError = await ensurePytest(project, config);
    if (pytestError) return { total: 0, passed: 0, failures: [], error: pytestError };
    const result = await runStudentArtifact([python, '-m', 'pytest', '-v', '-p', 'no:cacheprovider'], sandboxOptions);
    if (result.setupError) return { total: 0, passed: 0, failures: [], error: result.stderr };
    const output = result.stdout || '';
    if (/no tests ran|collected 0 items/i.test(output)) return { total: 0, passed: 0, failures: [] };
    // pytest exits non-zero when tests fail — the summary is still valid
    if (/passed|failed|error/.test(output)) return parsePytestSummary(output);
    return { total: 0, passed: 0, failures: [], error: result.timedOut ? 'pytest timed out' : `pytest failed to run: ${lastLine(result.stderr)}` };
}

// Checks the Python interpreter (required) and, when this lab runs or tests student programs,
// uv (needed for uv projects — a warning, not a failure, since loose scripts don't need it).
async function preflight(config = {}) {
    try {
        await execFileAsync(pythonBin(config), ['--version'], { timeout: 5000 });
    } catch (e) {
        return { available: false, hint: `Python interpreter not found (tried "${pythonBin(config)}"). Set config.toolchains.python to the correct command.` };
    }
    const runsCode = config.runtimeCheck === 'run_check' || (config.mappings || []).some(m => m.type === 'test_check');
    if (runsCode) {
        try {
            await execFileAsync(uvBin(config), ['--version'], { timeout: 5000 });
        } catch (e) {
            return { available: true, hint: '', warning: `uv not found (tried "${uvBin(config)}") — uv projects (pyproject.toml) can't be run or tested. Install uv (https://docs.astral.sh/uv/) or set toolchains.uv.` };
        }
    }
    return { available: true, hint: '' };
}

export default {
    language: 'python',
    sourceExtensions: ['.py'],
    stripComments,
    extractComments,
    checkManifest,
    extractUsedPackages,
    lint,
    lintConfigCandidates,
    detectProject,
    install,
    build,
    runScript: null, // no npm-style named-script concept in plain Python submissions
    runTests,
    preflight,
};

export { stripComments, checkManifest, extractUsedPackages, parseRequirementsTxt, parsePyprojectDependencies, importNamesFor, detectProject, parsePytestSummary, parseScriptTestOutput, resolveEntry, envPython, uvEnvKey };
