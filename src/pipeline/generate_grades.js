/**
 * generate_grades.js
 *
 * Generates graded spreadsheets for each student based on the config cell mappings
 * and the analysis/lint/runtime data attached to each student object.
 *
 * Handlers are registered via registerHandler() — external modules can add new types
 * without editing this file.
 */

import fs from 'fs';
import path from 'path';

import { getAvailableModel, generateSummary as ollamaGenerateSummary } from '../lib/ollama_comments.js';
import { readTemplateColumns, openRubricTemplate, writeGradeWorkbook, readGradeCell } from '../lib/rubric_writer.js';
import { walk, toPosix } from '../lib/file_walker.js';
import { registerHandler, getHandler, VALID_MAPPING_TYPES } from '../lib/handler_registry.js';

// --- Cell helpers ---

function setCellValue(sheet, cellRef, value) {
    sheet[cellRef] = { v: value, t: typeof value === 'number' ? 'n' : 's' };
}

// Determines where to write a student's grade spreadsheet, respecting the
// "Computer" sentinel in config.graderCell.
//
// Rules:
//   - If no graderCell configured, or the base file doesn't exist yet: return basePath.
//   - Otherwise, scan upward (V2, V3, …) to find the highest existing version.
//   - If the highest version's graderCell is null (pre-feature file) or "Computer"
//     (unreviewed): overwrite that file.
//   - If the highest version was manually reviewed (graderCell changed away from
//     "Computer"): return the next unused versioned path.
function resolveOutputPath(basePath, graderCell) {
    if (!graderCell || !fs.existsSync(basePath)) return basePath;

    const ext = path.extname(basePath);
    const stem = basePath.slice(0, -ext.length);

    let highest = basePath;
    let nextV = 2;
    while (fs.existsSync(`${stem}-V${nextV}${ext}`)) {
        highest = `${stem}-V${nextV}${ext}`;
        nextV++;
    }

    const val = readGradeCell(highest, graderCell);
    if (val === null || val.trim() === 'Computer') return highest;
    return `${stem}-V${nextV}${ext}`;
}

// --- Handler Registry ---
// registerHandler/getHandler/VALID_MAPPING_TYPES now live in ../lib/handler_registry.js
// so bin/grade.js can import just the registry (cheaply, before this module's heavier
// ollama/rubric_writer dependencies load) to register config.handlerModules BEFORE
// validateConfig() runs. Wizard-facing metadata (labels/descriptions/field prompts)
// still lives separately in lib/lab_config.js's MAPPING_TYPES/MAPPING_TYPE_SCHEMA —
// deliberately not merged in yet; see test/generate_grades.spec.mjs's
// "mapping-type lists stay in sync" test, which will fail loudly if the two drift.
// Full metadata consolidation is a documented future step (docs/multi_language_refactor_plan.md
// Phase 5) — do it the next time the wizard's schema needs to change anyway.

// --- Built-in Handlers ---

registerHandler('feature', (map, student) => {
    const features = (student.analysis && student.analysis.features) || {};
    const count = typeof features[map.featureId] === 'number'
        ? features[map.featureId]
        : (features[map.featureId] ? 1 : 0);
    const minRequired = map.minCount || 1;
    if (count >= minRequired) {
        return { score: map.maxScore, comment: `${map.successMsg || 'Yes'} (${count} found)` };
    }
    return { score: 0, comment: `${map.failMsg || 'Missing'} (only ${count} found)` };
});

function partCompletedHandler(map, student) {
    const pp = (student.analysis && student.analysis.partPresence) || {};
    const partId = map.partId || 'part1';
    return pp[partId]
        ? { score: map.maxScore, comment: `${partId} files found` }
        : { score: 0, comment: `${partId} files not found` };
}

registerHandler('part1_completed', partCompletedHandler);
registerHandler('part_completed', partCompletedHandler);

registerHandler('apps_in_repo', (map, student) => {
    const a = student.analysis || {};
    const pp = a.partPresence || {};
    if (!a.urls || !a.urls.github) {
        return { score: 0, comment: 'Missing GitHub repository' };
    }
    const partIds = Object.keys(pp).filter(k => k !== 'allPresent');
    // Multi-app lab: parts are configured — require all to be present
    if (partIds.length > 0) {
        if (pp.allPresent) {
            return { score: map.maxScore, comment: 'Yes (Both apps found in GitHub repo)' };
        }
        const status = partIds.map(id => `${id}: ${pp[id] ? 'Yes' : 'No'}`).join(', ');
        return { score: 0, comment: `Missing folders (${status})` };
    }
    // Single-app lab: no named parts — full credit if repo was successfully cloned
    if (student.extractedDir) {
        return { score: map.maxScore, comment: 'Yes (app in GitHub repo)' };
    }
    return { score: 0, comment: 'GitHub URL provided but repo could not be cloned' };
});

// Header elements a developer_comments mapping can require (see analyze_code.js's
// checkDeveloperComments for how each is detected), with their labels for comments.
const DEV_HEADER_LABELS = { name: 'name', date: 'date', ai: 'AI use' };

// The per-file checks a developer_comments mapping applies: the `require` elements (or, by
// default, "a name OR a date"), plus an AI-use disclosure when requireAiDisclosure is true.
function devHeaderChecks(map) {
    const require = Array.isArray(map.require) && map.require.length > 0 ? map.require : null;
    const checks = require
        ? require.map(k => ({ key: k, label: DEV_HEADER_LABELS[k] || k, test: f => !!f[k] }))
        : [{ key: 'name/date', label: 'name/date', test: f => f.name || f.date }];
    if (map.requireAiDisclosure === true && !checks.some(c => c.key === 'ai')) {
        checks.push({ key: 'ai', label: DEV_HEADER_LABELS.ai, test: f => !!f.ai });
    }
    return checks;
}

