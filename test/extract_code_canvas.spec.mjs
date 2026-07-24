/**
 * extract_code_canvas.spec.mjs
 *
 * Mocks src/lib/canvas_client.js's network calls and (like test/extract_code.spec.mjs)
 * child_process's execFileSync, so importFromCanvas can be exercised against a real tmpdir
 * with no actual network/git access. Verifies each Canvas submission_type maps into the same
 * students[] shape extract_code.js's Moodle path produces (name/extractedDir/gradeDir/
 * filesDir/urls/error), and that the shared acquireCode/matchUrlCategories mechanics
 * (zip extraction, GitHub clone, idempotent skip) work identically through this source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';

vi.mock('child_process', async () => {
    const actual = await vi.importActual('child_process');
    return { ...actual, execFileSync: vi.fn() };
});
import { execFileSync } from 'child_process';

vi.mock('../src/lib/canvas_client.js', () => ({
    listSubmissions: vi.fn(),
    downloadFile: vi.fn(),
}));
import * as canvasClient from '../src/lib/canvas_client.js';

const { default: importFromCanvas, importOneSubmission } = await import('../src/pipeline/extract_code_canvas.js');

function onlineUploadSubmission(overrides = {}) {
    return {
        user_id: 1,
        user: { name: 'Jamie Diaz' },
        submission_type: 'online_upload',
        workflow_state: 'submitted',
        attachments: [{ filename: 'lab03.zip', url: 'https://canvas.example/files/1/download' }],
        ...overrides,
    };
}

describe('importOneSubmission', () => {
    let root;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'canvas-extract-'));
        vi.mocked(execFileSync).mockReset();
        vi.mocked(canvasClient.downloadFile).mockReset();
        // Default: write a real zip when dest looks like a .zip, plain text otherwise — lets
        // acquireCode's real AdmZip-based extraction run against genuine archive bytes.
        vi.mocked(canvasClient.downloadFile).mockImplementation(async (url, dest) => {
            mkdirSync(dirname(dest), { recursive: true });
            if (dest.toLowerCase().endsWith('.zip')) {
                const z = new AdmZip();
                z.addFile('FROM_CANVAS_ZIP.txt', Buffer.from('from canvas zip'));
                z.writeZip(dest);
            } else {
                writeFileSync(dest, `downloaded from ${url}`);
            }
            return 42;
        });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const cloneSucceeds = () => vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const dest = args[args.length - 1];
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'CLONED.txt'), 'cloned');
    });

    it('downloads a zip attachment and extracts it', async () => {
        const submissionsDir = join(root, 'out');
        const student = await importOneSubmission(onlineUploadSubmission(), submissionsDir, {});

        expect(student.name).toBe('Jamie Diaz');
        expect(student.extractedDir).toMatch(/extracted_code$/);
        expect(existsSync(join(student.extractedDir, 'FROM_CANVAS_ZIP.txt'))).toBe(true);
        expect(student.filesDir).toBeTruthy();
        expect(existsSync(join(student.filesDir, 'lab03.zip'))).toBe(true);
        expect(student.error).toBeUndefined();
    });

    it('errors when an online_upload submission has no attachments', async () => {
        const student = await importOneSubmission(onlineUploadSubmission({ attachments: [] }), join(root, 'out'), {});
        expect(student.error).toMatch(/no attachments/i);
        expect(student.extractedDir).toBeUndefined();
    });

    it('clones a GitHub link found in an online_text_entry body', async () => {
        cloneSucceeds();
        const submission = {
            user_id: 2,
            user: { name: 'Robin Lee' },
            submission_type: 'online_text_entry',
            workflow_state: 'submitted',
            body: '<p>My repo: <a href="https://github.com/robin/lab03">here</a></p>',
        };
        const student = await importOneSubmission(submission, join(root, 'out'), {});

        expect(student.urls.github).toBe('https://github.com/robin/lab03');
        expect(student.extractedDir).toMatch(/[/\\]repo$/);
        expect(existsSync(join(student.extractedDir, 'CLONED.txt'))).toBe(true);
    });

    it('treats an online_url submission the same as a pasted GitHub link', async () => {
        cloneSucceeds();
        const submission = {
            user_id: 3,
            user: { name: 'Sam Okoye' },
            submission_type: 'online_url',
            workflow_state: 'submitted',
            url: 'https://github.com/sam/lab03',
        };
        const student = await importOneSubmission(submission, join(root, 'out'), {});

        expect(student.urls.github).toBe('https://github.com/sam/lab03');
        expect(existsSync(join(student.extractedDir, 'CLONED.txt'))).toBe(true);
    });

    it('records "no submission yet" without creating any directories or hitting the network', async () => {
        const submissionsDir = join(root, 'out');
        const submission = { user_id: 4, user: { name: 'No Show' }, submission_type: null, workflow_state: 'unsubmitted' };
        const student = await importOneSubmission(submission, submissionsDir, {});

        expect(student.error).toMatch(/no submission yet/i);
        expect(existsSync(join(submissionsDir, 'No-Show'))).toBe(false);
        expect(canvasClient.downloadFile).not.toHaveBeenCalled();
    });

    it('records unsupported submission types without downloading', async () => {
        const submission = { user_id: 5, user: { name: 'Media Person' }, submission_type: 'media_recording', workflow_state: 'submitted' };
        const student = await importOneSubmission(submission, join(root, 'out'), {});

        expect(student.error).toMatch(/not supported/i);
        expect(canvasClient.downloadFile).not.toHaveBeenCalled();
    });

    it('does not re-download an online_upload submission already extracted (idempotent, like the Moodle path)', async () => {
        const submissionsDir = join(root, 'out');
        const submission = onlineUploadSubmission();

        await importOneSubmission(submission, submissionsDir, {});
        expect(canvasClient.downloadFile).toHaveBeenCalledTimes(1);

        const student2 = await importOneSubmission(submission, submissionsDir, {});
        expect(canvasClient.downloadFile).toHaveBeenCalledTimes(1); // still 1 — skipped on the second pass
        expect(student2.extractedDir).toBeTruthy();
    });
});

describe('importFromCanvas', () => {
    let root;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'canvas-extract-top-'));
        vi.mocked(canvasClient.listSubmissions).mockReset();
        vi.mocked(canvasClient.downloadFile).mockReset();
        vi.mocked(canvasClient.downloadFile).mockImplementation(async (url, dest) => {
            mkdirSync(dirname(dest), { recursive: true });
            const z = new AdmZip();
            z.addFile('FROM_CANVAS_ZIP.txt', Buffer.from('from canvas zip'));
            z.writeZip(dest);
            return 42;
        });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('lists submissions for the assignment and imports each one into students[]', async () => {
        const submissionsDir = join(root, 'out');
        vi.mocked(canvasClient.listSubmissions).mockResolvedValue([
            onlineUploadSubmission({ user_id: 10, user: { name: 'Ana Cruz' } }),
            { user_id: 11, user: { name: 'No Show' }, submission_type: null, workflow_state: 'unsubmitted' },
        ]);

        const students = await importFromCanvas({
            courseId: 1, assignmentId: 2, submissionsDir, canvasConfig: { url: 'x', token: 'y' }, urlPatterns: {},
        });

        expect(canvasClient.listSubmissions).toHaveBeenCalledWith(1, 2, { url: 'x', token: 'y' });
        expect(students).toHaveLength(2);
        expect(students.find(s => s.name === 'Ana Cruz').extractedDir).toBeTruthy();
        expect(students.find(s => s.name === 'No Show').error).toMatch(/no submission yet/i);
        expect(existsSync(submissionsDir)).toBe(true);
    });
});
