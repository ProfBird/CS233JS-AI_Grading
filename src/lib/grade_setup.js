/**
 * grade_setup.js
 *
 * bin/grade.js's interactive setup phase (course/term/submission-source/assignment/step/
 * Canvas/rubric/mode resolution), extracted out of grade.js so it's unit-testable without
 * spawning a real process or stubbing process.exit — same rationale as
 * src/lib/config_validation.js's extraction (see CLAUDE.md's "Shared utilities" section).
 *
 * Prompts run over a driver (src/lib/prompt_driver.js) — either a full-screen neo-blessed
 * TUI (the same one bin/configure-lab.js uses) or a readline fallback for piped/non-TTY
 * invocations. `driver` is created and torn down by the caller (bin/grade.js's main()), not
 * here, so its post-teardown notes (driver.takeNotes()) can be replayed to real stdout
 * after this function returns.
 */
import fs from 'fs';
import path from 'path';

import { getExistingSteps, getExistingCourses, readCourseConfig, writeCourseConfig, applyCourseDefaults } from './lab_config.js';
import { askPath } from './path_browser.js';
import { validateConfig, loadHandlerModules } from './config_validation.js';
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
 * problem; callers are expected to print `err.lines` after tearing down the driver.
 *
 * @param {Object} driver - prompt driver (src/lib/prompt_driver.js); lifecycle (creation,
 *        close(), notes replay) is owned by the caller.
 * @param {Object} opts
 * @param {string[]} opts.argv - process.argv.slice(2), already past --help handling
 * @param {string} [opts.configsDir]
 * @param {string} [opts.localConfigPath]
 * @param {string} [opts.defaultConfigPath]
 */
