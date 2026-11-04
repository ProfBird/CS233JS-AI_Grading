/**
 * groups_runs_integration.spec.mjs
 *
 * End-to-end check of lab groups and multi-program labs through the real phases
 * (resolveGroups -> runtimeCheck -> computeResults) on scratch trees, with loose Python
 * scripts (no uv needed — the system interpreter). Skipped when Python isn't installed.
 *   - CS212 Lab01 style: two separate programs, each fed its own stdin, students naming
 *     files differently (entry candidates), two test scripts scored separately.
 *   - CS212 Lab02 style: groups A and B get different instructor data and expected output
 *     through variations[group].overrides; a student whose group is unknown is flagged.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import util from 'util';
import runtimeCheck from '../src/pipeline/runtime_check.js';
import { resolveGroups } from '../src/lib/student_group.js';
import { computeResults } from '../src/pipeline/generate_grades.js';

const execFileAsync = util.promisify(execFile);
const PY = process.platform === 'win32' ? 'py' : 'python3';
let pythonAvailable = false;
beforeAll(async () => {
    try { await execFileAsync(PY, ['--version'], { timeout: 15000 }); pythonAvailable = true; } catch (e) { /* not installed */ }
}, 30000);

function write(root, rel, content) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
}

const SHIPPING = `w = float(input("Weight: "))
zone = input("Zone: ").strip().upper()
base = {"A": 10, "B": 15, "C": 20}[zone]
print("Cost:", base + (5 if w > 5 else 0) + (5 if w > 10 else 0))
`;
const RECOMMENDER = `horizon = input("Horizon (short/long): ").strip()
risk = input("Risk (low/high): ").strip()
print("Recommendation:", {("short","low"): "High-Yield Savings", ("long","high"): "Diversified Stocks"}.get((horizon, risk), "Bonds"))
`;
const testScript = (n, failing) => Array.from({ length: n }, (_, i) =>
    `print("${i < n - failing ? 'PASS' : 'FAIL'}: test_${i}")`).join('\n') + '\n';

describe('multi-program lab (CS212 Lab01 style)', () => {
    it('runs each program with its own stdin, finds differently named files, scores runs and test scripts separately', async (ctx) => {
        if (!pythonAvailable) ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'multirun-'));
        try {
            // Two students: one names the first program shipping_calculator.py, the other
            // shipping_cost.py; the second student's expert system needs a third answer it
            // never gets (stdin-starved -> EOFError).
            const s1 = join(root, 's1');
            write(s1, 'shipping_calculator.py', SHIPPING);
            write(s1, 'recommender.py', RECOMMENDER);
            write(s1, 'test_shipping.py', testScript(3, 0));
            write(s1, 'test_recommender.py', testScript(2, 1));
            const s2 = join(root, 's2');
            write(s2, 'shipping_cost.py', SHIPPING);
            write(s2, 'recommender.py', RECOMMENDER + 'again = input("Again? ")\n');
            write(s2, 'test_shipping.py', testScript(2, 0));
            // (no test_recommender.py at all)
            const artifacts = join(root, 'Artifacts');
            mkdirSync(artifacts);

            const config = {
                language: 'python',
                runtimeCheck: 'run_check',
                execution: { cwd: 'copy' },
                runCheck: [
                    { id: 'translated', entry: ['shipping_calculator.py', 'shipping_cost.py'], stdin: '7\nb\n', expectPatterns: ['Cost: 20'] },
                    { id: 'expert', entry: 'recommender.py', stdin: 'long\nhigh\n', expectPatterns: ['Diversified Stocks'] },
                ],
                testCheck: [
                    { id: 'shippingTests', mode: 'script', entry: 'test_shipping.py' },
                    { id: 'expertTests', mode: 'script', entry: 'test_recommender.py' },
                ],
                mappings: [
                    { type: 'run_check', runId: 'translated', cell: 'C8', maxScore: 5 },
                    { type: 'run_check', runId: 'expert', cell: 'C15', maxScore: 12 },
                    { type: 'test_check', testId: 'shippingTests', cell: 'C9', maxScore: 4 },
                    { type: 'test_check', testId: 'expertTests', cell: 'C16', maxScore: 8 },
                ],
            };
            const students = [{ name: 'S1', extractedDir: s1 }, { name: 'S2', extractedDir: s2 }];
            resolveGroups(students, config);
            await runtimeCheck(students, config, artifacts, root);

            const [a, b] = students;
            expect(a.runtimeCheck.runs.translated.success).toBe(true);
            expect(a.runtimeCheck.runs.expert.success).toBe(true);
            expect(a.testCheck.runs).toEqual({
                shippingTests: { total: 3, passed: 3, failures: [] },
                expertTests: { total: 2, passed: 1, failures: ['FAIL: test_1'] },
            });
            expect(b.runtimeCheck.runs.translated.success).toBe(true);           // found shipping_cost.py
            expect(b.runtimeCheck.runs.expert.success).toBe(false);
            expect(b.runtimeCheck.runs.expert.errors.join(' ')).toMatch(/EOFError/);
            expect(b.testCheck.runs.expertTests.error).toBe('NEEDS MANUAL CHECK: Entry file "test_recommender.py" not found');

            const scores = r => Object.fromEntries(r.map(x => [x.cell, x.score]));
            expect(scores(await computeResults(a, config))).toEqual({ C8: 5, C15: 12, C9: 4, C16: 4 });
            const bResults = await computeResults(b, config);
            expect(scores(bResults)).toEqual({ C8: 5, C15: 0, C9: 4, C16: 0 });
            expect(bResults.find(r => r.cell === 'C16').comment).toBe('NEEDS MANUAL CHECK: Entry file "test_recommender.py" not found');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);
});

