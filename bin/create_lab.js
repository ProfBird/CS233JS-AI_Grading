#!/usr/bin/env node
// Usage: node bin/create_lab.js [LabXX]
// Interactive wizard to create a new lab configuration in configs/LabXX/

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

async function askOptions(rl, promptText, options) {
    console.log(`\n${promptText}`);
    options.forEach((opt, i) => {
        console.log(`  ${i + 1}) ${opt.label}${opt.desc ? ' — ' + opt.desc : ''}`);
    });
    while (true) {
        const raw = await ask(rl, 'Choice [1]: ');
        if (raw === '') return options[0].value;
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

function colLetter(idx) {
    return String.fromCharCode(65 + idx);
}

function excelCell(col, row) {
    return colLetter(col) + row;
}

function parseLabNumber(input) {
    const m = input.match(/(\d+)/);
    if (!m) return null;
    const num = parseInt(m[1], 10);
    return `Lab${String(num).padStart(2, '0')}`;
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

function readRubricRows(rubricPath) {
    let wb;
    try { wb = XLSX.readFile(rubricPath); } catch (e) { return null; }
    const ws = wb.Sheets['Grade'];
    if (!ws) {
        console.error('  No "Grade" sheet found in the rubric.');
        return null;
    }
    const rows = sheetRows(ws);

    let headerRow = -1;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].some(c => /^possible$/i.test((c ?? '').toString().trim()))) {
            headerRow = i;
            break;
        }
    }
    if (headerRow < 0) {
        console.error('  Could not find header row (containing "Possible") in Grade sheet.');
        return null;
    }

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
        const label = cellText(row, 0);
        if (!label) continue;

        const lower = label.toLowerCase();
        if (lower.startsWith('total') || lower.startsWith('sub-total')) continue;

        const possible = cellText(row, 1);
        const isSectionHeader = possible === '' && cellText(row, 2) === '' && cellText(row, 4) === '';

        rubricRows.push({
            excelRow: i + 1,
            label,
            possible,
            scoreCell: excelCell(2, i + 1),
            commentCell: excelCell(4, i + 1),
            isSectionHeader
        });
    }
    return rubricRows;
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

        const regex = await ask(rl, '  Regex pattern: ');
        if (!regex) {
            console.log('  Regex pattern is required. Skipping.');
            continue;
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

        const skip = await askBoolean(rl, '  Map this row?', false);
        if (!skip) continue;

        const type = await askOptions(rl, '  Mapping type:', MAPPING_TYPES);
        const mapping = await buildMappingEntry(rl, type, rr);
        if (mapping) mappings.push(mapping);
    }
    return mappings;
}

