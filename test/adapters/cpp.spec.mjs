/**
 * cpp.spec.mjs
 *
 * Adapter-level tests for src/adapters/cpp.js against a real g++ (MinGW-w64 WinLibs,
 * installed for this refactor — not on PATH by default, so config.toolchains.cpp.compiler
 * is used throughout, exercising the exact scenario that config key exists for).
 * Covers: raw-string-aware comment stripping, detectProject's CMake > Makefile > loose
 * precedence, SARIF-diagnostics-based build/lint, and run_check via the sandbox chokepoint.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import cppAdapter, { stripComments, detectProject } from '../../src/adapters/cpp.js';
import { REQUIRED_ADAPTER_KEYS } from '../../src/adapters/base.js';
import { resolveAdapter } from '../../src/adapters/index.js';
import { runStudentArtifact } from '../../src/lib/sandbox.js';

// WinLibs (or any WinGet-installed MinGW toolchain) commonly installs outside PATH —
// exactly the scenario config.toolchains exists to solve. Discover it dynamically rather
// than hardcoding a path so this test isn't tied to one machine's username; fall back to
// plain "g++" (works if a compiler happens to be on PATH) and skip compiler-dependent
// tests gracefully if neither is available.
function findWinGetGpp() {
    const pkgRoot = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
    try {
        const pkgDir = readdirSync(pkgRoot).find(d => /WinLibs/i.test(d));
        if (!pkgDir) return null;
        const binDir = join(pkgRoot, pkgDir, 'mingw64', 'bin');
        return existsSync(join(binDir, 'g++.exe')) ? join(binDir, 'g++.exe') : null;
    } catch (e) {
        return null;
    }
}

const GPP_PATH = (process.platform === 'win32' ? findWinGetGpp() : null) || 'g++';
const CPP_CONFIG = { toolchains: { cpp: { compiler: GPP_PATH } } };
let compilerAvailable = false;

beforeAll(async () => {
    compilerAvailable = (await cppAdapter.preflight(CPP_CONFIG)).available;
});

describe('cpp adapter — interface contract', () => {
    it('exposes all required adapter keys', () => {
        for (const key of REQUIRED_ADAPTER_KEYS) {
            expect(cppAdapter).toHaveProperty(key);
        }
    });

    it('resolveAdapter({language: "cpp"}) returns it', () => {
        expect(resolveAdapter({ language: 'cpp' })).toBe(cppAdapter);
    });

    it('has no manifest/package concept', () => {
        expect(cppAdapter.checkManifest).toBeNull();
        expect(cppAdapter.extractUsedPackages).toBeNull();
        expect(cppAdapter.install).toBeNull();
    });

    it('scans headers alongside source files but keeps them out of compilation', () => {
        expect(cppAdapter.sourceExtensions).toEqual(expect.arrayContaining(['.cpp', '.h', '.hpp']));
    });
});

describe('cpp adapter — stripComments (raw-string-aware)', () => {
    it('strips // and /* */ comments, preserving string contents', () => {
        expect(stripComments('int x = 1; // comment\nint y = 2;')).toBe('int x = 1; \nint y = 2;');
        expect(stripComments('/* block */ int x = 1;')).toBe(' int x = 1;');
    });

    it('does not corrupt a raw string literal containing quotes and parens', () => {
        // A naive quote-matching regex would misparse this: the raw string's content
        // includes an unescaped double-quote and parens that aren't string delimiters.
        const code = 'auto s = R"(He said "hi" (loudly))";\nint after = 1; // trailing comment';
        const result = stripComments(code);
        expect(result).toContain('He said "hi" (loudly)');
        expect(result).not.toContain('trailing comment');
    });

    it('does not treat // inside a raw string as a comment', () => {
        const code = 'auto s = R"(http://example.com)";';
        expect(stripComments(code)).toContain('http://example.com');
    });
});

