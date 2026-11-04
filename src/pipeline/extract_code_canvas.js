/**
 * extract_code_canvas.js
 *
 * Alternative code-acquisition source: imports a single assignment's submissions directly
 * from Canvas via the API instead of scanning a Moodle-downloaded labRoot folder
 * (src/pipeline/extract_code.js). Produces the exact same students[] shape extract_code.js's
 * default export does (`name`, `extractedDir`, `gradeDir`, `filesDir`, `urls`, optional
 * `error`), writing into the same `submissionsDir/<Student>/{repo,extracted_code}/` layout,
 * so every downstream pipeline phase (runtime check, analysis, lint, validation, grade
 * generation) and bin/grade.js's --reclone/--regrade handling work unchanged regardless of
 * which acquisition source populated submissionsDir.
 *
 * Reuses extract_code.js's clone/unzip/fallback mechanics (acquireCode) and URL-category
 * matching (matchUrlCategories) rather than reimplementing them — a Canvas online_text_entry
 * body or online_url is parsed for a GitHub link exactly like Moodle's onlinetext.html is.
 */

import fs from 'fs';
const fsp = fs.promises;
import path from 'path';
import { toSafeName, matchUrlCategories, acquireCode, acquireColabNotebook, applyGithubSubdir, CODE_DIR, REPO_DIR, DEFAULT_URL_PATTERNS, emptyUrls } from './extract_code.js';
import * as canvas from '../lib/canvas_client.js';
import { makeStudent } from '../lib/student.js';

const FILES_DIR = 'canvas_files';
const UNSAFE_FILENAME_RE = /[^A-Za-z0-9_.\-]+/g;

/** Collapse a Canvas-provided filename to a safe, flat basename. */
function safeFilename(name) {
    name = path.basename(name || 'file');
    name = name.replace(UNSAFE_FILENAME_RE, '_');
    return name || 'file';
}

// Downloads every attachment into destDir; returns the paths of any .zip files found among
// them (there's normally at most one, but a student could attach more than one by mistake).
async function downloadAttachments(attachments, destDir) {
    await fsp.mkdir(destDir, { recursive: true });
    const zipFiles = [];
    for (const att of attachments) {
        const filename = safeFilename(att.filename || att.display_name);
        const dest = path.join(destDir, filename);
        await canvas.downloadFile(att.url, dest);
        if (filename.toLowerCase().endsWith('.zip')) zipFiles.push(dest);
    }
    return zipFiles;
}

async function importOneSubmission(submission, submissionsDir, urlPatterns) {
    // Merge onto the same defaults extract_code.js's default export uses, so an unconfigured
    // config.urlPatterns still detects github/citstudent links exactly like the Moodle path.
    urlPatterns = { ...DEFAULT_URL_PATTERNS, ...(urlPatterns || {}) };

    const user = submission.user || {};
    const displayName = user.name || `user_${submission.user_id}`;
    const safeName = toSafeName(displayName);
    const studentDir = path.join(submissionsDir, safeName);

    const student = makeStudent({ name: displayName, gradeDir: studentDir, urls: emptyUrls(urlPatterns) });

    const submissionType = submission.submission_type ?? null;
    const workflowState = submission.workflow_state ?? 'unknown';
    if (workflowState === 'unsubmitted' || submissionType === null) {
        student.error = 'No submission yet.';
        console.log(`  - ${displayName}: no submission yet`);
        return student;
    }

    // Always one key per configured pattern (never a bare {}) — matches Moodle's
    // extractUrls()/emptyUrls() convention so student.urls.github is reliable regardless
    // of which acquisition source ran (an online_upload submission never touches
    // matchUrlCategories, so without this it would stay {}).
    let urls = emptyUrls(urlPatterns);
    if (submissionType === 'online_upload') {
        // Idempotent, same convention as the Moodle path: don't re-download attachments a
        // previous run already extracted successfully.
        const existingCodeDir = path.join(studentDir, CODE_DIR);
        if (fs.existsSync(existingCodeDir) && fs.readdirSync(existingCodeDir).filter(f => !f.startsWith('.')).length > 0) {
            student.extractedDir = existingCodeDir;
            student.filesDir = path.join(studentDir, FILES_DIR);
            console.log(`  Already extracted: ${displayName}`);
        } else {
            const attachments = submission.attachments || [];
            if (attachments.length === 0) {
                student.error = 'online_upload with no attachments.';
                console.log(`  WARNING: ${displayName}: online_upload but no attachments found`);
            } else {
                student.filesDir = path.join(studentDir, FILES_DIR);
                console.log(`  Downloading ${attachments.length} file(s) for ${displayName}...`);
                const zipFiles = await downloadAttachments(attachments, student.filesDir);
                if (zipFiles.length > 0) {
                    student.zipFile = zipFiles[0];
                    if (zipFiles.length > 1) {
                        console.log(`  NOTE: ${displayName} submitted multiple zip attachments — using ${path.basename(zipFiles[0])}`);
                    }
                }
            }
        }
    } else if (submissionType === 'online_text_entry') {
        urls = matchUrlCategories(submission.body || '', urlPatterns);
    } else if (submissionType === 'online_url') {
        urls = matchUrlCategories(submission.url || '', urlPatterns);
    } else {
        student.error = `Canvas submission_type "${submissionType}" is not supported by Canvas import.`;
        console.log(`  - ${displayName}: submission_type "${submissionType}" not supported, skipping`);
        return student;
    }

    // Skip acquireCode when a definitive outcome (already-extracted fast path, or a hard error
    // like "no attachments") was already determined above — acquireCode would otherwise
    // overwrite student.error with its own generic "no code source found" error.
    if (!student.extractedDir && !student.error) {
        const codeDir = path.join(studentDir, urls.github ? REPO_DIR : CODE_DIR);
        acquireCode(student, codeDir, urls);
        // A Colab link (online_text_entry / online_url) with no other code: fetch the notebook.
        await acquireColabNotebook(student, codeDir, urls);
    }
    applyGithubSubdir(student, urls);
    student.urls = urls;

    return student;
}

// importFromCanvas({ courseId, assignmentId, submissionsDir, canvasConfig, urlPatterns }) ->
// students[], matching extract_code.js's default-export contract.
export default async function importFromCanvas({ courseId, assignmentId, submissionsDir, canvasConfig, urlPatterns }) {
    console.log("--- Code Acquisition Phase (Canvas) ---");
    try {
        fs.mkdirSync(submissionsDir, { recursive: true });
    } catch (e) {
        const err = new Error(e.message);
        err.code = 'CODE_STORAGE_ERROR';
        err.repoClonePath = submissionsDir;
        throw err;
    }

    const submissions = await canvas.listSubmissions(courseId, assignmentId, canvasConfig);
    const students = [];
    for (const submission of submissions) {
        try {
            students.push(await importOneSubmission(submission, submissionsDir, urlPatterns));
        } catch (e) {
            const name = submission?.user?.name || `user_${submission?.user_id ?? '?'}`;
            console.log(`  ERROR: Failed to process ${name}: ${e.message}`);
            // makeStudent() so this fallback carries the same extractedDir/filesDir: null
            // keys the success path does — a bare {name, gradeDir, urls, error} literal
            // used to omit them entirely, which downstream code only worked around by
            // falsiness accident (undefined and null both read as "no code").
            students.push(makeStudent({ name, gradeDir: null, urls: emptyUrls(urlPatterns || DEFAULT_URL_PATTERNS), error: e.message }));
        }
    }
    return students;
}

export { importOneSubmission };
