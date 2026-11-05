/**
 * python_preflight.spec.mjs — the Python adapter's upfront toolchain check: a missing
 * interpreter is unavailable; a missing ruff (for a lab with lint rows) is a warning.
 */
import { describe, it, expect } from 'vitest';
import pythonAdapter from '../src/adapters/python.js';

describe('python preflight', () => {
    it('reports an unavailable interpreter with a hint', async () => {
        const r = await pythonAdapter.preflight({ toolchains: { python: 'no-such-python-xyz' } });
        expect(r.available).toBe(false);
        expect(r.hint).toMatch(/toolchains\.python/);
    });

    it('stays quiet when there is nothing that needs ruff or uv', async () => {
        const r = await pythonAdapter.preflight({ mappings: [{ type: 'developer_comments' }] });
        expect(r.available).toBe(true);
        // (an old system interpreter may still add a version warning; ruff must not be mentioned)
        expect(r.warning || '').not.toMatch(/ruff/);
    });
});
