#!/usr/bin/env node
// Usage: node bin/configure_lab.js [AssignmentName]
// LLM-assisted lab configuration wizard. Reads the rubric spreadsheet, generates a
// draft mapping table with AI, then lets the user review and edit before saving.

const fs   = require('fs');
const path = require('path');

const {
    normalizeAssignmentName,
    findSpreadsheets,
    getExistingAssignments, getExistingSteps,
    assembleConfig, writeLab,
    MAPPING_TYPES, MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA, guessMappingType,
} = require('../lib/lab_config.js');

const { promptRubricRows, promptRubricCriteria, copyRubric, buildMappingEntry } =
    require('../lib/config_prompts.js');

const { selectModel } = require('../lib/llm_client.js');
const { TUI } = require('../lib/tui.js');

const CONFIGS_DIR       = path.join(__dirname, '..', 'configs');
const LOCAL_CONFIG_PATH = path.join(CONFIGS_DIR, 'local-config.json');

// ── Helpers passed to selectModel ────────────────────────────────────────

function makeHelpers(tui) {
    return {
        ask:        (prompt)                => tui.ask(prompt),
        askBoolean: (q, def)               => tui.askBoolean(q, def),
        askOptions: (prompt, opts, defIdx) => tui.askOptions(prompt, opts, defIdx ?? 0),
    };
}

// ── LLM prompt construction ───────────────────────────────────────────────

function buildTypeRef() {
    const lines = ['MAPPING TYPES (choose the best fit for each row):'];
    for (const t of MAPPING_TYPES) {
        const schema = MAPPING_TYPE_SCHEMA[t.value] ?? GENERIC_MAPPING_SCHEMA;
        const extraFields = schema.fields
            .filter(f => f.key !== 'maxScore')
            .map(f => {
                if (f.type === 'options') return `${f.key} (${f.options.map(o => o.value).join('|')})`;
                return f.required ? `${f.key} (required)` : f.key;
            });
        const extras = extraFields.length ? `  extra: ${extraFields.join(', ')}` : '';
        lines.push(`  ${t.value.padEnd(20)} ${t.desc}${extras}`);
    }
    return lines.join('\n');
}

function buildRowTable(scoringRows) {
    const header = '| # | Label | Possible | scoreCell | commentCell |';
    const sep    = '|---|-------|----------|-----------|-------------|';
    const rows   = scoringRows.map((r, i) =>
        `| ${i + 1} | ${r.label} | ${r.possible || '0'} | ${r.scoreCell} | ${r.commentCell} |`
    );
    return [header, sep, ...rows].join('\n');
}

function buildCriteriaRef(criteria) {
    if (!criteria.length) return '';
    const header = '| Item | Points | Criteria (what the grader checks) |';
    const sep    = '|------|--------|-----------------------------------|';
    const rows   = criteria.map(c => `| ${c.label} | ${c.points || ''} | ${c.criteria} |`);
    return `\nRUBRIC SHEET (reference — item descriptions; correlate these with the rows to configure):
${[header, sep, ...rows].join('\n')}\n`;
}

