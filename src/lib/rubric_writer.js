/**
 * rubric_writer.js
 *
 * Low-level spreadsheet output plumbing for the grading pipeline. Isolates the
 * OOXML / ZIP surgery (column-width recovery, drawing/button preservation,
 * reducing the workbook to the Grade sheet) from the grading logic in
 * generate_grades.js, which only needs the three high-level helpers at the
 * bottom: readTemplateColumns(), openRubricTemplate(), writeGradeWorkbook().
 */

import fs from 'fs';
import zlib from 'zlib';
import xlsx from './xlsx.js';
import AdmZip from 'adm-zip';

// --- Workbook helpers ---

function stripToGradeSheet(wb, sheet) {
    wb.SheetNames = ['Grade'];
    wb.Sheets = { 'Grade': sheet };
    if (wb.Workbook && wb.Workbook.Sheets) {
        const entry = wb.Workbook.Sheets.find(s => s.name === 'Grade');
        wb.Workbook.Sheets = entry ? [entry] : [];
    }
    if (wb.Workbook && wb.Workbook.WBView) {
        wb.Workbook.WBView.forEach(v => { v.activeTab = 0; });
    }
}

function forceRecalc(sheet) {
    for (const ref of Object.keys(sheet)) {
        if (ref[0] === '!') continue;
        const cell = sheet[ref];
        if (cell.f && typeof cell.v === 'number') {
            delete cell.v;
        }
    }
}

// --- Column width helpers ---
// xlsx community edition does not parse <cols> from xlsm files into !cols.
// These helpers read the column widths directly from the ZIP XML and apply them.

