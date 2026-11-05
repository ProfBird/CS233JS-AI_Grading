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

/**
 * The inverse of makeCommentStripper: returns only the comment text (joined by newlines),
 * using the same grammar options and the same ordering, so "what counts as a comment" is
 * identical in both directions. Used by checks that must look at comments only — e.g. the
 * developer name/date check, which must not be satisfied by code like `name = input()`.
 *
 * @param {Object} opts - same as makeCommentStripper, plus:
 * @param {RegExp[]} [opts.docPatterns] - literal grammars whose text also counts as comment
 *        text (global flag; when it has a capture group, group 1 is the text) — e.g. Python's
 *        module docstring, where file-header "Author: ..." blocks conventionally live.
 *        Collected before protectPatterns run.
 * @returns {(code: string) => string}
 */
function makeCommentExtractor({ blockComment = null, lineComment = null, protectPatterns = [], docPatterns = [] } = {}) {
    return function extractComments(code) {
        const comments = [];
        if (blockComment) code = code.replace(blockComment, m => { comments.push(m); return ''; });
        for (const re of docPatterns) {
            // A pattern with a capture group contributes just that group (e.g. the docstring
            // itself, without the lines a start-of-file pattern had to skip to reach it).
            for (const m of code.matchAll(re)) comments.push(m[1] ?? m[0]);
        }
        const strings = [];
        for (const re of protectPatterns) {
            code = protect(code, re, strings);
        }
        if (lineComment) {
            // A quoted phrase inside a line comment (# by "Jo") was placeholder-swapped by
            // the protect pass above; restore it so the comment text is complete.
            for (const m of code.matchAll(lineComment)) {
                comments.push(m[0].replace(/\x00(\d+)\x00/g, (_, i) => strings[+i]));
            }
        }
        return comments.join('\n');
    };
}

export { makeCommentStripper, makeCommentExtractor };
