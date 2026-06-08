#!/usr/bin/env node
// Usage: node bin/create_lab.js [AssignmentName]
// Interactive wizard to create a new assignment configuration in configs/{AssignmentName}/

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const {
    colLetter, excelCell, colLetterToIndex,
    normalizeAssignmentName, sheetRows, isBlankRow, cellText,
    POSSIBLE_HEADER_RE, detectRubricLayout,
    readRubricRows, readRubricCriteria,
    findSpreadsheets, getExistingAssignments, getExistingSteps, keywordsToFolderPattern,
    MAPPING_TYPES, MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA,
    guessMappingType, buildConfig, writeLab,
} = require('../lib/lab_config.js');

const configPrompts = require('../lib/config_prompts.js');

const CONFIGS_DIR = path.join(__dirname, '..', 'configs');

// ── Readline driver ───────────────────────────────────────────────────────

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
        if (resolveWait) { resolveWait(line); resolveWait = null; }
        else pending.push(line);
    });

    rl.on('close', () => {
        eof = true;
        if (resolveWait) { resolveWait(null); resolveWait = null; }
    });

    rl._getLine = function (prompt) {
        return new Promise(resolve => {
            if (eof) { resolve(null); return; }
            process.stdout.write(prompt);
            if (pending.length > 0) resolve(pending.shift());
            else resolveWait = resolve;
        });
    };

    rl._close = () => rl.close();
    return rl;
}

// Standalone readline primitives (kept for direct wizard use and tests).

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

// Wraps an rl instance into the driver interface expected by lib/config_prompts.js.
function makeRLDriver(rl) {
    return {
        ask: async (prompt, def = '') => {
            const formatted = def ? `${prompt} [${def}]: ` : `${prompt}: `;
            const raw = await rl._getLine(formatted);
            if (raw === null) throw new Error('Input stream ended unexpectedly');
            return raw.trim() || def;
        },
        askBoolean: (question, def = false) => askBoolean(rl, question, def),
        askInt: (prompt, def = 0) => askInt(rl, `${prompt} [${def}]: `, def),
        askOptions: (prompt, opts, defIdx = 0) => askOptions(rl, prompt, opts, defIdx),
        print: (line) => console.log(line),
        exit: (code = 0) => process.exit(code),
    };
}

// ── Flow function thin-wrappers ───────────────────────────────────────────
// These preserve the (rl, ...) signature that wizard code and tests rely on.

async function promptRubricRows(rl, rubricPath) {
    return configPrompts.promptRubricRows(makeRLDriver(rl), rubricPath);
}

async function copyRubric(rl, labName) {
    return configPrompts.copyRubric(makeRLDriver(rl), labName);
}

async function promptFields(rl, fields, currentValues = {}) {
    return configPrompts.promptFields(makeRLDriver(rl), fields, currentValues);
}

async function buildMappingEntry(rl, type, rubricRow, currentValues = {}) {
    return configPrompts.buildMappingEntry(makeRLDriver(rl), type, rubricRow, currentValues);
}

// ── Feature prompts ───────────────────────────────────────────────────────

