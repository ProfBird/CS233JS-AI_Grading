/**
 * rubric_markdown.js
 *
 * Renders a rubric spreadsheet's Grade sheet as a Markdown table (bin/rubric-to-md.js).
 * Finds the header row and columns with lab_config.js's detectRubricLayout — the same
 * detection the grader and the lab wizard use — so a rubric headed "Points" (CS212) works as
 * well as one headed "Possible" (CS233JS).
 */

import { detectRubricLayout, cellText, isBlankRow } from './lab_config.js';

/**
 * @param {Array<Array<*>>} rows - the Grade sheet as rows of cells (sheet_to_json header:1)
 * @returns {{ markdown: string, foundTable: boolean }} — foundTable is false when no header row
 *   (Possible / Points / Pts / Max) was found, in which case markdown holds only the title.
 */
function renderGradeSheet(rows) {
    const lines = [];
    const title = cellText(rows[0] || [], 0);
    if (title) lines.push(`# ${title}`, '');

    const layout = detectRubricLayout(rows);
    if (!layout) return { markdown: lines.join('\n'), foundTable: false };
    const { headerRow, possibleCol, scoreCol, commentCol } = layout;

    // The table ends where the canned-comments block ("Comments" in column A) starts.
    let tableEnd = rows.length;
    for (let i = headerRow + 1; i < rows.length; i++) {
        if (/^comments$/i.test(cellText(rows[i], 0))) { tableEnd = i; break; }
    }

    const possibleLabel = cellText(rows[headerRow], possibleCol) || 'Possible';
    lines.push(`| Requirement | ${possibleLabel} | Actual | Comments |`);
    lines.push('|---|---:|---:|---|');

    for (let i = headerRow + 1; i < tableEnd; i++) {
        const row = rows[i];
        if (!row || isBlankRow(row)) continue;
        // Sub-requirements may sit in column B under a column-A section heading (as the
        // grader's own readRubricRows reads them).
        const label = cellText(row, 0) || cellText(row, 1);
        if (!label) continue;

        const possible = cellText(row, possibleCol);
        const actual = cellText(row, scoreCol);
        // Some rubrics put the per-row comment one column right of the "Comments" header.
        const comment = cellText(row, commentCol) || cellText(row, commentCol + 1);

        const lower = label.toLowerCase();
        const isTotalLine = lower.startsWith('total') || lower.startsWith('sub-total') || lower.startsWith('subtotal');
        if (possible === '' && actual === '' && comment === '') {
            lines.push(`| **${label}** | | | |`);
        } else if (isTotalLine) {
            lines.push(`| **${label.replace(/:$/, '')}** | **${possible}** | **${actual}** | |`);
        } else {
            lines.push(`| ${label} | ${possible} | ${actual} | ${comment} |`);
        }
    }
    return { markdown: lines.join('\n'), foundTable: true };
}

export { renderGradeSheet };
