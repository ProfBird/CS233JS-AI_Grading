/**
 * generate_render.spec.mjs
 *
 * Characterization / regression tests for generate_grades.js — specifically the
 * two rendering paths (spreadsheet and text report) and the shared compute step
 * computeResults(). These pin behavior end-to-end (build a minimal rubric, grade
 * a student, read the output back) so the "compute once, render twice" refactor
 * can be proven to preserve behavior.
 *
 * A few assertions intentionally pin a PRE-REFACTOR divergence between the two
 * paths; those are flagged inline and updated when the paths are unified.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as fs from 'fs';
import xlsx from 'xlsx';
import generateGrades, { computeResults } from '../pipeline/generate_grades.js';

// The xlsx ESM build (0.20.x) does not auto-wire Node's fs; writeFile/readFile
// throw "cannot save file" until set_fs() is called.
xlsx.set_fs(fs);

let dir;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'render-'));
    // Quiet the module's per-student console output.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Write a minimal rubric with a 'Grade' sheet spanning A1:Z200 (.xlsx or .xlsm). */
function makeRubric(name) {
    const sheet = { '!ref': 'A1:Z200' };
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, sheet, 'Grade');
    const p = join(dir, name);
    const bookType = name.toLowerCase().endsWith('.xlsm') ? 'xlsm' : 'xlsx';
    xlsx.writeFile(wb, p, { bookType });
    return p;
}

/** Run the spreadsheet path for one student and return the written Grade sheet. */
async function gradeToSheet(student, config, rubricName) {
    config.rubricName = rubricName;
    student.gradeDir = join(dir, student.name);
    const summary = await generateGrades([student], config, dir, { rubricDir: dir });
    const ext = rubricName.toLowerCase().endsWith('.xlsm') ? '.xlsm' : '.xlsx';
    const out = join(student.gradeDir, `${student.name}_Grade${ext}`);
    expect(summary.successful).toContain(student.name);
    expect(existsSync(out)).toBe(true);
    return xlsx.readFile(out).Sheets['Grade'];
}

/** Run the text-report path for one student and return the report text. */
async function gradeToText(student, config, rubricName) {
    config.rubricName = rubricName;
    student.gradeDir = join(dir, student.name);
    const summary = await generateGrades([student], config, dir, { rubricDir: dir, textReport: true });
    const out = join(student.gradeDir, `${student.name}_Grade.txt`);
    expect(summary.successful).toContain(student.name);
    return readFileSync(out, 'utf8');
}

// Cell value (or undefined if the cell was never written).
const cellVal = (sheet, ref) => (sheet[ref] ? sheet[ref].v : undefined);

// ── Spreadsheet path ───────────────────────────────────────────────────────

