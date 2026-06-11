/**
 * walkers.spec.mjs
 *
 * Regression tests for the shared directory-traversal primitive walk()
 * (file_walker.js) and the per-phase walkers built on top of it in
 * analyze_code.js, lint_code.js, and runtime_check.js.
 *
 * These began as characterization tests that pinned each walker's behavior
 * before the six hand-rolled implementations were collapsed onto walk(); they
 * now guard that behavior against regressions. They are intentionally exact,
 * including the wrappers' quirks and inconsistencies.
 *
 * Documented quirks captured below:
 *   - getAllFiles:        exclusions are SUBSTRING matches on the full path; does
 *                         NOT skip dot-dirs/dot-files; skips symlinks; returns all
 *                         file types.
 *   - getSubdirs:         returns NAMES of immediate child dirs; skips dot-dirs and
 *                         symlinks.
 *   - getAllJsFiles:      exclusions are CASE-INSENSITIVE substring matches; skips
 *                         dot-dirs and "__MACOSX"; still collects dot-files ending
 *                         in .js; returns only .js; skips symlinks.
 *   - findAllIndexHtmlDirs: skips node_modules (substring)/dist/dot-dirs, but NOT
 *                         "__MACOSX"; returns dirs directly containing index.html.
 *   - findDistIndexHtmlDirs: descends into dist/ dirs and returns those containing
 *                         index.html; skips node_modules (substring) and dot-dirs.
 *   - findPackageJsonDirs: skips node_modules (substring), dot-dirs, and "dist"
 *                         (exact name); returns dirs containing package.json.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join, relative, sep } from 'path';
import { tmpdir } from 'os';

import { getAllFiles, getSubdirs, checkRepoHygiene } from '../src/pipeline/analyze_code.js';
import { getAllJsFiles } from '../src/pipeline/lint_code.js';
import { findAllIndexHtmlDirs, findDistIndexHtmlDirs, findPackageJsonDirs } from '../src/pipeline/runtime_check.js';
import { walk, toPosix } from '../src/lib/file_walker.js';

let root;
let symlinksCreated = false;

/** Write a file, creating parent directories as needed. */
function file(relPath, contents = '') {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents);
}

/** Convert absolute result paths to forward-slash relative paths ('' -> '.'), sorted. */
function rel(absPaths) {
    return absPaths
        .map(p => {
            const r = relative(root, p).split(sep).join('/');
            return r === '' ? '.' : r;
        })
        .sort();
}

const sorted = arr => [...arr].sort();

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'walkers-'));

    // Top-level files
    file('index.html');
    file('app.js');
    file('.eslintrc.js');           // dot-FILE ending in .js
    file('README.md');
    file('package.json', '{}');

    // Dot-DIR with content
    file('.hidden/secret.js');
    file('.hidden/index.html');

    // node_modules with a nested package
    file('node_modules/dep/dep.js');
    file('node_modules/dep/index.html');
    file('node_modules/dep/package.json', '{}');

    // dist with built output
    file('dist/index.html');
    file('dist/bundle.js');

    // Regular source tree
    file('src/main.js');
    file('src/util.js');
    file('src/index.html');
    file('src/components/Btn.js');

    // macOS zip artifact dir
    file('__MACOSX/junk.js');

    // Nested dir with its own package.json
    file('sub/package.json', '{}');
    file('sub/nested/deep.js');

    // Symlinks (skipped by every walker). Guarded for platforms that disallow them.
    try {
        symlinkSync(join(root, 'src'), join(root, 'link-to-src'), 'dir');
        symlinkSync(join(root, 'app.js'), join(root, 'link-to-app.js'), 'file');
        symlinksCreated = true;
    } catch {
        symlinksCreated = false;
    }
});

afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
});

// ── getAllFiles (analyze_code.js) ──────────────────────────────────────────

