/**
 * python.spec.mjs
 *
 * Adapter-level tests for src/adapters/python.js: comment-stripping (no block-comment
 * syntax, triple-quoted strings must be protected), ruff-based lint, py_compile-based
 * build (syntax check), requirements.txt manifest handling, and pytest test running.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import util from 'util';
const execFileAsync = util.promisify(execFile);

import pyAdapter, { stripComments, parseRequirementsTxt } from '../../src/adapters/python.js';
import { isValidDiagnostics, REQUIRED_ADAPTER_KEYS } from '../../src/adapters/base.js';
import { resolveAdapter } from '../../src/adapters/index.js';

// ruff/pytest are separate pip packages, not guaranteed present alongside the Python
// interpreter itself (e.g. on a CI runner image) — gate the tests that need them so a
// missing tool skips gracefully instead of failing on an assertion that can never pass
// without it. Mirrors the beforeAll+ctx.skip() pattern in cpp.spec.mjs/csharp.spec.mjs.
const PY_BIN = process.platform === 'win32' ? 'py' : 'python3';
let pythonAvailable = false;
let ruffAvailable = false;
let pytestAvailable = false;
// Probes run in parallel with a generous per-probe limit: on a cold Windows CI runner each
// Python start-up can take seconds, and three sequential 5 s probes overran vitest's default
// 10 s hook timeout (CI run 41902676599). A probe that times out reads as "not installed"
// and silently skips that tool's tests, so the limit must not be tight either.
const PROBE_TIMEOUT_MS = 15000;
const probe = args => execFileAsync(PY_BIN, args, { timeout: PROBE_TIMEOUT_MS }).then(() => true, () => false);
beforeAll(async () => {
    // build() shells out to `py_compile` via the interpreter itself — on a Node-only CI
    // machine with no Python installed at all, that's a different (broader) gap than
    // "ruff/pytest aren't pip-installed", so it needs its own gate.
    [pythonAvailable, ruffAvailable, pytestAvailable] = await Promise.all([
        probe(['--version']),
        probe(['-m', 'ruff', '--version']),
        probe(['-m', 'pytest', '--version']),
    ]);
}, 30000);

describe('python adapter — interface contract', () => {
    it('exposes all required adapter keys', () => {
        for (const key of REQUIRED_ADAPTER_KEYS) {
            expect(pyAdapter).toHaveProperty(key);
        }
    });

    it('resolveAdapter({language: "python"}) returns it', () => {
        expect(resolveAdapter({ language: 'python' })).toBe(pyAdapter);
    });

    it('has no runScript concept (npm-style named scripts don\'t apply)', () => {
        expect(pyAdapter.runScript).toBeNull();
    });
});

describe('stripComments', () => {
    it('strips a # line comment but preserves string contents', () => {
        expect(stripComments('x = 1  # a comment\ny = 2')).toBe('x = 1  \ny = 2');
    });

    it('does not treat # inside a string literal as a comment', () => {
        expect(stripComments('url = "http://example.com/#frag"')).toBe('url = "http://example.com/#frag"');
    });

    it('protects triple-quoted strings/docstrings containing #', () => {
        const code = '"""\nThis is a docstring with a # inside.\n"""\nx = 1  # real comment';
        const result = stripComments(code);
        expect(result).toContain('This is a docstring with a # inside.');
        expect(result).not.toContain('real comment');
    });
});

describe('parseRequirementsTxt', () => {
    it('extracts package names, ignoring comments/blank lines/version specifiers', () => {
        const content = '# a comment\nflask==2.0.1\nrequests>=2.28\n\nnumpy\n-r other.txt\n';
        expect(parseRequirementsTxt(content)).toEqual(['flask', 'requests', 'numpy']);
    });
});

describe('python adapter — lint() via ruff', () => {
    it('reports a real diagnostics shape for a file with issues', async (ctx) => {
        if (!ruffAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'pyadapter-lint-'));
        try {
            const file = join(root, 'bad.py');
            writeFileSync(file, 'import os\nx=1\ndef foo():\n    y = 2\n    print(x==1)\n');
            const result = await pyAdapter.lint([file], root, null, {});
            expect(isValidDiagnostics(result)).toBe(true);
            expect(result.errors).toBeGreaterThan(0); // unused import/variable = pyflakes = error tier
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);

    it('a clean file lints with zero issues', async (ctx) => {
        if (!ruffAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'pyadapter-clean-'));
        try {
            const file = join(root, 'clean.py');
            writeFileSync(file, 'x = 1\nprint(x)\n');
            const result = await pyAdapter.lint([file], root, null, {});
            expect(result.errors).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);

    it('returns the empty-shape result for no files', async () => {
        const result = await pyAdapter.lint([], '/nowhere', null, {});
        expect(isValidDiagnostics(result)).toBe(true);
        expect(result.errors).toBe(0);
    });
});

describe('python adapter — build() via py_compile', () => {
    it('succeeds for syntactically valid Python', async (ctx) => {
        if (!pythonAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'pybuild-ok-'));
        try {
            writeFileSync(join(root, 'app.py'), 'def add(a, b):\n    return a + b\n');
            const result = await pyAdapter.build({ dir: root }, {});
            expect(result.success).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);

    it('reports a syntax error', async (ctx) => {
        if (!pythonAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'pybuild-fail-'));
        try {
            writeFileSync(join(root, 'app.py'), 'def add(a, b)\n    return a + b\n'); // missing colon
            const result = await pyAdapter.build({ dir: root }, {});
            expect(result.success).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);
});

describe('python adapter — detectProject()', () => {
    it('detects a loose-script project with no requirements.txt', () => {
        const root = mkdtempSync(join(tmpdir(), 'pyproj-loose-'));
        try {
            writeFileSync(join(root, 'main.py'), 'print("hi")\n');
            const projects = pyAdapter.detectProject(root, {});
            expect(projects.length).toBe(1);
            expect(projects[0].type).toBe('python-loose');
            expect(projects[0].runCommand[1]).toMatch(/main\.py$/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('detects a requirements.txt project', () => {
        const root = mkdtempSync(join(tmpdir(), 'pyproj-req-'));
        try {
            writeFileSync(join(root, 'requirements.txt'), 'requests\n');
            writeFileSync(join(root, 'main.py'), 'print("hi")\n');
            const projects = pyAdapter.detectProject(root, {});
            expect(projects[0].type).toBe('python-requirements');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('respects config.toolchains.python for the runCommand interpreter', () => {
        const root = mkdtempSync(join(tmpdir(), 'pyproj-toolchain-'));
        try {
            writeFileSync(join(root, 'main.py'), 'print("hi")\n');
            const projects = pyAdapter.detectProject(root, { toolchains: { python: 'python3.11' } });
            expect(projects[0].runCommand[0]).toBe('python3.11');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('returns an empty array for a directory with no .py files', () => {
        const root = mkdtempSync(join(tmpdir(), 'pyproj-empty-'));
        try {
            expect(pyAdapter.detectProject(root, {})).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('python adapter — checkManifest()', () => {
    it('flags a missing required dependency', () => {
        const root = mkdtempSync(join(tmpdir(), 'pymanifest-'));
        try {
            writeFileSync(join(root, 'requirements.txt'), 'requests\n');
            const result = pyAdapter.checkManifest(root, { dependencies: ['flask'] });
            expect(result.found).toBe(true);
            expect(result.passed).toBe(false);
            expect(result.issues.join(' ')).toMatch(/flask/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('reports not found when there is no requirements.txt', () => {
        const root = mkdtempSync(join(tmpdir(), 'pymanifest-missing-'));
        try {
            const result = pyAdapter.checkManifest(root, { dependencies: [] });
            expect(result.found).toBe(false);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('python adapter — runTests() via pytest', () => {
    it('reports pass/fail counts for a simple test file', async (ctx) => {
        if (!pytestAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'pytest-run-'));
        try {
            writeFileSync(join(root, 'test_math.py'), [
                'def test_pass():',
                '    assert 1 + 1 == 2',
                '',
                'def test_fail():',
                '    assert 1 + 1 == 3',
                '',
            ].join('\n'));
            const result = await pyAdapter.runTests({ dir: root }, {});
            expect(result.total).toBe(2);
            expect(result.passed).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30000);

    it('reports zero tests when none are collected', async (ctx) => {
        if (!pytestAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'pytest-none-'));
        try {
            writeFileSync(join(root, 'app.py'), 'print("no tests here")\n');
            const result = await pyAdapter.runTests({ dir: root }, {});
            expect(result.total).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30000);
});

describe('extractComments (inverse of stripComments)', () => {
    it('returns # comments and docstrings, never code', () => {
        const out = pyAdapter.extractComments('"""Author: Ana"""\nname = input("x")  # by "Ana" here\n');
        expect(out).toContain('Author: Ana');
        expect(out).toContain('# by "Ana" here');      // quoted text inside a comment is restored
        expect(out).not.toContain('input');
    });

    it('does not treat a # inside a string literal as a comment', () => {
        expect(pyAdapter.extractComments('url = "http://x/#frag"\n')).toBe('');
    });
});

describe('extractComments exists on every comment-capable adapter', () => {
    it.each(['javascript', 'typescript', 'python', 'cpp', 'csharp'])('%s', lang => {
        const adapter = resolveAdapter({ language: lang });
        expect(typeof adapter.extractComments).toBe('function');
        if (lang !== 'python') {
            expect(adapter.extractComments('int name = 1; // Ana\n/* date: x */')).toBe('/* date: x */\n// Ana');
        }
    });
});

