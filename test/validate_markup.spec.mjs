/**
 * validate_markup.spec.mjs
 *
 * Tests the shared file collector and the HTML/CSS validators.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getAllFilesByExt } = require('../lib/file_walker.js');
const validateHtmlPhase = require('../pipeline/validate_html.js');
const validateCssPhase = require('../pipeline/validate_css.js');
const { validateHtmlFiles } = validateHtmlPhase;
const { validateCssFiles } = validateCssPhase;

// ── getAllFilesByExt ─────────────────────────────────────────────────────
describe('getAllFilesByExt', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'validate_test_'));
        writeFileSync(join(dir, 'index.html'), '<p>hi</p>');
        writeFileSync(join(dir, 'style.css'), 'body{}');
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src', 'about.html'), '<p>about</p>');
        // Dirs that must be skipped — each holds a file with the target extension.
        for (const skip of ['node_modules', 'dist', 'build', '.git', '__MACOSX']) {
            mkdirSync(join(dir, skip));
            writeFileSync(join(dir, skip, 'junk.html'), '<p>junk</p>');
            writeFileSync(join(dir, skip, 'junk.css'), 'a{}');
        }
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('collects matching files in root and subdirs', () => {
        const html = getAllFilesByExt(dir, '.html');
        expect(html.length).toBe(2);          // index.html + src/about.html
        expect(html.some(f => f.endsWith('about.html'))).toBe(true);
    });

    it('skips node_modules / dist / build / .git / __MACOSX', () => {
        const html = getAllFilesByExt(dir, '.html');
        expect(html.every(f => !/node_modules|dist|build|\.git|__MACOSX/.test(f))).toBe(true);
    });

    it('accepts an array of extensions, case-insensitively', () => {
        writeFileSync(join(dir, 'page.HTM'), '<p>x</p>');
        const html = getAllFilesByExt(dir, ['.html', '.htm']);
        expect(html.some(f => f.endsWith('page.HTM'))).toBe(true);
    });

    it('honors caller exclusions (substring match)', () => {
        const html = getAllFilesByExt(dir, '.html', ['src']);
        expect(html.every(f => !f.includes('/src/'))).toBe(true);
    });
});

// ── HTML validator ───────────────────────────────────────────────────────
describe('validateHtmlFiles', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'html_test_')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reports zero errors for valid HTML', async () => {
        const good = join(dir, 'good.html');
        writeFileSync(good, '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>x</title></head><body><p>hi</p></body></html>');
        const r = await validateHtmlFiles([good]);
        expect(r.errors).toBe(0);
    });

    it('reports errors and messages for invalid HTML', async () => {
        const bad = join(dir, 'bad.html');
        writeFileSync(bad, '<html><head></head><body><p>hi<div></p></body></html>');
        const r = await validateHtmlFiles([bad]);
        expect(r.errors).toBeGreaterThan(0);
        expect(r.messages.length).toBeGreaterThan(0);
    });

    it('returns the empty result for no files', async () => {
        expect(await validateHtmlFiles([])).toEqual({ errors: 0, warnings: 0, messages: [], ruleCounts: {} });
    });
});

// ── CSS validator ──────────────────────────────────────────────────────────
describe('validateCssFiles', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'css_test_')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('reports zero errors for valid (incl. modern) CSS', () => {
        const good = join(dir, 'good.css');
        writeFileSync(good, 'body { color: red; margin: 0 auto; } .x { display: flex; gap: 1rem; }');
        expect(validateCssFiles([good]).errors).toBe(0);
    });

    it('reports errors for invalid CSS', () => {
        const bad = join(dir, 'bad.css');
        writeFileSync(bad, 'body { colr: red; } .x { display: flxbox; }');
        const r = validateCssFiles([bad]);
        expect(r.errors).toBeGreaterThan(0);
        expect(r.messages.length).toBeGreaterThan(0);
    });

    it('returns the empty result for no files', () => {
        expect(validateCssFiles([])).toEqual({ errors: 0, warnings: 0, messages: [], ruleCounts: {} });
    });
});

// ── phase entry points ───────────────────────────────────────────────────────
describe('validation phase entries', () => {
    let dir, artifacts;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'markup_phase_'));
        writeFileSync(join(dir, 'bad.html'), '<html><head></head><body><p>hi<div></p></body></html>');
        writeFileSync(join(dir, 'bad.css'), 'body { colr: red; }');
        artifacts = mkdtempSync(join(tmpdir(), 'markup_artifacts_'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(artifacts, { recursive: true, force: true });
    });

    it('validate_html sets student.htmlValidation and writes its report', async () => {
        const students = [{ name: 'Stu', extractedDir: dir }];
        await validateHtmlPhase(students, {}, artifacts);
        expect(students[0].htmlValidation.errors).toBeGreaterThan(0);
        expect(existsSync(join(artifacts, 'html_validation_report.json'))).toBe(true);
    });

    it('validate_css sets student.cssValidation and writes its report', async () => {
        const students = [{ name: 'Stu', extractedDir: dir }];
        await validateCssPhase(students, {}, artifacts);
        expect(students[0].cssValidation.errors).toBeGreaterThan(0);
        expect(existsSync(join(artifacts, 'css_validation_report.json'))).toBe(true);
    });
});