describe('getAllFiles', () => {
    it('with no exclusions: collects every file (incl. dot-dirs, node_modules, dist)', () => {
        expect(rel(getAllFiles(root))).toEqual(sorted([
            '.eslintrc.js',
            '.hidden/index.html',
            '.hidden/secret.js',
            'README.md',
            '__MACOSX/junk.js',
            'app.js',
            'dist/bundle.js',
            'dist/index.html',
            'index.html',
            'node_modules/dep/dep.js',
            'node_modules/dep/index.html',
            'node_modules/dep/package.json',
            'package.json',
            'src/components/Btn.js',
            'src/index.html',
            'src/main.js',
            'src/util.js',
            'sub/nested/deep.js',
            'sub/package.json',
        ]));
    });

    it('with exclusions: drops paths containing any excluded substring (but keeps dot-dirs and __MACOSX)', () => {
        expect(rel(getAllFiles(root, ['node_modules', 'dist', '.git']))).toEqual(sorted([
            '.eslintrc.js',
            '.hidden/index.html',
            '.hidden/secret.js',
            'README.md',
            '__MACOSX/junk.js',
            'app.js',
            'index.html',
            'package.json',
            'src/components/Btn.js',
            'src/index.html',
            'src/main.js',
            'src/util.js',
            'sub/nested/deep.js',
            'sub/package.json',
        ]));
    });

    it('does not follow symlinks', () => {
        if (!symlinksCreated) return;
        const results = rel(getAllFiles(root, []));
        expect(results.some(p => p.startsWith('link-to-src'))).toBe(false);
        expect(results).not.toContain('link-to-app.js');
    });
});

// ── getSubdirs (analyze_code.js) ───────────────────────────────────────────

describe('getSubdirs', () => {
    it('returns names of immediate child dirs, skipping dot-dirs and symlinks', () => {
        expect(sorted(getSubdirs(root))).toEqual(sorted([
            '__MACOSX',
            'dist',
            'node_modules',
            'src',
            'sub',
        ]));
    });

    it('returns [] for a non-existent directory', () => {
        expect(getSubdirs(join(root, 'does-not-exist'))).toEqual([]);
    });
});

// ── getAllJsFiles (lint_code.js) ───────────────────────────────────────────

describe('getAllJsFiles', () => {
    it('with no exclusions: collects .js files, skipping dot-dirs, node_modules, dist, and __MACOSX (but keeping dot-files)', () => {
        // node_modules/dist/build are hard-skipped by the shared collector — the
        // validation phases run after the build, so they must never be scanned.
        expect(rel(getAllJsFiles(root))).toEqual(sorted([
            '.eslintrc.js',
            'app.js',
            'src/components/Btn.js',
            'src/main.js',
            'src/util.js',
            'sub/nested/deep.js',
        ]));
    });

    it('with exclusions: case-insensitive substring match drops node_modules and dist', () => {
        expect(rel(getAllJsFiles(root, ['NODE_MODULES', 'Dist']))).toEqual(sorted([
            '.eslintrc.js',
            'app.js',
            'src/components/Btn.js',
            'src/main.js',
            'src/util.js',
            'sub/nested/deep.js',
        ]));
    });

    it('does not follow symlinks', () => {
        if (!symlinksCreated) return;
        const results = rel(getAllJsFiles(root));
        expect(results.some(p => p.startsWith('link-to-src'))).toBe(false);
        expect(results).not.toContain('link-to-app.js');
    });
});

// ── findAllIndexHtmlDirs (runtime_check.js) ────────────────────────────────

describe('findAllIndexHtmlDirs', () => {
    it('returns dirs with index.html, skipping node_modules/dist/dot-dirs (but searching __MACOSX)', () => {
        expect(rel(findAllIndexHtmlDirs(root))).toEqual(sorted(['.', 'src']));
    });
});

// ── findDistIndexHtmlDirs (runtime_check.js) ───────────────────────────────

describe('findDistIndexHtmlDirs', () => {
    it('returns dist/ dirs that contain index.html', () => {
        expect(rel(findDistIndexHtmlDirs(root))).toEqual(['dist']);
    });
});

// ── findPackageJsonDirs (runtime_check.js) ─────────────────────────────────

describe('findPackageJsonDirs', () => {
    it('returns dirs with package.json, skipping node_modules/dist/dot-dirs', () => {
        expect(rel(findPackageJsonDirs(root))).toEqual(sorted(['.', 'sub']));
    });
});

// ── checkRepoHygiene filesystem fallback (analyze_code.js) ──────────────────
// The non-git path uses an internal recursive walker with a depth-4 cap. These
// pin that behavior: excluded entry NAMES are reported, excluded dirs are not
// descended into, and the scan stops past depth 4.