// ---------- uv projects, entry points, pyproject.toml, script-mode tests ----------

import {
    resolveEntry, parsePyprojectDependencies, importNamesFor, parseScriptTestOutput,
    envPython, uvEnvKey,
} from '../../src/adapters/python.js';
import { mkdirSync, readdirSync, existsSync, rmSync as rmSync2 } from 'fs';

let uvAvailable = false;
beforeAll(async () => {
    try { await execFileAsync('uv', ['--version'], { timeout: PROBE_TIMEOUT_MS }); uvAvailable = true; } catch (e) { /* not installed */ }
}, 30000);

function scratchProject(files) {
    const dir = mkdtempSync(join(tmpdir(), 'pyproj-'));
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), content);
    }
    return dir;
}

describe('resolveEntry / detectProject', () => {
    it('picks main.py by exact name, never e.g. domain.py', () => {
        const files = ['domain.py', 'main.py', 'util.py'].map(f => join('/p', f));
        expect(resolveEntry('/p', files, null)).toEqual({ path: join('/p', 'main.py'), guessed: false });
        expect(resolveEntry('/p', [join('/p', 'domain.py')], null)).toEqual({ path: join('/p', 'domain.py'), guessed: false });
    });

    it('honors runCheck.entry as a bare filename or a relative path, and reports a missing one', () => {
        const dir = scratchProject({ 'scheduler.py': '', 'src/run_me.py': '', 'main.py': '' });
        try {
            const py = [join(dir, 'scheduler.py'), join(dir, 'src', 'run_me.py'), join(dir, 'main.py')];
            expect(resolveEntry(dir, py, 'scheduler.py').path).toBe(join(dir, 'scheduler.py'));
            expect(resolveEntry(dir, py, 'src/run_me.py').path).toBe(join(dir, 'src', 'run_me.py'));
            expect(resolveEntry(dir, py, 'nope.py')).toMatchObject({ path: null, error: 'Entry file "nope.py" not found' });
        } finally { rmSync2(dir, { recursive: true, force: true }); }
    });

    it('flags a guess when there is no main.py and several files', () => {
        const r = resolveEntry('/p', [join('/p', 'b.py'), join('/p', 'a.py')], null);
        expect(r).toMatchObject({ path: join('/p', 'a.py'), guessed: true });
    });

    it('a nested pyproject.toml makes its folder the project (python-uv), entry relative to it', () => {
        const dir = scratchProject({ 'Lab02/pyproject.toml': '[project]\nname="x"\n', 'Lab02/main.py': '', 'Lab02/Data/a.csv': '', 'notes.py': '' });
        try {
            const [p] = pyAdapter.detectProject(dir, {});
            expect(p).toMatchObject({ dir: join(dir, 'Lab02'), type: 'python-uv', entry: 'main.py', entryError: null });
        } finally { rmSync2(dir, { recursive: true, force: true }); }
    });

    it('surfaces a configured entry that does not exist', () => {
        const dir = scratchProject({ 'main.py': '' });
        try {
            const [p] = pyAdapter.detectProject(dir, { runCheck: { entry: 'scheduler.py' } });
            expect(p.entryError).toBe('Entry file "scheduler.py" not found');
            expect(p.runCommand).toBeNull();
        } finally { rmSync2(dir, { recursive: true, force: true }); }
    });
});

