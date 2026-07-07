/**
 * javascript.js
 *
 * The JavaScript/npm adapter — implements the interface documented in base.js.
 * This is a verbatim extraction of logic that used to live inline in analyze_code.js,
 * lint_code.js, and runtime_check.js; behavior is unchanged for existing CS233JS labs.
 */

import fs from 'fs';
import path from 'path';
import { exec, spawn, execFileSync } from 'child_process';
import util from 'util';
const execAsync = util.promisify(exec);
import { walk, toPosix } from '../lib/file_walker.js';

// ---------- Comment stripping (moved from analyze_code.js) ----------

// Strip single-line (//) and multi-line (/* */) comments from JS source.
// Preserves string/template literal contents to avoid stripping // inside URLs, etc.
// NOTE: block comments are stripped first to prevent apostrophes in JSDoc comments
// (e.g. "user's") from being mistakenly treated as the start of a string literal.
function stripComments(code) {
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    const strings = [];
    code = code.replace(/(['"`])((?:\\[\s\S]|(?!\1)[^\\])*?)\1/g, match => {
        strings.push(match);
        return `\x00${strings.length - 1}\x00`;
    });
    code = code.replace(/\/\/[^\n]*/g, '');
    code = code.replace(/\x00(\d+)\x00/g, (_, i) => strings[+i]);
    return code;
}

// ---------- File collection helper (local, avoids importing pipeline modules) ----------

function getAllFiles(dirPath, exclusions = []) {
    const results = [];
    walk(dirPath, {
        shouldSkip: full => exclusions.some(ex => toPosix(full).includes(toPosix(ex))),
        onFile: full => results.push(full)
    });
    return results;
}

const DEFAULT_EXCLUSIONS = ['node_modules', 'dist', '.git'];

// ---------- Manifest / dependency checking (moved from analyze_code.js) ----------

const KNOWN_PKG_SECTIONS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);

function extractUsedPackages(extractedDir, pkgJsonPaths) {
    const allFiles = getAllFiles(extractedDir, DEFAULT_EXCLUSIONS);
    const sourceFiles = allFiles.filter(f => /\.(js|mjs|cjs|jsx|ts|tsx)$/.test(f));

    const used = new Set();

    function normalizePkgName(raw) {
        if (raw.startsWith('@')) return raw.split('/').slice(0, 2).join('/');
        return raw.split('/')[0];
    }

    const patterns = [
        /\bfrom\s+['"]([^'"./][^'"]*)['"]/g,
        /\bimport\s+['"]([^'"./][^'"]*)['"]/g,
        /\bimport\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g,
        /\brequire\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g,
    ];

    for (const file of sourceFiles) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            for (const re of patterns) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(content)) !== null) {
                    used.add(normalizePkgName(m[1]));
                }
            }
        } catch (e) { /* skip unreadable files */ }
    }

    for (const pkgPath of pkgJsonPaths) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            for (const scriptVal of Object.values(pkg.scripts || {})) {
                const tokens = String(scriptVal).trim().split(/\s+/);
                let toolIdx = 0;
                if (tokens[toolIdx] === 'npx' || tokens[toolIdx] === 'node') toolIdx++;
                if (tokens[toolIdx]) used.add(normalizePkgName(tokens[toolIdx]));
            }
        } catch (e) { /* skip */ }
    }

    return used;
}

