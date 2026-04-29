/**
 * extract_code.js
 * 
 * Handles unzipping .zip files or cloning GitHub repositories
 * based on URLs found in onlinetext.html
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFileSync } = require('child_process');

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
                    if (iFiles.endsWith('.zip')) {
                        students[name].zipFile = path.join(fullPath, iFiles);
                    }
                });
            } else {
                students[name].textDir = fullPath;
            }
        }
    });

    // For students who only have _onlinetext (no _file dir), create one
    // so there's a place to clone code and write grade files
    for (const name of Object.keys(students)) {
        const student = students[name];
        if (!student.filesDir && student.textDir) {
            const fileDirName = student.textDir.replace('_assignsubmission_onlinetext', '_assignsubmission_file');
            fs.mkdirSync(fileDirName, { recursive: true });
            student.filesDir = fileDirName;
            console.log(`  Created _file directory for ${name} (text-only submission)`);
        }
    }

    return Object.values(students);
}

async function extractUrls(textDir) {
    if (!textDir) return { citstudent: null, github: null };
    const textFile = path.join(textDir, 'onlinetext.html');
    if (!fs.existsSync(textFile)) return { citstudent: null, github: null };

    let content;
    try {
        content = await readFileWithTimeout(textFile, 10000);
    } catch (e) {
        // Google Drive timeout — skip this student rather than hanging the pipeline
        console.log(`  Warning: timeout reading onlinetext.html for a student (Google Drive may be slow) — skipping`);
        return { citstudent: null, github: null };
    }
    const urls = { citstudent: null, github: null };

    const hrefRegex = /href="(.*?)"/g;
    let m;
    while ((m = hrefRegex.exec(content)) !== null) {
        if (m[1].includes('citstudent.lanecc.edu')) urls.citstudent = m[1];
        if (m[1].includes('github.com')) urls.github = m[1];
    }

    const plainUrlRegex = /https?:\/\/[^\s<>"]+/g;
    while ((m = plainUrlRegex.exec(content)) !== null) {
        if (m[0].includes('citstudent.lanecc.edu') && !urls.citstudent) urls.citstudent = m[0];
        if (m[0].includes('github.com') && !urls.github) urls.github = m[0];
    }
    return urls;
}

async function extractStudentCode(student, labDir, repoClonePath) {
    const urls = await extractUrls(student.textDir);
    // Use 'repo' for GitHub clones, 'extracted_code' for ZIP uploads
    const codeDirName = student.zipFile ? 'extracted_code' : (urls.github ? 'repo' : 'extracted_code');

    // Determine where to put the code: repoClonePath (outside Google Drive) or fallback to filesDir
    let codeDir;
    if (repoClonePath) {
        const studentDir = path.join(repoClonePath, student.name);
        codeDir = path.join(studentDir, codeDirName);
    } else {
        codeDir = path.join(student.filesDir || labDir, codeDirName);
    }

    // We only skip if the folder exists AND has actual content (not just .git or empty)
    if (fs.existsSync(codeDir)) {
        const contents = fs.readdirSync(codeDir).filter(f => !f.startsWith('.'));
        if (contents.length > 0) {
            student.extractedDir = codeDir;
            console.log(`  Already ${urls.github ? 'cloned' : 'extracted'}: ${student.name}`);
            return urls;
        }
        // Directory exists but is empty/broken — remove it so we retry
        console.log(`  Found empty ${codeDirName} for ${student.name}, retrying...`);
        fs.rmSync(codeDir, { recursive: true, force: true });
    }

    fs.mkdirSync(codeDir, { recursive: true });

    if (student.zipFile) {
        console.log(`  Extracting zip for ${student.name}...`);
        try {
            execFileSync('unzip', ['-o', student.zipFile, '-d', codeDir], { stdio: 'ignore' });
            student.extractedDir = codeDir;
        } catch (e) {
            console.log(`  Failed to unzip for ${student.name}`);
            student.error = 'Failed to unzip ZIP file';
        }
    } else if (urls.github) {
        const normalizedUrl = normalizeGithubUrl(urls.github);
        if (!normalizedUrl) {
            console.log(`  Invalid GitHub URL for ${student.name}: ${urls.github}`);
            student.error = 'Invalid GitHub URL format';
            return urls;
        }
        console.log(`  Cloning repo for ${student.name}...`);
        try {
            // --depth 1 to make cloning faster; SIGKILL ensures hung processes don't freeze the pipeline
            execFileSync('git', ['clone', '--depth', '1', normalizedUrl, codeDir], { stdio: 'ignore', timeout: 60_000, killSignal: 'SIGKILL' });
            student.extractedDir = codeDir;
        } catch (e) {
            const reason = e.killed ? '(timed out after 60s)' : e.stderr ? e.stderr.toString().trim() : e.message;
            console.log(`  Failed to clone repo for ${student.name} ${reason}`);
            student.error = 'Failed to clone GitHub repository';
        }
    } else {
        console.log(`  No code source found for ${student.name}`);
        student.error = 'No ZIP file or GitHub URL found';
    }

    return urls;
}

module.exports = async function(labDir, repoClonePath) {
    console.log("--- Code Acquisition Phase ---");
    if (repoClonePath) {
        fs.mkdirSync(repoClonePath, { recursive: true });
    }
    const students = getStudents(labDir);
    const urlsReport = {};

    for (const student of students) {
        try {
            const urls = await extractStudentCode(student, labDir, repoClonePath);
            urlsReport[student.name] = urls;

            // Ensure student has extractedDir field for downstream
            // (set inside extractStudentCode; only compute fallback if it wasn't)
            if (!student.extractedDir) {
                student.extractedDir = student.filesDir ? path.join(student.filesDir, 'extracted_code') : null;
            }
            student.urls = urls;

            // If the GitHub URL points to a subdirectory (tree URL), adjust extractedDir
            if (urls.github && student.extractedDir && fs.existsSync(student.extractedDir)) {
                const subdir = getGithubSubdir(urls.github);
                if (subdir) {
                    const subdirPath = path.join(student.extractedDir, subdir);
                    if (fs.existsSync(subdirPath)) {
                        student.extractedDir = subdirPath;
                        console.log(`  Using subdirectory: ${subdir} for ${student.name}`);
                    } else {
                        console.log(`  Warning: tree URL subdirectory "${subdir}" not found in cloned repo for ${student.name} — repo may have been reorganized since submission`);
                    }
                }
            }
        } catch (e) {
            console.log(`  ERROR: Failed to process ${student.name}: ${e.message}`);
            student.error = e.message;
        }
    }

    return students; // returns array of augmented student objects
};
