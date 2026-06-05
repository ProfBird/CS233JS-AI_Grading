#!/usr/bin/env node
// Usage: node bin/configure_lab.js [AssignmentName]
// LLM-assisted lab configuration wizard. Reads the rubric spreadsheet, generates a
// draft mapping table with AI, then lets the user review and edit before saving.

const fs   = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const {
    normalizeAssignmentName, colLetter, colLetterToIndex,
    findSpreadsheets, sheetRows, readRubricRows, readRubricCriteria, detectRubricLayout,
    buildConfig, writeLab, getExistingAssignments,
    MAPPING_TYPES, MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA, guessMappingType,
} = require('./create_lab.js');

const { loadLLMClient, setupLLMInteractive } = require('../lib/llm_client.js');
const { TUI } = require('../lib/tui.js');

const CONFIGS_DIR       = path.join(__dirname, '..', 'configs');
const LOCAL_CONFIG_PATH = path.join(CONFIGS_DIR, 'local-config.json');

// ── Helpers passed to setupLLMInteractive ────────────────────────────────

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
  "build_and_browser_check" when criteria mention BOTH build errors AND console/browser errors (e.g. "No Vite build errors or browser console errors") — half credit if only one check fails.
  "developer_comments" for developer name, date, or code comments present in files.

Type-specific extra fields:
  manual       → msg: short description of what to check
  lint         → severity: "errors" or "warnings"

