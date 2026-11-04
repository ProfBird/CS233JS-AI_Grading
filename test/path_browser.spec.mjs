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
import { askPath, listFolder, nearestExistingDir, expandHome } from '../src/lib/path_browser.js';

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
