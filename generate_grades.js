/**
 * generate_grades.js
 *
 * Generates graded spreadsheets for each student based on the config cell mappings
 * and the analysis/lint/runtime data attached to each student object.
 *
 * Handlers are registered via registerHandler() — external modules can add new types
 * without editing this file.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
let xlsx;
try {
    xlsx = require('xlsx');
} catch (e) {
    console.error("Please run `npm install xlsx` in AI_Grading directory.");
    process.exit(1);
}
let AdmZip;
try { AdmZip = require('adm-zip'); } catch (e) { AdmZip = null; }

const { getAvailableModel, generateSummary: ollamaGenerateSummary } = require('./ollama_comments');

// --- Cell helpers ---

function setCellValue(sheet, cellRef, value) {
    sheet[cellRef] = { v: value, t: typeof value === 'number' ? 'n' : 's' };
}

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

// --- Handler Registry ---

const _registry = new Map();
const VALID_MAPPING_TYPES = new Set();

/**
 * Register a handler for a mapping type.
 * @param {string} type  — mapping type name (must match "type" in config mappings)
 * @param {function} handlerFn — (map, student) => { score, comment }
 */
function registerHandler(type, handlerFn) {
    if (_registry.has(type)) {
        throw new Error(`Handler "${type}" is already registered`);
    }
    _registry.set(type, handlerFn);
    VALID_MAPPING_TYPES.add(type);
}

function getHandler(type) {
    return _registry.get(type);
}

// --- Built-in Handlers ---

registerHandler('feature', (map, student) => {
    const features = (student.analysis && student.analysis.features) || {};
    const count = typeof features[map.featureId] === 'number'
        ? features[map.featureId]
        : (features[map.featureId] ? 1 : 0);
    const minRequired = map.minCount || 1;
    if (count >= minRequired) {
        return { score: map.maxScore, comment: `${map.successMsg || 'Yes'} (${count} found)` };
    }
    return { score: 0, comment: `${map.failMsg || 'Missing'} (only ${count} found)` };
});

registerHandler('part1_completed', (map, student) => {
    const pp = (student.analysis && student.analysis.partPresence) || {};
    const partId = map.partId || 'part1';
    if (pp[partId]) {
        return { score: map.maxScore, comment: 'Part files found' };
    }
    return { score: 0, comment: 'Part files not found' };
});

registerHandler('part_completed', (map, student) => {
    const pp = (student.analysis && student.analysis.partPresence) || {};
    const partId = map.partId || 'part1';
    if (pp[partId]) {
        return { score: map.maxScore, comment: `${partId} files found` };
    }
    return { score: 0, comment: `${partId} files not found` };
});

registerHandler('apps_in_repo', (map, student) => {
    const a = student.analysis || {};
    const pp = a.partPresence || {};
    if (pp.allPresent && a.urls && a.urls.github) {
        return { score: map.maxScore, comment: 'Yes (Both apps found in GitHub repo)' };
    }
    if (!a.urls || !a.urls.github) {
        return { score: 0, comment: 'Missing GitHub repository' };
    }
    const partIds = Object.keys(pp).filter(k => k !== 'allPresent');
    if (partIds.length === 0) {
        return { score: 0, comment: 'Missing app folders' };
    }
    const status = partIds.map(id => `${id}: ${pp[id] ? 'Yes' : 'No'}`).join(', ');
    return { score: 0, comment: `Missing folders (${status})` };
});

registerHandler('developer_comments', (map, student) => {
    const a = student.analysis || {};
    if (a.hasDeveloperComments) {
        return { score: map.maxScore, comment: 'Yes' };
    }
    return { score: 0, comment: 'Missing name/date comments' };
});