// Reads package.json(s) under dir and validates against packageCheckConfig (config.packageCheck).
// Returns { found, passed, issues } exactly as before — a nullable adapter capability;
// non-npm adapters return null and callers (generate_grades' package_check handler)
// already treat missing data as "NEEDS MANUAL CHECK".
function checkManifest(extractedDir, packageCheckConfig) {
    const allFiles = getAllFiles(extractedDir, DEFAULT_EXCLUSIONS);
    const pkgFiles = allFiles.filter(f => path.basename(f) === 'package.json');

    if (pkgFiles.length === 0) {
        return { found: false, passed: false, issues: ['package.json not found'] };
    }

    const parsed = [];
    for (const f of pkgFiles) {
        try {
            parsed.push({ path: f, pkg: JSON.parse(fs.readFileSync(f, 'utf8')) });
        } catch (e) { /* skip unparseable */ }
    }

    if (parsed.length === 0) {
        return { found: true, passed: false, issues: ['package.json could not be parsed'] };
    }

    const issues = [];
    const allSections = [...KNOWN_PKG_SECTIONS];

    for (const [section, packages] of Object.entries(packageCheckConfig)) {
        if (!KNOWN_PKG_SECTIONS.has(section) || !Array.isArray(packages)) continue;
        const wrongSections = allSections.filter(s => s !== section);

        for (const pkgName of packages) {
            const inCorrect = parsed.some(({ pkg }) => pkg[section] && pkgName in pkg[section]);
            if (inCorrect) continue;

            const inWrong = wrongSections.find(s => parsed.some(({ pkg }) => pkg[s] && pkgName in pkg[s]));
            if (inWrong) {
                issues.push(`"${pkgName}" is in ${inWrong} but should be in ${section}`);
            } else {
                issues.push(`"${pkgName}" not found in package.json`);
            }
        }
    }

    const allowedExtras = new Set(Array.isArray(packageCheckConfig.allowedExtras) ? packageCheckConfig.allowedExtras : []);
    const usedPackages = extractUsedPackages(extractedDir, pkgFiles);

    for (const { pkg } of parsed) {
        for (const section of KNOWN_PKG_SECTIONS) {
            if (!pkg[section]) continue;
            for (const pkgName of Object.keys(pkg[section])) {
                if (!usedPackages.has(pkgName) && !allowedExtras.has(pkgName)) {
                    issues.push(`extra package "${pkgName}" in ${section} is never imported`);
                }
            }
        }
    }

    return { found: true, passed: issues.length === 0, issues };
}

// ---------- Linting (moved from lint_code.js) ----------

const ruleDescriptions = {
    'no-unused-vars': 'unused variables',
    'no-undef': 'undefined variables',
    'no-unreachable': 'unreachable code',
    'no-debugger': 'debugger statements',
    'no-constant-condition': 'constant conditions',
    'no-extra-semi': 'extra semicolons',
    'no-redeclare': 'redeclared variables',
    'no-duplicate-case': 'duplicate case labels',
    'no-empty': 'empty blocks',
    'no-irregular-whitespace': 'irregular whitespace',
    'no-func-assign': 'function reassignment',
    'no-inner-declarations': 'inner declarations',
    'no-obj-calls': 'non-callable globals',
    'no-prototype-builtins': 'unsafe prototype methods',
    'no-sparse-arrays': 'sparse arrays',
    'no-unexpected-multiline': 'unexpected multiline',
    'no-unsafe-finally': 'unsafe finally',
    'no-unsafe-negation': 'unsafe negation',
    'no-var': 'var usage (use let/const)',
    'no-console': 'console statements',
    'no-alert': 'alert/confirm/prompt',
    'no-shadow': 'variable shadowing',
    'no-use-before-define': 'used before defined',
    'no-param-reassign': 'parameter reassignment',
    'no-return-assign': 'assignment in return',
    'no-lone-blocks': 'unnecessary blocks',
    'eqeqeq': 'loose equality (use ===)',
    'curly': 'missing curly braces',
    'semi': 'missing semicolons',
    'comma-dangle': 'trailing commas',
    'prefer-const': 'use const where possible',
    'prefer-template': 'use template literals',
    'prefer-arrow-callback': 'use arrow functions',
    'indent': 'indentation issues',
    'quotes': 'quote style',
    'space-before-function-paren': 'function spacing',
    'keyword-spacing': 'keyword spacing',
    'space-infix-ops': 'operator spacing',
    'comma-spacing': 'comma spacing',
    'brace-style': 'brace style',
    'parse-error': 'syntax/parse errors'
};

