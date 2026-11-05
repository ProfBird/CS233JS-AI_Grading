/**
 * config_validation.js
 *
 * Pure config-validation logic extracted out of bin/grade.js so it can be unit-tested
 * directly instead of only exercised end-to-end. `validateConfig` throws on failure
 * (instead of calling process.exit) so callers control the exit behavior; bin/grade.js
 * catches and exits with the thrown message.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { VALID_RUNTIME_MODES } from '../pipeline/runtime_check.js';
import { VALID_MAPPING_TYPES } from './handler_registry.js';
import { OVERRIDABLE_KEYS } from './student_group.js';
import { mergeConfig } from './merge_config.js';

// The providers llm_check rows may use (src/lib/llm_check.js); kept here rather than imported
// so validation doesn't load the LLM client.
const LLM_PROVIDERS = ['ollama', 'openrouter', 'anthropic', 'openai'];

// Validate that a cell reference looks like "A1" or "AA23"
function isValidCellRef(ref) {
    return typeof ref === 'string' && /^[A-Z]+\d+$/.test(ref);
}

// Loads config.handlerModules (paths to JS modules that call registerHandler() as a
// side effect on import, relative to the lab's config dir) BEFORE validateConfig() runs
// — a mapping type registered by one of these modules must be recognized as valid before
// validation checks every mapping's "type" against VALID_MAPPING_TYPES. Mirrors the
// custom-analyzer loading pattern in analyze_code.js: a failing module is logged and
// skipped, never a hard crash.
async function loadHandlerModules(config, labConfigDir) {
    if (!Array.isArray(config.handlerModules)) return;
    for (const rel of config.handlerModules) {
        const modulePath = path.resolve(labConfigDir, rel);
        if (!fs.existsSync(modulePath)) {
            console.warn(`  WARNING: handlerModules entry not found: ${modulePath}`);
            continue;
        }
        try {
            await import(pathToFileURL(modulePath).href);
            console.log(`  Loaded handler module: ${rel}`);
        } catch (e) {
            console.warn(`  WARNING: Failed to load handler module "${rel}": ${e.message}`);
        }
    }
}

// Throws an Error (with all validation issues joined into the message) instead of
// exiting the process directly, so this is unit-testable without stubbing process.exit.
// ---------- Running student programs and tests (execution / runCheck / testCheck) ----------

const isPosInt = v => Number.isInteger(v) && v > 0;
const isRegex = src => { try { new RegExp(src); return true; } catch (e) { return false; } };
const isNonEmptyString = v => typeof v === 'string' && v.trim() !== '';

// One run's settings (runCheck object, or one entry of a runCheck array).
function runEntryErrors(rc, label) {
    const errors = [];
    if (rc.entry !== undefined) {
        const entries = Array.isArray(rc.entry) ? rc.entry : [rc.entry];
        if (entries.length === 0 || !entries.every(isNonEmptyString)) {
            errors.push(`${label}.entry: must be a file name or path, or a list of them`);
        }
    }
    if (rc.supportFiles !== undefined) {
        const ok = Array.isArray(rc.supportFiles) && rc.supportFiles.every(e =>
            isNonEmptyString(e)
            || (e && typeof e === 'object' && isNonEmptyString(e.from) && (e.to === undefined || isNonEmptyString(e.to))));
        if (!ok) errors.push(`${label}.supportFiles: must be a list of paths, or { "from": ..., "to": ... } entries`);
    }
    if (rc.expectPatterns !== undefined && !(Array.isArray(rc.expectPatterns) && rc.expectPatterns.every(isRegex))) {
        errors.push(`${label}.expectPatterns: must be a list of valid regular expressions`);
    }
    if (rc.stdin !== undefined && typeof rc.stdin !== 'string') errors.push(`${label}.stdin: must be text`);
    if (rc.timeoutMs !== undefined && !isPosInt(rc.timeoutMs)) errors.push(`${label}.timeoutMs: must be a positive whole number of milliseconds`);
    return errors;
}

// One test script's settings (testCheck object, or one entry of a testCheck array).
function testEntryErrors(tc, label) {
    const errors = [];
    if (tc.mode !== undefined && !['pytest', 'script'].includes(tc.mode)) {
        errors.push(`${label}.mode: "${tc.mode}" must be "pytest" or "script"`);
    }
    if (tc.mode === 'script') {
        const entries = Array.isArray(tc.entry) ? tc.entry : [tc.entry];
        if (entries.length === 0 || !entries.every(isNonEmptyString)) errors.push(`${label}.entry: "script" mode needs the test script to run`);
    }
    for (const k of ['passPattern', 'failPattern']) {
        if (tc[k] !== undefined && (typeof tc[k] !== 'string' || !isRegex(tc[k]))) errors.push(`${label}.${k}: must be a valid regular expression`);
    }
    if (tc.timeoutMs !== undefined && !isPosInt(tc.timeoutMs)) errors.push(`${label}.timeoutMs: must be a positive whole number of milliseconds`);
    if (tc.strict !== undefined && typeof tc.strict !== 'boolean') errors.push(`${label}.strict: must be true or false`);
    if (tc.env !== undefined && !(tc.env && typeof tc.env === 'object' && !Array.isArray(tc.env) && Object.values(tc.env).every(v => typeof v === 'string'))) {
        errors.push(`${label}.env: must be an object of text values`);
    }
    if (tc.supportFiles !== undefined) errors.push(...runEntryErrors({ supportFiles: tc.supportFiles }, label));
    return errors;
}

// runCheck/testCheck may be one entry (an object) or several (an array, each with a unique id).
function entriesErrors(value, key, checkEntry) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        return value && typeof value === 'object' ? checkEntry(value, key) : [`${key}: must be an object or a list of them`];
    }
    const errors = [];
    const seen = new Set();
    value.forEach((e, i) => {
        const label = `${key}[${i}]`;
        if (!e || typeof e !== 'object') { errors.push(`${label}: must be an object`); return; }
        if (!isNonEmptyString(e.id)) errors.push(`${label}.id: each entry in a list needs an "id"`);
        else if (seen.has(e.id)) errors.push(`${label}.id: "${e.id}" is used twice`);
        else seen.add(e.id);
        errors.push(...checkEntry(e, label));
    });
    return errors;
}

// The ids a runCheck/testCheck defines (empty for the single-object form).
const entryIds = value => new Set(Array.isArray(value) ? value.map(e => e && e.id).filter(Boolean) : []);

/**
 * Errors in a config's settings for running programs and tests, including that every
 * run_check `runId` / test_check `testId` names an entry this config defines.
 * @param {object} cfg - the lab config, or a group's merged config
 * @param {string} [where] - appended to messages, e.g. ' (group B)'
 */
