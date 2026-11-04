/**
 * Write configs/local-config.json (it can hold Canvas and LLM API tokens) readable only
 * by the current user. The mode option only applies when the file is created, so chmod
 * afterwards to tighten a file that already exists. On Windows chmod only toggles the
 * read-only bit, so failures are ignored.
 */
import fs from 'fs';

export function writeLocalConfigFile(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}
