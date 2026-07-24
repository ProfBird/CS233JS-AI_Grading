/**
 * canvas_client.spec.mjs
 *
 * Mocks global fetch (the same vi.stubGlobal pattern test/generate_grades.spec.mjs uses for
 * the deploy_check mapping's fetch calls) to test the Canvas API wrapper without any real
 * network access.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
    CanvasError,
    sanitize,
    isQuizOrForum,
    getCourse,
    listAssignments,
    listSubmissions,
    downloadFile,
} from '../src/lib/canvas_client.js';

const canvasConfig = { url: 'https://school.instructure.com', token: 'sekret-token' };

function jsonResponse(body, { ok = true, status = 200, statusText = 'OK', headers = {} } = {}) {
    return {
        ok,
        status,
        statusText,
        url: 'https://school.instructure.com/api/v1/mocked',
        headers: { get: (h) => headers[h.toLowerCase()] ?? null },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('sanitize', () => {
    it('redacts the token wherever it appears', () => {
        expect(sanitize(`error calling with token sekret-token in the URL`, 'sekret-token'))
            .toBe('error calling with token ***REDACTED*** in the URL');
    });
    it('is a no-op when no token is given', () => {
        expect(sanitize('plain message', null)).toBe('plain message');
    });
});

describe('isQuizOrForum', () => {
    it('flags discussion_topic submissions', () => {
        expect(isQuizOrForum({ submission_types: ['discussion_topic'] })).toBe(true);
    });
    it('flags classic quizzes via quiz_id', () => {
        expect(isQuizOrForum({ quiz_id: 42, submission_types: ['online_quiz'] })).toBe(true);
    });
    it('flags New Quizzes via is_quiz_assignment', () => {
        expect(isQuizOrForum({ is_quiz_assignment: true, submission_types: ['external_tool'] })).toBe(true);
    });
    it('flags an external_tool assignment whose LTI URL is quiz-lti', () => {
        expect(isQuizOrForum({
            submission_types: ['external_tool'],
            external_tool_tag_attributes: { url: 'https://school.instructure.com/quiz-lti/launch' },
        })).toBe(true);
    });
    it('does not flag a plain online_upload assignment', () => {
        expect(isQuizOrForum({ submission_types: ['online_upload'] })).toBe(false);
    });
});

describe('getCourse', () => {
    it('fetches the course and returns its JSON', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 680, name: 'CS233JS', workflow_state: 'available' }));
        vi.stubGlobal('fetch', fetchMock);

        const course = await getCourse(680, canvasConfig);
        expect(course).toEqual({ id: 680, name: 'CS233JS', workflow_state: 'available' });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://school.instructure.com/api/v1/courses/680',
            { headers: { Authorization: 'Bearer sekret-token' } }
        );
    });

    it('throws a CanvasError carrying the status on a non-OK response, with the token redacted', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
            jsonResponse({ errors: [{ message: 'not found' }] }, { ok: false, status: 404, statusText: 'Not Found' })
        ));

        await expect(getCourse(999, canvasConfig)).rejects.toMatchObject({
            name: 'CanvasError',
            status: 404,
        });
    });

    it('never leaks the token in a thrown error message', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            url: `https://school.instructure.com/api/v1/courses/1?access_token=${canvasConfig.token}`,
            text: async () => `bad token: ${canvasConfig.token}`,
        }));

        try {
            await getCourse(1, canvasConfig);
            expect.fail('should have thrown');
        } catch (e) {
            expect(e.message).not.toContain(canvasConfig.token);
            expect(e.message).toContain('REDACTED');
        }
    });
});

describe('listAssignments', () => {
    it('paginates via the Link header and filters out quizzes/forums', async () => {
        const page1 = [
            { id: 1, name: 'Lab01', submission_types: ['online_upload'] },
            { id: 2, name: 'Quiz 1', submission_types: ['online_quiz'], quiz_id: 5 },
        ];
        const page2 = [
            { id: 3, name: 'Lab02', submission_types: ['online_upload'] },
            { id: 4, name: 'Discussion', submission_types: ['discussion_topic'] },
        ];
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse(page1, {
                headers: { link: '<https://school.instructure.com/api/v1/courses/1/assignments?page=2&per_page=100>; rel="next"' },
            }))
            .mockResolvedValueOnce(jsonResponse(page2));
        vi.stubGlobal('fetch', fetchMock);

        const assignments = await listAssignments(1, canvasConfig);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(assignments.map(a => a.name)).toEqual(['Lab01', 'Lab02']);
    });
});

describe('listSubmissions', () => {
    it('requests include[]=user and returns the submissions array', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse([
            { user_id: 1, user: { name: 'Jamie Diaz' }, submission_type: 'online_upload' },
        ]));
        vi.stubGlobal('fetch', fetchMock);

        const submissions = await listSubmissions(1, 42, canvasConfig);
        expect(submissions[0].user.name).toBe('Jamie Diaz');
        const calledUrl = fetchMock.mock.calls[0][0];
        expect(calledUrl).toContain('/courses/1/assignments/42/submissions');
        expect(calledUrl).toContain('include[]=user');
    });
});

describe('downloadFile', () => {
    let root;
    afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

    it('downloads the response body to dest and returns the byte count', async () => {
        root = mkdtempSync(join(tmpdir(), 'canvas-dl-'));
        const dest = join(root, 'submission.zip');
        const payload = Buffer.from('fake zip bytes');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
        }));

        const size = await downloadFile('https://school.instructure.com/files/1/download', dest);
        expect(size).toBe(payload.length);
        expect(existsSync(dest)).toBe(true);
        expect(readFileSync(dest).toString()).toBe('fake zip bytes');
    });

    it('throws a CanvasError when the download response is not OK', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' }));
        await expect(downloadFile('https://school.instructure.com/files/1/download', '/tmp/whatever'))
            .rejects.toMatchObject({ name: 'CanvasError', status: 403 });
    });
});

describe('CanvasError', () => {
    it('carries the status and behaves like a normal Error', () => {
        const e = new CanvasError(500, 'boom');
        expect(e).toBeInstanceOf(Error);
        expect(e.status).toBe(500);
        expect(e.message).toBe('boom');
    });
});