function runSettingsErrors(cfg, where = '') {
    const errors = [];
    const ex = cfg.execution;
    if (ex !== undefined) {
        if (ex.cwd !== undefined && !['scratch', 'copy'].includes(ex.cwd)) errors.push(`execution.cwd: "${ex.cwd}" must be "scratch" or "copy"`);
        if (ex.envCacheDir !== undefined && !isNonEmptyString(ex.envCacheDir)) errors.push('execution.envCacheDir: must be a folder path');
        for (const k of ['timeoutMs', 'installTimeoutMs']) {
            if (ex[k] !== undefined && !isPosInt(ex[k])) errors.push(`execution.${k}: must be a positive whole number of milliseconds`);
        }
    }
    errors.push(...entriesErrors(cfg.runCheck, 'runCheck', runEntryErrors));
    errors.push(...entriesErrors(cfg.testCheck, 'testCheck', testEntryErrors));

    const runIds = entryIds(cfg.runCheck);
    const testIds = entryIds(cfg.testCheck);
    (Array.isArray(cfg.mappings) ? cfg.mappings : []).forEach((m, i) => {
        if (m.type === 'run_check' && m.runId !== undefined && !runIds.has(m.runId)) {
            errors.push(`mappings[${i}].runId: "${m.runId}" isn't one of runCheck's ids (${[...runIds].join(', ') || 'none — runCheck isn\'t a list'})`);
        }
        if (m.type === 'test_check' && m.testId !== undefined && !testIds.has(m.testId)) {
            errors.push(`mappings[${i}].testId: "${m.testId}" isn't one of testCheck's ids (${[...testIds].join(', ') || 'none — testCheck isn\'t a list'})`);
        }
    });
    return where ? errors.map(e => e + where) : errors;
}

/**
 * Errors in config.variations: shape, allowed override keys, and each group's merged config
 * validated on its own with the full lab-config checks (feature regexes, packageCheck,
 * webContent, run/test settings, …) — rubric rows are shared by every group, so e.g. a runId
 * must exist in every group's runCheck, and a bad regex in one group's features must not wait
 * until grading. Errors the lab's own config already has aren't repeated per group.
 */
