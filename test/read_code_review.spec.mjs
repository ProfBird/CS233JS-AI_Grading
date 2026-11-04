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
    it('treats "-" / "NA" as filled but not affirmative (addressed, not interpretable)', () => {
        // Real data: prod cells are sometimes marked "-" or "NA" (not applicable). These
        // count as the student having addressed the cell, but aren't a yes/no/score.
        expect(parseCellValue('-')).toEqual({ score: null, filled: true, affirmative: null });
        expect(parseCellValue('NA')).toEqual({ score: null, filled: true, affirmative: null });
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

    it('counts "-"/"NA" prod cells as a completed production column', () => {
        const html = thTable(
            thRow('Criteria', 'Beta', 'Prod.'),
            thRow('q1', 'y', '-'),
            thRow('q2', 'n', 'NA'),
        );
        expect(parseTableScores(html).productionCompleted).toBe(true);
    });
});

describe('parseTableScores — productionCompleted across multiple score tables', () => {
    it('detects a filled prod column in a SECOND table even when the primary table prod is empty', () => {
        // Primary (densest) table: 5 beta y/n, prod all empty. Second table: prod filled.
        const primary = thTable(
            thRow('Criteria', 'Beta', 'Prod.'),
            ...['q1', 'q2', 'q3', 'q4', 'q5'].map(q => `<tr>${th(q)}${th('y')}<th></th></tr>`),
        );
        const second = thTable(
            thRow('Programming Style', 'Beta', 'Prod.'),
            thRow('s1', 'y', 'y'),
            thRow('s2', 'n', 'n'),
        );
        const result = parseTableScores(primary + second);
        expect(result.productionCompleted).toBe(true);
        // items come from EVERY Beta/Prod-headed table, in document order, so reviewRow can
        // find criteria in any of them.
        expect(result.items.map(i => i.label)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 's1', 's2']);
        expect(result.items.slice(0, 5).every(i => !i.prodFilled)).toBe(true);
        expect(result.items.slice(5).every(i => i.prodFilled)).toBe(true);
    });

    it('does not treat a metadata table date (6/5/2026) as a filled prod column', () => {
        const meta = '<table><tr><th>Date</th><th>6/5/2026</th></tr></table>';
        const scores = thTable(
            thRow('Criteria', 'Beta', 'Prod.'),
            `<tr>${th('q1')}${th('y')}<th></th></tr>`,
            `<tr>${th('q2')}${th('y')}<th></th></tr>`,
        );
        const result = parseTableScores(meta + scores);
        expect(result.productionCompleted).toBe(false);  // prod genuinely empty; the date is ignored
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

describe('parseTableScores — "Release" production header (CS212 forms)', () => {
    it('treats a "Release" column as the production column', () => {
        const html = thTable(
            thRow('Criteria', 'Beta', 'Release', ''),
            thRow('Is the app interactive?', 'yes', 'yes', ''),
            thRow('Do all of the features work?', 'no', 'yes', ''),
        );
        const result = parseTableScores(html);
        expect(result.productionCompleted).toBe(true);
        expect(result.items[1]).toMatchObject({ prodFilled: true, prodAffirmative: true });
    });

    it('labels each item with its criterion text (blank for spacer rows)', () => {
        const html = thTable(
            thRow('Criteria', 'Beta', 'Prod.'),
            thRow('Does it run without errors?', 'y', 'y'),
            `<tr>${th('')}${th('')}${th('')}</tr>`,   // "list errors" spacer row
            thRow('Is the app interactive?', 'y', 'n'),
        );
        const { items } = parseTableScores(html);
        expect(items.map(i => i.label)).toEqual(['Does it run without errors?', '', 'Is the app interactive?']);
    });
});

describe('parseGroupFromTable', () => {
    it('reads the lab version letter from the cell to the right (works with <th>)', () => {
        const html = thTable(thRow("Developer's lab version", 'B'));
        expect(parseGroupFromTable(html)).toBe('B');
    });
});

describe('parseGroupFromTable — CS212 layout (letter cell, then group-name cell)', () => {
    it('accepts a lone lowercase letter, and never reads the group-name cell', () => {
        expect(parseGroupFromTable(thTable(thRow("Developer's lab version (A, B, or C) and lab partner group name", 'b', 'Team Rocket')))).toBe('B');
        expect(parseGroupFromTable(thTable(thRow('lab version', '', 'Plan B')))).toBeNull();
        expect(parseGroupFromTable(thTable(thRow('lab version', 'C', 'A-Team')))).toBe('C');
    });

    it('does not take the article "a" in a sentence as group A', () => {
        expect(parseGroupFromTable(thTable(thRow('lab version', 'not sure, a mix')))).toBeNull();
    });
});
