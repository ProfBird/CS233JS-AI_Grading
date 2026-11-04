/**
 * analyze.spec.mjs
 *
 * Smoke tests for the analysis module's pure utility functions.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as fs from 'fs';
import xlsx from 'xlsx';
import analyzeCode, { stripComments, normalizeDirName, detectPartsPresent, applyCustomAnalyzer, countFeatures, readGameNamesFromRubric, checkDeveloperComments } from '../src/pipeline/analyze_code.js';
import { resolveAdapter } from '../src/adapters/index.js';

// The xlsx ESM build does not auto-wire Node's fs; writeFile needs set_fs() first.
xlsx.set_fs(fs);

// Helper: load a shipped config's analysis.features so tests exercise the real config.
// Real lab configs live under configs/{Course}/{Lab}/ (course tier).
const loadFeatures = lab => JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'configs', 'CS233JS', lab, `${lab.toLowerCase()}_config.json`), 'utf8')
).analysis.features;

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

    it('merges the analyzer return value into analysis', async () => {
        const analysis = { features: { a: 1 } };
        const analyzer = () => ({ features: { a: 1, b: 2 }, custom: 'x' });
        await applyCustomAnalyzer(analyzer, [], analysis, {}, { name: 'S' });
        expect(analysis.custom).toBe('x');
        expect(analysis.features).toEqual({ a: 1, b: 2 });
    });

    it('awaits an async analyzer before merging its result', async () => {
        const analysis = { features: {} };
        const analyzer = async () => {
            await new Promise(r => setTimeout(r, 5));
            return { custom: 'async-x' };
        };
        await applyCustomAnalyzer(analyzer, [], analysis, {}, { name: 'S' });
        expect(analysis.custom).toBe('async-x');
    });

    it('swallows a throwing analyzer and leaves analysis intact', async () => {
        const analysis = { features: { a: 1 } };
        const analyzer = () => { throw new Error('boom'); };
        await expect(applyCustomAnalyzer(analyzer, [], analysis, {}, { name: 'S' })).resolves.not.toThrow();
        expect(analysis).toEqual({ features: { a: 1 } });
        expect(warnSpy).toHaveBeenCalled();
    });

    it('ignores a non-object return value', async () => {
        const analysis = { features: {} };
        await applyCustomAnalyzer(() => 42, [], analysis, {}, { name: 'S' });
        expect(analysis).toEqual({ features: {} });
    });

    it('passes jsFiles, analysis, config, and student through to the analyzer', async () => {
        const seen = {};
        const analyzer = (jsFiles, _analysis, config, student) => { Object.assign(seen, { jsFiles, config, student }); };
        await applyCustomAnalyzer(analyzer, ['a.js'], { features: {} }, { x: 1 }, { name: 'S' });
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

    const runAnalysis = async (tmpDir, fileName, content) => {
        writeFileSync(join(tmpDir, fileName), content);
        const students = [{ name: 'Zoey McKee', extractedDir: tmpDir, urls: {} }];
        await analyzeStudents(students, { analysis: { features: [] } }, tmpDir);
        return students[0].analysis.hasDeveloperComments;
    };

    it('detects last name in a .js file', async () => {
        expect(await runAnalysis(tmpDir, 'app.js', '/* Written by Zoey McKee */')).toBe(true);
    });

    it('detects last name in a .mjs file', async () => {
        expect(await runAnalysis(tmpDir, 'app.mjs', '/* Code Written by Brian Bird, Modified by Zoey McKee */')).toBe(true);
    });

    it('returns false when no name is present in .mjs file', async () => {
        expect(await runAnalysis(tmpDir, 'app.mjs', 'export function foo() {}')).toBe(false);
    });

    it('is not fooled by name/date assignments in code (only comments count)', async () => {
        expect(await runAnalysis(tmpDir, 'app.js', 'const name = prompt("Name?");\nconst obj = { date: new Date() };')).toBe(false);
    });

    it('scans a source file under a path containing "dist" as a substring (distance.js)', async () => {
        expect(await runAnalysis(tmpDir, 'distance.js', '// Zoey McKee, 2026')).toBe(true);
    });
});

