/**
 * check_names.js
 *
 * Checks every file and folder name in a student's submission for Linux/web
 * portability. Students develop on Mac/Windows and deploy to a Linux server;
 * spaces, parentheses, and accented characters break URLs, builds, and
 * case-sensitive deploys.
 *
 * Rule: POSIX portable filename set + no spaces. A name is invalid if it
 * contains any character outside [A-Za-z0-9._-]. Uppercase is allowed; dotfiles
 * (.gitignore) pass naturally. Attaches student.nameCheck, mirroring the shape of
 * the validation phases so the grader handler, report, and stock-comment tiers
 * all work identically.
 */

const fs = require('fs');
const path = require('path');
const { walk, DEFAULT_SKIP_DIRS } = require('../lib/file_walker');

const NAME_REPORT = 'name_check_report.json';

// POSIX portable filename characters. extraAllowed adds chars the grader opts into.
function allowedRegex(extraAllowed = '') {
    const escaped = extraAllowed.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    return new RegExp(`^[A-Za-z0-9._${escaped}-]+$`);
}

// Returns null if the name is portable, else { reason }. Space is reported
// distinctly (it is also out-of-set, but called out specifically).
function validateName(name, { extraAllowed = '' } = {}) {
    if (/\s/.test(name)) return { reason: 'space' };
    if (!allowedRegex(extraAllowed).test(name)) return { reason: 'illegal character' };
    if (name.startsWith('-')) return { reason: 'leading hyphen' };
    if (Buffer.byteLength(name, 'utf8') > 255) return { reason: 'too long' };
    return null;
}

// Walks dir checking both file and folder names. Skips DEFAULT_SKIP_DIRS and
// dot-dirs (not descended into); the root wrapper dir name is not checked.
function findInvalidNames(dir, { exclusions = [], extraAllowed = '' } = {}) {
    const badNames = [];
    let entriesChecked = 0;
    const check = (full, name) => {
        if (DEFAULT_SKIP_DIRS.has(name)) return;
        entriesChecked++;
        const bad = validateName(name, { extraAllowed });
        if (bad) badNames.push({ name, path: path.relative(dir, full), reason: bad.reason });
    };
    walk(dir, {
        shouldSkip: full => exclusions.some(ex => full.toLowerCase().includes(ex.toLowerCase())),
        shouldDescend: (full, name) => !name.startsWith('.') && !DEFAULT_SKIP_DIRS.has(name),
        onFile: check,
        onDir: check,
    });
    return { entriesChecked, badNames };
}

module.exports = async function(students, config, labDir) {
    console.log('--- File/Folder Name Check Phase ---');

    const validateCfg = config.validate || {};
    const exclusions = validateCfg.exclude || [];
    const extraAllowed = (config.nameCheck && config.nameCheck.extraAllowed) || '';

    for (const student of students) {
        if (!student.extractedDir || !fs.existsSync(student.extractedDir)) {
            student.nameCheck = { entriesChecked: 0, errors: 0, messages: [], badNames: [] };
            continue;
        }

        const { entriesChecked, badNames } = findInvalidNames(student.extractedDir, { exclusions, extraAllowed });
        const messages = badNames.map(b => `${b.path} (${b.reason})`);
        if (badNames.length) {
            console.log(`  ${student.name}: ${badNames.length} invalid of ${entriesChecked} names`);
        }
        student.nameCheck = { entriesChecked, errors: badNames.length, messages, badNames };
    }

    const report = students.map(s => ({
        student: s.name,
        entriesChecked: s.nameCheck ? s.nameCheck.entriesChecked : 0,
        errors: s.nameCheck ? s.nameCheck.errors : 0,
        messages: s.nameCheck ? s.nameCheck.messages : []
    }));
    fs.writeFileSync(path.join(labDir, NAME_REPORT), JSON.stringify(report, null, 2));
    console.log(`Created ${NAME_REPORT} for ${report.length} students.`);
};

module.exports.validateName = validateName;
module.exports.findInvalidNames = findInvalidNames;
