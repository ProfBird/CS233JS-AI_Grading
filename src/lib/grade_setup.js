/**
 * grade_setup.js
 *
 * bin/grade.js's interactive setup phase (course/term/submission-source/assignment/step/
 * Canvas/rubric/mode resolution), extracted out of grade.js so it's unit-testable without
 * spawning a real process or stubbing process.exit — same rationale as
 * src/lib/config_validation.js's extraction (see CLAUDE.md's "Shared utilities" section).
 *
 * This is currently a pure relocation of grade.js's former try/finally block (still using
 * a plain readline `askRl`); a follow-up converts its prompts to the shared driver
 * interface in src/lib/prompt_driver.js (the same one bin/configure-lab.js's TUI
 * implements), so the interactive menu can run over either a full-screen TUI or a
 * readline fallback for piped/non-TTY invocations.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { getExistingSteps, getExistingCourses, writeCourseConfig } from './lab_config.js';
import { validateConfig, loadHandlerModules } from './config_validation.js';
import { selectFromList } from './select_from_list.js';
import { resolveLegacyLabDir } from './resolve_lab_dir.js';
import * as canvasClient from './canvas_client.js';

// This file lives in src/lib/; course config + the default-config template live at the
// repo root, two levels up.
const REPO_ROOT = path.join(import.meta.dirname, '..', '..');
const DEFAULT_CONFIGS_DIR = path.join(REPO_ROOT, 'configs');
const DEFAULT_LOCAL_CONFIG_PATH = path.join(REPO_ROOT, 'configs', 'local-config.json');
const DEFAULT_DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'default-config.json');

const ARTIFACTS_DIR = 'Artifacts';
const SUBMISSIONS_DIR = 'SubmissionsAndAssessment';

const MOODLE_DIR_PATTERN = /^.*_\d+_assignsubmission_(file|onlinetext)$/;

function hasMoodleSubmissions(dir) {
    try {
        return fs.readdirSync(dir).some(
            f => MOODLE_DIR_PATTERN.test(f) && fs.statSync(path.join(dir, f)).isDirectory()
        );
    } catch (e) { return false; }
}

// Thrown by resolveGradeSetup on any unrecoverable configuration/input problem, in place
// of the console.error(...) + process.exit(1) pairs the original inline code used. `lines`
// is always an array (some diagnostics are multi-line) so a caller can print each line
// after tearing down whatever prompt UI is active, rather than losing the message inside
// a destroyed screen.
class SetupError extends Error {
    constructor(lines) {
        const arr = Array.isArray(lines) ? lines : [lines];
        super(arr[0]);
        this.name = 'SetupError';
        this.lines = arr;
    }
}

// Parses grade.js's CLI flags/positional args. Separated out from resolveGradeSetup so the
// flag/isPlainMenu logic is unit-testable on its own. `argv` is process.argv.slice(2)
// (already past any --help handling, which stays in bin/grade.js's main()).
function parseGradeArgs(argv) {
    const positional = argv.filter(a => !a.startsWith('--'));
    // Plain interactive menu = no positional args at all. Course/term selection always
    // prompt (even with one option) in that case; a shortcut like "node bin/grade.js Lab03"
    // keeps auto-resolving a single course/term silently, exactly as before.
    const isPlainMenu = positional.length === 0;
    const hasRegradeFlag = argv.includes('--regrade');
    const hasRecloneFlag = argv.includes('--reclone');
    const aiModelFlag = (argv.find(a => a.startsWith('--ai-model=')) || '').split('=')[1] || null;
    const aiComments = argv.includes('--ai-comments') || !!aiModelFlag;
    const textReport = argv.includes('--text-report');
    const canvasFlag = argv.includes('--canvas'); // also set by the interactive submission-source menu below
    const hasAnyFlag = hasRegradeFlag || hasRecloneFlag;
    return { positional, isPlainMenu, hasRegradeFlag, hasRecloneFlag, aiModelFlag, aiComments, textReport, canvasFlag, hasAnyFlag };
}

/**
 * Resolves everything bin/grade.js needs to start a grading run: course, term, submission
 * source, assignment/step, config, Canvas setup (if applicable), labDir/codeRoot paths,
 * and grading mode (normal/regrade/reclone). Throws SetupError on any unrecoverable
 * problem; callers are expected to print `err.lines` after tearing down any prompt UI.
 *
 * @param {Object} opts
 * @param {string[]} opts.argv - process.argv.slice(2), already past --help handling
 * @param {string} [opts.configsDir]
 * @param {string} [opts.localConfigPath]
 * @param {string} [opts.defaultConfigPath]
 */
