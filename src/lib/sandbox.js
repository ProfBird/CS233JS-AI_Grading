/**
 * sandbox.js
 *
 * The single chokepoint every current/future build/run_check/test_check strategy must
 * call to execute a student-produced artifact (a compiled binary, an interpreted script)
 * instead of spawning it directly. Centralizing this here means an isolation upgrade
 * only has to happen in one place, and — just as importantly — that no caller can
 * accidentally bypass it.
 *
 * Isolation tiers (config.execution.mode):
 *   "direct"          — spawn + timeout + kill-tree + a fresh throwaway cwd. This is NOT
 *                        a security sandbox: it protects against accidental damage (an
 *                        infinite loop, a fork bomb, a relative-path file write/delete
 *                        gone wrong) from bugs in trusted-classroom submissions. It does
 *                        NOT protect against a deliberately malicious program (e.g. one
 *                        that writes to an absolute path, opens a network socket, or
 *                        reads files outside its cwd). Use only where that's an
 *                        acceptable risk — a single-instructor tool grading known
 *                        students, not a service processing anonymous submissions.
 *   "restricted-user" — NOT IMPLEMENTED. Spawning as a distinct low-privilege Windows
 *                        user requires native credential/token APIs (CreateProcessWithLogonW)
 *                        this project doesn't depend on, and even then doesn't confine
 *                        filesystem access well without additional ACL work. Left as a
 *                        permanent loud-fail stub rather than removed, so a lab config
 *                        that requests it fails immediately instead of silently running
 *                        unsandboxed.
 *   "container"       — NOT IMPLEMENTED YET. The real second tier when genuine isolation
 *                        (filesystem + network + resource confinement) is needed — e.g. a
 *                        container runtime (Docker/Podman) invocation. Implement this if a
 *                        future course involves less-trusted submissions; until then it's
 *                        a documented path, not dead weight.
 *
 * IMPORTANT: never silently fall back to "direct" when a stronger mode is requested but
 * unavailable — that would turn a deliberate security choice into an unnoticed regression.
 * The grading machine's own filesystem permissions (not this module) are what actually
 * protect files outside the grading tree (e.g. a Google-Drive-synced gradebook) — run the
 * grader under an account that has no write access to anything it shouldn't touch.
 */

import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A runaway printer (accidental infinite loop, not malice) shouldn't be able to exhaust
// grader memory inside the timeout window. Past this cap, further output is dropped and
// `outputTruncated` is set — callers can still pattern-match against what was captured.
const MAX_OUTPUT_CHARS = 2_000_000;

// Kill a spawned process and its whole tree, cross-platform. On POSIX we signal the
// negative PID (the detached process group). Windows has no process groups, so use
// taskkill /T to walk and terminate the child tree — this is the same pattern already
// used for npm script execution (src/adapters/javascript.js's spawnScript), reused here
// rather than introducing a native Job Object dependency for an equivalent practical effect
// against the accidental (not adversarial) fork-bomb/runaway-child threat this covers.
function killProcessTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
    } else {
        try { process.kill(-pid, 'SIGKILL'); }
        catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
}

async function runDirect(argv, execConfig) {
    const { stdin = '', timeoutMs = 10000 } = execConfig;

    // Fresh, empty, throwaway working directory — any relative-path file writes/deletes
    // the student program makes land here, not in the actual submission/grading tree.
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grader-run-'));
    try {
        return await new Promise(resolve => {
            let child;
            try {
                child = spawn(argv[0], argv.slice(1), {
                    cwd: scratchDir,
                    stdio: 'pipe',
                    shell: false,
                    detached: process.platform !== 'win32', // POSIX process group for kill-tree
                });
            } catch (err) {
                resolve({ code: null, stdout: '', stderr: err.message, timedOut: false });
                return;
            }

            let stdout = '', stderr = '';
            let outputTruncated = false;
            const appendCapped = (buf, chunk) => {
                if (buf.length >= MAX_OUTPUT_CHARS) { outputTruncated = true; return buf; }
                return buf + chunk;
            };
            child.stdout.on('data', d => { stdout = appendCapped(stdout, d); });
            child.stderr.on('data', d => { stderr = appendCapped(stderr, d); });

            let resolved = false;
            const done = (code, timedOut) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                resolve({ code, stdout, stderr, timedOut, outputTruncated });
            };

            const timer = setTimeout(() => {
                killProcessTree(child.pid);
                done(null, true);
            }, timeoutMs);

            child.on('close', code => done(code, false));
            child.on('error', () => {
                killProcessTree(child.pid);
                done(null, false);
            });

            // A fast-crashing program (or one that never reads stdin) can close its stdin
            // pipe before write()/end() land, raising EPIPE — without this handler that's an
            // unhandled 'error' event on the stream, which crashes the grader process.
            if (typeof child.stdin.on === 'function') child.stdin.on('error', () => {});
            child.stdin.write(stdin);
            child.stdin.end();
        });
    } finally {
        try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (e) { /* best-effort cleanup */ }
    }
}

async function notImplemented(mode, alternative) {
    throw new Error(
        `execution.mode "${mode}" is not implemented. Use "direct" (trusted-classroom use ` +
        `only — see sandbox.js) ${alternative ? `or wait for "${alternative}"` : ''}. ` +
        `Refusing to silently fall back to "direct" for a lab that explicitly requested isolation.`
    );
}

const MODES = {
    direct: runDirect,
    'restricted-user': () => notImplemented('restricted-user', null),
    container: () => notImplemented('container', null),
};

/**
 * Execute a student-produced artifact under the configured isolation tier.
 * @param {string[]} argv — argv array (never a shell string — cross-platform quoting is
 *   exactly the kind of bug a shell string introduces on Windows).
 * @param {{mode?: string, stdin?: string, timeoutMs?: number}} execConfig
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
async function runStudentArtifact(argv, execConfig = {}) {
    const mode = execConfig.mode || 'direct';
    const runner = MODES[mode];
    if (!runner) {
        throw new Error(`Unknown execution.mode "${mode}". Valid: ${Object.keys(MODES).join(', ')}`);
    }
    return runner(argv, execConfig);
}

export { runStudentArtifact, killProcessTree };
