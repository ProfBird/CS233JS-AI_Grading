/**
 * prompt_driver.js
 *
 * bin/grade.js's interactive-prompt backend selector. Provides two implementations of
 * the same driver interface config_prompts.js already documents (ask/askBoolean/askInt/
 * askOptions/print/exit), plus 4 grade.js-specific extensions (note/takeNotes/banner/
 * close), so bin/grade.js's prompt code can be written once and run over either a
 * full-screen neo-blessed TUI (src/lib/tui.js — the same one bin/configure-lab.js uses)
 * or a plain readline fallback for piped/non-TTY invocations
 * (e.g. `node bin/grade.js Lab03 --regrade > out.txt`, or scripted stdin).
 *
 * Driver contract:
 *   ask(prompt, def='')                → Promise<string>   trims; empty input -> def
 *   askBoolean(question, def=false)    → Promise<boolean>
 *   askInt(prompt, def=0)              → Promise<number>   rejects negative numbers
 *   askOptions(prompt, opts, defIdx=0) → Promise<value>    opts: {label, value, desc?,
 *                                                            status?, color?, match?}
 *   print(line)                        → void
 *   exit(code=0)                       → never returns
 *   note(line)                         → void   print() + buffer for replay after close()
 *   takeNotes()                        → string[]
 *   banner(text)                       → void   TUI: sets the screen title; readline:
 *                                                the boxed banner bin/grade.js used to draw
 *   close()                            → void   TUI: destroy(); readline: rl.close()
 *
 * Call sites must pass a BARE, single-line label plus a separate `def` — never embed
 * "[default]" or a trailing ": " in the prompt string, and never embed "\n". Each backend
 * owns its own decoration (see createReadlineDriver's `_decorate` and TUI.ask, tui.js).
 * `opts[].match` is an additive key ignored by the TUI backend: extra names (besides
 * `label` and a string `value`) the readline backend accepts as typed input, e.g. a course
 * matching both its directory name and its display name from one askOptions call.
 */
import readline from 'readline';
import { selectFromList } from './select_from_list.js';

// ─────────────────────────────────────────────────────────────────────────
// Readline-backed driver (piped / non-TTY / scripted use)
// ─────────────────────────────────────────────────────────────────────────

