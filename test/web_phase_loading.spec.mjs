/**
 * web_phase_loading.spec.mjs
 *
 * The web-only phases (HTML/CSS validation, web content) are imported on demand, so grading
 * a non-web lab never loads their libraries. Each library is replaced by a stand-in that
 * records when it's loaded: the first test fails if run_pipeline.js imports one up front, or
 * if a Python lab's phases would pull one in.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const loaded = vi.hoisted(() => ({ jsdom: false, htmlValidate: false, csstree: false }));

vi.mock('jsdom', () => { loaded.jsdom = true; return { JSDOM: class {} }; });
vi.mock('html-validate', () => {
    loaded.htmlValidate = true;
    return { HtmlValidate: class { async validateFile() { return { results: [] }; } } };
});
vi.mock('csstree-validator', () => { loaded.csstree = true; return { validate: () => [] }; });

describe('web-only phases load on demand', () => {
    it("importing the pipeline loads none of them, and a Python lab's phases don't either", async () => {
        const { PHASES } = await import('../src/pipeline/run_pipeline.js');
        expect(loaded).toEqual({ jsdom: false, htmlValidate: false, csstree: false });
        const python = { language: 'python', mappings: [{ type: 'lint' }] };
        const running = PHASES.filter(p => p.when(python)).map(p => p.name);
        expect(running).not.toContain('validateHtml');
        expect(running).not.toContain('validateCss');
        expect(running).not.toContain('checkWebContent');
    });

    it('a web lab loads a library when its phase actually runs', async () => {
        const { PHASES } = await import('../src/pipeline/run_pipeline.js');
        const dir = mkdtempSync(join(tmpdir(), 'webphase-'));
        try {
            await PHASES.find(p => p.name === 'validateHtml').run([], {}, { artifactsDir: dir });
            expect(loaded.htmlValidate).toBe(true);
            expect(loaded.jsdom).toBe(false);   // web content not configured, never run
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