describe('checkRepoHygiene (filesystem fallback)', () => {
    let hroot;

    beforeAll(() => {
        hroot = mkdtempSync(join(tmpdir(), 'hygiene-'));
        const f = (rp, c = '') => {
            const abs = join(hroot, rp);
            mkdirSync(join(abs, '..'), { recursive: true });
            writeFileSync(abs, c);
        };
        f('src/app.js');                        // clean source
        f('node_modules/junk.js');              // depth-1 excluded dir
        f('.vscode/settings.json');             // depth-1 excluded dir
        f('a/b/c/d/deep5/marker.txt');          // 'deep5' is an entry of the depth-4 dir 'd' -> seen
        f('a/b/c/d/e/deep6/marker.txt');        // 'e' is a depth-5 dir -> never read, so 'deep6' is NOT seen
    });

    afterAll(() => {
        if (hroot) rmSync(hroot, { recursive: true, force: true });
    });

    const hygiene = { excludedFromRepo: ['node_modules', '.vscode', 'deep5', 'deep6'] };

    it('returns null when hygiene config is missing or malformed', () => {
        expect(checkRepoHygiene(hroot, null)).toBe(null);
        expect(checkRepoHygiene(hroot, { excludedFromRepo: 'nope' })).toBe(null);
    });

    it('reports excluded entry names found within the depth-4 limit, but not beyond', () => {
        const result = checkRepoHygiene(hroot, hygiene);
        // 'deep6' lives under a depth-5 directory that is never read, so it is excluded.
        expect(sorted(result.foundDirs)).toEqual(sorted(['node_modules', '.vscode', 'deep5']));
        expect(result.passed).toBe(false);
    });

    it('passes when no excluded entries are present', () => {
        const result = checkRepoHygiene(hroot, { excludedFromRepo: ['coverage', 'build'] });
        expect(result).toEqual({ passed: true, foundDirs: [] });
    });
});

// ── walk (shared primitive, file_walker.js) ────────────────────────────────
// Direct tests for the traversal primitive itself, covering option semantics
// that the six wrappers don't all exercise (notably followSymlinks and maxDepth
// in isolation).