function createReadlineDriver({ input = process.stdin, output = process.stdout } = {}) {
    let completions = [];
    const rl = readline.createInterface({
        input, output,
        completer: line => {
            const hits = completions.filter(c => c.toLowerCase().startsWith(line.toLowerCase()));
            return [hits, line];
        },
    });
    const question = q => new Promise(resolve => rl.question(q, resolve));

    let notes = [];
    let sigintHooked = false;

    function print(line = '') {
        output.write(String(line ?? '') + '\n');
    }

    function exit(code = 0) {
        close();
        process.exit(code);
    }

    function close() {
        rl.close();
    }

    return {
        print,
        note(line = '') { print(line); notes.push(String(line ?? '')); },
        takeNotes() { const n = notes; notes = []; return n; },
        exit,
        close,

        // TUI.ask (tui.js:78-117) trims and falls back to `def` on empty submit, decorating
        // the label itself as `${prompt} [${def}]` (or `[blank]` with no default). Mirror
        // both the decoration and the empty->def fallback here so callers passing no default
        // (the fatal-blank sites) keep getting '' back from both backends unchanged.
        async ask(prompt, def = '') {
            const defStr = def != null ? String(def) : '';
            const label = defStr ? `${prompt} [${defStr}]` : prompt;
            const raw = await question(`${label}: `);
            const result = (raw != null ? String(raw) : '').trim() || defStr;
            return result;
        },

        async askBoolean(question_, def = false) {
            const hint = def ? '[Y/n]' : '[y/N]';
            while (true) {
                const raw = (await this.ask(`${question_} ${hint}`, '')).toLowerCase();
                if (!raw) return def;
                if (raw === 'y' || raw === 'yes') return true;
                if (raw === 'n' || raw === 'no') return false;
                print('  Please enter y or n.');
            }
        },

        async askInt(prompt, def = 0) {
            while (true) {
                const raw = await this.ask(prompt, String(def));
                if (!raw || raw === String(def)) return def;
                const n = parseInt(raw, 10);
                if (!isNaN(n) && n >= 0) return n;
                print('  Please enter a non-negative integer.');
            }
        },

        // Prints the numbered list itself (askOptions owns rendering in both backends),
        // then delegates the number-or-name resolve loop to select_from_list.js. Resolves
        // to the matched OPTION OBJECT (never `getValue: o => o.value`) and reads `.value`
        // afterward — selectFromList's `while (!selected)` loop (select_from_list.js:41-52)
        // treats a falsy resolution as "keep prompting", so an option whose `value` is falsy
        // (e.g. `null`, used by configure-lab.js's "no AI" choice) would otherwise hang
        // forever. This mirrors tui.js:226, which resolves `opts[idx].value` after accepting
        // the object-shaped selection, not before.
        async askOptions(prompt, opts, defIdx = 0) {
            opts.forEach((o, i) => {
                const status = o.status ? `  ${o.status}` : '';
                print(`  ${i + 1}) ${o.label}${status}`);
            });
            print('');
            const hasDef = Number.isInteger(defIdx) && defIdx >= 0 && defIdx < opts.length;
            completions = opts.map(o => o.label);
            const chosen = await selectFromList(question, {
                items: opts,
                matchNames: o => [
                    String(o.label),
                    ...(Array.isArray(o.match) ? o.match : []),
                    ...(typeof o.value === 'string' ? [o.value] : []),
                ],
                promptText: `${prompt} (number or name)${hasDef ? ` [${defIdx + 1}]` : ''}: `,
                defaultIndex: hasDef ? defIdx : null,
                printer: print,
            });
            completions = [];
            print(`  ${prompt}: ${chosen.label}`);
            return chosen.value;
        },

        // readline equivalent of the boxed banner bin/grade.js used to draw directly.
        banner(text) {
            const boxWidth = Math.max(36, text.length + 6);
            const pad = boxWidth - 2 - text.length;
            const leftPad = Math.floor(pad / 2), rightPad = pad - leftPad;
            print(`\n╔${'═'.repeat(boxWidth - 2)}╗`);
            print(`║${' '.repeat(leftPad)}${text}${' '.repeat(rightPad)}║`);
            print(`╚${'═'.repeat(boxWidth - 2)}╝`);
        },

        // Parity with the TUI's ^C -> exit(130) binding (tui.js:42, 113, 225).
        _hookSigint() {
            if (sigintHooked) return;
            sigintHooked = true;
            rl.on('SIGINT', () => exit(130));
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────
// TUI-backed driver — lazily wraps src/lib/tui.js's TUI class
// ─────────────────────────────────────────────────────────────────────────

// A shortcut run (e.g. `node bin/grade.js Lab03 --regrade`) asks nothing, so the TUI must
// not open eagerly — that would flash the alt-buffer open and closed for no reason. The
// screen is constructed lazily, on the first call that actually needs interaction; `print`
// before that point goes straight to the real terminal, and a `note` emitted before the
// screen exists is not buffered (it already reached scrollback, so replaying it after
// close() would duplicate it).
function createTuiDriver(title) {
    let tui = null;
    let notes = [];

    async function ensureTui() {
        if (!tui) {
            const { TUI } = await import('./tui.js');
            tui = new TUI(title);
        }
        return tui;
    }

    return {
        print(line = '') {
            if (tui) tui.print(line);
            else process.stdout.write(String(line ?? '') + '\n');
        },
        note(line = '') {
            this.print(line);
            if (tui) notes.push(String(line ?? ''));
        },
        takeNotes() { const n = notes; notes = []; return n; },
        exit(code = 0) {
            if (tui) tui.exit(code);
            else process.exit(code);
        },
        close() {
            if (tui) tui.destroy();
        },
        async ask(prompt, def = '') {
            const t = await ensureTui();
            return t.ask(prompt, def);
        },
        async askBoolean(question, def = false) {
            const t = await ensureTui();
            return t.askBoolean(question, def);
        },
        async askInt(prompt, def = 0) {
            const t = await ensureTui();
            return t.askInt(prompt, def);
        },
        async askOptions(prompt, opts, defIdx = 0) {
            const t = await ensureTui();
            return t.askOptions(prompt, opts, defIdx);
        },
        async banner(text) {
            const t = await ensureTui();
            t.setTitle(text);
        },
        // Arrow-key file/folder picker (tui.js TUI.pickPath) — only the TUI backend has one.
        async pickPath(opts) {
            const t = await ensureTui();
            return t.pickPath(opts);
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────
// Backend selection
// ─────────────────────────────────────────────────────────────────────────

// blessed needs a real TTY on BOTH ends — `node bin/grade.js > out.txt` has a TTY stdin
// but a piped stdout, and an eager blessed screen there would write escape sequences into
// the redirected file instead of rendering.
function defaultInteractive() {
    return !!(process.stdin.isTTY && process.stdout.isTTY);
}

async function createDriver({ title = 'AI Grader', interactive = defaultInteractive() } = {}) {
    if (interactive) {
        return createTuiDriver(title);
    }
    const driver = createReadlineDriver();
    driver._hookSigint();
    return driver;
}

export { createReadlineDriver, createDriver };
