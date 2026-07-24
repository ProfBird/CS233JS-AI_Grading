/**
 * comment_stripper.js
 *
 * Factory for the "protect string/raw-literal contents, then strip comments" pattern that
 * was hand-duplicated (with only the literal-grammar regexes differing) across all four
 * language adapters' stripComments(). Each adapter's differences are purely which string/
 * raw-literal grammars need protecting before comment-stripping runs, and whether the
 * language has C-style block comments at all (Python doesn't).
 *
 * Order matters: block comments are stripped FIRST (so an apostrophe/quote inside a block
 * comment, e.g. in JSDoc prose, is never mistaken for the start of a string literal), THEN
 * each protectPatterns regex runs in order (placeholder-swapping matched text out so a
 * line-comment marker inside a protected string/raw-literal isn't later mistaken for a real
 * one), THEN the line-comment regex runs, THEN placeholders are restored.
 */

// Swaps every match of `re` in `code` for a \x00N\x00 placeholder, recording the original
// text at index N in `strings` so it can be restored later.
function protect(code, re, strings) {
    return code.replace(re, m => {
        strings.push(m);
        return `\x00${strings.length - 1}\x00`;
    });
}

/**
 * @param {Object} opts
 * @param {RegExp|null} [opts.blockComment] - matches this language's block-comment syntax
 *        (global flag), or null if the language has none (Python)
 * @param {RegExp|null} [opts.lineComment] - matches this language's line-comment syntax
 *        (global flag), or null if none
 * @param {RegExp[]} [opts.protectPatterns] - string/raw-literal grammars to protect, applied
 *        in order, BEFORE lineComment strips (so a comment marker inside one of these never
 *        gets mistaken for a comment start)
 * @returns {(code: string) => string}
 */
function makeCommentStripper({ blockComment = null, lineComment = null, protectPatterns = [] } = {}) {
    return function stripComments(code) {
        if (blockComment) code = code.replace(blockComment, '');
        const strings = [];
        for (const re of protectPatterns) {
            code = protect(code, re, strings);
        }
        if (lineComment) code = code.replace(lineComment, '');
        code = code.replace(/\x00(\d+)\x00/g, (_, i) => strings[+i]);
        return code;
    };
}

export { makeCommentStripper };