describe('spreadsheet path', () => {
    it('writes scores and comments for a normal submission', async () => {
        makeRubric('normal.xlsx');
        const config = {
            mappings: [
                { type: 'feature', featureId: 'arrow', maxScore: 2, cell: 'B5', commentCell: 'C5' },
                { type: 'lint', maxScore: 3, cell: 'B6', commentCell: 'C6' },
                { type: 'manual', maxScore: 1, msg: 'Check styling', cell: 'B7', commentCell: 'C7' },
            ],
            parts: [{ id: 'part1', featureCounts: [{ featureId: 'loops', maxScore: 2, cell: 'B10', commentCell: 'C10' }] }],
        };
        const student = {
            name: 'Ada',
            urls: { github: 'https://github.com/x/y' },
            extractedDir: '/tmp/x',
            analysis: { features: { arrow: 3 }, partFeatures: { part1: { loops: 2 } } },
            lint: { jsFiles: 1, errors: 0, warnings: 0, messages: [] },
            codeReview: { found: false, items: [], productionCompleted: false },
        };
        const s = await gradeToSheet(student, config, 'normal.xlsx');
        expect(cellVal(s, 'B5')).toBe(2);
        expect(cellVal(s, 'C5')).toBe('Yes (3 found)');
        expect(cellVal(s, 'B6')).toBe(3);
        expect(cellVal(s, 'C6')).toBe('Excellent - no lint issues');
        expect(cellVal(s, 'B7')).toBe(1);
        expect(cellVal(s, 'C7')).toBe('Check styling');
        expect(cellVal(s, 'B10')).toBe(2);
        expect(cellVal(s, 'C10')).toBe('Yes (2 found)');
    });

    it('writes 0 + error/NA comments for an extraction failure, incl. part cells', async () => {
        makeRubric('extr.xlsx');
        const config = {
            mappings: [
                { type: 'github_repo', maxScore: 2, cell: 'B5', commentCell: 'C5' },
                { type: 'feature', featureId: 'arrow', maxScore: 2, cell: 'B6', commentCell: 'C6' },
            ],
            parts: [{ id: 'part1', featureCounts: [{ featureId: 'loops', maxScore: 2, cell: 'B10', commentCell: 'C10' }] }],
        };
        const student = {
            name: 'Bob',
            urls: { github: 'https://github.com/x/y' },
            analysis: { extractionError: 'clone failed', features: {}, partFeatures: {} },
        };
        const s = await gradeToSheet(student, config, 'extr.xlsx');
        expect(cellVal(s, 'B5')).toBe(0);
        expect(cellVal(s, 'C5')).toBe('ERROR: clone failed');
        expect(cellVal(s, 'B6')).toBe(0);
        expect(cellVal(s, 'C6')).toBe('N/A (code unavailable)');
        expect(cellVal(s, 'B10')).toBe(0);
        expect(cellVal(s, 'C10')).toBe('N/A (code unavailable)');
    });

    it('writes an .xlsm output with scores when the rubric is .xlsm', async () => {
        makeRubric('macro.xlsm');
        const config = {
            mappings: [{ type: 'feature', featureId: 'arrow', maxScore: 2, cell: 'B5', commentCell: 'C5' }],
        };
        const student = { name: 'Xena', analysis: { features: { arrow: 1 } } };
        const s = await gradeToSheet(student, config, 'macro.xlsm');
        expect(cellVal(s, 'B5')).toBe(2);
        expect(cellVal(s, 'C5')).toBe('Yes (1 found)');
    });

    it('writes 0 (not a blank cell) when a passing mapping omits maxScore', async () => {
        makeRubric('nomax.xlsx');
        const config = {
            mappings: [{ type: 'feature', featureId: 'arrow', cell: 'B5', commentCell: 'C5' }],
        };
        const student = { name: 'Cy', analysis: { features: { arrow: 3 } } };
        const s = await gradeToSheet(student, config, 'nomax.xlsx');
        // Converged: both renderers now share computeResults' `score ?? 0` coercion,
        // so a handler that returns undefined (no maxScore configured) writes 0.
        // (Previously the spreadsheet path wrote the raw undefined -> a blank cell.)
        expect(cellVal(s, 'B5')).toBe(0);
        expect(cellVal(s, 'C5')).toBe('Yes (3 found)');
    });

    it('writes name/group only to the cells named in config.codeReview', async () => {
        makeRubric('namegroup.xlsx');
        const config = {
            codeReview: { studentNameCell: 'B1', groupCell: 'C1' },
            mappings: [{ type: 'feature', featureId: 'arrow', maxScore: 2, cell: 'B5', commentCell: 'C5' }],
        };
        const student = { name: 'Ada', analysis: { features: { arrow: 1 } }, codeReview: { group: 'B' } };
        const s = await gradeToSheet(student, config, 'namegroup.xlsx');
        expect(cellVal(s, 'B1')).toBe('Ada');
        expect(cellVal(s, 'C1')).toBe('B');
    });

    it('does not write name/group cells when config.codeReview is absent', async () => {
        makeRubric('nonamegroup.xlsx');
        const config = {
            mappings: [{ type: 'feature', featureId: 'arrow', maxScore: 2, cell: 'B5', commentCell: 'C5' }],
        };
        const student = { name: 'Ada', analysis: { features: { arrow: 1 } }, codeReview: { group: 'B' } };
        const s = await gradeToSheet(student, config, 'nonamegroup.xlsx');
        expect(cellVal(s, 'B1')).toBeUndefined();
        expect(cellVal(s, 'C1')).toBeUndefined();
    });
});

// ── Text report path ───────────────────────────────────────────────────────