describe('per-group settings (CS212 Lab02 style)', () => {
    it("runs each group's program with that group's data and expected output; flags an unknown group", async (ctx) => {
        if (!pythonAvailable) ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'groups-'));
        try {
            const configDir = join(root, 'config');
            write(configDir, 'GroupA-Data/items.csv', 'id\nS01\nS02\n');
            write(configDir, 'GroupB-Data/items.csv', 'id\nF01\n');
            // Every student's program prints the first id in Data/items.csv.
            const program = 'import csv\nrows = list(csv.DictReader(open("Data/items.csv")))\nprint("first:", rows[0]["id"], "count:", len(rows))\n';
            const mk = name => { const d = join(root, name); write(d, 'main.py', program); return d; };
            const artifacts = join(root, 'Artifacts');
            mkdirSync(artifacts);

            const config = {
                language: 'python',
                runtimeCheck: 'run_check',
                execution: { cwd: 'copy' },
                runCheck: { entry: 'main.py' },
                variations: {
                    A: { overrides: { runCheck: { supportFiles: [{ from: 'GroupA-Data', to: 'Data' }], expectPatterns: ['first: S01 count: 2'] } } },
                    B: { overrides: { runCheck: { supportFiles: [{ from: 'GroupB-Data', to: 'Data' }], expectPatterns: ['first: F01 count: 1'] } } },
                },
                mappings: [{ type: 'run_check', cell: 'C8', maxScore: 3 }, { type: 'lint', cell: 'C9', maxScore: 1 }],
            };
            const students = [
                { name: 'Ann', extractedDir: mk('ann'), codeReview: { group: 'A' } },
                { name: 'Bo', extractedDir: mk('bo'), codeReview: { group: 'B' } },
                { name: 'Cy', extractedDir: mk('cy'), codeReview: { group: null } },   // no review form group
            ];
            resolveGroups(students, config);
            await runtimeCheck(students, config, artifacts, configDir);

            const [ann, bo, cy] = students;
            expect(ann.runtimeCheck).toMatchObject({ success: true });
            expect(ann.runtimeCheck.stdout).toContain('first: S01 count: 2');
            expect(bo.runtimeCheck).toMatchObject({ success: true });
            expect(bo.runtimeCheck.stdout).toContain('first: F01 count: 1');
            expect(cy.runtimeCheck).toMatchObject({ success: false, groupUnknown: true });

            const cyRun = (await computeResults(cy, config)).find(r => r.cell === 'C8');
            expect(cyRun.score).toBe(0);
            expect(cyRun.comment).toMatch(/^NEEDS MANUAL CHECK: lab group unknown/);
            expect((await computeResults(ann, config)).find(r => r.cell === 'C8').score).toBe(3);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);
});