function readSheetColsXml(filePath, sheetIndex) {
    const target = `xl/worksheets/sheet${sheetIndex + 1}.xml`;
    let buf;
    try { buf = fs.readFileSync(filePath); } catch (e) { return undefined; }
    let pos = 0;
    while (pos < buf.length - 30) {
        if (buf[pos] !== 0x50 || buf[pos+1] !== 0x4B || buf[pos+2] !== 0x03 || buf[pos+3] !== 0x04) {
            pos++; continue;
        }
        const compression = buf.readUInt16LE(pos + 8);
        const compressedSize = buf.readUInt32LE(pos + 18);
        const fileNameLen = buf.readUInt16LE(pos + 26);
        const extraLen = buf.readUInt16LE(pos + 28);
        const fileName = buf.slice(pos + 30, pos + 30 + fileNameLen).toString();
        const dataStart = pos + 30 + fileNameLen + extraLen;
        if (fileName === target) {
            try {
                const data = buf.slice(dataStart, dataStart + compressedSize);
                const xml = (compression === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
                const m = xml.match(/<cols[\s\S]*?<\/cols>/);
                return m ? m[0] : undefined;
            } catch (e) { return undefined; }
        }
        pos = compressedSize > 0 ? dataStart + compressedSize : dataStart + 1;
    }
    return undefined;
}

function parseColsXml(colsXml) {
    if (!colsXml) return undefined;
    const cols = [];
    const re = /<col\s([^/]*?)\/>/g;
    let m;
    while ((m = re.exec(colsXml)) !== null) {
        const attrs = m[1];
        const min = parseInt(attrs.match(/\bmin="(\d+)"/)?.[1] || '1') - 1;
        const max = parseInt(attrs.match(/\bmax="(\d+)"/)?.[1] || (min + 1)) - 1;
        const width = parseFloat(attrs.match(/\bwidth="([^"]+)"/)?.[1] || '0');
        const hidden = /\bhidden="1"/.test(attrs);
        for (let i = min; i <= max; i++) {
            while (cols.length <= i) cols.push(null);
            cols[i] = width > 0 ? { wch: width } : {};
            if (hidden) cols[i].hidden = true;
        }
    }
    return cols.length > 0 ? cols : undefined;
}

// --- Drawing/button preservation ---
//
// The xlsx library strips drawing objects (buttons, shapes) when re-writing a sheet.
// This function copies the drawing-related ZIP entries from the template into the
// output file after xlsx has written it, and patches the sheet XML and rels so Excel
// can find and display the buttons again.

function preserveTemplateDrawings(templatePath, outputPath) {
    if (!AdmZip) return;
    let tmpl, out;
    try { tmpl = new AdmZip(templatePath); out = new AdmZip(outputPath); } catch (e) { return; }

    // Find Grade sheet index in template (0-based)
    const wbXml = tmpl.readAsText('xl/workbook.xml');
    let gradeIdx = -1, si = 0;
    for (const m of wbXml.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*\/>/g)) {
        if (m[1] === 'Grade') { gradeIdx = si; break; }
        si++;
    }
    if (gradeIdx < 0) return;

    // Read Grade sheet's rels — if there are none, there are no buttons to restore
    const tmplRelsPath = `xl/worksheets/_rels/sheet${gradeIdx + 1}.xml.rels`;
    if (!tmpl.getEntry(tmplRelsPath)) return;
    const relsXml = tmpl.readAsText(tmplRelsPath);

    // Collect files referenced in rels that xlsx doesn't carry over
    const DRAW_TYPES = new Set(['drawing', 'vmlDrawing', 'ctrlProp', 'printerSettings']);
    const filesToCopy = [];
    for (const m of relsXml.matchAll(/<Relationship\b[^>]*Type="([^"]*)"[^>]*Target="([^"]*)"[^>]*\/>/g)) {
        if (DRAW_TYPES.has(m[1].split('/').pop())) {
            const resolved = m[2].startsWith('../') ? 'xl/' + m[2].slice(3) : 'xl/worksheets/' + m[2];
            filesToCopy.push(resolved);
        }
    }
    if (filesToCopy.length === 0) return;

    // Copy those files verbatim from template into output
    for (const f of filesToCopy) {
        const entry = tmpl.getEntry(f);
        if (!entry) continue;
        if (out.getEntry(f)) out.deleteFile(f);
        out.addFile(f, entry.getData());
    }

    // Replace the Grade sheet rels (Grade is always sheet1 after stripToGradeSheet)
    const outRelsPath = 'xl/worksheets/_rels/sheet1.xml.rels';
    if (out.getEntry(outRelsPath)) out.deleteFile(outRelsPath);
    out.addFile(outRelsPath, Buffer.from(relsXml));

    // Patch the output sheet XML:
    // 1. Merge any namespace declarations xlsx omitted (e.g. xmlns:xdr, xmlns:x14)
    // 2. Inject the drawing/control elements that xlsx stripped
    const tmplSheet = tmpl.readAsText(`xl/worksheets/sheet${gradeIdx + 1}.xml`);
    const outSheetRaw = out.readAsText('xl/worksheets/sheet1.xml');

    // Collect namespaces from both sheets and add any that are missing in the output
    const getNs = xml => {
        const ns = {};
        for (const m of xml.matchAll(/xmlns(?::(\w+))?="([^"]*)"/g)) ns[m[1] || ''] = m[2];
        return ns;
    };
    const missing = Object.entries(getNs(tmplSheet))
        .filter(([k]) => !(k in getNs(outSheetRaw)))
        .map(([k, v]) => (k ? `xmlns:${k}` : 'xmlns') + `="${v}"`)
        .join(' ');
    let outSheet = missing
        ? outSheetRaw.replace(/(<worksheet\b)/, `$1 ${missing}`)
        : outSheetRaw;

    // Grab everything from the first <drawing or <legacyDrawing to just before </worksheet>
    const drawStart = tmplSheet.search(/<(?:drawing|legacyDrawing)\b/);
    if (drawStart >= 0) {
        const injection = tmplSheet.slice(drawStart, tmplSheet.lastIndexOf('</worksheet>'));
        outSheet = outSheet.replace('</worksheet>', injection + '</worksheet>');
    }

    out.deleteFile('xl/worksheets/sheet1.xml');
    out.addFile('xl/worksheets/sheet1.xml', Buffer.from(outSheet));

    // Re-add non-Grade sheets from the template as veryHidden.
    // The VBA project binary references all original sheet modules by code name (Sheet1, Sheet2…).
    // If a sheet no longer exists in the workbook, Excel refuses to load the VBA project entirely.
    // Making them veryHidden keeps them invisible to users while satisfying the VBA object model.
    const tmplWbXml = tmpl.readAsText('xl/workbook.xml');
    const tmplWbRels = tmpl.readAsText('xl/_rels/workbook.xml.rels');
    let outWbXml = out.readAsText('xl/workbook.xml');
    let outWbRels = out.readAsText('xl/_rels/workbook.xml.rels');

    // Collect all non-Grade sheet entries from the template workbook
    const nonGradeSheets = [...tmplWbXml.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/>/g)]
        .filter(m => m[1] !== 'Grade');

    if (nonGradeSheets.length > 0) {
        // Find the next free rId number in the output workbook rels
        const usedNums = new Set([...outWbRels.matchAll(/Id="rId(\d+)"/g)].map(m => +m[1]));
        let nextRIdNum = 1;
        while (usedNums.has(nextRIdNum)) nextRIdNum++;

        // Find the next free sheetId in the output workbook.xml
        const usedSheetIds = new Set([...outWbXml.matchAll(/sheetId="(\d+)"/g)].map(m => +m[1]));
        let nextSheetId = 1;
        while (usedSheetIds.has(nextSheetId)) nextSheetId++;

        // Determine how many worksheet files already exist in the output
        let nextSheetFileIdx = 1;
        while (out.getEntry(`xl/worksheets/sheet${nextSheetFileIdx}.xml`)) nextSheetFileIdx++;

        const newWbSheets = [];
        const newWbRels = [];

        for (const m of nonGradeSheets) {
            const sheetName = m[1];
            const tmplRId = m[2];

            // Resolve the template sheet's file path from the template workbook rels
            const targetM = tmplWbRels.match(new RegExp(`Id="${tmplRId}"[^>]*Target="([^"]*)"`));
            if (!targetM) continue;
            const tmplSheetPath = 'xl/' + targetM[1];  // e.g. xl/worksheets/sheet1.xml

            // Write a minimal empty sheet (preserving only codeName) so the VBA module
            // binding resolves without importing stale shared-string indices from the template.
            const entry = tmpl.getEntry(tmplSheetPath);
            if (!entry) continue;
            const tmplSheetXml = tmpl.readAsText(tmplSheetPath);
            const codeNameM = tmplSheetXml.match(/codeName="([^"]*)"/);
            const codeNameAttr = codeNameM ? ` codeName="${codeNameM[1]}"` : '';
            const emptySheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
                `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
                (codeNameAttr ? `<sheetPr${codeNameAttr}/>` : '') +
                `<sheetData/></worksheet>`;
            const outSheetFile = `xl/worksheets/sheet${nextSheetFileIdx}.xml`;
            if (out.getEntry(outSheetFile)) out.deleteFile(outSheetFile);
            out.addFile(outSheetFile, Buffer.from(emptySheet));

            const newRId = `rId${nextRIdNum}`;
            newWbSheets.push(`<sheet name="${sheetName}" sheetId="${nextSheetId}" state="veryHidden" r:id="${newRId}"/>`);
            newWbRels.push(`<Relationship Id="${newRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${nextSheetFileIdx}.xml"/>`);

            nextRIdNum++;
            nextSheetId++;
            nextSheetFileIdx++;
        }

        if (newWbSheets.length > 0) {
            outWbXml = outWbXml.replace('</sheets>', newWbSheets.join('') + '</sheets>');
            out.deleteFile('xl/workbook.xml');
            out.addFile('xl/workbook.xml', Buffer.from(outWbXml));

            outWbRels = outWbRels.replace('</Relationships>', newWbRels.join('') + '</Relationships>');
            out.deleteFile('xl/_rels/workbook.xml.rels');
            out.addFile('xl/_rels/workbook.xml.rels', Buffer.from(outWbRels));
        }
    }

    // Add any missing content-type entries for drawings, control props, and hidden sheets
    let ctXml = out.readAsText('[Content_Types].xml');
    const tmplCtXml = tmpl.readAsText('[Content_Types].xml');
    let ctDirty = false;

    for (const m of tmplCtXml.matchAll(/<Default\b[^>]*\/>/g)) {
        const ext = m[0].match(/Extension="([^"]*)"/)?.[1];
        if (ext && !ctXml.includes(`Extension="${ext}"`)) {
            ctXml = ctXml.replace('</Types>', m[0] + '</Types>');
            ctDirty = true;
        }
    }
    for (const m of tmplCtXml.matchAll(/<Override\b[^>]*\/>/g)) {
        const part = m[0].match(/PartName="([^"]*)"/)?.[1];
        if (part && !ctXml.includes(`PartName="${part}"`) &&
                (part.startsWith('/xl/drawings/') || part.startsWith('/xl/ctrlProps/'))) {
            ctXml = ctXml.replace('</Types>', m[0] + '</Types>');
            ctDirty = true;
        }
    }
    // Ensure any newly added worksheet files have content-type entries
    for (let idx = 2; out.getEntry(`xl/worksheets/sheet${idx}.xml`); idx++) {
        const part = `/xl/worksheets/sheet${idx}.xml`;
        if (!ctXml.includes(`PartName="${part}"`)) {
            ctXml = ctXml.replace('</Types>',
                `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
            ctDirty = true;
        }
    }
    if (ctDirty) {
        out.deleteFile('[Content_Types].xml');
        out.addFile('[Content_Types].xml', Buffer.from(ctXml));
    }

    out.writeZip(outputPath);
}