registerHandler('code_review', (map, student) => {
    const a = student.analysis || {};
    const cr = student.codeReview;
    const hasReview = a.hasCodeReview;
    const prodDone = cr && cr.productionCompleted;
    const group = (cr && cr.group) ? ` (Group ${cr.group})` : '';

    if (hasReview && prodDone) {
        return { score: map.maxScore, comment: 'yes and yes' + group };
    }
    if (hasReview && !prodDone) {
        return { score: 0, comment: 'yes and no' + group };
    }
    return { score: 0, comment: 'no and no' };
});

registerHandler('url_check', (map, student) => {
    const a = student.analysis || {};
    const url = a.urls && a.urls[map.urlType];
    if (url) {
        return { score: map.maxScore, comment: `NEEDS CHECK: ${url}` };
    }
    return { score: 0, comment: `No ${map.urlType} URL provided` };
});

registerHandler('deploy_check', async (map, student) => {
    const url = (student.analysis && student.analysis.urls && student.analysis.urls.citstudent) || '';
    if (!url) {
        return { score: 0, comment: 'No deployment URL provided' };
    }

    // 1. Check URL reachability
    let html;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) {
            return { score: 0, comment: `URL unreachable (HTTP ${response.status})` };
        }
        html = await response.text();
    } catch (err) {
        const reason = err.name === 'AbortError' ? 'timeout' : err.message;
        return { score: 0, comment: `URL unreachable (${reason})` };
    }

    // 2. Check <script> tags for bundling indicators
    const scriptSrcRe = /<script\s[^>]*src\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
    const scripts = [];
    let bundled = false;
    let match;
    while ((match = scriptSrcRe.exec(html)) !== null) {
        const src = match[1];
        scripts.push(src);
        if (/assets\/|dist\/|static\/|bundle|min\.|chunk/i.test(src) || /\/[a-f0-9]{8,}\./i.test(src)) {
            bundled = true;
        }
    }

    if (scripts.length === 0) {
        const score = Math.floor(map.maxScore / 2);
        return { score, comment: 'URL reachable but no <script> tags found' };
    }

    if (bundled) {
        return { score: map.maxScore, comment: `URL reachable, page appears bundled (${scripts.join(', ')})` };
    }
    const score = Math.floor(map.maxScore / 2);
    return { score, comment: `URL reachable but page may not be bundled (${scripts.join(', ')})` };
});

registerHandler('lint', (map, student) => {
    const lint = student.lint || {};
    if (lint.jsFiles > 0) {
        const severity = map.severity; // 'errors', 'warnings', or undefined (all)

        if (severity === 'errors') {
            const count = lint.errors || 0;
            const topIssues = (lint.errorMessages || lint.messages || []).slice(0, 3).join(', ');
            if (count === 0) return { score: map.maxScore, comment: 'No syntax errors' };
            return { score: 0, comment: `${count} error${count !== 1 ? 's' : ''} found (${topIssues})` };
        }

        let count, topIssues;
        if (severity === 'warnings') {
            count = lint.warnings || 0;
            topIssues = (lint.warningMessages || lint.messages || []).slice(0, 3).join(', ');
        } else {
            count = (lint.errors || 0) + (lint.warnings || 0);
            topIssues = (lint.messages || []).slice(0, 3).join(', ');
        }

        if (count === 0) {
            return { score: map.maxScore, comment: 'Excellent - no lint issues' };
        } else if (count <= 10) {
            return { score: map.maxScore, comment: `Good - ${count} minor issues (${topIssues})` };
        } else if (count <= 30) {
            return { score: Math.max(1, Math.floor(map.maxScore / 2)), comment: `${count} issues (${topIssues})` };
        } else {
            return { score: 0, comment: `${count} issues (${topIssues})` };
        }
    }
    return { score: map.maxScore, comment: 'No JS files to lint' };
});

