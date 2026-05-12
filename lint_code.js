/**
 * lint_code.js
 *
 * Lints the extracted code, ignoring paths defined in the config.
 * Attaches results directly to each student object as student.lint.
 */

const fs = require('fs');
const path = require('path');

const LINT_REPORT = 'lint_report.json';

function getAllJsFiles(dir, exclusions = []) {
    let results = [];
    try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const full = path.join(dir, item);
            const isExcluded = exclusions.some(ex => full.toLowerCase().includes(ex.toLowerCase()));

            if (isExcluded) continue;

            let stats;
            try { stats = fs.lstatSync(full); } catch (e) { continue; }
            if (stats.isSymbolicLink()) continue;

            if (stats.isDirectory()) {
                if (!item.startsWith('.') && item !== '__MACOSX') {
                    results = results.concat(getAllJsFiles(full, exclusions));
                }
            } else if (item.endsWith('.js')) {
                results.push(full);
            }
        }
    } catch (e) { /* skip */ }
    return results;
}

async function lintFiles(jsFiles, eslintConfigFile, extractedDir) {
    if (jsFiles.length === 0) return { errors: 0, warnings: 0, messages: [], ruleCounts: {} };

    let ESLint;
    try {
        ({ ESLint } = require(path.join(__dirname, 'node_modules', 'eslint')));
    } catch (e) {
        return { errors: 0, warnings: 0, messages: ['ESLint not installed'], ruleCounts: {} };
    }

    try {
        const eslint = new ESLint({
            overrideConfigFile: eslintConfigFile,
            cwd: extractedDir
        });
        const results = await eslint.lintFiles(jsFiles);
        return parseLintOutput(results);
    } catch (e) {
        return { errors: 0, warnings: 0, messages: ['ESLint execution failed: ' + e.message.substring(0, 100)], ruleCounts: {} };
    }
}

const ruleDescriptions = {
    'no-unused-vars': 'unused variables',
    'no-undef': 'undefined variables',
    'no-unreachable': 'unreachable code',
    'no-debugger': 'debugger statements',
    'no-constant-condition': 'constant conditions',
    'no-extra-semi': 'extra semicolons',
    'no-redeclare': 'redeclared variables',
    'no-duplicate-case': 'duplicate case labels',
    'no-empty': 'empty blocks',
    'no-irregular-whitespace': 'irregular whitespace',
    'no-func-assign': 'function reassignment',
    'no-inner-declarations': 'inner declarations',
    'no-obj-calls': 'non-callable globals',
    'no-prototype-builtins': 'unsafe prototype methods',
    'no-sparse-arrays': 'sparse arrays',
    'no-unexpected-multiline': 'unexpected multiline',
    'no-unsafe-finally': 'unsafe finally',
    'no-unsafe-negation': 'unsafe negation',
    'no-var': 'var usage (use let/const)',
    'no-console': 'console statements',
    'no-alert': 'alert/confirm/prompt',
    'no-shadow': 'variable shadowing',
    'no-use-before-define': 'used before defined',
    'no-param-reassign': 'parameter reassignment',
    'no-return-assign': 'assignment in return',
    'no-lone-blocks': 'unnecessary blocks',
    'eqeqeq': 'loose equality (use ===)',
    'curly': 'missing curly braces',
    'semi': 'missing semicolons',
    'comma-dangle': 'trailing commas',
    'prefer-const': 'use const where possible',
    'prefer-template': 'use template literals',
    'prefer-arrow-callback': 'use arrow functions',
    'indent': 'indentation issues',
    'quotes': 'quote style',
    'space-before-function-paren': 'function spacing',
    'keyword-spacing': 'keyword spacing',
    'space-infix-ops': 'operator spacing',
    'comma-spacing': 'comma spacing',
    'brace-style': 'brace style',
    'parse-error': 'syntax/parse errors'
};

function friendlyRuleName(ruleId) {
    return ruleDescriptions[ruleId] || ruleId;
}