describe('cpp adapter — detectProject() precedence', () => {
    it('prefers CMakeLists.txt over loose files', () => {
        const root = mkdtempSync(join(tmpdir(), 'cppproj-cmake-'));
        try {
            writeFileSync(join(root, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\n');
            writeFileSync(join(root, 'main.cpp'), 'int main() { return 0; }\n');
            const projects = detectProject(root);
            expect(projects[0].type).toBe('cmake');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('prefers a Makefile over loose files when no CMakeLists.txt exists', () => {
        const root = mkdtempSync(join(tmpdir(), 'cppproj-make-'));
        try {
            writeFileSync(join(root, 'Makefile'), 'all:\n\tg++ main.cpp -o main\n');
            writeFileSync(join(root, 'main.cpp'), 'int main() { return 0; }\n');
            const projects = detectProject(root);
            expect(projects[0].type).toBe('makefile');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('falls back to loose .cpp files with no build system, runCommand null until built', () => {
        const root = mkdtempSync(join(tmpdir(), 'cppproj-loose-'));
        try {
            writeFileSync(join(root, 'main.cpp'), 'int main() { return 0; }\n');
            const projects = detectProject(root);
            expect(projects[0].type).toBe('loose');
            expect(projects[0].runCommand).toBeNull();
            expect(projects[0].artifactPath).toBeTruthy();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not independently list header files as translation units', () => {
        const root = mkdtempSync(join(tmpdir(), 'cppproj-headers-'));
        try {
            writeFileSync(join(root, 'main.cpp'), '#include "util.h"\nint main() { return 0; }\n');
            writeFileSync(join(root, 'util.h'), 'int helper();\n');
            const projects = detectProject(root);
            expect(projects[0].sourceFiles.length).toBe(1);
            expect(projects[0].sourceFiles[0]).toMatch(/main\.cpp$/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('cpp adapter — build() with real g++', () => {
    it('compiles a correct program successfully and produces the artifact', async (ctx) => {
        if (!compilerAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'cppbuild-ok-'));
        try {
            writeFileSync(join(root, 'main.cpp'), '#include <iostream>\nint main() { std::cout << "hi\\n"; return 0; }\n');
            const project = detectProject(root)[0];
            const result = await cppAdapter.build(project, CPP_CONFIG);
            expect(result.success).toBe(true);
            expect(existsSync(project.artifactPath)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20000);

    it('reports compiler diagnostics for a syntax error', async (ctx) => {
        if (!compilerAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'cppbuild-fail-'));
        try {
            writeFileSync(join(root, 'main.cpp'), 'int main() {\n    int x\n    return 0;\n}\n'); // missing semicolon
            const project = detectProject(root)[0];
            const result = await cppAdapter.build(project, CPP_CONFIG);
            expect(result.success).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20000);

    it('succeeds (does not fail the build) when only warnings, no errors, are present', async (ctx) => {
        // build()'s contract is {success, errors: string[], artifacts} — a -Wall warning
        // doesn't fail compilation. The warning *count* is exposed via lint(), tested below,
        // not build(); the two intentionally don't share the "errors" field (Diagnostics.errors
        // is a count, the build-result's errors is a string[] — conflating them was a bug).
        if (!compilerAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'cppbuild-warn-'));
        try {
            writeFileSync(join(root, 'main.cpp'), '#include <iostream>\nint main() {\n    int unused = 5;\n    std::cout << "hi\\n";\n    return 0;\n}\n');
            const project = detectProject(root)[0];
            const result = await cppAdapter.build(project, CPP_CONFIG);
            expect(result.success).toBe(true);
            expect(existsSync(project.artifactPath)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20000);
});

describe('cpp adapter — lint() (compiler warnings as diagnostics)', () => {
    it('reports the same warnings build() would, via the lint mapping path', async (ctx) => {
        if (!compilerAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'cpplint-'));
        try {
            const file = join(root, 'main.cpp');
            writeFileSync(file, '#include <iostream>\nint main() {\n    int unused = 5;\n    std::cout << "hi\\n";\n    return 0;\n}\n');
            const result = await cppAdapter.lint([file], root, null, CPP_CONFIG);
            expect(result.warnings).toBeGreaterThan(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20000);
});

describe('cpp adapter — end-to-end via run_check\'s sandbox execution', () => {
    it('builds then runs the compiled artifact and captures its stdout', async (ctx) => {
        if (!compilerAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'cpprun-'));
        try {
            writeFileSync(join(root, 'main.cpp'), '#include <iostream>\nint main() { std::cout << "sum: 7" << std::endl; return 0; }\n');
            const project = detectProject(root)[0];
            const buildResult = await cppAdapter.build(project, CPP_CONFIG);
            expect(buildResult.success).toBe(true);

            const runResult = await runStudentArtifact([project.artifactPath]);
            expect(runResult.code).toBe(0);
            expect(runResult.stdout).toContain('sum: 7');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20000);
});

describe('cpp adapter — preflight()', () => {
    it('reports available when the configured compiler resolves', async (ctx) => {
        if (!compilerAvailable) return ctx.skip();
        const result = await cppAdapter.preflight(CPP_CONFIG);
        expect(result.available).toBe(true);
    });

    it('reports unavailable with an actionable hint for a bogus compiler path', async () => {
        const result = await cppAdapter.preflight({ toolchains: { cpp: { compiler: 'no-such-compiler-xyz' } } });
        expect(result.available).toBe(false);
        expect(result.hint).toMatch(/toolchains\.cpp\.compiler/);
    });
});
