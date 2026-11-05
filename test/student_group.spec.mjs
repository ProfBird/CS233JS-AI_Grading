/**
 * student_group.spec.mjs
 *
 * Lab groups (A/B/C): resolving a student's group (review form, else detected from code),
 * per-group config overrides, the grading-time "group unknown" flag, and scoring a named
 * run / test script (runId / testId).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    resolveStudentGroup, configForStudent, groupUnknownWithOverrides, mappingDependsOnGroup, overriddenKeys,
} from '../src/lib/student_group.js';
import { computeResults, getHandler } from '../src/pipeline/generate_grades.js';
import { validateConfig } from '../src/lib/config_validation.js';

const variations = {
    A: { appName: 'Class Section Scheduler', overrides: { runCheck: { supportFiles: [{ from: 'GroupA-Data', to: 'Data' }], expectPatterns: ['S01'] } } },
    B: { appName: 'Flight Crew Scheduler', overrides: { runCheck: { supportFiles: [{ from: 'GroupB-Data', to: 'Data' }], expectPatterns: ['F01'] } } },
    C: { appName: 'Van Delivery Scheduler' },   // uses the lab's own settings
};
const base = { runCheck: { entry: 'main.py', timeoutMs: 30000 }, variations, mappings: [] };

describe('resolveStudentGroup', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'grp-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const flightCode = () => writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "flight-crew-scheduler"\n');

    it('uses the review form letter when it names one of the lab groups', () => {
        const g = resolveStudentGroup({ codeReview: { group: 'A' }, extractedDir: dir }, base);
        expect(g).toMatchObject({ letter: 'A', source: 'codeReview', conflict: false });
    });

    it('lets the instructor assign a group by name, over the review form or no form at all', () => {
        const manual = { 'Ann Lee': 'A', 'Bo Kim': 'B', 'Cy Doe': 'Z' };
        expect(resolveStudentGroup({ name: 'Ann Lee', extractedDir: dir }, base, manual))
            .toMatchObject({ letter: 'A', source: 'instructor', conflict: false });
        expect(resolveStudentGroup({ name: 'Bo Kim', codeReview: { group: 'A' }, extractedDir: dir }, base, manual))
            .toMatchObject({ letter: 'B', source: 'instructor', formLetter: 'A', conflict: true });
        // a letter the lab doesn't define is ignored
        expect(resolveStudentGroup({ name: 'Cy Doe', extractedDir: dir }, base, manual).letter).toBe(null);
    });

    it('keeps the form letter but reports a conflict when the code looks like another group', () => {
        flightCode();
        const g = resolveStudentGroup({ codeReview: { group: 'A' }, extractedDir: dir }, base);
        expect(g).toMatchObject({ letter: 'A', source: 'codeReview', detected: 'B', conflict: true });
    });

    it('falls back to detection from the code when there is no usable form letter', () => {
        flightCode();
        expect(resolveStudentGroup({ codeReview: { group: null }, extractedDir: dir }, base))
            .toMatchObject({ letter: 'B', source: 'detected' });
        expect(resolveStudentGroup({ codeReview: { group: 'D' }, extractedDir: dir }, base))
            .toMatchObject({ letter: 'B', source: 'detected' });
    });

    it('is unknown, with a reason, when neither gives a lab group', () => {
        expect(resolveStudentGroup({ extractedDir: dir }, base))
            .toMatchObject({ letter: null, reason: expect.stringMatching(/no group on the code review form/) });
        expect(resolveStudentGroup({ codeReview: { group: 'D' }, extractedDir: dir }, base).reason)
            .toMatch(/says group "D", which isn't one of this lab's groups \(A\/B\/C\)/);
    });

    it('without variations, just reports the form letter', () => {
        expect(resolveStudentGroup({ codeReview: { group: 'B' } }, { mappings: [] })).toEqual({ letter: 'B', source: 'codeReview' });
    });
});

describe('configForStudent', () => {
    it("merges the student's group overrides (nested objects merge, arrays replace)", () => {
        const c = configForStudent(base, { group: { letter: 'B' } });
        expect(c.runCheck).toEqual({ entry: 'main.py', timeoutMs: 30000, supportFiles: [{ from: 'GroupB-Data', to: 'Data' }], expectPatterns: ['F01'] });
        expect(base.runCheck).toEqual({ entry: 'main.py', timeoutMs: 30000 });   // base untouched
    });

    it('returns the lab config itself for a group without overrides, an unknown group, or no overrides at all', () => {
        expect(configForStudent(base, { group: { letter: 'C' } })).toBe(base);
        expect(configForStudent(base, { group: { letter: null } })).toBe(base);
        const plain = { mappings: [] };
        expect(configForStudent(plain, { group: { letter: 'A' } })).toBe(plain);
    });

    it('caches one merged config per group', () => {
        expect(configForStudent(base, { group: { letter: 'A' } })).toBe(configForStudent(base, { group: { letter: 'A' } }));
    });
});

describe('group-dependent rows', () => {
    it('knows which mapping types read the overridden settings', () => {
        expect(overriddenKeys(base)).toEqual(['runCheck']);
        expect(mappingDependsOnGroup(base, 'run_check')).toBe(true);
        expect(mappingDependsOnGroup(base, 'test_check')).toBe(true);    // uses runCheck.supportFiles
        expect(mappingDependsOnGroup(base, 'lint')).toBe(false);
        expect(groupUnknownWithOverrides(base, { group: { letter: null } })).toBe(true);
        expect(groupUnknownWithOverrides(base, { group: { letter: 'C' } })).toBe(false);
    });

    it('computeResults flags group-dependent rows for a student whose group is unknown', async () => {
        const config = { ...base, mappings: [
            { type: 'run_check', cell: 'C5', maxScore: 5 },
            { type: 'manual', cell: 'C6', maxScore: 2, msg: 'Check by hand' },
        ] };
        const student = {
            name: 'S', extractedDir: '/x', group: { letter: null, reason: 'no group on the code review form' },
            runtimeCheck: { success: true, errors: [] },   // would otherwise score 5
        };
        const [run, manual] = await computeResults(student, config);
        expect(run.score).toBe(0);
        expect(run.comment).toBe('NEEDS MANUAL CHECK: lab group unknown (no group on the code review form); this row depends on the group');
        expect(manual).toMatchObject({ score: 2, comment: 'Check by hand' });
    });
});

describe('scoring a named run / test script', () => {
    const runCheck = getHandler('run_check');
    const testCheck = getHandler('test_check');
    const student = {
        runtimeCheck: { success: false, errors: ['[expert] Exited with code 1'], runs: {
            translated: { success: true, errors: [] },
            expert: { success: false, errors: ['Exited with code 1'] },
        } },
        testCheck: { total: 5, passed: 3, failures: ['[t2] FAIL: test_b', '[t2] FAIL: test_c'], runs: {
            t1: { total: 2, passed: 2, failures: [] },
            t2: { total: 3, passed: 1, failures: ['FAIL: test_b', 'FAIL: test_c'] },
        } },
    };

    it('runId scores just that run; without it every run must pass', () => {
        expect(runCheck({ maxScore: 5, runId: 'translated' }, student).score).toBe(5);
        expect(runCheck({ maxScore: 5, runId: 'expert' }, student)).toMatchObject({ score: 0, comment: 'Exited with code 1' });
        expect(runCheck({ maxScore: 5 }, student).score).toBe(0);
        expect(runCheck({ maxScore: 5, runId: 'nope' }, student).comment).toMatch(/NEEDS MANUAL CHECK: no result for run "nope"/);
    });

    it('testId scores just that test script; without it the totals across scripts', () => {
        expect(testCheck({ maxScore: 4, testId: 't1' }, student)).toMatchObject({ score: 4, comment: 'All 2 tests passed' });
        expect(testCheck({ maxScore: 6, testId: 't2' }, student).score).toBe(2);
        expect(testCheck({ maxScore: 10 }, student).score).toBe(6);
    });
});

describe('validation of groups and named runs', () => {
    const cfg = extra => ({ rubricName: 'R.xlsx', runtimeCheck: 'run_check', mappings: [{ type: 'run_check', cell: 'C5', maxScore: 1 }], ...extra });

    it('accepts runCheck/testCheck lists with unique ids and mappings that name them', () => {
        expect(() => validateConfig(cfg({
            runCheck: [{ id: 'translated', entry: ['shipping_calculator.py', 'shipping_cost.py'], stdin: '3\nA\n' }, { id: 'expert', entry: 'recommender.py' }],
            testCheck: [{ id: 't1', mode: 'script', entry: 'test_a.py' }],
            mappings: [{ type: 'run_check', runId: 'expert', cell: 'C5', maxScore: 1 }, { type: 'test_check', testId: 't1', cell: 'C6', maxScore: 1 }],
        }), 'Lab01')).not.toThrow();
    });

    it('rejects missing/duplicate ids and unknown runId/testId', () => {
        expect(() => validateConfig(cfg({ runCheck: [{ entry: 'a.py' }] }), 'x')).toThrow(/runCheck\[0\]\.id/);
        expect(() => validateConfig(cfg({ runCheck: [{ id: 'a' }, { id: 'a' }] }), 'x')).toThrow(/"a" is used twice/);
        expect(() => validateConfig(cfg({ runCheck: [{ id: 'a' }], mappings: [{ type: 'run_check', runId: 'b', cell: 'C5' }] }), 'x'))
            .toThrow(/runId: "b" isn't one of runCheck's ids \(a\)/);
        expect(() => validateConfig(cfg({ runCheck: { entry: [] } }), 'x')).toThrow(/runCheck\.entry/);
    });

    it("checks each group's merged settings on their own", () => {
        // Group B's runCheck list lacks "expert", which a shared rubric row scores.
        const groups = cfg({
            runCheck: [{ id: 'translated' }, { id: 'expert' }],
            mappings: [{ type: 'run_check', runId: 'expert', cell: 'C5' }],
            variations: { A: {}, B: { overrides: { runCheck: [{ id: 'translated' }] } } },
        });
        expect(() => validateConfig(groups, 'x')).toThrow(/runId: "expert" isn't one of runCheck's ids \(translated\) \(group B\)/);
    });

    it("runs the full lab-config checks on each group's merged settings, without repeating the lab's own errors", () => {
        const groups = cfg({
            runtimeCheck: 'bogus',   // a base error: reported once, not once per group
            analysis: { features: [{ id: 'f1', fileRegex: '\\.py$', regex: 'ok' }] },
            variations: {
                A: { overrides: { analysis: { features: [{ id: 'f1', fileRegex: '\\.py$', regex: '(' }] } } },   // bad regex
                B: { overrides: { testCheck: { mode: 'script', entry: 't.py', supportFiles: 'Data' } } },          // bad supportFiles
            },
        });
        let message = '';
        try { validateConfig(groups, 'x'); } catch (e) { message = e.message; }
        expect(message).toMatch(/\(group A\)/);
        expect(message).toMatch(/testCheck\.supportFiles: .* \(group B\)/);
        expect(message.match(/runtimeCheck/g)).toHaveLength(1);
    });

    it('rejects override keys the per-student phases would ignore', () => {
        expect(() => validateConfig(cfg({ variations: { A: { overrides: { mappings: [], parts: [] } } } }), 'x'))
            .toThrow(/variations\.A\.overrides: can't set mappings, parts/);
    });
});
