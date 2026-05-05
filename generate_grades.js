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
    if (a.hasCodeReview) {
        return { score: map.maxScore, comment: 'Yes' };
    }
    return { score: 0, comment: 'Not found in submission' };
});

registerHandler('url_check', (map, student) => {
    const a = student.analysis || {};
    const url = a.urls && a.urls[map.urlType];
    if (url) {
        return { score: map.maxScore, comment: `NEEDS CHECK: ${url}` };
    }
    return { score: 0, comment: `No ${map.urlType} URL provided` };
});

registerHandler('lint', (map, student) => {
    const lint = student.lint || {};
    if (lint.jsFiles > 0) {
        const totalIssues = lint.errors + lint.warnings;
        const topIssues = (lint.messages || []).slice(0, 3).join(', ');
        if (totalIssues === 0) {
            return { score: map.maxScore, comment: 'Excellent - no lint issues' };
        } else if (totalIssues <= 10) {
            return { score: map.maxScore, comment: `Good - ${totalIssues} minor issues (${topIssues})` };
        } else if (totalIssues <= 30) {
            return { score: Math.max(1, Math.floor(map.maxScore / 2)), comment: `${totalIssues} issues (${topIssues})` };
        } else {
            return { score: 0, comment: `${totalIssues} issues (${topIssues})` };
        }
    }
    return { score: map.maxScore, comment: 'No JS files to lint' };
});

registerHandler('build_check', (map, student) => {
    const rt = student.runtimeCheck || {};
    if (rt.success) {
        return { score: map.maxScore, comment: 'No runtime errors' };
    }
    const errors = rt.errors || [];
    return { score: 0, comment: errors.length ? `Errors found: ${errors.join(', ')}` : 'Build failed' };
});

registerHandler('manual', (map, student) => {
    return { score: map.maxScore, comment: map.msg || 'NEEDS MANUAL CHECK' };
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

    const rubricPath = path.join(labDir, config.rubricName);
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
            const wb = xlsx.readFile(rubricPath);
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
                    const result = handler(map, student);
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
                        const result = handler(virtualMap, student);
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
