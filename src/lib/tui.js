'use strict';
// Terminal UI primitives for configure_lab.js.
// Wraps neo-blessed: provides a scrollable log pane, prompt-bar text input,
// popup option lists with arrow-key navigation, and a full-screen review table.

import blessed from 'neo-blessed';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

class TUI {
    constructor(title = 'Configure Lab') {
        this.screen = blessed.screen({
            smartCSR: true,
            title,
            keys: true,
            mouse: false,
            fullUnicode: true,
        });

        // Header strip
        this._header = blessed.box({
            parent: this.screen,
            top: 0, left: 0, width: '100%', height: 1,
            content: ` === ${title} ===`,
            style: { bg: 'blue', fg: 'white', bold: true },
        });

        // Scrollable log — shrinks when input bar is visible
        this._log = blessed.log({
            parent: this.screen,
            top: 1, left: 0, width: '100%', height: '100%-2',
            scrollable: true, alwaysScroll: true, tags: false,
            scrollbar: { ch: '│', style: { fg: 'cyan' } },
        });

        // Status / help bar
        this._status = blessed.box({
            parent: this.screen,
            bottom: 0, left: 0, width: '100%', height: 1,
            content: ' ^C: exit ',
            style: { bg: 'blue', fg: 'white' },
        });

        this.screen.key(['C-c'], () => this.exit(130));

        // Redirect console output so callers using console.log don't corrupt the alt-buffer.
        // process.stdout.write is intentionally NOT overridden — blessed uses it internally
        // for rendering; overriding it would cause infinite recursion via print→render→write→print.
        this._origLog   = console.log.bind(console);
        this._origError = console.error.bind(console);
        console.log   = (...a) => this.print(a.map(x => String(x ?? '')).join(' '));
        console.error = (...a) => this.print('! ' + a.map(x => String(x ?? '')).join(' '));

        this.screen.render();
    }

    destroy() {
        // Restore original console before killing the screen
        console.log   = this._origLog;
        console.error = this._origError;
        try { this.screen.destroy(); } catch (_) {}
    }

    exit(code = 0) { this.destroy(); process.exit(code); }

