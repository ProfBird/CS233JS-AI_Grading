/**
 * select_from_list.spec.mjs
 *
 * Unit tests for the shared "number or name" picker loop factored out of bin/grade.js's
 * course/term selection prompts (see docs/code_review_2026-07-24.md §3.1's "Menu select
 * loop" duplication finding).
 */
import { describe, it, expect, vi } from 'vitest';
import { selectFromList } from '../src/lib/select_from_list.js';

// Builds a fake `ask` that returns each of `answers` in sequence, one per call.
function scriptedAsk(answers) {
    let i = 0;
    return vi.fn(async () => answers[i++]);
}

describe('selectFromList', () => {
    const items = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }];
    const matchNames = item => [item.id, item.label];

    it('resolves a valid 1-based index', async () => {
        const ask = scriptedAsk(['2']);
        const result = await selectFromList(ask, { items, matchNames });
        expect(result).toBe(items[1]);
        expect(ask).toHaveBeenCalledTimes(1);
    });

    it('resolves by exact name match, case-insensitive', async () => {
        const ask = scriptedAsk(['alpha']);
        const result = await selectFromList(ask, { items, matchNames });
        expect(result).toBe(items[0]);
    });

    it('resolves by a secondary match name (id vs label)', async () => {
        const ask = scriptedAsk(['B']);
        const result = await selectFromList(ask, { items, matchNames });
        expect(result).toBe(items[1]);
    });

    it('re-prompts on invalid input, then accepts a valid answer', async () => {
        const ask = scriptedAsk(['nope', '99', '1']);
        const result = await selectFromList(ask, { items, matchNames });
        expect(result).toBe(items[0]);
        expect(ask).toHaveBeenCalledTimes(3);
    });

    it('applies getValue to transform the matched item', async () => {
        const ask = scriptedAsk(['1']);
        const result = await selectFromList(ask, { items, matchNames, getValue: item => item.id });
        expect(result).toBe('a');
    });

    it('invokes extraOption.action() when the "one past the list" number is chosen', async () => {
        const created = { id: 'c', label: 'Created' };
        const action = vi.fn(async () => created);
        const ask = scriptedAsk(['3']);
        const result = await selectFromList(ask, { items, matchNames, extraOption: { action } });
        expect(action).toHaveBeenCalledTimes(1);
        expect(result).toBe(created);
    });

    it('re-prompts if extraOption.action() returns null (e.g. user cancelled)', async () => {
        const action = vi.fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'c', label: 'Created' });
        const ask = scriptedAsk(['3', '3']);
        const result = await selectFromList(ask, { items, matchNames, extraOption: { action } });
        expect(action).toHaveBeenCalledTimes(2);
        expect(result).toEqual({ id: 'c', label: 'Created' });
    });

    it('does not treat the extraOption number as valid when no extraOption is configured', async () => {
        // items.length + 1 with no extraOption falls through to name-matching, which fails,
        // so it should re-prompt rather than crash.
        const ask = scriptedAsk(['3', '1']);
        const result = await selectFromList(ask, { items, matchNames });
        expect(result).toBe(items[0]);
    });
});
