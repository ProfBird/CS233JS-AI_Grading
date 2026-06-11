/**
 * generate_grades.spec.mjs
 *
 * Tests for the grade handler functions and the handler registry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as fs from 'fs';
import * as XLSX from 'xlsx';
import { getHandler, registerHandler, VALID_MAPPING_TYPES, isCodeSourceType, resolveOutputPath, stockCommentFor, computeResults } from '../src/pipeline/generate_grades.js';

// The xlsx ESM build does not auto-wire Node's fs; writeFile needs set_fs() first.
XLSX.set_fs(fs);

// ── stock comments by score tier ────────────────────────────────────────────
describe('stockCommentFor', () => {
    const sc = { full: 'Good', partial: 'Errors', zero: 'Missing' };

    it('returns the full-tier comment at max score', () => {
        expect(stockCommentFor({ type: 'lint', maxScore: 6, stockComments: sc }, 6)).toBe('Good');
    });

    it('returns the partial-tier comment for a middle score', () => {
        expect(stockCommentFor({ type: 'lint', maxScore: 6, stockComments: sc }, 3)).toBe('Errors');
    });

    it('returns the zero-tier comment at or below zero', () => {
        expect(stockCommentFor({ type: 'lint', maxScore: 6, stockComments: sc }, 0)).toBe('Missing');
    });

    it('exempts manual rows so a human still grades them', () => {
        expect(stockCommentFor({ type: 'manual', maxScore: 6, stockComments: sc }, 6)).toBeNull();
    });

    it('returns null when the mapping has no stock comments', () => {
        expect(stockCommentFor({ type: 'lint', maxScore: 6 }, 6)).toBeNull();
    });

    it('returns null when the matching tier text is empty', () => {
        expect(stockCommentFor({ type: 'lint', maxScore: 6, stockComments: { full: 'Good' } }, 3)).toBeNull();
    });
});

// ── html_validate / css_validate handlers ───────────────────────────────────
describe('html_validate handler', () => {
    const handler = getHandler('html_validate');
    const map = { type: 'html_validate', maxScore: 6, tolerance: 3 };

    it('awards full marks for zero errors', () => {
        expect(handler(map, { htmlValidation: { htmlFiles: 1, errors: 0 } }).score).toBe(6);
    });
    it('awards half (rounded, min 1) within tolerance', () => {
        const r = handler(map, { htmlValidation: { htmlFiles: 1, errors: 2, messages: ['x: 2'] } });
        expect(r.score).toBe(3);
    });
    it('awards zero beyond tolerance', () => {
        expect(handler(map, { htmlValidation: { htmlFiles: 1, errors: 9, messages: ['x: 9'] } }).score).toBe(0);
    });
    it('scores zero with a clear note when there are no HTML files', () => {
        const r = handler(map, { htmlValidation: { htmlFiles: 0, errors: 0 } });
        expect(r.score).toBe(0);
        expect(r.comment).toMatch(/no html files/i);
    });
    it('tolerates a missing htmlValidation object', () => {
        expect(handler(map, {}).score).toBe(0);
    });
    it('includes warning count in comment when errors=0 but warnings>0', () => {
        const r = handler(map, { htmlValidation: { htmlFiles: 1, errors: 0, warnings: 3, messages: ['no-implicit-button-type: 3'] } });
        expect(r.score).toBe(6);
        expect(r.comment).toMatch(/no errors/i);
        expect(r.comment).toMatch(/3 warnings/i);
        expect(r.comment).toMatch(/no-implicit-button-type/i);
    });
    it('includes warning count alongside error count in the comment', () => {
        const r = handler(map, { htmlValidation: { htmlFiles: 1, errors: 2, warnings: 4, messages: ['void-style: 4', 'doctype-style: 2'] } });
        expect(r.score).toBe(3);
        expect(r.comment).toMatch(/2 HTML errors/i);
        expect(r.comment).toMatch(/4 warnings/i);
    });
    it('does not mention warnings when warnings=0', () => {
        const r = handler(map, { htmlValidation: { htmlFiles: 1, errors: 2, warnings: 0, messages: ['x: 2'] } });
        expect(r.comment).not.toMatch(/warning/i);
    });
});

describe('css_validate handler', () => {
    const handler = getHandler('css_validate');
    const map = { type: 'css_validate', maxScore: 4 };  // default tolerance 3

    it('awards full marks for zero errors', () => {
        expect(handler(map, { cssValidation: { cssFiles: 1, errors: 0 } }).score).toBe(4);
    });
    it('awards zero beyond the default tolerance', () => {
        expect(handler(map, { cssValidation: { cssFiles: 1, errors: 5, messages: ['x: 5'] } }).score).toBe(0);
    });
});

describe('name_check handler', () => {
    const handler = getHandler('name_check');
    const map = { type: 'name_check', maxScore: 2, tolerance: 2 };

    it('awards full marks when there are no invalid names', () => {
        const r = handler(map, { nameCheck: { entriesChecked: 8, errors: 0 } });
        expect(r.score).toBe(2);
        expect(r.comment).toMatch(/all file\/folder names are valid/i);
    });
    it('awards half (min 1) within tolerance and lists offenders', () => {
        const r = handler(map, { nameCheck: { entriesChecked: 8, errors: 2, messages: ['my file.js (space)', 'bad dir (space)'] } });
        expect(r.score).toBe(1);
        expect(r.comment).toMatch(/my file\.js/);
    });
    it('awards zero beyond tolerance', () => {
        expect(handler(map, { nameCheck: { entriesChecked: 8, errors: 5, messages: ['x (space)'] } }).score).toBe(0);
    });
    it('scores zero with a note when there are no files to check (empty submission)', () => {
        const r = handler(map, { nameCheck: { entriesChecked: 0, errors: 0 } });
        expect(r.score).toBe(0);
        expect(r.comment).toMatch(/no files to check/i);
    });
});

// ── manual handler: ambiguous-but-filled prod cell must not auto-score 0 ──────
describe('manual handler — prod cell filled but not affirmative', () => {
    const handler = getHandler('manual');
    const itemStudent = item => ({ codeReview: { found: true, items: [item] } });
    const map = { type: 'manual', maxScore: 5, msg: 'CHECK', _reviewIndex: 0 };

    it('falls through to the beta score (not 0) when prod is filled with "-"/"NA" (affirmative null)', () => {
        const r = handler(map, itemStudent({ betaScore: 4, prodScore: null, prodFilled: true, prodAffirmative: null }));
        expect(r.score).toBe(4);
        expect(r.comment).toContain('Beta score: 4');
    });

    it('flags for manual review when prod is ambiguous and there is no beta score', () => {
        const r = handler(map, itemStudent({ betaScore: null, prodScore: null, prodFilled: true, prodAffirmative: null }));
        expect(r.score).toBe(5);          // maxScore fallback (NEEDS MANUAL CHECK path)
        expect(r.comment).toBe('CHECK');
    });

    it('still auto-scores an affirmative prod cell (regression guard for the gate)', () => {
        expect(handler(map, itemStudent({ betaScore: null, prodScore: null, prodFilled: true, prodAffirmative: true })).score).toBe(5);
        expect(handler(map, itemStudent({ betaScore: null, prodScore: null, prodFilled: true, prodAffirmative: false })).score).toBe(0);
    });
});

// ── stock comments wired into computeResults ─────────────────────────────────
describe('computeResults — stock comment override', () => {
    const sc = { full: 'Good', partial: 'Errors', zero: 'Missing' };
    const config = { mappings: [
        { type: 'lint', severity: 'errors', cell: 'D7', commentCell: 'F7', maxScore: 6, stockComments: sc },
    ] };

    it('writes the full-tier stock comment when the handler scores max', async () => {
        const student = { lint: { jsFiles: 1, errors: 0 } };
        const [r] = await computeResults(student, config);
        expect(r.score).toBe(6);
        expect(r.comment).toBe('Good');           // overrode handler's "No syntax errors"
    });

    it('writes the zero-tier stock comment when the handler scores 0', async () => {
        const student = { lint: { jsFiles: 1, errors: 4 } };
        const [r] = await computeResults(student, config);
        expect(r.score).toBe(0);
        expect(r.comment).toBe('Missing');
    });

    it('leaves manual rows with their own comment (exempt)', async () => {
        const manualCfg = { mappings: [
            { type: 'manual', cell: 'D7', commentCell: 'F7', maxScore: 6, msg: 'CHECK ME', stockComments: sc },
        ] };
        const [r] = await computeResults({}, manualCfg);
        expect(r.comment).toContain('CHECK ME');  // not 'Good'/'Missing'
    });

    it('keeps the real html_validate error detail instead of partial stock comment', async () => {
        const cfg = { mappings: [
            { type: 'html_validate', cell: 'D7', commentCell: 'F7', maxScore: 6, tolerance: 3, stockComments: sc },
        ] };
        const student = { htmlValidation: { htmlFiles: 1, errors: 2, messages: ['x: 2'] } };
        const [r] = await computeResults(student, cfg);
        expect(r.score).toBe(3);                            // half of 6
        expect(r.comment).toBe('2 HTML errors (x: 2)');    // keepComment: true — stock not applied
    });

    it('keeps the real name_check failure description instead of stock comment', async () => {
        const cfg = { mappings: [
            { type: 'name_check', cell: 'D7', commentCell: 'F7', maxScore: 2, tolerance: 2, stockComments: sc },
        ] };
        const student = { nameCheck: { entriesChecked: 8, errors: 5, messages: ['a (space)'] } };
        const [r] = await computeResults(student, cfg);
        expect(r.score).toBe(0);
        expect(r.comment).toContain('5 invalid names');  // real description, not stock 'Missing'
        expect(r.comment).toContain('a (space)');
    });
});

// ── deploy_check failure transparency ────────────────────────────────────────
// A grader-side network failure (thrown fetch) or an HTTP error must NOT be silently
// scored as a stock "No" — it is indistinguishable from real non-deployment otherwise.
// These flag for manual review and keep their diagnostic through the stock override.
describe('deploy_check — failure comments survive stock override', () => {
    const sc = { full: 'Yes', partial: 'Bad URL', zero: 'No' };
    const cfg = { mappings: [
        { type: 'deploy_check', cell: 'D18', commentCell: 'F18', maxScore: 4, urlType: 'citstudent', stockComments: sc },
    ] };
    const student = { analysis: { urls: { citstudent: 'https://citstudent.lanecc.edu/~x/dist/' } } };

    afterEach(() => { vi.unstubAllGlobals(); });

    it('keeps the connection-error diagnostic instead of stock "No"', async () => {
        const err = new Error('socket hang up'); err.code = 'ECONNRESET';
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
        const [r] = await computeResults(student, cfg);
        expect(r.score).toBe(0);
        expect(r.comment).not.toBe('No');
        expect(r.comment).toContain('NEEDS MANUAL CHECK');
        expect(r.comment).toContain('ECONNRESET');
    }, 20000);

    it('keeps the HTTP-status diagnostic instead of stock "No"', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
        const [r] = await computeResults(student, cfg);
        expect(r.score).toBe(0);
        expect(r.comment).not.toBe('No');
        expect(r.comment).toContain('HTTP 503');
    });

    it('still applies stock "Yes" when reachable and bundled', async () => {
        const html = '<script type="module" src="./assets/index-AbC12345.js"></script>';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => html }));
        const [r] = await computeResults(student, cfg);
        expect(r.score).toBe(4);
        expect(r.comment).toBe('Yes');
    });
});

// ── Registry ───────────────────────────────────────────────────────────────

describe('handler registry', () => {
    it('exports VALID_MAPPING_TYPES containing all built-in types', () => {
        expect(VALID_MAPPING_TYPES).toBeInstanceOf(Set);
        expect(VALID_MAPPING_TYPES.has('feature')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('manual')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('lint')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('build_check')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('browser_check')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('url_check')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('developer_comments')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('code_review')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('apps_in_repo')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('part1_completed')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('part_completed')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('part_feature')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('env_file_check')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('path_exists')).toBe(true);
    });

    it('returns a handler for each valid type', () => {
        for (const type of VALID_MAPPING_TYPES) {
            expect(getHandler(type), `handler for "${type}"`).toBeInstanceOf(Function);
        }
    });

    it('returns undefined for unknown types', () => {
        expect(getHandler('nonexistent')).toBeUndefined();
    });

    it('registerHandler throws on duplicate registration', () => {
        expect(() => registerHandler('feature', () => {})).toThrow('already registered');
    });

    it('registerHandler adds handler and updates VALID_MAPPING_TYPES', async () => {
        // vi.resetModules() clears the module cache so the dynamic import below
        // gets a fresh instance — isolated from the shared registry the other
        // tests depend on. The top-level `import` bindings are unaffected.
        vi.resetModules();
        const fresh = await import('../src/pipeline/generate_grades.js');
        const { getHandler: gh, registerHandler: rh, VALID_MAPPING_TYPES: vmt } = fresh;
        const custom = () => ({ score: 42, comment: 'custom' });
        rh('test_isolated', custom);
        expect(gh('test_isolated')).toBe(custom);
        expect(gh('test_isolated')({}, {})).toEqual({ score: 42, comment: 'custom' });
        expect(vmt.has('test_isolated')).toBe(true);
    });
});

// ── isCodeSourceType ───────────────────────────────────────────────────────

describe('isCodeSourceType', () => {
    it('returns true for apps_in_repo', () => {
        expect(isCodeSourceType({ type: 'apps_in_repo' })).toBe(true);
    });

    it('returns true for part1_completed', () => {
        expect(isCodeSourceType({ type: 'part1_completed' })).toBe(true);
    });

    it('returns true for part_completed', () => {
        expect(isCodeSourceType({ type: 'part_completed' })).toBe(true);
    });

    it('returns true for url_check with urlType github', () => {
        expect(isCodeSourceType({ type: 'url_check', urlType: 'github' })).toBe(true);
    });

    it('returns false for url_check with urlType citstudent', () => {
        expect(isCodeSourceType({ type: 'url_check', urlType: 'citstudent' })).toBe(false);
    });

    it('returns false for url_check with no urlType', () => {
        expect(isCodeSourceType({ type: 'url_check' })).toBe(false);
    });

    it('returns false for feature type', () => {
        expect(isCodeSourceType({ type: 'feature', featureId: 'classes' })).toBe(false);
    });

    it('returns false for lint type', () => {
        expect(isCodeSourceType({ type: 'lint' })).toBe(false);
    });
});

// ── feature handler ────────────────────────────────────────────────────────

describe('feature handler', () => {
    const handler = getHandler('feature');

    it('returns maxScore when count meets minCount (default 1)', () => {
        const map = { featureId: 'classes', maxScore: 5, successMsg: 'Yes', failMsg: 'Missing' };
        const student = { analysis: { features: { classes: 3 } } };
        expect(handler(map, student)).toEqual({ score: 5, comment: 'Yes (3 found)' });
    });

    it('returns 0 when count is below minCount', () => {
        const map = { featureId: 'classes', maxScore: 5, minCount: 3, successMsg: 'Yes', failMsg: 'Missing' };
        const student = { analysis: { features: { classes: 1 } } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Missing (only 1 found)' });
    });

    it('treats boolean feature values as presence check', () => {
        const map = { featureId: 'modules', maxScore: 6, successMsg: 'Yes', failMsg: 'Missing' };
        const present = { analysis: { features: { modules: true } } };
        expect(handler(map, present)).toEqual({ score: 6, comment: 'Yes (1 found)' });
    });

    it('returns 0 for missing feature', () => {
        const map = { featureId: 'nonexistent', maxScore: 2 };
        const student = { analysis: { features: { classes: 1 } } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Missing (only 0 found)' });
    });

    it('handles empty features object', () => {
        const map = { featureId: 'classes', maxScore: 5 };
        expect(handler(map, { analysis: { features: {} } })).toEqual({ score: 0, comment: 'Missing (only 0 found)' });
    });

    it('handles missing analysis', () => {
        const map = { featureId: 'classes', maxScore: 5 };
        expect(handler(map, {})).toEqual({ score: 0, comment: 'Missing (only 0 found)' });
    });

    it('returns maxScore when count exactly equals minCount', () => {
        const map = { featureId: 'classes', maxScore: 5, minCount: 2 };
        const student = { analysis: { features: { classes: 2 } } };
        expect(handler(map, student)).toEqual({ score: 5, comment: 'Yes (2 found)' });
    });
});

// ── part1_completed handler ────────────────────────────────────────────────

describe('part1_completed handler', () => {
    const handler = getHandler('part1_completed');

    it('returns maxScore when part1 is present in partPresence', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: { part1: true } } };
        expect(handler(map, student)).toEqual({ score: 10, comment: 'part1 files found' });
    });

    it('returns 0 when part1 is false', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: { part1: false } } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'part1 files not found' });
    });

    it('returns 0 when partPresence is empty', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: {} } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'part1 files not found' });
    });

    it('supports custom partId from map', () => {
        const map = { maxScore: 10, partId: 'part2' };
        const student = { analysis: { partPresence: { part2: true } } };
        expect(handler(map, student)).toEqual({ score: 10, comment: 'part2 files found' });
    });

    it('handles missing analysis', () => {
        const map = { maxScore: 10 };
        expect(handler(map, {})).toEqual({ score: 0, comment: 'part1 files not found' });
    });
});

// ── part_completed handler (generic) ───────────────────────────────────────

describe('part_completed handler', () => {
    const handler = getHandler('part_completed');

    it('returns maxScore for detected part', () => {
        const map = { maxScore: 5, partId: 'part3' };
        const student = { analysis: { partPresence: { part3: true } } };
        expect(handler(map, student)).toEqual({ score: 5, comment: 'part3 files found' });
    });

    it('returns 0 when part not detected', () => {
        const map = { maxScore: 5, partId: 'part3' };
        const student = { analysis: { partPresence: { part3: false } } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'part3 files not found' });
    });

    it('defaults to part1 when no partId specified', () => {
        const map = { maxScore: 5 };
        const student = { analysis: { partPresence: { part1: true } } };
        expect(handler(map, student)).toEqual({ score: 5, comment: 'part1 files found' });
    });
});

// ── apps_in_repo handler ───────────────────────────────────────────────────

describe('apps_in_repo handler', () => {
    const handler = getHandler('apps_in_repo');

    it('returns maxScore when allPresent and github url exist', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: { allPresent: true, part1: true, part2: true }, urls: { github: 'https://github.com/user/repo' } } };
        expect(handler(map, student)).toEqual({ score: 10, comment: 'Yes (Both apps found in GitHub repo)' });
    });

    it('returns 0 when no GitHub url', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: { allPresent: true } } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Missing GitHub repository' });
    });

    it('returns 0 when apps not all present', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: { allPresent: false, part1: true, part2: false }, urls: { github: 'https://github.com/user/repo' } } };
        const result = handler(map, student);
        expect(result.score).toBe(0);
        expect(result.comment).toContain('Missing folders');
        expect(result.comment).toContain('part1: Yes');
        expect(result.comment).toContain('part2: No');
    });

    it('awards full credit for single-app repo when no parts are configured and repo was cloned', () => {
        const map = { maxScore: 10 };
        const student = {
            extractedDir: '/tmp/someRepo',
            analysis: { partPresence: { allPresent: false }, urls: { github: 'https://github.com/user/repo' } },
        };
        const result = handler(map, student);
        expect(result.score).toBe(10);
        expect(result.comment).toMatch(/yes.*app.*github/i);
    });

    it('returns 0 when GitHub URL present but repo could not be cloned', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: { allPresent: false }, urls: { github: 'https://github.com/user/repo' } } };
        const result = handler(map, student);
        expect(result.score).toBe(0);
        expect(result.comment).toMatch(/could not be cloned/i);
    });

    it('handles missing analysis', () => {
        const map = { maxScore: 10 };
        expect(handler(map, {})).toEqual({ score: 0, comment: 'Missing GitHub repository' });
    });
});

// ── gitignore_check handler ───────────────────────────────────────────────

describe('gitignore_check handler', () => {
    const handler = getHandler('gitignore_check');
    let tmpDir;
    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'gi-test-')); });
    afterEach(() => { rmSync(tmpDir, { recursive: true }); });

    it('returns 0 when no repo extracted', () => {
        expect(handler({ maxScore: 2 }, {})).toEqual({ score: 0, comment: 'No repo extracted' });
    });

    it('returns 0 when .gitignore not found', () => {
        expect(handler({ maxScore: 2 }, { extractedDir: tmpDir })).toEqual({ score: 0, comment: '.gitignore not found' });
    });

    it('gives full credit when .gitignore exists and no requiredEntry', () => {
        writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n');
        expect(handler({ maxScore: 2 }, { extractedDir: tmpDir })).toEqual({ score: 2, comment: 'yes, exists' });
    });

    it('gives full credit when requiredEntry is listed exactly', () => {
        writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\n.env\ndist/\n');
        expect(handler({ maxScore: 2, requiredEntry: '.env' }, { extractedDir: tmpDir })).toEqual({ score: 2, comment: 'yes — .env is listed' });
    });

    it('gives full credit when requiredEntry is listed with leading slash', () => {
        writeFileSync(join(tmpDir, '.gitignore'), '/.env\n');
        expect(handler({ maxScore: 2, requiredEntry: '.env' }, { extractedDir: tmpDir }).score).toBe(2);
    });

    it('returns 0 when requiredEntry is missing from .gitignore', () => {
        writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\ndist/\n');
        const result = handler({ maxScore: 2, requiredEntry: '.env' }, { extractedDir: tmpDir });
        expect(result.score).toBe(0);
        expect(result.comment).toMatch(/\.env.*not listed/i);
    });

    it('ignores comment lines when checking for requiredEntry', () => {
        writeFileSync(join(tmpDir, '.gitignore'), '# .env\nnode_modules/\n');
        const result = handler({ maxScore: 2, requiredEntry: '.env' }, { extractedDir: tmpDir });
        expect(result.score).toBe(0);
    });

    it('gives full credit when requiredEntry is covered by a wildcard pattern (.env*)', () => {
        writeFileSync(join(tmpDir, '.gitignore'), 'node_modules/\n.env*\n');
        expect(handler({ maxScore: 2, requiredEntry: '.env' }, { extractedDir: tmpDir }).score).toBe(2);
    });
});

// ── env_file_check handler ────────────────────────────────────────────────

describe('env_file_check handler', () => {
    const handler = getHandler('env_file_check');
    let tmpDir;
    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'env-test-')); });
    afterEach(() => { rmSync(tmpDir, { recursive: true }); });

    it('gives full credit when .env.local has a KEY=VALUE entry in filesDir', () => {
        const filesDir = mkdtempSync(join(tmpdir(), 'env-files-'));
        try {
            writeFileSync(join(filesDir, '.env.local'), 'MY_SECRET=hello\n');
            const result = handler({ maxScore: 3 }, { filesDir });
            expect(result.score).toBe(3);
            expect(result.comment).toMatch(/key=value/i);
            // Clean finding in filesDir should NOT have a "committed" warning
            expect(result.comment).not.toMatch(/committed/i);
        } finally {
            rmSync(filesDir, { recursive: true });
        }
    });

    it('gives full credit but notes when .env found in extractedDir (committed to repo)', () => {
        writeFileSync(join(tmpDir, '.env'), 'VITE_API_KEY=abc123\n');
        const result = handler({ maxScore: 3 }, { extractedDir: tmpDir });
        expect(result.score).toBe(3);
        expect(result.comment).toMatch(/key=value/i);
        expect(result.comment).toMatch(/committed/i);
        // keepComment protects the diagnostic note from stockComments.full override
        expect(result.keepComment).toBe(true);
    });

    it('filesDir takes precedence over extractedDir when both present', () => {
        const filesDir = mkdtempSync(join(tmpdir(), 'env-files-'));
        try {
            writeFileSync(join(filesDir, '.env'), 'CLEAN_KEY=goodvalue\n');
            writeFileSync(join(tmpDir, '.env'), 'ALSO_KEY=badcommit\n');
            const result = handler({ maxScore: 3 }, { filesDir, extractedDir: tmpDir });
            expect(result.score).toBe(3);
            // Should come from filesDir — no committed warning
            expect(result.comment).not.toMatch(/committed/i);
        } finally {
            rmSync(filesDir, { recursive: true });
        }
    });

    it('gives full credit for lowercase key (api_key=value)', () => {
        writeFileSync(join(tmpDir, '.env'), 'api_key=sk-abc123\n');
        const result = handler({ maxScore: 3 }, { extractedDir: tmpDir });
        expect(result.score).toBe(3);
    });

    it('gives full credit when there are spaces around = (KEY = value)', () => {
        writeFileSync(join(tmpDir, '.env'), 'VITE_API_KEY = sk-abc123\n');
        const result = handler({ maxScore: 3 }, { extractedDir: tmpDir });
        expect(result.score).toBe(3);
    });

    it('returns 0 when .env exists but has no valid KEY=VALUE pair', () => {
        writeFileSync(join(tmpDir, '.env'), '# just a comment\n=nokey\n');
        const result = handler({ maxScore: 3 }, { extractedDir: tmpDir });
        expect(result.score).toBe(0);
        expect(result.comment).toMatch(/no key=value/i);
    });

    it('flags for manual review when no .env found (probably gitignored)', () => {
        const result = handler({ maxScore: 3 }, { extractedDir: tmpDir });
        expect(result.score).toBe(0);
        expect(result.keepComment).toBe(true);
        expect(result.comment).toMatch(/manual check/i);
    });

    it('handles missing extractedDir gracefully', () => {
        const result = handler({ maxScore: 3 }, {});
        expect(result.keepComment).toBe(true);
    });
});

// ── path_exists handler ───────────────────────────────────────────────────

describe('path_exists handler', () => {
    const handler = getHandler('path_exists');
    let tmpDir;
    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'pe-test-')); });
    afterEach(() => { rmSync(tmpDir, { recursive: true }); });

    it('gives full credit when a file matching pathPattern is found', () => {
        mkdirSync(join(tmpDir, 'functions'));
        writeFileSync(join(tmpDir, 'functions', 'proxy.js'), 'export default {}');
        const result = handler({ maxScore: 5, pathPattern: 'functions/' }, { extractedDir: tmpDir });
        expect(result.score).toBe(5);
        expect(result.comment).toMatch(/yes/i);
        expect(result.comment).toMatch(/proxy\.js/);
    });

    it('returns 0 when no file matches pathPattern', () => {
        const result = handler({ maxScore: 5, pathPattern: 'functions/' }, { extractedDir: tmpDir });
        expect(result.score).toBe(0);
        expect(result.comment).toMatch(/not found/i);
    });

    it('flags for manual check when pathPattern is not configured', () => {
        const result = handler({ maxScore: 5 }, { extractedDir: tmpDir });
        expect(result.score).toBe(0);
        expect(result.keepComment).toBe(true);
    });

    it('returns 0 when no repo extracted', () => {
        const result = handler({ maxScore: 5, pathPattern: 'functions/' }, {});
        expect(result.score).toBe(0);
        expect(result.comment).toMatch(/no repo/i);
    });
});

// ── type-set consistency ──────────────────────────────────────────────────

describe('type-set consistency', () => {
    it('every type in lab_config MAPPING_TYPES has a registered handler', async () => {
        const { MAPPING_TYPES } = await import('../src/lib/lab_config.js');
        for (const { value: type } of MAPPING_TYPES) {
            // 'feature' and 'part_feature' use the same handler pool but
            // need a featureId at runtime — skip the schema-only ones.
            if (type === 'feature' || type === 'part_feature') continue;
            expect(getHandler(type), `no handler for type "${type}" from lab_config`).toBeInstanceOf(Function);
        }
    });
});

describe('developer_comments handler', () => {
    const handler = getHandler('developer_comments');

    it('returns maxScore when comments found', () => {
        const map = { maxScore: 1 };
        expect(handler(map, { analysis: { hasDeveloperComments: true } })).toEqual({ score: 1, comment: 'Yes' });
    });

    it('returns 0 when no comments', () => {
        const map = { maxScore: 1 };
        expect(handler(map, { analysis: { hasDeveloperComments: false } })).toEqual({ score: 0, comment: 'Missing name/date comments' });
    });

    it('handles missing analysis', () => {
        expect(getHandler('developer_comments')({ maxScore: 1 }, {})).toEqual({ score: 0, comment: 'Missing name/date comments' });
    });
});

// ── code_review handler ────────────────────────────────────────────────────

describe('code_review handler', () => {
    const handler = getHandler('code_review');

    it('returns maxScore and "yes and yes" when review found and prod column complete', () => {
        const map = { maxScore: 2 };
        const student = { analysis: { hasCodeReview: true }, codeReview: { productionCompleted: true } };
        expect(handler(map, student)).toEqual({ score: 2, comment: 'yes and yes' });
    });

    it('returns half points and "yes and no" when review found but prod column not complete', () => {
        const map = { maxScore: 2 };
        const student = { analysis: { hasCodeReview: true }, codeReview: { productionCompleted: false } };
        expect(handler(map, student)).toEqual({ score: 1, comment: 'yes and no' });
    });

    it('returns 0.5 for maxScore 1 when "yes and no"', () => {
        const map = { maxScore: 1 };
        const student = { analysis: { hasCodeReview: true }, codeReview: { productionCompleted: false } };
        expect(handler(map, student)).toEqual({ score: 0.5, comment: 'yes and no' });
    });

    it('returns 0 and "no and no" when no code review', () => {
        const map = { maxScore: 2 };
        expect(handler(map, { analysis: { hasCodeReview: false } })).toEqual({ score: 0, comment: 'no and no' });
    });

    it('appends group letter when present', () => {
        const map = { maxScore: 1 };
        const student = { analysis: { hasCodeReview: true }, codeReview: { productionCompleted: true, group: 'B' } };
        expect(handler(map, student)).toEqual({ score: 1, comment: 'yes and yes (Group B)' });
    });
});

// ── url_check handler ──────────────────────────────────────────────────────

describe('url_check handler', () => {
    const handler = getHandler('url_check');

    it('returns NEEDS CHECK with url when present', () => {
        const map = { urlType: 'citstudent' };
        const student = { analysis: { urls: { citstudent: 'https://citstudent.lanecc.edu/~user/lab' } } };
        expect(handler(map, student)).toEqual({ score: '', comment: 'NEEDS CHECK: https://citstudent.lanecc.edu/~user/lab' });
    });

    it('returns 0 when urlType not found', () => {
        const map = { urlType: 'citstudent' };
        const student = { analysis: { urls: {} } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'No citstudent URL provided' });
    });

    it('returns 0 when urls missing', () => {
        expect(getHandler('url_check')({ urlType: 'github' }, { analysis: {} })).toEqual({ score: 0, comment: 'No github URL provided' });
    });
});

// ── lint handler ───────────────────────────────────────────────────────────

describe('lint handler', () => {
    const handler = getHandler('lint');

    it('gives maxScore for zero issues', () => {
        const map = { maxScore: 2 };
        expect(handler(map, { lint: { jsFiles: 5, errors: 0, warnings: 0, messages: [] } }))
            .toEqual({ score: 2, comment: 'Excellent - no lint issues' });
    });

    it('gives maxScore for minor issues (<= 10)', () => {
        const map = { maxScore: 2 };
        const result = handler(map, { lint: { jsFiles: 5, errors: 2, warnings: 3, messages: ['rule1: 3', 'rule2: 2'] } });
        expect(result.score).toBe(2);
        expect(result.comment).toContain('Good - 5 minor issues');
    });

    it('gives half score for moderate issues (<= 30)', () => {
        const map = { maxScore: 2 };
        const result = handler(map, { lint: { jsFiles: 5, errors: 10, warnings: 5, messages: ['rule1: 10'] } });
        expect(result.score).toBe(1);
        expect(result.comment).toContain('15 issues');
    });

    it('gives 0 for severe issues (> 30)', () => {
        const map = { maxScore: 2 };
        const result = handler(map, { lint: { jsFiles: 5, errors: 30, warnings: 10, messages: ['rule1: 30'] } });
        expect(result.score).toBe(0);
        expect(result.comment).toContain('40 issues');
    });

    it('scores 0 when there are no JS files', () => {
        const map = { maxScore: 2 };
        expect(handler(map, { lint: { jsFiles: 0, errors: 0, warnings: 0, messages: [] } }))
            .toEqual({ score: 0, comment: 'No JS files to lint' });
    });

    it('scores 0 when lint data is missing', () => {
        const map = { maxScore: 2 };
        expect(handler(map, {})).toEqual({ score: 0, comment: 'No JS files to lint' });
    });

    it('includes top issues in comment', () => {
        const map = { maxScore: 2 };
        const messages = ['no-unused-vars: 5', 'no-undef: 3', 'eqeqeq: 2', 'semi: 1'];
        const result = handler(map, { lint: { jsFiles: 3, errors: 8, warnings: 3, messages } });
        expect(result.comment).toContain('no-unused-vars: 5');
        expect(result.comment).toContain('no-undef: 3');
        expect(result.comment).toContain('eqeqeq: 2');
        expect(result.comment).not.toContain('semi: 1'); // only top 3
    });
});

// ── build_check handler ────────────────────────────────────────────────────

describe('build_check handler', () => {
    const handler = getHandler('build_check');

    it('returns maxScore and "Error free" on success', () => {
        const map = { maxScore: 1 };
        expect(handler(map, { runtimeCheck: { success: true, errors: [] } })).toEqual({ score: 1, comment: 'Error free' });
    });

    it('returns 0 with categorized error types', () => {
        const map = { maxScore: 1 };
        const student = { runtimeCheck: { success: false, errors: ['Build failed', 'Timeout'] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Build: Build failed | Runtime: Timeout' });
    });

    it('returns 0 on failure with empty errors', () => {
        const map = { maxScore: 1 };
        expect(handler(map, { runtimeCheck: { success: false, errors: [] } })).toEqual({ score: 0, comment: 'Build failed' });
    });

    it('handles missing runtimeCheck', () => {
        const map = { maxScore: 1 };
        expect(handler(map, {})).toEqual({ score: 0, comment: 'Build failed' });
    });

    // "both" mode: build_check only scores the build phase
    it('"both" mode: returns maxScore when buildSuccess is true, ignoring browser errors', () => {
        const map = { maxScore: 1 };
        const student = { runtimeCheck: { buildSuccess: true, buildErrors: [], browserSuccess: false, browserErrors: ['TypeError: x is undefined'] } };
        expect(handler(map, student)).toEqual({ score: 1, comment: 'Build successful' });
    });

    it('"both" mode: returns 0 when buildSuccess is false', () => {
        const map = { maxScore: 1 };
        const student = { runtimeCheck: { buildSuccess: false, buildErrors: ['npm run build failed'] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Build failed: npm run build failed' });
    });

    it('"both" mode: returns 0 with generic message when buildErrors is empty', () => {
        const map = { maxScore: 1 };
        const student = { runtimeCheck: { buildSuccess: false, buildErrors: [] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Build failed' });
    });
});

// ── browser_check handler ──────────────────────────────────────────────────

describe('browser_check handler', () => {
    const handler = getHandler('browser_check');

    // "both" mode paths
    it('"both" mode: returns maxScore when build and browser both pass', () => {
        const map = { maxScore: 1 };
        const student = { runtimeCheck: { buildSuccess: true, browserSuccess: true, browserErrors: [] } };
        expect(handler(map, student)).toEqual({ score: 1, comment: 'No console errors' });
    });

    it('"both" mode: returns 0 with error list when browser has console errors', () => {
        const map = { maxScore: 1 };
        const student = { runtimeCheck: { buildSuccess: true, browserSuccess: false, browserErrors: ['TypeError: x is undefined', 'ReferenceError: foo is not defined'] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'TypeError: x is undefined; ReferenceError: foo is not defined' });
    });

    it('"both" mode: returns 0 with skip message when build failed', () => {
        const map = { maxScore: 1 };
        const student = { runtimeCheck: { buildSuccess: false, buildErrors: ['npm run build failed'], browserSuccess: null, browserErrors: [] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Build failed; browser check skipped' });
    });

    it('"both" mode: returns 0 with generic message when browser errors list is empty', () => {
        const map = { maxScore: 1 };
        const student = { runtimeCheck: { buildSuccess: true, browserSuccess: false, browserErrors: [] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Console errors detected' });
    });

    // "browser" mode fallback (no buildSuccess field present)
    it('"browser" mode fallback: returns maxScore on success', () => {
        const map = { maxScore: 2 };
        const student = { runtimeCheck: { success: true, errors: [] } };
        expect(handler(map, student)).toEqual({ score: 2, comment: 'No console errors' });
    });

    it('"browser" mode fallback: returns 0 with errors on failure', () => {
        const map = { maxScore: 2 };
        const student = { runtimeCheck: { success: false, errors: ['SyntaxError in app.js'] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'SyntaxError in app.js' });
    });

    it('"browser" mode fallback: returns 0 with generic message when errors list is empty', () => {
        const map = { maxScore: 2 };
        const student = { runtimeCheck: { success: false, errors: [] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Check failed' });
    });

    it('handles missing runtimeCheck', () => {
        const map = { maxScore: 1 };
        expect(handler(map, {})).toEqual({ score: 0, comment: 'Check failed' });
    });
});

// ── npm_package handler ────────────────────────────────────────────────────

describe('npm_package handler', () => {
    const handler = getHandler('npm_package');

    it('returns maxScore when packages are found', () => {
        const map = { maxScore: 3 };
        const student = { analysis: { npmPackages: ['lena-js', 'canvas-confetti'] } };
        expect(handler(map, student)).toEqual({ score: 3, comment: 'Yes - lena-js, canvas-confetti' });
    });

    it('returns 0 when no packages found', () => {
        const map = { maxScore: 3 };
        expect(handler(map, { analysis: { npmPackages: [] } })).toEqual({ score: 0, comment: 'No npm packages imported' });
        expect(handler(map, {})).toEqual({ score: 0, comment: 'No npm packages imported' });
    });

    it('excludes specified packages before scoring', () => {
        const map = { maxScore: 3, exclude: ['vite', 'bootstrap'] };
        const student = { analysis: { npmPackages: ['lena-js', 'vite', 'bootstrap'] } };
        expect(handler(map, student)).toEqual({ score: 3, comment: 'Yes - lena-js' });
    });

    it('returns 0 with informative comment when only excluded packages are present', () => {
        const map = { maxScore: 3, exclude: ['vite', 'bootstrap'] };
        const student = { analysis: { npmPackages: ['vite', 'bootstrap'] } };
        expect(handler(map, student)).toEqual({
            score: 0,
            comment: 'No qualifying packages (found only excluded: vite, bootstrap)'
        });
    });

    it('treats no exclude field the same as an empty exclude list', () => {
        const map = { maxScore: 3 };
        const student = { analysis: { npmPackages: ['vite'] } };
        expect(handler(map, student)).toEqual({ score: 3, comment: 'Yes - vite' });
    });
});

// ── manual handler ─────────────────────────────────────────────────────────

describe('manual handler', () => {
    const handler = getHandler('manual');

    it('returns maxScore and custom message', () => {
        const map = { maxScore: 8, msg: 'NEEDS MANUAL CHECK (Game works correctly)' };
        expect(handler(map, {})).toEqual({ score: 8, comment: 'NEEDS MANUAL CHECK (Game works correctly)' });
    });

    it('returns empty score when maxScore is null', () => {
        const map = { msg: 'Check this' };
        expect(handler(map, {})).toEqual({ score: '', comment: 'Check this' });
    });

    it('returns default message when no msg', () => {
        const map = { maxScore: 5 };
        expect(handler(map, {})).toEqual({ score: 5, comment: 'NEEDS MANUAL CHECK' });
    });

    it('uses production score when available', () => {
        const map = { maxScore: 5, msg: 'Check feature', _reviewIndex: 0 };
        const student = { codeReview: { found: true, items: [{ betaScore: 4, prodScore: 5 }] } };
        expect(handler(map, student)).toEqual({ score: 5, comment: 'Check feature [Production score: 5]' });
    });

    it('falls back to beta score when production is empty', () => {
        const map = { maxScore: 5, msg: 'Check feature', _reviewIndex: 0 };
        const student = { codeReview: { found: true, items: [{ betaScore: 4, prodScore: null, prodFilled: false }] } };
        expect(handler(map, student)).toEqual({ score: 4, comment: 'Check feature [Beta score: 4]' });
    });

    it('caps review score at maxScore', () => {
        const map = { maxScore: 3, msg: 'Check feature', _reviewIndex: 0 };
        const student = { codeReview: { found: true, items: [{ betaScore: 4, prodScore: 5 }] } };
        expect(handler(map, student)).toEqual({ score: 3, comment: 'Check feature [Production score: 5]' });
    });

    it('uses maxScore when production cell says Y', () => {
        const map = { maxScore: 5, msg: 'Check feature', _reviewIndex: 0 };
        const student = { codeReview: { found: true, items: [{ betaScore: 3, prodScore: null, prodFilled: true, prodAffirmative: true }] } };
        expect(handler(map, student)).toEqual({ score: 5, comment: 'Check feature [Production: Yes]' });
    });

    it('returns 0 when production cell says N', () => {
        const map = { maxScore: 5, msg: 'Check feature', _reviewIndex: 0 };
        const student = { codeReview: { found: true, items: [{ betaScore: 3, prodScore: null, prodFilled: true, prodAffirmative: false }] } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Check feature [Production: No]' });
    });
});

// ── part_feature handler ───────────────────────────────────────────────────

describe('part_feature handler', () => {
    const handler = getHandler('part_feature');

    it('returns maxScore when count meets minCount', () => {
        const map = { partId: 'part1', featureId: 'classes', maxScore: 5, minCount: 1 };
        const student = { analysis: { partFeatures: { part1: { classes: 2 } } } };
        expect(handler(map, student)).toEqual({ score: 5, comment: 'Yes (2 found)' });
    });

    it('returns 0 when count below minCount', () => {
        const map = { partId: 'part1', featureId: 'classes', maxScore: 5, minCount: 3 };
        const student = { analysis: { partFeatures: { part1: { classes: 1 } } } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Missing (only 1 found)' });
    });

    it('handles folder not found (null partFeatures)', () => {
        const map = { partId: 'part1', featureId: 'classes', maxScore: 5 };
        const student = { analysis: { partFeatures: { part1: null } } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Missing (folder not found)' });
    });

    it('handles missing partFeatures for part', () => {
        const map = { partId: 'part1', featureId: 'classes', maxScore: 5 };
        const student = { analysis: { partFeatures: {} } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Missing (folder not found)' });
    });

    it('uses custom success and fail messages', () => {
        const map = { partId: 'part1', featureId: 'classes', maxScore: 3, minCount: 2, successMsg: 'Great', failMsg: 'Needs work' };
        const pass = { analysis: { partFeatures: { part1: { classes: 2 } } } };
        expect(handler(map, pass)).toEqual({ score: 3, comment: 'Great (2 found)' });
        const fail = { analysis: { partFeatures: { part1: { classes: 0 } } } };
        expect(handler(map, fail)).toEqual({ score: 0, comment: 'Needs work (only 0 found)' });
    });
});

// ── resolveOutputPath ──────────────────────────────────────────────────────

function makeXlsx(dir, filename, cellRef, value) {
    const wb = XLSX.utils.book_new();
    const ws = {};
    if (cellRef && value !== undefined) ws[cellRef] = { v: value, t: 's' };
    ws['!ref'] = cellRef || 'A1';
    XLSX.utils.book_append_sheet(wb, ws, 'Grade');
    const p = join(dir, filename);
    XLSX.writeFile(wb, p);
    return p;
}

describe('scripts_check handler', () => {
    const handler = getHandler('scripts_check');
    const map = { maxScore: 3, scripts: 'dev,build,test' };

    it('returns maxScore when all scripts pass', () => {
        const student = { scriptsCheck: { scripts: {
            dev:   { defined: true, ran: false, passed: true, error: null },
            build: { defined: true, ran: true,  passed: true, error: null },
            test:  { defined: true, ran: true,  passed: true, error: null },
        }}};
        expect(handler(map, student)).toEqual({ score: 3, comment: 'All pass: dev, build, test' });
    });

    it('scores proportionally when some scripts fail', () => {
        const student = { scriptsCheck: { scripts: {
            dev:   { defined: true,  ran: false, passed: true,  error: null },
            build: { defined: true,  ran: true,  passed: true,  error: null },
            test:  { defined: true,  ran: true,  passed: false, error: 'AssertionError: expected 1 to equal 2' },
        }}};
        const result = handler(map, student);
        expect(result.score).toBe(2);
        expect(result.comment).toContain('pass: dev, build');
        expect(result.comment).toContain('fail: test');
        expect(result.keepComment).toBe(true);
    });

    it('marks script as not defined when missing from package.json', () => {
        const student = { scriptsCheck: { scripts: {
            dev:   { defined: false, ran: false, passed: false, error: '"dev" not in package.json scripts' },
            build: { defined: true,  ran: true,  passed: true,  error: null },
            test:  { defined: true,  ran: true,  passed: true,  error: null },
        }}};
        const result = handler(map, student);
        expect(result.score).toBe(2);
        expect(result.comment).toContain('dev (not defined)');
        expect(result.keepComment).toBe(true);
    });

    it('scores 0 and sets keepComment when scriptsCheck has a top-level error', () => {
        const student = { scriptsCheck: { error: 'No package.json found' } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'No package.json found', keepComment: true });
    });

    it('scores 0 and sets keepComment when scriptsCheck is absent', () => {
        const student = {};
        expect(handler(map, student)).toEqual({ score: 0, comment: 'NEEDS MANUAL CHECK (no scripts check data)', keepComment: true });
    });

    it('defaults to dev,build,test when map.scripts is not specified', () => {
        const student = { scriptsCheck: { scripts: {
            dev:   { defined: true, ran: false, passed: true, error: null },
            build: { defined: true, ran: true,  passed: true, error: null },
            test:  { defined: true, ran: true,  passed: true, error: null },
        }}};
        expect(handler({ maxScore: 3 }, student)).toEqual({ score: 3, comment: 'All pass: dev, build, test' });
    });

    it('accepts array form for map.scripts', () => {
        const student = { scriptsCheck: { scripts: {
            build: { defined: true, ran: true, passed: true, error: null },
            test:  { defined: true, ran: true, passed: true, error: null },
        }}};
        expect(handler({ maxScore: 2, scripts: ['build', 'test'] }, student))
            .toEqual({ score: 2, comment: 'All pass: build, test' });
    });
});

describe('resolveOutputPath', () => {
    let tmpDir;

    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'rop-test-')); });
    afterEach(() => { rmSync(tmpDir, { recursive: true }); });

    it('returns basePath when graderCell is not configured', () => {
        const base = join(tmpDir, 'Student_Grade.xlsx');
        expect(resolveOutputPath(base, null)).toBe(base);
        expect(resolveOutputPath(base, '')).toBe(base);
    });

    it('returns basePath when the file does not exist yet (first grade)', () => {
        const base = join(tmpDir, 'Student_Grade.xlsx');
        expect(resolveOutputPath(base, 'E1')).toBe(base);
    });

    it('returns basePath when the existing file still has "Computer"', () => {
        const base = makeXlsx(tmpDir, 'Student_Grade.xlsx', 'E1', 'Computer');
        expect(resolveOutputPath(base, 'E1')).toBe(base);
    });

    it('returns basePath when the cell value has extra whitespace ("Computer  ")', () => {
        const base = makeXlsx(tmpDir, 'Student_Grade.xlsx', 'E1', 'Computer  ');
        expect(resolveOutputPath(base, 'E1')).toBe(base);
    });

    it('returns basePath when graderCell is empty/null (pre-feature file)', () => {
        const base = makeXlsx(tmpDir, 'Student_Grade.xlsx', null, undefined);
        expect(resolveOutputPath(base, 'E1')).toBe(base);
    });

    it('returns V2 when basePath was manually reviewed ("Brian Bird")', () => {
        makeXlsx(tmpDir, 'Student_Grade.xlsx', 'E1', 'Brian Bird');
        const base = join(tmpDir, 'Student_Grade.xlsx');
        const v2 = join(tmpDir, 'Student_Grade-V2.xlsx');
        expect(resolveOutputPath(base, 'E1')).toBe(v2);
    });

    it('overwrites V2 on a second regrade when V2 still has "Computer" (no V3 created)', () => {
        makeXlsx(tmpDir, 'Student_Grade.xlsx', 'E1', 'Brian Bird');
        const v2 = makeXlsx(tmpDir, 'Student_Grade-V2.xlsx', 'E1', 'Computer');
        const base = join(tmpDir, 'Student_Grade.xlsx');
        // First regrade after manual edit → V2 already exists with "Computer" → return V2 (overwrite)
        expect(resolveOutputPath(base, 'E1')).toBe(v2);
    });

    it('returns V3 when both base and V2 were manually reviewed', () => {
        makeXlsx(tmpDir, 'Student_Grade.xlsx', 'E1', 'Brian Bird');
        makeXlsx(tmpDir, 'Student_Grade-V2.xlsx', 'E1', 'Brian Bird');
        const base = join(tmpDir, 'Student_Grade.xlsx');
        const v3 = join(tmpDir, 'Student_Grade-V3.xlsx');
        expect(resolveOutputPath(base, 'E1')).toBe(v3);
    });
});
