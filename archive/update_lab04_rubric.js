#!/usr/bin/env node
/**
 * update_lab04_rubric.js
 *
 * Updates CS233JS_Lab04_Rubric.xlsm (which was copied from the Lab03 rubric)
 * so that it reflects Lab04 requirements.
 *
 * Lab04 point design (total = 40):
 *
 * --- Rubric sheet ---
 * Row  4: Code review, prod column       2
 * Row  6: section header
 * Row  7: Developer's name, date         1
 * Row  8: App functionality (add/view/delete) 8
 * Row  9: Three JS modules w/ import/export  4
 * Row 10: lit-html used for rendering    4
 * Row 11: localStorage persistence       3
 * Row 12: Vite build, dist/ on citstudent 3
 * Row 13: No run-time (console) errors   1
 * Row 14: Screenshots submitted          2
 * Row 15: Style and best practices       2
 * Row 16: Sub-total                      SUM(B7:B15) = 28
 * Row 18: Total:                         B4+B16 = 30  ← wait, 2+28=30, not 40
 *
 * Hmm — in the Lab03 Rubric sheet the "Code review" row is separate from the
 * sub-totals, and the Grand Total sums it all. Let me check: Lab03 Rubric total
 * = B4(2) + B11(12) + B19(16) + B27(20) = 50. So the Rubric sheet and Grade
 * sheet had different totals (Rubric=50, Grade=40). That inconsistency was noted.
 *
 * For Lab04 I'll make them match at 40.
 *
 * Rubric sheet total:
 *   Code review: 2
 *   App section: name/date(1)+functionality(8)+modules(4)+lit-html(4)+
 *                localStorage(3)+vite/citstudent(3)+no-errors(1)+screenshots(2)+style(2) = 28
 *   GitHub: 10
 *   Total: 2+28+10 = 40 ✓
 *
 * Grade sheet total:
 *   App section (rows 7-17): 28
 *   General section (rows 19-22): GitHub(10)+code review(2) = 12
 *   Total: 28+12 = 40 ✓
 */

'use strict';

import XLSX from '../lib/xlsx.js';
import path from 'path';

const filePath = path.resolve(import.meta.dirname, '../Lab04/CS233JS_Lab04_Rubric.xlsm');

const wb = XLSX.readFile(filePath, { bookVBA: true, cellStyles: true });

// ── Cell helpers ─────────────────────────────────────────────────────────────

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStr(ws, addr, value) {
  const esc = xmlEscape(value);
  ws[addr] = { t: 's', v: value, r: `<t>${esc}</t>`, h: esc, w: value };
}

function setNum(ws, addr, value) {
  ws[addr] = { t: 'n', v: value, w: String(value) };
}

function setFormula(ws, addr, formula, computedValue) {
  ws[addr] = { t: 'n', v: computedValue, f: formula, w: String(computedValue) };
}

function clearCells(ws, addrs) {
  addrs.forEach(a => delete ws[a]);
}

