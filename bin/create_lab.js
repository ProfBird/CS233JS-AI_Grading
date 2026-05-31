#!/usr/bin/env node
// Usage: node bin/create_lab.js [AssignmentName]
// Interactive wizard to create a new assignment configuration in configs/{AssignmentName}/

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const XLSX = require('xlsx');

const CONFIGS_DIR = path.join(__dirname, '..', 'configs');

function createRL() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdout.isTTY
    });
    const pending = [];
    let resolveWait = null;
    let eof = false;

    rl.on('line', (line) => {
        if (resolveWait) {
            resolveWait(line);
            resolveWait = null;
        } else {
            pending.push(line);
        }
    });

    rl.on('close', () => {
        eof = true;
        if (resolveWait) {
            resolveWait(null);
            resolveWait = null;
        }
    });

    rl._getLine = function (prompt) {
        return new Promise(resolve => {
            if (eof) { resolve(null); return; }
            process.stdout.write(prompt);
            if (pending.length > 0) {
                resolve(pending.shift());
            } else {
                resolveWait = resolve;
            }
        });
    };

    rl._close = () => rl.close();
    return rl;
}

async function ask(rl, question) {
    const raw = await rl._getLine(question);
    if (raw === null) throw new Error('Input stream ended unexpectedly');
    return raw.trim();
}

async function askOptions(rl, promptText, options, defaultIdx = 0) {
    console.log(`\n${promptText}`);
    options.forEach((opt, i) => {
        console.log(`  ${i + 1}) ${opt.label}${opt.desc ? ' — ' + opt.desc : ''}`);
    });
    while (true) {
        const raw = await ask(rl, `Choice [${defaultIdx + 1}]: `);
        if (raw === '') return options[defaultIdx].value;
        const idx = parseInt(raw, 10) - 1;
        if (idx >= 0 && idx < options.length) return options[idx].value;
        console.log('  Invalid choice, try again.');
    }
}

async function askBoolean(rl, question, defaultYes = false) {
    const suffix = defaultYes ? ' [Y/n]: ' : ' [y/N]: ';
    while (true) {
        const raw = await ask(rl, question + suffix);
        if (raw === '') return defaultYes;
        const lower = raw.toLowerCase();
        if (lower === 'y' || lower === 'yes') return true;
        if (lower === 'n' || lower === 'no') return false;
        console.log('  Please answer y or n.');
    }
}

async function askInt(rl, prompt, defaultVal = 0) {
    while (true) {
        const raw = await ask(rl, prompt);
        if (raw === '') return defaultVal;
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n >= 0) return n;
        console.log('  Please enter a non-negative integer.');
    }
}

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

function normalizeAssignmentName(input) {
    const trimmed = input.trim();
    // All-digits shorthand: "7" or "07" → "Lab07"
    if (/^\d+$/.test(trimmed)) {
        return `Lab${String(parseInt(trimmed, 10)).padStart(2, '0')}`;
    }
    // "Lab7", "lab07", "LAB7" → "Lab07"
    const m = trimmed.match(/^[Ll][Aa][Bb](\d+)$/);
    if (m) {
        return `Lab${String(parseInt(m[1], 10)).padStart(2, '0')}`;
    }
    // Arbitrary name: "TermProject", "FinalExam" → returned as-is
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed)) return trimmed;
    return null;  // invalid (empty, spaces, special chars)
}

// --- Rubric Reading for cell-by-cell mode ---

function sheetRows(ws) {
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

function isBlankRow(row) {
    return row.every(c => c === '' || c === null || c === undefined);
}

function cellText(row, i) {
    return (row[i] ?? '').toString().trim();
}

// Default header synonyms for the "max points" column.
const POSSIBLE_HEADER_RE = /^(possible|points?|pts|max)$/i;

// Converts a column letter (A, B, C, … AA, AB …) to a 0-based index.
function colLetterToIndex(letter) {
    const upper = letter.toUpperCase().trim();
    let idx = 0;
    for (const ch of upper) idx = idx * 26 + (ch.charCodeAt(0) - 64);
    return idx - 1;
}

// Detects the rubric column layout from an already-read rows array.
// Returns { headerRow, possibleCol, scoreCol, commentCol } or null if header not found.
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

    return { headerRow, possibleCol, scoreCol, commentCol };
}

// Reads rubric rows using a pre-confirmed layout object or an optional custom headerLabel.
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

    // Accept either a pre-built layout object or a string header label (or null = auto).
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

    let tableEnd = rows.length;
    for (let i = headerRow + 1; i < rows.length; i++) {
        if (/^comments$/i.test(cellText(rows[i], 0))) {
            tableEnd = i;
            break;
        }
    }

    const rubricRows = [];
    for (let i = headerRow + 1; i < tableEnd; i++) {
        const row = rows[i];
        if (isBlankRow(row)) continue;
        // Label: col 0 for section headers, col 1 for indented items.
        const label = cellText(row, 0) || cellText(row, 1);
        if (!label) continue;

        const lower = label.toLowerCase();
        if (lower.startsWith('total') || lower.startsWith('sub-total')) continue;

        const possible = cellText(row, possibleCol);
        const isSectionHeader = possible === ''
            && cellText(row, scoreCol)   === ''
            && cellText(row, commentCol) === '';

        rubricRows.push({
            excelRow: i + 1,
            label,
            possible,
            scoreCell:   excelCell(scoreCol,   i + 1),
            commentCell: excelCell(commentCol, i + 1),
            isSectionHeader
        });
    }
    return rubricRows;
}

