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

// ── the whole phase over a Moodle download folder ─────────────────────────────

const extractPhase = (await import('../src/pipeline/extract_code.js')).default;
const { normalizeGithubUrl, applyGithubSubdir } = await import('../src/pipeline/extract_code.js');

describe('extract phase — a Moodle download folder', () => {
    let root, labDir, codeRoot;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'moodle-'));
        labDir = join(root, 'Lab03'); codeRoot = join(root, 'code');
        mkdirSync(labDir);
        vi.mocked(execFileSync).mockReset();
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    // One Moodle folder: "<Name>_<id>_assignsubmission_<file|onlinetext>"
    const moodle = (name, kind, files) => {
        const d = join(labDir, `${name}_123_assignsubmission_${kind}`);
        mkdirSync(d, { recursive: true });
        for (const [f, content] of Object.entries(files)) writeFileSync(join(d, f), content);
        return d;
    };
    const zipWith = (entries) => { const z = new AdmZip(); for (const [f, c] of Object.entries(entries)) z.addFile(f, Buffer.from(c)); return z.toBuffer(); };

    it("pairs each student's file and online-text folders, extracts into <codeRoot>/<Safe-Name>/, and reads their URLs", async () => {
        moodle('Ana Lopez', 'file', { 'lab.zip': zipWith({ 'main.js': 'x' }) });
        moodle('Ana Lopez', 'onlinetext', { 'onlinetext.html': '<a href="https://citstudent.lanecc.edu/~alopez/">site</a>' });
        moodle('Bo Wu', 'file', { 'app.py': 'print(1)' });
        mkdirSync(join(labDir, 'not a submission'));     // ignored
        writeFileSync(join(labDir, 'grades.csv'), '');   // ignored

        const students = await extractPhase(labDir, codeRoot);
        const byName = Object.fromEntries(students.map(s => [s.name, s]));
        expect(Object.keys(byName).sort()).toEqual(['Ana Lopez', 'Bo Wu']);

        const ana = byName['Ana Lopez'];
        expect(ana.gradeDir).toBe(join(codeRoot, 'Ana-Lopez'));
        expect(ana.extractedDir).toBe(join(codeRoot, 'Ana-Lopez', 'extracted_code'));
        expect(existsSync(join(ana.extractedDir, 'main.js'))).toBe(true);
        expect(ana.urls.citstudent).toBe('https://citstudent.lanecc.edu/~alopez/');
        expect(ana.urls.github).toBeNull();

        expect(readdirSync(byName['Bo Wu'].extractedDir)).toEqual(['app.py']);   // loose upload
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it('reuses code already extracted at the old space-named folder instead of re-extracting', async () => {
        moodle('Ana Lopez', 'file', { 'lab.zip': zipWith({ 'new.js': 'x' }) });
        const legacy = join(codeRoot, 'Ana Lopez', 'extracted_code');
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, 'old.js'), 'x');
        const [ana] = await extractPhase(labDir, codeRoot);
        expect(ana.extractedDir).toBe(legacy);
        expect(readdirSync(legacy)).toEqual(['old.js']);
    });

    it('clones a GitHub tree URL and grades the linked subfolder', async () => {
        moodle('Ana Lopez', 'onlinetext', { 'onlinetext.html': '<a href="https://github.com/ana/labs/tree/main/Week%203/Lab%203">repo</a>' });
        vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
            const target = args[args.length - 1];
            expect(args).toContain('https://github.com/ana/labs.git');
            mkdirSync(join(target, 'Week 3', 'Lab 3'), { recursive: true });
            writeFileSync(join(target, 'Week 3', 'Lab 3', 'main.js'), 'x');
        });
        const [ana] = await extractPhase(labDir, codeRoot);
        expect(ana.extractedDir).toBe(join(codeRoot, 'Ana-Lopez', 'repo', 'Week 3', 'Lab 3'));
    });

    it('reports a code storage folder that cannot be created', async () => {
        const blocker = join(root, 'file-not-folder');
        writeFileSync(blocker, '');
        await expect(extractPhase(labDir, join(blocker, 'code'))).rejects.toMatchObject({ code: 'CODE_STORAGE_ERROR' });
    });
});

describe('GitHub links', () => {
    it('normalizeGithubUrl turns any repo link into a clone URL, and rejects non-repo links', () => {
        for (const [url, clone] of [
            ['https://github.com/ana/labs', 'https://github.com/ana/labs.git'],
            ['https://github.com/ana/labs.git', 'https://github.com/ana/labs.git'],
            ['https://github.com/ana/my.labs/tree/main/Lab3', 'https://github.com/ana/my.labs.git'],
            ['https://github.com/ana', null],
            ['https://gitlab.com/ana/labs', null],
        ]) expect(normalizeGithubUrl(url), url).toBe(clone);
    });

    it("applyGithubSubdir keeps the repo root when the tree URL's folder no longer exists", () => {
        const dir = mkdtempSync(join(tmpdir(), 'subdir-'));
        const student = { name: 'S', extractedDir: dir };
        applyGithubSubdir(student, { github: 'https://github.com/a/b/tree/main/Gone' });
        expect(student.extractedDir).toBe(dir);
        rmSync(dir, { recursive: true, force: true });
    });
});
