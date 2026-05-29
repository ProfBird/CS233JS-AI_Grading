/**
 * generate_grades.spec.mjs
 *
 * Tests for the grade handler functions and the handler registry.
 */
import { describe, it, expect, vi } from 'vitest';
import generateGrades from '../generate_grades.js';

const { getHandler, registerHandler, VALID_MAPPING_TYPES, isCodeSourceType } = generateGrades;

// ── Registry ───────────────────────────────────────────────────────────────

describe('handler registry', () => {
    it('exports VALID_MAPPING_TYPES containing all built-in types', () => {
        expect(VALID_MAPPING_TYPES).toBeInstanceOf(Set);
        expect(VALID_MAPPING_TYPES.has('feature')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('manual')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('lint')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('build_check')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('url_check')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('developer_comments')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('code_review')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('apps_in_repo')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('part1_completed')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('part_completed')).toBe(true);
        expect(VALID_MAPPING_TYPES.has('part_feature')).toBe(true);
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
        const { default: fresh } = await import('../generate_grades.js');
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
        expect(handler(map, student)).toEqual({ score: 10, comment: 'Part files found' });
    });

    it('returns 0 when part1 is false', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: { part1: false } } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Part files not found' });
    });

    it('returns 0 when partPresence is empty', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: {} } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'Part files not found' });
    });

    it('supports custom partId from map', () => {
        const map = { maxScore: 10, partId: 'part2' };
        const student = { analysis: { partPresence: { part2: true } } };
        expect(handler(map, student)).toEqual({ score: 10, comment: 'Part files found' });
    });

    it('handles missing analysis', () => {
        const map = { maxScore: 10 };
        expect(handler(map, {})).toEqual({ score: 0, comment: 'Part files not found' });
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

    it('handles empty partPresence with GitHub URL', () => {
        const map = { maxScore: 10 };
        const student = { analysis: { partPresence: { allPresent: false }, urls: { github: 'https://github.com/user/repo' } } };
        const result = handler(map, student);
        expect(result.score).toBe(0);
        expect(result.comment).toBe('Missing app folders');
    });

    it('handles missing analysis', () => {
        const map = { maxScore: 10 };
        expect(handler(map, {})).toEqual({ score: 0, comment: 'Missing GitHub repository' });
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

    it('returns 0 and "yes and no" when review found but prod column not complete', () => {
        const map = { maxScore: 2 };
        const student = { analysis: { hasCodeReview: true }, codeReview: { productionCompleted: false } };
        expect(handler(map, student)).toEqual({ score: 0, comment: 'yes and no' });
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
