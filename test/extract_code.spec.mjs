/**
 * extract_code.spec.mjs
 *
 * Precedence tests for code acquisition: when a student submits BOTH a GitHub repo link and a
 * zip, the repository is preferred (cloned); the zip is used only as a fallback if the clone
 * fails. `git` is mocked (no real network/clone) and made to drop a CLONED.txt marker on
 * success; the zip is a real adm-zip archive containing a FROM_ZIP.txt marker — so each test
 * can tell which source was actually used.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';

// Mock only execFileSync (used for `git clone`); keep the rest of child_process real.
vi.mock('child_process', async () => {
    const actual = await vi.importActual('child_process');
    return { ...actual, execFileSync: vi.fn() };
});
import { execFileSync } from 'child_process';

const { extractStudentCode } = await import('../src/pipeline/extract_code.js');

describe('extractStudentCode — repo/zip precedence', () => {
    let root;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'extract-'));
        vi.mocked(execFileSync).mockReset();
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    // Build a student with an optional GitHub link (written into onlinetext.html) and an
    // optional real zip containing a FROM_ZIP.txt marker.
    function makeStudent(name, { github, zip } = {}) {
        const textDir = join(root, `${name}_text`);
        mkdirSync(textDir, { recursive: true });
        writeFileSync(join(textDir, 'onlinetext.html'), github ? `<a href="${github}">repo</a>` : '<p>no link</p>');
        let zipFile;
        if (zip) {
            zipFile = join(root, `${name}.zip`);
            const z = new AdmZip();
            z.addFile('FROM_ZIP.txt', Buffer.from('from the zip'));
            z.writeZip(zipFile);
        }
        return { name, textDir, zipFile };
    }

    const outDir = () => { const p = join(root, 'out'); mkdirSync(p, { recursive: true }); return p; };

    // git clone "succeeds": drop a CLONED.txt marker into the clone target dir (the last argv).
    const cloneSucceeds = () => vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        writeFileSync(join(args[args.length - 1], 'CLONED.txt'), 'cloned');
    });
    const cloneFails = () => vi.mocked(execFileSync).mockImplementation(() => { throw new Error('fatal: repository not found'); });

    it('prefers the repository (clones) when BOTH a repo link and a zip are present', async () => {
        cloneSucceeds();
        const student = makeStudent('Zoey', { github: 'https://github.com/x/y', zip: true });
        await extractStudentCode(student, root, outDir());
        expect(execFileSync).toHaveBeenCalledTimes(1);                              // attempted the clone
        expect(student.extractedDir).toMatch(/[/\\]repo$/);                         // repo dir, not extracted_code
        expect(existsSync(join(student.extractedDir, 'CLONED.txt'))).toBe(true);    // used the repo…
        expect(existsSync(join(student.extractedDir, 'FROM_ZIP.txt'))).toBe(false); // …not the zip
        expect(student.error).toBeUndefined();
    });

    it('falls back to the zip when the clone fails but a zip is present', async () => {
        cloneFails();
        const student = makeStudent('Broken', { github: 'https://github.com/x/y', zip: true });
        await extractStudentCode(student, root, outDir());
        expect(student.extractedDir).toBeTruthy();
        expect(existsSync(join(student.extractedDir, 'FROM_ZIP.txt'))).toBe(true);  // salvaged from the zip
        expect(student.error).toBeUndefined();
    });

    it('errors (no fallback) when the clone fails and there is no zip', async () => {
        cloneFails();
        const student = makeStudent('NoZip', { github: 'https://github.com/x/y' });
        await extractStudentCode(student, root, outDir());
        expect(student.extractedDir).toBeUndefined();
        expect(student.error).toMatch(/clone/i);
    });

    it('extracts the zip and never clones when there is no repo link (zip-only unchanged)', async () => {
        const student = makeStudent('ZipOnly', { zip: true });
        await extractStudentCode(student, root, outDir());
        expect(execFileSync).not.toHaveBeenCalled();
        expect(student.extractedDir).toMatch(/extracted_code$/);
        expect(existsSync(join(student.extractedDir, 'FROM_ZIP.txt'))).toBe(true);
    });
});
