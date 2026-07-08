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

import { getExistingSteps } from '../src/lib/lab_config.js';
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
