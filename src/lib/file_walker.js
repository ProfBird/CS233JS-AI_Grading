/**
 * file_walker.js
 *
 * Shared recursive directory traversal used by the analysis, lint, and
 * runtime-check phases. Replaces several near-identical hand-rolled walkers.
 *
 * walk(dir, opts) performs a pre-order depth-first traversal:
 *   - visit(dir, names)        called once per directory (incl. the root) with its entry names
 *   - onFile(full, name)       called for each non-directory, non-symlink entry that wasn't skipped
 *   - onDir(full, name)        called for each non-skipped, non-symlink directory entry found
 *                              during traversal, regardless of whether it is descended into.
 *                              Fires before the shouldDescend decision — use this to collect
 *                              directory names without needing to recurse into them.
 *   - shouldSkip(full, name)   if true, the entry is skipped entirely, before stat (default: never)
 *   - shouldDescend(full, name) if false, a subdirectory is not recursed into (default: always descend)
 *   - followSymlinks           include symlinked entries (default: false)
 *   - maxDepth                 deepest directory level to read; the root is depth 0
 *                              (default: Infinity). A directory at maxDepth is read
 *                              and visited, but its subdirectories are not.
 *
 * Unreadable directories are silently skipped, matching the prior walkers'
 * behavior of swallowing readdir/lstat errors.
 */
import fs from 'fs';
import path from 'path';

// Normalize a filesystem path to forward slashes. Use this at every point where a
// path is matched against a regex or substring (e.g. config patterns, exclusions),
// so patterns written with "/" behave identically on Windows (backslash paths),
// macOS, and Linux. Build paths with path.join; normalize only at the match site.
const toPosix = p => p.replace(/\\/g, '/');

function walk(dir, opts = {}) {
    const { visit, onFile, onDir, shouldSkip, shouldDescend, followSymlinks = false, maxDepth = Infinity } = opts;

    (function recurse(current, depth) {
        let names;
        try { names = fs.readdirSync(current); } catch (e) { return; }

        if (visit) visit(current, names);
        if (depth >= maxDepth) return;

        for (const name of names) {
            const full = path.join(current, name);
            if (shouldSkip && shouldSkip(full, name)) continue;

            let stats;
            try { stats = fs.lstatSync(full); } catch (e) { continue; }
            if (!followSymlinks && stats.isSymbolicLink()) continue;

            if (stats.isDirectory()) {
                if (onDir) onDir(full, name);
                if (!shouldDescend || shouldDescend(full, name)) {
                    recurse(full, depth + 1);
                }
            } else if (onFile) {
                onFile(full, name);
            }
        }
    })(dir, 0);
}

// Directories never worth scanning for student source: dependency installs,
// build output, VCS metadata, and macOS zip cruft. The validation phases run
// AFTER runtime_check's build (npm install + build), so these exist on disk and
// would otherwise flood the results with thousands of dependency/bundled errors.
const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '__MACOSX']);

// Collects files with the given extension(s) under dir. `ext` may be a single
// extension ('.html') or an array (['.htm', '.html']); matching is case-insensitive.
// Skips DEFAULT_SKIP_DIRS, dot-directories, and any path containing a substring
// from `exclusions` (case-insensitive) — mirroring lint_code's getAllJsFiles.
function getAllFilesByExt(dir, ext, exclusions = []) {
    const exts = (Array.isArray(ext) ? ext : [ext]).map(e => e.toLowerCase());
    const results = [];
    walk(dir, {
        shouldSkip: full => exclusions.some(ex => toPosix(full).toLowerCase().includes(toPosix(ex).toLowerCase())),
        shouldDescend: (full, name) => !name.startsWith('.') && !DEFAULT_SKIP_DIRS.has(name),
        onFile: (full, name) => {
            const lower = name.toLowerCase();
            if (exts.some(e => lower.endsWith(e))) results.push(full);
        }
    });
    return results;
}

export { walk, getAllFilesByExt, DEFAULT_SKIP_DIRS, toPosix };
