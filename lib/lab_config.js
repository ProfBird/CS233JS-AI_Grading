'use strict';
// Pure, UI-agnostic functions for lab configuration.
// No readline, no TUI, no process.exit. Safe to import from anywhere.

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const CONFIGS_DIR = path.join(__dirname, '..', 'configs');

// ── Column helpers ────────────────────────────────────────────────────────

function colLetter(idx) {
    let result = '';
    let n = idx + 1;
    while (n > 0) {
        const rem = (n - 1) % 26;
        result = String.fromCharCode(65 + rem) + result;
        n = Math.floor((n - 1) / 26);
    }
    return result;
}

function excelCell(col, row) {
    return colLetter(col) + row;
}

function colLetterToIndex(letter) {
    const upper = letter.toUpperCase().trim();
    let idx = 0;
    for (const ch of upper) idx = idx * 26 + (ch.charCodeAt(0) - 64);
    return idx - 1;
}

// ── Assignment name ───────────────────────────────────────────────────────

function normalizeAssignmentName(input) {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) return `Lab${String(parseInt(trimmed, 10)).padStart(2, '0')}`;
    const m = trimmed.match(/^[Ll][Aa][Bb](\d+)$/);
    if (m) return `Lab${String(parseInt(m[1], 10)).padStart(2, '0')}`;
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed)) return trimmed;
    return null;
}

// ── Spreadsheet helpers ───────────────────────────────────────────────────

function sheetRows(ws) {
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

function isBlankRow(row) {
    return row.every(c => c === '' || c === null || c === undefined);
}

function cellText(row, i) {
    return (row[i] ?? '').toString().trim();
}

const POSSIBLE_HEADER_RE = /^(possible|points?|pts|max)$/i;

function detectRubricLayout(rows, searchRe = POSSIBLE_HEADER_RE) {
    let headerRow = -1;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].some(c => searchRe.test((c ?? '').toString().trim()))) {
            headerRow = i;
            break;
        }
    }
    if (headerRow < 0) return null;

    const hrow = rows[headerRow];
    let possibleCol = -1, scoreCol = -1, commentCol = -1;
    for (let c = 0; c < hrow.length; c++) {
        const h = (hrow[c] ?? '').toString().trim();
        if (searchRe.test(h))                        possibleCol = c;
        else if (/^(score|grade|actual)$/i.test(h))  scoreCol    = c;
        else if (/^comments?$/i.test(h))              commentCol  = c;
    }
    if (possibleCol < 0) possibleCol = 1;
    if (scoreCol    < 0) scoreCol    = possibleCol + 1;
    if (commentCol  < 0) commentCol  = scoreCol + 2;

    let fullCol = -1, partialCol = -1, zeroCol = -1;
    for (let r = Math.max(0, headerRow - 1); r <= headerRow; r++) {
        const scanRow = rows[r] ?? [];
        for (let c = 0; c < scanRow.length; c++) {
            if (/stock\s*comments?/i.test((scanRow[c] ?? '').toString().trim())) {
                fullCol = c; partialCol = c + 1; zeroCol = c + 2;
                break;
            }
        }
        if (fullCol >= 0) break;
    }

    return { headerRow, possibleCol, scoreCol, commentCol, fullCol, partialCol, zeroCol };
}