export async function resolveGradeSetup(driver, {
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
        driver.note('  Migrated labRoot/codeRoot into a "Spring 2026" term in local-config.json');
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

    const localConfig = readLocalConfig();
    let configChanged = false;

    // Prompts for a new course's directory name + display fields and writes its
    // course_config.json — the plain-menu equivalent of configure-lab.js's "Add new
    // course" wizard step, so a from-scratch install doesn't have to shell out to a
    // second script just to get past the course picker.
    async function createCourse() {
        const dirNameInput = await driver.ask('Course directory name, used as configs/<name>/ (e.g. CS233JS)', '');
        const dirName = dirNameInput.trim();
        if (!dirName) { driver.print('  A course directory name is required.'); return null; }
        if (/[\\/]/.test(dirName)) { driver.print('  Course directory name cannot contain slashes.'); return null; }
        if (fs.existsSync(path.join(configsDir, dirName))) { driver.print(`  A course directory named "${dirName}" already exists.`); return null; }

        const courseName = (await driver.ask('Course display name', dirName)).trim() || dirName;
        const courseCode = (await driver.ask('Course code, shown in the interactive banner', dirName)).trim() || dirName;
        const rubricPrefix = (await driver.ask(`Rubric filename prefix, e.g. "${dirName}_Lab03_Rubric.xlsm"`, courseCode)).trim() || courseCode;

        const coursePath = path.join(configsDir, dirName);
        writeCourseConfig(coursePath, { courseName, courseCode, rubricPrefix });
        driver.note(`  Created course: ${coursePath}`);
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
        driver.print(`No courses found under ${configsDir} yet — let's create one.`);
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
            const courseOpts = [
                ...courses.map(c => ({ label: c.courseName, value: c, match: [c.name, c.courseName], desc: c.path })),
                { label: 'Add new course', value: '__new__', color: 'green', desc: 'Create a new configs/<name>/ course' },
            ];
            while (!course) {
                const chosen = await driver.askOptions('Select a course', courseOpts, 0);
                course = chosen === '__new__' ? await createCourse() : chosen;
            }
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
        const labelInput = await driver.ask(firstEver ? 'Term label' : 'Term label (e.g. Fall 2026)', firstEver ? 'Spring 2026' : '');
        const label = labelInput.trim() || (firstEver ? 'Spring 2026' : '');
        if (!label) { driver.print('  A term label is required.'); return null; }
        const defaultId = firstEver ? '2026Spring' : label.replace(/[^A-Za-z0-9]+/g, '');
        const idInput = await driver.ask('Term id, used as a folder-safe key', defaultId);
        const id = idInput.trim() || defaultId;
        if (!id) { driver.print('  A term id is required.'); return null; }
        if (terms[id]) { driver.print(`  A term with id "${id}" already exists.`); return null; }

        // New terms usually sit next to the previous term's folders — start browsing there.
        const lastTerm = listTerms().slice(-1)[0];
        driver.print('Lab root - the folder containing the students submissions');
        driver.print('  (e.g. /Volumes/GoogleDrive/StudentLabWork). Browse to it, or choose "Type a path".');
        const labRootInput = await askPath(driver, {
            prompt: 'Lab root folder', kind: 'dir',
            start: lastTerm ? path.dirname(lastTerm.labRoot) : undefined,
        });
        if (!labRootInput.trim()) { throw new SetupError('ERROR: A lab root path is required.'); }
        driver.print('Code storage root — a LOCAL folder (outside Google Drive) where student');
        driver.print('  code will be cloned or unzipped. A subfolder per lab is created automatically');
        driver.print('  (e.g. /Users/brian/GradingCode)');
        const codeRootInput = await askPath(driver, {
            prompt: 'Code storage root folder', kind: 'dir',
            start: lastTerm ? path.dirname(lastTerm.codeRoot) : undefined,
        });
        if (!codeRootInput.trim()) { throw new SetupError('ERROR: A code storage root path is required.'); }

        terms = { ...terms, [id]: { label, labRoot: labRootInput.trim(), codeRoot: codeRootInput.trim() } };
        saveLocalConfig({ terms });
        driver.note(`  Saved term "${label}" (${id}) to local-config.json`);
        return id;
    }

    if (listTerms().length === 0) {
        activeTermId = await createTerm();
    } else if (listTerms().length === 1 && !isPlainMenu) {
        activeTermId = listTerms()[0].id;
    } else {
        const list = listTerms();
        const termOpts = [
            ...list.map(t => ({ label: t.label, value: t.id, match: [t.id, t.label] })),
            { label: 'Add new term', value: '__new__', color: 'green' },
        ];
        activeTermId = null;
        while (!activeTermId) {
            const chosen = await driver.askOptions('Select a term', termOpts, 0);
            activeTermId = chosen === '__new__' ? await createTerm() : chosen;
        }
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
        const sourceOpts = [
            { label: "Assignment's configured source", value: 'configured', desc: 'Moodle download folder, or Canvas if already set up' },
            { label: 'Download from Canvas', value: 'canvas', desc: 'First-time setup, or re-select the Canvas assignment' },
        ];
        const sourceChoice = await driver.askOptions('Submission source', sourceOpts, 0);
        if (sourceChoice === 'canvas') canvasFlag = true;
        driver.print(canvasFlag ? '  Source: Canvas download' : '  Source: configured (Moodle folder by default)');
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
        // A course created but not yet given any assignment configs (e.g. via "Add new
        // course" just now) has nothing to pick — say what to do instead of showing an
        // empty picker.
        if (labs.length === 0) {
            throw new SetupError([
                `ERROR: Course "${course.courseName}" has no assignments configured yet.`,
                `  Add one with: node bin/configure-lab.js`,
            ]);
        }
        driver.banner(`${course.courseCode} AI Grader v1.0`);
        driver.print('  (Run with --help to see all command-line options)');

        const labOpts = labs.map(l => ({ label: l, value: l }));
        labName = await driver.askOptions(`Assignment (${course.courseName})`, labOpts, 0);
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
                const stepOpts = existingSteps.map(s => ({ label: s, value: s }));
                stepName = await driver.askOptions(`Which ${labName} step?`, stepOpts, 0);
            }
            driver.print(`  Step: ${stepName}`);
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
    // Course-wide settings (course_config.json's "defaults") fill in whatever the lab
    // config doesn't set. In memory only — anything written back to the lab config below
    // re-reads the file from disk, so course defaults are never copied into a lab's file.
    try {
        config = applyCourseDefaults(config, readCourseConfig(course.path));
    } catch (e) {
        throw new SetupError(`ERROR: ${e.message} (${path.join(course.path, 'course_config.json')})`);
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
            const input = await driver.ask('Canvas URL (e.g. https://yourschool.instructure.com)', '');
            if (!input.trim()) { throw new SetupError('ERROR: A Canvas URL is required.'); }
            canvasConfig.url = input.trim();
            canvasLocalChanged = true;
        }
        if (!canvasConfig.token) {
            const input = await driver.ask('Canvas API token (Account -> Settings -> New Access Token)', '');
            if (!input.trim()) { throw new SetupError('ERROR: A Canvas API token is required.'); }
            canvasConfig.token = input.trim();
            canvasLocalChanged = true;
        }

        courseId = course.canvasCourseId || null;
        assignmentId = config.canvas?.assignmentId || null;

        if (canvasFlag || !assignmentId) {
            driver.print('\n--- Canvas Setup ---');
            let canvasCourse = null;
            while (!canvasCourse) {
                const entered = await driver.ask('Canvas course ID', courseId ? String(courseId) : '');
                if (!entered) { driver.print('  A course ID is required.'); continue; }
                const id = Number(entered);
                if (!Number.isInteger(id)) { driver.print('  Please enter a numeric course ID.'); continue; }
                try {
                    const fetched = await canvasClient.getCourse(id, canvasConfig);
                    driver.print(`\n  Course: "${fetched.name}" (id ${fetched.id}, status: ${fetched.workflow_state})`);
                    const confirm = await driver.askBoolean('Is this the correct course?', false);
                    if (confirm) {
                        canvasCourse = fetched;
                        courseId = fetched.id;
                    } else {
                        driver.print('  Okay — enter the correct course ID.');
                    }
                } catch (e) {
                    driver.print(`  ERROR: ${canvasClient.sanitize(e.message, canvasConfig.token)}`);
                }
            }

            // Persist the confirmed Canvas course ID onto the local course record right
            // away — course.canvasCourseId (below) is what future labs in this course
            // will default to, and course_config.json is written after the assignment
            // is picked too, so both fields land in one write.
            course.canvasCourseId = courseId;

            driver.print(`\n  Fetching assignments for "${canvasCourse.name}"...`);
            const assignments = await canvasClient.listAssignments(courseId, canvasConfig);
            if (assignments.length === 0) {
                throw new SetupError(`ERROR: No assignments found in course ${courseId} ("${canvasCourse.name}").`);
            }
            const guessTarget = (stepName || labName).toLowerCase();
            const guessIdx = assignments.findIndex(a => {
                const n = a.name.toLowerCase();
                return n.includes(guessTarget) || guessTarget.includes(n);
            });

            const assignmentOpts = assignments.map((a, i) => ({
                label: a.name,
                value: a,
                status: `id ${a.id}${a.published === false ? '  [unpublished]' : ''}${i === guessIdx ? '  <-- looks like a match' : ''}`,
            }));
            const chosenAssignment = await driver.askOptions(
                `Assignments in "${canvasCourse.name}"`, assignmentOpts, Math.max(0, guessIdx)
            );
            assignmentId = chosenAssignment.id;
            driver.note(`  Assignment: "${chosenAssignment.name}" (id ${assignmentId})`);

            // Persist assignmentId into the lab's (or step's) own config file — same
            // read-modify-write pattern the rubricName prompt below already uses.
            const cfgOnDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            cfgOnDisk.canvas = { assignmentId };
            fs.writeFileSync(configPath, JSON.stringify(cfgOnDisk, null, 2) + '\n', 'utf8');
            config.canvas = { assignmentId };
            driver.note(`  Saved Canvas assignment to ${path.basename(configPath)}`);

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
        driver,
    });
    if (!usingCanvas && !fs.existsSync(labDir)) {
        // Common mistake: user entered the lab subdirectory as labRoot instead of its parent
        if (path.basename(labRoot).toLowerCase() === labName.toLowerCase() ||
            path.basename(labRoot).toLowerCase() === courseName.toLowerCase()) {
            const correctedRoot = path.dirname(labRoot);
            driver.print(`\nIt looks like your lab root points inside the ${courseName}/${labName} folder itself.`);
            driver.print(`  Entered:   ${labRoot}`);
            driver.print(`  Should be: ${correctedRoot}`);
            const confirm = await driver.askBoolean('Use the parent folder and update your saved settings?', false);
            if (confirm) {
                labRoot = correctedRoot;
                labDir = path.join(labRoot, courseName, labName);
                terms = { ...terms, [activeTermId]: { ...terms[activeTermId], labRoot } };
                saveLocalConfig({ terms });
                driver.note('  Updated lab root saved to local-config.json');
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
            driver.note(`  Note: no "${stepName}" subfolder found in labRoot — using submissions from ${labDir}`);
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
            driver.print(`\nNo submissions found directly in ${labName}/. Found these submission groups:`);
            const groupOpts = subdirs.map(d => ({ label: d, value: d }));
            const chosenGroup = await driver.askOptions('Select which group to grade', groupOpts, subdirs.length - 1);
            labDir = path.join(labDir, chosenGroup);
            driver.note(`  Using: ${labDir}`);
            // If this is a multi-step lab and the chosen folder doesn't match the step
            // name, the only reason we had to ask is the folder naming. Point the fix out.
            if (stepName) {
                const chosenName = path.basename(labDir);
                if (chosenName.toLowerCase() !== stepName.toLowerCase()) {
                    driver.note(`  Tip: rename "${chosenName}" to "${stepName}" under your lab root to skip this prompt next time.`);
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
            driver.print(`\nFound existing graded output at the pre-course-tier location:`);
            driver.print(`  ${path.join(codeRoot, legacySubPath)}`);
            driver.print(`It hasn't been moved under the new "${courseName}/" layout yet.`);
            const moveIt = await driver.askBoolean(`Move it to ${path.join(codeRoot, labSubPath)} now?`, true);
            if (moveIt) {
                fs.mkdirSync(path.dirname(path.join(codeRoot, labSubPath)), { recursive: true });
                fs.renameSync(path.join(codeRoot, legacySubPath), path.join(codeRoot, labSubPath));
                driver.note(`  Moved existing output to ${path.join(codeRoot, labSubPath)}.`);
            } else {
                driver.note(`  Skipped — a fresh ${courseName}/ tree will be created; the old data stays at ${path.join(codeRoot, legacySubPath)}.`);
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
            driver.print(`\nERROR: Cannot write to code storage directory:`);
            driver.print(`  ${path.join(codeRoot, labSubPath)}`);
            driver.print(`  ${e.message}`);
            driver.print('Choose a writable folder for storing cloned/extracted student code');
            driver.print('  (e.g. /Users/brian/GradingCode)');
            const newRoot = await askPath(driver, { prompt: 'Writable code storage folder', kind: 'dir', start: path.dirname(codeRoot) });
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
        driver.note('  Saved updated codeRoot to local-config.json');
    }

    // Validate rubric exists before starting the pipeline (skip for extract-only).
    // A textReport config may have no rubricName at all — treat that as "not found"
    // so it flows into the text-report branch below instead of crashing path.join.
    while (!skipRubric && !config.extractOnly) {
        const rubricCheckPath = config.rubricName ? path.join(labConfigDir, config.rubricName) : null;
        if (rubricCheckPath && fs.existsSync(rubricCheckPath)) {
            break;
        } else if (textReport) {
            driver.note(`  Rubric not found, but --text-report is set. Will generate .txt reports.`);
            skipRubric = true;
            break;
        } else {
            driver.print(`\nRubric file not found at expected path:`);
            driver.print(`  ${rubricCheckPath}`);
            const provideRubric = await driver.askBoolean('Would you like to provide a rubric spreadsheet?', false);
            if (!provideRubric) {
                driver.note('  Continuing without rubric — will generate .txt grade reports.');
                skipRubric = true;
                textReport = true;
                break;
            }
            driver.print(`  e.g. ${course.rubricPrefix}_${labName}_Rubric.xlsm — browse to the spreadsheet, or type its name`);
            const chosen = await askPath(driver, {
                prompt: 'Rubric spreadsheet', kind: 'file', extensions: ['.xlsx', '.xlsm'],
                start: labConfigDir, baseDir: labConfigDir,
            });
            if (!chosen.trim()) {
                driver.note('  No rubric chosen — will generate .txt grade reports.');
                skipRubric = true;
                textReport = true;
                break;
            }
            // The rubric lives in the lab's config folder (rubricName is a bare filename) —
            // copy one chosen from anywhere else into it.
            let rubricFile = chosen;
            if (path.dirname(path.resolve(chosen)) !== path.resolve(labConfigDir)) {
                const dest = path.join(labConfigDir, path.basename(chosen));
                const replace = !fs.existsSync(dest)
                    || await driver.askBoolean(`Replace ${path.basename(dest)} in the lab's config folder with the chosen file?`, false);
                if (replace) {
                    fs.copyFileSync(chosen, dest);
                    driver.note(`  Copied rubric to ${dest}`);
                }
                rubricFile = dest;
            }
            config.rubricName = path.basename(rubricFile);
            // Persist to config file on disk
            const cfgOnDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            cfgOnDisk.rubricName = config.rubricName;
            fs.writeFileSync(configPath, JSON.stringify(cfgOnDisk, null, 2) + '\n', 'utf8');
            driver.note(`  Updated rubricName in ${labName.toLowerCase()}_config.json`);
        }
    }

    if (!hasAnyFlag) {
        const modeOpts = config.extractOnly
            ? [
                { label: 'Normal', value: 'normal', desc: 'Extract new submissions (skip already-cloned)' },
                { label: 'Re-extract', value: 'regrade', desc: 'Keep existing code, run git pull on repos' },
                { label: 'Reclone', value: 'reclone', desc: 'Delete all extracted code, re-clone/unzip from scratch' },
            ]
            : [
                { label: 'Normal', value: 'normal', desc: 'Grade new submissions (skip already-extracted)' },
                { label: 'Regrade', value: 'regrade', desc: 'Re-run grading but keep existing cloned code' },
                { label: 'Reclone', value: 'reclone', desc: 'Delete all extracted code, re-clone/unzip, and re-grade' },
            ];
        const modeTitle = config.extractOnly ? 'Extract options' : 'Grading options';
        const choice = await driver.askOptions(modeTitle, modeOpts, 0);
        if (choice === 'regrade') {
            regrade = true;
        } else if (choice === 'reclone') {
            reclone = true;
            regrade = true;
        }
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