// ════════════════════════════════════════════════════════════════════════════
// RUBRIC sheet
//
// Layout (Lab04):
//   A1    Title
//   A3:B3 Headers: Requirements | Possible
//   A4:B4 Code review, prod column | 2
//   A6    Section header
//   A7:B7 Developer's name, date in each file | 1
//   A8:B8 App functionality: add, view, and delete items | 8
//   A9:B9 Three JS modules with import/export | 4
//  A10:B10 lit-html used for rendering | 4
//  A11:B11 localStorage persistence (survives page refresh) | 3
//  A12:B12 Vite build, dist/ uploaded to citstudent | 3
//  A13:B13 No run-time (console) errors | 1
//  A14:B14 Screenshots submitted (dev server, citstudent) | 2
//  A15:B15 Style and best practices | 2
//  A16:B16 Sub-total | SUM(B7:B15)=28
//  A18    In a GitHub repository | 10
//  A19:B19 Total: | B4+B16+B18=40
//
// Wait — this splits "GitHub" as a standalone item rather than a section.
// Simpler: put GitHub in the app sub-section (it's a submission requirement).
// Then: Total = B4 (code review=2) + B16 (sub-total=28) + B18 (github=10) = 40.
// Or: fold GitHub into the app sub-section and adjust sub-total.
//
// Cleanest: keep the same 2-level pattern as Lab03:
//   top-level non-sectioned items: code review (row 4)
//   one app section: rows 6-16  sub-total = 28
//   general: GitHub (row 18)    = 10
//   total row 20 = B4+B16+B18 = 40
//
// ════════════════════════════════════════════════════════════════════════════
{
  const ws = wb.Sheets['Rubric'];

  // Title
  setStr(ws, 'A1', 'Lab 4: Node.js Dev Tools and JavaScript Web Apps');

  // Row 3 headers already correct (Requirements | Possible)

  // Row 4: Code review stays as-is (value=2)
  // A4 and B4 already correct.

  // Clear all old Lab03 app section rows
  clearCells(ws, [
    'A6','B6',
    'A7','B7','A8','B8','A9','B9','A10','B10','A11','B11',
    'A13','B13','A14','B14','A15','B15','A16','B16','A17','B17','A18','B18','A19','B19',
    'A21','B21','A22','B22','A23','B23','A24','B24','A25','B25','A26','B26','A27','B27',
    'A29','B29',
  ]);

  // Row 6: app section header
  setStr(ws, 'A6', 'Your Web App (Bookmarker, Expense Tracker, or Grocery List)');

  // Row 7
  setStr(ws, 'A7', "Developer's name, date in each file");
  setNum(ws,  'B7', 1);

  // Row 8
  setStr(ws, 'A8', 'App functionality: add, view, and delete items');
  setNum(ws,  'B8', 8);

  // Row 9
  setStr(ws, 'A9', 'Three JS modules with import/export statements');
  setNum(ws,  'B9', 4);

  // Row 10
  setStr(ws, 'A10', 'lit-html used for rendering');
  setNum(ws,  'B10', 4);

  // Row 11
  setStr(ws, 'A11', 'localStorage persistence (survives page refresh)');
  setNum(ws,  'B11', 3);

  // Row 12
  setStr(ws, 'A12', 'Vite build, dist/ uploaded to citstudent');
  setNum(ws,  'B12', 3);

  // Row 13
  setStr(ws, 'A13', 'No run-time (console) errors');
  setNum(ws,  'B13', 1);

  // Row 14
  setStr(ws, 'A14', 'Screenshots submitted (dev server, citstudent)');
  setNum(ws,  'B14', 2);

  // Row 15
  setStr(ws, 'A15', 'Style and best practices');
  setNum(ws,  'B15', 2);

  // Row 16: Sub-total = 1+8+4+4+3+3+1+2+2 = 28
  setStr(ws, 'A16', 'Sub-total');
  setFormula(ws, 'B16', 'SUM(B7:B15)', 28);

  // Row 18: General — GitHub
  setStr(ws, 'A18', 'App in a GitHub repository');
  setNum(ws,  'B18', 10);

  // Row 19: Total = 2+28+10 = 40
  setStr(ws, 'A19', 'Total:');
  setFormula(ws, 'B19', 'B4+B16+B18', 40);

  ws['!ref'] = 'A1:D19';
}

