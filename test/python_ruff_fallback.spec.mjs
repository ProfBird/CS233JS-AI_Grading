/**
 * python_ruff_fallback.spec.mjs — lint runs `python -m ruff`, and when that gives nothing falls
 * back to a standalone `ruff` on PATH (how `uv tool install ruff` installs it).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join, delimiter } from 'path';
import { tmpdir } from 'os';
import pythonAdapter from '../src/adapters/python.js';

const posix = process.platform !== 'win32';
const oldPath = process.env.PATH;
let dir;
afterEach(() => { process.env.PATH = oldPath; if (dir) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!posix)('python lint — standalone ruff fallback', () => {
    it('uses a ruff on PATH when the interpreter has no ruff module', async () => {
        dir = mkdtempSync(join(tmpdir(), 'ruffbin-'));
        const fakePython = join(dir, 'fakepython');
        writeFileSync(fakePython, '#!/bin/sh\nexit 1\n');
        const fakeRuff = join(dir, 'ruff');
        writeFileSync(fakeRuff, `#!/bin/sh\necho '[{"code":"W291","name":"trailing-whitespace","message":"x","filename":"a.py","location":{"row":1,"column":1}}]'\nexit 1\n`);
        chmodSync(fakePython, 0o755); chmodSync(fakeRuff, 0o755);
        process.env.PATH = `${dir}${delimiter}${oldPath}`;
        const r = await pythonAdapter.lint([join(dir, 'a.py')], dir, null, { toolchains: { python: fakePython } });
        expect(r.toolError).toBeUndefined();
        expect(r.warnings).toBe(1);
    });

    it('reports a tool error when neither is available', async () => {
        dir = mkdtempSync(join(tmpdir(), 'ruffnone-'));
        process.env.PATH = dir;   // nothing runnable
        const r = await pythonAdapter.lint([join(dir, 'a.py')], dir, null, { toolchains: { python: join(dir, 'nope') } });
        expect(r.toolError).toMatch(/ruff/);
    });
});
