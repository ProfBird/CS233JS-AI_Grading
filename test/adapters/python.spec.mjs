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
let ruffAvailable = false;
let pytestAvailable = false;
beforeAll(async () => {
    try { await execFileAsync(PY_BIN, ['-m', 'ruff', '--version'], { timeout: 5000 }); ruffAvailable = true; } catch (e) { /* not installed */ }
    try { await execFileAsync(PY_BIN, ['-m', 'pytest', '--version'], { timeout: 5000 }); pytestAvailable = true; } catch (e) { /* not installed */ }
});

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
    it('succeeds for syntactically valid Python', async () => {
        const root = mkdtempSync(join(tmpdir(), 'pybuild-ok-'));
        try {
            writeFileSync(join(root, 'app.py'), 'def add(a, b):\n    return a + b\n');
            const result = await pyAdapter.build({ dir: root }, {});
            expect(result.success).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);

    it('reports a syntax error', async () => {
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
