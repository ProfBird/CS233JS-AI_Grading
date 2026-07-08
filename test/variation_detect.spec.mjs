/**
 * variation_detect.spec.mjs
 *
 * Focused tests for src/lib/variation_detect.js, extracted out of analyze_code.js
 * (refactoring_plan_2026-07-07.md Priority 6). Previously only exercised indirectly
 * via analyze.spec.mjs's whole-pipeline runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { checkVersionVariation, variationKeywords, buildVariationCorpus, VARIATION_KEYWORD_STOPWORDS } from '../src/lib/variation_detect.js';

// ── variationKeywords ────────────────────────────────────────────────────

describe('variationKeywords', () => {
    it('lowercases and splits on non-word characters', () => {
        expect(variationKeywords('Boneyard Bluff')).toEqual(['boneyard', 'bluff']);
    });

    it('drops words shorter than 4 characters', () => {
        // "the"(3), "big"(3), and "zoo"(3) are all dropped for being under 4 chars.
        expect(variationKeywords('The Big Zoo')).toEqual([]);
    });

    it('drops stopwords even when long enough', () => {
        for (const w of VARIATION_KEYWORD_STOPWORDS) {
            expect(variationKeywords(w)).toEqual([]);
        }
    });

    it('keeps a mix of valid keywords while dropping stopwords/short words', () => {
        expect(variationKeywords('Skull Skirmish Web App')).toEqual(['skull', 'skirmish']);
    });
});

// ── buildVariationCorpus ─────────────────────────────────────────────────

describe('buildVariationCorpus', () => {
    let tmpDir, warnSpy;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'corpus-'));
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it('includes top-level directory/file names', () => {
        mkdirSync(join(tmpDir, 'BoneyardBluff'));
        const corpus = buildVariationCorpus(tmpDir);
        expect(corpus).toContain('boneyardbluff');
    });

    it('includes HTML <title> text', () => {
        writeFileSync(join(tmpDir, 'index.html'), '<html><head><title>Skull Skirmish</title></head></html>');
        const corpus = buildVariationCorpus(tmpDir);
        expect(corpus).toContain('skull skirmish');
    });

    it('includes package.json name and description', () => {
        writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'skull-skirmish', description: 'a card game' }));
        const corpus = buildVariationCorpus(tmpDir);
        expect(corpus).toContain('skull-skirmish');
        expect(corpus).toContain('a card game');
    });

    it('includes README content (truncated)', () => {
        writeFileSync(join(tmpDir, 'README.md'), 'This is the Boneyard Bluff project readme.');
        const corpus = buildVariationCorpus(tmpDir);
        expect(corpus).toContain('boneyard bluff project readme');
    });

    it('excludes node_modules/dist/.git directory contents', () => {
        mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
        writeFileSync(join(tmpDir, 'node_modules', 'index.html'), '<title>ExcludedKeyword</title>');
        const corpus = buildVariationCorpus(tmpDir);
        expect(corpus).not.toContain('excludedkeyword');
    });

    it('excludes _starter/_template-suffixed directories by name', () => {
        mkdirSync(join(tmpDir, 'GameName_starter'), { recursive: true });
        writeFileSync(join(tmpDir, 'GameName_starter', 'index.html'), '<title>StarterKeyword</title>');
        const corpus = buildVariationCorpus(tmpDir);
        expect(corpus).not.toContain('starterkeyword');
    });

    it('warns (does not throw) and continues when a package.json is malformed', () => {
        writeFileSync(join(tmpDir, 'package.json'), '{ not valid json');
        writeFileSync(join(tmpDir, 'README.md'), 'Fallback readme content here.');
        const corpus = buildVariationCorpus(tmpDir);
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls[0][0]).toMatch(/could not parse/);
        expect(corpus).toContain('fallback readme content here');
    });

    it('returns lowercase text', () => {
        mkdirSync(join(tmpDir, 'UPPERCASE'));
        expect(buildVariationCorpus(tmpDir)).toBe(buildVariationCorpus(tmpDir).toLowerCase());
    });
});

// ── checkVersionVariation ─────────────────────────────────────────────────

describe('checkVersionVariation', () => {
    let tmpDir;
    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'vv-')); });
    afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

    const variations = {
        A: { appName: 'Boneyard Bluff' },
        B: { appName: 'Skull Skirmish' },
    };

    it('detects the variation whose keywords appear in the corpus', () => {
        mkdirSync(join(tmpDir, 'BoneyardBluff'));
        const result = checkVersionVariation(tmpDir, variations);
        expect(result.detected).toBe('A');
        expect(result.appName).toBe('Boneyard Bluff');
    });

    it('returns detected: null when no variation keywords are found', () => {
        mkdirSync(join(tmpDir, 'SomeUnrelatedFolder'));
        const result = checkVersionVariation(tmpDir, variations);
        expect(result.detected).toBeNull();
        expect(result.appName).toBeNull();
    });

    it('flags ambiguous when two variations tie for the top score', () => {
        writeFileSync(join(tmpDir, 'index.html'), '<title>Boneyard Skull</title>');
        const result = checkVersionVariation(tmpDir, variations);
        expect(result.ambiguous).toBe(true);
        expect(result.detected).toBeNull();
    });

    it('skips a variation entry with no appName', () => {
        mkdirSync(join(tmpDir, 'BoneyardBluff'));
        const withBlank = { A: { appName: 'Boneyard Bluff' }, B: {} };
        const result = checkVersionVariation(tmpDir, withBlank);
        expect(result.detected).toBe('A');
        expect(result.scores.B).toBeUndefined();
    });
});