describe('test scripts and support files when runCheck is a list', () => {
    it("gives each test script its own supportFiles (runCheck's list entries aren't shared with tests)", async (ctx) => {
        if (!pythonAvailable) ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'testdata-'));
        try {
            const configDir = join(root, 'config');
            write(configDir, 'Data/rules.csv', 'rule\nr1\nr2\n');
            const s = join(root, 's');
            write(s, 'main.py', 'print("hi")\n');
            write(s, 'test_rules.py', 'import csv\nrows = list(csv.DictReader(open("Data/rules.csv")))\nprint("PASS: loads" if len(rows) == 2 else "FAIL: loads")\n');
            const artifacts = join(root, 'Artifacts');
            mkdirSync(artifacts);
            const config = {
                language: 'python', runtimeCheck: 'run_check', execution: { cwd: 'copy' },
                runCheck: [{ id: 'main', entry: 'main.py', supportFiles: ['Data'] }],
                testCheck: { mode: 'script', entry: 'test_rules.py', supportFiles: ['Data'] },
                mappings: [{ type: 'test_check', cell: 'C9', maxScore: 4 }],
            };
            const student = { name: 'S', extractedDir: s };
            resolveGroups([student], config);
            await runtimeCheck([student], config, artifacts, configDir);
            expect(student.testCheck).toEqual({ total: 1, passed: 1, failures: [] });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    it("a crash's comment keeps the end of the traceback (the actual error line)", async (ctx) => {
        if (!pythonAvailable) ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'tb-'));
        try {
            const s = join(root, 's');
            // A deep call chain: the long traceback's last line is what matters.
            write(s, 'main.py', Array.from({ length: 12 }, (_, i) => `def f${i}():\n    ${i === 11 ? 'raise ValueError("the real problem")' : `f${i + 1}()`}`).join('\n') + '\nf0()\n');
            const artifacts = join(root, 'Artifacts');
            mkdirSync(artifacts);
            const student = { name: 'S', extractedDir: s };
            await runtimeCheck([student], { language: 'python', runtimeCheck: 'run_check', mappings: [] }, artifacts, null);
            expect(student.runtimeCheck.errors[0]).toMatch(/ValueError: the real problem/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);
});

describe('group-unknown skips only what depends on the group', () => {
    it('with only testCheck overridden, an unknown-group student still gets run (and scored); tests are flagged', async (ctx) => {
        if (!pythonAvailable) ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'onlytests-'));
        try {
            const s = join(root, 's');
            write(s, 'main.py', 'print("ok")\n');
            write(s, 'test_a.py', 'print("PASS: a")\n');
            const artifacts = join(root, 'Artifacts');
            mkdirSync(artifacts);
            const config = {
                language: 'python', runtimeCheck: 'run_check',
                runCheck: { entry: 'main.py', expectPatterns: ['ok'] },
                testCheck: { mode: 'script', entry: 'test_a.py' },
                variations: { A: { overrides: { testCheck: { mode: 'script', entry: 'test_a.py', passPattern: '^PASS' } } }, B: {} },
                mappings: [{ type: 'run_check', cell: 'C8', maxScore: 3 }, { type: 'test_check', cell: 'C9', maxScore: 4 }],
            };
            const student = { name: 'Unk', extractedDir: s };
            resolveGroups([student], config);
            await runtimeCheck([student], config, artifacts, null);
            expect(student.runtimeCheck.success).toBe(true);                // the run doesn't depend on the group
            expect(student.testCheck.groupUnknown).toBe(true);
            const scores = Object.fromEntries((await computeResults(student, config)).map(r => [r.cell, [r.score, r.comment]]));
            expect(scores.C8[0]).toBe(3);
            expect(scores.C9[1]).toMatch(/^NEEDS MANUAL CHECK: lab group unknown/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);
});
