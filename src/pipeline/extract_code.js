/**
 * extract_code.js
 * 
 * Handles unzipping .zip files or cloning GitHub repositories
 * based on URLs found in onlinetext.html
 */

import fs from 'fs';
const fsp = fs.promises;
import path from 'path';
import { execFileSync } from 'child_process';
import AdmZip from 'adm-zip';

const CODE_DIR = 'extracted_code';
const REPO_DIR = 'repo';

// Default URL categories to look for in a student's onlinetext.html — overridable via
// config.urlPatterns (e.g. a course using GitLab or a different deployment host). Keys
// become the labels under student.urls; "github" is structurally special (it decides
// whether the pipeline clones a repo vs. extracts a zip), the rest are just labels
// consumed by url_check/deploy_check mappings.
const DEFAULT_URL_PATTERNS = { github: 'github.com', citstudent: 'citstudent.lanecc.edu' };

// Replace spaces and filesystem-unfriendly characters with hyphens for directory/file names.
// Exported for reuse by other acquisition sources (e.g. Canvas) that need the same
// directory-naming convention.
export const toSafeName = name => name.replace(/[\s/\\:*?"<>|]+/g, '-');

// Read a file with a timeout — protects against Google Drive blocking reads on unsynced files
async function readFileWithTimeout(filePath, timeoutMs = 10000) {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Google Drive sync timed out')), timeoutMs);
    });
    try {
        return await Promise.race([
            fsp.readFile(filePath, 'utf8'),
            timeoutPromise
        ]);
    } finally {
        clearTimeout(timeoutHandle);
    }
}

// Extracts a cloneable GitHub URL from various GitHub URL formats
// Handles: /owner/repo, /owner/repo.git, /owner/repo/tree/branch/path, etc.
function normalizeGithubUrl(url) {
    const match = url.match(/^https:\/\/github\.com\/([\w.\-]+)\/([\w.\-]+?)(?:\/.*)?$/);
    if (!match) return null;
    const repo = match[2].replace(/\.git$/, '');
    return `https://github.com/${match[1]}/${repo}.git`;
}

// Extract subdirectory path from GitHub tree URLs like /tree/main/Week%203/Lab%203
// Returns "Week 3/Lab 3" from "https://github.com/owner/repo/tree/main/Week%203/Lab%203"
function getGithubSubdir(url) {
    const treeMatch = url.match(/\/tree\/([^/]+)\/(.+)$/);
    if (treeMatch) {
        return decodeURIComponent(treeMatch[2]);
    }
    return null;
}

function getStudents(labDir) {
    const files = fs.readdirSync(labDir);
    const students = {};

    files.forEach(f => {
        const fullPath = path.join(labDir, f);
        if (!fs.statSync(fullPath).isDirectory()) return;

        const match = f.match(/^(.*?)_([0-9]+)_assignsubmission_(file|onlinetext)$/);
        if (match) {
            const name = match[1];
            if (!students[name]) students[name] = { name, filesDir: '', textDir: '', zipFile: null };
            if (match[3] === 'file') {
                students[name].filesDir = fullPath;
                const inner = fs.readdirSync(fullPath);
                inner.forEach(iFiles => {
                    if (iFiles.toLowerCase().endsWith('.zip')) {
                        students[name].zipFile = path.join(fullPath, iFiles);
                    }
                });
            } else {
                students[name].textDir = fullPath;
            }
        }
    });

    return Object.values(students);
}

// If the GitHub URL points to a subdirectory (tree URL), adjust student.extractedDir to point
// at that subdirectory. Exported so any acquisition source that clones a GitHub repo (Moodle's
// onlinetext.html link or a Canvas-submitted URL) applies the same tree-URL handling.
function applyGithubSubdir(student, urls) {
    if (!(urls.github && student.extractedDir && fs.existsSync(student.extractedDir))) return;
    const subdir = getGithubSubdir(urls.github);
    if (!subdir) return;
    const subdirPath = path.join(student.extractedDir, subdir);
    if (fs.existsSync(subdirPath)) {
        student.extractedDir = subdirPath;
        console.log(`  Using subdirectory: ${subdir} for ${student.name}`);
    } else {
        console.log(`  Warning: tree URL subdirectory "${subdir}" not found in cloned repo for ${student.name} — repo may have been reorganized since submission`);
    }
}

function emptyUrls(urlPatterns) {
    const urls = {};
    for (const key of Object.keys(urlPatterns)) urls[key] = null;
    return urls;
}