// Converts space-separated keywords into a case-insensitive OR regex for folder matching.
// e.g. "dev env" → "dev|env"  (any keyword present in the folder name is a match)
function keywordsToFolderPattern(keywords) {
    const words = keywords.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    return words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

// Returns spreadsheet paths (relative to dir) found in dir and its immediate sub-folders.
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
                if (/\.(xlsx|xlsm)$/i.test(sub)) {
                    results.push(path.join(entry, sub));
                }
            }
        }
    }
    return results;
}

// Interactive rubric reader: auto-detects column layout, shows it, and lets the grader
// confirm or correct columns before the mapping wizard runs.
async function promptRubricRows(rl, rubricPath) {
    // Step 1: read the raw sheet rows (needed for both detection and final parse).
    let wb;
    try { wb = XLSX.readFile(rubricPath); } catch (e) {
        console.error(`  Could not read rubric file: ${e.message}`);
        return null;
    }
    const ws = wb && wb.Sheets['Grade'];
    if (!ws) { console.error('  No "Grade" sheet found in the rubric.'); return null; }
    const rows = sheetRows(ws);

    // Step 2: auto-detect layout; ask for the header label if not found.
    let layout = detectRubricLayout(rows);
    if (!layout) {
        console.error('  Could not find the max-points column header (tried: possible, points, pts, max).');
        const alt = await ask(rl,
            '  What is the exact header text for the max-points column? (blank to skip mappings): ');
        if (!alt) return null;
        const altRe = new RegExp(`^${alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        layout = detectRubricLayout(rows, altRe);
        if (!layout) {
            console.error(`  Still could not find "${alt}" in Grade sheet. Skipping mappings.`);
            return null;
        }
    }

    // Step 3: show detected columns and let the grader confirm or correct them.
    console.log(`  Detected columns in Grade sheet (row ${layout.headerRow + 1}):`);
    console.log(`    Max points : ${colLetter(layout.possibleCol)}`);
    console.log(`    Score      : ${colLetter(layout.scoreCol)}`);
    console.log(`    Comments   : ${colLetter(layout.commentCol)}`);

    const ok = await askBoolean(rl, '  Are these columns correct?', true);
    if (!ok) {
        const p = await ask(rl, `  Max-points column letter [${colLetter(layout.possibleCol)}]: `);
        const s = await ask(rl, `  Score/grade column letter [${colLetter(layout.scoreCol)}]: `);
        const c = await ask(rl, `  Comments column letter [${colLetter(layout.commentCol)}]: `);
        if (p) layout.possibleCol = colLetterToIndex(p);
        if (s) layout.scoreCol    = colLetterToIndex(s);
        if (c) layout.commentCol  = colLetterToIndex(c);
    }

    // Step 4: parse and return rows using the confirmed layout.
    return readRubricRows(rubricPath, layout);
}

// --- Rubric copy ---

async function copyRubric(rl, labName) {
    console.log('\n--- Rubric Spreadsheet ---');
    console.log('  The rubric spreadsheet (.xlsx or .xlsm) is required.');
    console.log('  It should have a "Grade" sheet with the grading rubric table.\n');

    let rubricPath;
    for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await ask(rl, 'Path to rubric file: ');
        rubricPath = raw.replace(/^["']|["']$/g, '');
        if (fs.existsSync(rubricPath)) break;
        console.log(`  File not found: ${rubricPath}`);
        rubricPath = null;
    }
    if (!rubricPath) {
        console.log('  No rubric provided after 3 attempts. Aborting.');
        process.exit(1);
    }

    const ext = path.extname(rubricPath).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xlsm') {
        console.log('  Warning: rubric should be .xlsx or .xlsm. Copying anyway.');
    }

    const suggestedName = `CS233JS_${labName}_Rubric${ext}`;
    console.log(`  Suggested name: ${suggestedName}`);
    const nameInput = await ask(rl, '  Use this name? Press Enter to accept, or type a new name: ');
    const rubricName = nameInput || suggestedName;

    return { rubricPath, rubricName, ext };
}

// --- Feature prompts ---

async function promptFeatures(rl) {
    console.log('\n--- Features (regex-based code analysis) ---');
    console.log('  Features are patterns found in student .js files.');
    console.log('  For each feature, provide an id, a regex pattern, and optionally a file name pattern.\n');

    const features = [];
    while (true) {
        const addMore = await askBoolean(rl, 'Add a feature?', features.length === 0);
        if (!addMore) break;

        const id = await ask(rl, '  Feature ID (e.g. fetch_api): ');
        if (!id) {
            console.log('  Feature ID is required. Skipping.');
            continue;
        }

        let regex = '';
        while (true) {
            regex = await ask(rl, '  Regex pattern: ');
            if (!regex) { console.log('  Regex pattern is required.'); continue; }
            try { new RegExp(regex); break; } catch (e) { console.log(`  Invalid regex: ${e.message}`); }
        }

        const fileRegex = await ask(rl, '  File name pattern (optional, e.g. \\.js$): ');

        const feat = { id, regex };
        if (fileRegex) feat.fileRegex = fileRegex;
        features.push(feat);
        console.log(`  Added feature "${id}".`);
    }
    return features;
}

// --- Mapping types ---

const MAPPING_TYPES = [
    { label: 'feature', value: 'feature', desc: 'Regex feature count → score' },
    { label: 'manual', value: 'manual', desc: 'Manual review item (uses code review form scores)' },
    { label: 'lint', value: 'lint', desc: 'ESLint errors or warnings' },
    { label: 'code_review', value: 'code_review', desc: 'Code review form submitted + production completed' },
    { label: 'deploy_check', value: 'deploy_check', desc: 'Check citstudent deployment (bundled + reachable)' },
    { label: 'build_check', value: 'build_check', desc: 'npm install && npm run build check' },
    { label: 'browser_check', value: 'browser_check', desc: 'Puppeteer browser runtime check' },
    { label: 'package_check', value: 'package_check', desc: 'Verify package.json dependencies' },
    { label: 'github_repo', value: 'github_repo', desc: 'GitHub repo link check' },
    { label: 'repo_hygiene', value: 'repo_hygiene', desc: 'Check excluded folders not in git' },
    { label: 'developer_comments', value: 'developer_comments', desc: 'Sufficient developer comments' },
    { label: 'url_check', value: 'url_check', desc: 'URL reachability check' },
    { label: 'part_completed', value: 'part_completed', desc: 'Multi-part: subdir completion check' },
    { label: 'part1_completed', value: 'part1_completed', desc: 'Single-part: part 1 completion check' },
    { label: 'apps_in_repo', value: 'apps_in_repo', desc: 'All expected apps present in repo' },
    { label: 'npm_package', value: 'npm_package', desc: 'npm package used check (Lab05 canvas)' },
];

// Guesses the most likely mapping type for a rubric row based on its label text.
function guessMappingType(label) {
    const l = label.toLowerCase();
    if (/github.*repo|private\s*repo/.test(l))                  return 'github_repo';
    if (/\.gitignore|repo.hygiene|node.?modules.*repo/.test(l)) return 'repo_hygiene';
    if (/deploy|live\s*site|citstudent/.test(l))                return 'deploy_check';
    if (/build|vite|webpack|bundle|npm\s*run/.test(l))          return 'build_check';
    if (/package\.json|npm\s*package|dependency/.test(l))       return 'package_check';
    if (/lint|eslint|code\s*style/.test(l))                     return 'lint';
    if (/code\s*review|peer\s*review/.test(l))                  return 'code_review';
    if (/developer\s*comment|jsdoc|documentation/.test(l))      return 'developer_comments';
    if (/\burl\b|live\s*link/.test(l))                          return 'url_check';
    if (/browser\s*check|runs?\s*in\s*browser/.test(l))         return 'browser_check';
    if (/all\s*app|apps?\s*in\s*repo/.test(l))                  return 'apps_in_repo';
    return 'manual';
}

async function promptMappingCellByCell(rl, rubricRows) {
    console.log('\n--- Rubric Mappings (cell-by-cell) ---');
    console.log('  For each row in the rubric, choose a mapping type or skip.\n');

    console.log('Rubric rows found:');
    rubricRows.forEach((rr, i) => {
        const prefix = rr.isSectionHeader ? '[SECTION] ' : '';
        console.log(`  ${i + 1}) ${prefix}${rr.label}  (score cell: ${rr.scoreCell})`);
    });

    const mappings = [];
    for (const rr of rubricRows) {
        if (rr.isSectionHeader) {
            console.log(`\n  Skipping section header: "${rr.label}"`);
            continue;
        }

        console.log(`\n  Row: "${rr.label}"  [score cell: ${rr.scoreCell}, comment: ${rr.commentCell}]`);

        const shouldMap = await askBoolean(rl, '  Map this row?', false);
        if (!shouldMap) continue;

        const guessed = guessMappingType(rr.label);
        const guessedIdx = Math.max(0, MAPPING_TYPES.findIndex(t => t.value === guessed));
        const type = await askOptions(rl, '  Mapping type:', MAPPING_TYPES, guessedIdx);
        const mapping = await buildMappingEntry(rl, type, rr);
        if (mapping) mappings.push(mapping);
    }
    return mappings;
}

const CHECKLIST_TYPES = [
    'feature', 'manual', 'lint', 'code_review', 'deploy_check',
    'build_check', 'browser_check', 'package_check', 'github_repo',
    'repo_hygiene', 'developer_comments', 'url_check',
    'part_completed', 'part1_completed', 'apps_in_repo', 'npm_package',
];

async function promptMappingsChecklist(rl) {
    console.log('\n--- Rubric Mappings (checklist) ---');
    console.log('  Walk through common mapping types and configure each one you need.\n');

    const mappings = [];
    for (const type of CHECKLIST_TYPES) {
        const want = await askBoolean(rl, `Add "${type}" mapping?`, false);
        if (!want) continue;

        const cell = await ask(rl, '  Score cell (e.g. C13): ');
        const commentCell = await ask(rl, '  Comment cell (e.g. E13, or blank): ');

        const schema = MAPPING_TYPE_SCHEMA[type] ?? GENERIC_MAPPING_SCHEMA;
        const fields = await promptFields(rl, schema.fields);
        if (fields === null) continue;

        const m = { type, cell, ...(schema.fixed ?? {}), ...fields };
        if (commentCell) m.commentCell = commentCell;
        mappings.push(m);
    }
    return mappings;
}

// Schema describing per-type fields beyond cell/commentCell.
// Each entry: fields[] — prompt descriptors; fixed{} — hardcoded key/value additions.
// Field types: 'int' (re-prompts on bad input), 'options' (askOptions), default = string.
// Field flags: required (null answer aborts entry), optional (empty answer skips key).
const MAPPING_TYPE_SCHEMA = {
    feature: {
        fields: [
            { key: 'featureId',  prompt: '  Feature ID: ',                            required: true },
            { key: 'maxScore',   prompt: '  Max score [0]: ',     type: 'int',        default: 0 },
            { key: 'minCount',   prompt: '  Min count [1]: ',     type: 'int',        default: 1 },
            { key: 'successMsg', prompt: '  Success message [Yes]: ',                 default: 'Yes' },
            { key: 'failMsg',    prompt: '  Fail message [Missing]: ',                default: 'Missing' },
        ]
    },
    manual: {
        fields: [
            { key: 'maxScore', prompt: '  Max score [0]: ',  type: 'int', default: 0 },
            { key: 'msg',      prompt: '  Comment message [NEEDS MANUAL CHECK]: ',   default: 'NEEDS MANUAL CHECK' },
        ]
    },
    lint: {
        fields: [
            { key: 'maxScore',  prompt: '  Max score [0]: ', type: 'int', default: 0 },
            { key: 'severity',  prompt: '  Severity:', type: 'options', options: [
                { label: 'errors',   value: 'errors',   desc: 'Only syntax/error-level issues' },
                { label: 'warnings', value: 'warnings', desc: 'Only style/warning-level issues' },
            ]},
        ]
    },
    deploy_check: {
        fixed:  { urlType: 'citstudent' },
        fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }]
    },
    url_check: {
        fixed:  { urlType: 'citstudent' },
        fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }]
    },
    github_repo: {
        fixed:  { linkUrlType: 'github' },
        fields: [
            { key: 'maxScore',  prompt: '  Max score [0]: ',             type: 'int', default: 0 },
            { key: 'linkCell',  prompt: '  Link cell (e.g. F20, or blank): ',        optional: true },
        ]
    },
};
const GENERIC_MAPPING_SCHEMA = {
    fields: [{ key: 'maxScore', prompt: '  Max score [0]: ', type: 'int', default: 0 }]
};

// Prompts the type-specific fields for a mapping entry and returns a plain object.
// Returns null if a required field is empty (signals the caller to abort this entry).
async function promptFields(rl, fields, currentValues = {}) {
    const result = {};
    for (const f of fields) {
        const cur = currentValues[f.key];
        if (f.type === 'int') {
            const def = cur ?? f.default ?? 0;
            const promptText = /\[/.test(f.prompt)
                ? f.prompt.replace(/\[.*?\]/, `[${def}]`)
                : f.prompt.replace(/:\s*$/, ` [${def}]:`);
            result[f.key] = await askInt(rl, promptText, def);
        } else if (f.type === 'options') {
            const defIdx = cur !== undefined
                ? Math.max(0, f.options.findIndex(o => o.value === cur))
                : 0;
            result[f.key] = await askOptions(rl, f.prompt, f.options, defIdx);
        } else {
            const def = cur ?? f.default ?? '';
            const promptText = def ? f.prompt.replace(/:\s*$/, ` [${def}]: `) : f.prompt;
            const raw = await ask(rl, promptText);
            if (f.required && !raw && !def) return null;
            if (f.optional && !raw && !def) continue;
            result[f.key] = raw || def;
        }
    }
    return result;
}

async function buildMappingEntry(rl, type, rubricRow, currentValues = {}) {
    const cell = rubricRow.scoreCell;
    const commentCell = rubricRow.commentCell;
    const schema = MAPPING_TYPE_SCHEMA[type] ?? GENERIC_MAPPING_SCHEMA;
    const fields = await promptFields(rl, schema.fields, currentValues);
    if (fields === null) return null;
    const m = { type, cell, ...(schema.fixed ?? {}), ...fields };
    if (commentCell) m.commentCell = commentCell;
    return m;
}

// --- Parts (multi-part lab) ---

async function promptParts(rl, labDir = null) {
    console.log('\n--- Multi-Part Lab ---');
    const hasParts = await askBoolean(rl, 'Is this a multi-part lab (separate submissions per part)?', false);
    if (!hasParts) return null;

    const parts = [];
    while (true) {
        const addPrompt = parts.length === 0 ? 'Add a part?' : 'Add another part?';
        if (!await askBoolean(rl, addPrompt, false)) break;
        console.log(`\n  Part ${parts.length + 1}:`);
        const partId = await ask(rl, '  Part ID (e.g. DevEnvAndStaticSite): ') || `part${i + 1}`;

        // Auto-detect rubric from labDir/partId/ if the folder exists
        let rubricName = '';
        if (labDir) {
            const partSubDir = path.join(labDir, partId);
            if (fs.existsSync(partSubDir) && fs.statSync(partSubDir).isDirectory()) {
                const found = fs.readdirSync(partSubDir).filter(f => /\.(xlsx|xlsm)$/i.test(f));
                if (found.length === 1) {
                    const detected = path.join(partId, found[0]);
                    console.log(`  Found rubric: ${detected}`);
                    const override = await ask(rl, `  Rubric filename [${detected}]: `);
                    rubricName = override || detected;
                } else if (found.length > 1) {
                    rubricName = await askOptions(rl, '  Multiple spreadsheets found — which is the rubric?',
                        found.map(f => ({ label: path.join(partId, f), value: path.join(partId, f) })));
                }
            }
        }
        if (!rubricName) {
            rubricName = await ask(rl, '  Rubric filename for this part (e.g. DevEnvAndStaticSite/Rubric.xlsm, or blank): ');
        }

        // folderPattern: only needed when students submit one repo with sub-folders per part.
        // Converted from plain keywords to a regex stored in the config.
        const keywords = await ask(rl,
            '  Keywords to find this part\'s sub-folder in the student\'s repo (e.g. "dev env", blank if not applicable): ');
        const folderPattern = keywordsToFolderPattern(keywords);

        const hasVariations = await askBoolean(rl, '  Does this part have A/B/C variations?', false);
        let variations = null;
        if (hasVariations) {
            variations = {};
            for (const group of ['A', 'B', 'C']) {
                const appName = await ask(rl, `  Group ${group} app name: `);
                if (appName) variations[group] = { appName };
            }
        }

        const hasFeatureCounts = await askBoolean(rl, '  Does this part have per-part feature counts?', false);
        let featureCounts = [];
        if (hasFeatureCounts) {
            while (true) {
                const add = await askBoolean(rl, '    Add a feature count?', featureCounts.length === 0);
                if (!add) break;
                const featureId = await ask(rl, '    Feature ID: ');
                const minCount = parseInt(await ask(rl, '    Min count: '), 10) || 1;
                const cell = await ask(rl, '    Score cell: ');
                const commentCell = await ask(rl, '    Comment cell (or blank): ');
                const maxScore = parseInt(await ask(rl, '    Max score: '), 10) || 0;
                const successMsg = await ask(rl, '    Success message [Yes]: ') || 'Yes';
                const failMsg = await ask(rl, '    Fail message [Missing]: ') || 'Missing';

                const fc = { featureId, minCount, cell, maxScore, successMsg, failMsg };
                if (commentCell) fc.commentCell = commentCell;
                featureCounts.push(fc);
            }
        }

        const part = { id: partId };
        if (rubricName) part.rubricName = rubricName;
        if (folderPattern) part.folderPattern = folderPattern;
        if (variations && Object.keys(variations).length > 0) part.variations = variations;
        if (featureCounts.length > 0) part.featureCounts = featureCounts;
        parts.push(part);
    }
    return parts.length > 0 ? parts : null;
}

// --- Variations ---

async function promptVariations(rl) {
    console.log('\n--- Lab Variations (A/B/C groups) ---');
    const hasVariations = await askBoolean(rl, 'Does this lab have A/B/C group variations?', false);
    if (!hasVariations) return null;

    const variations = {};
    for (const group of ['A', 'B', 'C']) {
        const appName = await ask(rl, `Group ${group} app name (or blank to skip): `);
        if (appName) variations[group] = { appName };
    }
    return Object.keys(variations).length > 0 ? variations : null;
}

// --- Custom analyzer ---

async function promptAnalyzer(rl, labName) {
    console.log('\n--- Custom Analyzer ---');
    const want = await askBoolean(rl, 'Create a custom analyzer (labXX_analyzer.js)?', false);
    if (!want) return null;

    const content = `module.exports = function analyze(jsFiles, analysis, config, student) {
    // Custom analysis logic here
    // Use student.codeReview?.group for A/B/C variation logic
    // Modify analysis.features or return { reportSections: [...] }
    return {};
};
`;
    return content;
}

// --- Optional fields ---

async function promptOptionalFields(rl) {
    console.log('\n--- Optional Fields ---');

    const summaryCell = await ask(rl, 'Summary cell (for AI/manual summary, e.g. A2, or blank): ');
    const graderCell = await ask(rl, 'Grader cell (e.g. E1, or blank): ');
    const titleCell = await ask(rl, 'Title cell (e.g. A1, or blank): ');

    const hasCodeReview = await askBoolean(rl, 'Does this lab have a code review form?', false);
    let codeReview = null;
    if (hasCodeReview) {
        const studentNameCell = await ask(rl, '  Student name cell [B1]: ') || 'B1';
        const groupCell = await ask(rl, '  Group letter cell [C1]: ') || 'C1';
        codeReview = { studentNameCell, groupCell };
    }

    const hasLintExclude = await askBoolean(rl, 'Add lint exclusions?', false);
    let lintExclude = null;
    if (hasLintExclude) {
        const raw = await ask(rl, '  Excluded folders (comma-separated, e.g. node_modules,dist): ');
        lintExclude = raw.split(',').map(s => s.trim()).filter(Boolean);
    }

    const hasPackageCheck = await askBoolean(rl, 'Add package.json dependency check?', false);
    let packageCheck = null;
    if (hasPackageCheck) {
        const depsRaw = await ask(rl, '  Required dependencies (comma-separated, e.g. lit-html,bootstrap): ');
        const devDepsRaw = await ask(rl, '  Required devDependencies (comma-separated, e.g. vite): ');
        packageCheck = {};
        const deps = depsRaw.split(',').map(s => s.trim()).filter(Boolean);
        const devDeps = devDepsRaw.split(',').map(s => s.trim()).filter(Boolean);
        if (deps.length > 0) packageCheck.dependencies = deps;
        if (devDeps.length > 0) packageCheck.devDependencies = devDeps;
    }

    const hasRepoHygiene = await askBoolean(rl, 'Add repo hygiene check (excluded folders in git)?', false);
    let repoHygiene = null;
    if (hasRepoHygiene) {
        const raw = await ask(rl, '  Excluded folder names (comma-separated, e.g. node_modules,dist,.DS_Store): ');
        const excluded = raw.split(',').map(s => s.trim()).filter(Boolean);
        if (excluded.length > 0) repoHygiene = { excludedFromRepo: excluded };
    }

    return { summaryCell, graderCell, titleCell, codeReview, lintExclude, packageCheck, repoHygiene };
}

// --- Assemble and write ---

function buildConfig(labName, responses) {
    const {
        rubricName, titleText, runtimeCheck, features, mappings, parts,
        variations, analyzerName, optional
    } = responses;

    const config = { rubricName };

    if (optional.titleCell) config.titleCell = optional.titleCell;
    if (titleText) config.titleText = titleText;
    if (optional.summaryCell) config.summaryCell = optional.summaryCell;
    if (optional.graderCell) config.graderCell = optional.graderCell;
    if (optional.codeReview) config.codeReview = optional.codeReview;

    config.runtimeCheck = runtimeCheck;

    if (variations) config.variations = variations;
    if (optional.packageCheck) config.packageCheck = optional.packageCheck;
    if (optional.repoHygiene) config.repoHygiene = optional.repoHygiene;

    const lint = {};
    if (optional.lintExclude) lint.exclude = optional.lintExclude;
    if (Object.keys(lint).length > 0) config.lint = lint;

    const analysis = {};
    if (features.length > 0) analysis.features = features;
    if (analyzerName) analysis.customAnalyzer = analyzerName;
    if (parts) analysis.parts = parts;
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

// Focused wizard: configure one part (rubric + mappings) and merge into existing config.
async function runPartSetup(rl, labDir, labName, existingConfig) {
    const existingParts = existingConfig?.analysis?.parts || [];

    // Which part to configure?
    let partIdx = -1; // -1 = new
    if (existingParts.length > 0) {
        console.log('\nExisting parts:');
        existingParts.forEach((p, i) =>
            console.log(`  ${i + 1}) ${p.id}${p.rubricName ? '  →  ' + p.rubricName : ''}`));
        const choices = [
            { label: 'Add a new part', value: -1 },
            ...existingParts.map((p, i) => ({ label: `Update "${p.id}"`, value: i })),
        ];
        partIdx = await askOptions(rl, 'Which part?', choices);
    }
    const existingPart = partIdx >= 0 ? existingParts[partIdx] : null;

    // Part ID
    let partId;
    if (existingPart) {
        const ovr = await ask(rl, `\n  Part ID [${existingPart.id}]: `);
        partId = ovr || existingPart.id;
    } else {
        partId = await ask(rl, '\n  Part ID (e.g. DevEnvAndStaticSite): ');
        if (!partId) { console.log('  Part ID is required. Aborting.'); return; }
    }

    // Rubric: auto-detect from labDir/partId/, then fall back to prompt
    let rubricName = existingPart?.rubricName || '';
    const partSubDir = path.join(labDir, partId);
    const xlFiles = fs.existsSync(partSubDir) && fs.statSync(partSubDir).isDirectory()
        ? fs.readdirSync(partSubDir).filter(f => /\.(xlsx|xlsm)$/i.test(f))
        : [];

    if (xlFiles.length === 1) {
        const detected = path.join(partId, xlFiles[0]);
        if (detected === rubricName) {
            console.log(`  Rubric: ${rubricName}`);
        } else {
            console.log(`  Found rubric: ${detected}`);
            const ovr = await ask(rl, `  Rubric filename [${detected}]: `);
            rubricName = ovr || detected;
        }
    } else if (xlFiles.length > 1) {
        rubricName = await askOptions(rl, '  Multiple spreadsheets found — which is the rubric?',
            xlFiles.map(f => ({ label: path.join(partId, f), value: path.join(partId, f) })));
    } else if (rubricName) {
        console.log(`  Rubric: ${rubricName}`);
    } else {
        rubricName = await ask(rl, '  Rubric filename (e.g. DevEnvAndStaticSite/Rubric.xlsm, or blank): ');
    }

    // Keywords for folder matching
    const keywords = await ask(rl,
        '  Keywords to find this part\'s folder in student repos (blank if not applicable): ');
    const folderPattern = keywords
        ? keywordsToFolderPattern(keywords)
        : (existingPart?.folderPattern || '');

    // Build updated part entry (preserve existing featureCounts / variations)
    const updatedPart = { id: partId };
    if (rubricName) updatedPart.rubricName = rubricName;
    if (folderPattern) updatedPart.folderPattern = folderPattern;
    if (existingPart?.variations) updatedPart.variations = existingPart.variations;
    if (existingPart?.featureCounts) updatedPart.featureCounts = existingPart.featureCounts;

    // Mappings: cell-by-cell from this part's rubric
    const rubricPath = rubricName ? path.join(labDir, rubricName) : null;
    const rubricRows = rubricPath ? await promptRubricRows(rl, rubricPath) : null;
    let mappings = existingConfig?.mappings || [];
    if (rubricRows) {
        mappings = await promptMappingCellByCell(rl, rubricRows);
    } else if (rubricPath) {
        console.log('  Skipping mappings.');
    } else {
        console.log('  No rubric specified — keeping existing mappings.');
    }

    // Merge into config
    const cfg = existingConfig
        ? JSON.parse(JSON.stringify(existingConfig))
        : { rubricName: '', runtimeCheck: 'browser', mappings: [] };

    if (rubricName) cfg.rubricName = rubricName;
    cfg.mappings = mappings;

    const parts = [...(cfg.analysis?.parts || [])];
    if (partIdx >= 0) parts[partIdx] = updatedPart;
    else parts.push(updatedPart);
    cfg.analysis = { ...(cfg.analysis || {}), parts };
    if (!cfg.runtimeCheck) cfg.runtimeCheck = 'browser';

    console.log('\n--- Writing Files ---');
    writeLab(labDir, cfg, null, null);
    console.log('\n=== Done! ===');
    console.log(`  Part "${partId}" configured.`);
    console.log(`  Mappings: ${mappings.length} configured.`);
    if (rubricName) {
        console.log(`  Active rubric: ${rubricName}`);
        console.log('  To verify: node bin/rubric_to_md.js ' + JSON.stringify(path.join(labDir, rubricName)));
    }
    console.log();
}

// --- Main ---

async function main() {
    let labName = process.argv[2] || '';

    console.log('\n=== Create New Lab Configuration ===\n');

    const rl = createRL();

    try {
        // 1. Assignment name
        if (labName) {
            const parsed = normalizeAssignmentName(labName);
            if (!parsed) {
                console.error(`Invalid assignment name: ${labName}. Use a number (07), a lab name (Lab07), or a slug (TermProject).`);
                process.exit(1);
            }
            labName = parsed;
        } else {
            while (true) {
                const raw = await ask(rl, 'Assignment name (e.g. 07, Lab07, TermProject): ');
                const parsed = normalizeAssignmentName(raw);
                if (parsed) {
                    labName = parsed;
                    break;
                }
                console.log('  Please enter a name like "07", "Lab07", or "TermProject".');
            }
        }

        const labDir = path.join(CONFIGS_DIR, labName);
        let useExisting = false;
        if (fs.existsSync(labDir)) {
            console.log(`\n  Warning: Directory already exists: ${labDir}`);
            const choice = await askOptions(rl, '  How do you want to proceed?', [
                { label: 'Abort',                value: 'abort' },
                { label: 'Keep existing files',  value: 'keep',      desc: 'Preserves rubric and other files; rewrites config only' },
                { label: 'Overwrite everything', value: 'overwrite', desc: 'Full wizard, existing files may be replaced' },
            ]);
            if (choice === 'abort') {
                console.log('  Aborted.');
                process.exit(0);
            }
            useExisting = (choice === 'keep');
        } else {
            fs.mkdirSync(labDir, { recursive: true });
        }
        console.log(`  Lab directory: ${labDir}`);

        // 2. Rubric + mode selection
        let rubricName, rubricDest;
        if (useExisting) {
            // Read existing config (needed for part list and for the part-focused wizard)
            const configPath = path.join(labDir, `${labName.toLowerCase()}_config.json`);
            let existingConfig = null;
            try {
                if (fs.existsSync(configPath)) existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (e) { /* ignore */ }

            const mode = await askOptions(rl, 'What would you like to do?', [
                { label: 'Set up one part',   value: 'part', desc: 'Configure rubric and mappings for a specific part' },
                { label: 'Full wizard',       value: 'full', desc: 'Rebuild the entire config from scratch' },
            ]);

            if (mode === 'part') {
                await runPartSetup(rl, labDir, labName, existingConfig);
                return;
            }

            // Full wizard: detect top-level rubric
            const found = findSpreadsheets(labDir);
            if (found.length === 1) {
                rubricName = found[0];
                console.log(`  Using existing rubric: ${rubricName}`);
            } else if (found.length > 1) {
                rubricName = await askOptions(rl, '  Multiple spreadsheets found — which is the rubric?',
                    found.map(f => ({ label: f, value: f })));
            } else {
                console.log('  No spreadsheet found in existing directory. Please provide one to copy in.');
                const r = await copyRubric(rl, labName);
                rubricName = r.rubricName;
                fs.copyFileSync(r.rubricPath, path.join(labDir, rubricName));
                console.log(`  Copied rubric to: ${path.join(labDir, rubricName)}`);
            }
            rubricDest = path.join(labDir, rubricName);
        } else {
            // 2a. Optional sub-folders for lab parts
            let rubricSubDir = '';
            const wantSubFolders = await askBoolean(rl, 'Create sub-folders for lab parts?', false);
            if (wantSubFolders) {
                const subFolders = [];
                while (true) {
                    const name = await ask(rl, '  Sub-folder name (blank to finish): ');
                    if (!name) break;
                    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
                        console.log('  Invalid name. Use letters, numbers, underscores, or hyphens.');
                        continue;
                    }
                    fs.mkdirSync(path.join(labDir, name), { recursive: true });
                    console.log(`  Created: ${path.join(labDir, name)}`);
                    subFolders.push(name);
                }
                if (subFolders.length > 0) {
                    rubricSubDir = await askOptions(
                        rl, '  Place rubric in which folder?',
                        [
                            { label: '(root — no sub-folder)', value: '' },
                            ...subFolders.map(f => ({ label: f, value: f })),
                        ]
                    );
                }
            }

            // 2b. Copy rubric into chosen location
            const r = await copyRubric(rl, labName);
            const destDir = rubricSubDir ? path.join(labDir, rubricSubDir) : labDir;
            rubricName = rubricSubDir ? path.join(rubricSubDir, r.rubricName) : r.rubricName;
            rubricDest = path.join(labDir, rubricName);
            fs.copyFileSync(r.rubricPath, path.join(destDir, r.rubricName));
            console.log(`  Copied rubric to: ${rubricDest}`);
        }

        // 3. Title
        const titleText = await ask(rl, '\nLab title (e.g. Lab 7: Web Components): ');

        // 4. Runtime mode
        const runtimeCheck = await askOptions(rl, 'Runtime check mode:', [
            { label: 'browser', value: 'browser', desc: 'Puppeteer browser only' },
            { label: 'build', value: 'build', desc: 'npm install && npm run build only' },
            { label: 'both', value: 'both', desc: 'Browser + build' }
        ]);

        // 5. Parts
        const parts = await promptParts(rl, labDir);

        // 6. Variations
        const variations = await promptVariations(rl);

        // 7. Features
        const features = await promptFeatures(rl);

        // 8. Mappings — always cell-by-cell from rubric; checklist only as fallback
        let mappings;
        console.log('\n--- Rubric Mappings ---');
        const rubricRows = await promptRubricRows(rl, rubricDest);
        if (rubricRows) {
            mappings = await promptMappingCellByCell(rl, rubricRows);
        } else {
            console.log('  Could not read rubric. Falling back to simplified checklist.');
            mappings = await promptMappingsChecklist(rl);
        }

        if (mappings.length === 0) {
            console.log('\n  Warning: No rubric mappings configured. The config will have an empty mappings array.');
        }

        // 9. Optional fields
        const optional = await promptOptionalFields(rl);

        // 10. Custom analyzer
        const analyzerContent = await promptAnalyzer(rl, labName);
        const analyzerName = analyzerContent ? `${labName.toLowerCase()}_analyzer.js` : null;

        // 11. Assemble and write
        const config = buildConfig(labName, {
            rubricName, titleText, runtimeCheck, features, mappings,
            parts, variations, analyzerName, optional
        });

        console.log('\n--- Writing Files ---');
        writeLab(labDir, config, analyzerContent, analyzerName);

        console.log('\n=== Done! ===');
        console.log(`  Config written to: ${path.join(labDir, labName.toLowerCase() + '_config.json')}`);
        if (useExisting) {
            console.log(`  Existing files preserved (rubric and other files were not overwritten).`);
        } else {
            console.log(`  Rubric copied to: ${rubricDest}`);
        }
        if (analyzerName) {
            console.log(`  Analyzer created at: ${path.join(labDir, analyzerName)}`);
        }
        console.log('\n  You can now edit the config file to adjust cell references or add more mappings.');
        console.log('  To verify, run: node bin/rubric_to_md.js ' + JSON.stringify(rubricDest) + '\n');

    } finally {
        rl.close();
    }
}

// Export testable functions for unit tests
module.exports = {
    colLetter, excelCell, normalizeAssignmentName, cellText, isBlankRow,
    sheetRows, readRubricRows, buildConfig, buildMappingEntry, promptFields,
    promptFeatures, copyRubric, writeLab, findSpreadsheets, keywordsToFolderPattern,
    promptRubricRows, detectRubricLayout, colLetterToIndex, guessMappingType, POSSIBLE_HEADER_RE,
    askBoolean, askOptions, ask, askInt, createRL,
    MAPPING_TYPES, MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA,
};

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
