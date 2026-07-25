/**
 * resolve_lab_dir.spec.mjs
 *
 * Tests the legacy labRoot fallback logic used by bin/grade.js.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveLegacyLabDir } from '../src/lib/resolve_lab_dir.js';

function makeDriver(askBooleanResponse) {
    return {
        print() {},
        note() {},
        askBoolean: async () => askBooleanResponse,
    };
}

function makeCourses(count) {
    return Array.from({ length: count }, (_, i) => ({ name: `Course${i}` }));
}

let root;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'resolve_lab_dir_test_'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('resolveLegacyLabDir', () => {
    it('uses the course-scoped path when it already exists', async () => {
        const labDir = join(root, 'CIS195', 'Lab01');
        const legacyLabDir = join(root, 'Lab01');
        mkdirSync(labDir, { recursive: true });

        const result = await resolveLegacyLabDir({
            labDir,
            legacyLabDir,
            courseName: 'CIS195',
            labName: 'Lab01',
            usingCanvas: false,
            courses: makeCourses(2),
            driver: makeDriver(false),
        });

        expect(result).toBe(labDir);
    });

    it('falls back to the legacy flat path automatically with only one course', async () => {
        const labDir = join(root, 'CIS195', 'Lab01');
        const legacyLabDir = join(root, 'Lab01');
        mkdirSync(legacyLabDir, { recursive: true });
        expect(existsSync(labDir)).toBe(false);

        const result = await resolveLegacyLabDir({
            labDir,
            legacyLabDir,
            courseName: 'CIS195',
            labName: 'Lab01',
            usingCanvas: false,
            courses: makeCourses(1),
            driver: makeDriver(false),
        });

        expect(result).toBe(legacyLabDir);
    });

    it('prompts and uses the legacy flat path when user confirms with multiple courses', async () => {
        const labDir = join(root, 'CIS195', 'Lab01');
        const legacyLabDir = join(root, 'Lab01');
        mkdirSync(legacyLabDir, { recursive: true });

        const result = await resolveLegacyLabDir({
            labDir,
            legacyLabDir,
            courseName: 'CIS195',
            labName: 'Lab01',
            usingCanvas: false,
            courses: makeCourses(2),
            driver: makeDriver(true),
        });

        expect(result).toBe(legacyLabDir);
    });

    it('prompts and keeps the course-scoped path when user declines with multiple courses', async () => {
        const labDir = join(root, 'CIS195', 'Lab01');
        const legacyLabDir = join(root, 'Lab01');
        mkdirSync(legacyLabDir, { recursive: true });

        const result = await resolveLegacyLabDir({
            labDir,
            legacyLabDir,
            courseName: 'CIS195',
            labName: 'Lab01',
            usingCanvas: false,
            courses: makeCourses(2),
            driver: makeDriver(false),
        });

        expect(result).toBe(labDir);
    });

    it('does not fall back when Canvas is the source', async () => {
        const labDir = join(root, 'CIS195', 'Lab01');
        const legacyLabDir = join(root, 'Lab01');
        mkdirSync(legacyLabDir, { recursive: true });

        const result = await resolveLegacyLabDir({
            labDir,
            legacyLabDir,
            courseName: 'CIS195',
            labName: 'Lab01',
            usingCanvas: true,
            courses: makeCourses(1),
            driver: makeDriver(false),
        });

        expect(result).toBe(labDir);
    });

    it('does not fall back when no legacy folder exists', async () => {
        const labDir = join(root, 'CIS195', 'Lab01');
        const legacyLabDir = join(root, 'Lab01');

        const result = await resolveLegacyLabDir({
            labDir,
            legacyLabDir,
            courseName: 'CIS195',
            labName: 'Lab01',
            usingCanvas: false,
            courses: makeCourses(1),
            driver: makeDriver(false),
        });

        expect(result).toBe(labDir);
    });
});