export async function resolveGradeSetup({
    argv,
    configsDir = DEFAULT_CONFIGS_DIR,
    localConfigPath = DEFAULT_LOCAL_CONFIG_PATH,
    defaultConfigPath = DEFAULT_DEFAULT_CONFIG_PATH,
} = {}) {
    const {
        positional: parsedPositional, isPlainMenu, hasRegradeFlag, hasRecloneFlag,
        aiModelFlag, aiComments, textReport: initialTextReport, canvasFlag: initialCanvasFlag,
        hasAnyFlag,
    } = parseGradeArgs(argv);

    function readLocalConfig() {
        try {
            return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
        } catch (e) {}
        // Fall back to default-config.json (shipped with the repo) as a starting point
        try {
            return JSON.parse(fs.readFileSync(defaultConfigPath, 'utf8'));
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

    let positional = parsedPositional;
    let textReport = initialTextReport;
    let canvasFlag = initialCanvasFlag;
    let labName;
    let stepName = null;     // set for multi-step labs (e.g. node bin/grade.js TermProject ApiDoc)
    let reclone = hasRecloneFlag;
    let regrade = hasRegradeFlag || hasRecloneFlag;
    let config, labDir, labConfigDir, artifactsDir, submissionsDir;
    let skipRubric = false;
    let usingCanvas = false, courseId = null, assignmentId = null, canvasConfig = null;
    let course = null; // resolved course record from getExistingCourses(); course.name is the configs/ dir name
    let terms = {}, activeTermId = null; // resolved via migrateLocalConfigTerms() + term selection below
    let labRoot, codeRoot;

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

        // Prompts for a new course's directory name + display fields and writes its
        // course_config.json — the plain-menu equivalent of configure-lab.js's "Add new
        // course" wizard step, so a from-scratch install doesn't have to shell out to a
        // second script just to get past the course picker.
        async function createCourse() {
            const dirNameInput = await askRl('Course directory name, used as configs/<name>/ (e.g. CS233JS): ');
            const dirName = dirNameInput.trim();
            if (!dirName) { console.log('  A course directory name is required.'); return null; }
            if (/[\\/]/.test(dirName)) { console.log('  Course directory name cannot contain slashes.'); return null; }
            if (fs.existsSync(path.join(configsDir, dirName))) { console.log(`  A course directory named "${dirName}" already exists.`); return null; }

            const courseName = (await askRl(`Course display name [${dirName}]: `)).trim() || dirName;
            const courseCode = (await askRl(`Course code, shown in the interactive banner [${dirName}]: `)).trim() || dirName;
            const rubricPrefix = (await askRl(`Rubric filename prefix, e.g. "${dirName}_Lab03_Rubric.xlsm" [${courseCode}]: `)).trim() || courseCode;

            const coursePath = path.join(configsDir, dirName);
            writeCourseConfig(coursePath, { courseName, courseCode, rubricPrefix });
            console.log(`  Created course: ${coursePath}\n`);
            return { name: dirName, path: coursePath, courseName, courseCode, rubricPrefix, canvasCourseId: null };
        }

        // --- Course selection ---
        // Runs before the assignment menu so every config/data path below can be scoped to
        // configs/<Course>/ and <labRoot|codeRoot>/<Course>/. The plain interactive menu
        // (no CLI args at all) always shows the picker, even with one course, with an
        // "Add new course" option — but a shortcut like "node bin/grade.js Lab03" still
        // auto-resolves a single course silently, so existing single-course usage keeps
        // working unchanged.
        let courses = getExistingCourses(configsDir);
        if (courses.length === 0) {
            console.log(`No courses found under ${configsDir} yet — let's create one.\n`);
            while (!course) {
                course = await createCourse();
            }
            courses = [course];
        }

        if (courses.length === 1 && !isPlainMenu) {
            course = course || courses[0];
        } else {
            // Once there's more than one course, position 0 is always the course argument
            // (e.g. "node bin/grade.js CS233JS Lab03"); assignment/step shift down one slot.
            const courseArg = positional[0];
            course = course || (courseArg
                ? courses.find(c => c.name.toLowerCase() === courseArg.toLowerCase() || c.courseName.toLowerCase() === courseArg.toLowerCase())
                : null);
            positional = positional.slice(1);

            if (!course) {
                console.log('\nAvailable courses:');
                courses.forEach((c, i) => console.log(`  ${i + 1}) ${c.courseName}`));
                console.log(`  ${courses.length + 1}) Add new course`);
                console.log();
                completions = courses.map(c => c.courseName);
                course = await selectFromList(askRl, {
                    items: courses,
                    matchNames: c => [c.name, c.courseName],
                    promptText: 'Select a course (number or name): ',
                    extraOption: { action: createCourse },
                });
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
            if (!labRootInput.trim()) { throw new SetupError('ERROR: A lab root path is required.'); }
            const codeRootInput = await askRl(
                'Code storage root — path to a LOCAL folder (outside Google Drive) where student\n' +
                '  code will be cloned or unzipped. A subfolder per lab is created automatically\n' +
                '  (e.g. /Users/brian/GradingCode): '
            );
            if (!codeRootInput.trim()) { throw new SetupError('ERROR: A code storage root path is required.'); }

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
            activeTermId = await selectFromList(askRl, {
                items: list,
                matchNames: t => [t.id, t.label],
                getValue: t => t.id,
                promptText: 'Select a term (number or name): ',
                extraOption: { action: createTerm },
            });
            completions = [];
            console.log(`  Term: ${terms[activeTermId].label}\n`);
        }

        labRoot = terms[activeTermId].labRoot;
        codeRoot = terms[activeTermId].codeRoot;

        // --- Submission source (plain interactive menu only) ---
        // The --canvas flag has always been the CLI way to force a Canvas download; give
        // the plain menu the same power right after the term is chosen. The default keeps
        // each assignment's configured source: the Moodle download folder, or Canvas for a
        // lab whose config already has canvas.assignmentId. Choosing Canvas here behaves
        // exactly like --canvas (runs the interactive Canvas setup, letting you set up a
        // lab for the first time or re-select its Canvas assignment).
        if (isPlainMenu && !canvasFlag) {
            console.log('Submission source:');
            console.log("  1) Assignment's configured source — Moodle download folder, or Canvas if already set up");
            console.log('  2) Download from Canvas — first-time setup, or re-select the Canvas assignment');
            console.log();
            for (;;) {
                const input = (await askRl('Select a source [1]: ')).trim();
                if (input === '' || input === '1') break;
                if (input === '2') { canvasFlag = true; break; }
                console.log('  Invalid selection, try again.');
            }
            console.log(canvasFlag ? '  Source: Canvas download\n' : '  Source: configured (Moodle folder by default)\n');
        }

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
            labName = await selectFromList(askRl, {
                items: labs,
                matchNames: l => [l],
                promptText: 'Select an assignment (number or name): ',
            });
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
                        throw new SetupError([
                            `ERROR: Step "${stepArg}" not found in ${labName}.`,
                            `  Available steps: ${existingSteps.join(', ')}`,
                        ]);
                    }
                    stepName = match;
                } else {
                    console.log(`\n${labName} has multiple submission steps:`);
                    existingSteps.forEach((s, i) => console.log(`  ${i + 1}) ${s}`));
                    console.log();
                    completions = existingSteps;
                    stepName = await selectFromList(askRl, {
                        items: existingSteps,
                        matchNames: s => [s],
                        promptText: 'Select a step (number or name): ',
                    });
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
            throw new SetupError(`ERROR: Config file not found at ${configPath}`);
        }
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            throw new SetupError(`ERROR: Could not parse config file ${configPath}: ${e.message}`);
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
            throw new SetupError(`ERROR: ${e.message}`);
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
                if (!input.trim()) { throw new SetupError('ERROR: A Canvas URL is required.'); }
                canvasConfig.url = input.trim();
                canvasLocalChanged = true;
            }
            if (!canvasConfig.token) {
                const input = await askRl('Canvas API token (Account -> Settings -> New Access Token): ');
                if (!input.trim()) { throw new SetupError('ERROR: A Canvas API token is required.'); }
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
                    throw new SetupError(`ERROR: No assignments found in course ${courseId} ("${canvasCourse.name}").`);
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
                const chosenAssignment = await selectFromList(askRl, {
                    items: assignments,
                    matchNames: a => [a.name],
                    promptText: defaultChoice ? `  Select an assignment (number or name) [${defaultChoice}]: ` : '  Select an assignment (number or name): ',
                    defaultIndex: guessIdx >= 0 ? guessIdx : null,
                });
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
        const legacyLabDir = path.join(labRoot, labName);
        labDir = await resolveLegacyLabDir({
            labDir,
            legacyLabDir,
            courseName,
            labName,
            usingCanvas,
            courses,
            // Temporary adapter reproducing the original raw-readline prompt/behavior
            // exactly (single "(y/n)" prompt, only literal "y" confirms) — replaced with
            // real driver plumbing once this module's own prompts are converted.
            driver: {
                print: line => console.log(line),
                note: line => console.log(line),
                askBoolean: async q => {
                    const raw = await askRl(`${q} (y/n): `);
                    return raw.trim().toLowerCase() === 'y';
                },
            },
        });
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
                    throw new SetupError('Aborted. Re-run and enter the correct lab root path.');
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

                const lines = [
                    `\nERROR: No submissions folder found for ${labName} at:`,
                    `  ${labDir}`,
                    `  (also checked the pre-course-tier path: ${legacyLabDir})`,
                ];
                if (siblings.length > 0) {
                    lines.push(`\n  Your lab root looks correct — it already contains: ${siblings.join(', ')}`);
                    lines.push(`  It just has no ${courseName}/${labName} folder yet. Have you downloaded the`);
                    lines.push(`  ${labName} submissions from Moodle into <labRoot>/${courseName}/${labName}/ ?`);
                } else {
                    lines.push(`  Make sure your lab root (${labRoot}) is the folder that contains the ${courseName}/${labName} subdirectory.`);
                }
                throw new SetupError(lines);
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
                const chosenGroup = await selectFromList(askRl, {
                    items: subdirs,
                    matchNames: d => [d],
                    promptText: `Select which group to grade (number or name) [${subdirs.length}]: `,
                    defaultIndex: subdirs.length - 1,
                });
                labDir = path.join(labDir, chosenGroup);
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
                    throw new SetupError('ERROR: A code storage root path is required.');
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

    return {
        course, labName, stepName,
        config, labConfigDir, labDir,
        artifactsDir, submissionsDir,
        usingCanvas, courseId, assignmentId, canvasConfig,
        regrade, reclone, skipRubric, textReport, aiComments, aiModelFlag,
        activeTermId, labRoot, codeRoot,
    };
}

export { parseGradeArgs, SetupError };
