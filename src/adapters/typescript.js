/**
 * typescript.js
 *
 * The TypeScript adapter. Extends the JS adapter rather than reimplementing it: same
 * npm project discovery, same package.json manifest/dependency logic, same ESLint
 * invocation mechanism — only the lint ruleset (a @typescript-eslint parser/plugin
 * config) and the build step (tsc --noEmit, a genuine compile check) differ.
 */

import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
const execFileAsync = util.promisify(execFile);

import jsAdapter from './javascript.js';

// Invoke the grader's OWN installed tsc (not the student's node_modules, which usually
// won't have TypeScript installed at all) — the same pattern lint_code.js already uses
// for ESLint: the checking tool comes from the grader's environment, resolved against
// the student's tsconfig.json (if present) via cwd.
const TSC_BIN = path.join(import.meta.dirname, '..', '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

async function build(project) {
    try {
        await execFileAsync(TSC_BIN, ['--noEmit'], { cwd: project.dir, timeout: 30000, shell: true });
        return { success: true, errors: [], artifacts: [] };
    } catch (err) {
        // tsc writes compiler diagnostics to stdout and exits non-zero; each error line
        // looks like "file.ts(12,5): error TS2322: Type 'string' is not assignable...".
        const output = (err.stdout || err.message || '').toString();
        const errorLines = output.split(/\r?\n/).filter(l => /error TS\d+/.test(l));
        return {
            success: false,
            errors: errorLines.length ? errorLines.slice(0, 20) : ['tsc failed or timed out'],
            artifacts: [],
        };
    }
}

function lintConfigCandidates(configsDir, labName, parentName, courseName = null) {
    const candidates = jsAdapter.lintConfigCandidates(configsDir, labName, parentName, courseName);
    // The last candidate is always the shipped default in priority order — swap it for
    // the TypeScript-specific shipped ruleset; per-lab overrides (step/lab-specific
    // eslint.config.mjs) still take priority exactly as they do for JS.
    const repoRoot = path.join(configsDir, '..');
    candidates[candidates.length - 1] = path.join(repoRoot, 'eslint', 'student.typescript.eslint.config.mjs');
    return candidates;
}

function detectProject(dir) {
    return jsAdapter.detectProject(dir).map(p => ({ ...p, type: 'npm-ts' }));
}

async function preflight() {
    try {
        await import('typescript');
        return { available: true, hint: '' };
    } catch (e) {
        return { available: false, hint: 'Run: npm install typescript @typescript-eslint/parser @typescript-eslint/eslint-plugin' };
    }
}

export default {
    ...jsAdapter,
    language: 'typescript',
    sourceExtensions: ['.ts', '.tsx'],
    build,
    lintConfigCandidates,
    detectProject,
    preflight,
};
