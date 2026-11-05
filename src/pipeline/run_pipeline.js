/**
 * run_pipeline.js
 *
 * The grading-phase orchestrator, extracted out of bin/grade.js so it's testable in
 * isolation and so the phase set is data (an array with a `when` predicate) rather than
 * a hardcoded sequence of awaits. bin/grade.js still owns CLI parsing, interactive
 * prompts, path resolution, and code acquisition (extractCode) / the extract-only
 * short-circuit — those aren't "grading phases" in the sense this module cares about.
 *
 * runPipeline(students, config, dirs, options) assumes `students` have already been
 * extracted (student.extractedDir set where applicable) and runs:
 *   1. already-graded filtering (skipped when options.regrade is true)
 *   2. each registered phase, in order, for which `when(config)` is true
 *   3. grade generation (spreadsheet or text report)
 *   4. the grading log summary
 *
 * Returns { successful, errors } — the same shape generate_grades.js's summary carries —
 * so callers can act on it, though writing the log file is this module's own side effect.
 */

import fs from 'fs';
import path from 'path';

import runtimeCheck from './runtime_check.js';
import readCodeReview from './read_code_review.js';
import analyzeCode from './analyze_code.js';
import lintCode from './lint_code.js';
import checkNames from './check_names.js';
import generateGrades from './generate_grades.js';
import { resolveAdapter } from '../adapters/index.js';
import { resolveGroups } from '../lib/student_group.js';

const LOG_FILE = 'grading_log.txt';

// Each phase: { name, run(students, config, dirs), when(config) }. `when` defaults to
// always-on; a future per-language config key (e.g. skipping markup validation for a
// non-web language) can gate a phase here without touching the loop below.
// Order matters at the top: the code review form (read first) gives each student's lab group,
// resolveGroups settles it (form, else detected from code), and the runtime check and
// analysis then use that group's settings (config.variations[group].overrides).
// HTML/CSS validation runs for web-language labs (JavaScript — the default — and TypeScript)
// and for any lab that scores an html_validate / css_validate rubric row; other languages
// (Python, C++, C#) skip it. Only those mapping types read its results.
const WEB_LANGUAGES = new Set(['javascript', 'typescript']);
const isWebLab = config => WEB_LANGUAGES.has(config.language || 'javascript');
const usesMapping = (config, type) => (config.mappings || []).some(m => m.type === type);

// group_overrides.json in the Artifacts folder: { "Student Name": "A" } — the instructor's word
// on a student's group when the review form is missing or wrong (see student_group.js).
function readManualGroups(artifactsDir) {
    try { return JSON.parse(fs.readFileSync(path.join(artifactsDir, 'group_overrides.json'), 'utf8')); } catch { return {}; }
}

const PHASES = [
    {
        name: 'readCodeReview',
        run: (students, config, dirs) => readCodeReview(students, config, dirs.artifactsDir),
        when: () => true,
    },
    {
        name: 'resolveGroups',
        run: (students, config, dirs) => resolveGroups(students, config, readManualGroups(dirs.artifactsDir)),
        when: () => true,
    },
    {
        name: 'runtimeCheck',
        run: (students, config, dirs) => runtimeCheck(students, config, dirs.artifactsDir, dirs.labConfigDir),
        when: () => true,
    },
    {
        name: 'analyzeCode',
        run: (students, config, dirs) => analyzeCode(students, config, dirs.artifactsDir, dirs.labConfigDir),
        when: () => true,
    },
    {
        name: 'lintCode',
        run: (students, config, dirs) => lintCode(students, config, dirs.artifactsDir, dirs.labName, dirs.stepName, dirs.courseName),
        when: () => true,
    },
    // The web-only phases below are imported on demand, so a lab that doesn't need them (e.g.
    // a Python course) never loads html-validate, csstree-validator or jsdom.
    {
        name: 'validateHtml',
        run: async (students, config, dirs) => (await import('./validate_html.js')).default(students, config, dirs.artifactsDir),
        when: config => isWebLab(config) || usesMapping(config, 'html_validate'),
    },
    {
        name: 'validateCss',
        run: async (students, config, dirs) => (await import('./validate_css.js')).default(students, config, dirs.artifactsDir),
        when: config => isWebLab(config) || usesMapping(config, 'css_validate'),
    },
    {
        name: 'checkNames',
        run: (students, config, dirs) => checkNames(students, config, dirs.artifactsDir),
        when: () => true,
    },
    {
        name: 'checkWebContent',
        run: async (students, config, dirs) => (await import('./check_web_content.js')).default(students, config, dirs.artifactsDir),
        when: (config) => !!config.webContent,
    },
];