// developer_comments — scores analysis.developerComments.
//   require:             optional array of header elements ("name", "date", "ai") a file's
//                        comments must ALL contain. Absent = the default rule: a name OR a date.
//   requireAiDisclosure: true adds an AI-use disclosure ("ai") to whatever else is required —
//                        the on/off switch for review forms that ask for "a description of any
//                        AI used (and how)". false/absent = not required.
//   scope:               "any" (default) — at least one source file passes; "each" — every
//                        non-empty source file must pass (for rubrics that say "in each file"),
//                        and the comment lists the files that don't, with what each is missing.
registerHandler('developer_comments', (map, student) => {
    const a = student.analysis || {};
    const checks = devHeaderChecks(map);

    // Default rule, default scope, no AI requirement: the long-standing behavior.
    if (checks.length === 1 && checks[0].key === 'name/date' && map.scope !== 'each') {
        return a.hasDeveloperComments
            ? { score: map.maxScore, comment: 'Yes' }
            : { score: 0, comment: 'Missing name/date comments' };
    }

    const what = checks.map(c => c.label).join('/');
    const dc = a.developerComments;
    if (!dc || !dc.files || dc.filesChecked === 0) return { score: 0, comment: `Missing ${what} comments` };

    const gapsOf = f => checks.filter(c => !c.test(f)).map(c => c.label);
    const failing = dc.files.map(f => ({ path: f.path, gaps: gapsOf(f) })).filter(x => x.gaps.length > 0);

    if (map.scope === 'each') {
        if (failing.length === 0) return { score: map.maxScore, comment: 'Yes' };
        const shown = failing.slice(0, 5).map(x => `${x.path} (${x.gaps.join(', ')})`).join('; ')
            + (failing.length > 5 ? `; +${failing.length - 5} more` : '');
        return {
            score: 0,
            comment: `Missing ${what} comments in ${failing.length} of ${dc.filesChecked} files: ${shown}`,
            keepComment: true,
        };
    }

    // scope "any": one file must pass every check.
    if (failing.length < dc.files.length) return { score: map.maxScore, comment: 'Yes' };
    const absent = checks.filter(c => !dc.files.some(c.test)).map(c => c.label);
    return {
        score: 0,
        comment: absent.length > 0
            ? `No ${absent.join('/')} found in any file's header comments`
            : `No single file's header comments include all of: ${what}`,
        keepComment: true,
    };
});

registerHandler('code_review', (map, student) => {
    const a = student.analysis || {};
    const cr = student.codeReview;
    const hasReview = a.hasCodeReview;
    const prodDone = cr && cr.productionCompleted;
    const group = (cr && cr.group) ? ` (Group ${cr.group})` : '';

    if (hasReview && prodDone) {
        return { score: map.maxScore, comment: 'yes and yes' + group };
    }
    if (hasReview && !prodDone) {
        return { score: map.maxScore / 2, comment: 'yes and no' + group };
    }
    return { score: 0, comment: 'no and no' };
});

registerHandler('url_check', (map, student) => {
    const a = student.analysis || {};
    const url = a.urls && a.urls[map.urlType];
    if (url) {
        return { score: map.maxScore ?? 0, comment: `NEEDS CHECK: ${url}` };
    }
    return { score: 0, comment: `No ${map.urlType} URL provided` };
});

registerHandler('deploy_check', async (map, student) => {
    const urlType = map.urlType || 'citstudent';
    const url = (student.analysis && student.analysis.urls && student.analysis.urls[urlType]) || '';
    if (!url) {
        return { score: 0, comment: 'No deployment URL provided' };
    }

    // 1. Check URL reachability — up to 3 attempts (initial + 2 retries) with 2 s delay between
    let html;
    let lastReason;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
                // HTTP error response (wrong path, or a transient 5xx). Could be student-side
                // or temporary — surface the real status and flag for manual verification
                // rather than masking it behind the stock "zero" comment.
                return {
                    score: 0,
                    comment: `NEEDS MANUAL CHECK: server returned HTTP ${response.status} — verify deployment manually`,
                    keepComment: true,
                };
            }
            html = await response.text();
            break;
        } catch (err) {
            lastReason = err.name === 'AbortError' ? 'timeout' : (err.code || err.message);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (html === undefined) {
        // A thrown fetch (DNS / connection / TLS / timeout) means the grader could not reach
        // the URL — this is NOT proof the student failed to deploy. A transient grader-side
        // network blip produces the identical result, so a confident 0 + stock "No" here would
        // silently zero a student whose app is actually live. Flag for manual review and keep
        // the real reason visible.
        return {
            score: 0,
            comment: `NEEDS MANUAL CHECK: could not connect after 3 attempts (${lastReason}) — verify deployment manually`,
            keepComment: true,
        };
    }

    // 2. Check <script> tags for bundling indicators — opt-out via map.checkBundling: false
    // for courses/labs where "bundled" isn't a meaningful deployment signal.
    const checkBundling = map.checkBundling !== false;
    if (!checkBundling) {
        return { score: map.maxScore, comment: 'URL reachable' };
    }

    const scriptSrcRe = /<script\s[^>]*src\s*=\s*['"]([^'"]+)['"][^>]*>/gi;
    const scripts = [];
    let bundled = false;
    let match;
    while ((match = scriptSrcRe.exec(html)) !== null) {
        const src = match[1];
        scripts.push(src);
        if (/assets\/|dist\/|static\/|bundle|min\.|chunk/i.test(src) || /\/[a-f0-9]{8,}\./i.test(src)) {
            bundled = true;
        }
    }

    if (scripts.length === 0) {
        const score = Math.floor(map.maxScore / 2);
        return { score, comment: 'URL reachable but no <script> tags found' };
    }

    if (bundled) {
        return { score: map.maxScore, comment: `URL reachable, page appears bundled (${scripts.join(', ')})` };
    }
    const score = Math.floor(map.maxScore / 2);
    return { score, comment: `URL reachable but page may not be bundled (${scripts.join(', ')})` };
});

const LINT_TOP_ISSUES = 6;  // how many offending rules to list in the lint comment

// Computes the lint score + a comment carrying the actual ESLint findings (issue count plus
// the top offending rules, e.g. "Good - 5 minor issues (Prefer const: 3, Use ===: 2)").
function lintResult(map, student) {
    const lint = student.lint || {};
    if (!(lint.sourceFiles > 0)) return { score: 0, comment: 'No source files to lint' };
    // Fail closed: a linter crash/missing-install is a grader-tooling failure, not a clean
    // pass — score 0 and flag for manual review rather than awarding full lint credit.
    if (lint.toolError) return { score: 0, comment: `NEEDS MANUAL CHECK: linter failed — ${lint.toolError}`, keepComment: true };

    const severity = map.severity; // 'errors', 'warnings', or undefined (all)

    if (severity === 'errors') {
        const count = lint.errors || 0;
        const topIssues = (lint.errorMessages || lint.messages || []).slice(0, LINT_TOP_ISSUES).join(', ');
        if (count === 0) return { score: map.maxScore, comment: 'No syntax errors' };
        return { score: 0, comment: `${count} error${count !== 1 ? 's' : ''} found (${topIssues})` };
    }

    let count, topIssues;
    if (severity === 'warnings') {
        count = lint.warnings || 0;
        topIssues = (lint.warningMessages || lint.messages || []).slice(0, LINT_TOP_ISSUES).join(', ');
    } else {
        count = (lint.errors || 0) + (lint.warnings || 0);
        topIssues = (lint.messages || []).slice(0, LINT_TOP_ISSUES).join(', ');
    }

    if (count === 0) return { score: map.maxScore, comment: 'Excellent - no lint issues' };
    if (count <= 10) return { score: map.maxScore, comment: `Good - ${count} minor issues (${topIssues})` };
    if (count <= 30) return { score: Math.max(1, Math.floor(map.maxScore / 2)), comment: `${count} issues (${topIssues})` };
    return { score: 0, comment: `${count} issues (${topIssues})` };
}

