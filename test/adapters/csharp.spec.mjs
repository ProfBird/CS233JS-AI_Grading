/**
 * csharp.spec.mjs
 *
 * Adapter-level tests for src/adapters/csharp.js against the real installed .NET SDK:
 * verbatim/raw-string-aware comment stripping, .sln multi-project detection, MSBuild
 * plain-text diagnostics parsing (build/lint), and dotnet test console-summary parsing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import util from 'util';
const execFileAsync = util.promisify(execFile);

import csharpAdapter, { stripComments, detectProject, parseMsBuildOutput, parseDotnetTestSummary } from '../../src/adapters/csharp.js';
import { REQUIRED_ADAPTER_KEYS } from '../../src/adapters/base.js';
import { resolveAdapter } from '../../src/adapters/index.js';

let dotnetAvailable = false;
beforeAll(async () => {
    dotnetAvailable = (await csharpAdapter.preflight({})).available;
});

describe('csharp adapter — interface contract', () => {
    it('exposes all required adapter keys', () => {
        for (const key of REQUIRED_ADAPTER_KEYS) {
            expect(csharpAdapter).toHaveProperty(key);
        }
    });

    it('resolveAdapter({language: "csharp"}) returns it', () => {
        expect(resolveAdapter({ language: 'csharp' })).toBe(csharpAdapter);
    });

    it('has no manifest/package concept in this adapter', () => {
        expect(csharpAdapter.checkManifest).toBeNull();
        expect(csharpAdapter.install).toBeNull();
    });
});

describe('csharp adapter — stripComments', () => {
    it('strips // and /* */ comments', () => {
        expect(stripComments('int x = 1; // c\nint y = 2;')).toBe('int x = 1; \nint y = 2;');
    });

    it('does not end a verbatim string early on an escaped "" quote', () => {
        // A naive quote-matching regex ends the string at the first ", corrupting
        // everything after it — here, that would strip "trailing comment" as code.
        const code = 'var s = @"She said ""hi"" to me";\nint after = 1; // trailing comment';
        const result = stripComments(code);
        expect(result).toContain('She said ""hi"" to me');
        expect(result).not.toContain('trailing comment');
    });

    it('protects a raw string literal (C# 11+) containing quotes', () => {
        const code = '"""\nHas a " quote inside.\n"""\nint x = 1; // real comment';
        const result = stripComments(code);
        expect(result).toContain('Has a " quote inside.');
        expect(result).not.toContain('real comment');
    });
});

describe('csharp adapter — parseMsBuildOutput', () => {
    it('classifies errors and warnings from real dotnet build text output', () => {
        const output = [
            'C:\\proj\\Program.cs(5,9): warning CS0219: The variable \'x\' is assigned but its value is never used [C:\\proj\\app.csproj]',
            'C:\\proj\\Program.cs(10,5): error CS1002: ; expected [C:\\proj\\app.csproj]',
        ].join('\n');
        const result = parseMsBuildOutput(output);
        expect(result.errors).toBe(1);
        expect(result.warnings).toBe(1);
        expect(result.ruleCounts.CS0219).toBe(1);
        expect(result.ruleCounts.CS1002).toBe(1);
    });

    it('returns a zero shape for output with no diagnostics', () => {
        const result = parseMsBuildOutput('Build succeeded.\n0 Warning(s)\n0 Error(s)\n');
        expect(result.errors).toBe(0);
        expect(result.warnings).toBe(0);
    });
});

describe('csharp adapter — parseDotnetTestSummary', () => {
    it('parses a passing summary line', () => {
        const result = parseDotnetTestSummary('Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3, Duration: 12 ms');
        expect(result).toMatchObject({ total: 3, passed: 3, failures: [] });
    });

    it('parses a failing summary line with named failures', () => {
        const output = [
            '  Failed tests.UnitTest1.FailingTest [3 ms]',
            'Failed!  - Failed:     1, Passed:     1, Skipped:     0, Total:     2, Duration: 208 ms',
        ].join('\n');
        const result = parseDotnetTestSummary(output);
        expect(result.total).toBe(2);
        expect(result.passed).toBe(1);
        expect(result.failures).toEqual(['tests.UnitTest1.FailingTest']);
    });
});

