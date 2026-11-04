/**
 * read_code_review.js
 *
 * Reads the code review form (.docx) from each student's submission
 * and parses out:
 *   - Lab assignment group (A/B/C) from "Developer's lab version" field
 *   - Per-item reviewer scores for manually-checked rubric items,
 *     distinguishing between beta and production columns
 *
 * Attaches results to student.codeReview for use by generate_grades.js.
 */

import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import { writePhaseReport } from '../lib/per_student_phase.js';

const CODE_REVIEW_REPORT = 'code_review_report.json';

// --- Finding the .docx file ---

function findReviewDocx(dirs) {
    for (const dir of dirs) {
        if (!dir || !fs.existsSync(dir)) continue;
        let entries;
        try { entries = fs.readdirSync(dir); } catch (e) { continue; }
        const docx = entries.find(f => {
            const lower = f.toLowerCase();
            return lower.includes('review') && lower.endsWith('.docx');
        });
        if (docx) return path.join(dir, docx);
    }
    return null;
}

// --- Parsing ---

function parseGroupLetter(text) {
    const match = text.match(/Developer'?s\s+lab\s+version\s*[:\s]*\b([A-C])\b/i);
    return match ? match[1].toUpperCase() : null;
}

/**
 * Find the group letter from the HTML table by locating the row with
 * "lab version" in one cell and reading the adjacent cell to the right.
 * This avoids the false match on "(A, B, or C)" in the label text itself.
 */
function parseGroupFromTable(html) {
    // Find all tables (there may be more than one)
    const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tableMatch;
    while ((tableMatch = tableRe.exec(html)) !== null) {
        const rows = [];
        const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
            const cells = [];
            const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
            let cellMatch;
            while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
                cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
            }
            if (cells.length > 0) rows.push(cells);
        }

        for (const row of rows) {
            for (let i = 0; i < row.length - 1; i++) {
                if (/lab\s+version/i.test(row[i])) {
                    const nextCell = row[i + 1];
                    const letterMatch = nextCell.match(/\b([A-C])\b/);
                    if (letterMatch) return letterMatch[1].toUpperCase();
                }
            }
        }
    }
    return null;
}

/**
 * Parse a table cell to extract score and yes/no semantics.
 * Returns { score, filled, affirmative } where:
 *   - score: numeric score from fraction, or null
 *   - filled: true if cell has meaningful content (fraction or Y/N)
 *   - affirmative: true for fraction/Y/Yes, false for N/No, null if empty
 */
function parseCellValue(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return { score: null, filled: false, affirmative: null };
    const fractionMatch = trimmed.match(/(\d+)\s*\/\s*\d+/);
    if (fractionMatch) return { score: parseInt(fractionMatch[1], 10), filled: true, affirmative: true };
    if (/^(y|yes)$/i.test(trimmed)) return { score: null, filled: true, affirmative: true };
    if (/^(n|no)$/i.test(trimmed)) return { score: null, filled: true, affirmative: false };
    // Any other non-empty content (e.g. "-", "NA", a note) counts as the student having
    // addressed the cell — so it marks the production column as filled — but it is NOT
    // auto-interpretable as a score or yes/no (affirmative: null). The manual handler must
    // only auto-score when affirmative is known; otherwise such a cell falls to manual review.
    return { score: null, filled: true, affirmative: null };
}

const parseScoreFromCell = text => parseCellValue(text).score;

/**
 * Parse all HTML tables and return the one most likely to contain review scores
 * (has the most cells with fractions or Y/N values).
 */
function findScoresTable(html) {
    const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let bestTable = null;
    let bestScore = 0;

    let tableMatch;
    while ((tableMatch = tableRe.exec(html)) !== null) {
        let cellCount = 0;
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cellMatch;
        while ((cellMatch = cellRe.exec(tableMatch[1])) !== null) {
            const text = cellMatch[1].replace(/<[^>]+>/g, '').trim();
            if (/\d+\s*\/\s*\d+/.test(text) || /^(y|yes|n|no)$/i.test(text)) {
                cellCount++;
            }
        }
        if (cellCount > bestScore) {
            bestScore = cellCount;
            bestTable = tableMatch[0];
        }
    }

    return bestTable;
}

// Extract a table's rows as arrays of cell text (handles <td> and <th>, strips inner tags).
function extractRows(tableHtml) {
    const rows = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
        const cells = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
        let cellMatch;
        while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
            cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
        }
        if (cells.length > 0) rows.push(cells);
    }
    return rows;
}

// The production column's header. CS233JS forms say "Prod."; several CS212 forms say "Release".
const PROD_HEADER_RE = /prod|release|final/i;

// True if any table OTHER than `primaryHtml` has an explicit "prod" header column with at
// least one filled cell. Requiring a Prod header skips non-score tables (e.g. the metadata
// table, whose date cells like "6/5/2026" would otherwise look like fractions). This lets
// productionCompleted reflect a prod-filled second score table that isn't the primary one.
function anyOtherProdTableFilled(html, primaryHtml) {
    const tableRe = /<table[^>]*>[\s\S]*?<\/table>/gi;
    let tableMatch;
    while ((tableMatch = tableRe.exec(html)) !== null) {
        if (tableMatch[0] === primaryHtml) continue;
        const rows = extractRows(tableMatch[0]);
        if (rows.length < 2) continue;
        const prodCol = rows[0].findIndex(h => PROD_HEADER_RE.test(h));
        if (prodCol < 0) continue;
        for (let r = 1; r < rows.length; r++) {
            if (parseCellValue(rows[r][prodCol] || '').filled) return true;
        }
    }
    return false;
}

