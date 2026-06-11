'use strict';
// Pure, UI-agnostic functions for lab configuration.
// No readline, no TUI, no process.exit. Safe to import from anywhere.

import fs from 'fs';
import path from 'path';
import XLSX from './xlsx.js';

// This module lives at src/lib/, two levels under the repo root, so reach the root
// with two '..' segments — matching the repoRoot convention in src/pipeline/lint_code.js.
// (The Phase 1 src/ move left this as a single '..', which resolved to the nonexistent
// src/configs and made getExistingAssignments return nothing.)
const CONFIGS_DIR = path.join(import.meta.dirname, '..', '..', 'configs');

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

/**
 * Returns the ordered list of step names for a multi-step lab (e.g. TermProject).
 * A step is a subdirectory of configs/{labName}/ that contains its own
 * {subdir_lower}_config.json.  Returns [] for flat (single-config) labs and for
 * labs whose top-level directory does not exist yet.
 *
 * @param {string} labName
 * @param {string} [configsDir] - Override the default CONFIGS_DIR (useful for tests).
 */
function getExistingSteps(labName, configsDir = CONFIGS_DIR) {
    const labTopDir = path.join(configsDir, labName);
    if (!fs.existsSync(labTopDir)) return [];
    // Flat lab — top-level config present, no steps
    if (fs.existsSync(path.join(labTopDir, `${labName.toLowerCase()}_config.json`))) return [];
    let entries;
    try { entries = fs.readdirSync(labTopDir); } catch (e) { return []; }
    return entries
        .filter(entry => {
            const full = path.join(labTopDir, entry);
            try { return fs.statSync(full).isDirectory(); } catch (e) { return false; }
        })
        .filter(entry =>
            fs.existsSync(path.join(labTopDir, entry, `${entry.toLowerCase()}_config.json`))
        )
        .sort();
}

/**
 * @param {string} [configsDir] - Override the default CONFIGS_DIR (useful for tests).
 */
