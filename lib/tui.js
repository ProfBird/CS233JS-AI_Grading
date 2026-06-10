'use strict';
// Terminal UI primitives for configure_lab.js.
// Wraps neo-blessed: provides a scrollable log pane, prompt-bar text input,
// popup option lists with arrow-key navigation, and a full-screen review table.

const blessed = require('neo-blessed');

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

    print(line = '') {
        this._log.log(String(line ?? ''));
        this.screen.render();
    }

    setStatus(text) {
        this._status.setContent(` ${text}`);
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

    async reviewTable(makeItems, editRow) {
        while (true) {
            const done = await this._tableView(makeItems, editRow);
            if (done) break;
        }
    }

    _tableView(makeItems, editRow) {
        return new Promise(resolve => {
            const overlay = blessed.box({
                parent: this.screen,
                top: 1, left: 0, width: '100%', height: '100%-2',
                border: { type: 'line' },
                label: ' Review Draft Mappings ',
                style: { border: { fg: 'cyan' } },
            });

            const list = blessed.list({
                parent: overlay,
                top: 1, left: 1, width: '100%-4', height: '100%-5',
                keys: true, vi: true, mouse: false,
                items: makeItems(),
                style: {
                    selected: { bg: 'cyan', fg: 'black', bold: true },
                },
                scrollbar: { ch: '│' },
            });

            blessed.text({
                parent: overlay,
                bottom: 1, left: 2, height: 1, width: '100%-4',
                content: '  a: accept all   Enter: edit selected row   ^C: exit',
                style: { fg: 'cyan' },
            });

            this.setStatus('Review draft — a: accept all  Enter: edit  ↑↓/j/k: navigate');

            const close = accepted => {
                overlay.detach();
                this.setStatus('^C: exit');
                this.screen.render();
                resolve(accepted);
            };

            list.key(['a', 'A'], () => close(true));
            list.key(['C-c'], () => this.exit(130));

            list.on('select', (_, idx) => {
                editRow(idx).then(changed => {
                    if (changed) list.setItems(makeItems());
                    list.focus();
                    this.screen.render();
                });
            });

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

module.exports = { TUI };