// keepComment:true so the linter findings are written to the comment cell verbatim, rather
// than being replaced by a mapping's stockComments — for style/best-practice rows the output
// is more useful than a canned "Good"/"Fair"/"Poor".
registerHandler('lint', (map, student) => ({ ...lintResult(map, student), keepComment: true }));

// Shared tiered scorer for the markup validators: 0 errors = full, ≤ tolerance =
// half, more = zero. Returns { score, comment }; the stock-comment tier override
// in computeResults replaces the comment when the mapping carries stockComments.
// Scoring is based on errors only; warnings appear in the comment but don't affect score.
function scoreValidation(map, data, fileKey, label) {
    const fileCount = data[fileKey] || 0;
    if (fileCount === 0) return { score: 0, comment: `No ${label} files to validate` };

    const errors = data.errors || 0;
    const warnings = data.warnings || 0;
    const tolerance = map.tolerance ?? 3;
    const topIssues = (data.messages || []).slice(0, 3).join(', ');
    const warnStr = warnings > 0 ? `, ${warnings} warning${warnings !== 1 ? 's' : ''}` : '';

    if (errors === 0) {
        if (warnings === 0) return { score: map.maxScore, comment: `Valid ${label} — no errors` };
        return { score: map.maxScore, comment: `Valid ${label} — no errors; ${warnings} warning${warnings !== 1 ? 's' : ''} (${topIssues})` };
    }

    const errStr = `${errors} ${label} error${errors !== 1 ? 's' : ''}`;
    if (errors <= tolerance) {
        // keepComment: true so the error detail isn't overwritten by a stock comment like "Missing"
        return { score: Math.max(1, Math.floor(map.maxScore / 2)), comment: `${errStr}${warnStr} (${topIssues})`, keepComment: true };
    }
    return { score: 0, comment: `${errStr}${warnStr} (${topIssues})`, keepComment: true };
}

registerHandler('html_validate', (map, student) => {
    return scoreValidation(map, student.htmlValidation || {}, 'htmlFiles', 'HTML');
});

registerHandler('css_validate', (map, student) => {
    return scoreValidation(map, student.cssValidation || {}, 'cssFiles', 'CSS');
});

registerHandler('name_check', (map, student) => {
    const nc = student.nameCheck || {};
    if ((nc.entriesChecked || 0) === 0) return { score: 0, comment: 'No files to check' };

    const errors = nc.errors || 0;
    const tolerance = map.tolerance ?? 2;
    const offenders = (nc.messages || []).slice(0, 4).join(', ');

    if (errors === 0) {
        return { score: map.maxScore, comment: 'All file/folder names are valid' };
    } else if (errors <= tolerance) {
        return { score: Math.max(1, Math.floor(map.maxScore / 2)), comment: `${errors} invalid name${errors !== 1 ? 's' : ''}: ${offenders}`, keepComment: true };
    }
    return { score: 0, comment: `${errors} invalid names: ${offenders}`, keepComment: true };
});

registerHandler('build_check', (map, student) => {
    const rt = student.runtimeCheck || {};

    // "both" mode stores build and browser results separately. Score only the
    // build phase so that browser errors don't penalise the build cell.
    if (rt.buildSuccess !== undefined) {
        if (rt.buildSuccess) {
            return { score: map.maxScore, comment: 'Build successful' };
        }
        const errs = (rt.buildErrors || []).join('; ');
        return { score: 0, comment: errs ? `Build failed: ${errs}` : 'Build failed' };
    }

    // "build" or "browser" mode: rt.success covers the whole check.
    if (rt.success) {
        return { score: map.maxScore, comment: 'Error free' };
    }
    const errors = rt.errors || [];
    if (errors.length === 0) {
        return { score: 0, comment: 'Build failed' };
    }
    // Categorize errors by type
    const buildErrors = [];
    const runtimeErrors = [];
    const resourceErrors = [];
    for (const err of errors) {
        const msg = (typeof err === 'string' ? err : String(err)).replace(/^[^:]+:\s*/, '');
        if (/npm\s+(install|run\s+build)\s+failed/i.test(msg) || /build\s+failed/i.test(msg)) {
            buildErrors.push(msg);
        } else if (/missing\s+(script|stylesheet)/i.test(msg)) {
            resourceErrors.push(msg);
        } else {
            runtimeErrors.push(msg);
        }
    }
    const parts = [];
    if (buildErrors.length) parts.push(`Build: ${buildErrors.join('; ')}`);
    if (resourceErrors.length) parts.push(`Resource: ${resourceErrors.join('; ')}`);
    if (runtimeErrors.length) parts.push(`Runtime: ${runtimeErrors.join('; ')}`);
    return { score: 0, comment: parts.join(' | ') };
});

// browser_check: scores the browser phase of a "both"-mode runtime check.
// Falls back to the unified runtimeCheck result for "browser"-only labs.
registerHandler('browser_check', (map, student) => {
    const rt = student.runtimeCheck || {};

    // "both" mode: use the browser sub-result directly.
    if (rt.browserSuccess !== undefined) {
        if (rt.buildSuccess === false) {
            return { score: 0, comment: 'Build failed; browser check skipped' };
        }
        if (rt.browserSuccess) {
            return { score: map.maxScore, comment: 'No console errors' };
        }
        const errs = rt.browserErrors || [];
        return { score: 0, comment: errs.length ? errs.join('; ') : 'Console errors detected' };
    }

    // "browser" mode fallback (no separate build step).
    if (rt.success) {
        return { score: map.maxScore, comment: 'No console errors' };
    }
    const errors = rt.errors || [];
    return { score: 0, comment: errors.length ? errors.join('; ') : 'Check failed' };
});

// build_and_browser_check: both Vite build and Puppeteer console errors checked together.
// Full score if both pass; half (rounded down) if exactly one fails; 0 if both fail.
registerHandler('build_and_browser_check', (map, student) => {
    const rt = student.runtimeCheck || {};
    const half = Math.floor(map.maxScore / 2);

    // "both" runtime mode — separate sub-results available.
    if (rt.buildSuccess !== undefined && rt.browserSuccess !== undefined) {
        const buildOk   = rt.buildSuccess;
        const browserOk = rt.browserSuccess;
        if (buildOk && browserOk) {
            return { score: map.maxScore, comment: 'Build successful; no console errors' };
        }
        const buildMsg   = buildOk   ? null : ((rt.buildErrors || []).join('; ') || 'Build failed');
        const browserMsg = browserOk ? null : ((rt.browserErrors || []).join('; ') || 'Console errors detected');
        const parts = [buildMsg, browserMsg].filter(Boolean);
        const bothFailed = !buildOk && !browserOk;
        return { score: bothFailed ? 0 : half, comment: parts.join(' | ') };
    }

    // Fallback for "build" or "browser" single-mode runtime — treat as one unified check.
    if (rt.success) {
        return { score: map.maxScore, comment: 'No errors' };
    }
    const errors = rt.errors || [];
    return { score: 0, comment: errors.length ? errors.join('; ') : 'Check failed' };
});