function readRubricRows(rubricPath, layoutOrLabel = null) {
    let wb;
    try { wb = XLSX.readFile(rubricPath); } catch (e) {
        console.error(`  Could not read rubric file: ${e.message}`);
        return null;
    }
    const ws = wb.Sheets['Grade'];
    if (!ws) {
        console.error('  No "Grade" sheet found in the rubric.');
        return null;
    }
    const rows = sheetRows(ws);

    let layout;
    if (layoutOrLabel && typeof layoutOrLabel === 'object') {
        layout = layoutOrLabel;
    } else {
        const searchRe = layoutOrLabel
            ? new RegExp(`^${layoutOrLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
            : POSSIBLE_HEADER_RE;
        layout = detectRubricLayout(rows, searchRe);
        if (!layout) {
            const searched = layoutOrLabel ?? 'possible / points / pts / max';
            console.error(`  Could not find header row (containing "${searched}") in Grade sheet.`);
            return null;
        }
    }

    const { headerRow, possibleCol, scoreCol, commentCol } = layout;
    const { fullCol = -1, partialCol = -1, zeroCol = -1 } = layout;

    let tableEnd = rows.length;
    for (let i = headerRow + 1; i < rows.length; i++) {
        if (/^comments$/i.test(cellText(rows[i], 0))) { tableEnd = i; break; }
    }

    const rubricRows = [];
    for (let i = headerRow + 1; i < tableEnd; i++) {
        const row = rows[i];
        if (isBlankRow(row)) continue;
        const label = cellText(row, 0) || cellText(row, 1);
        if (!label) continue;
        const lower = label.toLowerCase();
        if (lower.startsWith('total') || lower.startsWith('sub-total')) continue;

        const possible = cellText(row, possibleCol);
        const isSectionHeader = possible === ''
            && cellText(row, scoreCol)   === ''
            && cellText(row, commentCol) === '';

        const entry = {
            excelRow: i + 1,
            label,
            possible,
            scoreCell:   excelCell(scoreCol,   i + 1),
            commentCell: excelCell(commentCol, i + 1),
            isSectionHeader,
        };

        if (fullCol >= 0 && !isSectionHeader) {
            const full    = cellText(row, fullCol);
            const partial = cellText(row, partialCol);
            const zero    = cellText(row, zeroCol);
            if (full || partial || zero) {
                const sc = {};
                if (full)    sc.full    = full;
                if (partial) sc.partial = partial;
                if (zero)    sc.zero    = zero;
                entry.stockComments = sc;
            }
        }

        rubricRows.push(entry);
    }
    return rubricRows;
}

function readRubricCriteria(rubricPath) {
    let wb;
    try { wb = XLSX.readFile(rubricPath); } catch (e) { return []; }
    const ws = wb.Sheets['Rubric'];
    if (!ws) return [];
    const rows = sheetRows(ws);

    let headerRow = -1, criteriaCol = -1, pointsCol = -1;
    for (let i = 0; i < rows.length; i++) {
        const hrow = rows[i];
        const cc = hrow.findIndex(c => /^criteria$/i.test((c ?? '').toString().trim()));
        if (cc >= 0) {
            headerRow = i;
            criteriaCol = cc;
            pointsCol = hrow.findIndex(c => /^(possible|points?|pts|max)$/i.test((c ?? '').toString().trim()));
            break;
        }
    }
    if (headerRow < 0) return [];

    const out = [];
    for (let i = headerRow + 1; i < rows.length; i++) {
        const row = rows[i];
        if (isBlankRow(row)) continue;
        const label = cellText(row, 0) || cellText(row, 1);
        if (!label) continue;
        const lower = label.toLowerCase();
        if (lower.startsWith('total') || lower.startsWith('sub-total')) continue;
        const criteria = cellText(row, criteriaCol);
        if (!criteria) continue;
        out.push({
            label,
            points: pointsCol >= 0 ? cellText(row, pointsCol) : '',
            criteria,
        });
    }
    return out;
}

// ── File utilities ────────────────────────────────────────────────────────

function findSpreadsheets(dir) {
    const results = [];
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return results; }
    for (const entry of entries) {
        const full = path.join(dir, entry);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (stat.isFile() && /\.(xlsx|xlsm)$/i.test(entry)) {
            results.push(entry);
        } else if (stat.isDirectory()) {
            let subEntries;
            try { subEntries = fs.readdirSync(full); } catch (e) { continue; }
            for (const sub of subEntries) {
                if (/\.(xlsx|xlsm)$/i.test(sub)) results.push(path.join(entry, sub));
            }
        }
    }
    return results;
}

function getExistingAssignments() {
    const results = [];
    let entries;
    try { entries = fs.readdirSync(CONFIGS_DIR); } catch (e) { return results; }
    for (const entry of entries) {
        const full = path.join(CONFIGS_DIR, entry);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (!stat.isDirectory()) continue;
        const configFile = path.join(full, `${entry.toLowerCase()}_config.json`);
        results.push({ name: entry, hasConfig: fs.existsSync(configFile) });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
}

function keywordsToFolderPattern(keywords) {
    const words = keywords.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    return words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

// ── Mapping schema ────────────────────────────────────────────────────────

const MAPPING_TYPES = [
    { label: 'feature',               value: 'feature',               desc: 'Counts regex matches in student code; full credit if count meets minimum' },
    { label: 'manual',                value: 'manual',                desc: 'No automation; score pulled from student\'s peer code review form' },
    { label: 'lint',                  value: 'lint',                  desc: 'Runs ESLint on .js files; choose errors (syntax) or warnings (style)' },
    { label: 'html_validate',         value: 'html_validate',         desc: 'Validates HTML files; partial credit up to a configurable error tolerance' },
    { label: 'css_validate',          value: 'css_validate',          desc: 'Validates CSS files; partial credit up to a configurable error tolerance' },
    { label: 'name_check',            value: 'name_check',            desc: 'File and folder names must be Linux-safe (no spaces or special characters)' },
    { label: 'code_review',           value: 'code_review',           desc: 'Checks if peer code review was submitted and production column was filled' },
    { label: 'deploy_check',          value: 'deploy_check',          desc: 'Fetches citstudent URL; checks site is live and output is Vite-bundled' },
    { label: 'build_check',           value: 'build_check',           desc: 'Runs npm install + npm run build; 0 points if the build fails or errors' },
    { label: 'browser_check',         value: 'browser_check',         desc: 'Loads app in Puppeteer browser; 0 points if any JS console errors appear' },
    { label: 'build_and_browser_check', value: 'build_and_browser_check', desc: 'Runs build + browser checks; half credit if only one of the two fails' },
    { label: 'package_check',         value: 'package_check',         desc: 'Checks package.json for required or forbidden npm package dependencies' },
    { label: 'github_repo',           value: 'github_repo',           desc: 'Confirms a GitHub URL was submitted and the repo was successfully cloned' },
    { label: 'collaborator_check',    value: 'collaborator_check',    desc: 'Full credit if instructor was added as a collaborator (proven by clone)' },
    { label: 'gitignore_check',       value: 'gitignore_check',       desc: 'Full credit if a .gitignore file exists at the root of the cloned repo' },
    { label: 'repo_hygiene',          value: 'repo_hygiene',          desc: 'Confirms excluded folders (node_modules, dist, etc.) are not committed' },
    { label: 'developer_comments',    value: 'developer_comments',    desc: 'Scans code files for developer name, date, and/or file-header comments' },
    { label: 'url_check',             value: 'url_check',             desc: 'Fetches a URL from the student\'s submission; full credit if HTTP 200' },
    { label: 'part_completed',        value: 'part_completed',        desc: 'Checks that the expected files for a specific lab part are present' },
    { label: 'part1_completed',       value: 'part1_completed',       desc: 'Checks that files for the first (or only) lab part are present' },
    { label: 'apps_in_repo',          value: 'apps_in_repo',          desc: 'Verifies all expected app subfolders exist in the cloned repo' },
    { label: 'npm_package',           value: 'npm_package',           desc: 'Checks that a specific npm package is imported in the student\'s code' },
    { label: 'scripts_check',         value: 'scripts_check',         desc: 'Verifies dev/build/test scripts are defined; runs build and test for errors' },
];

const MAPPING_TYPE_SCHEMA = {
    feature: {
        fields: [
            { key: 'featureId',  prompt: '  Feature ID: ',                        required: true },
            { key: 'maxScore',   prompt: '  Max score [0]: ',   type: 'int',      default: 0 },
            { key: 'minCount',   prompt: '  Min count [1]: ',   type: 'int',      default: 1 },
            { key: 'successMsg', prompt: '  Success message [Yes]: ',             default: 'Yes' },
            { key: 'failMsg',    prompt: '  Fail message [Missing]: ',            default: 'Missing' },
        ],
    },
    manual: {
        fields: [
            { key: 'maxScore', prompt: '  Max score [0]: ',  type: 'int', default: 0 },
            { key: 'msg',      prompt: '  Comment message [NEEDS MANUAL CHECK]: ', default: 'NEEDS MANUAL CHECK' },
        ],
    },
    lint: {
        fields: [
            { key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 },
            { key: 'severity', prompt: '  Severity:', type: 'options', options: [
                { label: 'errors',   value: 'errors',   desc: 'Only syntax/error-level issues' },
                { label: 'warnings', value: 'warnings', desc: 'Only style/warning-level issues' },
            ]},
        ],
    },
    html_validate: {
        fields: [
            { key: 'maxScore',  prompt: '  Max score [0]: ',                      type: 'int', default: 0 },
            { key: 'tolerance', prompt: '  Errors allowed for half credit [3]: ', type: 'int', default: 3 },
        ],
    },
    css_validate: {
        fields: [
            { key: 'maxScore',  prompt: '  Max score [0]: ',                      type: 'int', default: 0 },
            { key: 'tolerance', prompt: '  Errors allowed for half credit [3]: ', type: 'int', default: 3 },
        ],
    },
    name_check: {
        fields: [
            { key: 'maxScore',  prompt: '  Max score [0]: ',                          type: 'int', default: 0 },
            { key: 'tolerance', prompt: '  Bad names allowed for half credit [2]: ',  type: 'int', default: 2 },
        ],
    },
    deploy_check: {
        fixed:  { urlType: 'citstudent' },
        fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }],
    },
    url_check: {
        fixed:  { urlType: 'citstudent' },
        fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }],
    },
    github_repo: {
        fixed:  { linkUrlType: 'github' },
        fields: [
            { key: 'maxScore', prompt: '  Max score [0]: ',              type: 'int', default: 0 },
            { key: 'linkCell', prompt: '  Link cell (e.g. F20, or blank): ',          optional: true },
        ],
    },
    collaborator_check: {
        fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }],
    },
    gitignore_check: {
        fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }],
    },
    scripts_check: {
        fields: [
            { key: 'maxScore', prompt: '  Max score [0]: ',                            type: 'int', default: 0 },
            { key: 'scripts',  prompt: '  Scripts to check (comma-separated)',                      default: 'dev,build,test' },
        ],
    },
};

const GENERIC_MAPPING_SCHEMA = {
    fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }],
};

function guessMappingType(label) {
    const l = label.toLowerCase();
    if (/github.*repo|private\s*repo/.test(l))                  return 'github_repo';
    if (/\bnpm scripts\b|\bpackage scripts\b|dev.{0,10}build|build.{0,10}test/.test(l)) return 'scripts_check';
    if (/collaborator/.test(l))                                  return 'collaborator_check';
    if (/\.gitignore/.test(l))                                   return 'gitignore_check';
    if (/repo.hygiene|node.?modules.*repo/.test(l))              return 'repo_hygiene';
    if (/deploy|live\s*site|citstudent/.test(l))                return 'deploy_check';
    const hasBuild   = /build.{0,10}error|vite|webpack|bundle|npm\s*run/.test(l);
    const hasBrowser = /console.{0,10}error|browser.{0,10}error|runtime.{0,10}error/.test(l);
    if (hasBuild && hasBrowser) return 'build_and_browser_check';
    if (hasBuild)   return 'build_check';
    if (hasBrowser) return 'browser_check';
    if (/package\.json|npm\s*package|dependency/.test(l))       return 'package_check';
    if (/lint|eslint|code\s*style/.test(l))                     return 'lint';
    if (/\bhtml\b|index\.html/.test(l))                         return 'html_validate';
    if (/\bcss\b|stylesheet|style\s*sheet/.test(l))             return 'css_validate';
    if (/file\s*nam|folder\s*(structure|nam)|directory\s*(structure|nam)|naming\s*conventi/.test(l)) return 'name_check';
    if (/code\s*review|peer\s*review/.test(l))                  return 'code_review';
    if (/developer\s*(comment|name|date)|dev\s*name|name.*date.*file|jsdoc|documentation/.test(l)) return 'developer_comments';
    if (/\burl\b|live\s*link/.test(l))                          return 'url_check';
    if (/browser\s*check|runs?\s*in\s*browser/.test(l))         return 'browser_check';
    if (/all\s*app|apps?\s*in\s*repo/.test(l))                  return 'apps_in_repo';
    return 'manual';
}

// ── Config assembly ───────────────────────────────────────────────────────

function buildConfig(labName, responses) {
    const {
        extractOnly,
        rubricName, titleText, runtimeCheck, features, mappings, parts,
        variations, analyzerName, optional,
    } = responses;

    // Minimal extract-only config — no rubric, no runtime check, no grade generation
    if (extractOnly) {
        return { extractOnly: true, mappings: [] };
    }

    const config = { rubricName };

    if (optional.titleCell)    config.titleCell   = optional.titleCell;
    if (titleText)             config.titleText   = titleText;
    if (optional.summaryCell)  config.summaryCell = optional.summaryCell;
    if (optional.graderCell)   config.graderCell  = optional.graderCell;
    if (optional.codeReview)   config.codeReview  = optional.codeReview;

    config.runtimeCheck = runtimeCheck;

    if (variations)              config.variations   = variations;
    if (optional.packageCheck)   config.packageCheck = optional.packageCheck;
    if (optional.repoHygiene)    config.repoHygiene  = optional.repoHygiene;

    const lint = {};
    if (optional.lintExclude) lint.exclude = optional.lintExclude;
    if (Object.keys(lint).length > 0) config.lint = lint;

    const analysis = {};
    if (features.length > 0) analysis.features      = features;
    if (analyzerName)        analysis.customAnalyzer = analyzerName;
    if (parts)               analysis.parts          = parts;
    if (Object.keys(analysis).length > 0) config.analysis = analysis;

    config.mappings = mappings;

    return config;
}

function writeLab(labDir, config, analyzerContent, analyzerName) {
    const configPath = path.join(labDir, `${path.basename(labDir).toLowerCase()}_config.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log(`  Written: ${configPath}`);

    if (analyzerContent && analyzerName) {
        const analyzerPath = path.join(labDir, analyzerName);
        fs.writeFileSync(analyzerPath, analyzerContent, 'utf8');
        console.log(`  Written: ${analyzerPath}`);
    }
}

module.exports = {
    colLetter, excelCell, colLetterToIndex,
    normalizeAssignmentName,
    sheetRows, isBlankRow, cellText,
    POSSIBLE_HEADER_RE,
    detectRubricLayout,
    readRubricRows, readRubricCriteria,
    findSpreadsheets, getExistingAssignments, keywordsToFolderPattern,
    MAPPING_TYPES, MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA,
    guessMappingType,
    buildConfig, writeLab,
};
