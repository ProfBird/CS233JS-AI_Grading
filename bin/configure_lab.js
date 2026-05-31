#!/usr/bin/env node
// Usage: node bin/configure_lab.js [AssignmentName]
// LLM-assisted lab configuration wizard. Reads the rubric spreadsheet, generates a
// draft mapping table with AI, then lets the user review and edit before saving.

const fs   = require('fs');
const path = require('path');

const {
    normalizeAssignmentName, colLetter, findSpreadsheets, copyRubric,
    readRubricRows, readRubricCriteria, promptRubricRows, buildConfig, writeLab,
    MAPPING_TYPES, MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA, guessMappingType,
    buildMappingEntry, promptFields, createRL, ask, askBoolean, askOptions, askInt,
} = require('./create_lab.js');

const { loadLLMClient, setupLLMInteractive } = require('../lib/llm_client.js');

const CONFIGS_DIR       = path.join(__dirname, '..', 'configs');
const LOCAL_CONFIG_PATH = path.join(CONFIGS_DIR, 'local-config.json');

// ── Prompt helpers that forward the rl handle ─────────────────────────────

// Wrap the rl-free ask/askBoolean/askOptions from create_lab with a curried version.
function makeHelpers(rl) {
    return {
        ask:         (prompt) => ask(rl, prompt),
        askBoolean:  (q, def) => askBoolean(rl, q, def),
        askOptions:  (prompt, opts, def) => askOptions(rl, prompt, opts, def ?? 0),
    };
}