// run_check: scores the "run_check" runtime-check strategy (build/interpret + execute the
// artifact directly, matching stdin/stdout expectations) — see runtime_check.js.
registerHandler('run_check', (map, student) => {
    const rt = student.runtimeCheck || {};
    if (rt.success) {
        return { score: map.maxScore, comment: 'Program ran and matched expected output' };
    }
    const errors = rt.errors || [];
    return { score: 0, comment: errors.length ? errors.join('; ') : 'Program check failed', keepComment: true };
});

// Finds the code-review rows a manual mapping reads, by label. map.reviewRow is a
// case-insensitive substring of the criterion text, or an array of them (a rubric row that
// covers several review questions). map.reviewRowOccurrence (1-based, default 1) picks a
// later match when a form repeats a question — e.g. "Does the game work correctly?" in both
// its Part 1 and Part 2 tables. Returns { items } or { missing: [unmatched texts] }.
function findReviewItems(map, cr) {
    const needles = Array.isArray(map.reviewRow) ? map.reviewRow : [map.reviewRow];
    const occurrence = Math.max(1, map.reviewRowOccurrence || 1);
    const items = [];
    const missing = [];
    for (const needle of needles) {
        const lower = String(needle).toLowerCase();
        const matches = cr.items.filter(it => it.label && it.label.toLowerCase().includes(lower));
        if (matches.length >= occurrence) items.push(matches[occurrence - 1]);
        else missing.push(needle);
    }
    return missing.length > 0 ? { missing } : { items };
}

// What one review row says, or null when it can't be auto-scored (nothing usable filled in).
function reviewVerdict(item, maxScore) {
    // Production score as a fraction (e.g. "4/5")
    if (item.prodScore !== null) {
        return { score: Math.min(item.prodScore, maxScore || Infinity), tag: `Production score: ${item.prodScore}` };
    }
    // Production cell filled with an interpretable Y/N/Yes/No. A cell filled with something
    // ambiguous (e.g. "-", "NA", a note) has affirmative === null — don't auto-score it 0;
    // fall through to the beta score / manual-review path.
    if (item.prodFilled && item.prodAffirmative !== null) {
        return { score: item.prodAffirmative ? (maxScore ?? 0) : 0, tag: item.prodAffirmative ? 'Production: Yes' : 'Production: No' };
    }
    if (item.betaScore !== null) {
        return { score: Math.min(item.betaScore, maxScore || Infinity), tag: `Beta score: ${item.betaScore}` };
    }
    return null;
}

// manual — a rubric row a human grades. Without reviewRow it's a pure placeholder (maxScore +
// msg, for the grader to confirm). With reviewRow, it's pre-scored from the student's code
// review form: the production column, falling back to a beta fraction. For several rows,
// every one must be answerable; the score is the lowest (any "No" → 0).
registerHandler('manual', (map, student) => {
    const msg = map.msg || 'NEEDS MANUAL CHECK';
    const placeholder = { score: map.maxScore ?? 0, comment: msg };
    const cr = student.codeReview;
    if (!map.reviewRow || !(cr && cr.found && cr.items)) return placeholder;

    const { items, missing } = findReviewItems(map, cr);
    if (missing) {
        const what = missing.map(m => `"${m}"`).join(', ');
        return { score: map.maxScore ?? 0, comment: `${msg} [review row ${what} not found on code review form]` };
    }
    const verdicts = items.map(it => reviewVerdict(it, map.maxScore));
    if (verdicts.some(v => v === null)) return placeholder;
    return {
        score: Math.min(...verdicts.map(v => v.score)),
        comment: `${msg} [${verdicts.map(v => v.tag).join('; ')}]`,
    };
});

// npm_package: checks that a package/module is imported in source. The underlying logic
// is language-agnostic (reads analysis.npmPackages, populated per-language by the resolved
// adapter's extractUsedPackages) — package_usage is a generic alias for non-npm labs.
const npmPackageHandler = (map, student) => {
    const a = student.analysis || {};
    const excluded = new Set(map.exclude || []);
    const all = a.npmPackages || [];
    const qualifying = all.filter(p => !excluded.has(p));
    if (qualifying.length > 0) {
        return { score: map.maxScore, comment: `Yes - ${qualifying.join(', ')}` };
    }
    if (excluded.size > 0 && all.length > 0) {
        return { score: 0, comment: `No qualifying packages (found only excluded: ${all.join(', ')})` };
    }
    return { score: 0, comment: 'No npm packages imported' };
};
registerHandler('npm_package', npmPackageHandler);
registerHandler('package_usage', npmPackageHandler);

// package_check: validates the language adapter's manifest check (analysis.packageCheck,
// populated by adapter.checkManifest). manifest_check is a generic alias for non-npm labs.
const packageCheckHandler = (map, student) => {
    const pc = student.analysis && student.analysis.packageCheck;
    if (!pc) return { score: map.maxScore, comment: 'NEEDS MANUAL CHECK (no package.json check data)' };
    if (!pc.found) return { score: 0, comment: 'package.json not found' };
    if (pc.passed) return { score: map.maxScore, comment: 'package.json entries correct' };
    return { score: 0, comment: pc.issues.join('; ') };
};
registerHandler('package_check', packageCheckHandler);
registerHandler('manifest_check', packageCheckHandler);

/**
 * Per-part feature handler — reads from analysis.partFeatures[partId][featureId].
 * Used by the unified featureCounts pipeline. Config mappings can also use this
 * type directly by specifying partId and featureId.
 */
registerHandler('part_feature', (map, student) => {
    const { partId, featureId, minCount = 1, maxScore, successMsg = 'Yes', failMsg = 'Missing' } = map;
    const partCounts = student.analysis && student.analysis.partFeatures && student.analysis.partFeatures[partId];
    if (partCounts === null || partCounts === undefined) {
        return { score: 0, comment: `${failMsg} (folder not found)` };
    }
    const count = partCounts[featureId] || 0;
    if (count >= minCount) {
        return { score: maxScore, comment: `${successMsg} (${count} found)` };
    }
    return { score: 0, comment: `${failMsg} (only ${count} found)` };
});

