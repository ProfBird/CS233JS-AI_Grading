/**
 * typescript.spec.mjs
 *
 * Adapter-level tests for src/adapters/typescript.js, validating the interface
 * abstraction from Phase 1 against a second real implementation: reused JS mechanics
 * (checkManifest, extractUsedPackages, detectProject discovery) plus TS-specific
 * pieces (typescript-eslint lint config, tsc --noEmit build check).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import tsAdapter from '../../src/adapters/typescript.js';
import { isValidDiagnostics, REQUIRED_ADAPTER_KEYS } from '../../src/adapters/base.js';
import { resolveAdapter } from '../../src/adapters/index.js';

describe('typescript adapter — interface contract', () => {
    it('exposes all required adapter keys', () => {
        for (const key of REQUIRED_ADAPTER_KEYS) {
            expect(tsAdapter).toHaveProperty(key);
        }
    });

    it('resolveAdapter({language: "typescript"}) returns it', () => {
        expect(resolveAdapter({ language: 'typescript' })).toBe(tsAdapter);
    });

    it('reuses the JS adapter\'s comment-stripping (shared C-style/string-literal syntax)', () => {
        expect(tsAdapter.stripComments('const x = 1; // comment\nlet y = 2;'))
            .toBe('const x = 1; \nlet y = 2;');
    });
});

describe('typescript adapter — lint() with the shipped typescript-eslint ruleset', () => {
    it('reports an undefined-variable-shaped error is off (TS handles type checking) but style issues are caught', async () => {
        const root = mkdtempSync(join(tmpdir(), 'tsadapter-lint-'));
        try {
            const file = join(root, 'app.ts');
            // Missing semicolon (error) + loose equality (warning) + unused var (warning).
            writeFileSync(file, [
                'const flag: number = 2;',
                'let neverUsed: number = 1;',
                'if (flag == 1) {',
                '    console.log("hi")',
                '}',
            ].join('\n'));

            const defaultConfig = join(import.meta.dirname, '..', '..', 'eslint', 'student.typescript.eslint.config.mjs');
            const result = await tsAdapter.lint([file], root, defaultConfig);
            expect(isValidDiagnostics(result)).toBe(true);
            expect(result.errors).toBeGreaterThan(0); // missing semicolon
            expect(result.warnings).toBeGreaterThan(0); // eqeqeq + unused var
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);

    it('a clean .ts file lints with zero issues', async () => {
        const root = mkdtempSync(join(tmpdir(), 'tsadapter-clean-'));
        try {
            const file = join(root, 'clean.ts');
            writeFileSync(file, 'const x: number = 1;\nconsole.log(x);\n');
            const defaultConfig = join(import.meta.dirname, '..', '..', 'eslint', 'student.typescript.eslint.config.mjs');
            const result = await tsAdapter.lint([file], root, defaultConfig);
            expect(result.errors).toBe(0);
            expect(result.warnings).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);
});

describe('typescript adapter — detectProject()', () => {
    it('finds npm projects the same way the JS adapter does, tagged npm-ts', () => {
        const root = mkdtempSync(join(tmpdir(), 'tsproject-'));
        try {
            writeFileSync(join(root, 'package.json'), '{}');
            const projects = tsAdapter.detectProject(root);
            expect(projects.length).toBe(1);
            expect(projects[0].type).toBe('npm-ts');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('typescript adapter — build() via tsc --noEmit', () => {
    it('succeeds for a type-correct project', async () => {
        const root = mkdtempSync(join(tmpdir(), 'tsbuild-ok-'));
        try {
            writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
            writeFileSync(join(root, 'app.ts'), 'const x: number = 1;\nconsole.log(x);\n');
            const result = await tsAdapter.build({ dir: root });
            expect(result.success).toBe(true);
            expect(result.errors).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30000);

    it('reports type errors for a type-incorrect project', async () => {
        const root = mkdtempSync(join(tmpdir(), 'tsbuild-fail-'));
        try {
            writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
            writeFileSync(join(root, 'app.ts'), 'const x: number = "not a number";\n');
            const result = await tsAdapter.build({ dir: root });
            expect(result.success).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors.join(' ')).toMatch(/TS\d+/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30000);
});