    /**
     * File/folder picker (inquirer-file-selector — arrow keys, → opens a folder, ← goes up,
     * Esc cancels). It needs the whole terminal, so blessed hands the screen to a child
     * process (screen.spawn) and takes it back afterwards. Resolves to the chosen absolute
     * path, or '' when cancelled or the picker could not run.
     * @param {{ kind?: 'file'|'dir', start?: string, extensions?: string[], message?: string }} opts
     */
    pickPath({ kind = 'file', start, extensions, message } = {}) {
        return new Promise(resolve => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pick-'));
            const outFile = path.join(dir, 'result.json');
            const args = [
                fileURLToPath(new URL('./file_picker_cli.mjs', import.meta.url)),
                '--out', outFile,
                '--type', kind === 'dir' ? 'directory' : 'file',
                '--message', `${message || (kind === 'dir' ? 'Choose a folder' : 'Choose a file')} (Enter: choose, →: open folder, ←: up, Esc: cancel)`,
            ];
            if (start) args.push('--start', start);
            if (extensions?.length) args.push('--ext', extensions.join(','));
            const done = () => {
                let result = '';
                try { result = JSON.parse(fs.readFileSync(outFile, 'utf8')).path || ''; } catch { /* cancelled / failed */ }
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
                try { this.screen.realloc(); } catch { /* older blessed */ }   // full repaint over the picker's output
                this.screen.render();
                resolve(result);
            };
            try {
                const child = this.screen.spawn(process.execPath, args, { stdio: 'inherit' });
                child.on('exit', done);
                child.on('error', done);
            } catch { done(); }
        });
    }

    print(line = '') {
        this._log.log(String(line ?? ''));
        this.screen.render();
    }

    setStatus(text) {
        this._status.setContent(` ${text}`);
        this.screen.render();
    }

    setTitle(text) {
        this.screen.title = text;
        this._header.setContent(` === ${text} ===`);
        this.screen.render();
    }

    // ── Text input ────────────────────────────────────────────────────────
    // Shows a prompt bar above an input line at the bottom of the screen.
    // Returns the trimmed string value; falls back to `def` on empty submit.

    ask(prompt, def = '') {
        return new Promise(resolve => {
            const defStr  = def != null ? String(def) : '';
            const label   = defStr ? `${prompt} [${defStr}]` : `${prompt} [blank]`;

            // Shrink log to expose 3 rows at bottom (prompt, input, status)
            this._log.height = '100%-4';
            this.setStatus('Enter: confirm  Esc: use default  ^C: exit');

            const pbar = blessed.box({
                parent: this.screen, bottom: 2, left: 0,
                width: '100%', height: 1,
                content: ` ${label}: `,
                style: { bg: 'black', fg: 'yellow' },
            });
            const inp = blessed.textbox({
                parent: this.screen, bottom: 1, left: 1,
                width: '100%-2', height: 1,
                inputOnFocus: true,
                style: { bg: 'black', fg: 'white', focus: { bg: '#111111', fg: 'white' } },
            });

            const done = val => {
                const result = (val != null ? String(val) : '').trim() || defStr;
                pbar.detach();
                inp.detach();
                this._log.height = '100%-2';
                this.setStatus('^C: exit');
                this.print(`  ${label}: ${result}`);
                this.screen.render();
                resolve(result);
            };

            inp.once('submit', v => done(v));
            inp.once('cancel', () => done(''));
            inp.key(['C-c'], () => this.exit(130));
            inp.focus();
            this.screen.render();
        });
    }

    async askBoolean(question, def = true) {
        const hint = def ? '[Y/n]' : '[y/N]';
        while (true) {
            const raw = (await this.ask(`${question} ${hint}`, '')).toLowerCase();
            if (!raw)                         return def;
            if (raw === 'y' || raw === 'yes') return true;
            if (raw === 'n' || raw === 'no')  return false;
            this.print('  Please enter y or n.');
        }
    }

    async askInt(prompt, def = 0) {
        while (true) {
            const raw = await this.ask(prompt, String(def));
            if (!raw || raw === String(def)) return def;
            const n = parseInt(raw, 10);
            if (!isNaN(n) && n >= 0) return n;
            this.print('  Please enter a non-negative integer.');
        }
    }

    // ── Options popup ─────────────────────────────────────────────────────
    // Shows a centered bordered list; arrow keys navigate, Enter selects.
    // Escape picks the default.

    askOptions(prompt, opts, defIdx = 0) {
        return new Promise(resolve => {
            const maxLabel    = Math.max(...opts.map(o => (o.label || '').length));
            // status: short per-item inline column (e.g. "has config"). Plain text, no color tags.
            const hasStatus   = opts.some(o => o.status);
            const statusWidth = hasStatus ? Math.max(...opts.map(o => (o.status || '').length)) : 0;
            // desc: longer help text shown in the bottom bar (reused by mapping/runtime pickers).
            const hasDesc     = opts.some(o => o.desc);
            // color: optional label color for a single special item (e.g. "Add new assignment").
            const hasColor    = opts.some(o => o.color);

            const maxDesc = hasDesc ? Math.max(...opts.map(o => (o.desc || '').length)) : 0;
            const W = Math.min(
                Math.max(maxLabel + 8 + (hasStatus ? 2 + statusWidth : 0), hasDesc ? maxDesc + 6 : 44),
                this.screen.width - 4
            );
            const innerH = Math.max(3, Math.min(opts.length, this.screen.height - 10));
            const H      = innerH + (hasDesc ? 4 : 3);

            const box = blessed.box({
                parent: this.screen, top: 'center', left: 'center',
                width: W, height: H,
                border: { type: 'line' },
                label: ` ${String(prompt).slice(0, W - 4)} `,
                style: { border: { fg: 'cyan' } },
            });

            const items = opts.map(o => {
                const colorOpen  = o.color ? `{${o.color}-fg}` : '';
                const colorClose = o.color ? `{/}` : '';
                if (hasStatus) {
                    const lbl = (o.label || '').padEnd(maxLabel);
                    return `  ${colorOpen}${lbl}${colorClose}  ${o.status || ''}`;
                }
                return `  ${colorOpen}${o.label || ''}${colorClose}`;
            });

            const list = blessed.list({
                parent: box, top: 1, left: 1,
                width: W - 4, height: innerH,
                keys: true, vi: true, mouse: false,
                tags: hasColor || false,
                items,
                style: {
                    selected: { bg: 'cyan', fg: 'black', bold: true },
                },
            });

            // Bottom help bar: yellow so it reads as information, not as a selection highlight.
            const descLine = hasDesc ? blessed.text({
                parent: box, bottom: 1, left: 2, height: 1, width: W - 6,
                content: opts[defIdx]?.desc || '',
                style: { fg: 'yellow' },
            }) : null;

            const updateDesc = idx => {
                if (descLine) { descLine.setContent(opts[idx]?.desc || ''); this.screen.render(); }
            };

            list.select(defIdx);
            updateDesc(defIdx);
            list.on('select item', (_, i) => updateDesc(i));

            this.setStatus('↑↓: navigate  Enter: select  Esc: default');

            // Guard against buffered key events (e.g. Enter/arrows from the previous popup)
            // being replayed immediately on this popup before the user sees it.
            let interactionAllowed = false;
            setImmediate(() => { interactionAllowed = true; });

            const accept = idx => {
                if (!interactionAllowed) return;
                box.detach();
                this.setStatus('^C: exit');
                this.print(`  ${prompt}: ${opts[idx].label}`);
                this.screen.render();
                resolve(opts[idx].value);
            };

            list.on('select', (_, i) => accept(i));
            list.key(['escape'], () => accept(defIdx));
            list.key(['C-c'], () => this.exit(130));
            list.focus();
            this.screen.render();
        });
    }

    // ── Review table ──────────────────────────────────────────────────────
    // Full-screen navigable table of draft mappings.
    //   makeItems(draft) → string[]   — formats draft into display rows
    //   editRow(idx)     → Promise<boolean>  — true if the draft row was modified
    //
    // The loop repeats until the user presses A (accept all).

    /**
     * Full-screen review table. ↑↓ pick a row, ←→ pick a column, Enter edits the selected
     * value, `a` accepts. `columns` is [{ name, editable? }]; `getRows()` returns one array of
     * cell strings per row (re-called after each edit); `editCell(rowIdx, colIdx)` resolves
     * true when something changed. With `opts.canSave`, `s` also closes the table. Resolves
     * 'accept' (a) or 'save' (s: the caller should write the config now and skip further questions).
     */
    async reviewTable(columns, getRows, editCell, opts = {}) {
        while (true) {
            const done = await this._tableView(columns, getRows, editCell, opts);
            if (done) return done;
        }
    }

    _tableView(columns, getRows, editCell, opts = {}) {
        return new Promise(resolve => {
            const overlay = blessed.box({
                parent: this.screen,
                top: 1, left: 0, width: '100%', height: '100%-2',
                border: { type: 'line' },
                label: ' Review Draft Mappings ',
                style: { border: { fg: 'cyan' } },
            });

            let col = Math.max(0, columns.findIndex(c => c.editable !== false));
            const esc = t => String(t).replace(/[{}]/g, ch => (ch === '{' ? '{open}' : '{close}'));

            // Cells are padded to the widest value in their column; the selected cell of the
            // selected row is highlighted (yellow) inside the row's own cyan selection bar.
            const render = () => {
                const rows = getRows();
                const widths = columns.map((c, i) => Math.min(34, Math.max(c.name.length, ...rows.map(r => String(r[i] ?? '').length))));
                const fit = (v, i) => esc(String(v ?? '').slice(0, widths[i]).padEnd(widths[i]));
                const items = rows.map((r, ri) => r.map((v, i) =>
                    (ri === sel && i === col) ? `{yellow-bg}{black-fg}${fit(v, i)}{/}` : fit(v, i)).join(' │ '));
                header.setContent(columns.map((c, i) => (i === col ? `{yellow-fg}${esc(c.name.padEnd(widths[i]))}{/}` : esc(c.name.padEnd(widths[i])))).join(' │ '));
                return items;
            };
            let sel = 0;

            const header = blessed.text({
                parent: overlay, top: 0, left: 1, height: 1, width: '100%-4', tags: true, content: '',
                style: { fg: 'white', bold: true },
            });
            const list = blessed.list({
                parent: overlay,
                top: 1, left: 1, width: '100%-4', height: '100%-5',
                keys: true, vi: true, mouse: false, tags: true,
                items: [],
                style: { selected: { bg: 'cyan', fg: 'black', bold: true } },
                scrollbar: { ch: '│' },
            });

            blessed.text({
                parent: overlay,
                bottom: 1, left: 2, height: 1, width: '100%-4',
                content: `  ←→: pick value   ↑↓: pick row   Enter: edit value   a: accept all${opts.canSave ? '   s: save & quit' : ''}   ^C: exit`,
                style: { fg: 'cyan' },
            });

            this.setStatus(`Review draft — ←→ value  ↑↓ row  Enter: edit  a: accept all${opts.canSave ? '  s: save & quit' : ''}`);

            // setItems/select fire 'select item' themselves, so ignore those while refreshing.
            let refreshing = false;
            const refresh = () => {
                refreshing = true;
                try {
                    const items = render();
                    list.setItems(items);
                    list.select(sel);
                } finally { refreshing = false; }
                this.screen.render();
            };

            const close = accepted => {
                overlay.detach();
                this.setStatus('^C: exit');
                this.screen.render();
                resolve(accepted);
            };

            const moveCol = step => {
                // Skip non-editable columns (the row number) so the cursor always lands on a value.
                let next = col;
                for (let n = 0; n < columns.length; n++) {
                    next = (next + step + columns.length) % columns.length;
                    if (columns[next].editable !== false) break;
                }
                col = next;
                refresh();
            };

            list.key(['left', 'h'], () => moveCol(-1));
            list.key(['right', 'l'], () => moveCol(1));
            list.on('select item', (_, idx) => {
                if (!refreshing && idx !== sel) { sel = idx; refresh(); }
            });
            list.key(['a', 'A'], () => close('accept'));
            if (opts.canSave) list.key(['s', 'S'], () => close('save'));
            list.key(['C-c'], () => this.exit(130));

            list.on('select', (_, idx) => {
                sel = idx;
                editCell(idx, col).then(() => {
                    refresh();
                    list.focus();
                });
            });

            refresh();
            list.focus();
            this.screen.render();
        });
    }

    // ── Spinner / progress ────────────────────────────────────────────────

    showSpinner(msg) {
        if (this._spinnerBox) this._spinnerBox.detach();
        this._spinnerBox = blessed.box({
            parent: this.screen, top: 'center', left: 'center',
            width: Math.min(msg.length + 6, this.screen.width - 4), height: 3,
            border: { type: 'line' },
            content: `  ${msg}`,
            style: { border: { fg: 'yellow' }, fg: 'yellow' },
            tags: false,
        });
        this.screen.render();
    }

    clearSpinner() {
        if (this._spinnerBox) {
            this._spinnerBox.detach();
            this._spinnerBox = null;
            this.screen.render();
        }
    }
}

export { TUI };
