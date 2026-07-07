/**
 * javascript.spec.mjs
 *
 * Adapter-level tests for src/adapters/javascript.js — verifying it satisfies the
 * interface contract in src/adapters/base.js directly (not through a pipeline phase).
 * Establishes the pattern later per-language adapter tests (typescript/python/cpp/csharp)
 * follow: shape checks via isValidDiagnostics, detectProject structure, capability nulls.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import jsAdapter from '../../src/adapters/javascript.js';
import { isValidDiagnostics, REQUIRED_ADAPTER_KEYS } from '../../src/adapters/base.js';
import { resolveAdapter } from '../../src/adapters/index.js';

describe('javascript adapter — interface contract', () => {
    it('exposes all required adapter keys', () => {
        for (const key of REQUIRED_ADAPTER_KEYS) {
            expect(jsAdapter).toHaveProperty(key);
        }
    });

    it('resolveAdapter({}) and resolveAdapter({language: "javascript"}) both return it', () => {
        expect(resolveAdapter({})).toBe(jsAdapter);
        expect(resolveAdapter({ language: 'javascript' })).toBe(jsAdapter);
    });

    it('resolveAdapter throws for an unregistered language', () => {
        expect(() => resolveAdapter({ language: 'cobol' })).toThrow(/Unknown language/);
    });
});

describe('javascript adapter — lint() produces valid diagnostics shape', () => {
    it('a clean file satisfies isValidDiagnostics', async () => {
        const root = mkdtempSync(join(tmpdir(), 'jsadapter-'));
        try {
            const file = join(root, 'clean.js');
            writeFileSync(file, 'const x = 1;\nconsole.log(x);\n');
            const result = await jsAdapter.lint([file], root, null);
            expect(isValidDiagnostics(result)).toBe(true);
            expect(result.errors).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);

    it('a buggy file satisfies isValidDiagnostics with nonzero counts', async () => {
        const root = mkdtempSync(join(tmpdir(), 'jsadapter-'));
        try {
            const file = join(root, 'buggy.js');
            writeFileSync(file, 'console.log(notDefined)\n');
            const defaultConfig = join(import.meta.dirname, '..', '..', 'eslint', 'student.eslint.config.mjs');
            const result = await jsAdapter.lint([file], root, defaultConfig);
            expect(isValidDiagnostics(result)).toBe(true);
            expect(result.errors).toBeGreaterThan(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 15000);

    it('an empty file list returns a valid empty-shape diagnostics object', async () => {
        const result = await jsAdapter.lint([], '/does/not/matter', null);
        expect(isValidDiagnostics(result)).toBe(true);
        expect(result.errors).toBe(0);
        expect(result.warnings).toBe(0);
    });
});

describe('javascript adapter — detectProject()', () => {
    it('returns an array of Project descriptors with the documented shape', () => {
        const root = mkdtempSync(join(tmpdir(), 'jsproject-'));
        try {
            mkdirSync(join(root, 'sub'), { recursive: true });
            writeFileSync(join(root, 'package.json'), '{}');
            writeFileSync(join(root, 'sub', 'package.json'), '{}');

            const projects = jsAdapter.detectProject(root);
            expect(Array.isArray(projects)).toBe(true);
            expect(projects.length).toBe(2);
            for (const p of projects) {
                expect(p).toHaveProperty('dir');
                expect(p).toHaveProperty('type', 'npm');
                expect(Array.isArray(p.buildCommand)).toBe(true);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('returns an empty array when there is no project', () => {
        const root = mkdtempSync(join(tmpdir(), 'jsproject-empty-'));
        try {
            expect(jsAdapter.detectProject(root)).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('javascript adapter — checkManifest / extractUsedPackages', () => {
    it('flags a required dependency missing from package.json', () => {
        const root = mkdtempSync(join(tmpdir(), 'jsmanifest-'));
        try {
            writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
            const result = jsAdapter.checkManifest(root, { dependencies: ['express'] });
            expect(result.found).toBe(true);
            expect(result.passed).toBe(false);
            expect(result.issues.join(' ')).toMatch(/express/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('extractUsedPackages finds import specifiers', () => {
        const root = mkdtempSync(join(tmpdir(), 'jsused-'));
        try {
            writeFileSync(join(root, 'app.js'), "import express from 'express';\n");
            const used = jsAdapter.extractUsedPackages(root, []);
            expect(used.has('express')).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