describe('text report path', () => {
    it('lists each mapping with score/total for a normal submission', async () => {
        makeRubric('normal_txt.xlsx');
        const config = {
            mappings: [
                { type: 'feature', featureId: 'arrow', maxScore: 2, cell: 'B5', commentCell: 'C5' },
                { type: 'lint', maxScore: 3, cell: 'B6', commentCell: 'C6' },
            ],
            parts: [{ id: 'part1', featureCounts: [{ featureId: 'loops', maxScore: 2, cell: 'B10', commentCell: 'C10' }] }],
        };
        const student = {
            name: 'Ada',
            analysis: { features: { arrow: 3 }, partFeatures: { part1: { loops: 2 } } },
            lint: { jsFiles: 1, errors: 0, warnings: 0, messages: [] },
        };
        const txt = await gradeToText(student, config, 'normal_txt.xlsx');
        expect(txt).toContain('GRADE REPORT: Ada');
        expect(txt).toContain('arrow');
        expect(txt).toContain('loops');
        expect(txt).toContain('Total: 7 / 7');
    });

    it('includes part-feature rows (as N/A) when extraction failed', async () => {
        makeRubric('extr_txt.xlsx');
        const config = {
            mappings: [{ type: 'github_repo', maxScore: 2, cell: 'B5', commentCell: 'C5' }],
            parts: [{ id: 'part1', featureCounts: [{ featureId: 'loops', maxScore: 2, cell: 'B10', commentCell: 'C10' }] }],
        };
        const student = { name: 'Bob', urls: { github: 'g' }, analysis: { extractionError: 'clone failed', features: {}, partFeatures: {} } };
        const txt = await gradeToText(student, config, 'extr_txt.xlsx');
        // Converged: computeResults now emits part-feature rows in the extraction-error
        // case, matching what the spreadsheet path has always written. The text report
        // therefore includes 'loops' (N/A) and counts its maxScore toward the total.
        // (Previously the text path returned early and omitted part rows -> Total 0 / 2.)
        expect(txt).toContain('loops');
        expect(txt).toContain('N/A (code unavailable)');
        expect(txt).toContain('Total: 0 / 4');
    });

    it('renders analyzer-contributed reportSections generically', async () => {
        makeRubric('sections_txt.xlsx');
        const config = {
            mappings: [{ type: 'feature', featureId: 'arrow', maxScore: 2, cell: 'B5', commentCell: 'C5' }],
        };
        const student = {
            name: 'Ada',
            analysis: {
                features: { arrow: 1 },
                reportSections: [{ title: 'Custom Pipeline', lines: ['[YES]  Step 1: foo', '1/1 steps complete'] }],
            },
        };
        const txt = await gradeToText(student, config, 'sections_txt.xlsx');
        expect(txt).toContain('Custom Pipeline');
        expect(txt).toContain('[YES]  Step 1: foo');
        expect(txt).toContain('1/1 steps complete');
    });

    it('omits any custom section when reportSections is absent', async () => {
        makeRubric('nosections_txt.xlsx');
        const config = {
            mappings: [{ type: 'feature', featureId: 'arrow', maxScore: 2, cell: 'B5', commentCell: 'C5' }],
        };
        const student = { name: 'Bob', analysis: { features: { arrow: 1 } } };
        const txt = await gradeToText(student, config, 'nosections_txt.xlsx');
        expect(txt).toContain('GRADE REPORT: Bob');
        expect(txt).not.toContain('Custom Pipeline');
    });
});

// ── computeResults (shared compute) ────────────────────────────────────────

describe('computeResults', () => {
    it('coerces a null/undefined handler score to 0', async () => {
        const config = { mappings: [{ type: 'feature', featureId: 'arrow', cell: 'B5' }] };
        const results = await computeResults({ analysis: { features: { arrow: 3 } } }, config);
        expect(results[0].score).toBe(0);
        expect(results[0].comment).toBe('Yes (3 found)');
    });

    it('reports an unknown mapping type as an error with score 0', async () => {
        const config = { mappings: [{ type: 'bogus', maxScore: 2 }] };
        const results = await computeResults({ analysis: {} }, config);
        expect(results[0].score).toBe(0);
        expect(results[0].comment).toBe('ERROR: Unknown mapping type "bogus"');
    });
});