Example (3 rows):
[
  {"scoreCell":"D7","commentCell":"F7","type":"manual","maxScore":10,"msg":"NEEDS MANUAL CHECK (index.html exists)"},
  {"scoreCell":"D8","commentCell":"F8","type":"lint","maxScore":5,"severity":"errors"},
  {"scoreCell":"D9","commentCell":"F9","type":"github_repo","maxScore":3}
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

// ── TUI-specific rubric reading ───────────────────────────────────────────

async function promptRubricRowsTUI(tui, rubricPath) {
    let wb;
    try { wb = XLSX.readFile(rubricPath); } catch (e) {
        tui.print(`  Could not read rubric file: ${e.message}`);
        return null;
    }
    const ws = wb?.Sheets['Grade'];
    if (!ws) { tui.print('  No "Grade" sheet found in the rubric.'); return null; }
    const rows = sheetRows(ws);

    let layout = detectRubricLayout(rows);
    if (!layout) {
        const alt = await tui.ask(
            'Max-points column header not found (tried: possible, points, pts, max). Enter exact header text or leave blank to skip'
        );
        if (!alt) return null;
        const altRe = new RegExp(`^${alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        layout = detectRubricLayout(rows, altRe);
        if (!layout) { tui.print(`  Could not find "${alt}". Skipping mappings.`); return null; }
    }

    tui.print(`  Detected columns in Grade sheet (header row ${layout.headerRow + 1}):`);
    tui.print(`    Max points : ${colLetter(layout.possibleCol)}`);
    tui.print(`    Score      : ${colLetter(layout.scoreCol)}`);
    tui.print(`    Comments   : ${colLetter(layout.commentCol)}`);
    if (layout.fullCol >= 0) {
        tui.print(`    Stock (100%/<100%/0%): ${colLetter(layout.fullCol)}/${colLetter(layout.partialCol)}/${colLetter(layout.zeroCol)}`);
    }

    const ok = await tui.askBoolean('Are these columns correct?', true);
    if (!ok) {
        const p = await tui.ask('Max-points column letter', colLetter(layout.possibleCol));
        const s = await tui.ask('Score/grade column letter', colLetter(layout.scoreCol));
        const c = await tui.ask('Comments column letter', colLetter(layout.commentCol));
        if (p) layout.possibleCol = colLetterToIndex(p);
        if (s) layout.scoreCol    = colLetterToIndex(s);
        if (c) layout.commentCol  = colLetterToIndex(c);
    }

    return readRubricRows(rubricPath, layout);
}

async function promptRubricCriteriaTUI(tui, rubricPath) {
    tui.print('\n--- Rubric Criteria Sheet ---');
    const criteria = readRubricCriteria(rubricPath);
    if (criteria.length === 0) {
        tui.print('  No "Rubric" sheet or no Criteria column found — skipping criteria descriptions.');
    } else {
        tui.print(`  Found ${criteria.length} criteria descriptions (used as AI context).`);
    }
    return criteria;
}

// ── Copy rubric (TUI version) ─────────────────────────────────────────────

async function copyRubricTUI(tui, labName) {
    tui.print('\n--- Rubric Spreadsheet ---');
    tui.print('  Provide a path to the .xlsx or .xlsm rubric file.');

    let rubricPath;
    for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await tui.ask('Path to rubric file');
        const candidate = raw.replace(/^["']|["']$/g, '').trim();
        if (!candidate) continue;
        if (!fs.existsSync(candidate)) { tui.print(`  File not found: ${candidate}`); continue; }
        if (!fs.statSync(candidate).isFile()) { tui.print('  That is a directory — provide the full file path.'); continue; }
        rubricPath = candidate;
        break;
    }
    if (!rubricPath) { tui.print('  No rubric provided after 3 attempts. Aborting.'); tui.exit(1); }

    const ext = path.extname(rubricPath).toLowerCase();
    const suggestedName = `CS233JS_${labName}_Rubric${ext}`;
    const nameInput = await tui.ask('Rubric filename', suggestedName);
    const rubricName = path.basename(nameInput || suggestedName);

    return { rubricPath, rubricName, ext };
}

// ── Mapping entry builder (TUI version of promptFields / buildMappingEntry) ──

async function promptFieldsTUI(tui, fields, currentValues = {}) {
    const result = {};
    for (const f of fields) {
        const cur = currentValues[f.key];
        if (f.type === 'int') {
            const def = cur ?? f.default ?? 0;
            // Strip existing [n] placeholder from the prompt text
            const label = f.prompt.replace(/\s*\[.*?\]/, '').replace(/:\s*$/, '').trim();
            result[f.key] = await tui.askInt(label, def);
        } else if (f.type === 'options') {
            const defIdx = cur !== undefined
                ? Math.max(0, f.options.findIndex(o => o.value === cur))
                : 0;
            const label = f.prompt.replace(/:\s*$/, '').trim();
            result[f.key] = await tui.askOptions(label, f.options, defIdx);
        } else {
            const def = cur ?? f.default ?? '';
            const label = f.prompt.replace(/:\s*$/, '').trim();
            const raw = await tui.ask(label, def);
            if (f.required && !raw && !def) {
                tui.print('  Required field empty — skipping this entry.');
                return null;
            }
            if (f.optional && !raw && !def) continue;
            result[f.key] = raw || def;
        }
    }
    return result;
}

async function buildMappingEntryTUI(tui, type, rubricRow, currentValues = {}) {
    const schema = MAPPING_TYPE_SCHEMA[type] ?? GENERIC_MAPPING_SCHEMA;
    const fields = await promptFieldsTUI(tui, schema.fields, currentValues);
    if (fields === null) return null;
    const m = { type, cell: rubricRow.scoreCell, ...(schema.fixed ?? {}), ...fields };
    if (rubricRow.commentCell) m.commentCell = rubricRow.commentCell;
    return m;
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

    const newEntry = await buildMappingEntryTUI(tui, newType, rr, current);
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

        // 1. LLM setup
        let llm = loadLLMClient(LOCAL_CONFIG_PATH);
        if (llm) {
            tui.print(`  LLM: ${llm.provider}  model: ${llm.model || '(auto)'}\n`);
        } else {
            tui.print('  No LLM configured yet.');
            const setup = await tui.askBoolean('Set one up now?', true);
            if (setup) llm = await setupLLMInteractive(LOCAL_CONFIG_PATH, makeHelpers(tui));
            if (!llm) tui.print('  Proceeding with heuristic mapping (no AI).\n');
        }

        // 2. Assignment name
        let labName = '';
        const rawArg = process.argv[2];
        if (rawArg) {
            labName = normalizeAssignmentName(rawArg);
            if (!labName) {
                tui.print(`Invalid assignment name: ${rawArg}. Use a number (07), a lab name (Lab07), or a slug (TermProject).`);
                tui.exit(1);
            }
            tui.print(`\n--- Assignment Name ---`);
            tui.print(`  Assignment: ${labName}`);
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

        const labDir = path.join(CONFIGS_DIR, labName);
        if (!fs.existsSync(labDir)) {
            fs.mkdirSync(labDir, { recursive: true });
            tui.print(`  Created: ${labDir}`);
        }

        // 3. Find rubric
        tui.print('\n--- Rubric ---');
        const found = findSpreadsheets(labDir);
        let rubricName;

        if (found.length === 0) {
            // Also search <codeRoot>/<labName>/
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
                const r = await copyRubricTUI(tui, labName);
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
        const configPath = path.join(labDir, `${labName.toLowerCase()}_config.json`);
        try { existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
        const knownFeatureIds = new Set(
            (existingConfig?.analysis?.features || []).map(f => f.id).filter(Boolean)
        );

        // 4. Read rubric with column confirmation
        tui.print('\n--- Reading Rubric ---');
        const rubricRows = await promptRubricRowsTUI(tui, rubricPath);
        if (!rubricRows) { tui.print('Could not read rubric. Exiting.'); tui.exit(1); }
        const scoringRows = rubricRows.filter(r => !r.isSectionHeader);
        tui.print(`  ${scoringRows.length} scoring rows, ${rubricRows.length - scoringRows.length} section headers.`);

        // 5. Criteria for LLM context
        const criteria = await promptRubricCriteriaTUI(tui, rubricPath);

        // 6. Generate draft
        tui.print('\n--- Generating Draft ---');
        let draft = await generateDraft(tui, llm, labName, rubricRows, criteria, knownFeatureIds);

        // 7. Review + edit (curses table)
        tui.print('\n--- Review Draft (use arrow keys to navigate, Enter to edit, a to accept) ---');
        draft = await reviewDraft(tui, draft, rubricRows);

        // 8. Global config questions
        tui.print('\n--- Assignment Settings ---');
        const ex           = existingConfig || {};
        const titleText    = await tui.ask('Assignment title', ex.titleText || '');
        const runtimeOpts  = [
            { label: 'browser', value: 'browser', desc: 'Puppeteer headless browser' },
            { label: 'build',   value: 'build',   desc: 'npm install + npm run build' },
            { label: 'both',    value: 'both',     desc: 'Browser + build' },
        ];
        const rtIdx       = Math.max(0, runtimeOpts.findIndex(o => o.value === ex.runtimeCheck));
        const runtimeCheck = await tui.askOptions('Runtime check mode', runtimeOpts, rtIdx);
        const summaryCell  = await tui.ask('Summary cell (e.g. A2, or blank)', ex.summaryCell || '');
        const graderCell   = await tui.ask('Grader cell (e.g. E1, or blank)',  ex.graderCell  || '');
        const titleCell    = await tui.ask('Title cell (e.g. A1, or blank)',   ex.titleCell   || '');

        // 9. Build and write
        const mappings = draft
            .filter(e => !e._skip)
            .map(({ _label, _skip, ...rest }) => rest);  // eslint-disable-line no-unused-vars

        const config = buildConfig(labName, {
            rubricName,
            titleText,
            runtimeCheck,
            features:     existingConfig?.analysis?.features || [],
            mappings,
            parts:        existingConfig?.analysis?.parts    || null,
            variations:   existingConfig?.variations         || null,
            analyzerName: null,
            optional: {
                titleCell,
                summaryCell,
                graderCell,
                codeReview:   existingConfig?.codeReview          || null,
                lintExclude:  existingConfig?.lint?.exclude        || null,
                packageCheck: existingConfig?.packageCheck         || null,
                repoHygiene:  existingConfig?.repoHygiene          || null,
            },
        });

        tui.print('\n--- Writing Config ---');
        writeLab(labDir, config, null, null);

        // Collect the summary so it can be printed to the normal terminal after destroy()
        summary = [
            `\n=== Done! ===`,
            `  ${mappings.length} mappings configured.`,
            `  Config: ${configPath}`,
            `  To verify: node bin/rubric_to_md.js ${JSON.stringify(rubricPath)}`,
        ];

    } finally {
        tui.destroy();
    }

    // Print to normal terminal after the alt-screen is gone
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