describe('pyproject.toml manifest', () => {
    const toml = `[project]
name = "lab02"
dependencies = [
    "z3-solver>=4.15.4",   # the solver
    "httpx[cli]>=0.27; python_version > '3.9'",
    "Scikit_Learn",
]

[dependency-groups]
dev = ["pytest>=8", "ruff"]
`;

    it('reads dependencies (multi-line, comments, extras, markers) and dev groups, normalized', () => {
        expect(parsePyprojectDependencies(toml)).toEqual({
            dependencies: ['z3-solver', 'httpx', 'scikit-learn'],
            devDependencies: ['pytest', 'ruff'],
        });
    });

    it('maps distribution names to import names', () => {
        expect(importNamesFor('scikit-learn')).toEqual(['sklearn']);
        expect(importNamesFor('Z3_Solver')).toEqual(['z3']);
        expect(importNamesFor('tensorflow-datasets')).toEqual(['tensorflow_datasets']);
        expect(importNamesFor('my-dist', { 'My_Dist': 'mymod' })).toEqual(['mymod']);
    });

    it('checkManifest: imported deps pass via aliases; unused runtime deps flagged; dev groups not', () => {
        const dir = scratchProject({
            'pyproject.toml': toml,
            'solver.py': 'from z3 import Solver\nimport httpx\n',
        });
        try {
            const r = pyAdapter.checkManifest(dir, { dependencies: ['z3-solver', 'numpy'] });
            expect(r.found).toBe(true);
            expect(r.issues).toEqual([
                '"numpy" not found in pyproject.toml',
                'extra package "scikit-learn" in pyproject.toml is never imported',
            ]);
        } finally { rmSync2(dir, { recursive: true, force: true }); }
    });
});

