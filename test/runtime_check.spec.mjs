/**
 * runtime_check.spec.mjs
 *
 * Characterization tests for the pre-refactor runtime-check phase, written as a
 * regression fence BEFORE runtime_check.js is generalized into a check-strategy
 * registry. `child_process.exec`/`spawn` are mocked so "build" mode and scripts_check
 * never shell out to a real npm install — only the two "browser" mode integration tests
 * launch real headless Chrome (skipped if Puppeteer can't launch in this environment).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

vi.mock('child_process', async () => {
    const actual = await vi.importActual('child_process');
    return { ...actual, exec: vi.fn(), spawn: vi.fn(), execFileSync: vi.fn() };
});
import { exec, spawn } from 'child_process';

const {
    default: runtimeCheck,
    findAllIndexHtmlDirs,
    findDistIndexHtmlDirs,
    findPackageJsonDirs,
    getCheckStrategy,
    VALID_RUNTIME_MODES,
} = await import('../src/pipeline/runtime_check.js');

// exec() is wrapped via util.promisify in runtime_check.js — the callback form must
// be honored: exec(cmd, opts, callback) or exec(cmd, callback).
function mockExecSequence(results) {
    let call = 0;
    vi.mocked(exec).mockImplementation((...args) => {
        const cb = args[args.length - 1];
        const result = results[Math.min(call, results.length - 1)];
        call++;
        if (result.error) cb(result.error);
        else cb(null, { stdout: result.stdout || '', stderr: result.stderr || '' });
    });
}

// Minimal fake ChildProcess: stdout/stderr are EventEmitters, plus an 'on'/'close' pair.
function makeFakeChild({ code = 0, stdout = '', stderr = '' } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => {}, end: () => {} };
    child.pid = 12345;
    setImmediate(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', code);
    });
    return child;
}

describe('findAllIndexHtmlDirs / findDistIndexHtmlDirs / findPackageJsonDirs', () => {
    let root;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rtfind-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('finds index.html dirs but skips node_modules/dist', () => {
        mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'index.html'), '<html></html>');
        writeFileSync(join(root, 'src', 'index.html'), '<html></html>');
        writeFileSync(join(root, 'node_modules', 'pkg', 'index.html'), '<html></html>');

        const found = findAllIndexHtmlDirs(root);
        expect(found).toContain(root);
        expect(found).toContain(join(root, 'src'));
        expect(found.some(d => d.includes('node_modules'))).toBe(false);
    });

    it('finds dist/ dirs containing index.html', () => {
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'dist', 'index.html'), '<html></html>');
        const found = findDistIndexHtmlDirs(root);
        expect(found).toEqual([join(root, 'dist')]);
    });

    it('finds package.json dirs but skips node_modules/dist', () => {
        mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
        writeFileSync(join(root, 'package.json'), '{}');
        writeFileSync(join(root, 'node_modules', 'pkg', 'package.json'), '{}');
        const found = findPackageJsonDirs(root);
        expect(found).toEqual([root]);
    });
});

describe('runtimeCheck phase — "build" mode (mocked exec)', () => {
    let root, labDir, extractedDir;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'rtbuild-'));
        labDir = join(root, 'Artifacts');
        mkdirSync(labDir, { recursive: true });
        extractedDir = join(root, 'extracted');
        mkdirSync(extractedDir, { recursive: true });
        writeFileSync(join(extractedDir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
        vi.mocked(exec).mockReset();
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('reports success when install and build both succeed', async () => {
        mockExecSequence([{ stdout: 'installed' }, { stdout: 'built' }]);
        const student = { name: 'Good', extractedDir };
        await runtimeCheck([student], { runtimeCheck: 'build' }, labDir);
        expect(student.runtimeCheck).toEqual({ success: true, errors: [] });
    });

    it('reports failure when npm install fails', async () => {
        mockExecSequence([{ error: new Error('install exploded') }]);
        const student = { name: 'BadInstall', extractedDir };
        await runtimeCheck([student], { runtimeCheck: 'build' }, labDir);
        expect(student.runtimeCheck.success).toBe(false);
        expect(student.runtimeCheck.errors[0]).toMatch(/npm install failed/);
    });

    it('reports failure when npm run build fails after install succeeds', async () => {
        mockExecSequence([{ stdout: 'installed' }, { error: new Error('build exploded') }]);
        const student = { name: 'BadBuild', extractedDir };
        await runtimeCheck([student], { runtimeCheck: 'build' }, labDir);
        expect(student.runtimeCheck.success).toBe(false);
        expect(student.runtimeCheck.errors[0]).toMatch(/npm run build failed/);
    });

    it('reports failure with no package.json found', async () => {
        const emptyDir = join(root, 'empty');
        mkdirSync(emptyDir, { recursive: true });
        const student = { name: 'NoPkg', extractedDir: emptyDir };
        await runtimeCheck([student], { runtimeCheck: 'build' }, labDir);
        expect(student.runtimeCheck).toEqual({ success: false, errors: ['No package.json found'] });
    });
});

describe('runtimeCheck phase — scripts_check (mocked spawn)', () => {
    let root, labDir, extractedDir;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'rtscripts-'));
        labDir = join(root, 'Artifacts');
        mkdirSync(labDir, { recursive: true });
        extractedDir = join(root, 'extracted');
        mkdirSync(extractedDir, { recursive: true });
        mkdirSync(join(extractedDir, 'node_modules'), { recursive: true }); // skip the install step
        writeFileSync(join(extractedDir, 'package.json'), JSON.stringify({
            scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' }
        }));
        vi.mocked(spawn).mockReset();
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('marks server scripts (dev) as passed-if-defined without running them', async () => {
        // Only "build" and "test" should ever spawn; "dev" must not.
        vi.mocked(spawn).mockImplementation(() => makeFakeChild({ code: 0 }));
        const student = { name: 'Scripty', extractedDir };
        const config = { runtimeCheck: 'build', mappings: [{ type: 'scripts_check', scripts: 'dev,build,test', maxScore: 3 }] };
        mockExecSequence([{ stdout: 'built' }]); // the "build" runtimeCheck mode itself
        await runtimeCheck([student], config, labDir);

        expect(student.scriptsCheck.scripts.dev).toEqual({ defined: true, ran: false, passed: true, error: null });
        expect(spawn).not.toHaveBeenCalledWith('npm', ['run', 'dev'], expect.anything());
    });

    it('runs build/test scripts via spawn and records pass/fail', async () => {
        vi.mocked(spawn).mockImplementation((_cmd, args) => {
            const script = args[1];
            return makeFakeChild({ code: script === 'test' ? 1 : 0, stderr: script === 'test' ? 'FAIL something' : '' });
        });
        mockExecSequence([{ stdout: 'built' }]);
        const student = { name: 'Scripty2', extractedDir };
        const config = { runtimeCheck: 'build', mappings: [{ type: 'scripts_check', scripts: 'build,test', maxScore: 2 }] };
        await runtimeCheck([student], config, labDir);

        expect(student.scriptsCheck.scripts.build.passed).toBe(true);
        expect(student.scriptsCheck.scripts.test.passed).toBe(false);
    });
});

describe('runtimeCheck phase — "browser" mode (real headless Chrome)', () => {
    let root, labDir, extractedDir, puppeteerAvailable = true;

    beforeEach(async () => {
        root = mkdtempSync(join(tmpdir(), 'rtbrowser-'));
        labDir = join(root, 'Artifacts');
        mkdirSync(labDir, { recursive: true });
        extractedDir = join(root, 'extracted');
        mkdirSync(extractedDir, { recursive: true });
        try {
            const puppeteer = (await import('puppeteer')).default;
            const b = await puppeteer.launch({ headless: 'shell' });
            await b.close();
        } catch (e) {
            puppeteerAvailable = false;
        }
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('reports no console errors for a clean page', async (ctx) => {
        if (!puppeteerAvailable) return ctx.skip();
        writeFileSync(join(extractedDir, 'index.html'), '<html><body>hi</body></html>');
        const student = { name: 'CleanPage', extractedDir };
        await runtimeCheck([student], { runtimeCheck: 'browser' }, labDir);
        expect(student.runtimeCheck.success).toBe(true);
    }, 20000);

    it('reports a JS console error thrown on load', async (ctx) => {
        if (!puppeteerAvailable) return ctx.skip();
        writeFileSync(join(extractedDir, 'index.html'), '<html><body><script>undefinedFn();</script></body></html>');
        const student = { name: 'ErrorPage', extractedDir };
        await runtimeCheck([student], { runtimeCheck: 'browser' }, labDir);
        expect(student.runtimeCheck.success).toBe(false);
        expect(student.runtimeCheck.errors.join(' ')).toMatch(/undefinedFn/);
    }, 20000);
});

describe('"run_check" strategy — direct execution against a fake adapter', () => {
    // Exercises the strategy in isolation (no resolveAdapter/registered language needed),
    // the way a future C++/C#/Python adapter's runCommand would be invoked.
    const runCheck = () => getCheckStrategy('run_check').fn;

    beforeEach(() => { vi.mocked(spawn).mockReset(); });

    it('registers "run_check" as a valid runtime mode', () => {
        expect(VALID_RUNTIME_MODES.has('run_check')).toBe(true);
    });

    it('succeeds when the program exits 0 and matches expected output', async () => {
        vi.mocked(spawn).mockImplementation(() => makeFakeChild({ code: 0, stdout: 'sum: 7\n' }));
        const fakeAdapter = {
            detectProject: () => [{ dir: '/tmp/proj', runCommand: ['./a.out'], artifactPath: null }],
        };
        const student = { extractedDir: '/tmp/proj' };
        const config = { runCheck: { stdin: '3\n4\n', expectPatterns: ['sum:\\s*7'] } };
        const result = await runCheck()(student, config, { adapter: fakeAdapter });
        expect(result.success).toBe(true);
        expect(result.errors).toEqual([]);
    });

    it('fails when the expected output pattern is not found', async () => {
        vi.mocked(spawn).mockImplementation(() => makeFakeChild({ code: 0, stdout: 'wrong output\n' }));
        const fakeAdapter = {
            detectProject: () => [{ dir: '/tmp/proj', runCommand: ['./a.out'], artifactPath: null }],
        };
        const student = { extractedDir: '/tmp/proj' };
        const config = { runCheck: { expectPatterns: ['sum:\\s*7'] } };
        const result = await runCheck()(student, config, { adapter: fakeAdapter });
        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toMatch(/Expected output pattern not found/);
    });

    it('fails with the exit code when the program exits non-zero', async () => {
        vi.mocked(spawn).mockImplementation(() => makeFakeChild({ code: 1, stderr: 'segfault' }));
        const fakeAdapter = {
            detectProject: () => [{ dir: '/tmp/proj', runCommand: ['./a.out'], artifactPath: null }],
        };
        const student = { extractedDir: '/tmp/proj' };
        const result = await runCheck()(student, {}, { adapter: fakeAdapter });
        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toMatch(/Exited with code 1/);
    });

    it('builds first when the project has no runCommand but the adapter can build', async () => {
        vi.mocked(spawn).mockImplementation(() => makeFakeChild({ code: 0, stdout: 'ok\n' }));
        const build = vi.fn().mockResolvedValue({ success: true, errors: [], artifactPath: './built.out' });
        const fakeAdapter = {
            detectProject: () => [{ dir: '/tmp/proj', runCommand: null, artifactPath: null }],
            build,
        };
        const student = { extractedDir: '/tmp/proj' };
        const result = await runCheck()(student, {}, { adapter: fakeAdapter });
        expect(build).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(true);
    });

    it('fails cleanly when there is no project', async () => {
        const fakeAdapter = { detectProject: () => [] };
        const student = { extractedDir: '/tmp/nothing' };
        const result = await runCheck()(student, {}, { adapter: fakeAdapter });
        expect(result.success).toBe(false);
        expect(result.errors[0]).toMatch(/No runnable project found/);
    });
});
