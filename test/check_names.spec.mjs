/**
 * check_names.spec.mjs
 *
 * Tests the Linux/web-portability name checker (POSIX portable set + no spaces).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const checkNamesPhase = require('../pipeline/check_names.js');
const { validateName, findInvalidNames } = checkNamesPhase;

// ── validateName ───────────────────────────────────────────────────────────
describe('validateName', () => {
    it('accepts POSIX-portable names (incl. uppercase and dotfiles)', () => {
        for (const n of ['good-name_1.js', '.gitignore', 'README.md', 'App.js', 'a_b-c.png', 'index.html']) {
            expect(validateName(n), n).toBeNull();
        }
    });

    it('flags spaces distinctly', () => {
        expect(validateName('my file.js')).toEqual({ reason: 'space' });
        expect(validateName('Part 1')).toEqual({ reason: 'space' });
    });

    it('flags out-of-set characters as illegal', () => {
        expect(validateName('café.css').reason).toBe('illegal character');
        expect(validateName('page(1).html').reason).toBe('illegal character');
        expect(validateName('a&b.js').reason).toBe('illegal character');
    });

    it('flags a leading hyphen', () => {
        expect(validateName('-x.js')).toEqual({ reason: 'leading hyphen' });
    });

    it('flags names longer than 255 bytes', () => {
        expect(validateName('a'.repeat(256)).reason).toBe('too long');
    });

    it('honors extraAllowed characters', () => {
        expect(validateName('page(1).html', { extraAllowed: '()' })).toBeNull();
    });
});

// ── findInvalidNames ─────────────────────────────────────────────────────────
describe('findInvalidNames', () => {
    let dir;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'names_test_'));
        writeFileSync(join(dir, 'index.html'), 'x');
        writeFileSync(join(dir, 'my file.js'), 'x');        // bad file (space)
        mkdirSync(join(dir, 'bad dir'));                     // bad folder (space)
        writeFileSync(join(dir, 'bad dir', 'ok.js'), 'x');
        mkdirSync(join(dir, 'src'));
        writeFileSync(join(dir, 'src', 'café.css'), 'x');    // bad file (illegal char)
        // Skip-dirs that hold offending names — must NOT be reported.
        for (const skip of ['node_modules', 'dist']) {
            mkdirSync(join(dir, skip));
            writeFileSync(join(dir, skip, 'junk file.js'), 'x');
        }
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('flags both file and folder names', () => {
        const { badNames } = findInvalidNames(dir);
        const paths = badNames.map(b => b.path).sort();
        expect(paths).toContain('my file.js');
        expect(paths).toContain('bad dir');
        expect(paths.some(p => p.endsWith('café.css'))).toBe(true);
    });

    it('skips node_modules / dist entirely', () => {
        const { badNames } = findInvalidNames(dir);
        expect(badNames.every(b => !/node_modules|dist/.test(b.path))).toBe(true);
    });

    it('records a reason per offender', () => {
        const { badNames } = findInvalidNames(dir);
        expect(badNames.find(b => b.path === 'my file.js').reason).toBe('space');
        expect(badNames.find(b => b.path === 'bad dir').reason).toBe('space');
    });

    it('counts every checked entry (valid + invalid)', () => {
        const { entriesChecked, badNames } = findInvalidNames(dir);
        expect(entriesChecked).toBeGreaterThan(badNames.length);
    });
});

// ── phase entry point ────────────────────────────────────────────────────────
describe('check_names phase entry', () => {
    let dir, artifacts;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'names_phase_'));
        mkdirSync(join(dir, 'bad dir'));                      // space in folder name
        writeFileSync(join(dir, 'bad dir', 'ok.js'), 'x');
        artifacts = mkdtempSync(join(tmpdir(), 'names_artifacts_'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(artifacts, { recursive: true, force: true });
    });

    it('attaches student.nameCheck and writes the report', async () => {
        const students = [{ name: 'Stu', extractedDir: dir }];
        await checkNamesPhase(students, {}, artifacts);

        expect(students[0].nameCheck.errors).toBeGreaterThan(0);
        const reportPath = join(artifacts, 'name_check_report.json');
        expect(existsSync(reportPath)).toBe(true);
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        expect(report[0].student).toBe('Stu');
        expect(report[0].errors).toBeGreaterThan(0);
    });

    it('handles a student with no extracted dir gracefully', async () => {
        const students = [{ name: 'NoCode', extractedDir: null }];
        await checkNamesPhase(students, {}, artifacts);
        expect(students[0].nameCheck).toEqual({ entriesChecked: 0, errors: 0, messages: [], badNames: [] });
    });
});
