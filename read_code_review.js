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

const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');

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
    const tableRe = /<table>([\s\S]*?)<\/table>/gi;
    let tableMatch;
    while ((tableMatch = tableRe.exec(html)) !== null) {
        const rows = [];
        const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRe.exec(tableMatch[1])) !== null) {
            const cells = [];
            const cellRe = /<td>([\s\S]*?)<\/td>/gi;
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

function parseScoreFromCell(text) {
    const match = text.match(/(\d+)\s*\/\s*\d+/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Check if a cell has any meaningful content (fraction, Y, N, Yes, No).
 */
function isCellFilled(text) {
    if (!text || !text.trim()) return false;
    if (/\d+\s*\/\s*\d+/.test(text)) return true;
    if (/^(y|yes|n|no)$/i.test(text.trim())) return true;
    return false;
}

/**
 * Parse a table cell to extract score and yes/no semantics.
 * Returns { score, filled, affirmative } where:
 *   - score: numeric score from fraction, or null
 *   - filled: true if cell has meaningful content
 *   - affirmative: true for fraction/Y/Yes, false for N/No, null if empty
 */
function parseCellValue(text) {
    if (!text || !text.trim()) return { score: null, filled: false, affirmative: null };
    const fractionMatch = text.match(/(\d+)\s*\/\s*\d+/);
    if (fractionMatch) return { score: parseInt(fractionMatch[1], 10), filled: true, affirmative: true };
    if (/^(y|yes)$/i.test(text.trim())) return { score: null, filled: true, affirmative: true };
    if (/^(n|no)$/i.test(text.trim())) return { score: null, filled: true, affirmative: false };
    return { score: null, filled: false, affirmative: null };
}

/**
 * Parse all HTML tables and return the one most likely to contain review scores
 * (has the most cells with fractions or Y/N values).
 */
function findScoresTable(html) {
    const tableRe = /<table>([\s\S]*?)<\/table>/gi;
    let bestTable = null;
    let bestScore = 0;

    let tableMatch;
    while ((tableMatch = tableRe.exec(html)) !== null) {
        let cellCount = 0;
        const cellRe = /<td>([\s\S]*?)<\/td>/gi;
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

/**
 * Parse the HTML scores table to extract per-item beta and production scores.
 * Returns null if no suitable table is found.
 */
function parseTableScores(html) {
    const tableHtml = findScoresTable(html);
    if (!tableHtml) return null;

    // Extract rows
    const rows = [];
    const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
        const cells = [];
        const cellRe = /<td>([\s\S]*?)<\/td>/gi;
        let cellMatch;
        while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
            const text = cellMatch[1].replace(/<[^>]+>/g, '').trim();
            cells.push(text);
        }
        if (cells.length > 0) rows.push(cells);
    }

    if (rows.length < 2) return null;

    // Identify beta and production columns from header
    const header = rows[0];
    let betaCol = -1;
    let prodCol = -1;

    for (let i = 0; i < header.length; i++) {
        const h = header[i].toLowerCase();
        if (h.includes('beta')) betaCol = i;
        if (h.includes('prod')) prodCol = i;
    }

    // If headers aren't identifiable, assume last two columns are beta, prod
    if (betaCol === -1 && prodCol === -1 && header.length >= 2) {
        betaCol = header.length - 2;
        prodCol = header.length - 1;
    }

    const items = [];
    let allProdFilled = true;

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const betaScore = betaCol >= 0 && betaCol < row.length
            ? parseScoreFromCell(row[betaCol])
            : null;
        const prodCell = prodCol >= 0 && prodCol < row.length
            ? parseCellValue(row[prodCol])
            : { score: null, filled: false, affirmative: null };

        // Only consider this row "active" if the beta column has content.
        // Rows with no beta score are for options the student isn't doing,
        // so an empty production cell there is expected and shouldn't count
        // against productionCompleted.
        const betaFilled = betaCol >= 0 && betaCol < row.length
            ? isCellFilled(row[betaCol])
            : false;

        if (betaFilled && !prodCell.filled) {
            allProdFilled = false;
        }

        items.push({
            betaScore,
            prodScore: prodCell.score,
            prodFilled: prodCell.filled,
            prodAffirmative: prodCell.affirmative
        });
    }

    return {
        items,
        productionCompleted: allProdFilled && items.length > 0
    };
}

// Legacy: parse flat scores list (used as fallback)
function parseScores(text) {
    const scores = [];
    const fractionRe = /(\d+)\s*\/\s*\d+/g;
    let m;
    while ((m = fractionRe.exec(text)) !== null) {
        scores.push(parseInt(m[1], 10));
    }
    return scores;
}

// --- Main export ---

module.exports = async function (students, config) {
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
            const scores = parseScores(text);

            const tableData = parseTableScores(html);

            student.codeReview = {
                found: true,
                docxPath,
                group,
                scores,
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
                scores: [],
                items: [],
                productionCompleted: false,
                parseError: err.message
            };
            console.log(`  PARSE ERROR: ${student.name} — ${err.message}`);
        }
    }
};