function groupErrors(config) {
    const v = config.variations;
    if (v === undefined) return [];
    if (!v || typeof v !== 'object' || Array.isArray(v)) return ['variations: must be an object of groups, e.g. { "A": {...}, "B": {...} }'];
    const withoutGroups = c => { const copy = { ...c }; delete copy.variations; return copy; };
    const baseErrors = new Set(configErrors(withoutGroups(config)));
    const errors = [];
    for (const [letter, group] of Object.entries(v)) {
        if (!group || typeof group !== 'object') { errors.push(`variations.${letter}: must be an object`); continue; }
        if (group.overrides === undefined) continue;
        const ov = group.overrides;
        if (!ov || typeof ov !== 'object' || Array.isArray(ov)) { errors.push(`variations.${letter}.overrides: must be an object`); continue; }
        const bad = Object.keys(ov).filter(k => !OVERRIDABLE_KEYS.includes(k));
        if (bad.length) errors.push(`variations.${letter}.overrides: can't set ${bad.join(', ')} (allowed: ${OVERRIDABLE_KEYS.join(', ')})`);
        if (bad.length) continue;
        const merged = withoutGroups(mergeConfig(config, ov));
        errors.push(...configErrors(merged).filter(e => !baseErrors.has(e)).map(e => `${e} (group ${letter})`));
    }
    return errors;
}