function friendlyRuleName(ruleId) {
    return ruleDescriptions[ruleId] || ruleId;
}

function parseLintOutput(results) {
    let totalErrors = 0;
    let totalWarnings = 0;
    const ruleCounts = {};
    const errorRuleCounts = {};
    const warningRuleCounts = {};

    for (const file of results) {
        totalErrors += file.errorCount;
        totalWarnings += file.warningCount;

        for (const msg of file.messages) {
            const rule = msg.ruleId || 'parse-error';
            ruleCounts[rule] = (ruleCounts[rule] || 0) + 1;
            if (msg.severity === 2) {
                errorRuleCounts[rule] = (errorRuleCounts[rule] || 0) + 1;
            } else {
                warningRuleCounts[rule] = (warningRuleCounts[rule] || 0) + 1;
            }
        }
    }

    const toMessages = counts => Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([rule, count]) => `${friendlyRuleName(rule)}: ${count}`);

    return {
        errors: totalErrors,
        warnings: totalWarnings,
        messages: toMessages(ruleCounts),
        errorMessages: toMessages(errorRuleCounts),
        warningMessages: toMessages(warningRuleCounts),
        ruleCounts
    };
}

async function lint(jsFiles, cwd, configOverride) {
    if (jsFiles.length === 0) return { errors: 0, warnings: 0, messages: [], errorMessages: [], warningMessages: [], ruleCounts: {} };

    let ESLint;
    try {
        const mod = await import('eslint');
        ESLint = mod.ESLint ?? mod.default?.ESLint;
    } catch (e) {
        return { errors: 0, warnings: 0, messages: ['ESLint not installed'], errorMessages: [], warningMessages: [], ruleCounts: {} };
    }

    try {
        const eslint = new ESLint({
            overrideConfigFile: configOverride,
            cwd
        });
        const results = await eslint.lintFiles(jsFiles);
        return parseLintOutput(results);
    } catch (e) {
        return { errors: 0, warnings: 0, messages: ['ESLint execution failed: ' + e.message.substring(0, 100)], errorMessages: [], warningMessages: [], ruleCounts: {} };
    }
}

// Resolution priority: step-specific override > lab-specific override > shipped default.
// labName/stepName mirror lint_code.js's existing derivation from the Artifacts labDir path
// (for multi-step labs, "labName" here is actually the step name and "parentName" the lab name).
function lintConfigCandidates(configsDir, labName, parentName) {
    const repoRoot = path.join(configsDir, '..');
    const candidates = [];
    if (parentName) candidates.push(path.join(configsDir, parentName, labName, 'eslint.config.mjs'));
    candidates.push(path.join(configsDir, labName, 'eslint.config.mjs'));
    candidates.push(path.join(repoRoot, 'eslint', 'student.eslint.config.mjs'));
    return candidates;
}

// ---------- Project detection / build / install / scripts (moved from runtime_check.js) ----------

const skipBuildDirs = (full, name) => !name.includes('node_modules') && name !== 'dist' && !name.startsWith('.');

function findPackageJsonDirs(dirPath) {
    const arrayOfDirs = [];
    walk(dirPath, {
        visit: (d, names) => { if (names.includes('package.json')) arrayOfDirs.push(d); },
        shouldDescend: skipBuildDirs
    });
    return arrayOfDirs;
}

function detectProject(dir) {
    return findPackageJsonDirs(dir).map(pkgDir => ({
        dir: pkgDir,
        type: 'npm',
        buildCommand: ['npm', 'run', 'build'],
        runCommand: null,   // JS runtime checking goes through the browser strategy, not exec
        artifactPath: null, // dist/ is discovered directly by the browser-check strategy
    }));
}