function parseLintOutput(results) {
    let totalErrors = 0;
    let totalWarnings = 0;
    const ruleCounts = {};
    const errorRuleCounts = {};
    const warningRuleCounts = {};

    for (const file of results) {
        totalErrors += file.errorCount;
        totalWarnings += file.warningCount;

        for (const msg of file.messages) {
            const rule = msg.ruleId || 'parse-error';
            ruleCounts[rule] = (ruleCounts[rule] || 0) + 1;
            if (msg.severity === 2) {
                errorRuleCounts[rule] = (errorRuleCounts[rule] || 0) + 1;
            } else {
                warningRuleCounts[rule] = (warningRuleCounts[rule] || 0) + 1;
            }
        }
    }

    const toMessages = counts => Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([rule, count]) => `${friendlyRuleName(rule)}: ${count}`);

    return {
        errors: totalErrors,
        warnings: totalWarnings,
        messages: toMessages(ruleCounts),
        errorMessages: toMessages(errorRuleCounts),
        warningMessages: toMessages(warningRuleCounts),
        ruleCounts
    };
}

module.exports = async function(students, config, labDir) {
    console.log("--- Linting Phase ---");

    // labDir is the ArtifactsAndRubrics subdir; derive the lab name from one level up
    const labRoot = path.dirname(labDir);
    const labName = path.basename(labRoot);

    // Grader uses config from inside AI_Grading/ so that node_modules (globals, etc.) resolve correctly.
    // Priority: configs/LabXX/eslint.config.mjs > configs/eslint.config.mjs
    const labSpecific = path.join(__dirname, 'configs', labName, 'eslint.config.mjs');
    const defaultConfig = path.join(__dirname, 'configs', 'eslint.config.mjs');
    const eslintConfigFile = fs.existsSync(labSpecific) ? labSpecific
                           : fs.existsSync(defaultConfig) ? defaultConfig
                           : null;
    if (!eslintConfigFile) {
        console.warn(`WARNING: No eslint.config.mjs found in configs/${labName}/ or configs/. Linting may fail.`);
    }

    // Also copy to the lab folder so VS Code can find it when browsing student code.
    const vsCodeCopy = path.join(labRoot, 'eslint.config.mjs');
    if (eslintConfigFile && !fs.existsSync(vsCodeCopy)) {
        try {
            fs.copyFileSync(eslintConfigFile, vsCodeCopy);
            console.log(`  Copied eslint.config.mjs to ${labName}/ (for VS Code)`);
        } catch (e) { /* non-fatal */ }
    }

    const exclusions = (config.lint && config.lint.exclude) ? config.lint.exclude : [];

    for (const student of students) {
        if (!student.extractedDir || !fs.existsSync(student.extractedDir)) {
            student.lint = { jsFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} };
            continue;
        }

        const jsFiles = getAllJsFiles(student.extractedDir, exclusions);
        if (jsFiles.length === 0) {
            console.log(`  SKIP LINT: ${student.name} - no JS files found to lint`);
            student.lint = { jsFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} };
            continue;
        }

        const result = await lintFiles(jsFiles, eslintConfigFile, student.extractedDir);
        console.log(`  ${student.name}: ${jsFiles.length} files, ${result.errors} errors, ${result.warnings} warnings`);

        student.lint = {
            jsFiles: jsFiles.length,
            errors: result.errors,
            warnings: result.warnings,
            messages: result.messages,
            ruleCounts: result.ruleCounts || {}
        };
    }

    const report = students.map(s => ({
        student: s.name,
        jsFiles: s.lint ? s.lint.jsFiles : 0,
        errors: s.lint ? s.lint.errors : 0,
        warnings: s.lint ? s.lint.warnings : 0,
        messages: s.lint ? s.lint.messages : [],
        ruleCounts: (s.lint && s.lint.ruleCounts) || {}
    }));
    fs.writeFileSync(path.join(labDir, LINT_REPORT), JSON.stringify(report, null, 2));
    console.log(`Created ${LINT_REPORT} for ${report.length} students.`);
};