describe('csharp adapter — detectProject() with a hand-written .slnx (no dotnet needed)', () => {
    it('parses .slnx XML project references directly', () => {
        const root = mkdtempSync(join(tmpdir(), 'slnx-manual-'));
        try {
            mkdirSync(join(root, 'App'), { recursive: true });
            mkdirSync(join(root, 'Lib'), { recursive: true });
            writeFileSync(join(root, 'App', 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
            writeFileSync(join(root, 'Lib', 'Lib.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
            writeFileSync(join(root, 'app.slnx'), '<Solution>\n  <Project Path="App/App.csproj" />\n  <Project Path="Lib/Lib.csproj" />\n</Solution>\n');

            const projects = detectProject(root);
            expect(projects.length).toBe(2);
            expect(projects.map(p => p.type)).toEqual(['csproj', 'csproj']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('csharp adapter — detectProject() with a real dotnet SDK', () => {
    it('detects a single loose .csproj with no .sln', async (ctx) => {
        if (!dotnetAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'csproj-loose-'));
        try {
            await execFileAsync('dotnet', ['new', 'console', '-o', root, '--force'], { timeout: 30000 });
            const projects = detectProject(root);
            expect(projects.length).toBe(1);
            expect(projects[0].type).toBe('csproj');
            expect(projects[0].runCommand).toEqual(['dotnet', 'run', '--project', projects[0].csprojPath]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 30000);

    it('detects multiple projects referenced by a .sln (class library + console app layout)', async (ctx) => {
        if (!dotnetAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'csproj-sln-'));
        try {
            mkdirSync(join(root, 'App'), { recursive: true });
            mkdirSync(join(root, 'Lib'), { recursive: true });
            await execFileAsync('dotnet', ['new', 'console', '-o', join(root, 'App'), '--force'], { timeout: 30000 });
            await execFileAsync('dotnet', ['new', 'classlib', '-o', join(root, 'Lib'), '--force'], { timeout: 30000 });
            await execFileAsync('dotnet', ['new', 'sln', '-o', root, '--force'], { timeout: 30000 });
            // `dotnet new sln` names the file after the output directory (not a fixed name)
            // and modern SDKs default to the .slnx format over classic .sln.
            const slnFile = readdirSync(root).find(f => /\.slnx?$/i.test(f));
            await execFileAsync('dotnet', ['sln', join(root, slnFile), 'add', join(root, 'App'), join(root, 'Lib')], { timeout: 30000 });

            const projects = detectProject(root);
            expect(projects.length).toBe(2);
            expect(projects.map(p => p.type)).toEqual(['csproj', 'csproj']);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    it('returns an empty array when there is no project at all', () => {
        const root = mkdtempSync(join(tmpdir(), 'csproj-empty-'));
        try {
            expect(detectProject(root)).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('csharp adapter — build()/lint() with a real dotnet SDK', () => {
    it('succeeds for a freshly scaffolded console app', async (ctx) => {
        if (!dotnetAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'csbuild-ok-'));
        try {
            await execFileAsync('dotnet', ['new', 'console', '-o', root, '--force'], { timeout: 30000 });
            const project = detectProject(root)[0];
            const result = await csharpAdapter.build(project, {});
            expect(result.success).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    it('reports a compile error for invalid C#', async (ctx) => {
        if (!dotnetAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'csbuild-fail-'));
        try {
            await execFileAsync('dotnet', ['new', 'console', '-o', root, '--force'], { timeout: 30000 });
            writeFileSync(join(root, 'Program.cs'), 'int x\nConsole.WriteLine(x);\n'); // missing semicolon
            const project = detectProject(root)[0];
            const result = await csharpAdapter.build(project, {});
            expect(result.success).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);

    it('lint() surfaces an unused-variable warning', async (ctx) => {
        if (!dotnetAvailable) return ctx.skip();
        const root = mkdtempSync(join(tmpdir(), 'cslint-'));
        try {
            await execFileAsync('dotnet', ['new', 'console', '-o', root, '--force'], { timeout: 30000 });
            writeFileSync(join(root, 'Program.cs'), 'int unused = 5;\nConsole.WriteLine("hi");\n');
            const result = await csharpAdapter.lint([join(root, 'Program.cs')], root, null, {});
            expect(result.warnings).toBeGreaterThan(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 60000);
});