describe('checkDeveloperComments', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'devc-')); });
    afterEach(() => { rmSync(dir, { recursive: true }); });

    const py = resolveAdapter({ language: 'python' });
    const write = (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p; };

    it('Python: ignores `name = input()` and dict keys in code', () => {
        const f = write('main.py', 'name = input("Name: ")\nrecord = {"date": today, "author": me}\n');
        expect(checkDeveloperComments([f], 'Ana Ruiz', py, dir)).toEqual({ filesChecked: 1, filesWith: 0, missing: ['main.py'] });
    });

    it('Python: accepts a # comment header or a module docstring', () => {
        const a = write('a.py', '# Ana Ruiz, 1/12/2026\nx = 1\n');
        const b = write('b.py', '"""Rule loader.\nAuthor: Ana Ruiz\n"""\nimport csv\n');
        expect(checkDeveloperComments([a, b], 'Ana Ruiz', py, dir).filesWith).toBe(2);
    });

    it('matches the student name as a whole word only', () => {
        const f = write('c.py', '# Helper algorithm module\n');
        expect(checkDeveloperComments([f], 'Al Smith', py, dir).filesWith).toBe(0);
    });

    it('reports per-file results and skips empty files', () => {
        const ok = write('engine.py', '# Author: Ana Ruiz\n');
        const bad = write('tests.py', 'def test_x():\n    assert True\n');
        const empty = write('__init__.py', '');
        expect(checkDeveloperComments([ok, bad, empty], 'Ana Ruiz', py, dir))
            .toEqual({ filesChecked: 2, filesWith: 1, missing: ['tests.py'] });
    });

    it('excludes a submitted .venv from analysis', async () => {
        mkdirSync(join(dir, '.venv', 'lib'), { recursive: true });
        writeFileSync(join(dir, '.venv', 'lib', 'six.py'), 'x = 1\n');
        write('main.py', '# Ana Ruiz\n');
        const students = [{ name: 'Ana Ruiz', extractedDir: dir, urls: {} }];
        await analyzeStudents(students, { language: 'python', analysis: { features: [] } }, dir);
        expect(students[0].analysis.developerComments).toEqual({ filesChecked: 1, filesWith: 1, missing: [] });
    });
});

// ── Lab02 'modules' feature (match rule) ─────────────────────────────────────

// The `modules` feature uses a nested match rule (import AND export) in
// lab02_config.json, replacing the former lab02_analyzer. These were that analyzer's
// characterization tests — now driving the SHIPPED config through countFeatures with
// the same fixtures and expected values (a fidelity check on the migration).
describe("Lab02 'modules' feature (match: import AND export)", () => {
    let tmpDir;
    const features = loadFeatures('Lab02');

    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'lab02-test-')); });
    afterEach(() => { rmSync(tmpDir, { recursive: true }); });

    const modules = code => {
        const file = join(tmpDir, 'main.js');
        writeFileSync(file, code);
        return countFeatures([file], features).modules;
    };

    it('1 when both import and export are present', () => {
        expect(modules('import foo from "./foo.js";\nexport default bar;')).toBe(1);
    });
    it('0 when export is missing', () => {
        expect(modules('import foo from "./foo.js";')).toBe(0);
    });
    it('0 when import is missing', () => {
        expect(modules('export default function foo() {}')).toBe(0);
    });
});

// ── Lab05 c12 / c13 (nested match rules) ──────────────────────────────────────

