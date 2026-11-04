/**
 * python_run_integration.spec.mjs
 *
 * End-to-end check of the runtime-check phase for a CS212-style uv project, against a
 * scratch tree: the submission nests its project in a folder, reads Data/ relative to the
 * project folder, and ships a plain PASS/FAIL test driver (no pytest). The instructor's
 * Data/ comes from runCheck.supportFiles next to the lab config. Exercises, in one pass:
 * project detection, the cached uv environment, running in a project copy, support files,
 * run_check output matching, and script-mode test_check.
 *
 * Real uv, but offline — the project has no dependencies, and UV_PYTHON_DOWNLOADS=never keeps
 * uv from fetching an interpreter. Skipped when uv isn't installed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import util from 'util';
import runtimeCheck from '../src/pipeline/runtime_check.js';

const execFileAsync = util.promisify(execFile);

let uvAvailable = false;
const savedEnv = {};
beforeAll(async () => {
    try { await execFileAsync('uv', ['--version'], { timeout: 5000 }); uvAvailable = true; } catch (e) { /* not installed */ }
    for (const k of ['UV_OFFLINE', 'UV_PYTHON_DOWNLOADS']) savedEnv[k] = process.env[k];
    process.env.UV_OFFLINE = '1';
    process.env.UV_PYTHON_DOWNLOADS = 'never';
});
afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function write(root, rel, content) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
}

const PYPROJECT = '[project]\nname = "lab02"\nversion = "0.1.0"\nrequires-python = ">=3.9"\ndependencies = []\n';

// The "program": loads Data/sections.csv relative to the working directory, as students
// are told to run it (from the project folder).
const MAIN = `import csv
from scheduler import count_rows
with open("Data/sections.csv", newline="") as f:
    rows = list(csv.DictReader(f))
print("sections:", count_rows(rows))
`;
const SCHEDULER = 'def count_rows(rows):\n    return len(rows)\n';
// The Lab02-style test driver: plain asserts, prints PASS/FAIL per test.
const TESTS = `from scheduler import count_rows
def test_counts():
    assert count_rows([{}, {}]) == 2
def test_empty():
    assert count_rows([]) == 1   # deliberately wrong
for t in [test_counts, test_empty]:
    try:
        t(); print("PASS:", t.__name__)
    except AssertionError:
        print("FAIL:", t.__name__)
`;

describe('runtime check — CS212-style uv project, end to end', () => {
    it('installs, runs in a project copy with instructor data, and scores a PASS/FAIL test script', async (ctx) => {
        if (!uvAvailable) ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'pyint-'));
        try {
            const extracted = join(root, 'Student', 'extracted_code');
            write(extracted, 'Lab02/pyproject.toml', PYPROJECT);
            write(extracted, 'Lab02/main.py', MAIN);
            write(extracted, 'Lab02/scheduler.py', SCHEDULER);
            write(extracted, 'Lab02/test_scheduler.py', TESTS);
            // The student didn't submit Data/ (allowed) — the instructor's copy supplies it.
            const configDir = join(root, 'configs', 'CS212', 'Lab02');
            write(configDir, 'Data/sections.csv', 'section_id,course\nS01,CS161\nS02,CS162\nS03,CS133Y\n');
            const artifactsDir = join(root, 'Artifacts');
            mkdirSync(artifactsDir);

            const config = {
                language: 'python',
                runtimeCheck: 'run_check',
                execution: { cwd: 'copy', envCacheDir: join(root, 'envs') },
                runCheck: { supportFiles: ['Data'], expectPatterns: ['sections: 3'] },
                testCheck: { mode: 'script', entry: 'test_scheduler.py' },
                mappings: [{ type: 'run_check' }, { type: 'test_check' }],
            };
            const student = { name: 'Student', extractedDir: extracted };
            await runtimeCheck([student], config, artifactsDir, configDir);

            expect(student.runtimeCheck).toMatchObject({ success: true, errors: [] });
            expect(student.runtimeCheck.stdout).toContain('sections: 3');
            expect(student.testCheck).toEqual({ total: 2, passed: 1, failures: ['FAIL: test_empty'] });
            // Nothing was written into the submission (no uv.lock, .venv, Data/, __pycache__).
            expect(readdirSync(join(extracted, 'Lab02')).sort())
                .toEqual(['main.py', 'pyproject.toml', 'scheduler.py', 'test_scheduler.py']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 120000);

    it('without the project copy, the same program cannot find its data (why execution.cwd exists)', async (ctx) => {
        if (!uvAvailable) ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'pyint-'));
        try {
            const extracted = join(root, 'S', 'extracted_code');
            write(extracted, 'pyproject.toml', PYPROJECT);
            write(extracted, 'main.py', MAIN);
            write(extracted, 'scheduler.py', SCHEDULER);
            write(extracted, 'Data/sections.csv', 'section_id\nS01\n');
            const artifactsDir = join(root, 'Artifacts');
            mkdirSync(artifactsDir);
            const student = { name: 'S', extractedDir: extracted };
            await runtimeCheck([student], {
                language: 'python', runtimeCheck: 'run_check',
                execution: { envCacheDir: join(root, 'envs') }, mappings: [],
            }, artifactsDir, null);
            expect(student.runtimeCheck.success).toBe(false);
            expect(student.runtimeCheck.errors.join(' ')).toMatch(/Data\/sections\.csv|No such file/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 120000);
});