// --- High-level interface used by generate_grades.js ---

// Reads a single cell value from the Grade sheet of an existing student spreadsheet.
// Returns the cell value as a string, or null if the file/sheet/cell is missing or unreadable.
function readGradeCell(filePath, cellRef) {
    try {
        const wb = xlsx.readFile(filePath);
        const sheet = wb.Sheets['Grade'] || wb.Sheets[wb.SheetNames[0]];
        if (!sheet) return null;
        const cell = sheet[cellRef];
        return cell != null ? String(cell.v) : null;
    } catch {
        return null;
    }
}

// Recovers the Grade sheet's column widths from the template (xlsx doesn't parse
// <cols> from xlsm into !cols). Returns a cols array or undefined.
function readTemplateColumns(rubricPath) {
    const wb = xlsx.readFile(rubricPath);
    const gradeIdx = wb.SheetNames.indexOf('Grade');
    if (gradeIdx < 0) return undefined;
    return parseColsXml(readSheetColsXml(rubricPath, gradeIdx));
}

// Opens a rubric template, returning the workbook and its Grade sheet.
function openRubricTemplate(rubricPath) {
    const wb = xlsx.readFile(rubricPath, { bookVBA: true });
    return { wb, sheet: wb.Sheets['Grade'] };
}

// Finalizes and writes a graded workbook: applies template column widths,
// reduces it to just the Grade sheet, clears cached formula values, writes the
// file, and (for .xlsm) restores drawings/buttons/hidden sheets from the template.
function writeGradeWorkbook(wb, sheet, { templateCols, rubricPath, outputPath, isXlsm }) {
    if (templateCols) sheet['!cols'] = templateCols.map(c => c ? Object.assign({}, c) : null);
    stripToGradeSheet(wb, sheet);
    forceRecalc(sheet);
    xlsx.writeFile(wb, outputPath, isXlsm ? { bookType: 'xlsm' } : undefined);
    if (isXlsm) preserveTemplateDrawings(rubricPath, outputPath);
}

export {
    readTemplateColumns,
    openRubricTemplate,
    writeGradeWorkbook,
    readGradeCell,
    // Exported for testing / advanced use:
    stripToGradeSheet,
    forceRecalc,
    parseColsXml,
    readSheetColsXml,
    preserveTemplateDrawings,
};