// c12_feature_ok / c13_feature_ok use nested anyOf / OR-of-ANDs match rules in
// lab05_config.json, replacing the former lab05_analyzer. Same fixtures and expected
// values as that analyzer's characterization tests, now via the shipped config.
describe('Lab05 c12/c13 features (nested match rules)', () => {
    let tmpDir;
    const features = loadFeatures('Lab05');

    beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'lab05-test-')); });
    afterEach(() => { rmSync(tmpDir, { recursive: true }); });

    // Write one or more { name, content } files and return the feature's value.
    const feature = (files, id) => {
        const paths = files.map(f => {
            const p = join(tmpDir, f.name);
            writeFileSync(p, f.content);
            return p;
        });
        return countFeatures(paths, features)[id];
    };
    const c12 = (...files) => feature(files, 'c12_feature_ok');
    const c13 = (...files) => feature(files, 'c13_feature_ok');

    // c12: zoom OR (lineTo AND mouse) OR (sticker AND mouse)
    it('c12=1: zoom via ctx.scale()', () => {
        expect(c12({ name: 'canvas.js', content: 'ctx.scale(zoomLevel, zoomLevel);\nctx.drawImage(img, 0, 0);' })).toBe(1);
    });
    it('c12=1: stickers with mousedown positioning', () => {
        expect(c12({ name: 'canvas.js', content: [
            'this.stickers = [];',
            'canvas.addEventListener("mousedown", handleMouseDown);',
            'ctx.fillText(sticker.emoji, sticker.x, sticker.y);',
        ].join('\n') })).toBe(1);
    });
    it('c12=1: freestyle drawing with lineTo and mousemove', () => {
        expect(c12({ name: 'canvas.js', content: [
            'canvas.addEventListener("mousemove", draw);',
            'ctx.lineTo(event.offsetX, event.offsetY);',
            'ctx.stroke();',
        ].join('\n') })).toBe(1);
    });
    it('c12=1: lineTo and mouse handler split across two files (codebase-wide AND)', () => {
        // The nested allOf combines per-pattern presence computed across ALL files,
        // so lineTo in one file + a mouse handler in another still matches.
        expect(c12(
            { name: 'draw.js', content: 'ctx.lineTo(event.offsetX, event.offsetY);' },
            { name: 'events.js', content: 'canvas.addEventListener("mousemove", draw);' },
        )).toBe(1);
    });
    it('c12=0: sticker keyword without mouse interaction', () => {
        expect(c12({ name: 'canvas.js', content: 'this.stickerText = ""; // vestigial, no mouse handler' })).toBe(0);
    });
    it('c12=0: lineTo without mouse interaction', () => {
        expect(c12({ name: 'canvas.js', content: 'ctx.lineTo(10, 10); // single path, no mouse handler' })).toBe(0);
    });
    it('c12=0: only background drawImage', () => {
        expect(c12({ name: 'canvas.js', content: 'ctx.drawImage(this.image, 0, 0, width, height);' })).toBe(0);
    });
    it('c12=0: a feature pattern that appears only in a comment is not counted', () => {
        // Deliberate, documented difference from the old raw-content analyzer: countFeatures
        // strips comments from .js, so commented-out code never satisfies a match rule.
        expect(c12({ name: 'canvas.js', content: '// ctx.scale(2, 2) used to be here\nconst x = 1;' })).toBe(0);
    });

    // c13: user-controlled bg color OR font color (incl. fillStyle fallback) OR font style
    it('c13=1: Group A background color via bgColor model property', () => {
        expect(c13({ name: 'model.js', content: 'this.bgColor = "#ffffff";\nctx.fillStyle = this.bgColor;' })).toBe(1);
    });
    it('c13=1: Group B font color via textColor model property', () => {
        expect(c13({ name: 'model.js', content: 'this.textColor = "#000000";\nctx.fillStyle = this.textColor;' })).toBe(1);
    });
    it('c13=1: Group C font style via fontSelect model property', () => {
        expect(c13({ name: 'model.js', content: 'this.fontSelect = "sans-serif";\nctx.font = `bold 40px ${this.fontSelect}`;' })).toBe(1);
    });
    it('c13=1: font color via private class field (#fontFillColor) in a .mjs file', () => {
        expect(c13({ name: 'TextSettings.mjs', content: [
            '#fontFillColor',
            'constructor() { this.#fontFillColor = "White"; }',
            'get fontFillColor() { return this.#fontFillColor; }',
            'set fontFillColor(v) { this.#fontFillColor = v; }',
        ].join('\n') })).toBe(1);
    });
    it('c13=1: dynamic fillStyle from nested model property (fallback branch)', () => {
        expect(c13({ name: 'canvasModel.js', content: 'ctx.fillStyle = this.#textSettings.fontFillColor;' })).toBe(1);
    });
    it('c13=0: only hardcoded canvas styling (no model property)', () => {
        expect(c13({ name: 'model.js', content: [
            'ctx.fillStyle = "white";',
            'ctx.strokeStyle = "black";',
            'ctx.font = "bold 40px Impact, sans-serif";',
        ].join('\n') })).toBe(0);
    });
});

// ── readGameNamesFromRubric (silent-failure surfacing, Priority 4) ───────────

describe('readGameNamesFromRubric', () => {
    let tmpDir, warnSpy;

    beforeEach(() => {
        tmpDir = mkdtempSync(join(tmpdir(), 'rubric-warn-'));
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
        rmSync(tmpDir, { recursive: true, force: true });
    });

    function makeRubric(rows) {
        const sheet = xlsx.utils.aoa_to_sheet(rows);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, sheet, 'Grade');
        const p = join(tmpDir, 'Rubric.xlsx');
        xlsx.writeFile(wb, p);
        return p;
    }

    it('returns game names from column E of the configured row, no warning', () => {
        const rows = [[], ['', '', '', '', 'Boneyard Bluff, Skull Skirmish']];
        const p = makeRubric(rows);
        expect(readGameNamesFromRubric(p, 2)).toEqual(['boneyard bluff', 'skull skirmish']);
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns and returns [] when the configured row has no game names (misconfigured rubricTitleRow)', () => {
        const rows = [['only column A has data']];
        const p = makeRubric(rows);
        expect(readGameNamesFromRubric(p, 1)).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/rubricTitleRow/);
    });

    it('warns and returns [] for a corrupt/unreadable rubric file', () => {
        // Plain text parses fine as CSV (xlsx auto-detects format), so use bytes that
        // look like a truncated/corrupt binary container (PK header with no valid zip
        // body) to force a real parse failure.
        const p = join(tmpDir, 'Corrupt.xlsx');
        writeFileSync(p, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]));
        expect(readGameNamesFromRubric(p, 1)).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatch(/failed to read/);
    });

    it('returns [] silently when the rubric path does not exist (expected absence)', () => {
        expect(readGameNamesFromRubric(join(tmpDir, 'nope.xlsx'), 1)).toEqual([]);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});