async function install(project) {
    const nodeModulesDir = path.join(project.dir, 'node_modules');
    if (fs.existsSync(nodeModulesDir)) {
        try { fs.rmSync(nodeModulesDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    try {
        await execAsync('npm install --no-fund --no-audit --ignore-scripts', { cwd: project.dir, timeout: 20000 });
        return { success: true, errors: [] };
    } catch (err) {
        return { success: false, errors: ['npm install failed or timed out'] };
    }
}

async function build(project) {
    try {
        await execAsync('npm run build', { cwd: project.dir, timeout: 20000 });
        return { success: true, errors: [], artifacts: [] };
    } catch (err) {
        return { success: false, errors: ['npm run build failed or timed out'], artifacts: [] };
    }
}

// Runs an npm script in pkgDir using spawn with a detached process group so
// the entire tree (npm → node → vite, etc.) is reliably killed on timeout.
function spawnScript(pkgDir, scriptName, timeoutMs) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn('npm', ['run', scriptName], { cwd: pkgDir, detached: true, stdio: 'pipe', shell: true });
        } catch (err) {
            resolve({ code: null, stdout: '', stderr: err.message, killed: false });
            return;
        }

        let stdout = '', stderr = '';
        if (child.stdout) child.stdout.on('data', d => { stdout += d; });
        if (child.stderr) child.stderr.on('data', d => { stderr += d; });

        let resolved = false;
        const done = (code, killed) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ code, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500), killed: !!killed });
        };

        const timer = setTimeout(() => {
            killProcessTree(child.pid);
            done(null, true);
        }, timeoutMs);

        child.on('close', code => done(code, false));
        child.on('error', () => {
            killProcessTree(child.pid);
            done(null, false);
        });
    });
}

// Kill a spawned process and its whole tree, cross-platform. On POSIX we signal
// the negative PID (the detached process group). Windows has no process groups,
// so use taskkill /T to walk and terminate the child tree (npm -> node -> vite).
function killProcessTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    } else {
        try { process.kill(-pid, 'SIGKILL'); }
        catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
}

// Checks whether `name` is defined in project's package.json, and (unless verifyOnly)
// actually runs it. verifyOnly is used by the pipeline for scripts that start persistent
// servers (dev/start/serve/watch/preview) — see SERVER_SCRIPTS in runtime_check.js;
// the adapter itself has no opinion about which script names are safe to execute.
async function runScript(project, name, opts = {}) {
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(project.dir, 'package.json'), 'utf8'));
    } catch (e) {
        return { defined: false, ran: false, passed: false, error: 'package.json unreadable' };
    }

    if (!pkg.scripts || !pkg.scripts[name]) {
        return { defined: false, ran: false, passed: false, error: `"${name}" not in package.json scripts` };
    }

    if (opts.verifyOnly) {
        return { defined: true, ran: false, passed: true, error: null };
    }

    const { code, stdout, stderr, killed } = await spawnScript(project.dir, name, 30000);

    if (code === 0) {
        return { defined: true, ran: true, passed: true, error: null };
    }

    if (killed) {
        const combined = (stdout + stderr).toLowerCase();
        if (!/\bfail\b|\berror\b|\bnot found\b/.test(combined)) {
            return { defined: true, ran: true, passed: true, error: null };
        }
    }

    const errorText = (stderr + stdout).trim().slice(0, 300) || 'Script exited with error';
    return { defined: true, ran: true, passed: false, error: errorText };
}

function preflight() {
    return { available: true, hint: '' }; // node/npm are the host runtime — always available
}

export default {
    language: 'javascript',
    sourceExtensions: ['.js', '.mjs'],
    stripComments,
    readManifest: null, // superseded by checkManifest (validates against config directly); see base.js note
    checkManifest,
    extractUsedPackages,
    lint,
    lintConfigCandidates,
    detectProject,
    install,
    build,
    runScript,
    preflight,
};

// Re-exported for any consumer that wants the pure functions directly (e.g. tests).
export {
    stripComments, extractUsedPackages, checkManifest, lint, lintConfigCandidates,
    detectProject, install, build, runScript, findPackageJsonDirs, spawnScript, killProcessTree,
    getAllFiles,
};
