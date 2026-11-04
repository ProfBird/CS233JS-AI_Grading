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
function validateConfig(config, labName) {
    const errors = [];

    // Extract-only configs need no rubric, runtimeCheck, or mappings
    if (config.extractOnly === true) {
        return;
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
        });
    }

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

    if (errors.length > 0) {
        const message = [`Config validation failed for ${labName}:`, ...errors.map(e => `  - ${e}`)].join('\n');
        throw new Error(message);
    }
}

export { validateConfig, loadHandlerModules };
