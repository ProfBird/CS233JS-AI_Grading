/**
 * sync_drivers.js
 *
 * Instructor check scripts ("drivers") live in the course-materials repo, where students get
 * them, and the grader keeps its own copy beside the lab config (so the config needs no path
 * into another repo). syncDrivers() copies — or, with check: true, only compares — every
 * `<source>/<Group>/drivers` folder into `<dest>/drivers/<Group>`.
 *
 * Used by bin/sync-drivers.js; nothing here knows where either folder lives.
 */
import fs from 'fs';
import path from 'path';

function listFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === '__pycache__') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFiles(full).map(f => path.join(e.name, f)));
        else out.push(e.name);
    }
    return out.sort();
}

/**
 * @param {string} sourceLabDir folder holding Group<X>/drivers (e.g. .../Lab01-Python)
 * @param {string} destLabConfigDir the lab's config folder (e.g. configs/CS212/Lab01)
 * @returns {{ groups: string[], differences: string[] }} differences = files that were
 *   missing or different before copying (with check: true, nothing is copied)
 */
function syncDrivers(sourceLabDir, destLabConfigDir, { check = false } = {}) {
    const groups = fs.readdirSync(sourceLabDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(sourceLabDir, e.name, 'drivers')))
        .map(e => e.name).sort();
    const differences = [];
    for (const group of groups) {
        const from = path.join(sourceLabDir, group, 'drivers');
        const to = path.join(destLabConfigDir, 'drivers', group);
        for (const file of listFiles(from)) {
            const src = fs.readFileSync(path.join(from, file));
            const dst = path.join(to, file);
            const same = fs.existsSync(dst) && src.equals(fs.readFileSync(dst));
            if (same) continue;
            differences.push(path.join(group, file));
            if (!check) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.writeFileSync(dst, src);
            }
        }
    }
    return { groups, differences };
}

export { syncDrivers };
