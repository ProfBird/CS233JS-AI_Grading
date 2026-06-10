/**
 * validate_css.js
 *
 * Validates each student's .css source files with csstree-validator (pure JS, offline).
 * Attaches results to each student object as student.cssValidation, mirroring the
 * shape of student.lint so the grader handlers, reports, and stock-comment tiers
 * all work identically. csstree reports validity errors only (no warning tier).
 */

import fs from 'fs';
import path from 'path';
import { validate } from 'csstree-validator';
import { getAllFilesByExt } from '../lib/file_walker.js';

const CSS_REPORT = 'css_validation_report.json';

// Aggregates csstree error arrays into { errors, warnings, messages, ruleCounts }.
// csstree errors carry a `.name` (e.g. SyntaxReferenceError, SyntaxMatchError,
// CssSyntaxError); messages is a "name: count" list sorted by frequency.
function aggregate(errorLists) {
    let errors = 0;
    const ruleCounts = {};
    for (const list of errorLists) {
        for (const err of list) {
            const name = err.name || 'CssSyntaxError';
            ruleCounts[name] = (ruleCounts[name] || 0) + 1;
            errors++;
        }
    }
    const messages = Object.entries(ruleCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}: ${count}`);
    return { errors, warnings: 0, messages, ruleCounts };
}

// Validates a list of CSS file paths. Returns the aggregated result.
function validateCssFiles(cssFiles) {
    if (cssFiles.length === 0) return { errors: 0, warnings: 0, messages: [], ruleCounts: {} };

    const errorLists = [];
    for (const file of cssFiles) {
        try {
            const source = fs.readFileSync(file, 'utf8');
            errorLists.push(validate(source, file));
        } catch (e) {
            errorLists.push([{ name: 'read-error', message: e.message }]);
        }
    }
    return aggregate(errorLists);
}

export default async function(students, config, labDir) {
    console.log('--- CSS Validation Phase ---');

    const exclusions = (config.validate && config.validate.exclude) ? config.validate.exclude : [];

    for (const student of students) {
        if (!student.extractedDir || !fs.existsSync(student.extractedDir)) {
            student.cssValidation = { cssFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} };
            continue;
        }

        const cssFiles = getAllFilesByExt(student.extractedDir, '.css', exclusions);
        if (cssFiles.length === 0) {
            student.cssValidation = { cssFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} };
            continue;
        }

        const result = validateCssFiles(cssFiles);
        console.log(`  ${student.name}: ${cssFiles.length} files, ${result.errors} errors`);
        student.cssValidation = { cssFiles: cssFiles.length, ...result };
    }

    const report = students.map(s => ({
        student: s.name,
        cssFiles: s.cssValidation ? s.cssValidation.cssFiles : 0,
        errors: s.cssValidation ? s.cssValidation.errors : 0,
        messages: s.cssValidation ? s.cssValidation.messages : []
    }));
    fs.writeFileSync(path.join(labDir, CSS_REPORT), JSON.stringify(report, null, 2));
    console.log(`Created ${CSS_REPORT} for ${report.length} students.`);
};

export { validateCssFiles, aggregate };