// ════════════════════════════════════════════════════════════════════════════
// GRADE sheet
//
// Layout (Lab04):
//   A1    Title
//   A2    Canned comment (keep)
//   A4    "Here's the grade breakdown:" (keep)
//   A5:F5 Headers: Requirements | Possible | Actual | | Comments (keep)
//
//   A7    Section: "Your Web App"
//   A8:F8  Developer's name, date in each file  | 1
//   A9:F9  App functionality: add, view, delete  | 8
//  A10:F10  Three JS modules w/ import/export    | 4
//  A11:F11  lit-html used for rendering          | 4
//  A12:F12  localStorage persistence             | 3
//  A13:F13  Vite build, dist/ on citstudent      | 3
//  A14:F14  No run-time (console) errors         | 1
//  A15:F15  Screenshots submitted                | 2
//  A16:F16  Style and best practices             | 2
//  A17:F17  Sub-total                            | SUM(B8:B16)=28
//
//  A19    Section: "General"
//  A20:F20  App in a GitHub repository           | 10
//  A21:F21  Code review, prod column             | 2
//  A22:F22  Sub-total                            | SUM(B20:B21)=12
//
//  A24:F24  Total:                               | B17+B22=40
//
//  A31:A36  Comments boilerplate (keep as-is)
//
// ════════════════════════════════════════════════════════════════════════════
{
  const ws = wb.Sheets['Grade'];

  // Title
  setStr(ws, 'A1', 'Lab 4: Node.js Dev Tools and JavaScript Web Apps');

  // Clear all old lab-specific rows
  clearCells(ws, [
    // Part 1 rows
    'A7','E7','F7',
    'A8','B8','C8','E8','F8',
    'A9','B9','C9','E9','F9',
    'A10','B10','C10','E10','F10',
    'A11','B11','C11','E11','F11',
    'A12','B12','C12',
    // Part 2 rows
    'A14','E14','F14',
    'A15','B15','C15','E15','F15',
    'A16','B16','C16','E16','F16',
    'A17','B17','C17','E17','F17',
    'A18','B18','C18','E18','F18',
    'A19','B19','C19','E19','F19',
    'A20','B20','C20',
    // General rows (old positions)
    'A22',
    'A23','B23','C23','E23','F23',
    'A24','B24','C24','E24','F24',
    'A25','B25','C25','E25','F25',
    'A26','B26','C26',
    'A28','B28','C28',
  ]);

  // Remove merges for old E7:F7 and E14:F14; keep merges for rows 2,3,4
  ws['!merges'] = [
    { s: { c: 0, r: 1 }, e: { c: 4, r: 1 } },  // A2:E2
    { s: { c: 0, r: 2 }, e: { c: 4, r: 2 } },  // A3:E3
    { s: { c: 0, r: 3 }, e: { c: 4, r: 3 } },  // A4:E4
  ];

  // Row 7: App section header
  setStr(ws, 'A7', 'Your Web App');

  // Row 8
  setStr(ws, 'A8', "Developer's name, date in each file");
  setNum(ws, 'B8', 1);  setNum(ws, 'C8', 1);
  setStr(ws, 'E8', 'Yes');  setStr(ws, 'F8', 'Yes');

  // Row 9
  setStr(ws, 'A9', 'App functionality: add, view, and delete items');
  setNum(ws, 'B9', 8);  setNum(ws, 'C9', 8);
  setStr(ws, 'E9', 'Yes');  setStr(ws, 'F9', 'Yes');

  // Row 10
  setStr(ws, 'A10', 'Three JS modules with import/export statements');
  setNum(ws, 'B10', 4);  setNum(ws, 'C10', 4);
  setStr(ws, 'E10', 'Yes');  setStr(ws, 'F10', 'Yes');

  // Row 11
  setStr(ws, 'A11', 'lit-html used for rendering');
  setNum(ws, 'B11', 4);  setNum(ws, 'C11', 4);
  setStr(ws, 'E11', 'Yes');  setStr(ws, 'F11', 'Yes');

  // Row 12
  setStr(ws, 'A12', 'localStorage persistence (survives page refresh)');
  setNum(ws, 'B12', 3);  setNum(ws, 'C12', 3);
  setStr(ws, 'E12', 'Yes');  setStr(ws, 'F12', 'Yes');

  // Row 13
  setStr(ws, 'A13', 'Vite build, dist/ uploaded to citstudent');
  setNum(ws, 'B13', 3);  setNum(ws, 'C13', 3);
  setStr(ws, 'E13', 'Yes');  setStr(ws, 'F13', 'Yes');

  // Row 14
  setStr(ws, 'A14', 'No run-time (console) errors');
  setNum(ws, 'B14', 1);  setNum(ws, 'C14', 1);
  setStr(ws, 'E14', 'Correct');  setStr(ws, 'F14', 'Correct');

  // Row 15
  setStr(ws, 'A15', 'Screenshots submitted (dev server, citstudent)');
  setNum(ws, 'B15', 2);  setNum(ws, 'C15', 2);
  setStr(ws, 'E15', 'Yes');  setStr(ws, 'F15', 'Yes');

  // Row 16
  setStr(ws, 'A16', 'Style and best practices');
  setNum(ws, 'B16', 2);  setNum(ws, 'C16', 2);
  setStr(ws, 'E16', 'Good');  setStr(ws, 'F16', 'Good');

  // Row 17: Sub-total = 1+8+4+4+3+3+1+2+2 = 28
  setStr(ws, 'A17', 'Sub-total');
  setFormula(ws, 'B17', 'SUM(B8:B16)', 28);
  setFormula(ws, 'C17', 'SUM(C8:C16)', 28);

  // Row 19: General section header
  setStr(ws, 'A19', 'General');

  // Row 20: GitHub
  setStr(ws, 'A20', 'App in a GitHub repository');
  setNum(ws, 'B20', 10);  setNum(ws, 'C20', 10);
  setStr(ws, 'E20', 'Yes');  setStr(ws, 'F20', 'Yes');

  // Row 21: Code review
  setStr(ws, 'A21', 'Code review, prod column');
  setNum(ws, 'B21', 2);  setNum(ws, 'C21', 2);
  setStr(ws, 'E21', 'Yes and yes');  setStr(ws, 'F21', 'Yes and yes');

  // Row 22: Sub-total = 10+2 = 12
  setStr(ws, 'A22', 'Sub-total');
  setFormula(ws, 'B22', 'SUM(B20:B21)', 12);
  setFormula(ws, 'C22', 'SUM(C20:C21)', 12);

  // Row 24: Total = 28+12 = 40
  setStr(ws, 'A24', 'Total:');
  setFormula(ws, 'B24', 'B17+B22', 40);
  setFormula(ws, 'C24', 'C17+C22', 40);

  // Rows 35-40 (Comments boilerplate) stay as-is.

  ws['!ref'] = 'A1:F40';
}

// ════════════════════════════════════════════════════════════════════════════
// Write
// ════════════════════════════════════════════════════════════════════════════
XLSX.writeFile(wb, filePath, { bookVBA: true, cellStyles: true });
console.log('Done. Written to:', filePath);

// Verify by re-reading
const wb2 = XLSX.readFile(filePath, { bookVBA: true });
const rubric = wb2.Sheets['Rubric'];
const grade  = wb2.Sheets['Grade'];

console.log('\n=== Rubric sheet ===');
const rData = XLSX.utils.sheet_to_json(rubric, { header: 1, defval: '' });
rData.forEach((row, i) => {
  if (row.some(c => c !== '')) console.log(`  Row ${i+1}: ${JSON.stringify(row)}`);
});

console.log('\n=== Grade sheet ===');
const gData = XLSX.utils.sheet_to_json(grade, { header: 1, defval: '' });
gData.forEach((row, i) => {
  if (row.some(c => c !== '')) console.log(`  Row ${i+1}: ${JSON.stringify(row)}`);
});