registerHandler('repo_hygiene', (map, student) => {
    const rh = student.analysis && student.analysis.repoHygiene;
    if (!rh) return { score: map.maxScore, comment: 'NEEDS MANUAL CHECK' };
    if (rh.error) return { score: 0, comment: `NEEDS MANUAL CHECK: ${rh.error}`, keepComment: true };
    if (rh.passed) return { score: map.maxScore, comment: 'No non-source files in repo' };
    return { score: 0, comment: `Non-source files found in repo: ${rh.foundDirs.join(', ')}` };
});

registerHandler('github_repo', (map, student) => {
    const url = student.urls && student.urls.github;
    if (!url) return { score: 0, comment: 'No GitHub URL provided' };
    if (student.extractedDir) return { score: map.maxScore, comment: `Yes - ${url}` };
    return { score: 0, comment: `GitHub URL provided but repo could not be cloned: ${url}` };
});

registerHandler('collaborator_check', (map, student) => {
    const url = student.urls && student.urls.github;
    if (!url) return { score: 0, comment: 'No GitHub repo — collaborator check not applicable' };
    if (student.extractedDir) return { score: map.maxScore, comment: 'yes, instructor' };
    return { score: 0, comment: `GitHub repo provided but could not be cloned: ${url}` };
});

// Returns true if the gitignore content contains a line that covers `entry`
// (e.g. ".env" is matched by lines like ".env", "/.env", ".env*", "*.env").
function gitignoreCoversEntry(content, entry) {
    const lines = content
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    return lines.some(l => {
        // Exact match or rooted form: ".env" or "/.env"
        if (l === entry || l === `/${entry}`) return true;
        // Wildcard suffix: ".env*" covers ".env", ".env.local", etc.
        if (l.endsWith('*') && entry.startsWith(l.slice(0, -1))) return true;
        // Wildcard prefix: "*.env" would cover "foo.env" etc.
        if (l.startsWith('*') && entry.endsWith(l.slice(1))) return true;
        return false;
    });
}

registerHandler('gitignore_check', (map, student) => {
    if (!student.extractedDir) return { score: 0, comment: 'No repo extracted' };
    const gitignorePath = path.join(student.extractedDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        return { score: 0, comment: '.gitignore not found' };
    }
    if (!map.requiredEntry) {
        return { score: map.maxScore, comment: 'yes, exists' };
    }
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const entry = map.requiredEntry;
    if (gitignoreCoversEntry(content, entry)) {
        return { score: map.maxScore, comment: `yes — ${entry} is listed` };
    }
    return { score: 0, comment: `.gitignore exists but "${entry}" is not listed` };
});

// Check that a .env file exists and contains at least one KEY=VALUE pair.
// Search order: filesDir first (submitted separately outside git), then extractedDir
// (committed to repo — the polarity trap: that is actually the *wrong* behaviour
// for this rubric item but we still give credit while flagging it for manual review).
// If the file is not found at all — the normal case for a correctly gitignored repo —
// we cannot verify the contents, so we flag for manual review rather than scoring 0.
registerHandler('env_file_check', (map, student) => {
    const ENV_NAMES = ['.env', '.env.local', '.env.development'];

    // Match any KEY=VALUE line: allow lowercase keys, optional spaces around =,
    // require a non-whitespace value. dotenv itself trims whitespace around =.
    const hasKeyValue = content => /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S+/m.test(content);

    // Check filesDir first (separately submitted, correct behaviour)
    if (student.filesDir) {
        for (const name of ENV_NAMES) {
            const filePath = path.join(student.filesDir, name);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                if (hasKeyValue(content)) {
                    return { score: map.maxScore, comment: `yes — ${name} has key=value entry` };
                }
                return { score: 0, comment: `${name} found but no KEY=VALUE entry` };
            }
        }
    }

    // Check extractedDir (cloned repo — only present if committed to git)
    if (student.extractedDir) {
        for (const name of ENV_NAMES) {
            const filePath = path.join(student.extractedDir, name);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                if (hasKeyValue(content)) {
                    return {
                        score: map.maxScore,
                        comment: `yes — ${name} has key=value entry (NOTE: file appears committed to repo — check .gitignore row)`,
                        keepComment: true,   // preserve diagnostic even if stockComments.full is set
                    };
                }
                return { score: 0, comment: `${name} found in repo but no KEY=VALUE entry` };
            }
        }
    }

    // .env not found anywhere — most likely gitignored correctly; cannot auto-verify
    return {
        score: 0,
        comment: 'NEEDS MANUAL CHECK — .env not found in submission (may be correctly gitignored)',
        keepComment: true,
    };
});

// Check that at least one file matching pathPattern exists somewhere in the repo.
// pathPattern is a substring or regex string matched against each file's full path.
registerHandler('path_exists', (map, student) => {
    if (!student.extractedDir) return { score: 0, comment: 'No repo extracted' };
    const pattern = map.pathPattern;
    if (!pattern) {
        return {
            score: 0,
            comment: 'NEEDS MANUAL CHECK (no pathPattern configured)',
            keepComment: true,
        };
    }
    const re = new RegExp(pattern);
    let found = null;
    // Normalize to forward slashes so patterns like "functions/" match on Windows,
    // where walk() yields backslash-separated paths.
    walk(student.extractedDir, {
        shouldSkip: full => /node_modules|\/dist\/|\.git/.test(toPosix(full)),
        onFile: full => { if (!found && re.test(toPosix(full))) found = full; },
    });
    if (found) {
        return { score: map.maxScore, comment: `yes — ${path.relative(student.extractedDir, found)}` };
    }
    return { score: 0, comment: `not found (expected: ${pattern})` };
});

registerHandler('scripts_check', (map, student) => {
    const sc = student.scriptsCheck;
    const scriptList = Array.isArray(map.scripts)
        ? map.scripts
        : (map.scripts || 'dev,build,test').split(',').map(s => s.trim()).filter(Boolean);

    if (!sc) return { score: 0, comment: 'NEEDS MANUAL CHECK (no scripts check data)', keepComment: true };
    if (sc.error) return { score: 0, comment: sc.error, keepComment: true };

    const results = sc.scripts || {};
    const passing = scriptList.filter(s => results[s]?.passed);
    const failing = scriptList.filter(s => results[s] && !results[s].passed);
    const missing = scriptList.filter(s => !results[s]);

    if (passing.length === scriptList.length) {
        return { score: map.maxScore, comment: `All pass: ${scriptList.join(', ')}` };
    }

    const parts = [];
    if (passing.length) parts.push(`pass: ${passing.join(', ')}`);
    if (failing.length) {
        const details = failing.map(s => (results[s]?.defined ? s : `${s} (not defined)`));
        parts.push(`fail: ${details.join(', ')}`);
    }
    if (missing.length) parts.push(`not checked: ${missing.join(', ')}`);

    const score = Math.round(map.maxScore * passing.length / scriptList.length);
    return { score, comment: parts.join(' | '), keepComment: true };
});

