'use strict';
// Driver-based rubric prompt functions used by the TUI wizard (configure_lab.js).
//
// Driver interface (4 I/O methods + 2 lifecycle):
//   ask(prompt, def?)          → Promise<string>
//   askBoolean(question, def?) → Promise<boolean>
//   askInt(prompt, def?)       → Promise<number>
//   askOptions(prompt, opts, defIdx?) → Promise<value>
//   print(line)
//   exit(code?)

import fs from 'fs';
import path from 'path';
import XLSX from './xlsx.js';

import {
    colLetter, colLetterToIndex,
    sheetRows, detectRubricLayout, readRubricRows, readRubricCriteria,
    MAPPING_TYPE_SCHEMA, GENERIC_MAPPING_SCHEMA,
} from './lab_config.js';

// ── promptRubricRows ──────────────────────────────────────────────────────
// Reads a rubric file, auto-detects the Grade sheet column layout, lets the
// user confirm or correct it, then returns the parsed row array.

async function promptRubricRows(driver, rubricPath) {
    let wb;
    try { wb = XLSX.readFile(rubricPath); } catch (e) {
        driver.print(`  Could not read rubric file: ${e.message}`);
        return null;
    }
    const ws = wb?.Sheets['Grade'];
    if (!ws) { driver.print('  No "Grade" sheet found in the rubric.'); return null; }
    const rows = sheetRows(ws);

    let layout = detectRubricLayout(rows);
    if (!layout) {
        const alt = await driver.ask(
            'Max-points column header not found (tried: possible, points, pts, max). ' +
            'Enter exact header text or leave blank to skip',
            ''
        );
        if (!alt) return null;
        const altRe = new RegExp(`^${alt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        layout = detectRubricLayout(rows, altRe);
        if (!layout) { driver.print(`  Could not find "${alt}". Skipping mappings.`); return null; }
    }

    driver.print(`  Detected columns in Grade sheet (header row ${layout.headerRow + 1}):`);
    driver.print(`    Max points : ${colLetter(layout.possibleCol)}`);
    driver.print(`    Score      : ${colLetter(layout.scoreCol)}`);
    driver.print(`    Comments   : ${colLetter(layout.commentCol)}`);
    if (layout.fullCol >= 0) {
        driver.print(
            `    Stock (100%/<100%/0%): ` +
            `${colLetter(layout.fullCol)}/${colLetter(layout.partialCol)}/${colLetter(layout.zeroCol)}`
        );
    }

    const ok = await driver.askBoolean('Are these columns correct?', true);
    if (!ok) {
        const p = await driver.ask('Max-points column letter', colLetter(layout.possibleCol));
        const s = await driver.ask('Score/grade column letter', colLetter(layout.scoreCol));
        const c = await driver.ask('Comments column letter',    colLetter(layout.commentCol));
        if (p) layout.possibleCol = colLetterToIndex(p);
        if (s) layout.scoreCol    = colLetterToIndex(s);
        if (c) layout.commentCol  = colLetterToIndex(c);
    }

    return readRubricRows(rubricPath, layout);
}

// ── promptRubricCriteria ──────────────────────────────────────────────────
// Reads the optional Rubric sheet for AI-context criteria descriptions.
// Auto-detects columns; reports the count but does not prompt for corrections
// (criteria are only hints, not grading data).

async function promptRubricCriteria(driver, rubricPath) {
    const criteria = readRubricCriteria(rubricPath);
    if (criteria.length === 0) {
        driver.print('  No "Rubric" sheet or no Criteria column found — skipping criteria descriptions.');
    } else {
        driver.print(`  Found ${criteria.length} criteria descriptions.`);
    }
    return criteria;
}

// ── copyRubric ────────────────────────────────────────────────────────────
// Prompts for a rubric file path (up to 3 attempts), suggests a canonical
// name, and returns { rubricPath, rubricName, ext }.

async function copyRubric(driver, labName) {
    driver.print('\n--- Rubric Spreadsheet ---');
    driver.print('  Provide a path to the .xlsx or .xlsm rubric file.');

    let rubricPath;
    for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await driver.ask('Path to rubric file', '');
        const candidate = raw.replace(/^["']|["']$/g, '').trim();
        if (!candidate) continue;
        if (!fs.existsSync(candidate)) { driver.print(`  File not found: ${candidate}`); continue; }
        if (!fs.statSync(candidate).isFile()) {
            driver.print('  That is a directory — provide the full file path.');
            continue;
        }
        rubricPath = candidate;
        break;
    }
    if (!rubricPath) {
        driver.print('  No rubric provided after 3 attempts. Aborting.');
        driver.exit(1);
    }

    const ext = path.extname(rubricPath).toLowerCase();
    if (ext !== '.xlsx' && ext !== '.xlsm') {
        driver.print('  Warning: rubric should be .xlsx or .xlsm. Copying anyway.');
    }

    const suggestedName = `CS233JS_${labName}_Rubric${ext}`;
    const nameInput = await driver.ask('Rubric filename', suggestedName);
    const rubricName = path.basename(nameInput || suggestedName);

    return { rubricPath, rubricName, ext };
}

// ── promptFields ──────────────────────────────────────────────────────────
// Walks a MAPPING_TYPE_SCHEMA fields array, prompting the user for each value.
// Returns a plain object of { key: value } pairs, or null if a required field
// is left empty.

async function promptFields(driver, fields, currentValues = {}) {
    const result = {};
    for (const f of fields) {
        const cur = currentValues[f.key];
        if (f.type === 'int') {
            const def = cur ?? f.default ?? 0;
            const label = f.prompt.replace(/\s*\[.*?\]/, '').replace(/:\s*$/, '').trim();
            result[f.key] = await driver.askInt(label, def);
        } else if (f.type === 'options') {
            const defIdx = cur !== undefined
                ? Math.max(0, f.options.findIndex(o => o.value === cur))
                : 0;
            const label = f.prompt.replace(/:\s*$/, '').trim();
            result[f.key] = await driver.askOptions(label, f.options, defIdx);
        } else {
            const def = cur ?? f.default ?? '';
            const label = f.prompt.replace(/:\s*$/, '').trim();
            const raw = await driver.ask(label, def);
            if (f.required && !raw && !def) {
                driver.print('  Required field empty — skipping this entry.');
                return null;
            }
            if (f.optional && !raw && !def) continue;
            result[f.key] = raw || def;
        }
    }
    return result;
}

// ── Feature detection-rule prompts ─────────────────────────────────────────
// A `feature` mapping needs a matching analysis.features[] definition describing
// how to detect it. These guide the user through either a single regex (counted)
// or a simple flat allOf/anyOf set of regexes (boolean). Nested OR-of-ANDs trees
// are left to hand-editing — see the USER_GUIDE "Available checks" notes.

// Ask for one regex; re-prompt on invalid syntax. Returns the pattern, or null if blank.
async function promptRegex(driver, label) {
    while (true) {
        const raw = (await driver.ask(label)).trim();
        if (!raw) return null;
        try { new RegExp(raw); return raw; }
        catch (e) { driver.print(`  Invalid regex (${e.message}); try again or leave blank to cancel.`); }
    }
}

// Collect a list of regexes for an allOf/anyOf rule (blank line ends the list).
// Invalid patterns are reported and skipped rather than written into the config.
async function promptRegexList(driver, combinator) {
    const verb = combinator === 'allOf' ? 'ALL must be present (AND)' : 'ANY may be present (OR)';
    driver.print(`  Enter patterns — ${verb}. Blank line to finish.`);
    const patterns = [];
    while (true) {
        const raw = (await driver.ask(`Pattern ${patterns.length + 1} (blank to finish)`)).trim();
        if (!raw) break;
        try { new RegExp(raw); patterns.push(raw); }
        catch (e) { driver.print(`  Invalid regex (${e.message}); not added.`); }
    }
    return patterns;
}

// Builds a `feature` mapping AND its analysis.features[] definition, attaching the
// definition as `_featureDef` for the wizard to merge into config.analysis.features.
async function buildFeatureEntry(driver, rubricRow, currentValues = {}) {
    const featureId = (await driver.ask('Feature ID (e.g. fetch_api)', currentValues.featureId || '')).trim();
    if (!featureId) { driver.print('  Feature ID is required — skipping this entry.'); return null; }

    const combinator = await driver.askOptions('How is this feature detected?', [
        { label: 'A single pattern',        value: 'single', desc: 'One regex; counts matches' },
        { label: 'ALL of several patterns', value: 'allOf',  desc: 'Every pattern must appear (AND)' },
        { label: 'ANY of several patterns', value: 'anyOf',  desc: 'At least one pattern appears (OR)' },
    ]);

    const fileRegex = (await driver.ask('Files to search (regex)', currentValues.fileRegex || '\\.js$')).trim() || '\\.js$';

    let featureDef, minCount;
    if (combinator === 'single') {
        const regex = await promptRegex(driver, 'Regex pattern');
        if (regex === null) { driver.print('  No pattern entered — skipping this entry.'); return null; }
        minCount = await driver.askInt('Min matches for full credit', currentValues.minCount ?? 1);
        featureDef = { id: featureId, regex, fileRegex };
    } else {
        const patterns = await promptRegexList(driver, combinator);
        if (patterns.length === 0) { driver.print('  No patterns entered — skipping this entry.'); return null; }
        // A `match` feature is boolean (0/1); minCount must be 1 — a higher value could never pass.
        minCount = 1;
        featureDef = { id: featureId, match: { [combinator]: patterns.map(regex => ({ regex })) }, fileRegex };
    }

    const maxScore = await driver.askInt('Max score', currentValues.maxScore ?? 0);

    const m = { type: 'feature', cell: rubricRow.scoreCell, featureId, minCount, maxScore, _featureDef: featureDef };
    if (rubricRow.commentCell) m.commentCell = rubricRow.commentCell;
    return m;
}

// ── buildMappingEntry ─────────────────────────────────────────────────────
// Prompts for the type-specific fields of one rubric row and returns a
// mapping entry object, or null if a required field was empty.

async function buildMappingEntry(driver, type, rubricRow, currentValues = {}) {
    // `feature` needs an analysis.features[] definition (regex or match), built interactively.
    if (type === 'feature') return buildFeatureEntry(driver, rubricRow, currentValues);

    const schema = MAPPING_TYPE_SCHEMA[type] ?? GENERIC_MAPPING_SCHEMA;
    const fields = await promptFields(driver, schema.fields, currentValues);
    if (fields === null) return null;
    const m = { type, cell: rubricRow.scoreCell, ...(schema.fixed ?? {}), ...fields };
    if (rubricRow.commentCell) m.commentCell = rubricRow.commentCell;
    return m;
}

export { promptRubricRows, promptRubricCriteria, copyRubric, promptFields, buildMappingEntry, buildFeatureEntry };
