/**
 * An instructor-written checker supplied through testCheck.supportFiles (e.g. CS212 Lab01
 * Group A's grader_checks/check_shipping.py) is run as supplied — it isn't a file the student
 * wrote, so it must not be looked up among the student's files — and its PASS/FAIL lines
 * are scored like a student's own test script.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import python from '../src/adapters/python.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!hasPython)('python runTests with an instructor-supplied checker', () => {
    it('runs the checker from supportFiles and counts its PASS/FAIL lines', async () => {
        const root = mkdtempSync(join(tmpdir(), 'checker-'));
        try {
            const project = join(root, 'project');
            mkdirSync(join(project, 'grader_checks'), { recursive: true });   // the run copy, after overlay
            writeFileSync(join(project, 'grader_checks', 'check.py'), 'print("PASS one")\nprint("PASS two")\nprint("FAIL three")\n');
            const config = { language: 'python', testCheck: { mode: 'script', entry: 'grader_checks/check.py' } };
            const r = await python.runTests({ dir: project, python: 'python3' }, config,
                { supportFiles: [{ from: root, to: 'grader_checks' }] });
            expect(r.total).toBe(3);
            expect(r.passed).toBe(2);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('still reports a missing student test script as needing a manual check', async () => {
        const root = mkdtempSync(join(tmpdir(), 'checker-'));
        try {
            const r = await python.runTests({ dir: root, python: 'python3' },
                { language: 'python', testCheck: { mode: 'script', entry: 'test_x.py' } }, {});
            expect(r.error).toMatch(/NEEDS MANUAL CHECK/);
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