// test_check: proportional scoring against a language adapter's test-runner results
// (pytest/dotnet test/CTest — see student.testCheck, attached by runtime_check.js's
// checkStudentTests). Scores proportionally to tests passed, same pattern as scripts_check.
registerHandler('test_check', (map, student) => {
    const tc = student.testCheck;
    if (!tc) return { score: 0, comment: 'NEEDS MANUAL CHECK (no test check data)', keepComment: true };
    if (tc.error) return { score: 0, comment: tc.error, keepComment: true };
    if (!tc.total) return { score: 0, comment: 'No tests found', keepComment: true };

    if (tc.passed === tc.total) {
        return { score: map.maxScore, comment: `All ${tc.total} tests passed` };
    }

    const failureList = (tc.failures || []).slice(0, 5).join(', ');
    const score = Math.round(map.maxScore * tc.passed / tc.total);
    return {
        score,
        comment: `${tc.passed}/${tc.total} tests passed${failureList ? ` (failing: ${failureList})` : ''}`,
        keepComment: true,
    };
});

// --- Web content checks (student.webContent, from check_web_content.js) ---

// Shared scorer for the element/selector/property checks: proportional credit for the
// checked entries that passed, comment listing up to 5 misses. keepComment protects the
// missing-item diagnostic from being masked by stockComments.zero.
function scoreWebEntries(map, entries, label, describe) {
    if (entries.length === 0) {
        return { score: 0, comment: `No ${label} configured (check config.webContent)`, keepComment: true };
    }
    const missing = entries.filter(e => !(e.passed ?? e.found));
    if (missing.length === 0) {
        return { score: map.maxScore, comment: `All ${entries.length} ${label} found` };
    }
    const shown = missing.slice(0, 5).map(describe).join(', ');
    const more = missing.length > 5 ? `, +${missing.length - 5} more` : '';
    const passed = entries.length - missing.length;
    return {
        score: Math.round(map.maxScore * passed / entries.length),
        comment: `${passed}/${entries.length} ${label} found — missing: ${shown}${more}`,
        keepComment: true,
    };
}

function noWebContent() {
    return { score: 0, comment: 'NEEDS MANUAL CHECK (no web content data — is config.webContent set?)', keepComment: true };
}

// ids/selectors/properties filters accept an array or a comma-separated string
// (the wizard writes strings — same convention as scripts_check's `scripts` field).
function asList(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}

registerHandler('element_check', (map, student) => {
    const wc = student.webContent;
    if (!wc) return noWebContent();
    let entries = wc.elements || [];
    const ids = asList(map.ids);
    if (ids.length > 0) entries = entries.filter(e => ids.includes(e.id));
    return scoreWebEntries(map, entries, 'required elements',
        e => e.description ? `${e.selector} (${e.description})` : e.selector);
});

registerHandler('css_selector_check', (map, student) => {
    const wc = student.webContent;
    if (!wc) return noWebContent();
    let entries = wc.cssSelectors || [];
    const selectors = asList(map.selectors);
    if (selectors.length > 0) entries = entries.filter(e => selectors.includes(e.selector));
    return scoreWebEntries(map, entries, 'required CSS selectors', e => e.selector);
});

registerHandler('css_property_check', (map, student) => {
    const wc = student.webContent;
    if (!wc) return noWebContent();
    let entries = wc.cssProperties || [];
    const properties = asList(map.properties);
    if (properties.length > 0) entries = entries.filter(e => properties.includes(e.property));
    return scoreWebEntries(map, entries, 'required CSS properties', e => e.property);
});

registerHandler('file_count', (map, student) => {
    const wc = student.webContent;
    if (!wc) return noWebContent();
    const fc = (wc.fileCounts || []).find(f => f.id === map.countId);
    if (!fc) {
        return { score: 0, comment: `NEEDS MANUAL CHECK (no fileCounts entry with id "${map.countId}")`, keepComment: true };
    }
    if (fc.count >= fc.min) {
        return { score: map.maxScore, comment: `${fc.count} file(s) matching ${fc.pattern} (expected ${fc.min})` };
    }
    return {
        score: 0,
        comment: `Found ${fc.count} file(s) matching ${fc.pattern}, expected ${fc.min}`,
        keepComment: true,
    };
});

// --- Mapping types that can produce a score even when code extraction failed ---

// Types that report an extraction error rather than 'N/A' when code could not be obtained.
const CODE_SOURCE_TYPES = new Set(['apps_in_repo', 'part1_completed', 'part_completed', 'github_repo']);

function isCodeSourceType(map) {
    return CODE_SOURCE_TYPES.has(map.type) || (map.type === 'url_check' && map.urlType === 'github');
}

// --- Text report helpers ---

function mappingDescription(map) {
    if (map.msg) return map.msg.replace('NEEDS MANUAL CHECK (', '').replace(')', '');
    if (map.featureId) return map.featureId;
    switch (map.type) {
        case 'build_check': return 'App builds without errors';
        case 'browser_check': return 'No run-time console errors';
        case 'build_and_browser_check': return 'No build or console errors';
        case 'run_check': return 'Program runs and produces expected output';
        case 'lint': return 'Style and best practices';
        case 'html_validate': return 'HTML is valid';
        case 'css_validate': return 'CSS is valid';
        case 'name_check': return 'File/folder names are valid';
        case 'developer_comments': return 'Developer name/date in files';
        case 'github_repo': return 'GitHub repo set up correctly';
        case 'deploy_check': return 'Deployed and running on citstudent';
        case 'code_review': return 'Code review, prod column completed';
        case 'url_check': return 'URL provided';
        case 'apps_in_repo': return 'App(s) in GitHub repository';
        case 'repo_hygiene': return 'Repo hygiene';
        case 'npm_package': case 'package_usage': return 'Package/module used';
        case 'package_check': case 'manifest_check': return 'Dependency manifest check';
        case 'part_feature': return map.featureId || 'Part feature';
        case 'part_completed': return map.partId || 'Part completed';
        case 'part1_completed': return 'Part 1 completed';
        case 'scripts_check': return `npm scripts: ${(map.scripts || 'dev,build,test')}`;
        case 'test_check': return 'Automated tests pass';
        case 'env_file_check': return '.env file with API key';
        case 'path_exists': return map.pathPattern ? `File exists: ${map.pathPattern}` : 'File exists check';
        case 'gitignore_check': return map.requiredEntry ? `.gitignore contains ${map.requiredEntry}` : '.gitignore exists';
        case 'element_check': return 'Required HTML elements present';
        case 'css_selector_check': return 'Required CSS selectors used';
        case 'css_property_check': return 'Required CSS properties used';
        case 'file_count': return map.countId ? `File count: ${map.countId}` : 'File count check';
        default: return map.type;
    }
}

