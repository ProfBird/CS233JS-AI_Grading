/**
 * rubric_writer.spec.mjs
 *
 * The spreadsheet output plumbing behind every graded .xlsm: a student's file must keep the
 * template's buttons (drawings + form controls), its VBA project and the sheets that project
 * refers to, and its column widths — none of which the xlsx library carries over by itself.
 * Uses a real shipped rubric (CS233JS Lab04: a "Rubric" sheet, then a "Grade" sheet with
 * two buttons).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';
import xlsx from '../src/lib/xlsx.js';
import {
    readTemplateColumns, openRubricTemplate, writeGradeWorkbook, readGradeCell,
    stripToGradeSheet, forceRecalc, parseColsXml,
} from '../src/lib/rubric_writer.js';

const TEMPLATE = join(import.meta.dirname, '..', 'configs', 'CS233JS', 'Lab04', 'CS233JS_Lab04_Rubric.xlsm');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rubric-writer-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Grades the template the way generate_grades.js does and returns the output path.
function gradeTemplate(name, { isXlsm = true, value = 'Ana Lopez' } = {}) {
    const outputPath = join(dir, name);
    const { wb, sheet } = openRubricTemplate(TEMPLATE);
    sheet.B1 = { t: 's', v: value };
    writeGradeWorkbook(wb, sheet, { templateCols: readTemplateColumns(TEMPLATE), rubricPath: TEMPLATE, outputPath, isXlsm });
    return outputPath;
}

describe('writeGradeWorkbook — .xlsm output', () => {
    it('writes the graded value and keeps the Grade sheet first and visible', () => {
        const out = gradeTemplate('S_Grade.xlsm');
        expect(readGradeCell(out, 'B1')).toBe('Ana Lopez');
        const wbXml = new AdmZip(out).readAsText('xl/workbook.xml');
        const sheets = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)].map(m => m[0]);
        expect(sheets[0]).toMatch(/name="Grade"/);
        expect(sheets[0]).not.toMatch(/state=/);
    });

    it("restores the template's buttons: drawings, form controls, the sheet's rels and content types", () => {
        const zip = new AdmZip(gradeTemplate('S_Grade.xlsm'));
        for (const f of ['xl/drawings/drawing1.xml', 'xl/drawings/vmlDrawing1.vml', 'xl/ctrlProps/ctrlProp1.xml', 'xl/ctrlProps/ctrlProp2.xml']) {
            expect(zip.getEntry(f), f).toBeTruthy();
        }
        const rels = zip.readAsText('xl/worksheets/_rels/sheet1.xml.rels');
        expect(rels).toMatch(/drawing1\.xml/);
        const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
        expect(sheet).toMatch(/<(?:drawing|legacyDrawing)\b/);
        // every prefix the injected controls use is declared on <worksheet>
        for (const prefix of new Set([...sheet.matchAll(/<(\w+):/g)].map(m => m[1]))) {
            expect(sheet, `xmlns:${prefix}`).toMatch(new RegExp(`xmlns:${prefix}=`));
        }
        const ct = zip.readAsText('[Content_Types].xml');
        expect(ct).toMatch(/PartName="\/xl\/drawings\/drawing1\.xml"/);
        expect(ct).toMatch(/PartName="\/xl\/ctrlProps\/ctrlProp1\.xml"/);
        expect(ct).toMatch(/Extension="vml"/);
    });

    it('keeps the VBA project and re-adds the other sheets as veryHidden, with their code names', () => {
        const zip = new AdmZip(gradeTemplate('S_Grade.xlsm'));
        expect(zip.getEntry('xl/vbaProject.bin')).toBeTruthy();
        const wbXml = zip.readAsText('xl/workbook.xml');
        const rubric = wbXml.match(/<sheet\b[^>]*name="Rubric"[^>]*\/>/);
        expect(rubric && rubric[0]).toMatch(/state="veryHidden"/);
        const rId = rubric[0].match(/r:id="([^"]+)"/)[1];
        const target = zip.readAsText('xl/_rels/workbook.xml.rels').match(new RegExp(`Id="${rId}"[^>]*Target="([^"]+)"`))[1];
        const hidden = zip.readAsText(`xl/${target}`);
        expect(hidden).toMatch(/codeName="Sheet1"/);
        expect(hidden).toMatch(/<sheetData\/>/);    // empty: no stale shared-string references
        expect(zip.readAsText('[Content_Types].xml')).toContain(`PartName="/xl/${target}"`);
        // no duplicate sheetIds or relationship ids
        const ids = [...wbXml.matchAll(/sheetId="(\d+)"/g)].map(m => m[1]);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("applies the template's column widths", () => {
        const cols = readTemplateColumns(TEMPLATE);
        expect(cols && cols.some(c => c && c.wch > 0)).toBe(true);
        const sheet = new AdmZip(gradeTemplate('S_Grade.xlsm')).readAsText('xl/worksheets/sheet1.xml');
        expect(sheet).toMatch(/<cols>[\s\S]*<col\b[^>]*width=/);
    });
});

describe('writeGradeWorkbook — .xlsx output', () => {
    it('writes just the Grade sheet, with no VBA or drawings', () => {
        const out = gradeTemplate('S_Grade.xlsx', { isXlsm: false });
        expect(readGradeCell(out, 'B1')).toBe('Ana Lopez');
        expect(xlsx.readFile(out).SheetNames).toEqual(['Grade']);
        const zip = new AdmZip(out);
        expect(zip.getEntry('xl/vbaProject.bin')).toBeFalsy();
        expect(zip.getEntries().some(e => e.entryName.startsWith('xl/drawings/'))).toBe(false);
    });
});

describe('workbook helpers', () => {
    it('stripToGradeSheet keeps only the Grade sheet and makes it the active tab', () => {
        const grade = { A1: { t: 's', v: 'x' } };
        const wb = {
            SheetNames: ['Rubric', 'Grade'], Sheets: { Rubric: {}, Grade: grade },
            Workbook: { Sheets: [{ name: 'Rubric' }, { name: 'Grade', CodeName: 'Sheet2' }], WBView: [{ activeTab: 1 }] },
        };
        stripToGradeSheet(wb, grade);
        expect(wb.SheetNames).toEqual(['Grade']);
        expect(wb.Sheets).toEqual({ Grade: grade });
        expect(wb.Workbook.Sheets).toEqual([{ name: 'Grade', CodeName: 'Sheet2' }]);
        expect(wb.Workbook.WBView[0].activeTab).toBe(0);
    });

    it("forceRecalc drops formulas' cached numbers (Excel recomputes totals) and leaves other cells alone", () => {
        const sheet = { '!ref': 'A1:A3', A1: { f: 'SUM(B1:B2)', v: 7, t: 'n' }, A2: { v: 3, t: 'n' }, A3: { f: 'B1&""', v: 'x', t: 's' } };
        forceRecalc(sheet);
        expect(sheet.A1).toEqual({ f: 'SUM(B1:B2)', t: 'n' });
        expect(sheet.A2.v).toBe(3);
        expect(sheet.A3.v).toBe('x');
    });

    it('parseColsXml expands column ranges, widths and hidden columns', () => {
        expect(parseColsXml('<cols><col min="1" max="2" width="12.5"/><col min="4" max="4" width="0" hidden="1"/></cols>'))
            .toEqual([{ wch: 12.5 }, { wch: 12.5 }, null, { hidden: true }]);
        expect(parseColsXml(undefined)).toBeUndefined();
        expect(parseColsXml('<cols></cols>')).toBeUndefined();
    });

    it('readGradeCell returns null for a missing file or an empty cell', () => {
        const out = gradeTemplate('S_Grade.xlsx', { isXlsm: false });
        expect(readGradeCell(out, 'Z999')).toBeNull();
        expect(readGradeCell(join(dir, 'nope.xlsx'), 'A1')).toBeNull();
    });
});
