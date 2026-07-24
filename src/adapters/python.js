/**
 * python.js
 *
 * The Python adapter. Manifest is requirements.txt (a flat dependency list — Python has
 * no dependencies/devDependencies section split the way package.json does). Lint is
 * ruff (JSON output normalized to the shared diagnostics shape). Build is a syntax-only
 * check via py_compile (Python has no separate compile step; this is the closest
 * equivalent to "does this parse"). Tests run via pytest, parsed from its text summary.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
const execFileAsync = util.promisify(execFile);
import { getAllFiles as sharedGetAllFiles } from '../lib/file_walker.js';
import { makeCommentStripper } from '../lib/comment_stripper.js';
import { aggregateDiagnostics } from '../lib/diagnostics_aggregator.js';

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
const stripComments = makeCommentStripper({
    lineComment: /#[^\n]*/g,
    protectPatterns: [
        /("""[\s\S]*?"""|'''[\s\S]*?''')/g,           // triple-quoted first (may span lines, contain # or quotes)
        /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g, // then single-line quoted strings
    ],
});

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

// Validates requirements.txt against packageCheckConfig.dependencies (a flat required-
// package list — devDependencies/peerDependencies/optionalDependencies don't apply to
// Python's requirements.txt model and are ignored if present in a shared config).
function checkManifest(dir, packageCheckConfig) {
    const reqFiles = findRequirementsFiles(dir);
    if (reqFiles.length === 0) {
        return { found: false, passed: false, issues: ['requirements.txt not found'] };
    }

    let declared = [];
    for (const f of reqFiles) {
        try { declared.push(...parseRequirementsTxt(fs.readFileSync(f, 'utf8'))); } catch (e) { /* skip unreadable */ }
    }
    declared = [...new Set(declared)];

    const required = packageCheckConfig.dependencies || [];
    const issues = [];
    for (const pkg of required) {
        if (!declared.includes(pkg.toLowerCase())) {
            issues.push(`"${pkg}" not found in requirements.txt`);
        }
    }

    const allowedExtras = new Set((packageCheckConfig.allowedExtras || []).map(p => p.toLowerCase()));
    const used = extractUsedPackages(dir);
    for (const pkg of declared) {
        if (!used.has(pkg) && !allowedExtras.has(pkg)) {
            issues.push(`extra package "${pkg}" in requirements.txt is never imported`);
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
    candidates.push(path.join(repoRoot, 'python', 'student.ruff.toml'));
    return candidates;
}

// ---------- Project detection / install / build ----------

// A Python "project" is any directory containing .py files, whether or not it has a
// requirements.txt — plenty of intro-level submissions are loose scripts with no
// packaging at all. detectProject still returns a project descriptor for those so
// build/lint/run_check have somewhere to work.
function detectProject(dir, config = {}) {
    const pyFiles = getAllFiles(dir).filter(f => f.toLowerCase().endsWith('.py'));
    if (pyFiles.length === 0) return [];

    const reqFiles = findRequirementsFiles(dir);
    const mainCandidate = pyFiles.find(f => /main\.py$/i.test(f)) || pyFiles[0];

    return [{
        dir,
        type: reqFiles.length ? 'python-requirements' : 'python-loose',
        buildCommand: null, // build() runs py_compile per-file; no single "build" argv
        runCommand: [pythonBin(config), mainCandidate],
        artifactPath: null, // interpreted — no build artifact to point at
    }];
}

async function install(project, config) {
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

async function runTests(project, config) {
    try {
        const { stdout } = await execFileAsync(pythonBin(config), ['-m', 'pytest', '-v'], { cwd: project.dir, timeout: 30000 });
        return parsePytestSummary(stdout);
    } catch (err) {
        const output = (err.stdout || '').toString();
        if (/no tests ran|collected 0 items/i.test(output)) {
            return { total: 0, passed: 0, failures: [] };
        }
        if (/passed|failed/.test(output)) {
            return parsePytestSummary(output); // pytest exits non-zero when tests fail — still valid results
        }
        return { total: 0, passed: 0, failures: [], error: 'pytest not installed or failed to run' };
    }
}

async function preflight(config) {
    try {
        await execFileAsync(pythonBin(config), ['--version'], { timeout: 5000 });
        return { available: true, hint: '' };
    } catch (e) {
        return { available: false, hint: `Python interpreter not found (tried "${pythonBin(config)}"). Set config.toolchains.python to the correct command.` };
    }
}

export default {
    language: 'python',
    sourceExtensions: ['.py'],
    stripComments,
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

export { stripComments, checkManifest, extractUsedPackages, parseRequirementsTxt, detectProject, parsePytestSummary };
