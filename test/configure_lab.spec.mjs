/**
 * configure_lab.spec.mjs
 *
 * Unit tests for lab configuration functions:
 *   lib/lab_config.js   — pure data/config helpers
 *   lib/config_prompts.js — driver-based rubric prompt functions
 *   bin/configure_lab.js  — AI-assisted wizard helpers
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mockDriver } from './helpers/mock_driver.mjs';

const {
    colLetter, excelCell, normalizeAssignmentName, cellText, isBlankRow,
    readRubricRows, readRubricCriteria, assembleConfig, mergeFeatureDefs, writeLab,
    findSpreadsheets, keywordsToFolderPattern, guessMappingType,
    getExistingSteps,
} = await import('../src/lib/lab_config.js');

const { countFeatures } = await import('../src/pipeline/analyze_code.js');

const {
    buildMappingEntry, copyRubric, promptRubricRows, extensionsToFileRegex,
    promptFields, promptRubricCriteria,
} = await import('../src/lib/config_prompts.js');

const {
    heuristicDraft, mergeLLMResponse, guardFeatureType, findCriteria, printDraftTable,
} = await import('../bin/configure-lab.js');

// Real lab configs live under configs/{Course}/{Lab}/ (course tier).
const TERM_RUBRIC = join(import.meta.dirname, '..', 'configs', 'CS233JS', 'TermProject',
    'DevEnvAndStaticSite', 'CS233JS_TermProjectDevEnv_Rubric.xlsm');
const LAB04_RUBRIC = join(import.meta.dirname, '..', 'configs', 'CS233JS', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');

// mockDriver (satisfying config_prompts.js's ask/askBoolean/askInt/askOptions/print/exit
// interface) now lives in test/helpers/mock_driver.mjs, shared with grade_setup.spec.mjs.

// ── colLetter ───────────────────────────────────────────────────────────

describe('colLetter', () => {
    it('returns A for index 0', () => expect(colLetter(0)).toBe('A'));
    it('returns Z for index 25', () => expect(colLetter(25)).toBe('Z'));
    it('returns AA for index 26', () => expect(colLetter(26)).toBe('AA'));
    it('returns AZ for index 51', () => expect(colLetter(51)).toBe('AZ'));
    it('returns BA for index 52', () => expect(colLetter(52)).toBe('BA'));
    it('returns ZZ for index 701', () => expect(colLetter(701)).toBe('ZZ'));
    it('returns AAA for index 702', () => expect(colLetter(702)).toBe('AAA'));
    it('returns empty string for negative index', () => expect(colLetter(-1)).toBe(''));
});

// ── excelCell ───────────────────────────────────────────────────────────

describe('excelCell', () => {
    // row arg is the actual spreadsheet row number (1-based), matching XLSX convention
    it('returns A1 for col 0, row 1', () => expect(excelCell(0, 1)).toBe('A1'));
    it('returns B3 for col 1, row 3', () => expect(excelCell(1, 3)).toBe('B3'));
    it('returns AA10 for col 26, row 10', () => expect(excelCell(26, 10)).toBe('AA10'));
});

// ── normalizeAssignmentName ──────────────────────────────────────────────

describe('normalizeAssignmentName', () => {
    it('converts a plain number to Lab-prefixed name', () => {
        expect(normalizeAssignmentName('03')).toBe('Lab03');
        expect(normalizeAssignmentName('3')).toBe('Lab03');
        expect(normalizeAssignmentName('10')).toBe('Lab10');
    });

    it('accepts Lab-prefixed names as-is', () => {
        expect(normalizeAssignmentName('Lab03')).toBe('Lab03');
        expect(normalizeAssignmentName('Lab10')).toBe('Lab10');
    });

    it('accepts arbitrary slug names', () => {
        expect(normalizeAssignmentName('TermProject')).toBe('TermProject');
        expect(normalizeAssignmentName('MyAssignment')).toBe('MyAssignment');
    });

    it('returns null for invalid input', () => {
        expect(normalizeAssignmentName('')).toBeNull();
        expect(normalizeAssignmentName('  ')).toBeNull();
        expect(normalizeAssignmentName('lab 03')).toBeNull();
    });

    it('accepts slugs with hyphens (Lab-03 is a valid slug)', () => {
        expect(normalizeAssignmentName('Lab-03')).toBe('Lab-03');
    });

    it('is case-sensitive for slug names', () => {
        expect(normalizeAssignmentName('termproject')).toBe('termproject');
        expect(normalizeAssignmentName('TERMPROJECT')).toBe('TERMPROJECT');
    });

    it('handles numeric strings with leading zeros', () => {
        expect(normalizeAssignmentName('007')).toBe('Lab07');
    });

    it('handles two-digit numbers without leading zero', () => {
        expect(normalizeAssignmentName('99')).toBe('Lab99');
    });
});

// ── cellText ─────────────────────────────────────────────────────────────
// cellText(row, i) — row is a plain array (from sheet_to_json), i is column index

describe('cellText', () => {
    it('returns the string at the given index', () => {
        expect(cellText(['Hello', 'World'], 0)).toBe('Hello');
        expect(cellText(['Hello', 'World'], 1)).toBe('World');
    });

    it('converts numbers to strings', () => {
        expect(cellText([42], 0)).toBe('42');
    });

    it('returns empty string for missing index', () => {
        expect(cellText([], 0)).toBe('');
        expect(cellText(['a'], 5)).toBe('');
    });

    it('trims surrounding whitespace', () => {
        expect(cellText(['  hello  '], 0)).toBe('hello');
    });
});

// ── isBlankRow ───────────────────────────────────────────────────────────
// isBlankRow(row) — row is a plain array (from sheet_to_json)

describe('isBlankRow', () => {
    it('returns true for an empty array', () => {
        expect(isBlankRow([])).toBe(true);
    });

    it('returns true for row with only blank cells', () => {
        expect(isBlankRow(['', '', null])).toBe(true);
    });

    it('returns false for row with at least one non-empty cell', () => {
        expect(isBlankRow(['', 'hello', ''])).toBe(false);
    });
});

// ── readRubricRows ───────────────────────────────────────────────────────

describe('readRubricRows', () => {
    it('returns rows from a real rubric file', () => {
        const rows = readRubricRows(LAB04_RUBRIC);
        expect(rows).not.toBeNull();
        expect(rows.length).toBeGreaterThan(0);
    });

    it('returns an array of objects with scoreCell and label properties', () => {
        const rows = readRubricRows(LAB04_RUBRIC);
        const scoringRows = rows.filter(r => !r.isSectionHeader);
        expect(scoringRows.length).toBeGreaterThan(0);
        for (const row of scoringRows) {
            expect(row).toHaveProperty('scoreCell');
            expect(row).toHaveProperty('label');
        }
    });

    it('identifies section headers (rows without a score cell)', () => {
        const rows = readRubricRows(LAB04_RUBRIC);
        const headers = rows.filter(r => r.isSectionHeader);
        expect(headers.length).toBeGreaterThanOrEqual(0);
    });

    it('captures stock comment columns when present', () => {
        const rows = readRubricRows(TERM_RUBRIC);
        const withStock = rows.filter(r => r.stockComments);
        expect(withStock.length).toBeGreaterThan(0);
        expect(withStock[0].stockComments).toHaveProperty('full');
        expect(withStock[0].stockComments).toHaveProperty('partial');
        expect(withStock[0].stockComments).toHaveProperty('zero');
    });

    it('returns null for a non-existent file', () => {
        expect(readRubricRows('/nonexistent/rubric.xlsx')).toBeNull();
    });
});

// ── readRubricRows — custom headerLabel ──────────────────────────────────

describe('readRubricRows — custom headerLabel', () => {
    it('returns null when rubric has no matching header row', () => {
        const rows = readRubricRows(LAB04_RUBRIC, 'NonexistentLabel');
        expect(rows).toBeNull();
    });

    it('returns rows when header is found by the default heuristic', () => {
        const rows = readRubricRows(LAB04_RUBRIC);
        expect(rows).not.toBeNull();
        expect(rows.length).toBeGreaterThan(0);
    });
});

// ── readRubricRows — stock comments ──────────────────────────────────────

describe('readRubricRows — stock comments', () => {
    it('attaches stockComments to rows that have all three columns populated', () => {
        const rows = readRubricRows(TERM_RUBRIC);
        const withStock = rows.filter(r => r.stockComments);
        expect(withStock.length).toBeGreaterThan(0);
    });

    it('does not attach stockComments to rows that lack the columns', () => {
        const rows = readRubricRows(LAB04_RUBRIC);
        const withStock = rows.filter(r => r.stockComments);
        // Lab04 rubric has no stock comment columns — all should be absent
        expect(withStock.length).toBe(0);
    });

    it('full/partial/zero values come from the rubric cells', () => {
        const rows = readRubricRows(TERM_RUBRIC);
        const first = rows.find(r => r.stockComments);
        expect(typeof first.stockComments.full).toBe('string');
        expect(typeof first.stockComments.partial).toBe('string');
        expect(typeof first.stockComments.zero).toBe('string');
    });
});

// ── readRubricCriteria ───────────────────────────────────────────────────

describe('readRubricCriteria', () => {
    it('returns an array (may be empty) from a real rubric', () => {
        const criteria = readRubricCriteria(LAB04_RUBRIC);
        expect(Array.isArray(criteria)).toBe(true);
    });

    it('each criterion has label and criteria fields', () => {
        const criteria = readRubricCriteria(LAB04_RUBRIC);
        for (const c of criteria) {
            expect(c).toHaveProperty('label');
            expect(c).toHaveProperty('criteria');
        }
    });
});

// ── promptRubricRows ────────────────────────────────────────────────────

describe('promptRubricRows', () => {
    const realRubric = LAB04_RUBRIC;

    it('returns rows when default header is found and user confirms columns', async () => {
        const driver = mockDriver(['']);  // empty = accept default for "Are these columns correct?"
        const rows = await promptRubricRows(driver, realRubric);
        expect(rows).not.toBeNull();
        expect(rows.length).toBeGreaterThan(0);
    });

    it('returns null when rubric is unreadable and user leaves alternative blank', async () => {
        const driver = mockDriver(['']);
        expect(await promptRubricRows(driver, '/nonexistent/rubric.xlsx')).toBeNull();
    });
});

// ── promptRubricCriteria ─────────────────────────────────────────────────
// config_prompts.js's thin wrapper around lab_config.js's readRubricCriteria — reports
// the count via driver.print but does not prompt for corrections (criteria are hints).

describe('promptRubricCriteria', () => {
    it('returns the criteria array unchanged from readRubricCriteria', async () => {
        const driver = mockDriver([]);
        const rubric = TERM_RUBRIC;
        const result = await promptRubricCriteria(driver, rubric);
        expect(result).toEqual(readRubricCriteria(rubric));
        expect(result.length).toBeGreaterThan(0);
    });

    it('returns an empty array without prompting when no Rubric sheet/Criteria column exists', async () => {
        const driver = mockDriver([]); // no answers queued — would throw if promptRubricCriteria asked anything
        const result = await promptRubricCriteria(driver, LAB04_RUBRIC);
        expect(result).toEqual([]);
    });
});

// ── promptFields ──────────────────────────────────────────────────────────
// Walks a MAPPING_TYPE_SCHEMA fields array, dispatching to the driver method that
// matches each field's type (int/options/text) and applying defaults/current values.

describe('promptFields', () => {
    it('applies askInt for an "int" field, using the field default when no current value', async () => {
        const fields = [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }];
        const driver = mockDriver(['7']);
        const result = await promptFields(driver, fields);
        expect(result).toEqual({ maxScore: 7 });
    });

    it('seeds the int prompt default from currentValues over the field default', async () => {
        const fields = [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }];
        const driver = mockDriver(['']); // blank answer -> falls back to the def passed to askInt
        const result = await promptFields(driver, fields, { maxScore: 4 });
        expect(result).toEqual({ maxScore: 4 });
    });

    it('applies askOptions for an "options" field and resolves the numbered choice', async () => {
        const fields = [{
            key: 'severity', prompt: '  Severity:', type: 'options',
            options: [{ label: 'Errors', value: 'errors' }, { label: 'Warnings', value: 'warnings' }],
        }];
        const driver = mockDriver(['2']);
        const result = await promptFields(driver, fields);
        expect(result).toEqual({ severity: 'warnings' });
    });

    it('defaults the options prompt index from a matching currentValues entry', async () => {
        const fields = [{
            key: 'severity', prompt: '  Severity:', type: 'options',
            options: [{ label: 'Errors', value: 'errors' }, { label: 'Warnings', value: 'warnings' }],
        }];
        const driver = mockDriver(['']); // blank -> accept the resolved default index
        const result = await promptFields(driver, fields, { severity: 'warnings' });
        expect(result).toEqual({ severity: 'warnings' });
    });

    it('returns null and stops when a required text field is left empty with no default', async () => {
        const fields = [{ key: 'pathPattern', prompt: '  Path pattern: ', required: true }];
        const driver = mockDriver(['']);
        expect(await promptFields(driver, fields)).toBeNull();
    });

    it('skips (omits from result) an optional text field left empty with no default', async () => {
        const fields = [
            { key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 },
            { key: 'linkCell', prompt: '  Link cell (e.g. F20, or blank): ', optional: true },
        ];
        const driver = mockDriver(['3', '']);
        const result = await promptFields(driver, fields);
        expect(result).toEqual({ maxScore: 3 });
        expect(result).not.toHaveProperty('linkCell');
    });

    it('fills a plain text field from the driver answer', async () => {
        const fields = [{ key: 'msg', prompt: '  Message: ' }];
        const driver = mockDriver(['Custom note']);
        const result = await promptFields(driver, fields);
        expect(result).toEqual({ msg: 'Custom note' });
    });

    it('falls back to the currentValues entry when the text answer is blank', async () => {
        const fields = [{ key: 'msg', prompt: '  Message: ' }];
        const driver = mockDriver(['']);
        const result = await promptFields(driver, fields, { msg: 'Existing note' });
        expect(result).toEqual({ msg: 'Existing note' });
    });
});

// ── assembleConfig (round-trip safety) ───────────────────────────────────

describe('assembleConfig', () => {
    const wizardResponses = {
        rubricName: 'CS233JS_Lab99_Rubric.xlsm',
        titleText: 'Lab 99',
        runtimeCheck: 'both',
        mappings: [{ cell: 'C8', type: 'lint', maxScore: 2 }],
        optional: { titleCell: 'A1', summaryCell: 'A2', graderCell: 'E1' },
    };

    it('preserves fields the wizard does not manage when re-run on an existing config', () => {
        // This is the W1 regression test: customAnalyzer, validate, and nameCheck were
        // silently dropped by the old buildConfig path. They must survive a re-run.
        const existing = {
            rubricName: 'old.xlsm',
            runtimeCheck: 'browser',
            codeReview: { studentNameCell: 'B1', groupCell: 'C1' },
            variations: { A: { appName: 'Foo' } },
            packageCheck: { dependencies: ['vite'] },
            repoHygiene: { excludedFromRepo: ['node_modules'] },
            lint: { exclude: ['dist'] },
            validate: { htmlRules: { 'no-inline-style': 'error' } },
            nameCheck: { extraAllowed: '+' },
            analysis: {
                customAnalyzer: 'lab99_analyzer.js',
                features: [{ id: 'fetch_api', regex: 'fetch\\s*\\(' }],
                parts: [{ id: 'part1' }],
            },
            mappings: [{ cell: 'C1', type: 'manual', maxScore: 1 }],
        };

        const config = assembleConfig(existing, wizardResponses);

        // Unmanaged sections survive untouched
        expect(config.analysis.customAnalyzer).toBe('lab99_analyzer.js');
        expect(config.analysis.features).toEqual(existing.analysis.features);
        expect(config.analysis.parts).toEqual(existing.analysis.parts);
        expect(config.validate).toEqual({ htmlRules: { 'no-inline-style': 'error' } });
        expect(config.nameCheck).toEqual({ extraAllowed: '+' });
        expect(config.codeReview).toEqual({ studentNameCell: 'B1', groupCell: 'C1' });
        expect(config.variations).toEqual({ A: { appName: 'Foo' } });
        expect(config.packageCheck).toEqual({ dependencies: ['vite'] });
        expect(config.repoHygiene).toEqual({ excludedFromRepo: ['node_modules'] });
        expect(config.lint).toEqual({ exclude: ['dist'] });

        // Wizard-owned keys are updated
        expect(config.rubricName).toBe('CS233JS_Lab99_Rubric.xlsm');
        expect(config.runtimeCheck).toBe('both');
        expect(config.mappings).toEqual([{ cell: 'C8', type: 'lint', maxScore: 2 }]);
        expect(config.titleCell).toBe('A1');
        expect(config.summaryCell).toBe('A2');
        expect(config.graderCell).toBe('E1');
    });

    it('does not mutate the input existingConfig', () => {
        const existing = {
            rubricName: 'old.xlsm', runtimeCheck: 'browser',
            mappings: [{ cell: 'C1', type: 'manual', maxScore: 1 }],
            analysis: { customAnalyzer: 'a.js' },
        };
        const snapshot = JSON.parse(JSON.stringify(existing));
        assembleConfig(existing, wizardResponses);
        expect(existing).toEqual(snapshot);
    });

    it('clears an optional cell when the wizard passes a blank value', () => {
        const existing = {
            rubricName: 'old.xlsm', runtimeCheck: 'browser', summaryCell: 'A2',
            mappings: [],
        };
        const config = assembleConfig(existing, {
            rubricName: 'r.xlsm', titleText: 'T', runtimeCheck: 'build', mappings: [],
            optional: { summaryCell: '' },
        });
        expect(config.summaryCell).toBeUndefined();
    });

    it('produces a clean minimal config for a brand-new lab (null existingConfig)', () => {
        const config = assembleConfig(null, {
            rubricName: 'r.xlsm', titleText: '', runtimeCheck: 'build', mappings: [],
            optional: {},
        });
        expect(config).toEqual({ rubricName: 'r.xlsm', runtimeCheck: 'build', mappings: [] });
    });

    it('drops the extractOnly flag when reconfiguring a former extract-only lab', () => {
        const existing = { extractOnly: true, mappings: [] };
        const config = assembleConfig(existing, wizardResponses);
        expect(config.extractOnly).toBeUndefined();
        expect(config.rubricName).toBe('CS233JS_Lab99_Rubric.xlsm');
        expect(config.mappings).toEqual([{ cell: 'C8', type: 'lint', maxScore: 2 }]);
    });

    it('returns a minimal extract-only config when responses.extractOnly is set', () => {
        const config = assembleConfig(null, { extractOnly: true });
        expect(config).toEqual({ extractOnly: true, mappings: [] });
    });

    it('omits language entirely when the wizard selection is the "javascript" default', () => {
        const config = assembleConfig(null, { ...wizardResponses, language: 'javascript' });
        expect(config.language).toBeUndefined();
    });

    it('writes language when the wizard selection is not "javascript"', () => {
        const config = assembleConfig(null, { ...wizardResponses, language: 'python' });
        expect(config.language).toBe('python');
    });

    it('clears a previously-set language when re-run and switched back to javascript', () => {
        const existing = { rubricName: 'old.xlsm', runtimeCheck: 'browser', language: 'python', mappings: [] };
        const config = assembleConfig(existing, { ...wizardResponses, language: 'javascript' });
        expect(config.language).toBeUndefined();
    });
});

// ── mergeFeatureDefs ──────────────────────────────────────────────────────

describe('mergeFeatureDefs', () => {
    it('creates analysis.features on a brand-new config (no analysis block)', () => {
        const config = { rubricName: 'r.xlsm', runtimeCheck: 'browser', mappings: [] };
        mergeFeatureDefs(config, [{ id: 'foo', regex: 'x', fileRegex: '\\.js$' }]);
        expect(config.analysis.features).toEqual([{ id: 'foo', regex: 'x', fileRegex: '\\.js$' }]);
    });

    it('appends a new feature while preserving existing ones', () => {
        const config = { analysis: { features: [{ id: 'foo', regex: 'a' }], customAnalyzer: 'keep.js' } };
        mergeFeatureDefs(config, [{ id: 'bar', regex: 'b' }]);
        expect(config.analysis.features.map(f => f.id)).toEqual(['foo', 'bar']);
        expect(config.analysis.customAnalyzer).toBe('keep.js');  // unrelated analysis keys untouched
    });

    it('replaces an existing feature with the same id (new wins)', () => {
        const config = { analysis: { features: [{ id: 'foo', regex: 'old' }] } };
        mergeFeatureDefs(config, [{ id: 'foo', match: { allOf: [{ regex: 'new' }] } }]);
        expect(config.analysis.features).toEqual([{ id: 'foo', match: { allOf: [{ regex: 'new' }] } }]);
    });

    it('is a no-op for an empty/absent feature-def list', () => {
        const config = { rubricName: 'r.xlsm' };
        mergeFeatureDefs(config, []);
        expect(config).toEqual({ rubricName: 'r.xlsm' });
    });
});

// ── getExistingSteps ────────────────────────────────────────────────────

describe('getExistingSteps', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'get_existing_steps_'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns [] when the lab directory does not exist', () => {
        expect(getExistingSteps('NoSuchLab', tmpDir)).toEqual([]);
    });

    it('returns [] for a flat lab (top-level config present)', () => {
        mkdirSync(join(tmpDir, 'Lab03'), { recursive: true });
        writeFileSync(join(tmpDir, 'Lab03', 'lab03_config.json'), '{}');
        expect(getExistingSteps('Lab03', tmpDir)).toEqual([]);
    });

    it('returns [] when lab dir exists but no step subdirs have configs', () => {
        mkdirSync(join(tmpDir, 'TermProject', 'DevEnvAndStaticSite'), { recursive: true });
        // no config json in the subdir
        expect(getExistingSteps('TermProject', tmpDir)).toEqual([]);
    });

    it('returns step names sorted when step subdirs each have their own config', () => {
        const base = join(tmpDir, 'TermProject');
        for (const step of ['Proposal', 'ApiDoc', 'Beta']) {
            mkdirSync(join(base, step), { recursive: true });
            writeFileSync(join(base, step, `${step.toLowerCase()}_config.json`), '{}');
        }
        expect(getExistingSteps('TermProject', tmpDir)).toEqual(['ApiDoc', 'Beta', 'Proposal']);
    });

    it('excludes subdirs that are present but have no matching config json', () => {
        const base = join(tmpDir, 'TermProject');
        mkdirSync(join(base, 'ApiDoc'), { recursive: true });
        writeFileSync(join(base, 'ApiDoc', 'apidoc_config.json'), '{}');
        mkdirSync(join(base, 'assets'), { recursive: true }); // no config
        expect(getExistingSteps('TermProject', tmpDir)).toEqual(['ApiDoc']);
    });

    it('ignores subdirs whose config file does not follow the {subdir_lower}_config.json convention', () => {
        const base = join(tmpDir, 'TermProject');
        mkdirSync(join(base, 'ApiDoc'), { recursive: true });
        // wrong name — 'config.json' instead of 'apidoc_config.json'
        writeFileSync(join(base, 'ApiDoc', 'config.json'), '{}');
        expect(getExistingSteps('TermProject', tmpDir)).toEqual([]);
    });
});

// ── extensionsToFileRegex ─────────────────────────────────────────────────

describe('extensionsToFileRegex', () => {
    it('builds a single-extension path regex', () => {
        expect(extensionsToFileRegex('js')).toBe('\\.js$');
        expect(extensionsToFileRegex('.js')).toBe('\\.js$');   // leading dot tolerated
    });
    it('builds an alternation for multiple extensions (comma or space separated)', () => {
        expect(extensionsToFileRegex('js, mjs')).toBe('\\.(js|mjs)$');
        expect(extensionsToFileRegex('js mjs cjs')).toBe('\\.(js|mjs|cjs)$');
        expect(extensionsToFileRegex('.js, .mjs')).toBe('\\.(js|mjs)$');
    });
    it('passes a raw regex through unchanged (advanced use)', () => {
        expect(extensionsToFileRegex('\\.m?js$')).toBe('\\.m?js$');
        expect(extensionsToFileRegex('\\.(js|mjs)$')).toBe('\\.(js|mjs)$');
        expect(extensionsToFileRegex('src/.*\\.js$')).toBe('src/.*\\.js$');
    });
    it('returns null for empty input', () => {
        expect(extensionsToFileRegex('')).toBeNull();
        expect(extensionsToFileRegex('   ')).toBeNull();
    });
});

// ── buildMappingEntry ───────────────────────────────────────────────────

describe('buildMappingEntry', () => {
    const rubricRow = { scoreCell: 'C8', commentCell: 'E8', label: 'Test' };
    const rubricRowNoComment = { scoreCell: 'C10', commentCell: '', label: 'No Comment' };

    // feature flow: ask(featureId), askOptions(combinator), then pattern(s), then fileRegex
    // (asked AFTER patterns so a code pattern isn't mistyped into the file prompt):
    //   single → ask(regex), ask(fileRegex), askInt(minCount), askInt(maxScore)
    //   allOf/anyOf → ask(pattern…), ask('') to finish, ask(fileRegex), askInt(maxScore)
    it('builds a single-regex feature mapping + feature definition', async () => {
        const rl = mockDriver(['my_feature', 'single', 'fetch\\(', '\\.js$', '2', '5']);
        const result = await buildMappingEntry(rl, 'feature', rubricRow);

        expect(result).toEqual({
            type: 'feature',
            cell: 'C8',
            commentCell: 'E8',
            featureId: 'my_feature',
            minCount: 2,
            maxScore: 5,
            _featureDef: { id: 'my_feature', regex: 'fetch\\(', fileRegex: '\\.js$' },
        });
    });

    it('accepts a plain extension list for the file prompt (js, mjs)', async () => {
        // featureId, combinator, regex, fileRegex(extensions), minCount, maxScore
        const rl = mockDriver(['feat', 'single', 'import\\b', 'js, mjs', '1', '3']);
        const result = await buildMappingEntry(rl, 'feature', rubricRow);
        expect(result._featureDef.fileRegex).toBe('\\.(js|mjs)$');
    });

    it('returns null for feature with empty id', async () => {
        const rl = mockDriver(['']);
        const result = await buildMappingEntry(rl, 'feature', rubricRow);
        expect(result).toBeNull();
    });

    it('builds an allOf feature and forces minCount to 1 (boolean match)', async () => {
        // featureId, combinator, pattern1, pattern2, '' (end list), fileRegex, maxScore
        const rl = mockDriver(['modules', 'allOf', 'import\\s+.*from', 'export\\s+', '', '\\.js$', '6']);
        const result = await buildMappingEntry(rl, 'feature', rubricRow);

        expect(result.type).toBe('feature');
        expect(result.featureId).toBe('modules');
        expect(result.minCount).toBe(1);               // boolean match → never prompt > 1
        expect(result.maxScore).toBe(6);
        expect(result._featureDef).toEqual({
            id: 'modules',
            match: { allOf: [{ regex: 'import\\s+.*from' }, { regex: 'export\\s+' }] },
            fileRegex: '\\.js$',
        });
    });

    it('builds an anyOf feature', async () => {
        const rl = mockDriver(['styling', 'anyOf', '\\.fillStyle', '\\.font\\s*=', '', '\\.js$', '3']);
        const result = await buildMappingEntry(rl, 'feature', rubricRow);
        expect(result._featureDef.match.anyOf).toEqual([{ regex: '\\.fillStyle' }, { regex: '\\.font\\s*=' }]);
    });

    it('returns null when an allOf rule has no patterns', async () => {
        const rl = mockDriver(['f', 'allOf', '']);  // immediately blank → no patterns (returns before fileRegex)
        const result = await buildMappingEntry(rl, 'feature', rubricRow);
        expect(result).toBeNull();
    });

    // Integration gate: the produced _featureDef must actually detect/reject via countFeatures,
    // not just have the right shape.
    it('produced allOf def detects only when BOTH patterns are present (via countFeatures)', async () => {
        const rl = mockDriver(['modules', 'allOf', 'import\\s+.*from', 'export\\s+', '', '\\.js$', '6']);
        const { _featureDef } = await buildMappingEntry(rl, 'feature', rubricRow);

        const dir = mkdtempSync(join(tmpdir(), 'featdef-'));
        try {
            const both = join(dir, 'both.js');
            writeFileSync(both, 'import x from "./x.js";\nexport default y;');
            expect(countFeatures([both], [_featureDef]).modules).toBe(1);

            const importOnly = join(dir, 'imp.js');
            writeFileSync(importOnly, 'import x from "./x.js";');
            expect(countFeatures([importOnly], [_featureDef]).modules).toBe(0);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it('builds a manual mapping entry', async () => {
        const rl = mockDriver(['10', 'Needs review', '']);
        const result = await buildMappingEntry(rl, 'manual', rubricRow);

        expect(result).toEqual({
            type: 'manual',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 10,
            msg: 'Needs review'
        });
    });

    it('manual records an optional reviewRow when one is given', async () => {
        const rl = mockDriver(['5', 'Check it', 'interactive']);
        const result = await buildMappingEntry(rl, 'manual', rubricRow);
        expect(result.reviewRow).toBe('interactive');
    });

    it('manual omits reviewRow when left blank', async () => {
        const rl = mockDriver(['5', 'Check it', '']);
        const result = await buildMappingEntry(rl, 'manual', rubricRow);
        expect(result).not.toHaveProperty('reviewRow');
    });

    it('manual uses default message on empty', async () => {
        const rl = mockDriver(['5', '', '']);
        const result = await buildMappingEntry(rl, 'manual', rubricRow);
        expect(result.msg).toBe('NEEDS MANUAL CHECK');
    });

    it('builds a lint mapping entry with severity', async () => {
        const rl = mockDriver(['2', '2']); // maxScore=2, severity=2 (warnings)
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
        const rl = mockDriver(['1', '']);
        const result = await buildMappingEntry(rl, 'lint', rubricRow);
        expect(result.severity).toBe('errors');
    });

    it('omits commentCell when empty', async () => {
        const rl = mockDriver(['3']);
        const result = await buildMappingEntry(rl, 'build_check', rubricRowNoComment);
        expect(result.type).toBe('build_check');
        expect(result.cell).toBe('C10');
        expect(result.maxScore).toBe(3);
        expect(result.commentCell).toBeUndefined();
    });

    it('builds a deploy_check entry', async () => {
        const rl = mockDriver(['4']);
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
        const rl = mockDriver(['4']);
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
        const rl = mockDriver(['2', 'F20']);
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
        const rl = mockDriver(['3', '']);
        const result = await buildMappingEntry(rl, 'github_repo', rubricRow);
        expect(result.linkCell).toBeUndefined();
    });

    it('builds generic entry for build_check', async () => {
        const rl = mockDriver(['1']);
        const result = await buildMappingEntry(rl, 'build_check', rubricRow);
        expect(result).toEqual({
            type: 'build_check',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 1
        });
    });

    it('builds generic entry for browser_check', async () => {
        const rl = mockDriver(['1']);
        const result = await buildMappingEntry(rl, 'browser_check', rubricRow);
        expect(result.type).toBe('browser_check');
        expect(result.cell).toBe('C8');
        expect(result.maxScore).toBe(1);
    });

    it('builds generic entry for code_review', async () => {
        const rl = mockDriver(['2']);
        const result = await buildMappingEntry(rl, 'code_review', rubricRow);
        expect(result).toEqual({
            type: 'code_review',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 2
        });
    });

    it('builds generic entry for package_check', async () => {
        const rl = mockDriver(['3']);
        const result = await buildMappingEntry(rl, 'package_check', rubricRow);
        expect(result).toEqual({
            type: 'package_check',
            cell: 'C8',
            commentCell: 'E8',
            maxScore: 3
        });
    });

    it('builds generic entry for repo_hygiene', async () => {
        const rl = mockDriver(['1']);
        const result = await buildMappingEntry(rl, 'repo_hygiene', rubricRow);
        expect(result.type).toBe('repo_hygiene');
        expect(result.maxScore).toBe(1);
    });

    it('builds a developer_comments entry with the AI-disclosure toggle off by default', async () => {
        const rl = mockDriver(['1', ''], { strict: true });
        const result = await buildMappingEntry(rl, 'developer_comments', rubricRow);
        expect(result).toMatchObject({ type: 'developer_comments', maxScore: 1, requireAiDisclosure: false });
    });

    it('developer_comments: answering yes turns the AI-disclosure toggle on', async () => {
        const rl = mockDriver(['1', 'y'], { strict: true });
        const result = await buildMappingEntry(rl, 'developer_comments', rubricRow);
        expect(result.requireAiDisclosure).toBe(true);
    });

    it('builds generic entry for part_completed', async () => {
        const rl = mockDriver(['10']);
        const result = await buildMappingEntry(rl, 'part_completed', rubricRow);
        expect(result.type).toBe('part_completed');
        expect(result.maxScore).toBe(10);
    });

    it('builds generic entry for apps_in_repo', async () => {
        const rl = mockDriver(['10']);
        const result = await buildMappingEntry(rl, 'apps_in_repo', rubricRow);
        expect(result.type).toBe('apps_in_repo');
    });

    it('builds generic entry for npm_package', async () => {
        const rl = mockDriver(['3']);
        const result = await buildMappingEntry(rl, 'npm_package', rubricRow);
        expect(result.type).toBe('npm_package');
    });

    it('returns maxScore from numeric input', async () => {
        const rl = mockDriver(['5']);
        const result = await buildMappingEntry(rl, 'build_check', rubricRow);
        expect(result.maxScore).toBe(5);
    });
});

// ── copyRubric ──────────────────────────────────────────────────────────

describe('copyRubric', () => {
    let tmpDir;
    const realRubric = LAB04_RUBRIC;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'configure_lab_test_'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns rubricName and rubricPath when user provides an existing file path', async () => {
        const rl = mockDriver([realRubric, '']);  // '' accepts default filename
        const result = await copyRubric(rl, 'Lab04');
        expect(result).toHaveProperty('rubricName');
        expect(result).toHaveProperty('rubricPath');
        expect(result.rubricName).toMatch(/\.xlsm$/i);
        expect(result.rubricPath).toBe(realRubric);
    });

    it('re-prompts when the user enters a non-existent path, then accepts a valid one', async () => {
        const rl = mockDriver(['/nonexistent/path.xlsx', realRubric, '']);  // '' accepts default filename
        const result = await copyRubric(rl, 'Lab04');
        expect(result.rubricPath).toBe(realRubric);
    });
});

// ── writeLab ────────────────────────────────────────────────────────────

describe('writeLab', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'configure_lab_test_'));
        mkdirSync(join(tmpDir, 'Lab99'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes a valid config JSON file', () => {
        const labDir = join(tmpDir, 'Lab99');
        const config = { rubricName: 'r.xlsm', mappings: [] };
        writeLab(labDir, config, null, null);
        const written = JSON.parse(readFileSync(join(labDir, 'lab99_config.json'), 'utf8'));
        expect(written).toEqual(config);
    });

    it('writes the analyzer file when analyzerContent is provided', () => {
        const labDir = join(tmpDir, 'Lab99');
        const config = { rubricName: 'r.xlsm', mappings: [] };
        writeLab(labDir, config, 'module.exports = () => {};', 'lab99_analyzer.js');
        const content = readFileSync(join(labDir, 'lab99_analyzer.js'), 'utf8');
        expect(content).toBe('module.exports = () => {};');
    });

    it('does not write analyzer file when analyzerContent is null', () => {
        const labDir = join(tmpDir, 'Lab99');
        writeLab(labDir, { rubricName: 'r.xlsm', mappings: [] }, null, null);
        expect(existsSync(join(labDir, 'lab99_analyzer.js'))).toBe(false);
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

    it('guesses apps_in_repo when "app" appears near "repo"', () => {
        expect(guessMappingType('App in a private GitHub repository')).toBe('apps_in_repo');
        expect(guessMappingType('Apps in private GitHub repo')).toBe('apps_in_repo');
    });

    it('still guesses github_repo when no "app" mention', () => {
        expect(guessMappingType('GitHub private repo')).toBe('github_repo');
        expect(guessMappingType('github repo link')).toBe('github_repo');
    });

    it('guesses manual for folder/file organization (not naming convention)', () => {
        expect(guessMappingType('Folder and file organization and naming')).toBe('manual');
        expect(guessMappingType('File organization')).toBe('manual');
    });

    it('still guesses name_check for naming convention rows', () => {
        expect(guessMappingType('Directory structure and file naming')).toBe('name_check');
        expect(guessMappingType('Folder structure and file names')).toBe('name_check');
    });

    it('guesses env_file_check for .env API key rows', () => {
        expect(guessMappingType('API key stored in .env file')).toBe('env_file_check');
        expect(guessMappingType('.env file exists with API key')).toBe('env_file_check');
    });

    it('guesses gitignore_check for .env excluded from repo rows', () => {
        expect(guessMappingType('.env excluded from repo .gitignore')).toBe('gitignore_check');
        expect(guessMappingType('.env in .gitignore')).toBe('gitignore_check');
        // Must NOT fall into env_file_check — both mention ".env file" but intent is different
        expect(guessMappingType('.env file excluded from repo (.gitignore)?')).toBe('gitignore_check');
    });

    it('guesses path_exists for "file exists at path" rows', () => {
        expect(guessMappingType('File exists at functions/api/proxy.js')).toBe('path_exists');
        expect(guessMappingType('Proxy file created at functions/')).toBe('path_exists');
    });

    it('guesses manual (not env_file_check) when label says "environment variable" but not ".env"', () => {
        // Row 6: "Function reads API key from Cloudflare environment variable?" — no ".env" token
        // Should fall through to manual because it requires runtime/human inspection
        expect(guessMappingType('Function reads API key from Cloudflare environment variable?')).toBe('manual');
        expect(guessMappingType('reads api key from environment')).toBe('manual');
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
        const llm = rows.map(() => ({ type: 'feature', featureId: 'made-up', maxScore: 5 }));
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

// ── promptVariations / assembleConfig variations ─────────────────────────

import { promptVariations } from '../src/lib/config_prompts.js';
import { mockDriver as _variationDriver } from './helpers/mock_driver.mjs';

describe('promptVariations', () => {
    it('returns undefined (leave untouched) when there are no versions', async () => {
        const d = _variationDriver(['n'], { strict: true });
        expect(await promptVariations(d, undefined)).toBeUndefined();
    });

    it('collects letters and app names', async () => {
        const d = _variationDriver(['y', '', 'Schedule sections', 'y', '', 'Flights', 'n'], { strict: true });
        expect(await promptVariations(d, undefined)).toEqual({
            A: { appName: 'Schedule sections' },
            B: { appName: 'Flights' },
        });
    });

    it('shows existing values as defaults and keeps each group\'s overrides', async () => {
        const existing = { A: { appName: 'Old A', overrides: { runCheck: { entry: 'a.py' } } } };
        const d = _variationDriver(['y', '', '', 'New A', 'n'], { strict: true });   // has versions, keep A, letter, app name, add another
        const r = await promptVariations(d, existing);
        expect(r).toEqual({ A: { appName: 'New A', overrides: { runCheck: { entry: 'a.py' } } } });
        const asks = d.calls.filter(c => c.method === 'ask');
        expect(asks[0].def).toBe('A');
        expect(asks[1].def).toBe('Old A');
    });

    it('can drop one existing version and keep the others', async () => {
        const existing = {
            A: { appName: 'Sections', overrides: { runCheck: { entry: 'a.py' } } },
            B: { appName: 'Flights' },
            C: { appName: 'Vans', overrides: { runCheck: { entry: 'c.py' } } },
        };
        // has versions; keep A (letter, name); drop B; keep C (letter, name); add another: no
        const d = _variationDriver(['y', '', '', '', 'n', '', '', '', 'n'], { strict: true });
        expect(await promptVariations(d, existing)).toEqual({
            A: { appName: 'Sections', overrides: { runCheck: { entry: 'a.py' } } },
            C: { appName: 'Vans', overrides: { runCheck: { entry: 'c.py' } } },
        });
    });

    it('dropping every existing version removes the section; a re-added letter starts fresh', async () => {
        const existing = { A: { appName: 'Old', overrides: { runCheck: { entry: 'a.py' } } } };
        expect(await promptVariations(_variationDriver(['y', 'n', 'n'], { strict: true }), existing)).toBeNull();
        // drop A, add another: yes, letter A, new name, add another: no
        expect(await promptVariations(_variationDriver(['y', 'n', 'y', 'A', 'New', 'n'], { strict: true }), existing))
            .toEqual({ A: { appName: 'New' } });
    });

    it('answering no on a lab with versions keeps them unless removal is confirmed', async () => {
        const existing = { A: { appName: 'A' } };
        expect(await promptVariations(_variationDriver(['n', 'n'], { strict: true }), existing)).toBeUndefined();
        expect(await promptVariations(_variationDriver(['n', 'y'], { strict: true }), existing)).toBeNull();
    });

    it('assembleConfig sets, removes or leaves variations', () => {
        const base = { rubricName: 'r.xlsx', runtimeCheck: 'none', mappings: [] };
        const ex = { variations: { A: { appName: 'a' } } };
        expect(assembleConfig(ex, { ...base }).variations).toEqual(ex.variations);
        expect(assembleConfig(ex, { ...base, variations: null }).variations).toBeUndefined();
        expect(assembleConfig(null, { ...base, variations: { B: { appName: 'b' } } }).variations).toEqual({ B: { appName: 'b' } });
    });
});

// ── file picker (TUI driver.pickPath) ────────────────────────────────────

import { askPath, setRecentPathsFile, getRecentPaths } from '../src/lib/path_browser.js';
import os from 'os';
import fs from 'fs';
import path from 'path';

describe('file picker integration', () => {
    function pickerDriver(picks, answers = []) {
        const d = _variationDriver(answers, { strict: true });
        const seen = [];
        d.pickPath = async (opts) => { seen.push(opts); return picks.shift() ?? ''; };
        return { d, seen };
    }

    it('copyRubric browses for the file when the driver has a picker', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rub-'));
        const file = path.join(dir, 'R.xlsm');
        fs.writeFileSync(file, 'x');
        const { d, seen } = pickerDriver([file], ['']);   // accept the suggested filename
        const r = await copyRubric(d, 'Lab01', 'CIS195');
        expect(r.rubricPath).toBe(file);
        expect(r.rubricName).toBe('CIS195_Lab01_Rubric.xlsm');
        expect(seen[0]).toMatchObject({ kind: 'file', extensions: ['.xlsx', '.xlsm'] });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('askPath falls back to a typed path when the picker is cancelled', async () => {
        const { d } = pickerDriver([''], ['/tmp/typed/place']);
        expect(await askPath(d, { prompt: 'Code folder', kind: 'dir' })).toBe(path.resolve('/tmp/typed/place'));
        const { d: d2 } = pickerDriver([''], ['']);
        expect(await askPath(d2, { prompt: 'Code folder', kind: 'dir' })).toBe('');
    });

    describe('recent paths', () => {
        let tmp, cfgFile, a, b;
        beforeEach(() => {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-'));
            cfgFile = path.join(tmp, 'local-config.json');
            fs.writeFileSync(cfgFile, JSON.stringify({ terms: { x: 1 } }));
            a = path.join(tmp, 'a'); b = path.join(tmp, 'b');
            fs.mkdirSync(a); fs.mkdirSync(b);
            setRecentPathsFile(cfgFile);
        });
        afterEach(() => { setRecentPathsFile(null); fs.rmSync(tmp, { recursive: true, force: true }); });

        it('remembers chosen paths (most recent first, no duplicates) and keeps other config', async () => {
            await askPath(pickerDriver([a]).d, { prompt: 'Folder', kind: 'dir' });
            await askPath(pickerDriver([b], ['2']).d, { prompt: 'Folder', kind: 'dir' });
            expect(getRecentPaths('Folder', 'dir')).toEqual([b, a]);
            expect(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).terms).toEqual({ x: 1 });
        });

        it('offers recent paths first and returns the one picked without browsing', async () => {
            await askPath(pickerDriver([a]).d, { prompt: 'Folder', kind: 'dir' });
            const { d, seen } = pickerDriver([], ['1']);
            expect(await askPath(d, { prompt: 'Folder', kind: 'dir' })).toBe(a);
            expect(seen).toHaveLength(0);
        });

        it('skips recent paths that no longer exist', async () => {
            await askPath(pickerDriver([a]).d, { prompt: 'Folder', kind: 'dir' });
            fs.rmSync(a, { recursive: true });
            expect(getRecentPaths('Folder', 'dir')).toEqual([]);
        });

        it('returns to the recent list when browsing is cancelled', async () => {
            await askPath(pickerDriver([a]).d, { prompt: 'Folder', kind: 'dir' });
            // Browse -> picker Esc -> typed path blank -> back to list -> pick recent
            const { d } = pickerDriver([''], ['2', '', '1']);
            expect(await askPath(d, { prompt: 'Folder', kind: 'dir' })).toBe(a);
        });
    });
});

// ── promptAiCheckSettings / promptSkipStudents / assembleConfig ──────────

import { promptAiCheckSettings, promptSkipStudents } from '../src/lib/config_prompts.js';
import { assembleConfig as _assemble } from '../src/lib/lab_config.js';

describe('promptAiCheckSettings', () => {
    it('asks nothing when the lab has no llm_check rows', async () => {
        const d = _variationDriver([], { strict: true });
        expect(await promptAiCheckSettings(d, undefined, false)).toBeUndefined();
        expect(d.calls).toHaveLength(0);
    });

    it('builds an OpenAI-compatible setting from the address and model', async () => {
        const d = _variationDriver(['openai', 'https://api.deepseek.com', 'deepseek-flash'], { strict: true });
        expect(await promptAiCheckSettings(d, undefined, true)).toEqual({
            provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
        });
    });

    it('keeps the hand-edited keys when the provider stays the same, and removes the block for Ollama', async () => {
        const existing = { provider: 'openai', baseUrl: 'https://x.example', model: 'm', concurrency: 8, redactTerms: ['bob'] };
        const kept = await promptAiCheckSettings(_variationDriver(['openai', '', ''], { strict: true }), existing, true);
        expect(kept).toMatchObject({ provider: 'openai', baseUrl: 'https://x.example', model: 'm', concurrency: 8, redactTerms: ['bob'] });
        expect(await promptAiCheckSettings(_variationDriver(['ollama'], { strict: true }), existing, true)).toBeNull();
        expect(await promptAiCheckSettings(_variationDriver(['ollama'], { strict: true }), undefined, true)).toBeUndefined();
    });
});

describe('promptSkipStudents and assembleConfig', () => {
    it('splits a comma list, and treats blank as none', async () => {
        expect(await promptSkipStudents(_variationDriver(['Test Student, Ann Lee'], { strict: true }), undefined)).toEqual(['Test Student', 'Ann Lee']);
        expect(await promptSkipStudents(_variationDriver([' '], { strict: true }), undefined)).toBeUndefined();
        expect(await promptSkipStudents(_variationDriver([' '], { strict: true }), ['Old'])).toBeNull();
    });

    it('assembleConfig sets, removes or leaves llmCheck and skipStudents', () => {
        const base = { rubricName: 'R', runtimeCheck: 'build', mappings: [] };
        const existing = { llmCheck: { provider: 'openai' }, skipStudents: ['A'] };
        expect(_assemble(existing, base)).toMatchObject(existing);
        const gone = _assemble(existing, { ...base, llmCheck: null, skipStudents: null });
        expect(gone.llmCheck).toBeUndefined();
        expect(gone.skipStudents).toBeUndefined();
        expect(_assemble({}, { ...base, skipStudents: ['B'] }).skipStudents).toEqual(['B']);
    });
});