// Yields each { part, fc } featureCount entry across all configured parts.
function* partFeatureMaps(config) {
    for (const part of (config.parts || [])) {
        if (!part.featureCounts) continue;
        for (const fc of part.featureCounts) yield { part, fc };
    }
}

// Every score in results[] must be a number (formatTextReport()'s totalScore += r.score
// would otherwise silently string-concatenate a stray '' or NaN into the total). Coerces
// any non-finite/non-number value to 0 defensively, not just null/undefined.
const num = v => (Number.isFinite(v) ? v : 0);

// Returns the grader-authored stock comment for a mapping at the given score, or null
// when none applies. Manual rows are exempt (a human still grades them), and missing
// tier text falls through to null so the handler's own comment stands.
function stockCommentFor(map, score) {
    if (!map.stockComments || map.type === 'manual') return null;
    const max  = map.maxScore || 0;
    const tier = (max > 0 && score >= max) ? 'full' : (score <= 0 ? 'zero' : 'partial');
    return map.stockComments[tier] || null;
}

// Appends one rendered result — the shape shared by every results[] entry regardless of
// which of computeResults' four push sites produced it (extraction-error mappings,
// extraction-error part-features, normal mappings, normal part-features). Coerces score
// through num() here so callers can't reintroduce a non-numeric score (see num()'s doc).
function pushResult(results, { desc, score, maxScore, comment, cell, commentCell, linkCell, linkUrlType }) {
    results.push({ desc, score: num(score), maxScore: maxScore || 0, comment, cell, commentCell, linkCell, linkUrlType });
}

/**
 * Computes the per-mapping grading results for a student — the single source of
 * truth shared by both the spreadsheet and text-report renderers. Each result
 * carries the rendered { desc, score, maxScore, comment } plus the spreadsheet
 * cell references it should be written to.
 */
async function computeResults(student, config) {
    const results = [];
    const analysis = student.analysis || {};

    // Extraction failure: every item is unavailable. Code-source items report the
    // underlying error; everything else (including part features) is marked N/A.
    if (analysis.extractionError) {
        for (const map of config.mappings) {
            pushResult(results, {
                desc: mappingDescription(map),
                score: 0,
                maxScore: map.maxScore,
                comment: isCodeSourceType(map) ? `ERROR: ${analysis.extractionError}` : 'N/A (code unavailable)',
                cell: map.cell,
                commentCell: map.commentCell
            });
        }
        for (const { part, fc } of partFeatureMaps(config)) {
            pushResult(results, {
                desc: fc.featureId || `${part.id} feature`,
                score: 0,
                maxScore: fc.maxScore,
                comment: 'N/A (code unavailable)',
                cell: fc.cell,
                commentCell: fc.commentCell
            });
        }
        return results;
    }

    for (const map of config.mappings) {
        const handler = getHandler(map.type);
        let score, comment, keepComment = false;

        if (handler) {
            const result = await handler(map, student);
            score = result.score;
            comment = result.comment;
            keepComment = result.keepComment === true;
        } else {
            score = 0;
            comment = `ERROR: Unknown mapping type "${map.type}"`;
        }

        // Grader-authored stock comments override the generic message at the matching
        // score tier. Manual rows are exempt — they keep their "needs manual grading"
        // flag so a human still grades them. A handler may also set keepComment to protect
        // a diagnostic (e.g. deploy_check's "could not connect — verify manually") that must
        // not be masked by the stock tier text.
        const stock = stockCommentFor(map, num(score));
        if (stock !== null && !keepComment) comment = stock;

        pushResult(results, {
            desc: mappingDescription(map),
            score,
            maxScore: map.maxScore,
            comment,
            cell: map.cell,
            commentCell: map.commentCell,
            linkCell: map.linkCell,
            linkUrlType: map.linkUrlType
        });
    }

    // Per-part feature counts
    if (config.parts && analysis.partFeatures) {
        const partFeatureHandler = getHandler('part_feature');
        for (const { part, fc } of partFeatureMaps(config)) {
            const virtualMap = {
                type: 'part_feature',
                partId: part.id,
                featureId: fc.featureId,
                minCount: fc.minCount || 1,
                maxScore: fc.maxScore,
                successMsg: fc.successMsg,
                failMsg: fc.failMsg
            };
            const result = await partFeatureHandler(virtualMap, student);
            pushResult(results, {
                desc: fc.featureId || `${part.id} feature`,
                score: result.score,
                maxScore: fc.maxScore,
                comment: result.comment,
                cell: fc.cell,
                commentCell: fc.commentCell
            });
        }
    }

    return results;
}

// Writes computed results into the Grade sheet at each result's cell references.
function writeResultsToSheet(sheet, results, analysis) {
    for (const r of results) {
        if (r.cell) setCellValue(sheet, r.cell, r.score);
        if (r.commentCell) setCellValue(sheet, r.commentCell, r.comment);
        if (r.linkCell && r.linkUrlType && analysis.urls && analysis.urls[r.linkUrlType]) {
            setCellValue(sheet, r.linkCell, analysis.urls[r.linkUrlType]);
        }
    }
}

function formatTextReport(student, config, results, labTitle) {
    const cr = student.codeReview || {};
    const group = cr.group
        || (student.analysis && student.analysis.versionVariation
            && student.analysis.versionVariation.detected)
        || '?';

    const lines = [];
    const divider = '='.repeat(56);

    lines.push(divider);
    lines.push(`GRADE REPORT: ${student.name}`);
    if (labTitle) lines.push(`${labTitle}`);
    lines.push(`Group: ${group}`);
    lines.push(divider);
    lines.push('');

    let totalScore = 0;
    let totalPossible = 0;

    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const num = String(i + 1).padStart(2);
        const scoreStr = String(r.score).padStart(2);
        const maxStr = String(r.maxScore).padStart(2);
        lines.push(`  ${num}. [${scoreStr}/${maxStr}]  ${r.desc}`);
        if (r.comment) lines.push(`      ${r.comment}`);
        totalScore += r.score;
        totalPossible += r.maxScore;
    }

    lines.push('');
    lines.push(`  Total: ${totalScore} / ${totalPossible}`);

    // Custom report sections contributed by a lab's analyzer (analysis.reportSections).
    // Generic code renders whatever lines the analyzer produced — it has no knowledge
    // of any particular lab's structure.
    for (const section of (student.analysis && student.analysis.reportSections) || []) {
        lines.push('');
        if (section.title) {
            lines.push(section.title);
            lines.push('-'.repeat(40));
        }
        for (const line of section.lines || []) lines.push(`  ${line}`);
    }

    lines.push('');
    lines.push(divider);

    return lines.join('\n');
}

