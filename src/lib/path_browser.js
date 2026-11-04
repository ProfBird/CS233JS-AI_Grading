/**
 * path_browser.js
 *
 * askPath(driver, opts) — lets the user find a folder or file by browsing instead of typing a
 * full path from memory (e.g. a Google Drive folder buried under ~/Library/CloudStorage).
 * Built only on the prompt driver's askOptions/ask (src/lib/prompt_driver.js), so it works the
 * same in the full-screen TUI (arrow keys) and the plain readline fallback (numbered list,
 * answer with a number or a name). "Type a path…" is always offered for people who'd rather
 * paste one.
 *
 * Each screen lists: the action for this folder ("Use this folder" when choosing a folder),
 * "Type a path…", "Up one level", quick jumps (Home, and on macOS /Volumes and the Google
 * Drive folder under ~/Library/CloudStorage; on Windows the drive letters), then the
 * folder's subfolders and — when choosing a file — its matching files. Hidden entries are
 * left out. "Cancel" returns '' so callers keep their existing "nothing entered" handling.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_ENTRIES = 300; // per folder — beyond this, type the rest of the path

// "~/x" -> home-relative, like a shell would (typed paths only).
function expandHome(p) {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
    return p;
}

// The nearest folder that exists, walking up from p (so a stale default still opens somewhere useful).
function nearestExistingDir(p) {
    let cur = path.resolve(p);
    for (;;) {
        try { if (fs.statSync(cur).isDirectory()) return cur; } catch (e) { /* keep walking up */ }
        const parent = path.dirname(cur);
        if (parent === cur) return os.homedir();
        cur = parent;
    }
}

// Quick jumps that exist on this machine.
function places(platform = process.platform) {
    const out = [{ label: 'Home', dir: os.homedir() }];
    if (platform === 'darwin') {
        out.push({ label: 'Drives (/Volumes)', dir: '/Volumes' });
        const cloud = path.join(os.homedir(), 'Library', 'CloudStorage');
        try {
            for (const name of fs.readdirSync(cloud)) {
                if (/^GoogleDrive/i.test(name)) out.push({ label: `Google Drive (${name.replace(/^GoogleDrive-?/i, '') || 'account'})`, dir: path.join(cloud, name) });
            }
        } catch (e) { /* no CloudStorage folder */ }
    } else if (platform === 'win32') {
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
            const root = `${letter}:\\`;
            try { if (fs.existsSync(root)) out.push({ label: `Drive ${letter}:`, dir: root }); } catch (e) { /* not mounted */ }
        }
    }
    return out.filter(p => { try { return fs.statSync(p.dir).isDirectory(); } catch (e) { return false; } });
}

// Subfolders and (for a file search) matching files, sorted case-insensitively, hidden left out.
function listFolder(dir, { kind, extensions }) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { dirs: [], files: [], error: e.message }; }
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const visible = entries.filter(e => !e.name.startsWith('.') && !e.name.startsWith('~$'));
    const isDir = e => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink()) return false;
        try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch (err) { return false; }
    };
    const dirs = visible.filter(isDir).sort(byName);
    const exts = (extensions || []).map(x => x.toLowerCase());
    const files = kind === 'file'
        ? visible.filter(e => !isDir(e) && (exts.length === 0 || exts.some(x => e.name.toLowerCase().endsWith(x)))).sort(byName)
        : [];
    return { dirs, files };
}

/**
 * @param {object} driver - prompt driver (askOptions, ask, print)
 * @param {object} opts
 * @param {string} opts.prompt - what's being chosen, e.g. "Lab root folder" (bare label)
 * @param {'dir'|'file'} [opts.kind='dir']
 * @param {string} [opts.start] - folder to open first (default: home)
 * @param {string[]} [opts.extensions] - for files: the extensions to list (e.g. ['.xlsx', '.xlsm'])
 * @param {string} [opts.baseDir] - a typed relative path is resolved against this (default: cwd)
 * @returns {Promise<string>} the chosen absolute path, or '' when cancelled / nothing typed
 */
async function askPath(driver, { prompt, kind = 'dir', start, extensions, baseDir } = {}) {
    let current = nearestExistingDir(start ? expandHome(start) : os.homedir());
    const what = kind === 'file' ? 'file' : 'folder';
    for (;;) {
        const { dirs, files, error } = listFolder(current, { kind, extensions });
        const opts = [];
        if (kind === 'dir') opts.push({ label: '[Use this folder]', value: { use: current }, desc: current });
        opts.push({ label: '[Type a path...]', value: { type: true }, desc: `Type or paste the ${what}'s full path` });
        const parent = path.dirname(current);
        if (parent !== current) opts.push({ label: '[Up one level]', value: { go: parent }, desc: parent });
        for (const p of places()) {
            if (p.dir !== current) opts.push({ label: `[${p.label}]`, value: { go: p.dir }, desc: p.dir });
        }
        const shownDirs = dirs.slice(0, MAX_ENTRIES);
        for (const d of shownDirs) {
            opts.push({ label: `${d.name}/`, value: { go: path.join(current, d.name) }, match: [d.name] });
        }
        for (const f of files.slice(0, Math.max(0, MAX_ENTRIES - shownDirs.length))) {
            opts.push({ label: f.name, value: { file: path.join(current, f.name) }, match: [f.name] });
        }
        opts.push({ label: '[Cancel]', value: { cancel: true }, desc: 'Go back without choosing' });

        if (error) driver.print(`  Can't open ${current}: ${error}`);
        if (dirs.length + files.length > MAX_ENTRIES) {
            driver.print(`  (${current} has more than ${MAX_ENTRIES} entries — only the first ${MAX_ENTRIES} are listed; use "Type a path..." for others)`);
        }
        if (kind === 'file' && files.length === 0 && !error) {
            driver.print(`  No ${(extensions || []).join('/') || ''} files in ${current} — open a folder to keep looking`);
        }

        const choice = await driver.askOptions(`${prompt} — ${current}`, opts, 0);
        if (!choice || choice.cancel) return '';
        if (choice.use) return choice.use;
        if (choice.file) return choice.file;
        if (choice.go) { current = choice.go; continue; }
        if (choice.type) {
            const typed = (await driver.ask(`${prompt} (full path)`, '')).trim();
            if (!typed) continue;
            const full = path.resolve(baseDir || process.cwd(), expandHome(typed));
            let st = null;
            try { st = fs.statSync(full); } catch (e) { /* doesn't exist */ }
            if (kind === 'dir' && st && st.isDirectory()) return full;
            if (kind === 'file' && st && st.isFile()) return full;
            if (kind === 'dir' && !st) {
                // A folder that doesn't exist yet (e.g. a new code storage folder) is the caller's
                // to create — but say so, in case it was a typo.
                driver.print(`  ${full} doesn't exist yet — it will be created when needed.`);
                return full;
            }
            driver.print(`  Not a ${what}: ${full}`);
            if (st && st.isDirectory()) current = full;   // typed a folder while looking for a file: open it
        }
    }
}

export { askPath, listFolder, places, nearestExistingDir, expandHome, MAX_ENTRIES };
