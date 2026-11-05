/**
 * sync_drivers.spec.mjs — copying instructor check scripts from a course-materials lab folder
 * into the grader's lab config folder (src/lib/sync_drivers.js), and the --check comparison.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncDrivers } from '../src/lib/sync_drivers.js';

let root, src, dest;
const put = (base, rel, text) => { mkdirSync(join(base, rel, '..'), { recursive: true }); writeFileSync(join(base, rel), text); };

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'syncdrivers-'));
    src = join(root, 'materials'); dest = join(root, 'config');
    put(src, 'GroupA/drivers/check.py', 'a1');
    put(src, 'GroupA/drivers/sub/helper.py', 'h1');
    put(src, 'GroupB/drivers/check.py', 'b1');
    put(src, 'GroupA/notes.md', 'not a driver');
    mkdirSync(dest, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('syncDrivers', () => {
    it('copies every group\'s drivers folder (and nothing else) under drivers/<Group>', () => {
        const r = syncDrivers(src, dest);
        expect(r.groups).toEqual(['GroupA', 'GroupB']);
        expect(r.differences).toHaveLength(3);
        expect(readFileSync(join(dest, 'drivers/GroupA/sub/helper.py'), 'utf8')).toBe('h1');
        expect(existsSync(join(dest, 'drivers/GroupA/notes.md'))).toBe(false);
        expect(syncDrivers(src, dest).differences).toEqual([]);
    });

    it('--check reports changed and missing files without touching the copy', () => {
        syncDrivers(src, dest);
        put(src, 'GroupB/drivers/check.py', 'b2');
        put(src, 'GroupB/drivers/new.py', 'n');
        const r = syncDrivers(src, dest, { check: true });
        expect(r.differences.sort()).toEqual([join('GroupB', 'check.py'), join('GroupB', 'new.py')].sort());
        expect(readFileSync(join(dest, 'drivers/GroupB/check.py'), 'utf8')).toBe('b1');
        expect(existsSync(join(dest, 'drivers/GroupB/new.py'))).toBe(false);
    });
});