// --- Main export ---

export default async function(students, config, labDir, opts = {}) {
    console.log("--- Grade Generation Phase ---");

    let aiModel = null;
    if (opts.aiComments) {
        const detected = await getAvailableModel();
        if (!detected) {
            console.warn('  WARNING: --ai-comments requested but Ollama not reachable or no models installed; using fallback text.');
        } else {
            aiModel = opts.aiModel || detected;
            const source = opts.aiModel ? 'specified' : 'auto-detected';
            console.log(`  AI comments: using model "${aiModel}" (${source}).`);
        }
    }

    // --- Text report path ---
    if (opts.textReport) {
        const summary = { successful: [], errors: [] };
        let generated = 0;
        let skipped = 0;
        const labTitle = config.titleText || '';

        for (const student of students) {
            const gradeDir = student.gradeDir;

            if (!gradeDir) {
                console.log(`  SKIP: ${student.name} - no grade output directory found`);
                summary.errors.push({ student: student.name, issue: 'No grade output directory found.' });
                skipped++;
                continue;
            }
            fs.mkdirSync(gradeDir, { recursive: true });

            try {
                const results = await computeResults(student, config);
                const report = formatTextReport(student, config, results, labTitle);

                const outputPath = path.join(gradeDir, `${path.basename(gradeDir)}_Grade.txt`);
                fs.writeFileSync(outputPath, report, 'utf8');
                console.log(`  OK: ${student.name} -> ${path.basename(outputPath)}`);
                summary.successful.push(student.name);
                generated++;
            } catch (err) {
                console.log(`  ERROR: ${student.name} - ${err.message}`);
                summary.errors.push({ student: student.name, issue: `Text report error: ${err.message}` });
                skipped++;
            }
        }

        console.log(`\nGenerated ${generated} text reports, skipped ${skipped}.`);
        return summary;
    }

    // --- Spreadsheet path ---
    const rubricPath = path.join(opts.rubricDir || labDir, config.rubricName);
    const isXlsm = rubricPath.toLowerCase().endsWith('.xlsm');
    if (!fs.existsSync(rubricPath)) {
        const err = new Error(`Rubric file not found at ${rubricPath}`);
        err.code = 'RUBRIC_NOT_FOUND';
        err.rubricPath = rubricPath;
        throw err;
    }

    // Read column widths once from the template ZIP (xlsx doesn't parse !cols from xlsm)
    const templateCols = readTemplateColumns(rubricPath);

    const summary = { successful: [], errors: [] };
    let generated = 0;
    let skipped = 0;

    for (const student of students) {
        const analysis = student.analysis || {};
        const gradeDir = student.gradeDir;

        if (!gradeDir) {
            console.log(`  SKIP: ${student.name} - no grade output directory found`);
            summary.errors.push({ student: student.name, issue: 'No grade output directory found.' });
            skipped++;
            continue;
        }
        fs.mkdirSync(gradeDir, { recursive: true });

        try {
            const { wb, sheet } = openRubricTemplate(rubricPath);

            if (config.titleCell && config.titleText) {
                setCellValue(sheet, config.titleCell, config.titleText);
            }

            if (config.summaryCell) {
                let summaryText;
                if (analysis.error) {
                    summaryText = `Issue: ${analysis.error}`;
                } else if (aiModel) {
                    const lint = student.lint || { errors: 0, warnings: 0, messages: [] };
                    const rt = student.runtimeCheck || { success: false, errors: [] };
                    process.stdout.write(`    Generating AI summary for ${student.name}... `);
                    const aiResult = await ollamaGenerateSummary({
                        model: aiModel,
                        student: student.name,
                        features: analysis.features || {},
                        lintErrors: lint.errors,
                        lintWarnings: lint.warnings,
                        lintTopIssues: lint.messages || [],
                        runtimeSuccess: rt.success,
                        runtimeErrors: rt.errors || [],
                        language: config.language || 'JavaScript'
                    });
                    if (aiResult) {
                        console.log('OK');
                        summaryText = aiResult;
                    } else {
                        console.log('FAILED (Ollama returned no result; using fallback)');
                        summaryText = 'Pending manual checks for full verification.';
                    }
                } else {
                    summaryText = 'Pending manual checks for full verification.';
                }
                setCellValue(sheet, config.summaryCell, summaryText);
            }

            // Write student name and lab assignment group — only where the config
            // says to. Generic code makes no assumption about the rubric layout.
            {
                const nameCell = config.codeReview && config.codeReview.studentNameCell;
                if (nameCell) setCellValue(sheet, nameCell, student.name);

                const groupCell = config.codeReview && config.codeReview.groupCell;
                if (groupCell) {
                    const cr = student.codeReview || {};
                    const group = cr.group
                        || (student.analysis && student.analysis.versionVariation
                            && student.analysis.versionVariation.detected)
                        || '?';
                    setCellValue(sheet, groupCell, group);
                }
            }

            // Per-mapping scores/comments — computed once (shared with the text
            // renderer) and written to their configured cells.
            const results = await computeResults(student, config);
            writeResultsToSheet(sheet, results, analysis);

            // Write the grader sentinel so the instructor can identify unreviewed files.
            if (config.graderCell) {
                setCellValue(sheet, config.graderCell, 'Computer');
            }

            const outputExt = isXlsm ? '.xlsm' : '.xlsx';
            const basePath = path.join(gradeDir, `${path.basename(gradeDir)}_Grade${outputExt}`);
            const outputPath = resolveOutputPath(basePath, config.graderCell);
            const isNewVersion = !fs.existsSync(outputPath);

            writeGradeWorkbook(wb, sheet, { templateCols, rubricPath, outputPath, isXlsm });
            const filePart = isNewVersion && outputPath !== basePath
                ? `${path.basename(outputPath)} (new version — existing file has manual edits)`
                : path.basename(outputPath);
            if (analysis.extractionError) {
                console.log(`  PARTIAL: ${student.name} -> ${filePart} (extraction failed)`);
            } else {
                console.log(`  OK: ${student.name} -> ${filePart}`);
            }
            summary.successful.push(student.name);
            generated++;

        } catch (err) {
            console.log(`  ERROR: ${student.name} - ${err.message}`);
            summary.errors.push({ student: student.name, issue: `Spreadsheet generation error: ${err.message}` });
            skipped++;
        }
    }

    console.log(`\nGenerated ${generated} spreadsheets, skipped ${skipped}.`);
    return summary;
};

export { registerHandler, getHandler, VALID_MAPPING_TYPES, isCodeSourceType, resolveOutputPath, computeResults, stockCommentFor };