// Filters out students whose grade output already exists, unless regrading.
// Exported for direct testing without needing to run the whole pipeline.
function filterAlreadyGraded(students, config, options) {
    if (options.regrade) return { toGrade: students, alreadyDone: [] };

    const outputExt = options.textReport ? '.txt' : ((config.rubricName || '').endsWith('.xlsm') ? '.xlsm' : '.xlsx');
    const alreadyDone = [];
    const toGrade = students.filter(s => {
        if (!s.gradeDir) return true;
        const dirName = path.basename(s.gradeDir);
        const gradePath = path.join(s.gradeDir, options.textReport
            ? `${dirName}_Grade.txt`
            : `${dirName}_Grade${outputExt}`);
        if (fs.existsSync(gradePath)) { alreadyDone.push(s.name); return false; }
        return true;
    });
    return { toGrade, alreadyDone };
}

// Runs the resolved adapter's toolchain preflight check once, upfront, so a missing
// interpreter/compiler/linter produces ONE clear, actionable message instead of the same
// "not installed" failure repeated per-student across the lint/build/test phases. This is
// informational, not a hard gate — some mapping types (analysis, name checks) don't need
// the toolchain at all, so grading continues; downstream phases still report their own
// per-student errors if the tool truly isn't available for the checks that do need it.
async function runPreflight(config) {
    const adapter = resolveAdapter(config);
    if (!adapter.preflight) return;
    const result = await adapter.preflight(config);
    if (!result.available) {
        console.warn(`  WARNING: ${adapter.language} toolchain not available. ${result.hint}`);
    }
    if (result.warning) console.warn(`  WARNING: ${result.warning}`);
}

async function runPipeline(students, config, dirs, options) {
    await runPreflight(config);

    // config.skipStudents: names to leave out entirely (placeholder/test accounts, withdrawn students).
    const skip = new Set((config.skipStudents || []).map(n => String(n).trim().toLowerCase()));
    if (skip.size > 0) {
        const skipped = students.filter(st => skip.has(String(st.name).trim().toLowerCase()));
        if (skipped.length > 0) {
            console.log(`  Skipping ${skipped.length} student(s) listed in skipStudents: ${skipped.map(st => st.name).join(', ')}\n`);
            students = students.filter(st => !skipped.includes(st));
        }
    }

    const { toGrade, alreadyDone } = filterAlreadyGraded(students, config, options);
    if (alreadyDone.length > 0) {
        console.log(`  Skipping ${alreadyDone.length} already-graded: ${alreadyDone.join(', ')}\n`);
    }

    // Enriched with labName/stepName from options so phases (e.g. lintCode) that need
    // the assignment/step identity don't have to re-derive it from directory paths.
    const phaseDirs = { ...dirs, labName: options.labName, stepName: options.stepName };
    for (const phase of PHASES) {
        if (!phase.when(config)) continue;
        const started = Date.now();
        await phase.run(toGrade, config, phaseDirs);
        const seconds = Math.round((Date.now() - started) / 1000);
        if (seconds >= 10) console.log(`  (${phase.name} took ${seconds}s)`);
    }

    let generateSummary;
    if (!options.skipRubric) {
        generateSummary = await generateGrades(toGrade, config, dirs.artifactsDir, {
            aiComments: options.aiComments, aiModel: options.aiModelFlag, rubricDir: dirs.labConfigDir, textReport: options.textReport,
        });
    } else if (options.textReport) {
        generateSummary = await generateGrades(toGrade, config, dirs.artifactsDir, {
            aiComments: options.aiComments, aiModel: options.aiModelFlag, rubricDir: dirs.labConfigDir, textReport: true,
        });
    } else {
        generateSummary = { successful: [], errors: [] };
        console.log("--- Grade Generation Phase (skipped) ---\n");
    }

    console.log("\n--- Creating Log Summary ---");
    const logLines = [];
    logLines.push(`Grading Summary for ${options.labName} [${options.modeLabel}]`);
    logLines.push(`Date: ${new Date().toISOString()}`);
    logLines.push(`===================================`);

    const errors = [];
    if (generateSummary && generateSummary.errors) {
        errors.push(...generateSummary.errors);
    }

    students.forEach(student => {
        if (student.error) {
            errors.push({ student: student.name, issue: `Extraction: ${student.error}` });
        }
        if (student.analysis && student.analysis.error) {
            errors.push({ student: student.name, issue: `Analysis: ${student.analysis.error}` });
        }
        if (student.runtimeCheck && !student.runtimeCheck.success && student.runtimeCheck.errors && student.runtimeCheck.errors.length > 0) {
            errors.push({ student: student.name, issue: `Runtime: ${student.runtimeCheck.errors.join(', ')}` });
        }
    });

    const successfulStudents = generateSummary ? generateSummary.successful : [];
    logLines.push(`\nSuccessfully Graded (${successfulStudents.length}):`);
    successfulStudents.forEach(s => logLines.push(` - ${s}`));

    logLines.push(`\nIssues Encountered (${errors.length}):`);
    if (errors.length === 0) {
        logLines.push(" None! Great job.");
    } else {
        errors.forEach(e => logLines.push(` - ${e.student}: ${e.issue}`));
    }

    const logPath = path.join(dirs.artifactsDir, LOG_FILE);
    fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');

    console.log(`\nAll Done! Summary written to ${logPath}\n`);

    return { successful: successfulStudents, errors };
}

export { runPipeline, filterAlreadyGraded, runPreflight, PHASES };
