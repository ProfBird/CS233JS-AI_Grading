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
    colLetter, excelCell, parseLabNumber, cellText, isBlankRow,
    readRubricRows, buildConfig, buildMappingEntry,
    askBoolean, askOptions, ask
} = await import('../bin/create_lab.js');

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
    it('wraps for index 26 (single letter alphabet wraps)', () => {
        expect(colLetter(26)).toBe('[');
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

// ── parseLabNumber ─────────────────────────────────────────────────────

describe('parseLabNumber', () => {
    it('parses "7" → Lab07', () => {
        expect(parseLabNumber('7')).toBe('Lab07');
    });
    it('parses "07" → Lab07', () => {
        expect(parseLabNumber('07')).toBe('Lab07');
    });
    it('parses "Lab7" → Lab07', () => {
        expect(parseLabNumber('Lab7')).toBe('Lab07');
    });
    it('parses "Lab07" → Lab07', () => {
        expect(parseLabNumber('Lab07')).toBe('Lab07');
    });
    it('parses "lab03" → Lab03', () => {
        expect(parseLabNumber('lab03')).toBe('Lab03');
    });
    it('parses "Lab99" → Lab99', () => {
        expect(parseLabNumber('Lab99')).toBe('Lab99');
    });
    it('parses "10" → Lab10', () => {
        expect(parseLabNumber('10')).toBe('Lab10');
    });
    it('returns null for "abc"', () => {
        expect(parseLabNumber('abc')).toBeNull();
    });
    it('returns null for empty string', () => {
        expect(parseLabNumber('')).toBeNull();
    });
    it('parses "123" → Lab123', () => {
        expect(parseLabNumber('123')).toBe('Lab123');
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
        const parts = [{ id: 'part1', rubricTitleRow: 7 }];
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

    it('parses maxScore 0 for non-numeric input', async () => {
        const rl = mockRL(['abc']);
        const result = await buildMappingEntry(rl, 'build_check', rubricRow);
        expect(result.maxScore).toBe(0);
    });
});
