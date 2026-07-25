/**
 * mock_driver.mjs
 *
 * Shared fake prompt driver for tests exercising driver-based prompt code
 * (config_prompts.js, src/lib/grade_setup.js). Answers are consumed in order from a
 * fixed queue; running out throws so a test fails loudly instead of hanging, and an
 * empty-string answer means "accept the default" for ask/askBoolean/askInt/askOptions.
 *
 * Originally test/configure_lab.spec.mjs's local mockDriver(); lifted here once
 * grade_setup.spec.mjs needed the same shape, plus two additions:
 *   - a `calls` array recording every driver method invocation, so a test can assert
 *     e.g. "the shortcut path prompted for nothing" without inspecting stdout;
 *   - an optional `strict` mode that throws if a prompt/question string ends in a
 *     "[...]" bracket or a trailing ":", or contains a newline — the convention every
 *     driver call site must follow (see src/lib/prompt_driver.js's header comment) is a
 *     bare, single-line label with the default passed separately, because each backend
 *     (TUI vs readline) decorates the prompt itself; a call site that embeds its own
 *     "[default]" renders doubled brackets on both backends.
 */

const BAD_PROMPT_RE = /\[[^\]]*\]\s*$/;

function checkPromptString(strict, prompt) {
    if (!strict) return;
    if (typeof prompt !== 'string') return;
    if (BAD_PROMPT_RE.test(prompt)) {
        throw new Error(`mockDriver(strict): prompt string embeds its own "[default]" — pass the default separately: ${JSON.stringify(prompt)}`);
    }
    if (/:\s*$/.test(prompt)) {
        throw new Error(`mockDriver(strict): prompt string ends in ":" — each backend appends its own: ${JSON.stringify(prompt)}`);
    }
    if (prompt.includes('\n')) {
        throw new Error(`mockDriver(strict): prompt string contains a newline — use driver.print() for multi-line guidance: ${JSON.stringify(prompt)}`);
    }
}

/**
 * @param {string[]} answers - consumed in order, one per ask/askBoolean/askInt/askOptions call
 * @param {Object} [opts]
 * @param {boolean} [opts.strict=false] - validate every prompt string against the
 *        bare-label convention described above
 * @returns {Object} a driver satisfying config_prompts.js's 6-method interface plus
 *          grade_setup.js's note/takeNotes/banner/close extensions, plus a `calls` array
 */
function mockDriver(answers, { strict = false } = {}) {
    const queue = [...answers];
    const pop = () => queue.shift() ?? null;
    const calls = [];
    let notes = [];

    return {
        calls,

        print(line) { calls.push({ method: 'print', line }); },
        note(line) { calls.push({ method: 'note', line }); notes.push(String(line ?? '')); },
        takeNotes() { const n = notes; notes = []; return n; },
        banner(text) { calls.push({ method: 'banner', text }); },
        close() { calls.push({ method: 'close' }); },
        exit(code = 0) { calls.push({ method: 'exit', code }); throw new Error(`driver.exit(${code}) called`); },

        ask(prompt, def = '') {
            checkPromptString(strict, prompt);
            calls.push({ method: 'ask', prompt, def });
            const v = pop();
            if (v === null) throw new Error(`driver.ask: no more answers (prompt: ${JSON.stringify(prompt)})`);
            return Promise.resolve(v !== '' ? v : def);
        },

        askBoolean(question, def = false) {
            checkPromptString(strict, question);
            calls.push({ method: 'askBoolean', question, def });
            const v = pop();
            if (v === null) throw new Error(`driver.askBoolean: no more answers (question: ${JSON.stringify(question)})`);
            if (v === '') return Promise.resolve(def);
            return Promise.resolve(/^y(es)?$/i.test(v));
        },

        askInt(prompt, def = 0) {
            checkPromptString(strict, prompt);
            calls.push({ method: 'askInt', prompt, def });
            const v = pop();
            if (v === null) throw new Error(`driver.askInt: no more answers (prompt: ${JSON.stringify(prompt)})`);
            const n = parseInt(v, 10);
            return Promise.resolve(!isNaN(n) ? n : def);
        },

        askOptions(prompt, opts, defIdx = 0) {
            checkPromptString(strict, prompt);
            calls.push({ method: 'askOptions', prompt, opts, defIdx });
            const v = pop();
            if (v === null) throw new Error(`driver.askOptions: no more answers (prompt: ${JSON.stringify(prompt)})`);
            if (v === '') return Promise.resolve(opts[defIdx]?.value ?? opts[0]?.value);
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 1 && n <= opts.length) return Promise.resolve(opts[n - 1].value);
            // direct value or name match (mirrors select_from_list.js's matchNames)
            const match = opts.find(o =>
                o.value === v ||
                (typeof o.label === 'string' && o.label.toLowerCase() === String(v).toLowerCase()) ||
                (Array.isArray(o.match) && o.match.some(m => m.toLowerCase() === String(v).toLowerCase()))
            );
            return Promise.resolve(match ? match.value : (opts[defIdx]?.value ?? opts[0]?.value));
        },
    };
}

export { mockDriver };