registerHandler('build_check', (map, student) => {
    const rt = student.runtimeCheck || {};
    if (rt.success) {
        return { score: map.maxScore, comment: 'Error free' };
    }
    const errors = rt.errors || [];
    if (errors.length === 0) {
        return { score: 0, comment: 'Build failed' };
    }
    // Categorize errors by type
    const buildErrors = [];
    const runtimeErrors = [];
    const resourceErrors = [];
    for (const err of errors) {
        const msg = (typeof err === 'string' ? err : String(err)).replace(/^[^:]+:\s*/, '');
        if (/npm\s+(install|run\s+build)\s+failed/i.test(msg) || /build\s+failed/i.test(msg)) {
            buildErrors.push(msg);
        } else if (/missing\s+(script|stylesheet)/i.test(msg)) {
            resourceErrors.push(msg);
        } else {
            runtimeErrors.push(msg);
        }
    }
    const parts = [];
    if (buildErrors.length) parts.push(`Build: ${buildErrors.join('; ')}`);
    if (resourceErrors.length) parts.push(`Resource: ${resourceErrors.join('; ')}`);
    if (runtimeErrors.length) parts.push(`Runtime: ${runtimeErrors.join('; ')}`);
    return { score: 0, comment: parts.join(' | ') };
});

registerHandler('manual', (map, student) => {
    const cr = student.codeReview;
    if (cr && cr.found && cr.items && map._reviewIndex !== undefined && map._reviewIndex < cr.items.length) {
        const item = cr.items[map._reviewIndex];
        // Production score as a fraction (e.g. "4/5")
        if (item.prodScore !== null) {
            const score = Math.min(item.prodScore, map.maxScore || Infinity);
            const comment = (map.msg || 'NEEDS MANUAL CHECK') + ` [Production score: ${item.prodScore}]`;
            return { score, comment };
        }
        // Production cell filled with Y/N/Yes/No
        if (item.prodFilled) {
            const score = item.prodAffirmative ? map.maxScore : 0;
            const label = item.prodAffirmative ? 'Production: Yes' : 'Production: No';
            const comment = (map.msg || 'NEEDS MANUAL CHECK') + ` [${label}]`;
            return { score, comment };
        }
        // Fall back to beta score
        if (item.betaScore !== null) {
            const score = Math.min(item.betaScore, map.maxScore || Infinity);
            const comment = (map.msg || 'NEEDS MANUAL CHECK') + ` [Beta score: ${item.betaScore}]`;
            return { score, comment };
        }
    }
    return { score: map.maxScore, comment: map.msg || 'NEEDS MANUAL CHECK' };
});

registerHandler('npm_package', (map, student) => {
    const a = student.analysis || {};
    const packages = a.npmPackages || [];
    if (packages.length > 0) {
        return { score: map.maxScore, comment: `Yes - ${packages.join(', ')}` };
    }
    return { score: 0, comment: 'No npm packages imported' };
});

registerHandler('package_check', (map, student) => {
    const pc = student.analysis && student.analysis.packageCheck;
    if (!pc) return { score: map.maxScore, comment: 'NEEDS MANUAL CHECK (no package.json check data)' };
    if (!pc.found) return { score: 0, comment: 'package.json not found' };
    if (pc.passed) return { score: map.maxScore, comment: 'package.json entries correct' };
    return { score: 0, comment: pc.issues.join('; ') };
});

/**
 * Per-part feature handler — reads from analysis.partFeatures[partId][featureId].
 * Used by the unified featureCounts pipeline. Config mappings can also use this
 * type directly by specifying partId and featureId.
 */
registerHandler('part_feature', (map, student) => {
    const { partId, featureId, minCount = 1, maxScore, successMsg = 'Yes', failMsg = 'Missing' } = map;
    const partCounts = student.analysis && student.analysis.partFeatures && student.analysis.partFeatures[partId];
    if (partCounts === null || partCounts === undefined) {
        return { score: 0, comment: `${failMsg} (folder not found)` };
    }
    const count = partCounts[featureId] || 0;
    if (count >= minCount) {
        return { score: maxScore, comment: `${successMsg} (${count} found)` };
    }
    return { score: 0, comment: `${failMsg} (only ${count} found)` };
});

