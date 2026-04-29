/**
 * extract_code.js
 * 
 * Handles unzipping .zip files or cloning GitHub repositories
 * based on URLs found in onlinetext.html
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

function extractUrls(textDir) {
    if (!textDir) return { citstudent: null, github: null };
    const textFile = path.join(textDir, 'onlinetext.html');
    if (!fs.existsSync(textFile)) return { citstudent: null, github: null };

    const content = fs.readFileSync(textFile, 'utf8');
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

function extractStudentCode(student, labDir) {
    const urls = extractUrls(student.textDir);
    const unzippedDir = path.join(student.filesDir || labDir, 'extracted_code'); // if no filesDir, put in root (fallback)
    
    // We only skip if the folder exists AND has actual content (not just .git or empty)
    if (fs.existsSync(unzippedDir)) {
        const contents = fs.readdirSync(unzippedDir).filter(f => !f.startsWith('.'));
        if (contents.length > 0) {
            console.log(`  Already extracted: ${student.name}`);
            return urls;
        }
        // Directory exists but is empty/broken — remove it so we retry
        console.log(`  Found empty extracted_code for ${student.name}, retrying...`);
        fs.rmSync(unzippedDir, { recursive: true, force: true });
    }

    if (student.filesDir) {
        fs.mkdirSync(unzippedDir, { recursive: true });
    }

    if (student.zipFile) {
        console.log(`  Unzipping for ${student.name}...`);
        try {
            execFileSync('unzip', ['-o', student.zipFile, '-d', unzippedDir], { stdio: 'ignore' });
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
        console.log(`  Cloning GitHub repo for ${student.name}...`);
        try {
            // --depth 1 to make cloning faster
            execFileSync('git', ['clone', '--depth', '1', normalizedUrl, unzippedDir], { stdio: 'ignore' });
        } catch (e) {
            console.log(`  Failed to clone github repo for ${student.name}`);
            student.error = 'Failed to clone GitHub repository';
        }
    } else {
        console.log(`  No code source found for ${student.name}`);
        student.error = 'No ZIP file or GitHub URL found';
    }

    return urls;
}

module.exports = function(labDir) {
    console.log("--- Extraction Phase ---");
    const students = getStudents(labDir);
    const urlsReport = {};

    students.forEach(student => {
        const urls = extractStudentCode(student, labDir);
        urlsReport[student.name] = urls;

        // Ensure student has extractedDir field for downstream
        student.extractedDir = student.filesDir ? path.join(student.filesDir, 'extracted_code') : null;
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
    });

    return students; // returns array of augmented student objects
};
