/**
 * read_code_review.spec.mjs
 *
 * Regression tests for the code-review .docx HTML-table parser. The key case:
 * mammoth emits review-form cells as <th> (inside <thead>) when Word marked the
 * cells as header cells — not <td>. The parser must read both, or it sees zero
 * cells and falsely reports the production column as not filled out (the bug that
 * misgraded e.g. Joseph Sutton's TermProject Production review).
 */
import { describe, it, expect } from 'vitest';

const { parseCellValue, parseGroupFromTable, parseTableScores } =
    await import('../src/pipeline/read_code_review.js');

// Mirrors mammoth's real output for these forms: <thead> + <th> + <p> wrappers.
const th = (inner) => `<th><p>${inner}</p></th>`;
const thRow = (...cells) => `<tr>${cells.map(th).join('')}</tr>`;
const thTable = (...rows) => `<table><thead>${rows.join('')}</thead></table>`;

describe('parseCellValue', () => {
    it('reads a fraction as filled + affirmative with a score', () => {
        expect(parseCellValue('3/5')).toEqual({ score: 3, filled: true, affirmative: true });
    });
    it('reads y / n', () => {
        expect(parseCellValue('y')).toEqual({ score: null, filled: true, affirmative: true });
        expect(parseCellValue('n')).toEqual({ score: null, filled: true, affirmative: false });
    });
    it('treats blank as not filled', () => {
        expect(parseCellValue('')).toEqual({ score: null, filled: false, affirmative: null });
    });
});

describe('parseTableScores — <th> cells (the mammoth reality)', () => {
    it('detects a filled production column in a <th>/<thead> table', () => {
        const html = thTable(
            thRow('Criteria', 'Beta', 'Prod.'),
            thRow('Is the code in a repo?', 'y', 'y'),
            thRow('Bootstrap used?', 'n', 'n'),
        );
        const result = parseTableScores(html);
        expect(result).not.toBeNull();
        expect(result.productionCompleted).toBe(true);
        expect(result.items).toHaveLength(2);
        expect(result.items.every(i => i.prodFilled)).toBe(true);
    });

    it('reports productionCompleted=false when the prod column is empty', () => {
        const html = thTable(
            thRow('Criteria', 'Beta', 'Prod.'),
            `<tr>${th('Is the code in a repo?')}${th('y')}<th></th></tr>`,
            `<tr>${th('Bootstrap used?')}${th('n')}<th></th></tr>`,
        );
        const result = parseTableScores(html);
        expect(result.productionCompleted).toBe(false);
    });

    it('tolerates attributes on the cell/row/table tags', () => {
        const html =
            '<table class="x"><thead>' +
            '<tr><th colspan="1">Criteria</th><th>Beta</th><th>Prod.</th></tr>' +
            '<tr><th>Q1</th><th>y</th><th>y</th></tr>' +
            '</thead></table>';
        expect(parseTableScores(html).productionCompleted).toBe(true);
    });
});

describe('parseTableScores — <td> cells (still supported)', () => {
    it('detects a filled production column in a plain <td> table', () => {
        const html =
            '<table><tr><td>Criteria</td><td>Beta</td><td>Prod.</td></tr>' +
            '<tr><td>Q1</td><td>y</td><td>3/5</td></tr></table>';
        const result = parseTableScores(html);
        expect(result.productionCompleted).toBe(true);
        expect(result.items[0].prodScore).toBe(3);
    });
});

describe('parseGroupFromTable', () => {
    it('reads the lab version letter from the cell to the right (works with <th>)', () => {
        const html = thTable(thRow("Developer's lab version", 'B'));
        expect(parseGroupFromTable(html)).toBe('B');
    });
});