registerHandler('repo_hygiene', (map, student) => {
    const rh = student.analysis && student.analysis.repoHygiene;
    if (!rh) return { score: map.maxScore, comment: 'NEEDS MANUAL CHECK' };
    if (rh.passed) return { score: map.maxScore, comment: 'No non-source files in repo' };
    return { score: 0, comment: `Non-source files found in repo: ${rh.foundDirs.join(', ')}` };
});

registerHandler('github_repo', (map, student) => {
    const url = student.urls && student.urls.github;
    if (!url) return { score: 0, comment: 'No GitHub URL provided' };
    if (student.extractedDir) return { score: map.maxScore, comment: `Yes - ${url}` };
    return { score: 0, comment: `GitHub URL provided but repo could not be cloned: ${url}` };
});

// --- Mapping types that can produce a score even when code extraction failed ---

// Types that report an extraction error rather than 'N/A' when code could not be obtained.
const CODE_SOURCE_TYPES = new Set(['apps_in_repo', 'part1_completed', 'part_completed', 'github_repo']);

function isCodeSourceType(map) {
    return CODE_SOURCE_TYPES.has(map.type) || (map.type === 'url_check' && map.urlType === 'github');
}

// --- Text report helpers ---

function mappingDescription(map, index) {
    if (map.msg) return map.msg.replace('NEEDS MANUAL CHECK (', '').replace(')', '');
    if (map.featureId) return map.featureId;
    switch (map.type) {
        case 'build_check': return 'App loads and runs without errors';
        case 'lint': return 'Style and best practices';
        case 'developer_comments': return 'Developer name/date in files';
        case 'github_repo': return 'GitHub repo set up correctly';
        case 'deploy_check': return 'Deployed and running on citstudent';
        case 'code_review': return 'Code review, prod column completed';
        case 'url_check': return 'URL provided';
        case 'apps_in_repo': return 'Apps in repository';
        case 'repo_hygiene': return 'Repo hygiene';
        case 'npm_package': return 'NPM package used';
        case 'package_check': return 'package.json check';
        case 'part_feature': return map.featureId || 'Part feature';
        case 'part_completed': return map.partId || 'Part completed';
        case 'part1_completed': return 'Part 1 completed';
        default: return map.type;
    }
}

async function gradeStudentMappings(student, config) {
    const results = [];
    const analysis = student.analysis || {};

    if (analysis.extractionError) {
        for (const map of config.mappings) {
            const desc = mappingDescription(map, results.length);
            if (isCodeSourceType(map)) {
                results.push({ desc, score: 0, maxScore: map.maxScore || 0, comment: `ERROR: ${analysis.extractionError}` });
            } else {
                results.push({ desc, score: 0, maxScore: map.maxScore || 0, comment: 'N/A (code unavailable)' });
            }
        }
        return results;
    }

    for (const map of config.mappings) {
        const handler = getHandler(map.type);
        let score, comment;

        if (handler) {
            const result = await handler(map, student);
            score = result.score;
            comment = result.comment;
        } else {
            score = 0;
            comment = `ERROR: Unknown mapping type "${map.type}"`;
        }

        results.push({
            desc: mappingDescription(map, results.length),
            score: score != null ? score : 0,
            maxScore: map.maxScore || 0,
            comment
        });
    }

    // Per-part feature counts
    if (config.parts && analysis.partFeatures) {
        for (const part of config.parts) {
            if (!part.featureCounts) continue;
            for (const fc of part.featureCounts) {
                const virtualMap = {
                    type: 'part_feature',
                    partId: part.id,
                    featureId: fc.featureId,
                    minCount: fc.minCount || 1,
                    maxScore: fc.maxScore,
                    successMsg: fc.successMsg,
                    failMsg: fc.failMsg
                };
                const handler = getHandler('part_feature');
                const result = await handler(virtualMap, student);
                results.push({
                    desc: fc.featureId || `${part.id} feature`,
                    score: result.score != null ? result.score : 0,
                    maxScore: fc.maxScore || 0,
                    comment: result.comment
                });
            }
        }
    }

    return results;
}

