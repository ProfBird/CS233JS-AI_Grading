/**
 * validate_html.js
 *
 * Validates each student's .html source files with html-validate (pure JS, offline).
 * Attaches results to each student object as student.htmlValidation, mirroring the
 * shape of student.lint so the grader handlers, reports, and stock-comment tiers
 * all work identically.
 */

const fs = require('fs');
const path = require('path');
const { getAllFilesByExt } = require('../lib/file_walker');

const HTML_REPORT = 'html_validation_report.json';

// Aggregates html-validate per-file reports into { errors, warnings, messages, ruleCounts }.
// messages is a "rule: count" list sorted by frequency (matches lint_code output).
function aggregate(reports) {
    let errors = 0, warnings = 0;
    const ruleCounts = {};
    for (const report of reports) {
        for (const msg of report.messages) {
            const rule = msg.ruleId || 'parse-error';
            ruleCounts[rule] = (ruleCounts[rule] || 0) + 1;
            if (msg.severity === 2) errors++; else warnings++;
        }
    }
    const messages = Object.entries(ruleCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([rule, count]) => `${rule}: ${count}`);
    return { errors, warnings, messages, ruleCounts };
}

// Validates a list of HTML file paths. Returns the aggregated result.
// `options` (from config.validate) can override the ruleset:
//   extends — preset list (default ['html-validate:recommended'])
//   rules   — per-rule overrides, e.g. { "no-trailing-whitespace": "off" }
// The default turns off the purely-cosmetic whitespace rule so "free of errors"
// reflects real validity issues, not formatting nits.
async function validateHtmlFiles(htmlFiles, options = {}) {
    if (htmlFiles.length === 0) return { errors: 0, warnings: 0, messages: [], ruleCounts: {} };

    let HtmlValidate;
    try {
        ({ HtmlValidate } = require('html-validate'));
    } catch (e) {
        return { errors: 0, warnings: 0, messages: ['html-validate not installed'], ruleCounts: {} };
    }

    const hv = new HtmlValidate({
        extends: options.extends || ['html-validate:recommended'],
        rules: { 'no-trailing-whitespace': 'off', ...(options.rules || {}) },
    });
    const reports = [];
    for (const file of htmlFiles) {
        try {
            const source = fs.readFileSync(file, 'utf8');
            const report = await hv.validateString(source, file);
            for (const r of report.results) reports.push(r);
        } catch (e) {
            reports.push({ messages: [{ ruleId: 'read-error', severity: 2, message: e.message }] });
        }
    }
    return aggregate(reports);
}

module.exports = async function(students, config, labDir) {
    console.log('--- HTML Validation Phase ---');

    const validateCfg = config.validate || {};
    const exclusions = validateCfg.exclude || [];
    const htmlOptions = { extends: validateCfg.htmlExtends, rules: validateCfg.htmlRules };

    for (const student of students) {
        if (!student.extractedDir || !fs.existsSync(student.extractedDir)) {
            student.htmlValidation = { htmlFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} };
            continue;
        }

        const htmlFiles = getAllFilesByExt(student.extractedDir, ['.html', '.htm'], exclusions);
        if (htmlFiles.length === 0) {
            student.htmlValidation = { htmlFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} };
            continue;
        }

        const result = await validateHtmlFiles(htmlFiles, htmlOptions);
        console.log(`  ${student.name}: ${htmlFiles.length} files, ${result.errors} errors, ${result.warnings} warnings`);
        student.htmlValidation = { htmlFiles: htmlFiles.length, ...result };
    }

    const report = students.map(s => ({
        student: s.name,
        htmlFiles: s.htmlValidation ? s.htmlValidation.htmlFiles : 0,
        errors: s.htmlValidation ? s.htmlValidation.errors : 0,
        warnings: s.htmlValidation ? s.htmlValidation.warnings : 0,
        messages: s.htmlValidation ? s.htmlValidation.messages : []
    }));
    fs.writeFileSync(path.join(labDir, HTML_REPORT), JSON.stringify(report, null, 2));
    console.log(`Created ${HTML_REPORT} for ${report.length} students.`);
};

module.exports.validateHtmlFiles = validateHtmlFiles;
module.exports.aggregate = aggregate;