function buildLLMPrompt(labName, scoringRows, criteria = []) {
    return `Assignment: ${labName}

${buildTypeRef()}
${buildCriteriaRef(criteria)}
RUBRIC ROWS TO CONFIGURE:
${buildRowTable(scoringRows)}

Return a JSON array with exactly ${scoringRows.length} objects, one per row above (in order).
Required fields for every object:
  scoreCell    – copy from input (e.g. "D7")
  commentCell  – copy from input (e.g. "F7")
  type         – one of the mapping types listed above
  maxScore     – integer from "Possible" column (0 if blank)

Use the RUBRIC SHEET descriptions above to infer the most accurate type for each row.
Do NOT use type "feature" — it requires a regex not yet defined.

Type selection rules:
  "lint" is ONLY for ESLint static analysis (code style/syntax) — never for build or runtime errors.
  "build_check" for Vite/webpack/npm-run-build failures or build errors only.
  "browser_check" for Puppeteer browser console errors or runtime errors only.
  "build_and_browser_check" when criteria mention BOTH build errors AND console/browser errors — half credit if only one check fails.
  "developer_comments" for developer name, date, or code comments present in files.
  "env_file_check" when criteria check that a .env file exists and contains a KEY=VALUE API key entry.
  "gitignore_check" when criteria mention .gitignore; add requiredEntry:".env" when the check is specifically that .env is excluded from the repo.
  "path_exists" when criteria say a specific file or directory must exist (e.g. "file exists at functions/..."); set pathPattern to a substring matching that path.
  "apps_in_repo" when criteria say the app (or apps) must be in a GitHub repository — for BOTH single-app and multi-app labs.
  "github_repo" only when the check is that the student provided a valid cloneable GitHub URL.
  "collaborator_check" only when the check specifically requires the instructor to be added as a repo collaborator.
  "part_completed" ONLY for multi-part labs where students have separate named game/app subfolders (Part1/, Part2/, etc.) — do NOT use for checking that a single config file or source file exists.
  "manual" for anything requiring human visual inspection, including: folder/file organization, CORS behavior, proxy configuration, API integration, no-hardcoded-secret checks, and deployment correctness.

Type-specific extra fields:
  manual            → msg: short description of what to check
  lint              → severity: "errors" or "warnings"
  gitignore_check   → requiredEntry: entry that must be listed (e.g. ".env")
  path_exists       → pathPattern: substring or regex matched against file paths (required)

Example (5 rows):
[
  {"scoreCell":"D7","commentCell":"F7","type":"env_file_check","maxScore":3},
  {"scoreCell":"D8","commentCell":"F8","type":"gitignore_check","maxScore":2,"requiredEntry":".env"},
  {"scoreCell":"D9","commentCell":"F9","type":"path_exists","maxScore":5,"pathPattern":"functions/"},
  {"scoreCell":"D10","commentCell":"F10","type":"manual","maxScore":4,"msg":"NEEDS MANUAL CHECK (no hardcoded API key in source files)"},
  {"scoreCell":"D11","commentCell":"F11","type":"apps_in_repo","maxScore":3}
]`;
}

const SYSTEM_PROMPT =
    'You are a configuration assistant for an automated JavaScript lab grader. ' +
    'Analyze rubric rows and output a JSON array. ' +
    'Return ONLY valid JSON — no explanation, no markdown fences, no commentary.';

// ── Draft generation ──────────────────────────────────────────────────────

function guardFeatureType(type, featureId, knownFeatureIds) {
    if (type !== 'feature') return type;
    if (featureId && knownFeatureIds.has(featureId)) return type;
    return 'manual';
}

function findCriteria(label, criteria) {
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w.length > 2);
    const want = new Set(norm(label));
    if (!want.size) return '';
    let best = null, bestScore = 0;
    for (const c of criteria) {
        const tokens = norm(`${c.label} ${c.criteria}`);
        const hits = tokens.filter(t => want.has(t)).length;
        if (hits > bestScore) { bestScore = hits; best = c; }
    }
    return bestScore >= 1 && best ? best.criteria : '';
}

function heuristicDraft(scoringRows, criteria = [], knownFeatureIds = new Set()) {
    return scoringRows.map(rr => {
        const extra   = findCriteria(rr.label, criteria);
        const guessed = guessMappingType(extra ? `${rr.label} ${extra}` : rr.label);
        const type    = guardFeatureType(guessed, undefined, knownFeatureIds);
        const schema  = MAPPING_TYPE_SCHEMA[type] ?? GENERIC_MAPPING_SCHEMA;
        const entry   = {
            cell:        rr.scoreCell,
            commentCell: rr.commentCell,
            _label:      rr.label,
            type,
            maxScore:    parseInt(rr.possible, 10) || 0,
        };
        if (schema.fixed) Object.assign(entry, schema.fixed);
        for (const f of schema.fields) {
            if (f.key === 'maxScore') continue;
            if (f.type === 'options') entry[f.key] = f.options[0].value;
            else if (f.default !== undefined) entry[f.key] = f.default;
        }
        if (rr.stockComments) entry.stockComments = rr.stockComments;
        return entry;
    });
}

function extractJSON(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) return fenced[1].trim();
    const start = text.indexOf('['), end = text.lastIndexOf(']');
    if (start >= 0 && end > start) return text.slice(start, end + 1);
    return text;
}

