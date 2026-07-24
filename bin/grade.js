#!/usr/bin/env node
/**
 * grade.js (formerly run_all.js)
 *
 * Master orchestrator script for CS233JS lab grading.
 * Each pipeline phase attaches results directly to student objects.
 *
 * Usage:
 *   node bin/grade.js                           -> interactive menu
 *   node bin/grade.js Lab03                     -> first-time grade (skips existing extractions)
 *   node bin/grade.js Lab03 --regrade           -> re-run analysis/lint/runtime/generation (keeps cloned code)
 *   node bin/grade.js Lab03 --reclone           -> delete extracted code, re-clone/unzip, and re-grade
 *   node bin/grade.js Lab03 --regrade --reclone -> same as --reclone (reclone implies regrade)
 *   node bin/grade.js --help                    -> show help
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import extractCode, { CODE_DIR, REPO_DIR } from '../src/pipeline/extract_code.js';
import importFromCanvas from '../src/pipeline/extract_code_canvas.js';
import { runPipeline } from '../src/pipeline/run_pipeline.js';

import { getExistingSteps, getExistingCourses, writeCourseConfig } from '../src/lib/lab_config.js';
import { validateConfig, loadHandlerModules } from '../src/lib/config_validation.js';
import * as canvasClient from '../src/lib/canvas_client.js';

// This file lives in bin/; course config + the default-config template live at the repo root.
const REPO_ROOT = path.join(import.meta.dirname, '..');

const ARTIFACTS_DIR = 'Artifacts';
const SUBMISSIONS_DIR = 'SubmissionsAndAssessment';
const LOG_FILE = 'grading_log.txt';

// --- Help ---

function showHelp() {
    console.log(`
AI Grader v1.0

USAGE
  node bin/grade.js [courseName] [labName] [stepName] [options]

  If no arguments are given, an interactive menu is shown: it always asks you
  to pick a course, then a term (e.g. "Spring 2026"), even when there's only
  one of each — that's where "Add new course"/"Add new term" live. Shortcuts
  like "node bin/grade.js Lab03" skip both prompts and auto-resolve the single
  course/term, so existing muscle-memory usage keeps working unchanged.
  courseName is only needed as an argument once more than one course exists.
  For multi-step labs, stepName selects which submission set to grade.

ARGUMENTS
  courseName       Course directory under configs/ (e.g. CS233JS) — only
                   needed when more than one course exists
  labName          Name of the lab directory (e.g. Lab03, TermProject)
  stepName         Step within a multi-step lab (e.g. ApiDoc, TermProjectProposal)

OPTIONS
  --regrade        Re-run all grading phases (runtime check, analysis, lint,
                   grade generation) but keep existing extracted/cloned code.
                   Use this after fixing grading scripts or config.

  --reclone        Delete all extracted_code and repo directories, re-clone/unzip
                   from scratch, then run full grading. Use this if student
                   repos have been updated.

  --ai-comments    Generate AI summary sentences for each student's rubric
                   summary cell using a local Ollama model. Falls back to
                   default text if Ollama is not running. Auto-selects the
                   first available model unless --ai-model is specified.

  --ai-model=NAME  Specify which Ollama model to use for AI summaries.
                   Implies --ai-comments. Example: --ai-model=qwen3-coder

	  --text-report    Generate .txt grade reports instead of spreadsheets.
	                   Use when a rubric spreadsheet is not yet available.

  --canvas         Import submissions directly from Canvas instead of a Moodle
                   download folder. First use prompts for a Canvas course ID,
                   confirms the course name before continuing, then lets you
                   pick the assignment; the choice is saved to the lab's config
                   file so later runs (even without --canvas) use Canvas again.

  --help, -h       Show this help message.

EXAMPLES
  node bin/grade.js                              Interactive mode
  node bin/grade.js Lab03                        First-time grading
  node bin/grade.js Lab03 --regrade              Re-grade without re-cloning
  node bin/grade.js Lab03 --reclone              Fresh clone + full grade
  node bin/grade.js Lab03 --ai-comments          Grade with AI summaries (auto model)
  node bin/grade.js Lab03 --ai-model=qwen3-coder Grade with a specific model
  node bin/grade.js TermProject ApiDoc           Grade one step of a multi-step lab
  node bin/grade.js Lab03 --canvas               Import from Canvas instead of Moodle
  node bin/grade.js CS233JS Lab03                Explicit course (only needed with 2+ courses)
`);
}

const MOODLE_DIR_PATTERN = /^.*_\d+_assignsubmission_(file|onlinetext)$/;

function hasMoodleSubmissions(dir) {
    try {
        return fs.readdirSync(dir).some(
            f => MOODLE_DIR_PATTERN.test(f) && fs.statSync(path.join(dir, f)).isDirectory()
        );
    } catch (e) { return false; }
}

// --- Helpers ---

const localConfigPath = path.join(REPO_ROOT, 'configs', 'local-config.json');

function readLocalConfig() {
    try {
        return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
    } catch (e) {}
    // Fall back to default-config.json (shipped with the repo) as a starting point
    try {
        return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'default-config.json'), 'utf8'));
    } catch (e) {}
    return {};
}

// Merges cfg into whatever's currently on disk (rather than overwriting the whole file), so
// saving e.g. { labRoot, codeRoot } doesn't clobber an already-configured toolchains/llm/canvas
// section.
function saveLocalConfig(cfg) {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')); } catch (e) {}
    fs.writeFileSync(localConfigPath, JSON.stringify({ ...existing, ...cfg }, null, 2) + '\n', 'utf8');
}

// One-time migration: earlier runs stored a single flat labRoot/codeRoot pair.
// "Term" (e.g. "Spring 2026" / "2026Spring") generalizes this to multiple named
// { label, labRoot, codeRoot } entries, so different semesters can be switched between
// without overwriting each other. If local-config.json already has a terms map, use it
// as-is; if it only has the old flat keys, synthesize a single "Spring 2026" term from
// them and rewrite the file (local-config.json is gitignored/machine-local — this script
// is its only consumer, so no need to keep supporting the old flat shape going forward). A
// brand-new install (no labRoot at all yet) starts with an empty terms map.
function migrateLocalConfigTerms(localConfig) {
    if (localConfig.terms && Object.keys(localConfig.terms).length > 0) {
        return localConfig.terms;
    }
    if (!localConfig.labRoot) {
        return {};
    }
    const terms = {
        '2026Spring': { label: 'Spring 2026', labRoot: localConfig.labRoot, codeRoot: localConfig.codeRoot || '' },
    };
    let onDisk = {};
    try { onDisk = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')); } catch (e) {}
    delete onDisk.labRoot;
    delete onDisk.codeRoot;
    onDisk.terms = terms;
    fs.writeFileSync(localConfigPath, JSON.stringify(onDisk, null, 2) + '\n', 'utf8');
    console.log('  Migrated labRoot/codeRoot into a "Spring 2026" term in local-config.json');
    return terms;
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        process.exit(0);
    }

    let positional = args.filter(a => !a.startsWith('--'));
    // Plain interactive menu = no positional args at all. Course/term selection always
    // prompt (even with one option) in that case; a shortcut like "node bin/grade.js Lab03"
    // keeps auto-resolving a single course/term silently, exactly as before.
    const isPlainMenu = positional.length === 0;
    const hasRegradeFlag = args.includes('--regrade');
    const hasRecloneFlag = args.includes('--reclone');
    const aiModelFlag = (args.find(a => a.startsWith('--ai-model=')) || '').split('=')[1] || null;
    const aiComments = args.includes('--ai-comments') || !!aiModelFlag;
    let textReport = args.includes('--text-report');
    const canvasFlag = args.includes('--canvas');
    const hasAnyFlag = hasRegradeFlag || hasRecloneFlag;

    // labName is resolved after course selection below — position 0 of `positional` means
    // different things depending on how many courses exist (see the course-resolution block).
    let labName;
    let stepName = null;     // set for multi-step labs (e.g. node bin/grade.js TermProject ApiDoc)
    let reclone = hasRecloneFlag;
    let regrade = hasRegradeFlag || hasRecloneFlag;
    let config, labDir, labConfigDir, artifactsDir, submissionsDir;
    let skipRubric = false;
    let usingCanvas = false, courseId = null, assignmentId = null, canvasConfig = null;
    let course = null; // resolved course record from getExistingCourses(); course.name is the configs/ dir name
    let terms = {}, activeTermId = null; // resolved via migrateLocalConfigTerms() + term selection below

    let completions = [];
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: line => {
            const hits = completions.filter(c => c.toLowerCase().startsWith(line.toLowerCase()));
            return [hits, line];
        }
    });
    const askRl = q => new Promise(resolve => rl.question(q, resolve));

    try {
        const localConfig = readLocalConfig();
        let configChanged = false;

        const configsDir = path.join(REPO_ROOT, 'configs');

        // --- Course selection ---
        // Runs before the assignment menu so every config/data path below can be scoped to
        // configs/<Course>/ and <labRoot|codeRoot>/<Course>/. The plain interactive menu
        // (no CLI args at all) always shows the picker, even with one course — but a
        // shortcut like "node bin/grade.js Lab03" still auto-resolves a single course
        // silently, so existing single-course usage keeps working unchanged.
        const courses = getExistingCourses(configsDir);
        if (courses.length === 0) {
            console.error(`ERROR: No courses found under ${configsDir}.`);
            console.error(`  Run "node bin/configure-lab.js" to set up your first course and lab.`);
            process.exit(1);
        }

        if (courses.length === 1 && !isPlainMenu) {
            course = courses[0];
        } else {
            // Once there's more than one course, position 0 is always the course argument
            // (e.g. "node bin/grade.js CS233JS Lab03"); assignment/step shift down one slot.
            const courseArg = positional[0];
            course = courseArg
                ? courses.find(c => c.name.toLowerCase() === courseArg.toLowerCase() || c.courseName.toLowerCase() === courseArg.toLowerCase())
                : null;
            positional = positional.slice(1);

            if (!course) {
                console.log('\nAvailable courses:');
                courses.forEach((c, i) => console.log(`  ${i + 1}) ${c.courseName}`));
                console.log();
                completions = courses.map(c => c.courseName);
                while (!course) {
                    const input = await askRl('Select a course (number or name): ');
                    const num = parseInt(input);
                    if (!isNaN(num) && num >= 1 && num <= courses.length) {
                        course = courses[num - 1];
                    } else {
                        const found = courses.find(c =>
                            c.name.toLowerCase() === input.trim().toLowerCase() ||
                            c.courseName.toLowerCase() === input.trim().toLowerCase()
                        );
                        if (found) course = found;
                        else console.log('  Invalid selection, try again.');
                    }
                }
                completions = [];
                console.log(`  Course: ${course.courseName}\n`);
            }
        }
        const courseName = course.name;
        const courseConfigsDir = path.join(configsDir, courseName);

        // --- Term selection ---
        // A term is { label, labRoot, codeRoot } — orthogonal to course (course is inserted
        // as a subfolder under the selected term's labRoot/codeRoot by the course-tier path
        // construction further down). Absorbs what used to be the unconditional "enter your
        // lab root / code storage root" first-run prompts — those now only run when creating
        // a term. Same always-prompt-in-the-plain-menu rule as course selection above.
        terms = migrateLocalConfigTerms(localConfig);
        const listTerms = () => Object.entries(terms).map(([id, t]) => ({ id, ...t }));

        async function createTerm() {
            const firstEver = listTerms().length === 0;
            const labelInput = await askRl(firstEver ? 'Term label [Spring 2026]: ' : 'Term label (e.g. Fall 2026): ');
            const label = labelInput.trim() || (firstEver ? 'Spring 2026' : '');
            if (!label) { console.log('  A term label is required.'); return null; }
            const defaultId = firstEver ? '2026Spring' : label.replace(/[^A-Za-z0-9]+/g, '');
            const idInput = await askRl(`Term id, used as a folder-safe key [${defaultId}]: `);
            const id = idInput.trim() || defaultId;
            if (!id) { console.log('  A term id is required.'); return null; }
            if (terms[id]) { console.log(`  A term with id "${id}" already exists.`); return null; }

            const labRootInput = await askRl(
                'Lab root - path to the folder containing the students submissions\n' +
                '  (e.g. /Volumes/GoogleDrive/StudentLabWork): '
            );
            if (!labRootInput.trim()) { console.error('ERROR: A lab root path is required.'); process.exit(1); }
            const codeRootInput = await askRl(
                'Code storage root — path to a LOCAL folder (outside Google Drive) where student\n' +
                '  code will be cloned or unzipped. A subfolder per lab is created automatically\n' +
                '  (e.g. /Users/brian/GradingCode): '
            );
            if (!codeRootInput.trim()) { console.error('ERROR: A code storage root path is required.'); process.exit(1); }

            terms = { ...terms, [id]: { label, labRoot: labRootInput.trim(), codeRoot: codeRootInput.trim() } };
            saveLocalConfig({ terms });
            console.log(`  Saved term "${label}" (${id}) to local-config.json`);
            return id;
        }

        if (listTerms().length === 0) {
            activeTermId = await createTerm();
        } else if (listTerms().length === 1 && !isPlainMenu) {
            activeTermId = listTerms()[0].id;
        } else {
            const list = listTerms();
            console.log('\nAvailable terms:');
            list.forEach((t, i) => console.log(`  ${i + 1}) ${t.label}`));
            console.log(`  ${list.length + 1}) Add new term`);
            console.log();
            completions = list.flatMap(t => [t.label, t.id]);
            while (!activeTermId) {
                const input = await askRl('Select a term (number or name): ');
                const num = parseInt(input);
                if (!isNaN(num) && num >= 1 && num <= list.length) {
                    activeTermId = list[num - 1].id;
                } else if (!isNaN(num) && num === list.length + 1) {
                    activeTermId = await createTerm();
                } else {
                    const found = list.find(t =>
                        t.id.toLowerCase() === input.trim().toLowerCase() ||
                        t.label.toLowerCase() === input.trim().toLowerCase()
                    );
                    if (found) activeTermId = found.id;
                    else console.log('  Invalid selection, try again.');
                }
            }
            completions = [];
            console.log(`  Term: ${terms[activeTermId].label}\n`);
        }

        let labRoot = terms[activeTermId].labRoot;
        let codeRoot = terms[activeTermId].codeRoot;

        labName = positional[0];

        const labs = fs.readdirSync(courseConfigsDir)
            .filter(f => {
                const subdir = path.join(courseConfigsDir, f);
                try { return fs.statSync(subdir).isDirectory(); } catch (e) { return false; }
            })
            .filter(name =>
                // flat lab: top-level config exists
                fs.existsSync(path.join(courseConfigsDir, name, `${name.toLowerCase()}_config.json`)) ||
                // multi-step lab: at least one step subdir has its own config
                getExistingSteps(name, courseConfigsDir).length > 0
            )
            .map(name => {
                // Restore original casing from labRoot/<course>/ if the directory exists
                const courseLabRoot = path.join(labRoot, courseName);
                const match = fs.existsSync(courseLabRoot)
                    ? fs.readdirSync(courseLabRoot).find(d => d.toLowerCase() === name.toLowerCase())
                    : null;
                return match || name;
            })
            .sort();

        if (!labName) {
            const title = `${course.courseCode} AI Grader v1.0`;
            const boxWidth = Math.max(36, title.length + 6);
            const pad = boxWidth - 2 - title.length;
            const leftPad = Math.floor(pad / 2), rightPad = pad - leftPad;
            console.log(`\n╔${'═'.repeat(boxWidth - 2)}╗`);
            console.log(`║${' '.repeat(leftPad)}${title}${' '.repeat(rightPad)}║`);
            console.log(`╚${'═'.repeat(boxWidth - 2)}╝`);
            console.log('  (Run with --help to see all command-line options)\n');

            console.log(`Available assignments (${course.courseName}):`);
            labs.forEach((lab, i) => console.log(`  ${i + 1}) ${lab}`));
            console.log();

            completions = labs;
            while (!labName) {
                const input = await askRl('Select an assignment (number or name): ');
                const num = parseInt(input);
                if (!isNaN(num) && num >= 1 && num <= labs.length) {
                    labName = labs[num - 1];
                } else if (labs.find(l => l.toLowerCase() === input.trim().toLowerCase())) {
                    labName = labs.find(l => l.toLowerCase() === input.trim().toLowerCase());
                } else {
                    console.log('  Invalid selection, try again.');
                }
            }
            completions = [];
        }

        // Multi-step lab: detect available steps and resolve which one to grade
        {
            const existingSteps = getExistingSteps(labName, courseConfigsDir);
            if (existingSteps.length > 0) {
                const stepArg = positional[1]; // e.g. node bin/grade.js TermProject ApiDoc
                if (stepArg) {
                    const match = existingSteps.find(s => s.toLowerCase() === stepArg.toLowerCase());
                    if (!match) {
                        console.error(`ERROR: Step "${stepArg}" not found in ${labName}.`);
                        console.error(`  Available steps: ${existingSteps.join(', ')}`);
                        process.exit(1);
                    }
                    stepName = match;
                } else {
                    console.log(`\n${labName} has multiple submission steps:`);
                    existingSteps.forEach((s, i) => console.log(`  ${i + 1}) ${s}`));
                    console.log();
                    completions = existingSteps;
                    while (!stepName) {
                        const input = await askRl('Select a step (number or name): ');
                        const num = parseInt(input);
                        if (!isNaN(num) && num >= 1 && num <= existingSteps.length) {
                            stepName = existingSteps[num - 1];
                        } else if (existingSteps.find(s => s.toLowerCase() === input.trim().toLowerCase())) {
                            stepName = existingSteps.find(s => s.toLowerCase() === input.trim().toLowerCase());
                        } else {
                            console.log('  Invalid selection, try again.');
                        }
                    }
                    completions = [];
                }
                console.log(`  Step: ${stepName}\n`);
            }
        }

        labConfigDir = stepName
            ? path.join(courseConfigsDir, labName, stepName)
            : path.join(courseConfigsDir, labName);
        const configPath = path.join(labConfigDir, `${path.basename(labConfigDir).toLowerCase()}_config.json`);
        if (!fs.existsSync(configPath)) {
            console.error(`ERROR: Config file not found at ${configPath}`);
            process.exit(1);
        }
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error(`ERROR: Could not parse config file ${configPath}: ${e.message}`);
            process.exit(1);
        }
        // toolchains (compiler/SDK paths not on the default PATH) are machine-specific, so
        // they live in local-config.json; a lab config may override individual entries.
        if (localConfig.toolchains) {
            config.toolchains = { ...localConfig.toolchains, ...(config.toolchains || {}) };
        }
        await loadHandlerModules(config, labConfigDir);
        try {
            validateConfig(config, labName);
        } catch (e) {
            console.error(`\nERROR: ${e.message}\n`);
            process.exit(1);
        }

        // A lab can opt into text reports permanently (e.g. courses with no rubric
        // spreadsheets, like CIS195) — same effect as passing --text-report every run.
        textReport = textReport || config.textReport === true;

        // --- Canvas source resolution ---
        // config.canvas.assignmentId (persisted below) makes a lab always use Canvas once set
        // up; --canvas is how you set it up the first time or repoint it at a different
        // assignment. The Canvas course ID lives on the COURSE (course.canvasCourseId,
        // configs/<Course>/course_config.json), not per-lab — a course's Canvas ID doesn't
        // change from one assignment to the next.
        usingCanvas = canvasFlag || !!config.canvas?.assignmentId;
        if (usingCanvas) {
            const storedCanvas = localConfig.canvas || {};
            canvasConfig = {
                url: process.env.CANVAS_URL || storedCanvas.url || null,
                token: process.env.CANVAS_TOKEN || storedCanvas.token || null,
            };
            let canvasLocalChanged = false;

            if (!canvasConfig.url) {
                const input = await askRl('Canvas URL (e.g. https://yourschool.instructure.com): ');
                if (!input.trim()) { console.error('ERROR: A Canvas URL is required.'); process.exit(1); }
                canvasConfig.url = input.trim();
                canvasLocalChanged = true;
            }
            if (!canvasConfig.token) {
                const input = await askRl('Canvas API token (Account -> Settings -> New Access Token): ');
                if (!input.trim()) { console.error('ERROR: A Canvas API token is required.'); process.exit(1); }
                canvasConfig.token = input.trim();
                canvasLocalChanged = true;
            }

            courseId = course.canvasCourseId || null;
            assignmentId = config.canvas?.assignmentId || null;

            if (canvasFlag || !assignmentId) {
                console.log('\n--- Canvas Setup ---');
                let canvasCourse = null;
                while (!canvasCourse) {
                    const input = await askRl(courseId ? `Canvas course ID [${courseId}]: ` : 'Canvas course ID: ');
                    const entered = input.trim() || (courseId ? String(courseId) : '');
                    if (!entered) { console.log('  A course ID is required.'); continue; }
                    const id = Number(entered);
                    if (!Number.isInteger(id)) { console.log('  Please enter a numeric course ID.'); continue; }
                    try {
                        const fetched = await canvasClient.getCourse(id, canvasConfig);
                        console.log(`\n  Course: "${fetched.name}" (id ${fetched.id}, status: ${fetched.workflow_state})`);
                        const confirm = await askRl('  Is this the correct course? (y/n): ');
                        if (confirm.trim().toLowerCase().startsWith('y')) {
                            canvasCourse = fetched;
                            courseId = fetched.id;
                        } else {
                            console.log('  Okay — enter the correct course ID.\n');
                        }
                    } catch (e) {
                        console.log(`  ERROR: ${canvasClient.sanitize(e.message, canvasConfig.token)}\n`);
                    }
                }

                // Persist the confirmed Canvas course ID onto the local course record right
                // away — course.canvasCourseId (below) is what future labs in this course
                // will default to, and course_config.json is written after the assignment
                // is picked too, so both fields land in one write.
                course.canvasCourseId = courseId;

                console.log(`\n  Fetching assignments for "${canvasCourse.name}"...`);
                const assignments = await canvasClient.listAssignments(courseId, canvasConfig);
                if (assignments.length === 0) {
                    console.error(`ERROR: No assignments found in course ${courseId} ("${canvasCourse.name}").`);
                    process.exit(1);
                }
                const guessTarget = (stepName || labName).toLowerCase();
                const guessIdx = assignments.findIndex(a => {
                    const n = a.name.toLowerCase();
                    return n.includes(guessTarget) || guessTarget.includes(n);
                });

                console.log(`\n  Assignments in "${canvasCourse.name}":`);
                assignments.forEach((a, i) => {
                    const flag = a.published === false ? '  [unpublished]' : '';
                    const guess = i === guessIdx ? '  <-- looks like a match' : '';
                    console.log(`    ${i + 1}) ${a.name}  (id ${a.id})${flag}${guess}`);
                });
                const defaultChoice = guessIdx >= 0 ? guessIdx + 1 : null;
                let chosenAssignment = null;
                while (!chosenAssignment) {
                    const prompt = defaultChoice ? `  Select an assignment # [${defaultChoice}]: ` : '  Select an assignment #: ';
                    const input = await askRl(prompt);
                    const trimmed = input.trim();
                    const n = trimmed === '' ? defaultChoice : parseInt(trimmed);
                    if (n && n >= 1 && n <= assignments.length) chosenAssignment = assignments[n - 1];
                    else console.log('  Invalid selection, try again.');
                }
                assignmentId = chosenAssignment.id;
                console.log(`  Assignment: "${chosenAssignment.name}" (id ${assignmentId})\n`);

                // Persist assignmentId into the lab's (or step's) own config file — same
                // read-modify-write pattern the rubricName prompt below already uses.
                const cfgOnDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                cfgOnDisk.canvas = { assignmentId };
                fs.writeFileSync(configPath, JSON.stringify(cfgOnDisk, null, 2) + '\n', 'utf8');
                config.canvas = { assignmentId };
                console.log(`  Saved Canvas assignment to ${path.basename(configPath)}`);

                // Persist courseId onto the course itself, so the next lab in this course
                // skips the course-ID prompt entirely.
                writeCourseConfig(course.path, {
                    courseName: course.courseName,
                    courseCode: course.courseCode,
                    rubricPrefix: course.rubricPrefix,
                    canvasCourseId: courseId,
                });
            }

            if (canvasLocalChanged) {
                saveLocalConfig({ canvas: { url: canvasConfig.url, token: canvasConfig.token } });
            }
        }

        labDir = path.join(labRoot, courseName, labName);
        // One-time migration ease: Moodle downloads are external (on Google Drive, not
        // managed by this tool), so rather than requiring an upfront reorganization, fall
        // back to the pre-course-tier flat path if that's where the download still is.
        const legacyLabDir = path.join(labRoot, labName);
        if (!usingCanvas && !fs.existsSync(labDir) && fs.existsSync(legacyLabDir)) {
            labDir = legacyLabDir;
            console.log(`  Note: reading submissions from ${legacyLabDir} (not yet moved under <labRoot>/${courseName}/).`);
            console.log(`  Consider moving it under <labRoot>/${courseName}/${labName}/ to match the course-scoped layout.\n`);
        }
        if (!usingCanvas && !fs.existsSync(labDir)) {
            // Common mistake: user entered the lab subdirectory as labRoot instead of its parent
            if (path.basename(labRoot).toLowerCase() === labName.toLowerCase() ||
                path.basename(labRoot).toLowerCase() === courseName.toLowerCase()) {
                const correctedRoot = path.dirname(labRoot);
                console.log(`\nIt looks like your lab root points inside the ${courseName}/${labName} folder itself.`);
                console.log(`  Entered:   ${labRoot}`);
                console.log(`  Should be: ${correctedRoot}`);
                const confirm = await askRl('Use the parent folder and update your saved settings? (y/n): ');
                if (confirm.trim().toLowerCase() === 'y') {
                    labRoot = correctedRoot;
                    labDir = path.join(labRoot, courseName, labName);
                    terms = { ...terms, [activeTermId]: { ...terms[activeTermId], labRoot } };
                    saveLocalConfig({ terms });
                    console.log('  Updated lab root saved to local-config.json\n');
                } else {
                    console.error('Aborted. Re-run and enter the correct lab root path.');
                    process.exit(1);
                }
            } else {
                // labRoot exists (verified at startup) but has no subfolder for this lab.
                // Distinguish "submissions not downloaded yet" from "labRoot misconfigured":
                // if labRoot already holds other lab folders, the root is clearly correct and
                // the likely cause is that this lab's Moodle submissions haven't been downloaded.
                let siblings = [];
                try {
                    siblings = fs.readdirSync(labRoot)
                        .filter(d => {
                            try { return fs.statSync(path.join(labRoot, d)).isDirectory(); }
                            catch (e) { return false; }
                        })
                        .sort();
                } catch (e) { /* labRoot unreadable — fall through to the generic hint */ }

                console.error(`\nERROR: No submissions folder found for ${labName} at:`);
                console.error(`  ${labDir}`);
                console.error(`  (also checked the pre-course-tier path: ${legacyLabDir})`);
                if (siblings.length > 0) {
                    console.error(`\n  Your lab root looks correct — it already contains: ${siblings.join(', ')}`);
                    console.error(`  It just has no ${courseName}/${labName} folder yet. Have you downloaded the`);
                    console.error(`  ${labName} submissions from Moodle into <labRoot>/${courseName}/${labName}/ ?`);
                } else {
                    console.error(`  Make sure your lab root (${labRoot}) is the folder that contains the ${courseName}/${labName} subdirectory.`);
                }
                process.exit(1);
            }
        }

        // For multi-step labs: descend into the step subdir within labRoot/labName.
        // Case-insensitively resolve the step folder name in case labRoot casing differs.
        // If the step subdir doesn't exist in labRoot, fall back to the lab root itself —
        // Moodle downloads don't need to mirror the configs step layout.
        if (!usingCanvas && stepName) {
            let stepDirName = stepName;
            try {
                const m = fs.readdirSync(labDir).find(d => d.toLowerCase() === stepName.toLowerCase());
                if (m) stepDirName = m;
            } catch (e) { /* use stepName as-is */ }
            const stepPath = path.join(labDir, stepDirName);
            if (fs.existsSync(stepPath)) {
                labDir = stepPath;
            } else {
                console.log(`  Note: no "${stepName}" subfolder found in labRoot — using submissions from ${labDir}\n`);
            }
        }

        // If labDir has no direct Moodle submissions but contains subdirectories that do
        // (e.g. Moodle exported Lab05-Beta and Lab05-Production as separate groups),
        // ask the user which group to grade.
        if (!usingCanvas && !hasMoodleSubmissions(labDir)) {
            const subdirs = fs.readdirSync(labDir).filter(f => {
                const fp = path.join(labDir, f);
                try { return fs.statSync(fp).isDirectory() && hasMoodleSubmissions(fp); } catch (e) { return false; }
            });
            if (subdirs.length > 0) {
                console.log(`\nNo submissions found directly in ${labName}/. Found these submission groups:`);
                subdirs.forEach((d, i) => console.log(`  ${i + 1}) ${d}`));
                console.log();
                let chosen = false;
                while (!chosen) {
                    const input = await askRl(`Select which group to grade (number) [${subdirs.length}]: `);
                    const trimmed = input.trim();
                    if (trimmed === '') {
                        labDir = path.join(labDir, subdirs[subdirs.length - 1]);
                        chosen = true;
                    } else {
                        const num = parseInt(trimmed);
                        if (!isNaN(num) && num >= 1 && num <= subdirs.length) {
                            labDir = path.join(labDir, subdirs[num - 1]);
                            chosen = true;
                        } else {
                            console.log('  Invalid selection, try again.');
                        }
                    }
                }
                console.log(`  Using: ${labDir}\n`);
                // If this is a multi-step lab and the chosen folder doesn't match the step
                // name, the only reason we had to ask is the folder naming. Point the fix out.
                if (stepName) {
                    const chosenName = path.basename(labDir);
                    if (chosenName.toLowerCase() !== stepName.toLowerCase()) {
                        console.log(`  Tip: rename "${chosenName}" to "${stepName}" under your lab root to skip this prompt next time.\n`);
                    }
                }
            }
        }

        // Per-lab (or per-step) paths under codeRoot.
        // For multi-step labs the layout is codeRoot/{courseName}/{labName}/{stepName}/Artifacts...
        const labSubPath = stepName ? path.join(courseName, labName, stepName) : path.join(courseName, labName);
        artifactsDir = path.join(codeRoot, labSubPath, ARTIFACTS_DIR);
        submissionsDir = path.join(codeRoot, labSubPath, SUBMISSIONS_DIR);

        // One-time migration: earlier (pre-course-tier) runs wrote graded output straight to
        // codeRoot/<Lab>/... (no course segment). If that legacy location has data and the new
        // nested location doesn't yet, offer to move it — otherwise --regrade would silently
        // treat every already-graded student as new, and any manual post-grading edits (e.g.
        // graderCell changed to a name) would be orphaned by a fresh empty tree.
        {
            const legacySubPath = stepName ? path.join(labName, stepName) : labName;
            const legacyArtifacts = path.join(codeRoot, legacySubPath, ARTIFACTS_DIR);
            const legacySubmissions = path.join(codeRoot, legacySubPath, SUBMISSIONS_DIR);
            if (!fs.existsSync(artifactsDir) && !fs.existsSync(submissionsDir) &&
                (fs.existsSync(legacyArtifacts) || fs.existsSync(legacySubmissions))) {
                console.log(`\nFound existing graded output at the pre-course-tier location:`);
                console.log(`  ${path.join(codeRoot, legacySubPath)}`);
                console.log(`It hasn't been moved under the new "${courseName}/" layout yet.`);
                const moveIt = await askRl(`Move it to ${path.join(codeRoot, labSubPath)} now? (y/n) [y]: `);
                if (moveIt.trim().toLowerCase() !== 'n') {
                    fs.mkdirSync(path.dirname(path.join(codeRoot, labSubPath)), { recursive: true });
                    fs.renameSync(path.join(codeRoot, legacySubPath), path.join(codeRoot, labSubPath));
                    console.log(`  Moved.\n`);
                } else {
                    console.log(`  Skipped — a fresh ${courseName}/ tree will be created; the old data stays at ${path.join(codeRoot, legacySubPath)}.\n`);
                }
            }
        }

        // Validate codeRoot is writable before proceeding — ask for a new one if not
        let codeRootConfirmed = false;
        while (!codeRootConfirmed) {
            try {
                fs.mkdirSync(artifactsDir, { recursive: true });
                fs.mkdirSync(submissionsDir, { recursive: true });
                codeRootConfirmed = true;
            } catch (e) {
                console.error(`\nERROR: Cannot write to code storage directory:`);
                console.error(`  ${path.join(codeRoot, labSubPath)}`);
                console.error(`  ${e.message}\n`);
                const newRoot = await askRl(
                    'Enter a writable path for storing cloned/extracted student code\n' +
                    '  (e.g. /Users/brian/GradingCode): '
                );
                if (!newRoot.trim()) {
                    console.error('ERROR: A code storage root path is required.');
                    process.exit(1);
                }
                codeRoot = newRoot.trim();
                configChanged = true;
                artifactsDir = path.join(codeRoot, labSubPath, ARTIFACTS_DIR);
                submissionsDir = path.join(codeRoot, labSubPath, SUBMISSIONS_DIR);
            }
        }
        if (configChanged) {
            terms = { ...terms, [activeTermId]: { ...terms[activeTermId], codeRoot } };
            saveLocalConfig({ terms });
            console.log(`  Saved updated codeRoot to local-config.json\n`);
        }

        // Validate rubric exists before starting the pipeline (skip for extract-only).
        // A textReport config may have no rubricName at all — treat that as "not found"
        // so it flows into the text-report branch below instead of crashing path.join.
        while (!skipRubric && !config.extractOnly) {
            const rubricCheckPath = config.rubricName ? path.join(labConfigDir, config.rubricName) : null;
            if (rubricCheckPath && fs.existsSync(rubricCheckPath)) {
                break;
            } else if (textReport) {
                console.log(`  Rubric not found, but --text-report is set. Will generate .txt reports.\n`);
                skipRubric = true;
                break;
            } else {
                console.log(`\nRubric file not found at expected path:`);
                console.log(`  ${rubricCheckPath}\n`);
                const provideRubric = await askRl('Would you like to provide a rubric spreadsheet? (y/n): ');
                if (provideRubric.trim().toLowerCase() !== 'y' && provideRubric.trim().toLowerCase() !== 'yes') {
                    console.log('  Continuing without rubric — will generate .txt grade reports.\n');
                    skipRubric = true;
                    textReport = true;
                    break;
                }
                const newName = await askRl(
                    'Enter the rubric filename\n' +
                    `  (e.g. ${course.rubricPrefix}_${labName}_Rubric.xlsm): `
                );
                if (!newName.trim()) {
                    console.log('  No filename entered — will generate .txt grade reports.\n');
                    skipRubric = true;
                    textReport = true;
                    break;
                }
                config.rubricName = newName.trim();
                // Persist to config file on disk
                const cfgOnDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                cfgOnDisk.rubricName = config.rubricName;
                fs.writeFileSync(configPath, JSON.stringify(cfgOnDisk, null, 2) + '\n', 'utf8');
                console.log(`  Updated rubricName in ${labName.toLowerCase()}_config.json\n`);
            }
        }

        if (!hasAnyFlag) {
            if (config.extractOnly) {
                console.log('\nExtract options:');
                console.log('  1) Normal     — extract new submissions (skip already-cloned)');
                console.log('  2) Re-extract — keep existing code, run git pull on repos');
                console.log('  3) Reclone    — delete all extracted code, re-clone/unzip from scratch');
            } else {
                console.log('\nGrading options:');
                console.log('  1) Normal   — grade new submissions (skip already-extracted)');
                console.log('  2) Regrade  — re-run grading but keep existing cloned code');
                console.log('  3) Reclone  — delete all extracted code, re-clone/unzip, and re-grade');
            }
            console.log();
            const modeInput = await askRl('Select option [1]: ');
            const choice = modeInput.trim();
            if (choice === '2') {
                regrade = true;
            } else if (choice === '3') {
                reclone = true;
                regrade = true;
            }
        }
    } finally {
        rl.close();
    }

    const modeLabel = config.extractOnly
        ? (reclone ? 'RECLONE' : (regrade ? 'REEXTRACT' : 'EXTRACT'))
        : (reclone ? 'RECLONE' : (regrade ? 'REGRADE' : 'NORMAL'));
    const aiLabel = aiComments ? ' +AI' : '';
    const txtLabel = textReport ? ' +TXT' : '';
    const canvasLabel = usingCanvas ? ' +CANVAS' : '';
    console.log(`\n================================`);
    console.log(`   Grading: ${course.courseName} / ${labName}${stepName ? '/' + stepName : ''}  [${modeLabel}${aiLabel}${txtLabel}${canvasLabel}]`);
    console.log(`================================\n`);

    if (reclone) {
        console.log('--- Clearing previous code ---');

        if (fs.existsSync(submissionsDir)) {
            const entries = fs.readdirSync(submissionsDir);
            for (const entry of entries) {
                for (const dir of [CODE_DIR, REPO_DIR]) {
                    const codeDir = path.join(submissionsDir, entry, dir);
                    if (fs.existsSync(codeDir)) {
                        fs.rmSync(codeDir, { recursive: true, force: true });
                        console.log(`  Cleared: ${entry}/${dir}`);
                    }
                }
            }
        }

        console.log();
    }

    if (regrade && !reclone && fs.existsSync(submissionsDir)) {
        console.log('--- Pulling latest code from repositories ---');
        const entries = fs.readdirSync(submissionsDir);
        for (const entry of entries) {
            const repoDir = path.join(submissionsDir, entry, REPO_DIR);
            if (!fs.existsSync(repoDir)) continue;
            const result = spawnSync('git', ['pull'], { cwd: repoDir, encoding: 'utf8' });
            if (result.status === 0) {
                const summary = (result.stdout || '').trim().split('\n').pop();
                console.log(`  ${entry}: ${summary}`);
            } else {
                console.log(`  ${entry}: pull failed — ${(result.stderr || result.stdout || '').trim()}`);
            }
        }
        console.log();
    }

    // 1. Code Acquisition
    const students = usingCanvas
        ? await importFromCanvas({ courseId, assignmentId, submissionsDir, canvasConfig, urlPatterns: config.urlPatterns })
        : await extractCode(labDir, submissionsDir, config);

    // In extract-only mode, skip all checking and grade-generation phases
    if (config.extractOnly) {
        const extracted = students.filter(s => s.extractedDir);
        console.log(`  Extract-only mode: ${extracted.length} repo(s) extracted. No grading.\n`);

        console.log("--- Creating Log Summary ---");
        const logLines = [];
        logLines.push(`Extraction Summary for ${labName} [${modeLabel}]`);
        logLines.push(`Date: ${new Date().toISOString()}`);
        logLines.push(`===================================`);
        logLines.push(`\nExtracted (${extracted.length}):`);
        extracted.forEach(s => logLines.push(` - ${s.name}`));
        const extractErrors = students.filter(s => s.error);
        logLines.push(`\nIssues Encountered (${extractErrors.length}):`);
        if (extractErrors.length === 0) {
            logLines.push(" None! Great job.");
        } else {
            extractErrors.forEach(e => logLines.push(` - ${e.name}: ${e.error}`));
        }
        const logPath = path.join(artifactsDir, LOG_FILE);
        fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');
        console.log(`\nAll Done! Summary written to ${logPath}\n`);
        return;
    }

    // Runtime check, code review, analysis, lint, markup validation, name check, grade
    // generation, and the log summary are all orchestrated by run_pipeline.js.
    await runPipeline(
        students,
        config,
        { artifactsDir, labConfigDir, courseName: course.name },
        { regrade, skipRubric, textReport, aiComments, aiModelFlag, labName, stepName, modeLabel }
    );
}

main().catch(err => {
    console.error("Fatal error during grading:", err);
});
