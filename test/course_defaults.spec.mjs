/**
 * course_defaults.spec.mjs
 *
 * Course-wide config defaults: course_config.json's `defaults` block is merged underneath
 * every lab/step config (src/lib/lab_config.js's applyCourseDefaults), so a course can set
 * e.g. "language": "python" once. Also covers writeCourseConfig keeping fields it wasn't
 * asked to change (a Canvas-ID save must not wipe a hand-written `defaults` block).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { applyCourseDefaults, writeCourseConfig, COURSE_DEFAULTS_FORBIDDEN_KEYS } from '../src/lib/lab_config.js';

describe('applyCourseDefaults', () => {
    const lab = {
        runtimeCheck: 'none',
        mappings: [{ type: 'manual', cell: 'C5' }],
        execution: { timeoutMs: 30000 },
        lint: { exclude: ['tests/'] },
    };

    it('returns the lab config untouched when the course has no defaults', () => {
        expect(applyCourseDefaults(lab, {})).toBe(lab);
        expect(applyCourseDefaults(lab, { courseName: 'CS212' })).toBe(lab);
        expect(applyCourseDefaults(lab, undefined)).toBe(lab);
    });

    it('fills in settings the lab config does not set', () => {
        const merged = applyCourseDefaults(lab, { defaults: { language: 'python', textReport: true } });
        expect(merged.language).toBe('python');
        expect(merged.textReport).toBe(true);
        expect(merged.mappings).toBe(lab.mappings);
    });

    it('lets the lab config win, merging nested objects key by key', () => {
        const merged = applyCourseDefaults(lab, { defaults: {
            runtimeCheck: 'run_check',
            execution: { mode: 'direct', timeoutMs: 10000 },
        } });
        expect(merged.runtimeCheck).toBe('none');
        expect(merged.execution).toEqual({ mode: 'direct', timeoutMs: 30000 });
    });

    it('replaces arrays instead of concatenating them', () => {
        const merged = applyCourseDefaults(lab, { defaults: { lint: { exclude: ['.venv/', 'data/'] } } });
        expect(merged.lint.exclude).toEqual(['tests/']);
    });

    it('does not modify its inputs', () => {
        const course = { defaults: { execution: { mode: 'direct' } } };
        const labCopy = structuredClone(lab);
        const courseCopy = structuredClone(course);
        applyCourseDefaults(lab, course);
        expect(lab).toEqual(labCopy);
        expect(course).toEqual(courseCopy);
    });

    it.each(COURSE_DEFAULTS_FORBIDDEN_KEYS)('rejects a per-assignment key in defaults: %s', key => {
        expect(() => applyCourseDefaults(lab, { defaults: { [key]: [] } })).toThrow(new RegExp(key));
    });

    it('rejects a defaults value that is not an object', () => {
        expect(() => applyCourseDefaults(lab, { defaults: ['python'] })).toThrow(/must be an object/);
    });
});

describe('writeCourseConfig', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'coursecfg-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('keeps fields already in course_config.json that the caller did not pass', () => {
        writeFileSync(join(dir, 'course_config.json'), JSON.stringify({
            courseName: 'CS212', courseCode: 'CS212', rubricPrefix: 'CS212',
            defaults: { language: 'python' },
        }));
        writeCourseConfig(dir, { courseName: 'CS212', courseCode: 'CS212', rubricPrefix: 'CS212', canvasCourseId: 42 });
        expect(JSON.parse(readFileSync(join(dir, 'course_config.json'), 'utf8'))).toEqual({
            courseName: 'CS212', courseCode: 'CS212', rubricPrefix: 'CS212',
            defaults: { language: 'python' }, canvasCourseId: 42,
        });
    });
});