function mergeLLMResponse(llmDraft, scoringRows, knownFeatureIds = new Set()) {
    const validTypes = new Set(MAPPING_TYPES.map(t => t.value));
    return scoringRows.map((rr, i) => {
        const src      = llmDraft[i] ?? {};
        const rawType  = validTypes.has(src.type) ? src.type : guessMappingType(rr.label);
        const type     = guardFeatureType(rawType, src.featureId, knownFeatureIds);
        const maxScore = typeof src.maxScore === 'number' && src.maxScore >= 0
            ? src.maxScore
            : parseInt(rr.possible, 10) || 0;

        const entry = {
            cell:        rr.scoreCell,
            commentCell: rr.commentCell,
            _label:      rr.label,
            type,
            maxScore,
        };

        const schema = MAPPING_TYPE_SCHEMA[type] ?? GENERIC_MAPPING_SCHEMA;
        if (schema.fixed) Object.assign(entry, schema.fixed);
        for (const f of schema.fields) {
            if (f.key === 'maxScore') continue;
            if (src[f.key] !== undefined) entry[f.key] = src[f.key];
            else if (f.type === 'options') entry[f.key] = f.options[0].value;
            else if (f.default !== undefined) entry[f.key] = f.default;
        }
        if (rr.stockComments) entry.stockComments = rr.stockComments;
        return entry;
    });
}

async function generateDraft(tui, llm, labName, rubricRows, criteria = [], knownFeatureIds = new Set()) {
    const scoringRows = rubricRows.filter(r => !r.isSectionHeader);

    if (!llm) return heuristicDraft(scoringRows, criteria, knownFeatureIds);

    tui.showSpinner('Asking AI to draft configuration...');
    const response = await llm.chat(SYSTEM_PROMPT, buildLLMPrompt(labName, scoringRows, criteria));
    tui.clearSpinner();

    if (!response) {
        tui.print('  AI request failed. Using heuristic fallback.');
        return heuristicDraft(scoringRows, criteria, knownFeatureIds);
    }

    try {
        const parsed = JSON.parse(extractJSON(response));
        if (!Array.isArray(parsed)) throw new Error('not an array');
        tui.print('  AI draft generated.');
        return mergeLLMResponse(parsed, scoringRows, knownFeatureIds);
    } catch (e) {
        tui.print(`  AI parse error (${e.message}). Using heuristic fallback.`);
        return heuristicDraft(scoringRows, criteria, knownFeatureIds);
    }
}

// ── Draft table display ───────────────────────────────────────────────────

function summaryNotes(entry) {
    let note = '';
    if (entry.type === 'manual' && entry.msg)
        note = `"${String(entry.msg).slice(0, 24)}"`;
    else if (entry.type === 'lint' && entry.severity)
        note = `severity: ${entry.severity}`;
    else if (entry.type === 'feature' && entry.featureId)
        note = `featureId: ${entry.featureId}`;
    else if (entry.type === 'github_repo' && entry.linkCell)
        note = `linkCell: ${entry.linkCell}`;
    if (entry.stockComments) note = (note ? note + ' ' : '') + '+stock';
    return note;
}

function defPrompt(text, current) {
    return current ? `${text} [${current}]: ` : `${text} (or blank): `;
}

function printDraftTable(draft) {
    const maxLabel = Math.min(34, Math.max(5, ...draft.map(d => (d._label || '').length)));
    const maxType  = Math.max(6, ...draft.map(d => (d._skip ? '(skip)' : d.type).length));

    const bar = (w) => '─'.repeat(w);
    console.log(
        `\n  ${'#'.padStart(3)} │ ${'Label'.padEnd(maxLabel)} │ Cell  │ ${'Type'.padEnd(maxType)} │ Max │ Notes`
    );
    console.log(
        `  ${bar(3)}─┼─${bar(maxLabel)}─┼───────┼─${bar(maxType)}─┼─────┼──────────────────────────────`
    );
    draft.forEach((e, i) => {
        const num   = String(i + 1).padStart(3);
        const label = (e._label || '').slice(0, maxLabel).padEnd(maxLabel);
        const cell  = (e.cell || '').padEnd(5);
        const type  = (e._skip ? '(skip)' : e.type).padEnd(maxType);
        const max   = String(e._skip ? '' : (e.maxScore ?? 0)).padStart(3);
        const notes = e._skip ? 'no mapping — graded by hand' : summaryNotes(e);
        console.log(`  ${num} │ ${label} │ ${cell} │ ${type} │ ${max} │ ${notes}`);
    });
    console.log();
}

// ── Edit a single row in the review table ────────────────────────────────

