/**
 * multi_step_integration.spec.mjs
 *
 * Integration test for the multi-step lab layout (configs/{AssignmentName}/{StepName}/,
 * see CLAUDE.md's "Multi-step lab" section) — the most config-sensitive real workflow
 * (TermProject), per refactoring_plan_2026-07-07.md Priority 7. Builds a scratch
 * configs/ tree with two step subdirs, confirms getExistingSteps() detects both, then
 * runs runPipeline() once per step (mirroring how bin/grade.js resolves dirs/options
 * per step) and asserts each step's Artifacts/grade output lands in its own directory
 * without leaking into the sibling step's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { getExistingSteps, getExistingCourses, readCourseConfig, writeCourseConfig } from '../src/lib/lab_config.js';
import { runPipeline } from '../src/pipeline/run_pipeline.js';

describe('multi-step lab layout — getExistingSteps + runPipeline integration', () => {
    let configsRoot, codeRoot;
    const LAB = 'TermProject';
    const STEPS = ['ApiDoc', 'Beta'];

    beforeEach(() => {
        configsRoot = mkdtempSync(join(tmpdir(), 'msconfigs-'));
        codeRoot = mkdtempSync(join(tmpdir(), 'mscode-'));
        for (const step of STEPS) {
            const stepConfigDir = join(configsRoot, LAB, step);
            mkdirSync(stepConfigDir, { recursive: true });
            writeFileSync(join(stepConfigDir, `${step.toLowerCase()}_config.json`), JSON.stringify({
                runtimeCheck: 'browser',
                mappings: [{ type: 'manual', maxScore: 5, msg: `Review ${step}`, cell: 'B2', commentCell: 'C2' }],
            }));
        }
    });

    afterEach(() => {
        rmSync(configsRoot, { recursive: true, force: true });
        rmSync(codeRoot, { recursive: true, force: true });
    });

    it('getExistingSteps detects both step subdirs, sorted', () => {
        expect(getExistingSteps(LAB, configsRoot)).toEqual(['ApiDoc', 'Beta']);
    });

    it('running the pipeline for one step writes only into that step\'s Artifacts dir', async () => {
        const stepName = 'ApiDoc';
        const labConfigDir = join(configsRoot, LAB, stepName);
        const config = JSON.parse(readFileSync(join(labConfigDir, 'apidoc_config.json'), 'utf8'));

        const artifactsDir = join(codeRoot, LAB, stepName, 'Artifacts');
        const gradeDir = join(codeRoot, LAB, stepName, 'SubmissionsAndAssessment', 'Ada');
        mkdirSync(artifactsDir, { recursive: true });
        mkdirSync(gradeDir, { recursive: true });

        const students = [{ name: 'Ada', gradeDir, analysis: {} }];

        await runPipeline(
            students, config,
            { artifactsDir, labConfigDir },
            { regrade: true, skipRubric: false, textReport: true, labName: LAB, stepName, modeLabel: 'NORMAL' }
        );

        // This step's own Artifacts dir got the log + reports.
        expect(existsSync(join(artifactsDir, 'grading_log.txt'))).toBe(true);
        expect(existsSync(join(artifactsDir, 'lint_report.json'))).toBe(true);
        // This step's own student got a text grade report.
        expect(existsSync(join(gradeDir, 'Ada_Grade.txt'))).toBe(true);

        // The sibling step's directory tree was never created/touched.
        const siblingArtifacts = join(codeRoot, LAB, 'Beta', 'Artifacts');
        expect(existsSync(siblingArtifacts)).toBe(false);
    });

    it('grading two steps back-to-back keeps each step\'s output fully isolated', async () => {
        const results = {};
        for (const stepName of STEPS) {
            const labConfigDir = join(configsRoot, LAB, stepName);
            const config = JSON.parse(readFileSync(join(labConfigDir, `${stepName.toLowerCase()}_config.json`), 'utf8'));

            const artifactsDir = join(codeRoot, LAB, stepName, 'Artifacts');
            const gradeDir = join(codeRoot, LAB, stepName, 'SubmissionsAndAssessment', 'Student');
            mkdirSync(artifactsDir, { recursive: true });
            mkdirSync(gradeDir, { recursive: true });

            await runPipeline(
                [{ name: 'Student', gradeDir, analysis: {} }], config,
                { artifactsDir, labConfigDir },
                { regrade: true, skipRubric: false, textReport: true, labName: LAB, stepName, modeLabel: 'NORMAL' }
            );

            results[stepName] = readFileSync(join(gradeDir, 'Student_Grade.txt'), 'utf8');
        }

        // Each step's mapping msg ("Review ApiDoc" / "Review Beta") only shows up in its
        // own step's report — proves the per-step config (not a leaked/shared one) was used.
        expect(results.ApiDoc).toContain('Review ApiDoc');
        expect(results.ApiDoc).not.toContain('Review Beta');
        expect(results.Beta).toContain('Review Beta');
        expect(results.Beta).not.toContain('Review ApiDoc');
    });
});

// ── Course tier ──────────────────────────────────────────────────────────
// bin/grade.js and bin/configure-lab.js now root every config-side path at
// configs/{Course}/ (getExistingCourses) rather than configs/ directly. These tests build
// the real nested layout (configs/{Course}/{Lab}/{Step}/...) and confirm course discovery
// composes correctly with the existing step-detection covered above.
describe('course tier — getExistingCourses + nested step layout', () => {
    let configsRoot;
    const COURSE = 'CS233JS';
    const LAB = 'TermProject';
    const STEPS = ['ApiDoc', 'Beta'];

    beforeEach(() => {
        configsRoot = mkdtempSync(join(tmpdir(), 'msconfigs-course-'));
        for (const step of STEPS) {
            const stepConfigDir = join(configsRoot, COURSE, LAB, step);
            mkdirSync(stepConfigDir, { recursive: true });
            writeFileSync(join(stepConfigDir, `${step.toLowerCase()}_config.json`), JSON.stringify({
                runtimeCheck: 'browser',
                mappings: [{ type: 'manual', maxScore: 5, msg: `Review ${step}`, cell: 'B2', commentCell: 'C2' }],
            }));
        }
    });

    afterEach(() => rmSync(configsRoot, { recursive: true, force: true }));

    it('is discovered even with no course_config.json yet (pre-migration tolerance)', () => {
        const courses = getExistingCourses(configsRoot);
        expect(courses).toHaveLength(1);
        expect(courses[0]).toMatchObject({
            name: COURSE,
            courseName: COURSE,   // defaults to the directory name when course_config.json is absent
            courseCode: COURSE,
            rubricPrefix: COURSE,
            canvasCourseId: null,
        });
    });

    it('reads courseName/rubricPrefix/canvasCourseId from course_config.json when present', () => {
        writeCourseConfig(join(configsRoot, COURSE), {
            courseName: 'Web Dev with JS',
            courseCode: 'CS233JS',
            rubricPrefix: 'CS233JS',
            canvasCourseId: 680,
        });

        const courses = getExistingCourses(configsRoot);
        expect(courses).toHaveLength(1);
        expect(courses[0]).toMatchObject({
            name: COURSE,
            courseName: 'Web Dev with JS',
            canvasCourseId: 680,
        });
        expect(readCourseConfig(join(configsRoot, COURSE)).courseName).toBe('Web Dev with JS');
    });

    it('a directory with neither course_config.json nor any assignment config is not a course', () => {
        mkdirSync(join(configsRoot, 'not-a-course'), { recursive: true });
        const courses = getExistingCourses(configsRoot);
        expect(courses.map(c => c.name)).toEqual([COURSE]);
    });

    it('getExistingSteps composes with the course-scoped dir exactly like the flat-configs case above', () => {
        const course = getExistingCourses(configsRoot)[0];
        expect(getExistingSteps(LAB, course.path)).toEqual(['ApiDoc', 'Beta']);
    });
});