// Every validation error in a config (an empty list when it's valid). validateConfig() below
// throws them; groupErrors() also runs this on each group's merged config.
function configErrors(config) {
    const errors = [];

    // Extract-only configs need no rubric, runtimeCheck, or mappings
    if (config.extractOnly === true) {
        return errors;
    }

    // Text-report labs (config.textReport === true) have no rubric spreadsheet —
    // rubricName is only required when a spreadsheet will actually be written.
    if (config.textReport !== true && (!config.rubricName || typeof config.rubricName !== 'string')) {
        errors.push(`Missing or invalid "rubricName" (must be a string, or set "textReport": true)`);
    }

    if (!config.runtimeCheck) {
        errors.push(`Missing "runtimeCheck" (must be "${[...VALID_RUNTIME_MODES].join('" or "')}")`);
    } else if (!VALID_RUNTIME_MODES.has(config.runtimeCheck)) {
        errors.push(`Invalid runtimeCheck "${config.runtimeCheck}" (must be one of: ${[...VALID_RUNTIME_MODES].join(', ')})`);
    }

    if (!Array.isArray(config.mappings) || config.mappings.length === 0) {
        errors.push(`Missing or empty "mappings" array`);
    } else {
        config.mappings.forEach((map, i) => {
            const prefix = `mappings[${i}]`;
            if (!map.type) {
                errors.push(`${prefix}: missing "type"`);
            } else if (!VALID_MAPPING_TYPES.has(map.type)) {
                errors.push(`${prefix}: unknown type "${map.type}"`);
            }
            if (map.cell && !isValidCellRef(map.cell)) {
                errors.push(`${prefix}.cell: "${map.cell}" is not a valid cell reference`);
            }
            if (map.type === 'developer_comments' && map.scope !== undefined && !['any', 'each'].includes(map.scope)) {
                errors.push(`${prefix}.scope: "${map.scope}" must be "any" or "each"`);
            }
            if (map.type === 'llm_check') {
                if (!isNonEmptyString(map.criterion)) errors.push(`${prefix}.criterion: llm_check needs the rubric criterion for the AI to judge`);
                if (map.guidance !== undefined && typeof map.guidance !== 'string') errors.push(`${prefix}.guidance: must be text`);
                if (map.files !== undefined && !(typeof map.files === 'string' && isRegex(map.files))) errors.push(`${prefix}.files: must be a valid regular expression`);
            }
            if (map.type === 'manual' && map.reviewRow !== undefined) {
                const rows = Array.isArray(map.reviewRow) ? map.reviewRow : [map.reviewRow];
                if (rows.length === 0 || rows.some(r => typeof r !== 'string' || !r.trim())) {
                    errors.push(`${prefix}.reviewRow: must be a non-empty string or array of strings`);
                }
            }
            if (map.type === 'manual' && map.reviewRowOccurrence !== undefined
                && !(Number.isInteger(map.reviewRowOccurrence) && map.reviewRowOccurrence >= 1)) {
                errors.push(`${prefix}.reviewRowOccurrence: must be a positive integer`);
            }
            if (map.type === 'developer_comments' && map.requireAiDisclosure !== undefined
                && typeof map.requireAiDisclosure !== 'boolean') {
                errors.push(`${prefix}.requireAiDisclosure: must be true or false`);
            }
            if (map.type === 'developer_comments' && map.ignoreCommentsBy !== undefined
                && !(Array.isArray(map.ignoreCommentsBy) && map.ignoreCommentsBy.every(v => typeof v === 'string' && v.trim()))) {
                errors.push(`${prefix}.ignoreCommentsBy: must be an array of non-empty strings`);
            }
            if (map.type === 'developer_comments' && map.require !== undefined) {
                const valid = ['name', 'date', 'ai'];
                if (!Array.isArray(map.require) || map.require.some(k => !valid.includes(k))) {
                    errors.push(`${prefix}.require: must be an array of ${valid.map(v => `"${v}"`).join(', ')}`);
                }
            }
            if (map.commentCell && !isValidCellRef(map.commentCell)) {
                errors.push(`${prefix}.commentCell: "${map.commentCell}" is not a valid cell reference`);
            }
        });
    }

    if (config.analysis && config.analysis.customAnalyzer && typeof config.analysis.customAnalyzer !== 'string') {
        errors.push(`"analysis.customAnalyzer" must be a string (file path relative to configs/)`);
    }

    if (config.analysis && Array.isArray(config.analysis.features)) {
        config.analysis.features.forEach((feat, i) => {
            const prefix = `analysis.features[${i}]`;
            if (!feat.id) errors.push(`${prefix}: missing "id"`);
            // A feature needs either a single "regex" (counted) or a nested "match"
            // tree of allOf/anyOf/regex (boolean) — see analyze_code.js evalMatchNode.
            if (!feat.regex && !feat.match) errors.push(`${prefix}: needs "regex" or "match"`);
            // Compile every pattern now, so a typo fails at startup rather than as
            // "Analysis failed" for each student at grading time.
            const badRegex = (src, flags, where) => {
                try { new RegExp(src, flags || ''); } catch (e) { errors.push(`${prefix}.${where}: invalid regular expression (${e.message})`); }
            };
            if (typeof feat.regex === 'string') badRegex(feat.regex, feat.flags, 'regex');
            if (typeof feat.fileRegex === 'string') badRegex(feat.fileRegex, null, 'fileRegex');
            const walkMatch = (node, where) => {
                if (!node || typeof node !== 'object') return;
                if (typeof node.regex === 'string') badRegex(node.regex, node.flags, `${where}.regex`);
                for (const k of ['allOf', 'anyOf']) {
                    if (Array.isArray(node[k])) node[k].forEach((child, j) => walkMatch(child, `${where}.${k}[${j}]`));
                }
            };
            walkMatch(feat.match, 'match');
        });
    }

    // --- skipStudents (names left out of grading) ---
    if (config.skipStudents !== undefined
        && !(Array.isArray(config.skipStudents) && config.skipStudents.every(isNonEmptyString))) {
        errors.push('skipStudents: must be an array of student names');
    }

    // --- llmCheck (llm_check rows' AI model) ---
    if (config.llmCheck !== undefined) {
        const lc = config.llmCheck;
        if (!lc || typeof lc !== 'object' || Array.isArray(lc)) errors.push('llmCheck: must be an object');
        else {
            if (lc.provider !== undefined && !LLM_PROVIDERS.includes(lc.provider)) errors.push(`llmCheck.provider: "${lc.provider}" must be one of ${LLM_PROVIDERS.join(', ')}`);
            for (const k of ['model', 'baseUrl']) if (lc[k] !== undefined && !isNonEmptyString(lc[k])) errors.push(`llmCheck.${k}: must be text`);
            if (lc.redactTerms !== undefined && !(Array.isArray(lc.redactTerms) && lc.redactTerms.every(isNonEmptyString))) errors.push('llmCheck.redactTerms: must be an array of text');
            for (const k of ['redactNames', 'cache']) if (lc[k] !== undefined && typeof lc[k] !== 'boolean') errors.push(`llmCheck.${k}: must be true or false`);
            for (const k of ['maxChars', 'timeoutMs', 'concurrency']) if (lc[k] !== undefined && !isPosInt(lc[k])) errors.push(`llmCheck.${k}: must be a positive whole number`);
        }
    }

    // --- execution / runCheck / testCheck, for the lab and for each group's overrides ---
    errors.push(...runSettingsErrors(config));
    errors.push(...groupErrors(config));

    // --- webContent block (check_web_content.js) + the mapping types that read it ---
    const WEB_CONTENT_TYPES = new Set(['element_check', 'css_selector_check', 'css_property_check', 'file_count']);
    const webMappings = Array.isArray(config.mappings)
        ? config.mappings.filter(m => WEB_CONTENT_TYPES.has(m.type))
        : [];
    if (webMappings.length > 0 && !config.webContent) {
        errors.push(`Mappings of type ${[...new Set(webMappings.map(m => m.type))].join('/')} require a "webContent" config block`);
    }
    if (config.webContent) {
        const wc = config.webContent;
        const seenIds = new Set();
        (Array.isArray(wc.requiredElements) ? wc.requiredElements : []).forEach((entry, i) => {
            const prefix = `webContent.requiredElements[${i}]`;
            if (!entry.selector || typeof entry.selector !== 'string') {
                errors.push(`${prefix}: missing "selector"`);
                return;
            }
            if (entry.minCount !== undefined && (!Number.isInteger(entry.minCount) || entry.minCount < 1)) {
                errors.push(`${prefix}: "minCount" must be a positive integer`);
            }
            const id = entry.id || entry.selector;
            if (seenIds.has(id)) errors.push(`${prefix}: duplicate id "${id}"`);
            seenIds.add(id);
        });
        for (const key of ['requiredCssSelectors', 'requiredCssProperties']) {
            if (wc[key] !== undefined && (!Array.isArray(wc[key]) || wc[key].some(s => typeof s !== 'string'))) {
                errors.push(`webContent.${key} must be an array of strings`);
            }
        }
        const countIds = new Set();
        (Array.isArray(wc.fileCounts) ? wc.fileCounts : []).forEach((fc, i) => {
            const prefix = `webContent.fileCounts[${i}]`;
            if (!fc.id) errors.push(`${prefix}: missing "id"`);
            else countIds.add(fc.id);
            if (!fc.pattern) {
                errors.push(`${prefix}: missing "pattern"`);
            } else {
                try { new RegExp(fc.pattern); } catch { errors.push(`${prefix}: "pattern" is not a valid regex`); }
            }
            if (fc.min !== undefined && (!Number.isInteger(fc.min) || fc.min < 1)) {
                errors.push(`${prefix}: "min" must be a positive integer`);
            }
        });
        for (const map of webMappings) {
            if (map.type === 'file_count' && !countIds.has(map.countId)) {
                errors.push(`file_count mapping: countId "${map.countId}" has no matching webContent.fileCounts entry`);
            }
        }
    }

    if (config.repoHygiene) {
        if (!config.repoHygiene.excludedFromRepo || !Array.isArray(config.repoHygiene.excludedFromRepo)) {
            errors.push(`"repoHygiene.excludedFromRepo" must be an array of directory names`);
        }
    }

    if (config.packageCheck) {
        const KNOWN_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        for (const [section, packages] of Object.entries(config.packageCheck)) {
            if (!KNOWN_SECTIONS.includes(section)) {
                errors.push(`packageCheck: unknown section "${section}" (expected: ${KNOWN_SECTIONS.join(', ')})`);
            } else if (!Array.isArray(packages)) {
                errors.push(`packageCheck.${section} must be an array of package names`);
            }
        }
    }

    if (config.codeReview) {
        if (config.codeReview.studentNameCell && !isValidCellRef(config.codeReview.studentNameCell)) {
            errors.push(`codeReview.studentNameCell: "${config.codeReview.studentNameCell}" is not a valid cell reference`);
        }
        if (config.codeReview.groupCell && !isValidCellRef(config.codeReview.groupCell)) {
            errors.push(`codeReview.groupCell: "${config.codeReview.groupCell}" is not a valid cell reference`);
        }
        if (config.codeReview.manualFallback && !['maxScore', 'zero', 'skip'].includes(config.codeReview.manualFallback)) {
            errors.push(`codeReview.manualFallback: "${config.codeReview.manualFallback}" must be one of: maxScore, zero, skip`);
        }
    }

    if (config.parts) {
        if (!Array.isArray(config.parts)) {
            errors.push(`"parts" must be an array`);
        } else {
            config.parts.forEach((part, i) => {
                const prefix = `parts[${i}]`;
                if (!part.id) errors.push(`${prefix}: missing "id"`);
            });
        }
    }

    return errors;
}

function validateConfig(config, labName) {
    const errors = configErrors(config);
    if (errors.length > 0) {
        const message = [`Config validation failed for ${labName}:`, ...errors.map(e => `  - ${e}`)].join('\n');
        throw new Error(message);
    }
}

export { validateConfig, loadHandlerModules };
