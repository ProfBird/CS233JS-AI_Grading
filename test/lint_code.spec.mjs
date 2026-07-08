/**
 * lint_code.spec.mjs
 *
 * Characterization tests for the pre-refactor ESLint phase, written as a regression
 * fence BEFORE lint_code.js is generalized into a language-adapter call. Covers:
 *   - getAllJsFiles exclusion filtering
 *   - the zero/skip output shapes (no extractedDir, no JS files)
 *   - a real ESLint run against the shipped student.eslint.config.mjs, verifying the
 *     output shape and the friendly rule-name mapping used in rubric comments
 *   - eslint.config.mjs resolution priority: step-specific > lab-specific > shipped default
 *     (uses scratch folders under the real configs/ dir, cleaned up in afterEach)
 *
 * lintCode's labName/stepName are passed in explicitly by the caller (run_pipeline.js,
 * threading through bin/grade.js's resolved assignment/step names) rather than derived
 * by climbing up from labDir — see refactoring_plan_2026-07-07.md Priority 3.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import lintCode, { getAllJsFiles } from '../src/pipeline/lint_code.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const CONFIGS_DIR = join(REPO_ROOT, 'configs');

describe('getAllJsFiles', () => {
    let root;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lintfiles-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('collects .js files recursively and respects exclusions and default skip dirs', () => {
        mkdirSync(join(root, 'sub'), { recursive: true });
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        mkdirSync(join(root, 'vendor'), { recursive: true });
        writeFileSync(join(root, 'a.js'), '');
        writeFileSync(join(root, 'sub', 'b.js'), '');
        writeFileSync(join(root, 'node_modules', 'dep.js'), '');
        writeFileSync(join(root, 'vendor', 'c.js'), '');
        writeFileSync(join(root, 'notjs.txt'), '');

        const found = getAllJsFiles(root, ['vendor']);
        expect(found.some(f => f.endsWith('a.js'))).toBe(true);
        expect(found.some(f => f.endsWith(join('sub', 'b.js')))).toBe(true);
        expect(found.some(f => f.includes('node_modules'))).toBe(false); // default-skipped
        expect(found.some(f => f.includes('vendor'))).toBe(false);       // explicitly excluded
        expect(found.some(f => f.endsWith('notjs.txt'))).toBe(false);
    });
});

describe('lintCode phase — zero/skip shapes', () => {
    let root, labDir, student;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'lintphase-'));
        labDir = join(root, '__LintCharacterizationLab__', 'Artifacts');
        mkdirSync(labDir, { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('produces the zero shape when a student has no extractedDir', async () => {
        student = { name: 'NoCode' };
        await lintCode([student], {}, labDir, '__LintCharacterizationLab__');
        expect(student.lint).toEqual({ sourceFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} });
    });

    it('produces the zero shape when extractedDir has no JS files', async () => {
        const extractedDir = join(root, 'extracted');
        mkdirSync(extractedDir, { recursive: true });
        writeFileSync(join(extractedDir, 'index.html'), '<html></html>');
        student = { name: 'HtmlOnly', extractedDir };
        await lintCode([student], {}, labDir, '__LintCharacterizationLab__');
        expect(student.lint).toEqual({ sourceFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} });
    });
});

describe('lintCode phase — real ESLint run against the shipped ruleset', () => {
    let root, labDir, extractedDir, student;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'lintreal-'));
        // labDir's grandparent basename ("labName") must not collide with any real
        // configs/ subfolder, so resolution falls through to the shipped default.
        labDir = join(root, '__LintCharacterizationLab__', 'Artifacts');
        mkdirSync(labDir, { recursive: true });
        extractedDir = join(root, 'extracted');
        mkdirSync(extractedDir, { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('reports errors, warnings, and friendly rule-name messages', async () => {
        // Deliberately triggers exactly: no-unused-vars (warn), eqeqeq (warn),
        // no-undef (error), semi (error) — one each, per the shipped ruleset.
        const code = [
            'var neverUsed = 1;',
            'var flag = 2;',
            'if (flag == 1) {',
            '    console.log(notDefined)',
            '}',
            ''
        ].join('\n');
        writeFileSync(join(extractedDir, 'app.js'), code);
        student = { name: 'Buggy', extractedDir };

        await lintCode([student], {}, labDir, '__LintCharacterizationLab__');

        expect(student.lint.sourceFiles).toBe(1);
        expect(student.lint.errors).toBe(2);   // no-undef + semi
        expect(student.lint.warnings).toBe(2); // no-unused-vars + eqeqeq
        expect(student.lint.messages).toEqual(expect.arrayContaining([
            expect.stringContaining('unused variables'),
            expect.stringContaining('loose equality'),
            expect.stringContaining('undefined variables'),
            expect.stringContaining('missing semicolons'),
        ]));
        expect(student.lint.ruleCounts['no-undef']).toBe(1);
        expect(student.lint.ruleCounts['eqeqeq']).toBe(1);
    }, 15000); // ESLint's cold start (first invocation) can exceed vitest's 5s default

    it('reports a clean file as zero errors/warnings', async () => {
        writeFileSync(join(extractedDir, 'clean.js'), 'const x = 1;\nconsole.log(x);\n');
        student = { name: 'Clean', extractedDir };
        await lintCode([student], {}, labDir, '__LintCharacterizationLab__');
        expect(student.lint.errors).toBe(0);
        expect(student.lint.warnings).toBe(0);
    });
});

describe('lintCode phase — eslint.config.mjs resolution priority', () => {
    let root, scratchLabName, scratchParentName;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'lintcfg-'));
        scratchLabName = '__scratch_lint_lab__';
        scratchParentName = '__scratch_lint_parent__';
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(join(CONFIGS_DIR, scratchLabName), { recursive: true, force: true });
        rmSync(join(CONFIGS_DIR, scratchParentName), { recursive: true, force: true });
    });

    // A config that disables no-undef entirely lets us tell, from the *scoring*, which
    // config file actually got loaded (rather than parsing internal resolution state).
    const permissiveConfig = `
export default [{
    files: ['**/*.js'],
    rules: { 'no-undef': 'off', semi: 'off' }
}];
`;

    it('falls back to the shipped default when no override exists', async () => {
        const labDir = join(root, scratchLabName, 'Artifacts');
        mkdirSync(labDir, { recursive: true });
        const extractedDir = join(root, 'extracted');
        mkdirSync(extractedDir, { recursive: true });
        writeFileSync(join(extractedDir, 'app.js'), 'console.log(notDefined)\n');

        const student = { name: 'Default', extractedDir };
        await lintCode([student], {}, labDir, scratchLabName);
        // Shipped default has no-undef:error and semi:error — both should fire.
        expect(student.lint.errors).toBe(2);
    });

    it('prefers a lab-specific override over the shipped default', async () => {
        mkdirSync(join(CONFIGS_DIR, scratchLabName), { recursive: true });
        writeFileSync(join(CONFIGS_DIR, scratchLabName, 'eslint.config.mjs'), permissiveConfig);

        const labDir = join(root, scratchLabName, 'Artifacts');
        mkdirSync(labDir, { recursive: true });
        const extractedDir = join(root, 'extracted');
        mkdirSync(extractedDir, { recursive: true });
        writeFileSync(join(extractedDir, 'app.js'), 'console.log(notDefined)\n');

        const student = { name: 'LabOverride', extractedDir };
        await lintCode([student], {}, labDir, scratchLabName);
        // Permissive override turns both rules off.
        expect(student.lint.errors).toBe(0);
    });

    it('prefers a step-specific override over a lab-specific one', async () => {
        // Lab-specific override that would flag the issue (i.e. NOT permissive)...
        mkdirSync(join(CONFIGS_DIR, scratchLabName), { recursive: true });
        writeFileSync(join(CONFIGS_DIR, scratchLabName, 'eslint.config.mjs'), `
export default [{ files: ['**/*.js'], rules: { 'no-undef': 'error' } }];
`);
        // ...but the step-specific override (configs/{parent}/{lab}/eslint.config.mjs)
        // should win instead, and it's permissive.
        mkdirSync(join(CONFIGS_DIR, scratchParentName, scratchLabName), { recursive: true });
        writeFileSync(join(CONFIGS_DIR, scratchParentName, scratchLabName, 'eslint.config.mjs'), permissiveConfig);

        // scratchParentName is the real assignment name, scratchLabName is the step —
        // matching the (labName, stepName) convention run_pipeline.js passes through
        // from bin/grade.js's resolved names (labName=assignment, stepName=step).
        const labDir = join(root, scratchParentName, scratchLabName, 'Artifacts');
        mkdirSync(labDir, { recursive: true });
        const extractedDir = join(root, 'extracted');
        mkdirSync(extractedDir, { recursive: true });
        writeFileSync(join(extractedDir, 'app.js'), 'console.log(notDefined)\n');

        const student = { name: 'StepOverride', extractedDir };
        await lintCode([student], {}, labDir, scratchParentName, scratchLabName);
        expect(student.lint.errors).toBe(0);
    });
});
