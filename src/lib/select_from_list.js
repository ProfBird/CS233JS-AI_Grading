/**
 * select_from_list.js
 *
 * The "number or name" selection loop bin/grade.js re-implements for every picker
 * (course, term, assignment, step, Canvas assignment, group) — prompt, accept either a
 * 1-based list index or a case-insensitive name match, optionally accept a trailing
 * "create new" option, loop on invalid input. Printing the list itself (numbering,
 * labels, an "Add new X" line, readline tab-completions) stays with each caller since
 * those vary; this is just the shared resolve-the-answer loop.
 */

/**
 * @param {(prompt: string) => Promise<string>} ask - prompts for and returns raw input
 *        (e.g. bin/grade.js's `askRl`)
 * @param {Object} opts
 * @param {any[]} opts.items - the pickable items, in the same order they were numbered
 *        when printed to the user
 * @param {(item: any) => string[]} opts.matchNames - names an item can be selected by
 *        (case-insensitive); e.g. a course matches its directory name AND display name
 * @param {(item: any) => any} [opts.getValue] - maps a matched item to the resolved
 *        value; defaults to the item itself
 * @param {string} [opts.promptText] - the full prompt string, including trailing
 *        punctuation/space
 * @param {{ action: () => Promise<any|null> }} [opts.extraOption] - when given, selecting
 *        the number one past the item list (items.length + 1) invokes `action()` instead
 *        of resolving an item; a null/falsy return from `action` re-prompts rather than
 *        resolving (e.g. the user cancelled out of a "create new X" flow)
 * @param {string} [opts.invalidMessage] - printed (via console.log) on an unrecognized
 *        answer, before re-prompting
 * @returns {Promise<any>} the resolved value
 */
async function selectFromList(ask, {
    items,
    matchNames,
    getValue = item => item,
    promptText = 'Select an option (number or name): ',
    extraOption = null,
    invalidMessage = '  Invalid selection, try again.',
}) {
    let selected = null;
    while (!selected) {
        const input = await ask(promptText);
        const trimmed = input.trim();
        const num = parseInt(trimmed);

        if (extraOption && num === items.length + 1) {
            const created = await extraOption.action();
            if (created) selected = created;
            continue;
        }
        if (!isNaN(num) && num >= 1 && num <= items.length) {
            selected = getValue(items[num - 1]);
            continue;
        }
        const found = items.find(item =>
            matchNames(item).some(name => name.toLowerCase() === trimmed.toLowerCase())
        );
        if (found) {
            selected = getValue(found);
        } else {
            console.log(invalidMessage);
        }
    }
    return selected;
}

export { selectFromList };
