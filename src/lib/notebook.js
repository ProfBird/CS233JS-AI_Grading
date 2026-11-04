/**
 * notebook.js
 *
 * Jupyter notebooks (.ipynb — e.g. CS212's Colab labs) as source code. A notebook is JSON, so
 * regex feature checks, the developer-comment check and import scanning can't read it raw
 * (every line is an escaped string). notebookToSource() turns it into a plain Python script
 * in the "percent" format editors understand: code cells as code, markdown cells as `#`
 * comment lines (where students usually put their name, date and AI-use notes), each cell
 * introduced by a `# %%` marker. readSourceFile() is the one reader the analysis uses for
 * source files, converting notebooks and reading everything else as text.
 */

import fs from 'fs';

const isNotebook = file => file.toLowerCase().endsWith('.ipynb');

// A cell's `source` is a string or a list of line strings (nbformat allows both).
const cellText = cell => (Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || ''));

/**
 * @param {string} jsonText - the .ipynb file's contents
 * @returns {string|null} the notebook as a Python script, or null if it isn't a readable notebook
 */
function notebookToSource(jsonText) {
    let nb;
    try { nb = JSON.parse(jsonText); } catch (e) { return null; }
    if (!nb || !Array.isArray(nb.cells)) return null;
    const parts = [];
    for (const cell of nb.cells) {
        const text = cellText(cell).replace(/\s+$/, '');
        if (cell.cell_type === 'code') {
            parts.push(`# %%\n${text}`);
        } else if (cell.cell_type === 'markdown') {
            parts.push(`# %% [markdown]\n${text.split(/\r?\n/).map(l => (l ? `# ${l}` : '#')).join('\n')}`);
        }
        // raw cells carry no code or prose worth checking
    }
    return parts.join('\n\n') + '\n';
}

/**
 * Reads a source file for analysis: notebooks converted with notebookToSource() (an unreadable
 * notebook reads as empty), everything else as UTF-8 text. Throws like fs.readFileSync when
 * the file can't be read.
 */
function readSourceFile(file) {
    const content = fs.readFileSync(file, 'utf8');
    if (!isNotebook(file)) return content;
    return notebookToSource(content) ?? '';
}

export { notebookToSource, readSourceFile, isNotebook };
