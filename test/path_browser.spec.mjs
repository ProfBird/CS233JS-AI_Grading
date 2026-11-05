/**
 * path_browser.spec.mjs
 *
 * askPath(): browsing for a folder or file over the prompt driver (the same askOptions/ask
 * calls the TUI and readline backends both implement), driven here by the strict mock driver.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { mockDriver } from './helpers/mock_driver.mjs';
import { askPath, listFolder, nearestExistingDir, expandHome, setRecentPathsFile, getRecentPaths } from '../src/lib/path_browser.js';
import os from 'os';
import fs from 'fs';
import path from 'path';

let root;
beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'browse-')));
    mkdirSync(join(root, 'Drive', 'CS212', 'Lab02'), { recursive: true });
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, 'Drive', 'CS212', 'Rubric.xlsm'), '');
    writeFileSync(join(root, 'Drive', 'CS212', 'notes.txt'), '');
    writeFileSync(join(root, 'Drive', 'CS212', '~$Rubric.xlsm'), '');   // Excel lock file
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('askPath — folders', () => {
    it('opens folders by name and returns the one chosen with [Use this folder]', async () => {
        const driver = mockDriver(['Drive', 'CS212', '[Use this folder]'], { strict: true });
        expect(await askPath(driver, { prompt: 'Lab root folder', start: root })).toBe(join(root, 'Drive', 'CS212'));
        const prompts = driver.calls.filter(c => c.method === 'askOptions').map(c => c.prompt);
        expect(prompts).toEqual([`Lab root folder — ${root}`, `Lab root folder — ${join(root, 'Drive')}`, `Lab root folder — ${join(root, 'Drive', 'CS212')}`]);
    });

    it('goes up a level, and lists no hidden folders', async () => {
        const driver = mockDriver(['[Up one level]', '[Cancel]'], { strict: true });
        await askPath(driver, { prompt: 'Folder', start: join(root, 'Drive') });
        const first = driver.calls.find(c => c.method === 'askOptions');
        const labels = first.opts.map(o => o.label);
        expect(labels.slice(0, 3)).toEqual(['[Use this folder]', '[Type a path...]', '[Up one level]']);
        expect(labels).toContain('CS212/');
        const second = driver.calls.filter(c => c.method === 'askOptions')[1];
        expect(second.prompt).toBe(`Folder — ${root}`);
        expect(second.opts.map(o => o.label)).not.toContain('.hidden/');
    });

    it('accepts a typed path (~ expanded; a not-yet-existing folder is allowed and flagged)', async () => {
        const typed = mockDriver(['[Type a path...]', join(root, 'Drive')], { strict: true });
        expect(await askPath(typed, { prompt: 'Folder', start: root })).toBe(join(root, 'Drive'));
        const missing = mockDriver(['[Type a path...]', join(root, 'NewFolder')], { strict: true });
        expect(await askPath(missing, { prompt: 'Folder', start: root })).toBe(join(root, 'NewFolder'));
        expect(missing.calls.some(c => c.method === 'print' && /doesn't exist yet/.test(c.line))).toBe(true);
        expect(expandHome('~/x')).toBe(join(homedir(), 'x'));
    });

    it('[Cancel] returns an empty string', async () => {
        expect(await askPath(mockDriver(['[Cancel]'], { strict: true }), { prompt: 'Folder', start: root })).toBe('');
    });

    it('opens the nearest existing folder when the start folder is gone', () => {
        expect(nearestExistingDir(join(root, 'Drive', 'gone', 'deeper'))).toBe(join(root, 'Drive'));
    });
});

describe('askPath — files', () => {
    it('lists only matching files (no lock files) and returns the one chosen', async () => {
        const driver = mockDriver(['Drive', 'CS212', 'Rubric.xlsm'], { strict: true });
        const chosen = await askPath(driver, { prompt: 'Rubric spreadsheet', kind: 'file', extensions: ['.xlsx', '.xlsm'], start: root });
        expect(chosen).toBe(join(root, 'Drive', 'CS212', 'Rubric.xlsm'));
        const last = driver.calls.filter(c => c.method === 'askOptions').pop();
        const labels = last.opts.map(o => o.label);
        expect(labels).toContain('Rubric.xlsm');
        expect(labels).not.toContain('notes.txt');
        expect(labels).not.toContain('~$Rubric.xlsm');
        expect(labels).not.toContain('[Use this folder]');
    });

    it('a typed bare filename resolves against baseDir; a typed folder opens it', async () => {
        const base = join(root, 'Drive', 'CS212');
        const byName = mockDriver(['[Type a path...]', 'Rubric.xlsm'], { strict: true });
        expect(await askPath(byName, { prompt: 'Rubric', kind: 'file', start: root, baseDir: base })).toBe(join(base, 'Rubric.xlsm'));
        const folderThenFile = mockDriver(['[Type a path...]', base, 'Rubric.xlsm'], { strict: true });
        expect(await askPath(folderThenFile, { prompt: 'Rubric', kind: 'file', extensions: ['.xlsm'], start: root })).toBe(join(base, 'Rubric.xlsm'));
    });

    it('listFolder reports an unreadable folder instead of throwing', () => {
        expect(listFolder(join(root, 'nope'), { kind: 'dir' }).error).toBeTruthy();
    });
});

// ── the TUI's arrow-key picker (driver.pickPath) and recent paths ─────────────

describe('askPath with the file picker', () => {
    function pickerDriver(picks, answers = []) {
        const d = mockDriver(answers, { strict: true });
        const seen = [];
        d.pickPath = async (opts) => { seen.push(opts); return picks.shift() ?? ''; };
        return { d, seen };
    }

    it('askPath falls back to a typed path when the picker is cancelled', async () => {
        const { d } = pickerDriver([''], ['/tmp/typed/place']);
        expect(await askPath(d, { prompt: 'Code folder', kind: 'dir' })).toBe(path.resolve('/tmp/typed/place'));
        const { d: d2 } = pickerDriver([''], ['']);
        expect(await askPath(d2, { prompt: 'Code folder', kind: 'dir' })).toBe('');
    });

    describe('recent paths', () => {
        let tmp, cfgFile, a, b;
        beforeEach(() => {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-'));
            cfgFile = path.join(tmp, 'local-config.json');
            fs.writeFileSync(cfgFile, JSON.stringify({ terms: { x: 1 } }));
            a = path.join(tmp, 'a'); b = path.join(tmp, 'b');
            fs.mkdirSync(a); fs.mkdirSync(b);
            setRecentPathsFile(cfgFile);
        });
        afterEach(() => { setRecentPathsFile(null); fs.rmSync(tmp, { recursive: true, force: true }); });

        it('remembers chosen paths (most recent first, no duplicates) and keeps other config', async () => {
            await askPath(pickerDriver([a]).d, { prompt: 'Folder', kind: 'dir' });
            await askPath(pickerDriver([b], ['2']).d, { prompt: 'Folder', kind: 'dir' });
            expect(getRecentPaths('Folder', 'dir')).toEqual([b, a]);
            expect(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).terms).toEqual({ x: 1 });
        });

        it('offers recent paths first and returns the one picked without browsing', async () => {
            await askPath(pickerDriver([a]).d, { prompt: 'Folder', kind: 'dir' });
            const { d, seen } = pickerDriver([], ['1']);
            expect(await askPath(d, { prompt: 'Folder', kind: 'dir' })).toBe(a);
            expect(seen).toHaveLength(0);
        });

        it('skips recent paths that no longer exist', async () => {
            await askPath(pickerDriver([a]).d, { prompt: 'Folder', kind: 'dir' });
            fs.rmSync(a, { recursive: true });
            expect(getRecentPaths('Folder', 'dir')).toEqual([]);
        });

        it('returns to the recent list when browsing is cancelled', async () => {
            await askPath(pickerDriver([a]).d, { prompt: 'Folder', kind: 'dir' });
            // Browse -> picker Esc -> typed path blank -> back to list -> pick recent
            const { d } = pickerDriver([''], ['2', '', '1']);
            expect(await askPath(d, { prompt: 'Folder', kind: 'dir' })).toBe(a);
        });
    });
});
