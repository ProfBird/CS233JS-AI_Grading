/**
 * analyze.spec.mjs
 *
 * Smoke tests for the analysis module's pure utility functions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import analyzeCode from '../analyze_code.js';
import lab02Analyzer from '../configs/lab02_analyzer.js';

const { stripComments, normalizeDirName } = analyzeCode;

// ── stripComments ────────────────────────────────────────────────────────

describe('stripComments', () => {
    it('removes single-line comments', () => {
        const result = stripComments('let x = 1; // inline comment\nlet y = 2;');
        expect(result).toBe('let x = 1; \nlet y = 2;');
    });

    it('removes multi-line block comments', () => {
        const result = stripComments('/* block\ncomment */ let x = 1;');
        expect(result).toBe(' let x = 1;');
    });

    it('preserves URL-like strings that contain //', () => {
        const result = stripComments('let url = "http://example.com/api";');
        expect(result).toContain('http://example.com/api');
    });

    it('preserves template literals with // inside', () => {
        const result = stripComments('let path = `http://example.com/${id}`;');
        expect(result).toContain('http://example.com/');
    });

    it('handles JSDoc-style block comments', () => {
        const result = stripComments('/**\n * @param {string} name\n */\nfunction foo(name) {}');
        expect(result).not.toContain('@param');
        expect(result).toContain('function foo(name) {}');
    });

    it('returns unchanged code when there are no comments', () => {
        const code = 'let x = 1;\nlet y = 2;';
        expect(stripComments(code)).toBe(code);
    });

    it('handles empty string', () => {
        expect(stripComments('')).toBe('');
    });

    it('preserves backslash-escaped slashes that do not form a // sequence', () => {
        // \/\/ inside a regex literal is four chars (\, /, \, /) — never two forward slashes,
        // so the comment-stripping regex doesn't match it.
        const result = stripComments('let re = /foo\\/\\/bar/;');
        expect(result).toContain('let re = /foo\\/\\/bar/;');
    });

    it('strips block comment inside a line', () => {
        const result = stripComments('let x = /* inline block */ 1;');
        expect(result).toBe('let x =  1;');
    });
});

// ── normalizeDirName ─────────────────────────────────────────────────────

describe('normalizeDirName', () => {
    it('splits camelCase into words', () => {
        expect(normalizeDirName('boneyardBluff')).toBe('boneyard bluff');
    });

    it('lowercases everything', () => {
        expect(normalizeDirName('BoneYard')).toBe('bone yard');
    });

    it('replaces hyphens with spaces', () => {
        expect(normalizeDirName('boneyard-bluff')).toBe('boneyard bluff');
    });

    it('replaces underscores with spaces', () => {
        expect(normalizeDirName('boneyard_bluff')).toBe('boneyard bluff');
    });

    it('handles mixed separators', () => {
        expect(normalizeDirName('BoneYard-Bluff_game')).toBe('bone yard bluff game');
    });

    it('handles dir names that are just a word', () => {
        expect(normalizeDirName('game')).toBe('game');
    });
});

// ── lab02_analyzer ──────────────────────────────────────────────────────────

describe('lab02_analyzer', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'lab02-test-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true });
    });

    it('sets modules to 1 when both import and export are present', () => {
        const file = join(tmpDir, 'main.js');
        writeFileSync(file, 'import foo from "./foo.js";\nexport default bar;');
        const analysis = { features: { modules: 5 } }; // regex pre-count overridden
        lab02Analyzer([file], analysis);
        expect(analysis.features.modules).toBe(1);
    });

    it('sets modules to 0 when export is missing', () => {
        const file = join(tmpDir, 'main.js');
        writeFileSync(file, 'import foo from "./foo.js";');
        const analysis = { features: { modules: 3 } };
        lab02Analyzer([file], analysis);
        expect(analysis.features.modules).toBe(0);
    });

    it('sets modules to 0 when import is missing', () => {
        const file = join(tmpDir, 'main.js');
        writeFileSync(file, 'export default function foo() {}');
        const analysis = { features: { modules: 0 } };
        lab02Analyzer([file], analysis);
        expect(analysis.features.modules).toBe(0);
    });
});
