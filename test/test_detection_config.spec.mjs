// Which folder test_check treats as the project when runCheck is a list of runs (no single entry).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { testDetectionConfig } from '../src/pipeline/runtime_check.js';
import py from '../src/adapters/python.js';

let dir;
const write = (rel, text = 'x = 1\n') => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tdc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('testDetectionConfig', () => {
    it("finds a loose project's folder from a runCheck list's entries, not the shallowest .py", () => {
        write('scratch.py');                       // shallowest .py — the old guess
        write('lab/shipping_cost.py');
        write('lab/recommend.py');
        const config = { runCheck: [{ id: 'a', entry: ['shipping_calculator.py', 'shipping_cost.py'] }, { id: 'b', entry: 'recommend.py' }] };
        expect(py.detectProject(dir, config)[0].dir).toBe(dir);               // before: a guess
        expect(py.detectProject(dir, testDetectionConfig(config))[0].dir).toBe(join(dir, 'lab'));
    });

    it("falls back to a script-mode test script's own folder", () => {
        write('notes.py');
        write('work/test_lab.py');
        const config = { runCheck: [{ id: 'a', entry: 'missing.py' }], testCheck: { mode: 'script', entry: 'test_lab.py' } };
        expect(py.detectProject(dir, testDetectionConfig(config))[0].dir).toBe(join(dir, 'work'));
    });

    it('leaves a config that names no file unchanged', () => {
        const config = { runCheck: [{ id: 'a', stdin: '1\n' }] };
        expect(testDetectionConfig(config)).toBe(config);
    });
});
