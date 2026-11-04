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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
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

describe('extractStudentCode — loose uploaded files (no zip, no repo)', () => {
    let root;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'extract-loose-'));
        vi.mocked(execFileSync).mockReset();
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    // A Moodle-style file-submission dir holding the given loose files, plus an empty onlinetext.
    function looseStudent(name, files) {
        const textDir = join(root, `${name}_text`);
        mkdirSync(textDir, { recursive: true });
        writeFileSync(join(textDir, 'onlinetext.html'), '<p>no link</p>');
        const filesDir = join(root, `${name}_files`);
        mkdirSync(filesDir, { recursive: true });
        for (const f of files) writeFileSync(join(filesDir, f), `contents of ${f}`);
        return { name, textDir, filesDir, zipFile: null };
    }

    it('copies loose source files into extracted_code, skipping Word docs and hidden files', async () => {
        const student = looseStudent('Loose', ['shipping.py', 'recommender.py', 'rules.csv', 'CS212 Code Review.docx', '.DS_Store']);
        const out = join(root, 'out');
        mkdirSync(out);
        await extractStudentCode(student, root, out);

        expect(student.error).toBeUndefined();
        expect(student.extractedDir).toMatch(/extracted_code$/);
        expect(readdirSync(student.extractedDir).sort()).toEqual(['recommender.py', 'rules.csv', 'shipping.py']);
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it('still errors when the only upload is a Word document', async () => {
        const student = looseStudent('DocOnly', ['Code Review.docx']);
        const out = join(root, 'out');
        mkdirSync(out);
        await extractStudentCode(student, root, out);

        expect(student.extractedDir).toBeUndefined();
        expect(student.error).toMatch(/no zip file, github url, or uploaded source files/i);
    });

    // A zip (containing unsolvable_data/ and a main.py) next to loose uploads.
    function withZip(student, entries) {
        const zipFile = join(student.filesDir, 'data.zip');
        const z = new AdmZip();
        for (const [name, text] of Object.entries(entries)) z.addFile(name, Buffer.from(text));
        z.writeZip(zipFile);
        student.zipFile = zipFile;
        return student;
    }

    it('merges loose files uploaded alongside a zip; the zip wins a name collision', async () => {
        const student = withZip(
            looseStudent('Both', ['scheduler.py', 'main.py', 'Code Review.docx']),
            { 'unsolvable_data/sections.csv': 'a,b', 'main.py': 'FROM ZIP' },
        );
        const out = join(root, 'out');
        mkdirSync(out);
        await extractStudentCode(student, root, out);

        expect(student.error).toBeUndefined();
        expect(readdirSync(student.extractedDir).sort()).toEqual(['main.py', 'scheduler.py', 'unsolvable_data']);
        expect(readFileSync(join(student.extractedDir, 'main.py'), 'utf8')).toBe('FROM ZIP');
    });

    it('uses the loose files when the zip is corrupt', async () => {
        const student = looseStudent('BadZip', ['main.py']);
        student.zipFile = join(student.filesDir, 'broken.zip');
        writeFileSync(student.zipFile, 'not a zip');
        const out = join(root, 'out');
        mkdirSync(out);
        await extractStudentCode(student, root, out);

        expect(student.error).toBeUndefined();
        expect(readdirSync(student.extractedDir)).toEqual(['main.py']);
    });
});

describe('extractStudentCode — config-driven urlPatterns', () => {
    let root;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'urlpatterns-'));
        vi.mocked(execFileSync).mockReset();
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function makeTextOnlyStudent(name, html) {
        const textDir = join(root, `${name}_text`);
        mkdirSync(textDir, { recursive: true });
        writeFileSync(join(textDir, 'onlinetext.html'), html);
        return { name, textDir, zipFile: undefined };
    }

    it('defaults to citstudent/github when no urlPatterns are configured', async () => {
        const student = makeTextOnlyStudent('Default', '<a href="https://citstudent.lanecc.edu/~jdoe/">site</a>');
        const outDir = join(root, 'out'); mkdirSync(outDir, { recursive: true });
        const urls = await extractStudentCode(student, root, outDir);
        expect(urls.citstudent).toBe('https://citstudent.lanecc.edu/~jdoe/');
        expect(urls.github).toBeNull();
    });

    it('recognizes an additional URL type configured via urlPatterns', async () => {
        const student = makeTextOnlyStudent('Custom', '<a href="https://myapp.up.railway.app/">deploy</a>');
        const outDir = join(root, 'out'); mkdirSync(outDir, { recursive: true });
        const urlPatterns = { github: 'github.com', deploy: 'railway.app' };
        const urls = await extractStudentCode(student, root, outDir, urlPatterns);
        expect(urls.deploy).toBe('https://myapp.up.railway.app/');
        expect(urls.citstudent).toBeUndefined(); // not in the configured pattern set
    });
});