function getExistingAssignments(configsDir = CONFIGS_DIR) {
    const results = [];
    let entries;
    try { entries = fs.readdirSync(configsDir); } catch (e) { return results; }
    for (const entry of entries) {
        const full = path.join(configsDir, entry);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (!stat.isDirectory()) continue;
        const configFile = path.join(full, `${entry.toLowerCase()}_config.json`);
        const hasTopLevelConfig = fs.existsSync(configFile);
        const steps = hasTopLevelConfig ? [] : getExistingSteps(entry, configsDir);
        const isMultiStep = steps.length > 0;
        results.push({ name: entry, hasConfig: hasTopLevelConfig || isMultiStep, isMultiStep, steps });
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
    { label: 'gitignore_check',       value: 'gitignore_check',       desc: 'Full credit if .gitignore exists; add requiredEntry to also verify a specific entry is listed' },
    { label: 'repo_hygiene',          value: 'repo_hygiene',          desc: 'Confirms excluded folders (node_modules, dist, etc.) are not committed' },
    { label: 'developer_comments',    value: 'developer_comments',    desc: 'Scans code files for developer name, date, and/or file-header comments' },
    { label: 'url_check',             value: 'url_check',             desc: 'Fetches a URL from the student\'s submission; full credit if HTTP 200' },
    { label: 'part_completed',        value: 'part_completed',        desc: 'Checks part folder presence; ONLY for multi-part labs with named game/app subfolders' },
    { label: 'part1_completed',       value: 'part1_completed',       desc: 'Checks that files for the first (or only) lab part are present' },
    { label: 'apps_in_repo',          value: 'apps_in_repo',          desc: 'Verifies the app (single-app) or all app subfolders (multi-app) exist in the cloned GitHub repo' },
    { label: 'npm_package',           value: 'npm_package',           desc: 'Checks that a specific npm package is imported in the student\'s code' },
    { label: 'scripts_check',         value: 'scripts_check',         desc: 'Verifies dev/build/test scripts are defined; runs build and test for errors' },
    { label: 'env_file_check',        value: 'env_file_check',        desc: 'Checks that a .env file with at least one KEY=VALUE pair was submitted; flags for manual review when not found (normal if gitignored)' },
    { label: 'path_exists',           value: 'path_exists',           desc: 'Full credit if any file whose path matches pathPattern exists in the repo; use for "file created" checks' },
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
        fields: [
            { key: 'maxScore',      prompt: '  Max score [0]: ',                                type: 'int', default: 0 },
            { key: 'requiredEntry', prompt: '  Required entry (e.g. .env, or blank to skip): ', optional: true },
        ],
    },
    env_file_check: {
        fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }],
    },
    path_exists: {
        fields: [
            { key: 'maxScore',     prompt: '  Max score [0]: ',                     type: 'int', default: 0 },
            { key: 'pathPattern',  prompt: '  Path pattern (substring or regex): ', required: true },
        ],
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
    // .gitignore rows must be tested first — they also mention ".env" and would otherwise
    // fall into the env_file_check branch below
    if (/\.env.*gitignore|gitignore.*\.env|env.*excluded.*repo|\.env.*not.*commit/.test(l)) return 'gitignore_check';
    // Env file / API key storage (before github_repo to avoid false match on "repo")
    if (/\.env.*(?:file|key|exist)|api.?key.*\.env|env.*api.?key|stored.*\.env/.test(l)) return 'env_file_check';
    // File/folder *organization* requires visual inspection — distinct from naming convention checks
    if (/(?:folder|file|directory).*organiz/.test(l))           return 'manual';
    // Specific file existence check
    if (/file\s+(?:exist|created?|present)|(?:exist|created?|present)\s+at\s+[a-z./]/.test(l))  return 'path_exists';
    // "App(s) in [a/private/GitHub] repo" → apps_in_repo; bare "GitHub repo" → github_repo
    if (/\bapp.{0,25}(?:github|private).*repo|\bapps?\s+in\s+(?:the\s+)?(?:a\s+)?(?:github|private|repo)/.test(l)) return 'apps_in_repo';
    if (/github.*repo|private\s*repo/.test(l))                  return 'github_repo';
    if (/\bnpm scripts\b|\bpackage scripts\b|dev.{0,10}build|build.{0,10}test/.test(l)) return 'scripts_check';
    if (/collaborator/.test(l))                                  return 'collaborator_check';
    if (/\.gitignore/.test(l))                                   return 'gitignore_check';
    if (/repo.hygiene|node.?modules.*repo/.test(l))              return 'repo_hygiene';
    if (/deploy|live\s*site|citstudent/.test(l))                return 'deploy_check';
    // "vite" alone is too broad — a row mentioning vite.config.js routes here wrongly.
    // Require "vite" to be near a build/error term to count as a build check.
    const hasBuild   = /build.{0,10}error|vite.{0,15}(?:error|fail|build|bundle)|webpack|bundle|npm\s*run/.test(l);
    const hasBrowser = /console.{0,10}error|browser.{0,10}error|runtime.{0,10}error|cors.{0,10}error/.test(l);
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

// Assign a key when the value is truthy; delete it otherwise. Lets the wizard both
// set and clear an optional field (e.g. blanking a cell reference removes the key).
function setOrDelete(obj, key, value) {
    if (value) obj[key] = value;
    else delete obj[key];
}

// Round-trip-safe config assembler for the configure_lab wizard.
//
// Re-running the wizard on an existing lab must not lose config the wizard doesn't
// prompt for. assembleConfig starts from a deep clone of the existing config and
// overwrites ONLY the keys the wizard owns, so analysis.customAnalyzer, validate,
// nameCheck, and any field added in the future survive a re-run untouched. (An
// earlier rebuild-from-scratch approach silently dropped them.)
//
// Wizard-owned keys: rubricName, titleText, titleCell, summaryCell, graderCell,
// runtimeCheck, mappings. A blank optional cell deletes that key (clearing is
// intentional). Every other section — codeReview, variations, packageCheck,
// repoHygiene, lint, validate, nameCheck, the whole analysis block — is preserved
// untouched. The wizard does not prompt for those, so it must not clobber them.
function assembleConfig(existingConfig, responses) {
    if (responses.extractOnly) {
        return { extractOnly: true, mappings: [] };
    }

    // Deep clone via JSON round-trip — config objects are pure JSON (read from and
    // written to JSON files), so this is lossless and avoids a global dependency.
    const config = existingConfig ? JSON.parse(JSON.stringify(existingConfig)) : {};
    // A former extract-only lab now being configured for real grading: drop the flag.
    delete config.extractOnly;

    const opt = responses.optional || {};
    config.rubricName = responses.rubricName;
    setOrDelete(config, 'titleText',   responses.titleText);
    setOrDelete(config, 'titleCell',   opt.titleCell);
    setOrDelete(config, 'summaryCell', opt.summaryCell);
    setOrDelete(config, 'graderCell',  opt.graderCell);
    config.runtimeCheck = responses.runtimeCheck;
    config.mappings     = responses.mappings;

    return config;
}

// Merge wizard-created feature definitions into config.analysis.features: replace any
// existing entry with the same id, keep all others, and create analysis/features if absent
// (e.g. a brand-new lab). Returns the same config object. Without this, a wizard-created
// `feature` mapping would reference an id that nothing produces → a silent 0.
function mergeFeatureDefs(config, featureDefs) {
    if (!featureDefs || featureDefs.length === 0) return config;
    if (!config.analysis) config.analysis = {};
    const newIds = new Set(featureDefs.map(d => d.id));
    const kept = (config.analysis.features || []).filter(f => !newIds.has(f.id));
    config.analysis.features = [...kept, ...featureDefs];
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

export {
    colLetter, excelCell, colLetterToIndex,
    normalizeAssignmentName,
    sheetRows, isBlankRow, cellText,
    POSSIBLE_HEADER_RE,
    detectRubricLayout,
    readRubricRows, readRubricCriteria,
    findSpreadsheets, getExistingAssignments, getExistingSteps, keywordsToFolderPattern,
    MAPPING_TYPES, MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA,
    guessMappingType,
    assembleConfig, mergeFeatureDefs, writeLab,
};