function formatTextReport(student, config, results, labTitle) {
    const cr = student.codeReview || {};
    const group = cr.group
        || (student.analysis && student.analysis.versionVariation
            && student.analysis.versionVariation.detected)
        || '?';

    const lines = [];
    const divider = '='.repeat(56);

    lines.push(divider);
    lines.push(`GRADE REPORT: ${student.name}`);
    if (labTitle) lines.push(`${labTitle}`);
    lines.push(`Group: ${group}`);
    lines.push(divider);
    lines.push('');

    let totalScore = 0;
    let totalPossible = 0;

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const num = String(i + 1).padStart(2);
        const scoreStr = String(r.score).padStart(2);
        const maxStr = String(r.maxScore).padStart(2);
        lines.push(`  ${num}. [${scoreStr}/${maxStr}]  ${r.desc}`);
        if (r.comment) lines.push(`      ${r.comment}`);
        totalScore += r.score;
        totalPossible += r.maxScore;
    }

    lines.push('');
    lines.push(`  Total: ${totalScore} / ${totalPossible}`);

    // API completeness breakdown (Lab 6 specific)
    const api = student.analysis && student.analysis.apiCompleteness;
    if (api && api.steps) {
        lines.push('');
        lines.push(`API Integration Pipeline (${api.version})`);
        lines.push('-'.repeat(40));
        for (const step of api.steps) {
            const check = step.found ? 'YES' : ' no';
            lines.push(`  [${check}]  Step ${step.step}: ${step.name}`);
        }
        lines.push(`  ${api.completed}/${api.total} steps complete`);
    }

    lines.push('');
    lines.push(divider);

    return lines.join('\n');
}

// --- Main export ---