describe('walk', () => {
    let wroot;
    let symlinked = false;

    // Convert absolute paths to sorted forward-slash paths relative to `base` ('' -> '.').
    const relTo = (base, paths) => paths
        .map(p => {
            const r = relative(base, p).split(sep).join('/');
            return r === '' ? '.' : r;
        })
        .sort();

    beforeAll(() => {
        wroot = mkdtempSync(join(tmpdir(), 'walk-'));
        const f = (rp, c = '') => {
            const abs = join(wroot, rp);
            mkdirSync(join(abs, '..'), { recursive: true });
            writeFileSync(abs, c);
        };
        f('a.txt');
        f('sub/b.txt');
        f('sub/deep/c.txt');
        try {
            symlinkSync(join(wroot, 'sub'), join(wroot, 'link-dir'), 'dir');
            symlinkSync(join(wroot, 'a.txt'), join(wroot, 'link-file'), 'file');
            symlinked = true;
        } catch {
            symlinked = false;
        }
    });

    afterAll(() => {
        if (wroot) rmSync(wroot, { recursive: true, force: true });
    });

    it('calls visit once per directory (incl. the root), skipping symlinked dirs by default', () => {
        const dirs = [];
        walk(wroot, { visit: d => dirs.push(d) });
        expect(relTo(wroot, dirs)).toEqual(sorted(['.', 'sub', 'sub/deep']));
    });

    it('passes the directory entry names to visit', () => {
        const namesByDir = {};
        walk(wroot, { visit: (d, names) => { namesByDir[relTo(wroot, [d])[0]] = sorted(names); } });
        expect(namesByDir['sub']).toEqual(sorted(['b.txt', 'deep']));
    });

    it('calls onFile for each non-directory, non-symlink entry', () => {
        const files = [];
        walk(wroot, { onFile: f => files.push(f) });
        expect(relTo(wroot, files)).toEqual(sorted(['a.txt', 'sub/b.txt', 'sub/deep/c.txt']));
    });

    it('shouldSkip drops an entry (and its subtree) before stat', () => {
        const files = [];
        walk(wroot, { onFile: f => files.push(f), shouldSkip: (full, name) => name === 'sub' });
        expect(relTo(wroot, files)).toEqual(['a.txt']);
    });

    it('shouldDescend prevents recursing into (and visiting) a directory', () => {
        const dirs = [];
        walk(wroot, { visit: d => dirs.push(d), shouldDescend: (full, name) => name !== 'sub' });
        expect(relTo(wroot, dirs)).toEqual(['.']);
    });

    it('maxDepth: 0 reads only the root', () => {
        const dirs = [];
        walk(wroot, { visit: d => dirs.push(d), maxDepth: 0 });
        expect(relTo(wroot, dirs)).toEqual(['.']);
    });

    it('maxDepth: 1 reads the root and its immediate subdirectories only', () => {
        const dirs = [];
        walk(wroot, { visit: d => dirs.push(d), maxDepth: 1 });
        expect(relTo(wroot, dirs)).toEqual(sorted(['.', 'sub']));
    });

    it('onDir fires for every non-skipped directory entry, before shouldDescend is consulted', () => {
        const dirs = [];
        walk(wroot, {
            onDir: (full, name) => dirs.push(name),
            shouldDescend: () => false    // nothing is recursed into
        });
        // Only immediate child dirs of wroot (sub); link-dir is a symlink so excluded
        expect(sorted(dirs)).toEqual(['sub']);
    });

    it('onDir fires at every depth during normal traversal', () => {
        const dirs = [];
        walk(wroot, { onDir: (full, name) => dirs.push(name) });
        // 'sub' found from root, 'deep' found from inside sub
        expect(sorted(dirs)).toEqual(sorted(['sub', 'deep']));
    });

    it('onDir fires for a dir even when shouldDescend returns false for it', () => {
        const dirs = [];
        walk(wroot, {
            onDir: (full, name) => dirs.push(name),
            shouldDescend: (full, name) => name !== 'sub'
        });
        expect(dirs).toContain('sub');    // onDir fired
        expect(dirs).not.toContain('deep'); // but sub was not descended into
    });

    it('onDir does not fire for the root directory itself, only for children', () => {
        const dirs = [];
        walk(wroot, { onDir: full => dirs.push(full) });
        expect(dirs).not.toContain(wroot);
    });

    it('followSymlinks: true surfaces symlinks to onFile but does NOT traverse symlinked dirs (lstat-based)', () => {
        if (!symlinked) return;
        const files = [];
        walk(wroot, { onFile: f => files.push(f), followSymlinks: true });
        // link-dir and link-file both appear as entries (lstat reports them as
        // non-directories), but link-dir is not descended into.
        expect(relTo(wroot, files)).toEqual(sorted([
            'a.txt', 'sub/b.txt', 'sub/deep/c.txt', 'link-dir', 'link-file',
        ]));
    });

    it('silently skips an unreadable / non-existent directory', () => {
        let visitCount = 0;
        expect(() => walk(join(wroot, 'does-not-exist'), { visit: () => { visitCount++; } })).not.toThrow();
        expect(visitCount).toBe(0);
    });
});

// ── toPosix (shared path normalizer, file_walker.js) ───────────────────────
// Pins the cross-platform contract: any path-vs-pattern match site routes the
// path through toPosix first, so "/"-based patterns behave identically on a
// Windows backslash path. Uses literal backslash strings (not path.join) so the
// Windows behavior is exercised even when the suite runs on Linux/macOS.

describe('toPosix', () => {
    it('converts backslashes to forward slashes', () => {
        expect(toPosix('a\\b\\c.js')).toBe('a/b/c.js');
        expect(toPosix('C:\\Users\\pc\\functions\\proxy.js')).toBe('C:/Users/pc/functions/proxy.js');
    });

    it('leaves already-posix paths unchanged', () => {
        expect(toPosix('a/b/c.js')).toBe('a/b/c.js');
    });

    it('lets a "/"-based pattern match a Windows-style path after normalization', () => {
        const winPath = 'repo\\functions\\proxy.js';
        expect(/functions\//.test(winPath)).toBe(false);          // raw: no match
        expect(/functions\//.test(toPosix(winPath))).toBe(true);  // normalized: matches
    });
});
