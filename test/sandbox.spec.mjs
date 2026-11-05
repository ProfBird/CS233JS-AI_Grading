/**
 * sandbox.spec.mjs
 *
 * Tests for the runStudentArtifact() isolation chokepoint (src/lib/sandbox.js). Uses
 * `node -e` as the "artifact" under test — always available, no compiler required —
 * to exercise direct-mode execution for real: stdout/exit-code capture, stdin pass-through,
 * timeout+kill, and the throwaway-cwd containment property. restricted-user/container are
 * verified to fail loudly rather than silently falling back to direct.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runStudentArtifact, scrubEnv } from '../src/lib/sandbox.js';

describe('runStudentArtifact — direct mode', () => {
    it('captures stdout and a zero exit code on success', async () => {
        const result = await runStudentArtifact(['node', '-e', 'console.log("hello grader")']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('hello grader');
        expect(result.timedOut).toBe(false);
    });

    it('captures a non-zero exit code and stderr', async () => {
        const result = await runStudentArtifact(['node', '-e', 'console.error("boom"); process.exit(2)']);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('boom');
    });

    it('pipes stdin through to the child process', async () => {
        const script = `
            let data = '';
            process.stdin.on('data', d => data += d);
            process.stdin.on('end', () => console.log('got:' + data.trim()));
        `;
        const result = await runStudentArtifact(['node', '-e', script], { stdin: '42\n' });
        expect(result.stdout).toContain('got:42');
    });

    it('times out and kills a hanging process rather than waiting forever', async () => {
        const result = await runStudentArtifact(
            ['node', '-e', 'setInterval(() => {}, 1000)'], // never exits on its own
            { timeoutMs: 500 }
        );
        expect(result.timedOut).toBe(true);
        expect(result.code).toBeNull();
    }, 10000);

    it('runs from a fresh throwaway cwd, not the caller\'s directory', async () => {
        // Have the child report its own cwd; it must not be this test file's directory.
        const result = await runStudentArtifact(['node', '-e', 'console.log(process.cwd())']);
        const childCwd = result.stdout.trim();
        expect(childCwd).not.toBe(import.meta.dirname);
        expect(childCwd.toLowerCase()).toContain(tmpdir().toLowerCase().slice(0, 10)); // lives under the OS temp dir
    });

    it('a relative-path file write from the child lands in the scratch dir, not the test tree', async () => {
        // Regression guard for the "accidental relative-path clobber" containment property:
        // the child writes "marker.txt" relative to its own cwd, which must be the scratch
        // dir sandbox.js creates — never a caller-visible path we'd need to clean up here.
        await runStudentArtifact(['node', '-e', "require('fs').writeFileSync('marker.txt', 'x')"]);
        expect(existsSync(join(import.meta.dirname, 'marker.txt'))).toBe(false);
        expect(existsSync(join(process.cwd(), 'marker.txt'))).toBe(false);
    });
});

describe('runStudentArtifact — unimplemented modes fail loudly, never fall back', () => {
    it('rejects with an explicit error for "restricted-user"', async () => {
        await expect(runStudentArtifact(['node', '-e', 'console.log(1)'], { mode: 'restricted-user' }))
            .rejects.toThrow(/not implemented/i);
    });

    it('rejects with an explicit error for "container"', async () => {
        await expect(runStudentArtifact(['node', '-e', 'console.log(1)'], { mode: 'container' }))
            .rejects.toThrow(/not implemented/i);
    });

    it('rejects for an unrecognized mode', async () => {
        await expect(runStudentArtifact(['node', '-e', 'console.log(1)'], { mode: 'yolo' }))
            .rejects.toThrow(/Unknown execution.mode/);
    });
});

describe('runStudentArtifact — project copy, support files, environment', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = await import('fs');
    // A tiny "student program": prints the files in its working directory (recursively)
    // and the contents of Data/a.csv.
    const lister = `
        const fs = require('fs'), path = require('path');
        const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
        console.log(JSON.stringify({ files: walk('.').sort(), csv: fs.existsSync('Data/a.csv') ? fs.readFileSync('Data/a.csv', 'utf8') : null }));
    `;

    it('runs in a copy of the project, skipping .venv/.git/__pycache__, never touching the original', async () => {
        const project = mkdtempSync(join(tmpdir(), 'sbx-proj-'));
        try {
            writeFileSync(join(project, 'main.py'), 'print(1)');
            mkdirSync(join(project, '.venv', 'lib'), { recursive: true });
            writeFileSync(join(project, '.venv', 'lib', 'x.py'), '');
            mkdirSync(join(project, '__pycache__'));
            writeFileSync(join(project, '__pycache__', 'm.pyc'), '');
            const result = await runStudentArtifact(['node', '-e', lister + "fs.writeFileSync('scratch.txt', 'x')"], { cwdSource: project });
            expect(JSON.parse(result.stdout).files).toEqual(['main.py']);
            expect(existsSync(join(project, 'scratch.txt'))).toBe(false);   // write landed in the copy
        } finally {
            rmSync(project, { recursive: true, force: true });
        }
    });

    it('adds support files only where the student has none (student edits win)', async () => {
        const project = mkdtempSync(join(tmpdir(), 'sbx-proj-'));
        const support = mkdtempSync(join(tmpdir(), 'sbx-support-'));
        try {
            mkdirSync(join(support, 'Data'));
            writeFileSync(join(support, 'Data', 'a.csv'), 'instructor a');
            writeFileSync(join(support, 'Data', 'b.csv'), 'instructor b');
            mkdirSync(join(project, 'Data'));
            writeFileSync(join(project, 'Data', 'a.csv'), 'student a');
            const result = await runStudentArtifact(['node', '-e', lister], {
                cwdSource: project,
                supportFiles: [{ from: join(support, 'Data'), to: 'Data' }],
            });
            const out = JSON.parse(result.stdout);
            expect(out.files).toEqual(['Data/a.csv', 'Data/b.csv'].map(p => join(...p.split('/'))));
            expect(out.csv).toBe('student a');
            expect(readFileSync(join(project, 'Data', 'a.csv'), 'utf8')).toBe('student a');
        } finally {
            rmSync(project, { recursive: true, force: true });
            rmSync(support, { recursive: true, force: true });
        }
    });

    it('reports a missing support file as a setup error instead of running', async () => {
        const result = await runStudentArtifact(['node', '-e', 'console.log("ran")'], {
            supportFiles: [{ from: join(tmpdir(), 'definitely-not-here-xyz'), to: 'Data' }],
        });
        expect(result.setupError).toBe(true);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/support file not found/);
    });

    it("hides the grader's secrets from the student program's environment", async () => {
        const saved = { CANVAS_TOKEN: process.env.CANVAS_TOKEN, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
        process.env.CANVAS_TOKEN = 'secret-canvas';
        process.env.OPENROUTER_API_KEY = 'secret-llm';
        try {
            const result = await runStudentArtifact(['node', '-e',
                'console.log(JSON.stringify([process.env.CANVAS_TOKEN, process.env.OPENROUTER_API_KEY, !!process.env.PATH, process.env.EXTRA]))'],
                { env: { EXTRA: 'given' } });
            expect(JSON.parse(result.stdout)).toEqual([null, null, true, 'given']);
        } finally {
            for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
    });
});

describe('scrubEnv', () => {
    it('removes token/key/secret-style variables and keeps the rest', () => {
        const env = {
            PATH: '/bin', HOME: '/h', LANG: 'C', PYTHONPATH: 'x',
            CANVAS_URL: 'u', GITHUB_TOKEN: 't', OPENAI_API_KEY: 'k', LLM_API_KEY: 'k',
            DEEPSEEK_KEY: 'k', OPENAI_KEY: 'k', GH_PAT: 'p', AWS_SECRET_ACCESS_KEY: 's', DB_PASSWORD: 'p',
        };
        expect(Object.keys(scrubEnv(env)).sort()).toEqual(['HOME', 'LANG', 'PATH', 'PYTHONPATH']);
    });
});