// Builds a prompt string that shows the current value as a [default] when present.
function defPrompt(text, current) {
    return current ? `${text} [${current}]: ` : `${text} (or blank): `;
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
Do NOT use type "feature" — it requires a regex that is not yet defined; prefer
manual, package_check, build_check, or lint instead.

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

// Downgrade a "feature" guess to "manual" unless its featureId already has a
// matching analysis.features regex — otherwise the row silently scores 0 at grade time.
function guardFeatureType(type, featureId, knownFeatureIds) {
    if (type !== 'feature') return type;
    if (featureId && knownFeatureIds.has(featureId)) return type;
    return 'manual';
}

// Best-effort match of a Grade-sheet label to a Rubric-sheet criteria entry by token
// overlap (the two sheets word/order items differently, so no exact join exists).
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
        const extra  = findCriteria(rr.label, criteria);
        const guessed = guessMappingType(extra ? `${rr.label} ${extra}` : rr.label);
        const type   = guardFeatureType(guessed, undefined, knownFeatureIds);
        const schema = MAPPING_TYPE_SCHEMA[type] ?? GENERIC_MAPPING_SCHEMA;
        const entry  = {
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
        const src = llmDraft[i] ?? {};
        const rawType = validTypes.has(src.type) ? src.type : guessMappingType(rr.label);
        const type = guardFeatureType(rawType, src.featureId, knownFeatureIds);
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

        // Copy known extra fields from LLM output
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

async function generateDraft(llm, labName, rubricRows, criteria = [], knownFeatureIds = new Set()) {
    const scoringRows = rubricRows.filter(r => !r.isSectionHeader);

    if (!llm) return heuristicDraft(scoringRows, criteria, knownFeatureIds);

    process.stdout.write('  Asking AI to draft configuration...');
    const response = await llm.chat(SYSTEM_PROMPT, buildLLMPrompt(labName, scoringRows, criteria));
    if (!response) {
        console.log(' failed. Using heuristic fallback.');
        return heuristicDraft(scoringRows, criteria, knownFeatureIds);
    }

    try {
        const parsed = JSON.parse(extractJSON(response));
        if (!Array.isArray(parsed)) throw new Error('not an array');
        console.log(' done.');
        return mergeLLMResponse(parsed, scoringRows, knownFeatureIds);
    } catch (e) {
        console.log(` parse error (${e.message}). Using heuristic fallback.`);
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

// ── Review + edit loop ────────────────────────────────────────────────────

async function reviewDraft(rl, draft, rubricRows) {
    const scoringRows = rubricRows.filter(r => !r.isSectionHeader);

    while (true) {
        printDraftTable(draft);

        const accept = await askBoolean(rl, 'Accept all mappings?', true);
        if (accept) break;

        const input = await ask(rl, 'Row number(s) to edit (comma-separated, or "all"): ');
        let indices;
        if (input.toLowerCase() === 'all') {
            indices = draft.map((_, i) => i);
        } else {
            indices = input.split(',')
                .map(s => parseInt(s.trim(), 10) - 1)
                .filter(i => i >= 0 && i < draft.length);
        }
        if (!indices.length) { console.log('  No valid row numbers.'); continue; }

        const SKIP = { label: '— skip (no mapping, graded by hand) —', value: '__skip__' };
        const typeChoices = [...MAPPING_TYPES, SKIP];

        for (const idx of indices) {
            const rr      = scoringRows[idx];
            const current = draft[idx];
            console.log(`\n  Row ${idx + 1}: "${current._label || rr.label}"  [${current.cell}]`);

            const guessedIdx = current._skip
                ? typeChoices.length - 1
                : Math.max(0, MAPPING_TYPES.findIndex(t => t.value === current.type));
            const newType = await askOptions(rl, '  Mapping type:', typeChoices, guessedIdx);
            if (newType === '__skip__') {
                draft[idx] = { _label: rr.label, cell: rr.scoreCell, _skip: true };
                continue;
            }
            const newEntry = await buildMappingEntry(rl, newType, rr, current);
            if (newEntry) {
                const entry = { ...newEntry, _label: rr.label };
                if (rr.stockComments) entry.stockComments = rr.stockComments;
                draft[idx] = entry;
            }
        }
    }

    return draft;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log('Usage: node bin/configure_lab.js [AssignmentName]');
        console.log('LLM-assisted rubric → config wizard.');
        console.log('Reads the rubric spreadsheet, generates a draft mapping table with AI,');
        console.log('presents it for review, and writes the config JSON.');
        process.exit(0);
    }

    console.log('\n=== Configure Lab Grading (AI-assisted) ===\n');

    const rl      = createRL();
    const helpers = makeHelpers(rl);

    try {
        // 1. LLM setup
        let llm = loadLLMClient(LOCAL_CONFIG_PATH);
        if (llm) {
            console.log(`  LLM: ${llm.provider}  model: ${llm.model || '(auto)'}\n`);
        } else {
            console.log('  No LLM configured yet.');
            const setup = await askBoolean(rl, '  Set one up now?', true);
            if (setup) {
                llm = await setupLLMInteractive(LOCAL_CONFIG_PATH, helpers);
            }
            if (!llm) console.log('  Proceeding with heuristic mapping (no AI).\n');
        }

        // 2. Assignment name
        let labName = '';
        const rawArg = process.argv[2];
        if (rawArg) {
            labName = normalizeAssignmentName(rawArg);
            if (!labName) {
                console.error(`Invalid assignment name: ${rawArg}. Use a number (07), a lab name (Lab07), or a slug (TermProject).`);
                process.exit(1);
            }
        }
        if (!labName) {
            while (true) {
                const raw = await ask(rl, 'Assignment name (e.g. TermProject, 07): ');
                labName = normalizeAssignmentName(raw);
                if (labName) break;
                console.log('  Invalid — use letters, numbers, underscores, or hyphens.');
            }
        }

        const labDir = path.join(CONFIGS_DIR, labName);
        if (!fs.existsSync(labDir)) {
            fs.mkdirSync(labDir, { recursive: true });
            console.log(`  Created: ${labDir}`);
        }

        // 3. Find rubric
        const found = findSpreadsheets(labDir);
        let rubricName;
        if (found.length === 0) {
            console.log('\n  No spreadsheet found. Please provide one to copy in.');
            const r = await copyRubric(rl, labName);
            rubricName = r.rubricName;
            const dest = path.join(labDir, rubricName);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(r.rubricPath, dest);
            console.log(`  Copied to: ${dest}`);
        } else if (found.length === 1) {
            rubricName = found[0];
            console.log(`  Rubric: ${rubricName}`);
        } else {
            rubricName = await askOptions(rl, '  Multiple spreadsheets — which to configure?',
                found.map(f => ({ label: f, value: f })));
        }
        const rubricPath = path.join(labDir, rubricName);

        // Load any existing config now — used for defaults, feature-id guard, and preservation.
        let existingConfig = null;
        const configPath = path.join(labDir, `${labName.toLowerCase()}_config.json`);
        try { existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) {}
        const knownFeatureIds = new Set(
            (existingConfig?.analysis?.features || []).map(f => f.id).filter(Boolean)
        );

        // 4. Read rubric with column confirmation
        console.log('\n--- Reading Rubric ---');
        const rubricRows = await promptRubricRows(rl, rubricPath);
        if (!rubricRows) { console.error('Could not read rubric. Exiting.'); process.exit(1); }
        const scoringRows = rubricRows.filter(r => !r.isSectionHeader);
        console.log(`  ${scoringRows.length} scoring rows, ${rubricRows.length - scoringRows.length} section headers.`);

        // Read Criteria descriptions from the Rubric sheet (reference context for the LLM).
        const criteria = readRubricCriteria(rubricPath);
        if (criteria.length) console.log(`  Found ${criteria.length} criteria descriptions on the Rubric sheet.`);

        // 5. Generate draft
        console.log('\n--- Generating Draft ---');
        let draft = await generateDraft(llm, labName, rubricRows, criteria, knownFeatureIds);

        // 6. Review + edit
        console.log('\n--- Review Draft ---');
        draft = await reviewDraft(rl, draft, rubricRows);

        // 7. Global config questions (defaults pre-filled from any existing config)
        console.log('\n--- Assignment Settings ---');
        const ex = existingConfig || {};
        const titleText    = await ask(rl, defPrompt('Assignment title', ex.titleText)) || ex.titleText || '';
        const runtimeOpts  = [
            { label: 'browser', value: 'browser', desc: 'Puppeteer' },
            { label: 'build',   value: 'build',   desc: 'npm install + npm run build' },
            { label: 'both',    value: 'both',     desc: 'Browser + build' },
        ];
        const rtIdx = Math.max(0, runtimeOpts.findIndex(o => o.value === ex.runtimeCheck));
        const runtimeCheck = await askOptions(rl, 'Runtime check mode:', runtimeOpts, rtIdx);
        const summaryCell = await ask(rl, defPrompt('Summary cell (e.g. A2)', ex.summaryCell)) || ex.summaryCell || '';
        const graderCell  = await ask(rl, defPrompt('Grader cell (e.g. E1)',  ex.graderCell))  || ex.graderCell  || '';
        const titleCell   = await ask(rl, defPrompt('Title cell (e.g. A1)',   ex.titleCell))   || ex.titleCell   || '';

        // 8. Build and write
        // Drop skipped rows and the _label display field before saving.
        const mappings = draft
            .filter(e => !e._skip)
            .map(({ _label, _skip, ...rest }) => rest);

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

        console.log('\n--- Writing Config ---');
        writeLab(labDir, config, null, null);

        console.log('\n=== Done! ===');
        console.log(`  ${mappings.length} mappings configured.`);
        console.log(`  To verify: node bin/rubric_to_md.js ${JSON.stringify(rubricPath)}`);
        console.log();

    } finally {
        rl.close();
    }
}

module.exports = {
    heuristicDraft, mergeLLMResponse, guardFeatureType, findCriteria,
    buildLLMPrompt, buildCriteriaRef, extractJSON, summaryNotes, defPrompt,
    printDraftTable,
};

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}