// Scans raw text (an HTML fragment or a bare URL string) for URLs matching each configured
// category, preferring an href="..." match over a bare-URL match for the same category.
// Exported so any acquisition source that already has the text/URL in hand (e.g. a Canvas
// submission body or a directly-submitted URL) can reuse the same category matching that
// extractUrls() applies to onlinetext.html, without needing a file on disk.
export function matchUrlCategories(content, urlPatterns = DEFAULT_URL_PATTERNS) {
    const urls = emptyUrls(urlPatterns);
    const entries = Object.entries(urlPatterns);

    const hrefRegex = /href="(.*?)"/g;
    let m;
    while ((m = hrefRegex.exec(content)) !== null) {
        for (const [key, pattern] of entries) {
            if (m[1].includes(pattern)) urls[key] = m[1];
        }
    }

    const plainUrlRegex = /https?:\/\/[^\s<>"]+/g;
    while ((m = plainUrlRegex.exec(content)) !== null) {
        for (const [key, pattern] of entries) {
            if (m[0].includes(pattern) && !urls[key]) urls[key] = m[0];
        }
    }
    return urls;
}

async function extractUrls(textDir, urlPatterns = DEFAULT_URL_PATTERNS) {
    if (!textDir) return emptyUrls(urlPatterns);
    const textFile = path.join(textDir, 'onlinetext.html');
    if (!fs.existsSync(textFile)) return emptyUrls(urlPatterns);

    let content;
    try {
        content = await readFileWithTimeout(textFile, 10000);
    } catch (e) {
        // Google Drive timeout — skip this student rather than hanging the pipeline
        console.log(`  Warning: timeout reading onlinetext.html for a student (Google Drive may be slow) — skipping`);
        return emptyUrls(urlPatterns);
    }
    return matchUrlCategories(content, urlPatterns);
}

// Extracts student.zipFile into codeDir, sets student.extractedDir on success, and returns
// whether it worked. Uses adm-zip (in-process) rather than shelling out to `unzip`, which is
// not installed on stock Windows. true = overwrite existing files (-o).
function extractZip(student, codeDir) {
    try {
        new AdmZip(student.zipFile).extractAllTo(codeDir, true);
        student.extractedDir = codeDir;
        return true;
    } catch (e) {
        console.log(`  Failed to unzip for ${student.name}`);
        return false;
    }
}

// Given an already-resolved codeDir and urls map, does the actual clone/unzip into codeDir,
// setting student.extractedDir/student.error. Idempotent — skips if codeDir already has real
// content. Shared by extractStudentCode() (Moodle path resolution below) and any other
// acquisition source (e.g. Canvas) that resolves codeDir/urls its own way but wants the same
// clone-with-fallback/unzip mechanics.
function acquireCode(student, codeDir, urls) {
    // We only skip if the folder exists AND has actual content (not just .git or empty)
    if (fs.existsSync(codeDir)) {
        const contents = fs.readdirSync(codeDir).filter(f => !f.startsWith('.'));
        if (contents.length > 0) {
            student.extractedDir = codeDir;
            console.log(`  Already ${urls.github ? 'cloned' : 'extracted'}: ${student.name}`);
            return;
        }
        // Directory exists but is empty/broken — remove it so we retry
        console.log(`  Found empty ${path.basename(codeDir)} for ${student.name}, retrying...`);
        fs.rmSync(codeDir, { recursive: true, force: true });
    }

    fs.mkdirSync(codeDir, { recursive: true });

    // When a student submits BOTH a GitHub repo link and a zip, prefer the repository (the zip
    // is usually a stale or accidental extra) and alert the grader that both were present.
    if (urls.github && student.zipFile) {
        console.log(`  NOTE: ${student.name} submitted BOTH a GitHub repo link AND a zip — using the repository (the zip is a fallback only if the clone fails).`);
    }

    if (urls.github) {
        const normalizedUrl = normalizeGithubUrl(urls.github);
        if (normalizedUrl) {
            console.log(`  Cloning repo for ${student.name}...`);
            try {
                // --depth 1 to make cloning faster; SIGKILL ensures hung processes don't freeze the pipeline.
                // stderr is captured (not 'ignore'd) so the catch block's e.stderr branch below
                // actually has diagnostics to report instead of always falling through to e.message.
                execFileSync('git', ['clone', '--depth', '1', normalizedUrl, codeDir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL' });
                student.extractedDir = codeDir;
            } catch (e) {
                const reason = e.killed ? '(timed out after 60s)' : e.stderr ? e.stderr.toString().trim() : e.message;
                console.log(`  Failed to clone repo for ${student.name} ${reason}`);
            }
        } else {
            console.log(`  Invalid GitHub URL for ${student.name}: ${urls.github}`);
        }

        // Repository is preferred, but if it couldn't be obtained and a zip was also submitted,
        // fall back to extracting the zip rather than losing the submission.
        if (!student.extractedDir && student.zipFile) {
            console.log(`  Repository unavailable — falling back to the submitted zip for ${student.name}.`);
            extractZip(student, codeDir);
        }
        if (!student.extractedDir) {
            student.error = normalizedUrl ? 'Failed to clone GitHub repository' : 'Invalid GitHub URL format';
        }
    } else if (student.zipFile) {
        console.log(`  Extracting zip for ${student.name}...`);
        if (!extractZip(student, codeDir)) student.error = 'Failed to unzip ZIP file';
    } else {
        console.log(`  No code source found for ${student.name}`);
        student.error = 'No ZIP file or GitHub URL found';
    }
}

async function extractStudentCode(student, labDir, repoClonePath, urlPatterns = DEFAULT_URL_PATTERNS) {
    const urls = await extractUrls(student.textDir, urlPatterns);
    // Prefer the GitHub repository over a submitted zip when both are present, so the dir is
    // named for the repo (the zip is only used as a fallback if the clone fails).
    const codeDirName = urls.github ? REPO_DIR : CODE_DIR;

    // Determine where to put the code: repoClonePath (SubmissionsAndAssessment) or fallback to filesDir
    let codeDir;
    if (repoClonePath) {
        const safeName   = toSafeName(student.name);
        const studentDir = path.join(repoClonePath, safeName);
        codeDir          = path.join(studentDir, codeDirName);
        student.gradeDir = studentDir;

        // Backward compatibility: if already-extracted code lives at the old path with spaces,
        // reuse it rather than forcing a re-clone into the new hyphenated path.
        if (safeName !== student.name) {
            const legacyDir  = path.join(repoClonePath, student.name);
            const legacyCode = path.join(legacyDir, codeDirName);
            if (!fs.existsSync(codeDir) && fs.existsSync(legacyCode)) {
                const contents = fs.readdirSync(legacyCode).filter(f => !f.startsWith('.'));
                if (contents.length > 0) {
                    codeDir          = legacyCode;
                    student.gradeDir = legacyDir;
                }
            }
        }
    } else {
        codeDir = path.join(student.filesDir || labDir, codeDirName);
        student.gradeDir = student.filesDir || null;
    }

    acquireCode(student, codeDir, urls);

    return urls;
}

export default async function(labDir, repoClonePath, config = {}) {
    console.log("--- Code Acquisition Phase ---");
    const urlPatterns = { ...DEFAULT_URL_PATTERNS, ...(config.urlPatterns || {}) };
    if (repoClonePath) {
        try {
            fs.mkdirSync(repoClonePath, { recursive: true });
        } catch (e) {
            const err = new Error(e.message);
            err.code = 'CODE_STORAGE_ERROR';
            err.repoClonePath = repoClonePath;
            throw err;
        }
    }
    const students = getStudents(labDir);
    const urlsReport = {};

    for (const student of students) {
        try {
            const urls = await extractStudentCode(student, labDir, repoClonePath, urlPatterns);
            urlsReport[student.name] = urls;

            // Ensure student has extractedDir field for downstream
            // (set inside extractStudentCode; only compute fallback if it wasn't)
            if (!student.extractedDir) {
                student.extractedDir = student.filesDir ? path.join(student.filesDir, CODE_DIR) : null;
            }
            if (!student.gradeDir) {
                student.gradeDir = student.filesDir || null;
            }
            student.urls = urls;

            applyGithubSubdir(student, urls);
        } catch (e) {
            console.log(`  ERROR: Failed to process ${student.name}: ${e.message}`);
            student.error = e.message;
        }
    }

    return students; // returns array of augmented student objects
};

export { CODE_DIR, REPO_DIR, DEFAULT_URL_PATTERNS, extractStudentCode, extractUrls, acquireCode, applyGithubSubdir, extractZip, normalizeGithubUrl, emptyUrls };
