/**
 * grade_setup.spec.mjs
 *
 * Unit tests for src/lib/grade_setup.js's resolveGradeSetup() — bin/grade.js's
 * interactive setup phase (course/term/submission-source/assignment/step/Canvas/rubric/
 * mode resolution), extracted so it's testable without spawning a real process or
 * driving a real terminal. Runs against a scratch configs/labRoot/codeRoot tree and a
 * strict mockDriver (test/helpers/mock_driver.mjs) that fails loudly on any prompt
 * string violating the driver's bare-label convention (no embedded "[default]",
 * no trailing ":", no newline — see src/lib/prompt_driver.js's header comment).
 *
 * Single-course fixtures deliberately omit the course name from argv: per CLAUDE.md's
 * "Courses" section, a shortcut only needs a courseName argument once 2+ courses exist —
 * with exactly one, grade.js auto-resolves it and positional args are NOT shifted, so
 * argv: ['Lab03'] (not ['CS233JS', 'Lab03']) is the realistic single-course invocation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockDriver } from './helpers/mock_driver.mjs';
import { resolveGradeSetup, parseGradeArgs, SetupError } from '../src/lib/grade_setup.js';
// Side-effect import: generate_grades.js registers all built-in mapping-type handlers
// (registerHandler calls at module load), populating VALID_MAPPING_TYPES that
// validateConfig() checks against. In the real app this happens because bin/grade.js's
// import chain pulls in generate_grades.js via run_pipeline.js; this test exercises
// grade_setup.js in isolation, so it must trigger that registration itself (same fix as
// test/config_validation.spec.mjs).
import '../src/pipeline/generate_grades.js';

const VALID_CONFIG = {
    textReport: true,
    runtimeCheck: 'none',
    mappings: [{ type: 'manual', maxScore: 5 }],
};

let configsDir, localConfigPath, defaultConfigPath, labRootDir, codeRootDir, scratchRoot;

function writeLocalConfig(obj) {
    writeFileSync(localConfigPath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeLab(course, lab, config = VALID_CONFIG) {
    const dir = join(configsDir, course, lab);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${lab.toLowerCase()}_config.json`), JSON.stringify(config), 'utf8');
    return dir;
}

function writeStep(course, lab, step, config = VALID_CONFIG) {
    const dir = join(configsDir, course, lab, step);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${step.toLowerCase()}_config.json`), JSON.stringify(config), 'utf8');
    return dir;
}

function writeCourseConfig(course, obj = { courseName: course, courseCode: course, rubricPrefix: course }) {
    const dir = join(configsDir, course);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'course_config.json'), JSON.stringify(obj), 'utf8');
}

// Creates a fake Moodle submission subdir (matches MOODLE_DIR_PATTERN) so
// hasMoodleSubmissions() reports true for `dir`.
function markMoodleSubmissions(dir) {
    mkdirSync(join(dir, 'Student_12345_assignsubmission_onlinetext'), { recursive: true });
}

beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'grade_setup_test_'));
    configsDir = join(scratchRoot, 'configs');
    localConfigPath = join(scratchRoot, 'local-config.json');
    defaultConfigPath = join(scratchRoot, 'nonexistent-default-config.json');
    labRootDir = join(scratchRoot, 'labRoot');
    codeRootDir = join(scratchRoot, 'codeRoot');
    mkdirSync(configsDir, { recursive: true });
    mkdirSync(labRootDir, { recursive: true });
    mkdirSync(codeRootDir, { recursive: true });
});

afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
});

function opts(extra = {}) {
    return { configsDir, localConfigPath, defaultConfigPath, ...extra };
}

function oneTermConfig() {
    return { terms: { '2026Spring': { label: 'Spring 2026', labRoot: labRootDir, codeRoot: codeRootDir } } };
}

describe('parseGradeArgs', () => {
    it('treats no positional args as the plain menu', () => {
        expect(parseGradeArgs([]).isPlainMenu).toBe(true);
    });

    it('treats any positional arg as a shortcut invocation', () => {
        expect(parseGradeArgs(['Lab03']).isPlainMenu).toBe(false);
    });

    it('parses --regrade/--reclone/--ai-model/--text-report/--canvas', () => {
        const r = parseGradeArgs(['Lab03', '--regrade', '--ai-model=qwen3-coder', '--text-report', '--canvas']);
        expect(r.hasRegradeFlag).toBe(true);
        expect(r.hasRecloneFlag).toBe(false);
        expect(r.aiModelFlag).toBe('qwen3-coder');
        expect(r.aiComments).toBe(true);
        expect(r.textReport).toBe(true);
        expect(r.canvasFlag).toBe(true);
        expect(r.hasAnyFlag).toBe(true);
        expect(r.positional).toEqual(['Lab03']);
    });

    it('--reclone sets hasAnyFlag independently of --ai-comments', () => {
        const r = parseGradeArgs(['Lab03', '--reclone']);
        expect(r.hasRecloneFlag).toBe(true);
        expect(r.hasAnyFlag).toBe(true);
        expect(r.aiComments).toBe(false);
    });
});

describe('resolveGradeSetup — non-interactive shortcut path', () => {
    it('prompts for NOTHING when course, term, and lab are all unambiguous', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03');
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS233JS', 'Lab03'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'Lab03'));

        const driver = mockDriver([], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab03', '--regrade'] }));

        expect(driver.calls.filter(c => ['ask', 'askBoolean', 'askInt', 'askOptions'].includes(c.method))).toEqual([]);
        expect(setup.regrade).toBe(true);
        expect(setup.labName).toBe('Lab03');
        expect(setup.course.name).toBe('CS233JS');
    });
});

describe('resolveGradeSetup — course defaults', () => {
    it('merges course_config.json "defaults" under the lab config, in memory only', async () => {
        writeCourseConfig('CS212', {
            courseName: 'CS212', courseCode: 'CS212', rubricPrefix: 'CS212',
            defaults: { language: 'python', textReport: true, runtimeCheck: 'none', execution: { mode: 'direct', timeoutMs: 20000 } },
        });
        // The lab config sets neither language nor textReport nor runtimeCheck — all from the course.
        const labConfig = { mappings: [{ type: 'manual', maxScore: 5 }], execution: { timeoutMs: 60000 } };
        const labDir = writeLab('CS212', 'Lab02', labConfig);
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS212', 'Lab02'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS212', 'Lab02'));

        const driver = mockDriver([], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab02', '--regrade'] }));

        expect(setup.config.language).toBe('python');
        expect(setup.config.runtimeCheck).toBe('none');
        expect(setup.config.execution).toEqual({ mode: 'direct', timeoutMs: 60000 });
        expect(setup.textReport).toBe(true);
        // The lab's file on disk is unchanged.
        expect(JSON.parse(readFileSync(join(labDir, 'lab02_config.json'), 'utf8'))).toEqual(labConfig);
    });

    it('a course with no assignments yet gets a clear error, not an empty picker', async () => {
        writeCourseConfig('CS212');
        writeLocalConfig(oneTermConfig());

        // Plain menu: course picker -> CS212; term picker -> the one term; source -> configured.
        const driver = mockDriver(['CS212', '', ''], { strict: true });
        await expect(resolveGradeSetup(driver, opts({ argv: [] })))
            .rejects.toThrow(/has no assignments configured yet/);
    });

    it('throws SetupError when defaults set a per-assignment key', async () => {
        writeCourseConfig('CS212', { courseName: 'CS212', defaults: { mappings: [] } });
        writeLab('CS212', 'Lab02');
        writeLocalConfig(oneTermConfig());

        const driver = mockDriver([], { strict: true });
        await expect(resolveGradeSetup(driver, opts({ argv: ['Lab02'] })))
            .rejects.toThrow(/can't set per-assignment key\(s\): mappings/);
    });
});

describe('resolveGradeSetup — plain menu walk', () => {
    it('walks course -> term -> source -> assignment -> mode with driver.askOptions', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03');
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS233JS', 'Lab03'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'Lab03'));

        // Plain menu (argv: []) always shows course/term/source/assignment pickers even
        // with a single option each; mode menu shows too since no --regrade/--reclone.
        const driver = mockDriver(['1', '1', '', '1', '1'], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: [] }));

        expect(setup.labName).toBe('Lab03');
        expect(setup.regrade).toBe(false);
        expect(setup.reclone).toBe(false);
    });

    it('picks assignment and step by typed name', async () => {
        writeCourseConfig('CS233JS');
        writeStep('CS233JS', 'TermProject', 'Beta');
        writeStep('CS233JS', 'TermProject', 'Production');
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS233JS', 'TermProject', 'Beta'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'TermProject', 'Beta'));

        const driver = mockDriver(['1', '1', '', 'TermProject', 'beta', '1'], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: [] }));

        expect(setup.labName).toBe('TermProject');
        expect(setup.stepName).toBe('Beta');
    });
});

describe('resolveGradeSetup — multi-step errors', () => {
    it('throws SetupError listing available steps when the given step arg does not exist', async () => {
        writeCourseConfig('CS233JS');
        writeStep('CS233JS', 'TermProject', 'Beta');
        writeStep('CS233JS', 'TermProject', 'Production');
        writeLocalConfig(oneTermConfig());

        const driver = mockDriver([], { strict: true });
        await expect(resolveGradeSetup(driver, opts({ argv: ['TermProject', 'Nope'] })))
            .rejects.toMatchObject({
                constructor: SetupError,
                lines: [
                    'ERROR: Step "Nope" not found in TermProject.',
                    '  Available steps: Beta, Production',
                ],
            });
    });
});

describe('resolveGradeSetup — config errors', () => {
    it('throws SetupError when the lab config file is missing', async () => {
        writeCourseConfig('CS233JS');
        mkdirSync(join(configsDir, 'CS233JS', 'GhostLab'), { recursive: true });
        writeLocalConfig(oneTermConfig());

        const driver = mockDriver([], { strict: true });
        await expect(resolveGradeSetup(driver, opts({ argv: ['GhostLab'] })))
            .rejects.toThrow(/Config file not found/);
    });

    it('throws SetupError when the lab config file is unparseable JSON', async () => {
        writeCourseConfig('CS233JS');
        const dir = join(configsDir, 'CS233JS', 'BadLab');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'badlab_config.json'), '{ not json', 'utf8');
        writeLocalConfig(oneTermConfig());

        const driver = mockDriver([], { strict: true });
        await expect(resolveGradeSetup(driver, opts({ argv: ['BadLab'] })))
            .rejects.toThrow(/Could not parse config file/);
    });

    it('throws SetupError when validateConfig rejects the config', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'InvalidLab', { runtimeCheck: 'bogus-mode', mappings: [] });
        writeLocalConfig(oneTermConfig());

        const driver = mockDriver([], { strict: true });
        await expect(resolveGradeSetup(driver, opts({ argv: ['InvalidLab'] })))
            .rejects.toThrow(/Config validation failed/);
    });
});

describe('resolveGradeSetup — term creation', () => {
    it('throws SetupError on a blank lab root when creating the first-ever term', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03');
        writeLocalConfig({}); // no terms yet -> createTerm() runs once, non-looping

        const driver = mockDriver(['Spring 2026', '2026Spring', ''], { strict: true }); // blank lab root
        await expect(resolveGradeSetup(driver, opts({ argv: ['Lab03'] })))
            .rejects.toThrow(/A lab root path is required/);
    });
});

describe('resolveGradeSetup — submission group picker', () => {
    it('resolves a typed group name and notes the chosen path', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab05');
        writeLocalConfig(oneTermConfig());
        const labDir = join(labRootDir, 'CS233JS', 'Lab05');
        markMoodleSubmissions(join(labDir, 'Lab05-Beta'));
        markMoodleSubmissions(join(labDir, 'Lab05-Production'));

        const driver = mockDriver(['Lab05-Beta', '1'], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab05'] }));

        expect(setup.labDir).toBe(join(labDir, 'Lab05-Beta'));
        expect(driver.takeNotes().some(n => n.includes('Using:') && n.includes('Lab05-Beta'))).toBe(true);
    });

    it('defaults to the last group on empty input', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab05');
        writeLocalConfig(oneTermConfig());
        const labDir = join(labRootDir, 'CS233JS', 'Lab05');
        markMoodleSubmissions(join(labDir, 'Lab05-Beta'));
        markMoodleSubmissions(join(labDir, 'Lab05-Production'));

        const driver = mockDriver(['', '1'], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab05'] }));

        expect(setup.labDir).toBe(join(labDir, 'Lab05-Production'));
    });
});

describe('resolveGradeSetup — legacy pre-course-tier labRoot', () => {
    it('auto-falls-back with a single course, no prompt', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03');
        writeLocalConfig(oneTermConfig());
        // Legacy flat path (no CS233JS/ segment), single course -> auto-used, no prompt.
        mkdirSync(join(labRootDir, 'Lab03'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'Lab03'));

        const driver = mockDriver(['1'], { strict: true }); // just the mode menu
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab03'] }));

        expect(setup.labDir).toBe(join(labRootDir, 'Lab03'));
    });
});

describe('resolveGradeSetup — rubric resolution', () => {
    it('falls back to text reports when no rubric is provided', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03', { runtimeCheck: 'none', rubricName: 'Missing_Rubric.xlsm', mappings: [{ type: 'manual', maxScore: 5 }] });
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS233JS', 'Lab03'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'Lab03'));

        // askBoolean("provide a rubric?") -> 'n', then mode menu -> '1'
        const driver = mockDriver(['n', '1'], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab03'] }));

        expect(setup.skipRubric).toBe(true);
        expect(setup.textReport).toBe(true);
    });

    it('skips the rubric prompt AND the mode menu when textReport/--regrade are set', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab06'); // VALID_CONFIG already has textReport: true
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS233JS', 'Lab06'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'Lab06'));

        const driver = mockDriver([], { strict: true }); // zero prompts expected
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab06', '--regrade'] }));

        expect(setup.skipRubric).toBe(true);
        expect(setup.textReport).toBe(true);
    });
});

describe('resolveGradeSetup — grading/extract mode menu', () => {
    it('maps the Regrade option to regrade=true', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03');
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS233JS', 'Lab03'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'Lab03'));

        const driver = mockDriver(['2'], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab03'] }));

        expect(setup.regrade).toBe(true);
        expect(setup.reclone).toBe(false);
    });

    it('maps the Reclone option to both regrade and reclone true', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03');
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS233JS', 'Lab03'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'Lab03'));

        const driver = mockDriver(['3'], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab03'] }));

        expect(setup.regrade).toBe(true);
        expect(setup.reclone).toBe(true);
    });

    it('an unrecognized answer falls back to the default (Normal), never silently to something else', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03');
        writeLocalConfig(oneTermConfig());
        mkdirSync(join(labRootDir, 'CS233JS', 'Lab03'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'Lab03'));

        const driver = mockDriver(['9'], { strict: true });
        const setup = await resolveGradeSetup(driver, opts({ argv: ['Lab03'] }));

        expect(setup.regrade).toBe(false);
        expect(setup.reclone).toBe(false);
    });
});

describe('resolveGradeSetup — course creation flow', () => {
    it('creates a new course via the zero-courses bootstrap prompt', async () => {
        // No courses exist yet at all -> the "let's create one" while(!course) loop runs
        // (not the "Add new course" menu option, which only appears once >=1 course
        // already exists). The freshly created course has no labs yet, so the assignment
        // picker that follows has nothing to offer — this test only asserts the course
        // creation side effect, not a full successful run.
        writeLocalConfig(oneTermConfig());

        const driver = mockDriver(['NewCourse', '', '', ''], { strict: true });
        await expect(resolveGradeSetup(driver, opts({ argv: [] }))).rejects.toThrow();

        expect(existsSync(join(configsDir, 'NewCourse', 'course_config.json'))).toBe(true);
        expect(driver.takeNotes().some(n => n.includes('Created course'))).toBe(true);
    });
});

describe('resolveGradeSetup — driver notes survive teardown', () => {
    it('buffers a note for a saved term', async () => {
        writeCourseConfig('CS233JS');
        writeLab('CS233JS', 'Lab03');
        writeLocalConfig({}); // triggers createTerm()
        mkdirSync(join(labRootDir, 'CS233JS', 'Lab03'), { recursive: true });
        markMoodleSubmissions(join(labRootDir, 'CS233JS', 'Lab03'));

        const driver = mockDriver([
            'Spring 2026', '2026Spring', labRootDir, codeRootDir, // createTerm prompts
            '1', // mode menu
        ], { strict: true });

        await resolveGradeSetup(driver, opts({ argv: ['Lab03'] }));

        expect(driver.takeNotes().some(n => n.includes('Saved term "Spring 2026"'))).toBe(true);
    });
});
