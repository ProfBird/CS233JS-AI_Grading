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

import { runStudentArtifact } from '../src/lib/sandbox.js';

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
