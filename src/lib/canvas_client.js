/**
 * canvas_client.js
 *
 * Thin Canvas LMS REST API wrapper, ported from the proof-of-concept at
 * CourseVibeCoding/Node/download_assignment_submissions.js and trimmed to what the grader
 * needs: no CLI/.env handling here — credentials are passed in via `canvasConfig` (resolved
 * by bin/grade.js from CANVAS_URL/CANVAS_TOKEN env vars or configs/local-config.json, the
 * same env-then-local-config precedence src/lib/llm_client.js uses for its API keys).
 *
 * Uses Node's built-in global fetch (Node >= 20, already this repo's engines floor) — no new
 * dependency.
 */

import fs from 'fs';
const fsp = fs.promises;

/** Raised for a non-OK Canvas API response, carrying the HTTP status. */
class CanvasError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'CanvasError';
        this.status = status;
    }
}

/** Strip the Canvas token out of any string before it's printed, logged, or thrown. */
function sanitize(text, token) {
    text = String(text);
    if (token) text = text.split(token).join('***REDACTED***');
    return text;
}

/**
 * Reduce whatever was typed or pasted as the Canvas URL to its origin
 * ("https://canvas.lanecc.edu/courses/680" -> "https://canvas.lanecc.edu"),
 * adding https:// when the scheme is missing. Unparseable input is returned trimmed.
 */
function normalizeCanvasUrl(input) {
    const text = String(input || '').trim();
    if (!text) return '';
    try {
        return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).origin;
    } catch {
        return text.replace(/\/+$/, '');
    }
}

function apiBase(canvasConfig) {
    return normalizeCanvasUrl(canvasConfig.url) + '/api/v1';
}

function authHeaders(canvasConfig) {
    return { Authorization: `Bearer ${canvasConfig.token}` };
}

async function canvasError(res, canvasConfig) {
    const body = await res.text().catch(() => '');
    return new CanvasError(
        res.status,
        `${res.status} ${res.statusText} for ${sanitize(res.url, canvasConfig.token)} ${sanitize(body, canvasConfig.token).slice(0, 300)}`.trim()
    );
}

/** GET one JSON resource from the Canvas API (path relative to /api/v1). */
async function apiGetJson(pathAndQuery, canvasConfig) {
    const res = await fetch(`${apiBase(canvasConfig)}${pathAndQuery}`, { headers: authHeaders(canvasConfig) });
    if (!res.ok) throw await canvasError(res, canvasConfig);
    return res.json();
}

/** Parse the rel="next" URL out of a Canvas Link header, or null. */
function parseNextLink(linkHeader) {
    if (!linkHeader) return null;
    for (const part of linkHeader.split(',')) {
        const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
        if (m) return m[1];
    }
    return null;
}

/**
 * GET every page of a paginated Canvas list endpoint, following the Link header's
 * rel="next".
 */
async function apiGetAll(pathAndQuery, canvasConfig) {
    const sep = pathAndQuery.includes('?') ? '&' : '?';
    let url = `${apiBase(canvasConfig)}${pathAndQuery}${sep}per_page=100`;
    const results = [];
    while (url) {
        const res = await fetch(url, { headers: authHeaders(canvasConfig) });
        if (!res.ok) throw await canvasError(res, canvasConfig);
        const page = await res.json();
        results.push(...page);
        url = parseNextLink(res.headers.get('link'));
    }
    return results;
}

/**
 * True if this assignment shell is actually a quiz (classic or New Quizzes) or a graded
 * discussion/forum, per the note that both get exposed through the assignments endpoint
 * alongside plain assignments. submission_types alone can't tell New Quizzes apart from some
 * other external-tool assignment, so that case also checks the LTI launch URL for
 * Instructure's quiz-lti domain.
 */
function isQuizOrForum(assignment) {
    const submissionTypes = assignment.submission_types || [];
    if (submissionTypes.includes('discussion_topic')) return true;
    if (assignment.quiz_id != null) return true;
    if (assignment.is_quiz_assignment) return true;
    if (submissionTypes.includes('external_tool')) {
        const tool = assignment.external_tool_tag_attributes || {};
        if ((tool.url || '').includes('quiz-lti')) return true;
    }
    return false;
}

function getCourse(courseId, canvasConfig) {
    return apiGetJson(`/courses/${courseId}`, canvasConfig);
}

async function listAssignments(courseId, canvasConfig) {
    const assignments = await apiGetAll(`/courses/${courseId}/assignments`, canvasConfig);
    return assignments.filter(a => !isQuizOrForum(a));
}

/** Every submission for one assignment, with `submission.user.name` populated. */
function listSubmissions(courseId, assignmentId, canvasConfig) {
    return apiGetAll(`/courses/${courseId}/assignments/${assignmentId}/submissions?include[]=user`, canvasConfig);
}

/** Download a single URL to dest, returning the byte count written. */
async function downloadFile(url, dest) {
    const res = await fetch(url);
    if (!res.ok) throw new CanvasError(res.status, `download failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.writeFile(dest, buf);
    return buf.length;
}

export { CanvasError, sanitize, normalizeCanvasUrl, isQuizOrForum, getCourse, listAssignments, listSubmissions, downloadFile };