// Beta/production column indexes from a table's header row (-1 when absent).
function scoreColumns(header) {
    let betaCol = -1;
    let prodCol = -1;
    for (let i = 0; i < header.length; i++) {
        const h = header[i].toLowerCase();
        if (h.includes('beta')) betaCol = i;
        else if (PROD_HEADER_RE.test(h)) prodCol = i;
    }
    return { betaCol, prodCol };
}

// One item per data row (spacer rows included, with label ''), and whether any prod cell is filled.
function itemsFromRows(rows, betaCol, prodCol) {
    const items = [];
    let anyProdFilled = false;
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const betaScore = betaCol >= 0 && betaCol < row.length
            ? parseScoreFromCell(row[betaCol])
            : null;
        const prodCell = prodCol >= 0 && prodCol < row.length
            ? parseCellValue(row[prodCol])
            : { score: null, filled: false, affirmative: null };

        if (prodCell.filled) anyProdFilled = true;

        items.push({
            // Criterion text (first cell; empty for a form's spacer/"list errors" rows) — what
            // a manual mapping's reviewRow matches against.
            label: row[0] || '',
            betaScore,
            prodScore: prodCell.score,
            prodFilled: prodCell.filled,
            prodAffirmative: prodCell.affirmative
        });
    }
    return { items, anyProdFilled };
}

/**
 * Parse the review form's score tables to extract per-criterion beta and production scores.
 * Returns null if no suitable table is found.
 *
 * `items` come from EVERY table whose header names a Beta or Prod/Release column, in document
 * order — many forms split their criteria across several tables (e.g. "General", "Part 1",
 * "Part 2"), and manual mappings look criteria up by label (reviewRow), so all of them must be
 * visible. A form whose tables have no recognizable headers falls back to the single densest
 * table, reading its last two columns as beta/prod.
 *
 * `productionCompleted` is true when the primary (densest) table's prod column has anything
 * filled in, OR any other prod-headed table does.
 */
function parseTableScores(html) {
    const tableHtml = findScoresTable(html);
    if (!tableHtml) return null;

    const rows = extractRows(tableHtml);
    if (rows.length < 2) return null;

    let { betaCol, prodCol } = scoreColumns(rows[0]);
    // If headers aren't identifiable, assume last two columns are beta, prod
    if (betaCol === -1 && prodCol === -1 && rows[0].length >= 2) {
        betaCol = rows[0].length - 2;
        prodCol = rows[0].length - 1;
    }
    const primary = itemsFromRows(rows, betaCol, prodCol);

    // Criteria from every header-identified score table, in document order.
    const items = [];
    for (const table of html.match(/<table[^>]*>[\s\S]*?<\/table>/gi) || []) {
        const tRows = extractRows(table);
        if (tRows.length < 2) continue;
        const cols = scoreColumns(tRows[0]);
        if (cols.betaCol === -1 && cols.prodCol === -1) continue;
        items.push(...itemsFromRows(tRows, cols.betaCol, cols.prodCol).items);
    }

    return {
        items: items.length > 0 ? items : primary.items,
        productionCompleted: primary.anyProdFilled || anyOtherProdTableFilled(html, tableHtml)
    };
}

// Exported for unit testing the HTML-table parsing against mammoth-style output.
export { parseCellValue, parseGroupFromTable, findScoresTable, parseTableScores };

// --- Main export ---

export default async function (students, _config, labDir = null) {
    console.log('--- Code Review Reading Phase ---');

    for (const student of students) {
        const searchDirs = [student.filesDir, student.extractedDir].filter(Boolean);

        const docxPath = findReviewDocx(searchDirs);
        if (!docxPath) {
            student.codeReview = { found: false, group: null, scores: [], items: [], productionCompleted: false };
            console.log(`  NO REVIEW: ${student.name}`);
            continue;
        }

        try {
            // Use convertToHtml to preserve table structure for column detection
            const htmlResult = await mammoth.convertToHtml({ path: docxPath });
            const html = htmlResult.value;

            // Also extract raw text for group letter parsing
            const textResult = await mammoth.extractRawText({ path: docxPath });
            const text = textResult.value;

            const group = parseGroupFromTable(html) || parseGroupLetter(text);
            const tableData = parseTableScores(html);

            student.codeReview = {
                found: true,
                docxPath,
                group,
                items: tableData ? tableData.items : [],
                productionCompleted: tableData ? tableData.productionCompleted : false,
                groupSource: group ? 'form' : 'none'
            };

            const groupStr = group || '?';
            const itemCount = tableData ? tableData.items.length : 0;
            const prodStatus = tableData ? (tableData.productionCompleted ? 'complete' : 'incomplete') : 'unknown';
            console.log(`  OK: ${student.name} — Group ${groupStr}, ${itemCount} items, production ${prodStatus}`);
        } catch (err) {
            student.codeReview = {
                found: true,
                docxPath,
                group: null,
                items: [],
                productionCompleted: false,
                parseError: err.message
            };
            console.log(`  PARSE ERROR: ${student.name} — ${err.message}`);
        }
    }

    // labDir is optional so existing direct callers/tests that only care about the
    // student-attachment side effect keep working unchanged.
    if (labDir) {
        writePhaseReport(labDir, CODE_REVIEW_REPORT, students, s => ({ student: s.name, ...(s.codeReview || {}) }));
    }
};