describe('script-mode test output', () => {
    const run = (stdout, extra = {}) => parseScriptTestOutput({ stdout, stderr: '', code: 0, timedOut: false, ...extra });

    it('counts PASS/FAIL lines (the Lab02 driver format)', () => {
        expect(run('PASS: test_a\nFAIL: test_b\nPASS: test_c\n2 of 3 tests passed\n', { code: 1 }))
            .toEqual({ total: 3, passed: 2, failures: ['FAIL: test_b'] });
    });

    it('a traceback after some tests adds a failure for the tests that never ran', () => {
        const r = run('PASS: test_a\n', { code: 1, stderr: 'Traceback (most recent call last):\n  ...\nModuleNotFoundError: No module named \'z3\'' });
        expect(r.total).toBe(2);
        expect(r.passed).toBe(1);
        expect(r.failures[0]).toMatch(/exit code 1.*ModuleNotFoundError/);
    });

    it('no PASS/FAIL lines: one test, decided by the exit code', () => {
        expect(run('all good')).toEqual({ total: 1, passed: 1, failures: [] });
        expect(run('', { code: 1, stderr: 'AssertionError' }).passed).toBe(0);
        expect(run('', { timedOut: true, code: null }).failures).toEqual(['Test run timed out']);
    });

    it('custom patterns', () => {
        expect(parseScriptTestOutput({ stdout: 'ok 1\nnot ok 2\nok 3', stderr: '', code: 0 }, { passPattern: '^ok\\b', failPattern: '^not ok\\b' }))
            .toEqual({ total: 3, passed: 2, failures: ['not ok 2'] });
    });
});

