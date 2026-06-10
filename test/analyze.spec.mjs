/**
 * analyze.spec.mjs
 *
 * Smoke tests for the analysis module's pure utility functions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import analyzeCode, { stripComments, normalizeDirName, detectPartsPresent, applyCustomAnalyzer } from '../pipeline/analyze_code.js';
import lab02Analyzer from '../configs/Lab02/lab02_analyzer.js';
import lab05Analyzer from '../configs/Lab05/lab05_analyzer.js';

const analyzeStudents = analyzeCode;

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

// ── detectPartsPresent ───────────────────────────────────────────────────────

describe('detectPartsPresent', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'parts-test-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true });
    });

    it('detects part1 from a subdirectory named "part1"', () => {
        mkdirSync(join(tmpDir, 'part1'));
        const result = detectPartsPresent(tmpDir, {}, {});
        expect(result.part1).toBe(true);
        expect(result.allPresent).toBe(true);
    });

    it('detects part1 from a subdirectory named "Part 1"', () => {
        mkdirSync(join(tmpDir, 'Part 1'));
        const result = detectPartsPresent(tmpDir, {}, {});
        expect(result.part1).toBe(true);
    });

    it('detects part1 from a filename at the root (e.g. CS233JS_Lab01_Part1.html)', () => {
        writeFileSync(join(tmpDir, 'CS233JS_Lab01_Part1.html'), '');
        writeFileSync(join(tmpDir, 'CS233JS_Lab01_Part1.js'), '');
        const result = detectPartsPresent(tmpDir, {}, {});
        expect(result.part1).toBe(true);
        expect(result.allPresent).toBe(true);
    });

    it('detects part1 from a filename in a subdirectory', () => {
        const sub = join(tmpDir, 'MyGame');
        mkdirSync(sub);
        writeFileSync(join(sub, 'Lab02_Part1_exercises.html'), '');
        const result = detectPartsPresent(tmpDir, {}, {});
        expect(result.part1).toBe(true);
    });

    it('does not false-positive on a file named "counterpart1.js"', () => {
        writeFileSync(join(tmpDir, 'counterpart1.js'), '');
        const result = detectPartsPresent(tmpDir, {}, {});
        expect(result.part1).toBeUndefined();
        expect(result.allPresent).toBe(false);
    });

    it('prefers directory detection over file fallback when directories exist', () => {
        mkdirSync(join(tmpDir, 'part1'));
        // a file that would also match — directory detection runs first
        writeFileSync(join(tmpDir, 'part2_notes.html'), '');
        const result = detectPartsPresent(tmpDir, {}, {});
        expect(result.part1).toBe(true);
        // part2 should NOT be set via file fallback since part1 dir was found
        expect(result.part2).toBeUndefined();
    });

    it('returns allPresent false when no parts are found at all', () => {
        writeFileSync(join(tmpDir, 'index.html'), '');
        writeFileSync(join(tmpDir, 'gameLogic.js'), '');
        const result = detectPartsPresent(tmpDir, {}, {});
        expect(result.allPresent).toBe(false);
    });
});

// ── applyCustomAnalyzer (custom-analyzer extension point) ────────────────────

describe('applyCustomAnalyzer', () => {
    let warnSpy;
    beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { warnSpy.mockRestore(); });

    it('merges the analyzer return value into analysis', () => {
        const analysis = { features: { a: 1 } };
        const analyzer = () => ({ features: { a: 1, b: 2 }, custom: 'x' });
        applyCustomAnalyzer(analyzer, [], analysis, {}, { name: 'S' });
        expect(analysis.custom).toBe('x');
        expect(analysis.features).toEqual({ a: 1, b: 2 });
    });

    it('swallows a throwing analyzer and leaves analysis intact', () => {
        const analysis = { features: { a: 1 } };
        const analyzer = () => { throw new Error('boom'); };
        expect(() => applyCustomAnalyzer(analyzer, [], analysis, {}, { name: 'S' })).not.toThrow();
        expect(analysis).toEqual({ features: { a: 1 } });
        expect(warnSpy).toHaveBeenCalled();
    });

    it('ignores a non-object return value', () => {
        const analysis = { features: {} };
        applyCustomAnalyzer(() => 42, [], analysis, {}, { name: 'S' });
        expect(analysis).toEqual({ features: {} });
    });

    it('passes jsFiles, analysis, config, and student through to the analyzer', () => {
        const seen = {};
        const analyzer = (jsFiles, _analysis, config, student) => { Object.assign(seen, { jsFiles, config, student }); };
        applyCustomAnalyzer(analyzer, ['a.js'], { features: {} }, { x: 1 }, { name: 'S' });
        expect(seen.jsFiles).toEqual(['a.js']);
        expect(seen.config).toEqual({ x: 1 });
        expect(seen.student).toEqual({ name: 'S' });
    });
});

// ── hasDeveloperComments ─────────────────────────────────────────────────────

describe('hasDeveloperComments', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'devcomments-test-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true });
    });

    const runAnalysis = (tmpDir, fileName, content) => {
        writeFileSync(join(tmpDir, fileName), content);
        const students = [{ name: 'Zoey McKee', extractedDir: tmpDir, urls: {} }];
        analyzeStudents(students, { analysis: { features: [] } }, tmpDir);
        return students[0].analysis.hasDeveloperComments;
    };

    it('detects last name in a .js file', () => {
        expect(runAnalysis(tmpDir, 'app.js', '/* Written by Zoey McKee */')).toBe(true);
    });

    it('detects last name in a .mjs file', () => {
        expect(runAnalysis(tmpDir, 'app.mjs', '/* Code Written by Brian Bird, Modified by Zoey McKee */')).toBe(true);
    });

    it('returns false when no name is present in .mjs file', () => {
        expect(runAnalysis(tmpDir, 'app.mjs', 'export function foo() {}')).toBe(false);
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

// ── lab05_analyzer ───────────────────────────────────────────────────────────

describe('lab05_analyzer', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'lab05-test-'));
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true });
    });

    function makeAnalysis() {
        return { features: {} };
    }

    it('detects zoom via ctx.scale()', () => {
        const file = join(tmpDir, 'canvas.js');
        writeFileSync(file, 'ctx.scale(zoomLevel, zoomLevel);\nctx.drawImage(img, 0, 0);');
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c12_feature_ok).toBe(1);
    });

    it('detects emoji stickers with mousedown positioning', () => {
        const file = join(tmpDir, 'canvas.js');
        writeFileSync(file, [
            'this.stickers = [];',
            'canvas.addEventListener("mousedown", handleMouseDown);',
            'ctx.fillText(sticker.emoji, sticker.x, sticker.y);',
        ].join('\n'));
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c12_feature_ok).toBe(1);
    });

    it('detects freestyle drawing with lineTo and mousemove', () => {
        const file = join(tmpDir, 'canvas.js');
        writeFileSync(file, [
            'canvas.addEventListener("mousemove", draw);',
            'ctx.lineTo(event.offsetX, event.offsetY);',
            'ctx.stroke();',
        ].join('\n'));
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c12_feature_ok).toBe(1);
    });

    it('rejects sticker keyword without mouse interaction', () => {
        const file = join(tmpDir, 'canvas.js');
        writeFileSync(file, 'this.stickerText = ""; // vestigial, no mouse handler');
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c12_feature_ok).toBe(0);
    });

    it('rejects lineTo without mouse interaction', () => {
        const file = join(tmpDir, 'canvas.js');
        writeFileSync(file, 'ctx.lineTo(10, 10); // single path, no mouse handler');
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c12_feature_ok).toBe(0);
    });

    it('rejects code with only background drawImage', () => {
        const file = join(tmpDir, 'canvas.js');
        writeFileSync(file, 'ctx.drawImage(this.image, 0, 0, width, height);');
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c12_feature_ok).toBe(0);
    });

    // c13: background / font color / font style (one of three based on group)

    it('c13: detects Group A background color via bgColor model property', () => {
        const file = join(tmpDir, 'model.js');
        writeFileSync(file, 'this.bgColor = "#ffffff";\nctx.fillStyle = this.bgColor;');
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c13_feature_ok).toBe(1);
    });

    it('c13: detects Group B font color via textColor model property', () => {
        const file = join(tmpDir, 'model.js');
        writeFileSync(file, 'this.textColor = "#000000";\nctx.fillStyle = this.textColor;');
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c13_feature_ok).toBe(1);
    });

    it('c13: detects Group C font style via fontSelect model property', () => {
        const file = join(tmpDir, 'model.js');
        writeFileSync(file, 'this.fontSelect = "sans-serif";\nctx.font = `bold 40px ${this.fontSelect}`;');
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c13_feature_ok).toBe(1);
    });

    it('c13: detects font color via private class field (this.#fontFillColor)', () => {
        const file = join(tmpDir, 'TextSettings.mjs');
        writeFileSync(file, [
            '#fontFillColor',
            'constructor() { this.#fontFillColor = "White"; }',
            'get fontFillColor() { return this.#fontFillColor; }',
            'set fontFillColor(v) { this.#fontFillColor = v; }',
        ].join('\n'));
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c13_feature_ok).toBe(1);
    });

    it('c13: detects font color via dynamic fillStyle from nested model property', () => {
        const file = join(tmpDir, 'canvasModel.js');
        writeFileSync(file, 'ctx.fillStyle = this.#textSettings.fontFillColor;');
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c13_feature_ok).toBe(1);
    });

    it('c13: rejects code with only hardcoded canvas styling (no model property)', () => {
        const file = join(tmpDir, 'model.js');
        writeFileSync(file, [
            'ctx.fillStyle = "white";',
            'ctx.strokeStyle = "black";',
            'ctx.font = "bold 40px Impact, sans-serif";',
        ].join('\n'));
        const analysis = makeAnalysis();
        lab05Analyzer([file], analysis);
        expect(analysis.features.c13_feature_ok).toBe(0);
    });
});
