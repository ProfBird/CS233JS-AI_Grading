/**
 * create_lab.spec.mjs
 *
 * Unit tests for the lab configuration creation wizard's pure functions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const {
    colLetter, excelCell, normalizeAssignmentName, cellText, isBlankRow,
    readRubricRows, readRubricCriteria, buildConfig, writeLab,
    findSpreadsheets, keywordsToFolderPattern, guessMappingType,
} = await import('../lib/lab_config.js');

const {
    askBoolean, askOptions, ask, askInt,
    buildMappingEntry, promptFeatures, copyRubric, promptRubricRows,
} = await import('../bin/create_lab.js');

const {
    heuristicDraft, mergeLLMResponse, guardFeatureType, findCriteria, printDraftTable,
} = await import('../bin/configure_lab.js');

const TERM_RUBRIC = join(import.meta.dirname, '..', 'configs', 'TermProject',
    'DevEnvAndStaticSite', 'CS233JS_TermProjectDevEnv_Rubric.xlsm');
const LAB04_RUBRIC = join(import.meta.dirname, '..', 'configs', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');

// ── mock rl factory ─────────────────────────────────────────────────────

function mockRL(answers) {
    const answersClone = [...answers];
    return {
        _getLine(_prompt) {
            const val = answersClone.shift();
            if (val === undefined) return Promise.resolve(null);
            return Promise.resolve(val);
        }
    };
}

// ── colLetter ───────────────────────────────────────────────────────────

describe('colLetter', () => {
    it('returns A for index 0', () => {
        expect(colLetter(0)).toBe('A');
    });
    it('returns C for index 2', () => {
        expect(colLetter(2)).toBe('C');
    });
    it('returns Z for index 25', () => {
        expect(colLetter(25)).toBe('Z');
    });
    it('returns AA for index 26 (first two-letter column)', () => {
        expect(colLetter(26)).toBe('AA');
    });
    it('returns AZ for index 51', () => {
        expect(colLetter(51)).toBe('AZ');
    });
    it('returns BA for index 52', () => {
        expect(colLetter(52)).toBe('BA');
    });
    it('returns E for index 4', () => {
        expect(colLetter(4)).toBe('E');
    });
});

// ── excelCell ───────────────────────────────────────────────────────────

describe('excelCell', () => {
    it('builds C7 from col 2, row 7', () => {
        expect(excelCell(2, 7)).toBe('C7');
    });
    it('builds A1 from col 0, row 1', () => {
        expect(excelCell(0, 1)).toBe('A1');
    });
    it('builds E15 from col 4, row 15', () => {
        expect(excelCell(4, 15)).toBe('E15');
    });
});

// ── normalizeAssignmentName ────────────────────────────────────────────

describe('normalizeAssignmentName', () => {
    it('parses "7" → Lab07', () => {
        expect(normalizeAssignmentName('7')).toBe('Lab07');
    });
    it('parses "07" → Lab07', () => {
        expect(normalizeAssignmentName('07')).toBe('Lab07');
    });
    it('parses "Lab7" → Lab07', () => {
        expect(normalizeAssignmentName('Lab7')).toBe('Lab07');
    });
    it('parses "Lab07" → Lab07', () => {
        expect(normalizeAssignmentName('Lab07')).toBe('Lab07');
    });
    it('parses "lab03" → Lab03', () => {
        expect(normalizeAssignmentName('lab03')).toBe('Lab03');
    });
    it('parses "Lab99" → Lab99', () => {
        expect(normalizeAssignmentName('Lab99')).toBe('Lab99');
    });
    it('parses "10" → Lab10', () => {
        expect(normalizeAssignmentName('10')).toBe('Lab10');
    });
    it('parses "123" → Lab123', () => {
        expect(normalizeAssignmentName('123')).toBe('Lab123');
    });
    it('accepts "TermProject" as-is', () => {
        expect(normalizeAssignmentName('TermProject')).toBe('TermProject');
    });
    it('accepts "FinalExam" as-is', () => {
        expect(normalizeAssignmentName('FinalExam')).toBe('FinalExam');
    });
    it('accepts "Midterm_2" as-is', () => {
        expect(normalizeAssignmentName('Midterm_2')).toBe('Midterm_2');
    });
    it('returns null for empty string', () => {
        expect(normalizeAssignmentName('')).toBeNull();
    });
    it('returns null for string with spaces', () => {
        expect(normalizeAssignmentName('Term Project')).toBeNull();
    });
    it('returns null for string starting with a digit (non-numeric)', () => {
        expect(normalizeAssignmentName('1abc')).toBeNull();
    });
});

// ── cellText ─────────────────────────────────────────────────────────────

describe('cellText', () => {
    it('extracts text from a row at given index', () => {
        expect(cellText(['Label', '5', '3', ''], 0)).toBe('Label');
    });
    it('handles null cell', () => {
        expect(cellText([null, 'x'], 0)).toBe('');
    });
    it('handles undefined cell', () => {
        expect(cellText([undefined], 0)).toBe('');
    });
    it('trims whitespace', () => {
        expect(cellText(['  hello  '], 0)).toBe('hello');
    });
    it('returns empty string for missing index', () => {
        expect(cellText(['a'], 5)).toBe('');
    });
});

// ── isBlankRow ──────────────────────────────────────────────────────────

describe('isBlankRow', () => {
    it('returns true for row of empty strings', () => {
        expect(isBlankRow(['', '', ''])).toBe(true);
    });
    it('returns true for row with nulls', () => {
        expect(isBlankRow([null, null, null])).toBe(true);
    });
    it('returns true for row with undefined', () => {
        expect(isBlankRow([undefined, undefined])).toBe(true);
    });
    it('returns false if any cell has content', () => {
        expect(isBlankRow(['', 'x', ''])).toBe(false);
    });
    it('returns false for row with number 0', () => {
        expect(isBlankRow([0, '', ''])).toBe(false);
    });
    it('returns true for empty array', () => {
        expect(isBlankRow([])).toBe(true);
    });
});

// ── readRubricRows ──────────────────────────────────────────────────────

describe('readRubricRows', () => {
    it('reads Grade sheet from a real rubric and returns structured rows', () => {
        const rubricPath = join(import.meta.dirname, '..', 'configs', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');
        const rows = readRubricRows(rubricPath);

        expect(rows).not.toBeNull();
        expect(rows.length).toBeGreaterThan(0);

        // Each row should have the expected shape
        const first = rows[0];
        expect(first).toHaveProperty('excelRow');
        expect(first).toHaveProperty('label');
        expect(first).toHaveProperty('possible');
        expect(first).toHaveProperty('scoreCell');
        expect(first).toHaveProperty('commentCell');
        expect(first).toHaveProperty('isSectionHeader');

        // Score cells should be in C column (col 2)
        for (const r of rows) {
            expect(r.scoreCell).toMatch(/^C\d+$/);
        }
        // Comment cells should be in E column (col 4)
        for (const r of rows) {
            expect(r.commentCell).toMatch(/^E\d+$/);
        }
    });

    it('returns null for non-existent file', () => {
        const result = readRubricRows('/nonexistent/path.xlsx');
        expect(result).toBeNull();
    });

    it('skips total/sub-total rows', () => {
        const rubricPath = join(import.meta.dirname, '..', 'configs', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');
        const rows = readRubricRows(rubricPath);
        const labels = rows.map(r => r.label.toLowerCase());
        for (const label of labels) {
            expect(label).not.toMatch(/^total/);
            expect(label).not.toMatch(/^sub-total/);
        }
    });

    it('marks section headers correctly', () => {
        const rubricPath = join(import.meta.dirname, '..', 'configs', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');
        const rows = readRubricRows(rubricPath);
        const sectionHeaders = rows.filter(r => r.isSectionHeader);
        // Lab04 has at least one section header
        expect(sectionHeaders.length).toBeGreaterThan(0);
        // Section headers have empty possible/actual/comment
        for (const h of sectionHeaders) {
            expect(h.possible).toBe('');
        }
    });
});

// ── readRubricRows (custom header) ──────────────────────────────────────

describe('readRubricRows — custom headerLabel', () => {
    const realRubric = join(import.meta.dirname, '..', 'configs', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');

    it('succeeds with the default label (case-insensitive)', () => {
        expect(readRubricRows(realRubric)).not.toBeNull();
        expect(readRubricRows(realRubric, 'Possible')).not.toBeNull();
        expect(readRubricRows(realRubric, 'POSSIBLE')).not.toBeNull();
    });

    it('returns null for a wrong header label', () => {
        expect(readRubricRows(realRubric, 'MaxPoints')).toBeNull();
    });
});

// ── stock comments (new rubric format) ──────────────────────────────────

describe('readRubricRows — stock comments', () => {
    it('attaches per-row stockComments when the Grade sheet has them', () => {
        const rows = readRubricRows(TERM_RUBRIC);
        const withStock = rows.filter(r => r.stockComments);
        expect(withStock.length).toBeGreaterThan(0);

        const indexHtml = rows.find(r => r.label === 'index.html');
        expect(indexHtml.stockComments).toEqual({ full: 'Good', partial: 'Errors', zero: 'Missing' });
    });

    it('never attaches stockComments to section headers', () => {
        const rows = readRubricRows(TERM_RUBRIC);
        for (const r of rows.filter(r => r.isSectionHeader)) {
            expect(r.stockComments).toBeUndefined();
        }
    });

    it('omits stockComments entirely when the rubric has no stock columns', () => {
        const rows = readRubricRows(LAB04_RUBRIC);
        expect(rows.every(r => r.stockComments === undefined)).toBe(true);
    });
});

// ── readRubricCriteria ──────────────────────────────────────────────────

describe('readRubricCriteria', () => {
    it('returns label/points/criteria entries from the Rubric sheet', () => {
        const crit = readRubricCriteria(TERM_RUBRIC);
        expect(crit.length).toBeGreaterThan(0);
        const first = crit[0];
        expect(first).toHaveProperty('label');
        expect(first).toHaveProperty('points');
        expect(first).toHaveProperty('criteria');
        expect(first.criteria).toMatch(/free of errors/i);
    });

    it('returns [] when no Criteria column / no Rubric sheet exists', () => {
        expect(readRubricCriteria(LAB04_RUBRIC)).toEqual([]);
    });

    it('returns [] for a non-existent file', () => {
        expect(readRubricCriteria('/nonexistent/path.xlsm')).toEqual([]);
    });
});

// ── promptRubricRows ────────────────────────────────────────────────────

describe('promptRubricRows', () => {
    const realRubric = join(import.meta.dirname, '..', 'configs', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');

    it('returns rows when default header is found and user confirms columns', async () => {
        const rl = mockRL(['']);  // empty = accept default (Y) for "Are these columns correct?"
        const rows = await promptRubricRows(rl, realRubric);
        expect(rows).not.toBeNull();
        expect(rows.length).toBeGreaterThan(0);
    });

    it('returns null when rubric is unreadable and user leaves alternative blank', async () => {
        const rl = mockRL(['']);
        expect(await promptRubricRows(rl, '/nonexistent/rubric.xlsx')).toBeNull();
    });
});

// ── buildConfig ─────────────────────────────────────────────────────────

describe('buildConfig', () => {
    it('builds a minimal config with rubric name and runtime', () => {
        const config = buildConfig('Lab99', {
            rubricName: 'CS233JS_Lab99_Rubric.xlsm',
            titleText: 'Lab 99: Test',
            runtimeCheck: 'browser',
            features: [],
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: null,
            optional: {}
        });

        expect(config.rubricName).toBe('CS233JS_Lab99_Rubric.xlsm');
        expect(config.titleText).toBe('Lab 99: Test');
        expect(config.runtimeCheck).toBe('browser');
        expect(config.mappings).toEqual([]);
    });

    it('includes optional fields when provided', () => {
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'both',
            features: [],
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: null,
            optional: {
                titleCell: 'A1',
                summaryCell: 'A2',
                graderCell: 'E1',
                codeReview: { studentNameCell: 'B1', groupCell: 'C1' },
                lintExclude: ['node_modules', 'dist']
            }
        });

        expect(config.titleCell).toBe('A1');
        expect(config.summaryCell).toBe('A2');
        expect(config.graderCell).toBe('E1');
        expect(config.codeReview).toEqual({ studentNameCell: 'B1', groupCell: 'C1' });
        expect(config.lint).toEqual({ exclude: ['node_modules', 'dist'] });
    });

    it('omits analysis section when no features, parts, or analyzer', () => {
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'build',
            features: [],
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: null,
            optional: {}
        });
        expect(config.analysis).toBeUndefined();
    });

    it('includes analysis.features when features array has entries', () => {
        const features = [{ id: 'fetch_api', regex: 'fetch\\s*\\(' }];
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'browser',
            features,
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: null,
            optional: {}
        });
        expect(config.analysis).toBeDefined();
        expect(config.analysis.features).toEqual(features);
    });

    it('includes analysis.customAnalyzer when set', () => {
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'browser',
            features: [],
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: 'lab99_analyzer.js',
            optional: {}
        });
        expect(config.analysis.customAnalyzer).toBe('lab99_analyzer.js');
    });

    it('includes variations when provided', () => {
        const variations = {
            A: { appName: 'Foo Game' },
            B: { appName: 'Bar Game' }
        };
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'browser',
            features: [],
            mappings: [],
            parts: null,
            variations,
            analyzerName: null,
            optional: {}
        });
        expect(config.variations).toEqual(variations);
    });

    it('includes packageCheck when provided', () => {
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'browser',
            features: [],
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: null,
            optional: {
                packageCheck: { dependencies: ['lit-html'], devDependencies: ['vite'] }
            }
        });
        expect(config.packageCheck).toEqual({ dependencies: ['lit-html'], devDependencies: ['vite'] });
    });

    it('includes repoHygiene when provided', () => {
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'browser',
            features: [],
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: null,
            optional: {
                repoHygiene: { excludedFromRepo: ['node_modules', 'dist'] }
            }
        });
        expect(config.repoHygiene).toEqual({ excludedFromRepo: ['node_modules', 'dist'] });
    });

    it('includes analysis.parts when provided', () => {
        const parts = [{ id: 'part1', rubricName: 'Part1/CS233JS_Lab99_Part1_Rubric.xlsm' }];
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'browser',
            features: [],
            mappings: [],
            parts,
            variations: null,
            analyzerName: null,
            optional: {}
        });
        expect(config.analysis.parts).toEqual(parts);
    });

    it('omits falsy optional fields', () => {
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: '',
            runtimeCheck: 'browser',
            features: [],
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: null,
            optional: {
                titleCell: '',
                summaryCell: null,
                graderCell: undefined,
                codeReview: null
            }
        });
        expect(config.titleText).toBeUndefined();
        expect(config.titleCell).toBeUndefined();
        expect(config.summaryCell).toBeUndefined();
        expect(config.graderCell).toBeUndefined();
        expect(config.codeReview).toBeUndefined();
    });

    it('does not add lint section when no excludes provided', () => {
        const config = buildConfig('Lab99', {
            rubricName: 'r.xlsm',
            titleText: 'T',
            runtimeCheck: 'browser',
            features: [],
            mappings: [],
            parts: null,
            variations: null,
            analyzerName: null,
            optional: { lintExclude: null }
        });
        expect(config.lint).toBeUndefined();
    });
});

// ── askBoolean ──────────────────────────────────────────────────────────

describe('askBoolean', () => {
    it('returns true for "y"', async () => {
        const rl = mockRL(['y']);
        expect(await askBoolean(rl, 'Q?', false)).toBe(true);
    });

    it('returns true for "yes"', async () => {
        const rl = mockRL(['yes']);
        expect(await askBoolean(rl, 'Q?', false)).toBe(true);
    });

    it('returns true for "Y" (case insensitive)', async () => {
        const rl = mockRL(['Y']);
        expect(await askBoolean(rl, 'Q?', false)).toBe(true);
    });

    it('returns false for "n"', async () => {
        const rl = mockRL(['n']);
        expect(await askBoolean(rl, 'Q?', false)).toBe(false);
    });

    it('returns false for "no"', async () => {
        const rl = mockRL(['no']);
        expect(await askBoolean(rl, 'Q?', false)).toBe(false);
    });

    it('returns defaultYes on empty input', async () => {
        const rl = mockRL(['']);
        expect(await askBoolean(rl, 'Q?', true)).toBe(true);
    });

    it('returns defaultNo on empty input', async () => {
        const rl = mockRL(['']);
        expect(await askBoolean(rl, 'Q?', false)).toBe(false);
    });

    it('retries on invalid input then accepts valid', async () => {
        const rl = mockRL(['invalid', 'maybe', 'y']);
        expect(await askBoolean(rl, 'Q?', false)).toBe(true);
    });

    it('throws on null (EOF) from ask', async () => {
        const rl = mockRL([null]);
        await expect(askBoolean(rl, 'Q?', true)).rejects.toThrow('ended unexpectedly');
    });
});

// ── askOptions ──────────────────────────────────────────────────────────

describe('askOptions', () => {
    const opts = [
        { label: 'alpha', value: 'a' },
        { label: 'beta', value: 'b', desc: 'Second option' },
        { label: 'gamma', value: 'g' }
    ];

    it('returns first option value on empty input', async () => {
        const rl = mockRL(['']);
        expect(await askOptions(rl, 'Pick:', opts)).toBe('a');
    });

    it('returns selected option by number', async () => {
        const rl = mockRL(['2']);
        expect(await askOptions(rl, 'Pick:', opts)).toBe('b');
    });

    it('returns third option for "3"', async () => {
        const rl = mockRL(['3']);
        expect(await askOptions(rl, 'Pick:', opts)).toBe('g');
    });

    it('retries on invalid number then accepts valid', async () => {
        const rl = mockRL(['5', '0', '2']);
        expect(await askOptions(rl, 'Pick:', opts)).toBe('b');
    });

    it('retries on non-numeric input then accepts valid', async () => {
        const rl = mockRL(['beta', '1']);
        expect(await askOptions(rl, 'Pick:', opts)).toBe('a');
    });

    it('throws on null (EOF) from ask', async () => {
        const rl = mockRL([null]);
        await expect(askOptions(rl, 'Pick:', opts)).rejects.toThrow('ended unexpectedly');
    });
});

// ── ask ─────────────────────────────────────────────────────────────────

describe('ask', () => {
    it('returns trimmed answer', async () => {
        const rl = mockRL(['  hello world  ']);
        expect(await ask(rl, 'Q:')).toBe('hello world');
    });

    it('returns empty string for empty answer', async () => {
        const rl = mockRL(['']);
        expect(await ask(rl, 'Q:')).toBe('');
    });

    it('throws on null (EOF)', async () => {
        const rl = mockRL([null]);
        await expect(ask(rl, 'Q:')).rejects.toThrow('ended unexpectedly');
    });
});

// ── buildMappingEntry ───────────────────────────────────────────────────

describe('buildMappingEntry', () => {
    const rubricRow = { scoreCell: 'C8', commentCell: 'E8', label: 'Test' };
    const rubricRowNoComment = { scoreCell: 'C10', commentCell: '', label: 'No Comment' };

    it('builds a feature mapping entry', async () => {
        const rl = mockRL(['my_feature', '5', '2', 'Found', 'Not found']);
        const result = await buildMappingEntry(rl, 'feature', rubricRow);

        expect(result).toEqual({
            type: 'feature',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 5,
            featureId: 'my_feature',
            minCount: 2,
            successMsg: 'Found',
            failMsg: 'Not found'
        });
    });

    it('returns null for feature with empty id', async () => {
        const rl = mockRL(['']);
        const result = await buildMappingEntry(rl, 'feature', rubricRow);
        expect(result).toBeNull();
    });

    it('uses defaults for feature minCount/successMsg/failMsg', async () => {
        const rl = mockRL(['feat', '3', '', '', '']);
        const result = await buildMappingEntry(rl, 'feature', rubricRow);

        expect(result.minCount).toBe(1);
        expect(result.successMsg).toBe('Yes');
        expect(result.failMsg).toBe('Missing');
    });

    it('builds a manual mapping entry', async () => {
        const rl = mockRL(['10', 'Needs review']);
        const result = await buildMappingEntry(rl, 'manual', rubricRow);

        expect(result).toEqual({
            type: 'manual',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 10,
            msg: 'Needs review'
        });
    });

    it('manual uses default message on empty', async () => {
        const rl = mockRL(['5', '']);
        const result = await buildMappingEntry(rl, 'manual', rubricRow);
        expect(result.msg).toBe('NEEDS MANUAL CHECK');
    });

    it('builds a lint mapping entry with severity', async () => {
        const rl = mockRL(['2', '2']); // maxScore=2, severity=2 (warnings)
        const result = await buildMappingEntry(rl, 'lint', rubricRow);

        expect(result).toEqual({
            type: 'lint',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 2,
            severity: 'warnings'
        });
    });

    it('builds a lint entry with errors severity (option 1)', async () => {
        const rl = mockRL(['1', '']);
        const result = await buildMappingEntry(rl, 'lint', rubricRow);
        expect(result.severity).toBe('errors');
    });

    it('omits commentCell when empty', async () => {
        const rl = mockRL(['3']);
        const result = await buildMappingEntry(rl, 'build_check', rubricRowNoComment);
        expect(result.type).toBe('build_check');
        expect(result.cell).toBe('C10');
        expect(result.maxScore).toBe(3);
        expect(result.commentCell).toBeUndefined();
    });

    it('builds a deploy_check entry', async () => {
        const rl = mockRL(['4']);
        const result = await buildMappingEntry(rl, 'deploy_check', rubricRow);
        expect(result).toEqual({
            type: 'deploy_check',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 4,
            urlType: 'citstudent'
        });
    });

    it('builds a url_check entry', async () => {
        const rl = mockRL(['4']);
        const result = await buildMappingEntry(rl, 'url_check', rubricRow);
        expect(result).toEqual({
            type: 'url_check',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 4,
            urlType: 'citstudent'
        });
    });

    it('builds a github_repo entry', async () => {
        const rl = mockRL(['2', 'F20']);
        const result = await buildMappingEntry(rl, 'github_repo', rubricRow);
        expect(result).toEqual({
            type: 'github_repo',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 2,
            linkUrlType: 'github',
            linkCell: 'F20'
        });
    });

    it('github_repo omits linkCell when empty', async () => {
        const rl = mockRL(['3', '']);
        const result = await buildMappingEntry(rl, 'github_repo', rubricRow);
        expect(result.linkCell).toBeUndefined();
    });

    it('builds generic entry for build_check', async () => {
        const rl = mockRL(['1']);
        const result = await buildMappingEntry(rl, 'build_check', rubricRow);
        expect(result).toEqual({
            type: 'build_check',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 1
        });
    });

    it('builds generic entry for browser_check', async () => {
        const rl = mockRL(['1']);
        const result = await buildMappingEntry(rl, 'browser_check', rubricRow);
        expect(result.type).toBe('browser_check');
        expect(result.cell).toBe('C8');
        expect(result.maxScore).toBe(1);
    });

    it('builds generic entry for code_review', async () => {
        const rl = mockRL(['2']);
        const result = await buildMappingEntry(rl, 'code_review', rubricRow);
        expect(result).toEqual({
            type: 'code_review',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 2
        });
    });

    it('builds generic entry for package_check', async () => {
        const rl = mockRL(['3']);
        const result = await buildMappingEntry(rl, 'package_check', rubricRow);
        expect(result).toEqual({
            type: 'package_check',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 3
        });
    });

    it('builds generic entry for repo_hygiene', async () => {
        const rl = mockRL(['1']);
        const result = await buildMappingEntry(rl, 'repo_hygiene', rubricRow);
        expect(result.type).toBe('repo_hygiene');
        expect(result.maxScore).toBe(1);
    });

    it('builds generic entry for developer_comments', async () => {
        const rl = mockRL(['1']);
        const result = await buildMappingEntry(rl, 'developer_comments', rubricRow);
        expect(result.type).toBe('developer_comments');
    });

    it('builds generic entry for part_completed', async () => {
        const rl = mockRL(['10']);
        const result = await buildMappingEntry(rl, 'part_completed', rubricRow);
        expect(result.type).toBe('part_completed');
        expect(result.maxScore).toBe(10);
    });

    it('builds generic entry for apps_in_repo', async () => {
        const rl = mockRL(['10']);
        const result = await buildMappingEntry(rl, 'apps_in_repo', rubricRow);
        expect(result.type).toBe('apps_in_repo');
    });

    it('builds generic entry for npm_package', async () => {
        const rl = mockRL(['3']);
        const result = await buildMappingEntry(rl, 'npm_package', rubricRow);
        expect(result.type).toBe('npm_package');
    });

    it('re-prompts on non-numeric maxScore then accepts valid input', async () => {
        const rl = mockRL(['abc', '5']);
        const result = await buildMappingEntry(rl, 'build_check', rubricRow);
        expect(result.maxScore).toBe(5);
    });
});

// ── askInt ──────────────────────────────────────────────────────────────

describe('askInt', () => {
    it('returns integer on valid input', async () => {
        const rl = mockRL(['7']);
        expect(await askInt(rl, 'N: ', 0)).toBe(7);
    });

    it('returns default on empty input', async () => {
        const rl = mockRL(['']);
        expect(await askInt(rl, 'N: ', 3)).toBe(3);
    });

    it('returns 0 default on empty when default is 0', async () => {
        const rl = mockRL(['']);
        expect(await askInt(rl, 'N: ', 0)).toBe(0);
    });

    it('re-prompts on non-numeric input then accepts valid', async () => {
        const rl = mockRL(['abc', 'xyz', '10']);
        expect(await askInt(rl, 'N: ', 0)).toBe(10);
    });

    it('throws on EOF while waiting for valid input', async () => {
        const rl = mockRL(['abc']);
        await expect(askInt(rl, 'N: ', 0)).rejects.toThrow('ended unexpectedly');
    });
});

// ── promptFeatures ──────────────────────────────────────────────────────

describe('promptFeatures', () => {
    it('returns empty array when user declines to add features', async () => {
        const rl = mockRL(['n']);
        const result = await promptFeatures(rl);
        expect(result).toEqual([]);
    });

    it('adds a feature with id and regex', async () => {
        const rl = mockRL(['y', 'fetch_api', 'fetch\\s*\\(', '', 'n']);
        const result = await promptFeatures(rl);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({ id: 'fetch_api', regex: 'fetch\\s*\\(' });
    });

    it('includes fileRegex when provided', async () => {
        const rl = mockRL(['y', 'my_feat', '\\.test\\(', '\\.js$', 'n']);
        const result = await promptFeatures(rl);
        expect(result[0].fileRegex).toBe('\\.js$');
    });

    it('omits fileRegex when blank', async () => {
        const rl = mockRL(['y', 'my_feat', '\\.test\\(', '', 'n']);
        const result = await promptFeatures(rl);
        expect(result[0].fileRegex).toBeUndefined();
    });

    it('re-prompts when feature ID is empty', async () => {
        // empty ID → "required" → loops back to askBoolean → 'y' again → then valid id
        const rl = mockRL(['y', '', 'y', 'valid_id', 'foo\\(', '', 'n']);
        const result = await promptFeatures(rl);
        expect(result[0].id).toBe('valid_id');
    });

    it('re-prompts when regex is empty', async () => {
        const rl = mockRL(['y', 'my_feat', '', 'foo\\(', '', 'n']);
        const result = await promptFeatures(rl);
        expect(result[0].regex).toBe('foo\\(');
    });

    it('re-prompts when regex is invalid', async () => {
        const rl = mockRL(['y', 'my_feat', '(unclosed', 'foo\\(', '', 'n']);
        const result = await promptFeatures(rl);
        expect(result[0].regex).toBe('foo\\(');
    });

    it('adds multiple features', async () => {
        const rl = mockRL(['y', 'a', 'a\\(', '', 'y', 'b', 'b\\(', '', 'n']);
        const result = await promptFeatures(rl);
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('a');
        expect(result[1].id).toBe('b');
    });
});

// ── copyRubric ──────────────────────────────────────────────────────────

describe('copyRubric', () => {
    let tmpDir;
    const realRubric = join(import.meta.dirname, '..', 'configs', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'create_lab_test_'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('accepts a valid rubric path and returns rubricPath + rubricName', async () => {
        const rl = mockRL([realRubric, '']);
        const result = await copyRubric(rl, 'Lab04');
        expect(result.rubricPath).toBe(realRubric);
        expect(result.rubricName).toBe('CS233JS_Lab04_Rubric.xlsm');
    });

    it('uses a custom name when the user types one', async () => {
        const rl = mockRL([realRubric, 'MyCustomRubric.xlsm']);
        const result = await copyRubric(rl, 'Lab04');
        expect(result.rubricName).toBe('MyCustomRubric.xlsm');
    });
});

// ── writeLab ────────────────────────────────────────────────────────────

describe('writeLab', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'create_lab_test_'));
        mkdirSync(join(tmpDir, 'Lab99'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes a valid config JSON file', () => {
        const labDir = join(tmpDir, 'Lab99');
        const config = { rubricName: 'r.xlsm', mappings: [] };
        writeLab(labDir, config, null, null);
        const written = JSON.parse(require('fs').readFileSync(join(labDir, 'lab99_config.json'), 'utf8'));
        expect(written).toEqual(config);
    });

    it('writes the analyzer file when analyzerContent is provided', () => {
        const labDir = join(tmpDir, 'Lab99');
        const config = { rubricName: 'r.xlsm', mappings: [] };
        writeLab(labDir, config, 'module.exports = () => {};', 'lab99_analyzer.js');
        const content = require('fs').readFileSync(join(labDir, 'lab99_analyzer.js'), 'utf8');
        expect(content).toBe('module.exports = () => {};');
    });

    it('does not write analyzer file when analyzerContent is null', () => {
        const labDir = join(tmpDir, 'Lab99');
        writeLab(labDir, { rubricName: 'r.xlsm', mappings: [] }, null, null);
        expect(require('fs').existsSync(join(labDir, 'lab99_analyzer.js'))).toBe(false);
    });
});

// ── findSpreadsheets ────────────────────────────────────────────────────

describe('findSpreadsheets', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'find_xlsx_test_'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty array for directory with no spreadsheets', () => {
        writeFileSync(join(tmpDir, 'readme.txt'), '');
        expect(findSpreadsheets(tmpDir)).toEqual([]);
    });

    it('finds a spreadsheet in the root directory', () => {
        writeFileSync(join(tmpDir, 'Rubric.xlsx'), '');
        expect(findSpreadsheets(tmpDir)).toEqual(['Rubric.xlsx']);
    });

    it('finds an xlsm in the root directory', () => {
        writeFileSync(join(tmpDir, 'Rubric.xlsm'), '');
        expect(findSpreadsheets(tmpDir)).toContain('Rubric.xlsm');
    });

    it('finds a spreadsheet inside an immediate sub-folder', () => {
        mkdirSync(join(tmpDir, 'Part1'));
        writeFileSync(join(tmpDir, 'Part1', 'Rubric.xlsm'), '');
        const results = findSpreadsheets(tmpDir);
        expect(results).toHaveLength(1);
        expect(results[0]).toBe(join('Part1', 'Rubric.xlsm'));
    });

    it('finds spreadsheets in both root and sub-folders', () => {
        writeFileSync(join(tmpDir, 'Root.xlsx'), '');
        mkdirSync(join(tmpDir, 'Sub'));
        writeFileSync(join(tmpDir, 'Sub', 'Sub.xlsm'), '');
        const results = findSpreadsheets(tmpDir);
        expect(results).toHaveLength(2);
        expect(results).toContain('Root.xlsx');
        expect(results).toContain(join('Sub', 'Sub.xlsm'));
    });

    it('does not recurse more than one level deep', () => {
        mkdirSync(join(tmpDir, 'A', 'B'), { recursive: true });
        writeFileSync(join(tmpDir, 'A', 'B', 'Deep.xlsx'), '');
        expect(findSpreadsheets(tmpDir)).toEqual([]);
    });

    it('ignores non-spreadsheet files in sub-folders', () => {
        mkdirSync(join(tmpDir, 'Sub'));
        writeFileSync(join(tmpDir, 'Sub', 'notes.txt'), '');
        writeFileSync(join(tmpDir, 'Sub', 'Rubric.xlsm'), '');
        const results = findSpreadsheets(tmpDir);
        expect(results).toHaveLength(1);
        expect(results[0]).toBe(join('Sub', 'Rubric.xlsm'));
    });
});

// ── keywordsToFolderPattern ─────────────────────────────────────────────

describe('keywordsToFolderPattern', () => {
    it('returns empty string for blank input', () => {
        expect(keywordsToFolderPattern('')).toBe('');
        expect(keywordsToFolderPattern('   ')).toBe('');
    });

    it('returns single keyword as-is', () => {
        expect(keywordsToFolderPattern('dev')).toBe('dev');
    });

    it('joins multiple keywords with |', () => {
        expect(keywordsToFolderPattern('dev env')).toBe('dev|env');
    });

    it('handles extra whitespace between keywords', () => {
        expect(keywordsToFolderPattern('  dev   env  ')).toBe('dev|env');
    });

    it('escapes regex special characters in keywords', () => {
        expect(keywordsToFolderPattern('part1 (beta)')).toBe('part1|\\(beta\\)');
    });

    it('generated pattern matches folder names case-insensitively', () => {
        const pattern = keywordsToFolderPattern('dev env');
        const regex = new RegExp(pattern, 'i');
        expect(regex.test('DevEnvAndStaticSite')).toBe(true);
        expect(regex.test('dev-environment')).toBe(true);
        expect(regex.test('my-env-setup')).toBe(true);
        expect(regex.test('FinalApp')).toBe(false);
    });

    it('three keywords — any one match is sufficient', () => {
        const pattern = keywordsToFolderPattern('alpha beta gamma');
        const regex = new RegExp(pattern, 'i');
        expect(regex.test('beta-version')).toBe(true);
        expect(regex.test('GammaRelease')).toBe(true);
        expect(regex.test('delta')).toBe(false);
    });
});

// ── guessMappingType ────────────────────────────────────────────────────

describe('guessMappingType', () => {
    it('guesses manual for generic labels', () => {
        expect(guessMappingType('Professional looking')).toBe('manual');
    });

    it('guesses collaborator_check for collaborator rows', () => {
        expect(guessMappingType('Collaborators added')).toBe('collaborator_check');
    });

    it('guesses lint for style/lint rows', () => {
        expect(guessMappingType('Code style and best practices')).toBe('lint');
        expect(guessMappingType('ESLint errors')).toBe('lint');
        expect(guessMappingType('Lint check')).toBe('lint');
    });

    it('guesses html_validate for HTML rows', () => {
        expect(guessMappingType('index.html')).toBe('html_validate');
        expect(guessMappingType('One or more HTML pages')).toBe('html_validate');
        expect(guessMappingType('HTML page(s) are free of errors')).toBe('html_validate');
    });

    it('guesses css_validate for CSS rows', () => {
        expect(guessMappingType('css file')).toBe('css_validate');
        expect(guessMappingType('One or more CSS files')).toBe('css_validate');
        expect(guessMappingType('stylesheet is valid')).toBe('css_validate');
    });

    it('does not mistake "Code style" for css_validate (substring guard)', () => {
        expect(guessMappingType('Code style and best practices')).toBe('lint');
    });

    it('guesses name_check for file/folder naming rows', () => {
        expect(guessMappingType('Directory structure and file naming')).toBe('name_check');
        expect(guessMappingType('Folder structure and file names')).toBe('name_check');
        expect(guessMappingType('Appropriate naming conventions')).toBe('name_check');
    });

    it('guesses github_repo for GitHub repo rows', () => {
        expect(guessMappingType('GitHub private repo')).toBe('github_repo');
        expect(guessMappingType('github repo link')).toBe('github_repo');
    });

    it('guesses gitignore_check for .gitignore rows', () => {
        expect(guessMappingType('.gitignore file')).toBe('gitignore_check');
    });

    it('guesses repo_hygiene for repo hygiene rows', () => {
        expect(guessMappingType('repo hygiene check')).toBe('repo_hygiene');
    });

    it('guesses build_check for build / vite rows', () => {
        expect(guessMappingType('vite build passes')).toBe('build_check');
        expect(guessMappingType('npm run build')).toBe('build_check');
        expect(guessMappingType('webpack bundle')).toBe('build_check');
    });

    it('guesses package_check for package.json rows', () => {
        expect(guessMappingType('package.json scripts')).toBe('package_check');
        expect(guessMappingType('npm package dependency')).toBe('package_check');
    });

    it('guesses deploy_check for deployment rows', () => {
        expect(guessMappingType('deployed to citstudent')).toBe('deploy_check');
        expect(guessMappingType('live site reachable')).toBe('deploy_check');
    });

    it('guesses code_review for review rows', () => {
        expect(guessMappingType('code review submitted')).toBe('code_review');
    });

    it('guesses developer_comments for comment rows', () => {
        expect(guessMappingType('developer comments present')).toBe('developer_comments');
    });

    it('is case-insensitive', () => {
        expect(guessMappingType('GITHUB PRIVATE REPO')).toBe('github_repo');
        expect(guessMappingType('LINT CHECK')).toBe('lint');
    });
});

// ── askOptions with non-zero default ────────────────────────────────────

describe('askOptions — defaultIdx', () => {
    const opts = [
        { label: 'alpha', value: 'a' },
        { label: 'beta',  value: 'b' },
        { label: 'gamma', value: 'g' },
    ];

    it('returns the default-index option on empty input', async () => {
        const rl = mockRL(['']);
        expect(await askOptions(rl, 'Pick:', opts, 1)).toBe('b');
    });

    it('still accepts explicit selection regardless of default', async () => {
        const rl = mockRL(['1']);
        expect(await askOptions(rl, 'Pick:', opts, 2)).toBe('a');
    });
});

// ── configure_lab: draft generation ─────────────────────────────────────

describe('guardFeatureType', () => {
    it('downgrades feature to manual when the featureId is unknown', () => {
        expect(guardFeatureType('feature', 'vite-config', new Set())).toBe('manual');
        expect(guardFeatureType('feature', undefined, new Set())).toBe('manual');
    });

    it('keeps feature when the featureId is already defined', () => {
        expect(guardFeatureType('feature', 'vite-config', new Set(['vite-config']))).toBe('feature');
    });

    it('leaves non-feature types untouched', () => {
        expect(guardFeatureType('lint', undefined, new Set())).toBe('lint');
        expect(guardFeatureType('build_check', 'x', new Set())).toBe('build_check');
    });
});

describe('findCriteria', () => {
    const criteria = [
        { label: 'One or more HTML pages', criteria: 'HTML page(s) are free of errors' },
        { label: 'vite', criteria: 'Vite is in the package.json file' },
    ];

    it('matches by token overlap across differently-worded labels', () => {
        expect(findCriteria('index.html (HTML pages)', criteria)).toMatch(/free of errors/i);
        expect(findCriteria('vite', criteria)).toMatch(/package\.json/i);
    });

    it('returns empty string when nothing overlaps', () => {
        expect(findCriteria('completely unrelated thing', criteria)).toBe('');
    });
});

describe('heuristicDraft', () => {
    const rows = readRubricRows(TERM_RUBRIC).filter(r => !r.isSectionHeader);

    it('captures stockComments onto each entry that has them', () => {
        const draft = heuristicDraft(rows, [], new Set());
        const idx = draft.find(d => d._label === 'index.html');
        expect(idx.stockComments).toEqual({ full: 'Good', partial: 'Errors', zero: 'Missing' });
    });

    it('never emits a feature type without a known featureId', () => {
        const draft = heuristicDraft(rows, [], new Set());
        expect(draft.every(d => d.type !== 'feature')).toBe(true);
    });

    it('uses cell (not scoreCell) as the score-cell key', () => {
        const draft = heuristicDraft(rows, [], new Set());
        expect(draft[0]).toHaveProperty('cell');
        expect(draft[0].scoreCell).toBeUndefined();
    });
});

describe('mergeLLMResponse', () => {
    const rows = readRubricRows(TERM_RUBRIC).filter(r => !r.isSectionHeader).slice(0, 2);

    it('downgrades an LLM feature guess with an unknown featureId', () => {
        const llm = rows.map(r => ({ type: 'feature', featureId: 'made-up', maxScore: 5 }));
        const merged = mergeLLMResponse(llm, rows, new Set());
        expect(merged.every(m => m.type !== 'feature')).toBe(true);
    });

    it('captures stockComments from the rubric row, not the LLM output', () => {
        const llm = rows.map(() => ({ type: 'lint', maxScore: 6 }));
        const merged = mergeLLMResponse(llm, rows, new Set());
        const idx = merged.find(m => m._label === 'index.html');
        expect(idx.stockComments).toEqual({ full: 'Good', partial: 'Errors', zero: 'Missing' });
    });
});

describe('printDraftTable', () => {
    it('renders a skipped row (no type field) without throwing', () => {
        // Guards the regression where maxType read d.type.length on a skip entry.
        expect(() => printDraftTable([
            { _label: 'index.html', cell: 'D7', type: 'manual', maxScore: 6 },
            { _label: 'css file', cell: 'D8', _skip: true },
        ])).not.toThrow();
    });
});