describe('uv environments', () => {
    it('finds the environment interpreter per platform', () => {
        expect(envPython('/e', 'darwin')).toBe(join('/e', 'bin', 'python'));
        expect(envPython('/e', 'win32')).toBe(join('/e', 'Scripts', 'python.exe'));
    });

    it('keys environments by pyproject.toml + uv.lock + .python-version contents', () => {
        const a = scratchProject({ 'pyproject.toml': '[project]\nname="x"\n' });
        const b = scratchProject({ 'pyproject.toml': '[project]\nname="x"\n', 'main.py': 'different code, same deps' });
        const c = scratchProject({ 'pyproject.toml': '[project]\nname="x"\n', 'uv.lock': 'v1' });
        try {
            expect(uvEnvKey(a)).toBe(uvEnvKey(b));
            expect(uvEnvKey(a)).not.toBe(uvEnvKey(c));
        } finally { [a, b, c].forEach(d => rmSync2(d, { recursive: true, force: true })); }
    });

    // Real uv, but offline: a dependency-free project needs no package downloads, and
    // UV_PYTHON_DOWNLOADS=never keeps uv from fetching an interpreter.
    it('builds a cached environment outside the submission, then reuses it', async (ctx) => {
        if (!uvAvailable) ctx.skip();
        const saved = { UV_OFFLINE: process.env.UV_OFFLINE, UV_PYTHON_DOWNLOADS: process.env.UV_PYTHON_DOWNLOADS };
        process.env.UV_OFFLINE = '1';
        process.env.UV_PYTHON_DOWNLOADS = 'never';
        const dir = scratchProject({ 'pyproject.toml': '[project]\nname = "lab"\nversion = "0.1.0"\nrequires-python = ">=3.9"\ndependencies = []\n', 'main.py': 'print("hi")\n' });
        const cache = mkdtempSync(join(tmpdir(), 'uvcache-'));
        try {
            const config = { execution: { envCacheDir: cache } };
            const [project] = pyAdapter.detectProject(dir, config);
            const first = await pyAdapter.install(project, config);
            expect(first).toMatchObject({ success: true, errors: [] });
            expect(project.runCommand[0]).toBe(first.python);
            expect(first.python.startsWith(cache)).toBe(true);
            expect(existsSync(first.python)).toBe(true);
            expect(readdirSync(dir).sort()).toEqual(['main.py', 'pyproject.toml']);  // no uv.lock/.venv written

            const t0 = Date.now();
            const [again] = pyAdapter.detectProject(dir, config);
            const second = await pyAdapter.install(again, config);
            expect(second.python).toBe(first.python);
            expect(Date.now() - t0).toBeLessThan(2000);   // marker hit: no second sync
        } finally {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
            rmSync2(dir, { recursive: true, force: true });
            rmSync2(cache, { recursive: true, force: true });
        }
    }, 120000);

    it('reports a uv sync failure with uv\'s own message', async (ctx) => {
        if (!uvAvailable) ctx.skip();
        const dir = scratchProject({ 'pyproject.toml': 'this is [not valid toml', 'main.py': '' });
        const cache = mkdtempSync(join(tmpdir(), 'uvcache-'));
        try {
            const [project] = pyAdapter.detectProject(dir, {});
            const r = await pyAdapter.install(project, { execution: { envCacheDir: cache } });
            expect(r.success).toBe(false);
            expect(r.errors[0]).toMatch(/^uv sync failed: /);
        } finally {
            rmSync2(dir, { recursive: true, force: true });
            rmSync2(cache, { recursive: true, force: true });
        }
    }, 60000);
});

describe('preflight', () => {
    it('warns (without failing) about a missing uv only when the lab runs or tests code', async (ctx) => {
        if (!pythonAvailable) ctx.skip();
        const toolchains = { uv: '/definitely/not/uv' };
        const runs = await pyAdapter.preflight({ toolchains, runtimeCheck: 'run_check', mappings: [] });
        expect(runs.available).toBe(true);
        expect(runs.warning).toMatch(/uv not found/);
        const lintOnly = await pyAdapter.preflight({ toolchains, runtimeCheck: 'none', mappings: [{ type: 'lint' }] });
        expect(lintOnly.available).toBe(true);
        expect(lintOnly.warning || '').not.toMatch(/uv not found/);
    }, 30000);   // two interpreter/tool start-ups — over the 5 s default on a cold Windows runner
});