async function editRowTUI(idx, draft, scoringRows, tui) {
    const rr      = scoringRows[idx];
    const current = draft[idx];
    tui.print(`\n  Row ${idx + 1}: "${current._label || rr?.label || ''}"  [${current.cell || rr?.scoreCell || ''}]`);

    const SKIP    = { label: '— skip (graded by hand, no automation) —', value: '__skip__', desc: 'Exclude this row from automated grading' };
    const choices = [...MAPPING_TYPES, SKIP];

    const defIdx = current._skip
        ? choices.length - 1
        : Math.max(0, MAPPING_TYPES.findIndex(t => t.value === current.type));

    const newType = await tui.askOptions('Mapping type', choices, defIdx);

    if (newType === '__skip__') {
        draft[idx] = { _label: rr.label, cell: rr.scoreCell, _skip: true };
        return true;
    }

    const newEntry = await buildMappingEntry(tui, newType, rr, current);
    if (newEntry) {
        draft[idx] = { ...newEntry, _label: rr.label };
        if (rr.stockComments) draft[idx].stockComments = rr.stockComments;
        return true;
    }
    return false;
}

// ── Review + edit loop ────────────────────────────────────────────────────

async function reviewDraft(tui, draft, rubricRows) {
    const scoringRows = rubricRows.filter(r => !r.isSectionHeader);

    const makeItems = () => {
        const maxLabel = Math.min(28, Math.max(5, ...draft.map(e => (e._label || '').length)));
        const maxType  = Math.max(6, ...draft.map(e => (e._skip ? '(skip)' : (e.type || '')).length));
        return draft.map((e, i) => {
            const num  = String(i + 1).padStart(3);
            const lbl  = (e._label || '').slice(0, maxLabel).padEnd(maxLabel);
            const cell = (e.cell || '').padEnd(5);
            const type = (e._skip ? '(skip)' : (e.type || '')).padEnd(maxType);
            const max  = String(e._skip ? '' : (e.maxScore ?? 0)).padStart(3);
            const note = e._skip ? 'manual' : summaryNotes(e);
            return ` ${num} │ ${lbl} │ ${cell} │ ${type} │ ${max} │ ${note}`;
        });
    };

    await tui.reviewTable(makeItems, idx => editRowTUI(idx, draft, scoringRows, tui));

    return draft;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        process.stdout.write('Usage: node bin/configure_lab.js [AssignmentName]\n');
        process.stdout.write('LLM-assisted rubric → config wizard.\n');
        process.exit(0);
    }

    let summary = null;
    const tui = new TUI('Configure Lab Grading (AI-assisted)');
    try {
        tui.print('\nWelcome! This wizard reads a rubric spreadsheet, uses AI to draft a');
        tui.print('mapping configuration, then lets you review and edit before saving.\n');

        // 1. LLM model selection — always shown, pre-selects current model
        const llm = await selectModel(LOCAL_CONFIG_PATH, makeHelpers(tui));
        if (!llm) tui.print('  Proceeding with heuristic mapping (no AI).\n');

        // 2. Assignment name — selection menu or CLI arg
        let labName = '';
        const rawArg = process.argv[2];
        if (rawArg) {
            labName = normalizeAssignmentName(rawArg);
            if (!labName) {
                tui.print(`Invalid assignment name: ${rawArg}. Use a number (07), a lab name (Lab07), or a slug (TermProject).`);
                tui.exit(1);
            }
            tui.print(`\n--- Assignment: ${labName} ---`);
        } else {
            const existing = getExistingAssignments();
            const options = [
                ...existing.map(a => ({
                    label:  a.name,
                    value:  a.name,
                    status: a.hasConfig ? 'has config' : 'no config yet',
                })),
                { label: 'Add new assignment', value: '__new__',
                  color: 'green', desc: 'Create a brand-new assignment configuration' },
            ];
            const choice = await tui.askOptions('Select an assignment to configure', options, 0);
            if (choice === '__new__') {
                while (true) {
                    const raw = await tui.ask('Assignment name (e.g. TermProject, 07)');
                    labName = normalizeAssignmentName(raw);
                    if (labName) break;
                    tui.print('  Invalid — use letters, numbers, underscores, or hyphens.');
                }
            } else {
                labName = choice;
            }
        }

        // 2b. Multi-step detection
        const labTopDir     = path.join(CONFIGS_DIR, labName);
        const existingSteps = getExistingSteps(labName);
        let stepName = null;

        if (existingSteps.length > 0) {
            const stepOptions = [
                ...existingSteps.map(s => ({ label: s, value: s, status: 'existing step' })),
                { label: 'Add new step', value: '__new__', color: 'green',
                  desc: 'Create a new submission step for this lab' },
            ];
            const stepChoice = await tui.askOptions(
                `${labName} has multiple submission steps. Which step?`, stepOptions, 0);
            if (stepChoice === '__new__') {
                while (true) {
                    const raw = (await tui.ask('New step name (e.g. TermProjectProposal)')).trim();
                    if (!raw) { tui.print('  Step name is required.'); continue; }
                    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)) {
                        tui.print('  Invalid name. Use letters, numbers, underscores, or hyphens.');
                        continue;
                    }
                    stepName = raw;
                    break;
                }
            } else {
                stepName = stepChoice;
            }
        } else if (!fs.existsSync(labTopDir)) {
            // Brand-new lab — ask upfront
            const multi = await tui.askBoolean(
                'Will there be multiple sets of submissions for this lab?', false);
            if (multi) {
                while (true) {
                    const raw = (await tui.ask('Step name (e.g. TermProjectProposal)')).trim();
                    if (!raw) { tui.print('  Step name is required.'); continue; }
                    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw)) {
                        tui.print('  Invalid name. Use letters, numbers, underscores, or hyphens.');
                        continue;
                    }
                    stepName = raw;
                    break;
                }
            }
        }

        const labDir = stepName
            ? path.join(labTopDir, stepName)
            : labTopDir;

        if (!fs.existsSync(labDir)) {
            fs.mkdirSync(labDir, { recursive: true });
            tui.print(`  Created: ${labDir}`);
        }

        // configPath is needed both for the normal path and the extract-only early exit.
        // writeLab uses path.basename(labDir) for the filename, so we match that here.
        const configPath = path.join(labDir, `${path.basename(labDir).toLowerCase()}_config.json`);

        // 3. Find rubric
        tui.print('\n--- Rubric ---');
        const found = findSpreadsheets(labDir);
        let rubricName;

        if (found.length === 0) {
            let codeRootCandidates = [];
            try {
                const localCfg = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
                if (localCfg.codeRoot) {
                    const codeLabDir = path.join(localCfg.codeRoot, labName);
                    codeRootCandidates = findSpreadsheets(codeLabDir)
                        .map(rel => path.join(localCfg.codeRoot, labName, rel));
                }
            } catch (_) {}

            let sourceRubricPath = null;
            if (codeRootCandidates.length === 1) {
                const use = await tui.askBoolean(
                    `Found ${path.basename(codeRootCandidates[0])} in ${labName}/ — use it?`, true);
                if (use) sourceRubricPath = codeRootCandidates[0];
            } else if (codeRootCandidates.length > 1) {
                tui.print('\n  Spreadsheets found in codeRoot:');
                const opts = [
                    ...codeRootCandidates.map(p => ({ label: path.basename(p), value: p })),
                    { label: 'None of these — enter path manually', value: null },
                ];
                sourceRubricPath = await tui.askOptions('Which to use?', opts);
            }

            if (sourceRubricPath) {
                const rubricExt = path.extname(sourceRubricPath).toLowerCase();
                rubricName = `CS233JS_${labName}_Rubric${rubricExt}`;
            } else {
                // No rubric found anywhere — offer extract-only as an alternative to
                // providing a file path. Extract-only clones repos and writes a log;
                // no runtime check, analysis, lint, or grade spreadsheets are produced.
                const noRubricChoice = await tui.askOptions(
                    'No rubric spreadsheet found. How would you like to proceed?',
                    [
                        { label: 'Provide a rubric file path', value: 'provide',
                          desc: 'Copy a .xlsx or .xlsm rubric into the config directory' },
                        { label: 'Extract-only (no rubric)',   value: 'extract',
                          desc: 'Just clone/extract repos; skip runtime/analysis/grading — grade manually' },
                    ]
                );

                if (noRubricChoice === 'extract') {
                    const cfg = assembleConfig(null, { extractOnly: true });
                    writeLab(labDir, cfg, null, null);
                    summary = [
                        `\n=== Done! ===`,
                        `  Extract-only config written — repos will be cloned, no grading.`,
                        `  Config: ${configPath}`,
                        `  Run: node run_all.js ${labName}${stepName ? ' ' + stepName : ''}`,
                    ];
                    return;   // skip rubric read, draft, review, and settings steps
                }

                const r = await copyRubric(tui, labName);
                rubricName       = r.rubricName;
                sourceRubricPath = r.rubricPath;
            }

            const dest = path.join(labDir, rubricName);
            fs.copyFileSync(sourceRubricPath, dest);
            tui.print(`  Copied to: ${dest}`);
        } else if (found.length === 1) {
            rubricName = found[0];
            tui.print(`  Rubric: ${rubricName}`);
        } else {
            rubricName = await tui.askOptions(
                'Multiple spreadsheets found — which to configure?',
                found.map(f => ({ label: f, value: f }))
            );
        }
        const rubricPath = path.join(labDir, rubricName);

        // Load existing config (for defaults, feature-id guard, and preservation)
        let existingConfig = null;
        try { existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
        const knownFeatureIds = new Set(
            (existingConfig?.analysis?.features || []).map(f => f.id).filter(Boolean)
        );

        // 4. Read rubric with column confirmation
        tui.print('\n--- Reading Rubric ---');
        const rubricRows = await promptRubricRows(tui, rubricPath);
        if (!rubricRows) { tui.print('Could not read rubric. Exiting.'); tui.exit(1); }
        const scoringRows = rubricRows.filter(r => !r.isSectionHeader);
        tui.print(`  ${scoringRows.length} scoring rows, ${rubricRows.length - scoringRows.length} section headers.`);

        // 5. Criteria for LLM context
        tui.print('\n--- Rubric Criteria Sheet ---');
        const criteria = await promptRubricCriteria(tui, rubricPath);

        // 6. Generate draft
        tui.print('\n--- Generating Draft ---');
        let draft = await generateDraft(tui, llm, labName, rubricRows, criteria, knownFeatureIds);

        // 7. Review + edit
        tui.print('\n--- Review Draft (use arrow keys to navigate, Enter to edit, a to accept) ---');
        draft = await reviewDraft(tui, draft, rubricRows);

        // 8. Global config questions
        tui.print('\n--- Assignment Settings ---');
        const ex           = existingConfig || {};
        const titleText    = await tui.ask('Assignment title', ex.titleText || labName);
        const runtimeOpts  = [
            { label: 'browser', value: 'browser', desc: 'Puppeteer headless browser' },
            { label: 'build',   value: 'build',   desc: 'npm install + npm run build' },
            { label: 'both',    value: 'both',     desc: 'Browser + build' },
        ];
        const rtIdx        = Math.max(0, runtimeOpts.findIndex(o => o.value === ex.runtimeCheck));
        const runtimeCheck = await tui.askOptions('Runtime check mode', runtimeOpts, rtIdx);
        const summaryCell  = await tui.ask('Summary cell (e.g. A2, or blank)', ex.summaryCell || '');
        const graderCell   = await tui.ask('Grader cell (e.g. E1, or blank)',  ex.graderCell  || '');
        const titleCell    = await tui.ask('Title cell (e.g. A1, or blank)',   ex.titleCell   || '');

        // 9. Build and write
        const mappings = draft
            .filter(e => !e._skip)
            .map(({ _label, _skip, ...rest }) => rest);

        // assembleConfig deep-clones existingConfig and overwrites only the keys the
        // wizard owns, so a re-run preserves customAnalyzer, validate, nameCheck,
        // codeReview, variations, packageCheck, repoHygiene, lint, features, parts —
        // anything the wizard doesn't prompt for.
        const config = assembleConfig(existingConfig, {
            rubricName,
            titleText,
            runtimeCheck,
            mappings,
            optional: { titleCell, summaryCell, graderCell },
        });

        tui.print('\n--- Writing Config ---');
        writeLab(labDir, config, null, null);

        summary = [
            `\n=== Done! ===`,
            `  ${mappings.length} mappings configured.`,
            `  Config: ${configPath}`,
            `  To verify: node bin/rubric_to_md.js ${JSON.stringify(rubricPath)}`,
        ];

    } finally {
        tui.destroy();
    }

    if (summary) summary.forEach(line => process.stdout.write(line + '\n'));
}

module.exports = {
    heuristicDraft, mergeLLMResponse, guardFeatureType, findCriteria,
    buildLLMPrompt, buildCriteriaRef, extractJSON, summaryNotes, defPrompt,
    printDraftTable,
};

if (require.main === module) {
    main().catch(err => {
        process.stderr.write(`Fatal error: ${err.stack || err.message}\n`);
        process.exit(1);
    });
}
