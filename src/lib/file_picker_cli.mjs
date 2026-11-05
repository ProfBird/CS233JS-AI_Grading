/**
 * file_picker_cli.mjs — runs the arrow-key file/folder picker (inquirer-file-selector, the
 * same one GradingAssistant's Menu.mjs uses) as a child process and writes the answer to a
 * JSON file. It is a separate process because the full-screen neo-blessed TUI owns the
 * terminal: TUI.pickPath (tui.js) hands the terminal to this process through blessed's
 * screen.spawn, then reads the result back.
 *
 *   node file_picker_cli.mjs --out <file> --type file|directory --start <dir>
 *        --message <text> [--ext .xlsx,.xlsm]
 *
 * Result file: {"path": "..."} or {"cancelled": true}. Esc cancels; Ctrl-C cancels too.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileSelector } from 'inquirer-file-selector';

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = arg('out');
const type = arg('type') === 'file' ? 'file' : 'directory';
const exts = (arg('ext') || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
let basePath = arg('start') || os.homedir();
try { if (!fs.statSync(basePath).isDirectory()) basePath = path.dirname(basePath); } catch { basePath = os.homedir(); }

let result = { cancelled: true };
try {
    const item = await fileSelector({
        message: arg('message') || (type === 'file' ? 'Choose a file' : 'Choose a folder'),
        basePath,
        type,
        filter: exts.length ? (item) => item.isDirectory || exts.some(e => item.name.toLowerCase().endsWith(e)) : undefined,
        allowCancel: true,
    });
    if (item) result = { path: item.path };
} catch {
    // Ctrl-C (ExitPromptError) or any picker failure: treat as cancelled
}
if (out) fs.writeFileSync(out, JSON.stringify(result));