async function promptMappingsChecklist(rl) {
    console.log('\n--- Rubric Mappings (checklist) ---');
    console.log('  Walk through common mapping types and configure each one you need.\n');

    const mappings = [];

    const typesToCheck = [
        'feature', 'manual', 'lint', 'code_review', 'deploy_check',
        'build_check', 'browser_check', 'package_check', 'github_repo',
        'repo_hygiene', 'developer_comments', 'url_check',
        'part_completed', 'part1_completed', 'apps_in_repo', 'npm_package'
    ];

    for (const type of typesToCheck) {
        const want = await askBoolean(rl, `Add "${type}" mapping?`, false);
        if (!want) continue;

        if (type === 'feature') {
            const featureId = await ask(rl, '  Feature ID to map: ');
            const cell = await ask(rl, '  Score cell (e.g. C13): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E13, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
            const minCount = parseInt(await ask(rl, '  Min count [1]: ') || '1', 10);
            const successMsg = await ask(rl, '  Success message [Yes]: ') || 'Yes';
            const failMsg = await ask(rl, '  Fail message [Missing]: ') || 'Missing';

            const m = { type, cell, maxScore, featureId, minCount, successMsg, failMsg };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'manual') {
            const cell = await ask(rl, '  Score cell (e.g. C9): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E9, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
            const msg = await ask(rl, '  Comment message [NEEDS MANUAL CHECK]: ') || 'NEEDS MANUAL CHECK';

            const m = { type, cell, maxScore, msg };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'lint') {
            const cell = await ask(rl, '  Score cell (e.g. C17): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E17, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
            const severity = await askOptions(rl, '  Severity:', [
                { label: 'errors', value: 'errors', desc: 'Only syntax/error-level issues' },
                { label: 'warnings', value: 'warnings', desc: 'Only style/warning-level issues' }
            ]);

            const m = { type, cell, maxScore, severity };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'code_review') {
            const cell = await ask(rl, '  Score cell (e.g. C25): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E25, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'deploy_check') {
            const cell = await ask(rl, '  Score cell (e.g. C22): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E22, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore, urlType: 'citstudent' };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'build_check' || type === 'browser_check') {
            const cell = await ask(rl, '  Score cell (e.g. C13): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E13, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'package_check') {
            const cell = await ask(rl, '  Score cell (e.g. C10): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E10, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'github_repo') {
            const cell = await ask(rl, '  Score cell (e.g. C20): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E20, or blank): ');
            const linkCell = await ask(rl, '  Link cell (e.g. F20, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore, linkUrlType: 'github' };
            if (commentCell) m.commentCell = commentCell;
            if (linkCell) m.linkCell = linkCell;
            mappings.push(m);
        } else if (type === 'repo_hygiene') {
            const cell = await ask(rl, '  Score cell (e.g. C23): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E23, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'developer_comments') {
            const cell = await ask(rl, '  Score cell (e.g. C24): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E24, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        } else if (type === 'url_check') {
            const cell = await ask(rl, '  Score cell (e.g. C24): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E24, or blank): ');
            const linkCell = await ask(rl, '  Link cell (e.g. F24, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore, urlType: 'citstudent' };
            if (commentCell) m.commentCell = commentCell;
            if (linkCell) m.linkCell = linkCell;
            mappings.push(m);
        } else if (type === 'part_completed' || type === 'part1_completed' || type === 'apps_in_repo' || type === 'npm_package') {
            const cell = await ask(rl, '  Score cell (e.g. C8): ');
            const commentCell = await ask(rl, '  Comment cell (e.g. E8, or blank): ');
            const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;

            const m = { type, cell, maxScore };
            if (commentCell) m.commentCell = commentCell;
            mappings.push(m);
        }
    }
    return mappings;
}

async function buildMappingEntry(rl, type, rubricRow) {
    const cell = rubricRow.scoreCell;
    const commentCell = rubricRow.commentCell;

    if (type === 'feature') {
        const featureId = await ask(rl, '  Feature ID: ');
        if (!featureId) return null;
        const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
        const minCount = parseInt(await ask(rl, '  Min count [1]: ') || '1', 10);
        const successMsg = await ask(rl, '  Success message [Yes]: ') || 'Yes';
        const failMsg = await ask(rl, '  Fail message [Missing]: ') || 'Missing';
        const m = { type, cell, maxScore, featureId, minCount, successMsg, failMsg };
        if (commentCell) m.commentCell = commentCell;
        return m;
    }

    if (type === 'manual') {
        const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
        const msg = await ask(rl, '  Comment message [NEEDS MANUAL CHECK]: ') || 'NEEDS MANUAL CHECK';
        const m = { type, cell, maxScore, msg };
        if (commentCell) m.commentCell = commentCell;
        return m;
    }

    if (type === 'lint') {
        const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
        const severity = await askOptions(rl, '  Severity:', [
            { label: 'errors', value: 'errors', desc: 'Only syntax/error-level issues' },
            { label: 'warnings', value: 'warnings', desc: 'Only style/warning-level issues' }
        ]);
        const m = { type, cell, maxScore, severity };
        if (commentCell) m.commentCell = commentCell;
        return m;
    }

    if (type === 'deploy_check') {
        const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
        const m = { type, cell, maxScore, urlType: 'citstudent' };
        if (commentCell) m.commentCell = commentCell;
        return m;
    }

    if (type === 'url_check') {
        const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
        const m = { type, cell, maxScore, urlType: 'citstudent' };
        if (commentCell) m.commentCell = commentCell;
        return m;
    }

    if (type === 'github_repo') {
        const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
        const linkCell = await ask(rl, '  Link cell (e.g. F20): ');
        const m = { type, cell, maxScore, linkUrlType: 'github' };
        if (commentCell) m.commentCell = commentCell;
        if (linkCell) m.linkCell = linkCell;
        return m;
    }

    // Generic: build_check, browser_check, package_check, repo_hygiene,
    // developer_comments, part_completed, part1_completed, apps_in_repo,
    // code_review, npm_package
    const maxScore = parseInt(await ask(rl, '  Max score: '), 10) || 0;
    const m = { type, cell, maxScore };
    if (commentCell) m.commentCell = commentCell;
    return m;
}

// --- Parts (multi-part lab) ---

async function promptParts(rl) {
    console.log('\n--- Multi-Part Lab ---');
    const hasParts = await askBoolean(rl, 'Is this a multi-part lab (separate submissions per part)?', false);
    if (!hasParts) return null;

    const parts = [];
    const numParts = parseInt(await ask(rl, 'How many parts? '), 10) || 0;
    for (let i = 0; i < numParts; i++) {
        console.log(`\n  Part ${i + 1}:`);
        const partId = await ask(rl, '  Part ID (e.g. part1): ') || `part${i + 1}`;
        const rubricTitleRow = parseInt(await ask(rl, '  Rubric title row number (in Grade sheet): '), 10) || 0;
        const folderPattern = await ask(rl, '  Folder name pattern (regex, e.g. (?:part|pt)\\s*[_-]?\\s*1): ') || '';

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
        if (rubricTitleRow) part.rubricTitleRow = rubricTitleRow;
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

// --- Main ---

async function main() {
    let labName = process.argv[2] || '';

    console.log('\n=== Create New Lab Configuration ===\n');

    const rl = createRL();

    try {
        // 1. Lab number
        if (labName) {
            const parsed = parseLabNumber(labName);
            if (!parsed) {
                console.error(`Invalid lab name: ${labName}. Use a number or "LabXX" format.`);
                process.exit(1);
            }
            labName = parsed;
        } else {
            while (true) {
                const raw = await ask(rl, 'Lab number (e.g. 07 for Lab07): ');
                const parsed = parseLabNumber(raw);
                if (parsed) {
                    labName = parsed;
                    break;
                }
                console.log('  Please enter a number like "07" or "7".');
            }
        }

        const labDir = path.join(CONFIGS_DIR, labName);
        if (fs.existsSync(labDir)) {
            console.log(`\n  Warning: Directory already exists: ${labDir}`);
            const overwrite = await askBoolean(rl, '  Continue and possibly overwrite files?', false);
            if (!overwrite) {
                console.log('  Aborted.');
                process.exit(0);
            }
        } else {
            fs.mkdirSync(labDir, { recursive: true });
        }
        console.log(`  Lab directory: ${labDir}`);

        // 2. Rubric
        const { rubricPath, rubricName } = await copyRubric(rl, labName);
        const rubricDest = path.join(labDir, rubricName);
        fs.copyFileSync(rubricPath, rubricDest);
        console.log(`  Copied rubric to: ${rubricDest}`);

        // 3. Title
        const titleText = await ask(rl, '\nLab title (e.g. Lab 7: Web Components): ');

        // 4. Runtime mode
        const runtimeCheck = await askOptions(rl, 'Runtime check mode:', [
            { label: 'browser', value: 'browser', desc: 'Puppeteer browser only' },
            { label: 'build', value: 'build', desc: 'npm install && npm run build only' },
            { label: 'both', value: 'both', desc: 'Browser + build' }
        ]);

        // 5. Parts
        const parts = await promptParts(rl);

        // 6. Variations
        const variations = await promptVariations(rl);

        // 7. Features
        const features = await promptFeatures(rl);

        // 8. Mappings
        let mappings;
        const mappingMode = await askOptions(rl, '\nMapping configuration mode:', [
            { label: 'cell-by-cell wizard', value: 'cellbycell', desc: 'Reads the rubric Grade sheet and walks through each row' },
            { label: 'simplified checklist', value: 'checklist', desc: 'Yes/no for each common mapping type' }
        ]);

        if (mappingMode === 'cellbycell') {
            const rubricRows = readRubricRows(rubricDest);
            if (rubricRows) {
                mappings = await promptMappingCellByCell(rl, rubricRows);
            } else {
                console.log('  Falling back to simplified checklist mode.');
                mappings = await promptMappingsChecklist(rl);
            }
        } else {
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
        console.log(`  Config created at: ${path.join(labDir, labName.toLowerCase() + '_config.json')}`);
        console.log(`  Rubric copied to: ${rubricDest}`);
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
    colLetter, excelCell, parseLabNumber, cellText, isBlankRow,
    sheetRows, readRubricRows, buildConfig, buildMappingEntry,
    askBoolean, askOptions, ask, createRL
};

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