async function promptFeatures(rl) {
    console.log('\n--- Features (regex-based code analysis) ---');
    console.log('  Features are patterns found in student .js files.');
    console.log('  For each feature, provide an id, a regex pattern, and optionally a file name pattern.\n');

    const features = [];
    while (true) {
        const addMore = await askBoolean(rl, 'Add a feature?', features.length === 0);
        if (!addMore) break;

        const id = await ask(rl, '  Feature ID (e.g. fetch_api): ');
        if (!id) { console.log('  Feature ID is required. Skipping.'); continue; }

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

// ── Mapping wizards ───────────────────────────────────────────────────────

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
    'feature', 'manual', 'lint', 'html_validate', 'css_validate', 'name_check', 'code_review', 'deploy_check',
    'build_check', 'browser_check', 'build_and_browser_check', 'package_check', 'github_repo',
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

// ── Parts (multi-part lab) ────────────────────────────────────────────────

async function promptParts(rl, labDir = null) {
    console.log('\n--- Multi-Part Lab ---');
    const hasParts = await askBoolean(rl, 'Is this a multi-part lab (separate submissions per part)?', false);
    if (!hasParts) return null;

    const parts = [];
    while (true) {
        const addPrompt = parts.length === 0 ? 'Add a part?' : 'Add another part?';
        if (!await askBoolean(rl, addPrompt, false)) break;
        console.log(`\n  Part ${parts.length + 1}:`);
        const partId = await ask(rl, '  Part ID (e.g. DevEnvAndStaticSite): ') || `part${parts.length + 1}`;

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
        if (rubricName)            part.rubricName    = rubricName;
        if (folderPattern)         part.folderPattern = folderPattern;
        if (variations && Object.keys(variations).length > 0) part.variations = variations;
        if (featureCounts.length > 0) part.featureCounts = featureCounts;
        parts.push(part);
    }
    return parts.length > 0 ? parts : null;
}

// ── Variations ────────────────────────────────────────────────────────────

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

// ── Custom analyzer ───────────────────────────────────────────────────────

async function promptAnalyzer(rl, labName) {
    console.log('\n--- Custom Analyzer ---');
    const want = await askBoolean(rl, 'Create a custom analyzer (labXX_analyzer.js)?', false);
    if (!want) return null;

    return `module.exports = function analyze(jsFiles, analysis, config, student) {
    // Custom analysis logic here
    // Use student.codeReview?.group for A/B/C variation logic
    // Modify analysis.features or return { reportSections: [...] }
    return {};
};
`;
}

// ── Optional fields ───────────────────────────────────────────────────────

async function promptOptionalFields(rl) {
    console.log('\n--- Optional Fields ---');

    const summaryCell = await ask(rl, 'Summary cell (for AI/manual summary, e.g. A2, or blank): ');
    const graderCell  = await ask(rl, 'Grader cell (e.g. E1, or blank): ');
    const titleCell   = await ask(rl, 'Title cell (e.g. A1, or blank): ');

    const hasCodeReview = await askBoolean(rl, 'Does this lab have a code review form?', false);
    let codeReview = null;
    if (hasCodeReview) {
        const studentNameCell = await ask(rl, '  Student name cell [B1]: ') || 'B1';
        const groupCell       = await ask(rl, '  Group letter cell [C1]: ')  || 'C1';
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
        const depsRaw    = await ask(rl, '  Required dependencies (comma-separated, e.g. lit-html,bootstrap): ');
        const devDepsRaw = await ask(rl, '  Required devDependencies (comma-separated, e.g. vite): ');
        packageCheck = {};
        const deps    = depsRaw.split(',').map(s => s.trim()).filter(Boolean);
        const devDeps = devDepsRaw.split(',').map(s => s.trim()).filter(Boolean);
        if (deps.length > 0)    packageCheck.dependencies    = deps;
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

// ── Part-focused sub-wizard ───────────────────────────────────────────────

async function runPartSetup(rl, labDir, labName, existingConfig) {
    const existingParts = existingConfig?.analysis?.parts || [];

    let partIdx = -1;
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

    let partId;
    if (existingPart) {
        const ovr = await ask(rl, `\n  Part ID [${existingPart.id}]: `);
        partId = ovr || existingPart.id;
    } else {
        partId = await ask(rl, '\n  Part ID (e.g. DevEnvAndStaticSite): ');
        if (!partId) { console.log('  Part ID is required. Aborting.'); return; }
    }

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

    const keywords = await ask(rl,
        '  Keywords to find this part\'s folder in student repos (blank if not applicable): ');
    const folderPattern = keywords
        ? keywordsToFolderPattern(keywords)
        : (existingPart?.folderPattern || '');

    const updatedPart = { id: partId };
    if (rubricName)               updatedPart.rubricName    = rubricName;
    if (folderPattern)            updatedPart.folderPattern = folderPattern;
    if (existingPart?.variations) updatedPart.variations    = existingPart.variations;
    if (existingPart?.featureCounts) updatedPart.featureCounts = existingPart.featureCounts;

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

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    let labName = process.argv[2] || '';
    let isEditingExisting = false;

    console.log('\n=== Create / Edit Lab Configuration ===\n');

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
            const configFile = path.join(CONFIGS_DIR, labName, `${labName.toLowerCase()}_config.json`);
            isEditingExisting = fs.existsSync(configFile);
        } else {
            const existing = getExistingAssignments();
            const options = [
                ...existing.map(a => ({
                    label: a.name,
                    value: a.name,
                    desc: a.hasConfig ? 'has config' : 'no config yet',
                })),
                { label: 'Add new assignment', value: '__new__', desc: 'Create a brand-new assignment configuration' },
            ];

            const choice = await askOptions(rl, 'Select an assignment to edit, or add a new one:', options);

            if (choice === '__new__') {
                while (true) {
                    const raw = await ask(rl, 'Assignment name (e.g. 07, Lab07, TermProject): ');
                    const parsed = normalizeAssignmentName(raw);
                    if (parsed) { labName = parsed; break; }
                    console.log('  Please enter a name like "07", "Lab07", or "TermProject".');
                }
                isEditingExisting = false;
            } else {
                labName = choice;
                const configFile = path.join(CONFIGS_DIR, labName, `${labName.toLowerCase()}_config.json`);
                isEditingExisting = fs.existsSync(configFile);
            }
        }

        // 1b. Multi-step detection — must happen before labDir is set
        const labTopDir = path.join(CONFIGS_DIR, labName);
        const existingSteps = getExistingSteps(labName);
        let stepName = null;

        if (existingSteps.length > 0) {
            // Already a multi-step lab — prompt for which step to create/edit
            const stepOptions = [
                ...existingSteps.map(s => ({ label: s, value: s, desc: 'Edit existing step' })),
                { label: 'Add new step', value: '__new__', desc: 'Create a new submission step for this lab' },
            ];
            const stepChoice = await askOptions(rl, `${labName} has multiple submission steps. Which step?`, stepOptions);
            if (stepChoice === '__new__') {
                while (true) {
                    const raw = (await ask(rl, 'New step name (e.g. TermProjectProposal): ')).trim();
                    if (!raw) { console.log('  Step name is required.'); continue; }
                    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)) {
                        console.log('  Invalid name. Use letters, numbers, underscores, or hyphens.'); continue;
                    }
                    stepName = raw;
                    break;
                }
            } else {
                stepName = stepChoice;
            }
        } else if (!fs.existsSync(labTopDir)) {
            // Brand-new lab — ask upfront before anything else
            const multi = await askBoolean(rl, 'Will there be multiple sets of submissions for this lab?', false);
            if (multi) {
                while (true) {
                    const raw = (await ask(rl, 'Step name (e.g. TermProjectProposal): ')).trim();
                    if (!raw) { console.log('  Step name is required.'); continue; }
                    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)) {
                        console.log('  Invalid name. Use letters, numbers, underscores, or hyphens.'); continue;
                    }
                    stepName = raw;
                    break;
                }
            }
        }
        // If labTopDir exists with a flat config, stepName stays null (existing flat lab).

        // configBaseName is the folder/file stem used for {name}_config.json and {name}_analyzer.js
        const configBaseName = stepName || labName;
        const labDir = stepName ? path.join(labTopDir, stepName) : labTopDir;

        // For a multi-step lab: re-derive isEditingExisting based on the step config, not the top-level config
        if (stepName) {
            isEditingExisting = fs.existsSync(path.join(labDir, `${stepName.toLowerCase()}_config.json`));
        }

        let useExisting = false;
        if (fs.existsSync(labDir)) {
            if (isEditingExisting) {
                console.log(`\n  Editing existing assignment: ${labName}${stepName ? ' / ' + stepName : ''}`);
                const choice = await askOptions(rl, '  How do you want to proceed?', [
                    { label: 'Keep existing files',  value: 'keep',      desc: 'Preserves rubric and other files; rewrites config only' },
                    { label: 'Overwrite everything', value: 'overwrite', desc: 'Full wizard, existing files may be replaced' },
                    { label: 'Abort',                value: 'abort' },
                ]);
                if (choice === 'abort') { console.log('  Aborted.'); process.exit(0); }
                useExisting = (choice === 'keep');
            } else {
                console.log(`\n  Warning: Directory already exists: ${labDir}`);
                const choice = await askOptions(rl, '  How do you want to proceed?', [
                    { label: 'Abort',                value: 'abort' },
                    { label: 'Keep existing files',  value: 'keep',      desc: 'Preserves rubric and other files; rewrites config only' },
                    { label: 'Overwrite everything', value: 'overwrite', desc: 'Full wizard, existing files may be replaced' },
                ]);
                if (choice === 'abort') { console.log('  Aborted.'); process.exit(0); }
                useExisting = (choice === 'keep');
            }
        } else {
            fs.mkdirSync(labDir, { recursive: true });
        }
        console.log(`  Lab directory: ${labDir}`);

        // 1b. Configuration type — short-circuit for extract-only labs
        const configType = await askOptions(rl, '\nConfiguration type:', [
            { label: 'Full grading config', value: 'full',    desc: 'Rubric, runtime check, analysis, linting, validation, grade generation' },
            { label: 'Extract only',        value: 'extract', desc: 'Just clone repos / unzip submissions — no checking or grading' },
        ]);

        if (configType === 'extract') {
            const config = buildConfig(labName, { extractOnly: true });
            console.log('\n--- Writing Files ---');
            writeLab(labDir, config, null, null);
            console.log('\n=== Done! ===');
            console.log(`  Extract-only config: ${path.join(labDir, configBaseName.toLowerCase() + '_config.json')}`);
            const runCmd = stepName ? `node run_all.js ${labName} ${stepName}` : `node run_all.js ${labName}`;
            console.log('  Run:  ' + runCmd + '\n');
            return;
        }

        // 2. Rubric + mode selection
        let rubricName, rubricDest;
        if (useExisting) {
            const configPath = path.join(labDir, `${configBaseName.toLowerCase()}_config.json`);
            let existingConfig = null;
            try {
                if (fs.existsSync(configPath)) existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (e) { /* ignore */ }

            const mode = await askOptions(rl, 'What would you like to do?', [
                { label: 'Set up one part', value: 'part', desc: 'Configure rubric and mappings for a specific part' },
                { label: 'Full wizard',     value: 'full', desc: 'Rebuild the entire config from scratch' },
            ]);

            if (mode === 'part') {
                await runPartSetup(rl, labDir, labName, existingConfig);
                return;
            }

            const found = findSpreadsheets(labDir);
            if (found.length === 1) {
                rubricName = found[0];
                console.log(`  Using existing rubric: ${rubricName}`);
            } else if (found.length > 1) {
                rubricName = await askOptions(rl, '  Multiple spreadsheets found — which is the rubric?',
                    found.map(f => ({ label: f, value: f })));
            } else {
                console.log('  No spreadsheet found in existing directory. Please provide one to copy in.');
                const r = await copyRubric(rl, configBaseName);
                rubricName = r.rubricName;
                fs.copyFileSync(r.rubricPath, path.join(labDir, rubricName));
                console.log(`  Copied rubric to: ${path.join(labDir, rubricName)}`);
            }
            rubricDest = path.join(labDir, rubricName);
        } else {
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

            const r = await copyRubric(rl, configBaseName);
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
            { label: 'build',   value: 'build',   desc: 'npm install && npm run build only' },
            { label: 'both',    value: 'both',     desc: 'Browser + build' },
        ]);

        // 5. Parts
        const parts = await promptParts(rl, labDir);

        // 6. Variations
        const variations = await promptVariations(rl);

        // 7. Features
        const features = await promptFeatures(rl);

        // 8. Mappings
        console.log('\n--- Rubric Mappings ---');
        const rubricRows = await promptRubricRows(rl, rubricDest);
        let mappings;
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
        const analyzerContent = await promptAnalyzer(rl, configBaseName);
        const analyzerName = analyzerContent ? `${configBaseName.toLowerCase()}_analyzer.js` : null;

        // 11. Assemble and write
        const config = buildConfig(labName, {
            rubricName, titleText, runtimeCheck, features, mappings,
            parts, variations, analyzerName, optional,
        });

        console.log('\n--- Writing Files ---');
        writeLab(labDir, config, analyzerContent, analyzerName);

        console.log('\n=== Done! ===');
        console.log(`  Config written to: ${path.join(labDir, configBaseName.toLowerCase() + '_config.json')}`);
        if (useExisting) {
            console.log(`  Existing files preserved (rubric and other files were not overwritten).`);
        } else {
            console.log(`  Rubric copied to: ${rubricDest}`);
        }
        if (analyzerName) console.log(`  Analyzer created at: ${path.join(labDir, analyzerName)}`);
        const runCmd = stepName ? `node run_all.js ${labName} ${stepName}` : `node run_all.js ${labName}`;
        console.log('\n  You can now edit the config file to adjust cell references or add more mappings.');
        console.log('  Grade with:  ' + runCmd);
        console.log('  To verify, run: node bin/rubric_to_md.js ' + JSON.stringify(rubricDest) + '\n');

    } finally {
        rl.close();
    }
}

module.exports = {
    // Readline driver primitives (tested directly)
    createRL, ask, askBoolean, askInt, askOptions, makeRLDriver,
    // Flow thin-wrappers (preserve rl-first signature for tests and wizard callers)
    promptRubricRows, copyRubric, promptFields, buildMappingEntry,
    // Wizard-only functions
    promptFeatures,
    // Re-exported from lib for test backward compat
    colLetter, excelCell, colLetterToIndex, normalizeAssignmentName,
    cellText, isBlankRow, sheetRows, POSSIBLE_HEADER_RE, detectRubricLayout,
    readRubricRows, readRubricCriteria,
    findSpreadsheets, getExistingAssignments, keywordsToFolderPattern,
    MAPPING_TYPES, MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA,
    guessMappingType, buildConfig, writeLab,
};

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
