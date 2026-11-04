/**
 * run_pipeline.spec.mjs
 *
 * Tests for the phase-list/when orchestration extracted out of bin/grade.js into
 * run_pipeline.js. Uses students with no extractedDir so each sub-phase's own
 * "no code to check" branch fires immediately — this test is about orchestration
 * (filtering, phase sequencing, log-summary assembly), not re-testing what each
 * individual phase already covers elsewhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runPipeline, filterAlreadyGraded, runPreflight, PHASES } from '../src/pipeline/run_pipeline.js';

describe('PHASES', () => {
    it('is a non-empty array of { name, run, when } entries', () => {
        expect(Array.isArray(PHASES)).toBe(true);
        expect(PHASES.length).toBeGreaterThan(0);
        for (const phase of PHASES) {
            expect(typeof phase.name).toBe('string');
            expect(typeof phase.run).toBe('function');
            expect(typeof phase.when).toBe('function');
        }
    });

    it('every phase except the web-only ones runs unconditionally (when() is always true)', () => {
        const webOnly = new Set(['validateHtml', 'validateCss', 'checkWebContent']);
        for (const phase of PHASES) {
            if (webOnly.has(phase.name)) continue;
            expect(phase.when({})).toBe(true);
            expect(phase.when({ language: 'python' })).toBe(true);
        }
    });

    it('HTML/CSS validation runs for web languages, or any lab with an html_validate/css_validate row', () => {
        for (const name of ['validateHtml', 'validateCss']) {
            const phase = PHASES.find(p => p.name === name);
            const row = name === 'validateHtml' ? 'html_validate' : 'css_validate';
            expect(phase.when({})).toBe(true);                                   // JavaScript is the default
            expect(phase.when({ language: 'typescript' })).toBe(true);
            expect(phase.when({ language: 'python' })).toBe(false);
            expect(phase.when({ language: 'python', mappings: [{ type: row }] })).toBe(true);
        }
    });

    it('checkWebContent runs only when config.webContent is present', () => {
        const phase = PHASES.find(p => p.name === 'checkWebContent');
        expect(phase.when({})).toBe(false);
        expect(phase.when({ webContent: { requiredElements: [] } })).toBe(true);
    });

    it('includes the expected built-in phase names in order', () => {
        expect(PHASES.map(p => p.name)).toEqual([
            'readCodeReview', 'resolveGroups', 'runtimeCheck', 'analyzeCode', 'lintCode',
            'validateHtml', 'validateCss', 'checkNames', 'checkWebContent',
        ]);
    });
});

describe('runPreflight', () => {
    it('does not warn for the always-available JS adapter (default language)', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await runPreflight({});
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    it('warns with an actionable hint when the configured toolchain is unavailable', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await runPreflight({ language: 'cpp', toolchains: { cpp: { compiler: 'no-such-compiler-xyz' } } });
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/cpp toolchain not available/);
        expect(warnSpy.mock.calls[0][0]).toMatch(/toolchains\.cpp\.compiler/);
        warnSpy.mockRestore();
    });
});

describe('filterAlreadyGraded', () => {
    let root;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'filtergraded-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('returns all students unfiltered when regrade is true', () => {
        const students = [{ name: 'A', gradeDir: root }];
        const { toGrade, alreadyDone } = filterAlreadyGraded(students, { rubricName: 'R.xlsx' }, { regrade: true });
        expect(toGrade).toBe(students);
        expect(alreadyDone).toEqual([]);
    });

    it('filters out a student whose .xlsx grade file already exists', () => {
        const gradeDir = join(root, 'Ada');
        mkdirSync(gradeDir, { recursive: true });
        writeFileSync(join(gradeDir, 'Ada_Grade.xlsx'), 'x');
        const students = [{ name: 'Ada', gradeDir }, { name: 'Newbie', gradeDir: join(root, 'Newbie') }];
        const { toGrade, alreadyDone } = filterAlreadyGraded(students, { rubricName: 'R.xlsx' }, { regrade: false, textReport: false });
        expect(alreadyDone).toEqual(['Ada']);
        expect(toGrade.map(s => s.name)).toEqual(['Newbie']);
    });

    it('checks for .txt grade files when textReport is set', () => {
        const gradeDir = join(root, 'Ada');
        mkdirSync(gradeDir, { recursive: true });
        writeFileSync(join(gradeDir, 'Ada_Grade.txt'), 'x');
        const students = [{ name: 'Ada', gradeDir }];
        const { toGrade, alreadyDone } = filterAlreadyGraded(students, { rubricName: 'R.xlsx' }, { regrade: false, textReport: true });
        expect(alreadyDone).toEqual(['Ada']);
        expect(toGrade).toEqual([]);
    });

    it('keeps a student with no gradeDir (nothing to check against)', () => {
        const students = [{ name: 'NoGradeDir' }];
        const { toGrade, alreadyDone } = filterAlreadyGraded(students, { rubricName: 'R.xlsx' }, { regrade: false, textReport: false });
        expect(alreadyDone).toEqual([]);
        expect(toGrade).toEqual(students);
    });
});

describe('runPipeline — orchestration with no extracted code', () => {
    let root, artifactsDir, labConfigDir;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'runpipeline-'));
        artifactsDir = join(root, 'Artifacts');
        labConfigDir = join(root, 'config');
        mkdirSync(artifactsDir, { recursive: true });
        mkdirSync(labConfigDir, { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('runs all phases, skips generation, and writes a grading log summary', async () => {
        const students = [
            { name: 'Extracted', error: 'Failed to clone GitHub repository' },
        ];
        const config = { runtimeCheck: 'build', mappings: [] };
        const result = await runPipeline(
            students, config,
            { artifactsDir, labConfigDir },
            { regrade: true, skipRubric: true, textReport: false, labName: 'TestLab', modeLabel: 'NORMAL' }
        );

        expect(result.successful).toEqual([]);
        expect(result.errors.some(e => e.student === 'Extracted' && /Extraction/.test(e.issue))).toBe(true);

        const logPath = join(artifactsDir, 'grading_log.txt');
        expect(existsSync(logPath)).toBe(true);
        const logContent = readFileSync(logPath, 'utf8');
        expect(logContent).toContain('Grading Summary for TestLab [NORMAL]');
        expect(logContent).toContain('Extracted: Extraction: Failed to clone GitHub repository');
    });

    it('writes per-phase artifact reports into artifactsDir', async () => {
        const students = [{ name: 'NoCode' }];
        const config = { runtimeCheck: 'build', mappings: [] };
        await runPipeline(
            students, config,
            { artifactsDir, labConfigDir },
            { regrade: true, skipRubric: true, textReport: false, labName: 'TestLab', modeLabel: 'NORMAL' }
        );

        for (const report of ['runtime_report.json', 'analysis_report.json', 'lint_report.json', 'name_check_report.json']) {
            expect(existsSync(join(artifactsDir, report)), report).toBe(true);
        }
    });
});