module.exports = async function(students, config, labDir, opts = {}) {
    console.log("--- Grade Generation Phase ---");

    let aiModel = null;
    if (opts.aiComments) {
        const detected = await getAvailableModel();
        if (!detected) {
            console.warn('  WARNING: --ai-comments requested but Ollama not reachable or no models installed; using fallback text.');
        } else {
            aiModel = opts.aiModel || detected;
            const source = opts.aiModel ? 'specified' : 'auto-detected';
            console.log(`  AI comments: using model "${aiModel}" (${source}).`);
        }
    }

    // Pre-compute review score indices for manual mappings
    let reviewIdx = 0;
    for (const map of config.mappings) {
        if (map.type === 'manual') {
            map._reviewIndex = reviewIdx++;
        }
    }

    // --- Text report path ---
    if (opts.textReport) {
        const summary = { successful: [], errors: [] };
        let generated = 0;
        let skipped = 0;
        const labTitle = config.titleText || '';

        for (const student of students) {
            const gradeDir = student.gradeDir;

            if (!gradeDir) {
                console.log(`  SKIP: ${student.name} - no grade output directory found`);
                summary.errors.push({ student: student.name, issue: 'No grade output directory found.' });
                skipped++;
                continue;
            }
            fs.mkdirSync(gradeDir, { recursive: true });

            try {
                const results = await gradeStudentMappings(student, config);
                const report = formatTextReport(student, config, results, labTitle);

                const outputPath = path.join(gradeDir, `${student.name}_Grade.txt`);
                fs.writeFileSync(outputPath, report, 'utf8');
                console.log(`  OK: ${student.name} -> ${path.basename(outputPath)}`);
                summary.successful.push(student.name);
                generated++;
            } catch (err) {
                console.log(`  ERROR: ${student.name} - ${err.message}`);
                summary.errors.push({ student: student.name, issue: `Text report error: ${err.message}` });
                skipped++;
            }
        }

        console.log(`\nGenerated ${generated} text reports, skipped ${skipped}.`);
        return summary;
    }

    // --- Spreadsheet path ---
    const rubricPath = path.join(opts.rubricDir || labDir, config.rubricName);
    const isXlsm = rubricPath.toLowerCase().endsWith('.xlsm');
    if (!fs.existsSync(rubricPath)) {
        const err = new Error(`Rubric file not found at ${rubricPath}`);
        err.code = 'RUBRIC_NOT_FOUND';
        err.rubricPath = rubricPath;
        throw err;
    }

    // Read column widths once from the template ZIP (xlsx doesn't parse !cols from xlsm)
    let templateCols;
    {
        const _wb = xlsx.readFile(rubricPath);
        const gradeIdx = _wb.SheetNames.indexOf('Grade');
        if (gradeIdx >= 0) {
            templateCols = parseColsXml(readSheetColsXml(rubricPath, gradeIdx));
        }
    }

    const summary = { successful: [], errors: [] };
    let generated = 0;
    let skipped = 0;

    for (const student of students) {
        const analysis = student.analysis || {};
        const gradeDir = student.gradeDir;

        if (!gradeDir) {
            console.log(`  SKIP: ${student.name} - no grade output directory found`);
            summary.errors.push({ student: student.name, issue: 'No grade output directory found.' });
            skipped++;
            continue;
        }
        fs.mkdirSync(gradeDir, { recursive: true });

        try {
            const wb = xlsx.readFile(rubricPath, { bookVBA: true });
            const sheet = wb.Sheets['Grade'];
            if (templateCols) sheet['!cols'] = templateCols.map(c => c ? Object.assign({}, c) : null);

            if (config.titleCell && config.titleText) {
                setCellValue(sheet, config.titleCell, config.titleText);
            }

            if (config.summaryCell) {
                let summaryText;
                if (analysis.error) {
                    summaryText = `Issue: ${analysis.error}`;
                } else if (aiModel) {
                    const lint = student.lint || { errors: 0, warnings: 0, messages: [] };
                    const rt = student.runtimeCheck || { success: false, errors: [] };
                    process.stdout.write(`    Generating AI summary for ${student.name}... `);
                    const aiResult = await ollamaGenerateSummary({
                        model: aiModel,
                        student: student.name,
                        features: analysis.features || {},
                        lintErrors: lint.errors,
                        lintWarnings: lint.warnings,
                        lintTopIssues: lint.messages || [],
                        runtimeSuccess: rt.success,
                        runtimeErrors: rt.errors || []
                    });
                    if (aiResult) {
                        console.log('OK');
                        summaryText = aiResult;
                    } else {
                        console.log('FAILED (Ollama returned no result; using fallback)');
                        summaryText = 'Pending manual checks for full verification.';
                    }
                } else {
                    summaryText = 'Pending manual checks for full verification.';
                }
                setCellValue(sheet, config.summaryCell, summaryText);
            }

            // Write student name and lab assignment group
            {
                const nameCell = (config.codeReview && config.codeReview.studentNameCell) || 'B1';
                setCellValue(sheet, nameCell, student.name);

                const groupCell = (config.codeReview && config.codeReview.groupCell) || 'C1';
                const cr = student.codeReview || {};
                const group = cr.group
                    || (student.analysis && student.analysis.versionVariation
                        && student.analysis.versionVariation.detected)
                    || '?';
                setCellValue(sheet, groupCell, group);
            }

            // If code could not be extracted, write extraction-available info to relevant cells,
            // mark everything else N/A
            if (analysis.extractionError) {
                for (const map of config.mappings) {
                    if (isCodeSourceType(map)) {
                        setCellValue(sheet, map.cell, 0);
                        if (map.commentCell) setCellValue(sheet, map.commentCell, `ERROR: ${analysis.extractionError}`);
                    } else {
                        if (map.cell) setCellValue(sheet, map.cell, 0);
                        if (map.commentCell) setCellValue(sheet, map.commentCell, 'N/A (code unavailable)');
                    }
                }
                for (const part of (config.parts || [])) {
                    if (!part.featureCounts) continue;
                    for (const fc of part.featureCounts) {
                        if (fc.cell) setCellValue(sheet, fc.cell, 0);
                        if (fc.commentCell) setCellValue(sheet, fc.commentCell, 'N/A (code unavailable)');
                    }
                }
                stripToGradeSheet(wb, sheet);
                forceRecalc(sheet);
                const outputExt = isXlsm ? '.xlsm' : '.xlsx';
                const outputPath = path.join(gradeDir, `${student.name}_Grade${outputExt}`);
                xlsx.writeFile(wb, outputPath, isXlsm ? { bookType: 'xlsm' } : undefined);
                if (isXlsm) preserveTemplateDrawings(rubricPath, outputPath);
                console.log(`  PARTIAL: ${student.name} -> ${path.basename(outputPath)} (extraction failed)`);
                summary.successful.push(student.name);
                generated++;
                continue;
            }

            // Normal grading
            for (const map of config.mappings) {
                const handler = getHandler(map.type);
                let score, comment;

                if (handler) {
                    const result = await handler(map, student);
                    score = result.score;
                    comment = result.comment;
                } else {
                    score = 0;
                    comment = `ERROR: Unknown mapping type "${map.type}" — check config`;
                    console.warn(`  WARNING: Unknown map.type "${map.type}" for ${student.name}`);
                }

                if (map.cell) setCellValue(sheet, map.cell, score);
                if (map.commentCell) setCellValue(sheet, map.commentCell, comment);
                if (map.linkCell && map.linkUrlType && analysis.urls && analysis.urls[map.linkUrlType]) {
                    setCellValue(sheet, map.linkCell, analysis.urls[map.linkUrlType]);
                }
            }

            // Per-part feature counts — processed through handler pipeline
            if (config.parts && analysis.partFeatures) {
                for (const part of config.parts) {
                    if (!part.featureCounts) continue;
                    for (const fc of part.featureCounts) {
                        const virtualMap = {
                            type: 'part_feature',
                            partId: part.id,
                            featureId: fc.featureId,
                            minCount: fc.minCount || 1,
                            maxScore: fc.maxScore,
                            successMsg: fc.successMsg,
                            failMsg: fc.failMsg
                        };
                        const handler = getHandler('part_feature');
                        const result = await handler(virtualMap, student);
                        if (fc.cell) setCellValue(sheet, fc.cell, result.score);
                        if (fc.commentCell) setCellValue(sheet, fc.commentCell, result.comment);
                    }
                }
            }

            stripToGradeSheet(wb, sheet);
            forceRecalc(sheet);

            const outputExt = isXlsm ? '.xlsm' : '.xlsx';
            const outputPath = path.join(gradeDir, `${student.name}_Grade${outputExt}`);
            xlsx.writeFile(wb, outputPath, isXlsm ? { bookType: 'xlsm' } : undefined);
            if (isXlsm) preserveTemplateDrawings(rubricPath, outputPath);
            console.log(`  OK: ${student.name} -> ${path.basename(outputPath)}`);
            summary.successful.push(student.name);
            generated++;

        } catch (err) {
            console.log(`  ERROR: ${student.name} - ${err.message}`);
            summary.errors.push({ student: student.name, issue: `Spreadsheet generation error: ${err.message}` });
            skipped++;
        }
    }

    console.log(`\nGenerated ${generated} spreadsheets, skipped ${skipped}.`);
    return summary;
};

module.exports.registerHandler = registerHandler;
module.exports.getHandler = getHandler;
module.exports.VALID_MAPPING_TYPES = VALID_MAPPING_TYPES;
module.exports.isCodeSourceType = isCodeSourceType;
