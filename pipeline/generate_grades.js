/**
 * generate_grades.js
 *
 * Generates graded spreadsheets for each student based on the config cell mappings
 * and the analysis/lint/runtime data attached to each student object.
 *
 * Handlers are registered via registerHandler() — external modules can add new types
 * without editing this file.
 */

const fs = require('fs');
const path = require('path');

const { getAvailableModel, generateSummary: ollamaGenerateSummary } = require('../lib/ollama_comments');
const { readTemplateColumns, openRubricTemplate, writeGradeWorkbook } = require('../lib/rubric_writer');

// --- Cell helpers ---

function setCellValue(sheet, cellRef, value) {
    sheet[cellRef] = { v: value, t: typeof value === 'number' ? 'n' : 's' };
}

// --- Handler Registry ---

const _registry = new Map();
const VALID_MAPPING_TYPES = new Set();

/**
 * Register a handler for a mapping type.
 * @param {string} type  — mapping type name (must match "type" in config mappings)
 * @param {function} handlerFn — (map, student) => { score, comment }
 */
function registerHandler(type, handlerFn) {
    if (_registry.has(type)) {
        throw new Error(`Handler "${type}" is already registered`);
    }
    _registry.set(type, handlerFn);
    VALID_MAPPING_TYPES.add(type);
}

function getHandler(type) {
    return _registry.get(type);
}

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
    if (pp.allPresent && a.urls && a.urls.github) {
        return { score: map.maxScore, comment: 'Yes (Both apps found in GitHub repo)' };
    }
    if (!a.urls || !a.urls.github) {
        return { score: 0, comment: 'Missing GitHub repository' };
    }
    const partIds = Object.keys(pp).filter(k => k !== 'allPresent');
    if (partIds.length === 0) {
        return { score: 0, comment: 'Missing app folders' };
    }
    const status = partIds.map(id => `${id}: ${pp[id] ? 'Yes' : 'No'}`).join(', ');
    return { score: 0, comment: `Missing folders (${status})` };
});

registerHandler('developer_comments', (map, student) => {
    const a = student.analysis || {};
    if (a.hasDeveloperComments) {
        return { score: map.maxScore, comment: 'Yes' };
    }
    return { score: 0, comment: 'Missing name/date comments' };
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
        return { score: 0, comment: 'yes and no' + group };
    }
    return { score: 0, comment: 'no and no' };
});

registerHandler('url_check', (map, student) => {
    const a = student.analysis || {};
    const url = a.urls && a.urls[map.urlType];
    if (url) {
        return { score: map.maxScore ?? '', comment: `NEEDS CHECK: ${url}` };
    }
    return { score: 0, comment: `No ${map.urlType} URL provided` };
});

registerHandler('deploy_check', async (map, student) => {
    const url = (student.analysis && student.analysis.urls && student.analysis.urls.citstudent) || '';
    if (!url) {
        return { score: 0, comment: 'No deployment URL provided' };
    }

    // 1. Check URL reachability
    let html;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) {
            return { score: 0, comment: `URL unreachable (HTTP ${response.status})` };
        }
        html = await response.text();
    } catch (err) {
        const reason = err.name === 'AbortError' ? 'timeout' : err.message;
        return { score: 0, comment: `URL unreachable (${reason})` };
    }

    // 2. Check <script> tags for bundling indicators
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

registerHandler('lint', (map, student) => {
    const lint = student.lint || {};
    if (lint.jsFiles > 0) {
        const severity = map.severity; // 'errors', 'warnings', or undefined (all)

        if (severity === 'errors') {
            const count = lint.errors || 0;
            const topIssues = (lint.errorMessages || lint.messages || []).slice(0, 3).join(', ');
            if (count === 0) return { score: map.maxScore, comment: 'No syntax errors' };
            return { score: 0, comment: `${count} error${count !== 1 ? 's' : ''} found (${topIssues})` };
        }

        let count, topIssues;
        if (severity === 'warnings') {
            count = lint.warnings || 0;
            topIssues = (lint.warningMessages || lint.messages || []).slice(0, 3).join(', ');
        } else {
            count = (lint.errors || 0) + (lint.warnings || 0);
            topIssues = (lint.messages || []).slice(0, 3).join(', ');
        }

        if (count === 0) {
            return { score: map.maxScore, comment: 'Excellent - no lint issues' };
        } else if (count <= 10) {
            return { score: map.maxScore, comment: `Good - ${count} minor issues (${topIssues})` };
        } else if (count <= 30) {
            return { score: Math.max(1, Math.floor(map.maxScore / 2)), comment: `${count} issues (${topIssues})` };
        } else {
            return { score: 0, comment: `${count} issues (${topIssues})` };
        }
    }
    return { score: 0, comment: 'No JS files to lint' };
});

registerHandler('build_check', (map, student) => {
    const rt = student.runtimeCheck || {};
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

registerHandler('manual', (map, student) => {
    const cr = student.codeReview;
    if (cr && cr.found && cr.items && map._reviewIndex !== undefined && map._reviewIndex < cr.items.length) {
        const item = cr.items[map._reviewIndex];
        // Production score as a fraction (e.g. "4/5")
        if (item.prodScore !== null) {
            const score = Math.min(item.prodScore, map.maxScore || Infinity);
            const comment = (map.msg || 'NEEDS MANUAL CHECK') + ` [Production score: ${item.prodScore}]`;
            return { score, comment };
        }
        // Production cell filled with Y/N/Yes/No
        if (item.prodFilled) {
            const score = item.prodAffirmative ? map.maxScore : 0;
            const label = item.prodAffirmative ? 'Production: Yes' : 'Production: No';
            const comment = (map.msg || 'NEEDS MANUAL CHECK') + ` [${label}]`;
            return { score, comment };
        }
        // Fall back to beta score
        if (item.betaScore !== null) {
            const score = Math.min(item.betaScore, map.maxScore || Infinity);
            const comment = (map.msg || 'NEEDS MANUAL CHECK') + ` [Beta score: ${item.betaScore}]`;
            return { score, comment };
        }
    }
    return { score: map.maxScore ?? '', comment: map.msg || 'NEEDS MANUAL CHECK' };
});

registerHandler('npm_package', (map, student) => {
    const a = student.analysis || {};
    const packages = a.npmPackages || [];
    if (packages.length > 0) {
        return { score: map.maxScore, comment: `Yes - ${packages.join(', ')}` };
    }
    return { score: 0, comment: 'No npm packages imported' };
});

registerHandler('package_check', (map, student) => {
    const pc = student.analysis && student.analysis.packageCheck;
    if (!pc) return { score: map.maxScore, comment: 'NEEDS MANUAL CHECK (no package.json check data)' };
    if (!pc.found) return { score: 0, comment: 'package.json not found' };
    if (pc.passed) return { score: map.maxScore, comment: 'package.json entries correct' };
    return { score: 0, comment: pc.issues.join('; ') };
});

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
    if (rh.passed) return { score: map.maxScore, comment: 'No non-source files in repo' };
    return { score: 0, comment: `Non-source files found in repo: ${rh.foundDirs.join(', ')}` };
});

registerHandler('github_repo', (map, student) => {
    const url = student.urls && student.urls.github;
    if (!url) return { score: 0, comment: 'No GitHub URL provided' };
    if (student.extractedDir) return { score: map.maxScore, comment: `Yes - ${url}` };
    return { score: 0, comment: `GitHub URL provided but repo could not be cloned: ${url}` };
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
        case 'build_check': return 'App loads and runs without errors';
        case 'lint': return 'Style and best practices';
        case 'developer_comments': return 'Developer name/date in files';
        case 'github_repo': return 'GitHub repo set up correctly';
        case 'deploy_check': return 'Deployed and running on citstudent';
        case 'code_review': return 'Code review, prod column completed';
        case 'url_check': return 'URL provided';
        case 'apps_in_repo': return 'Apps in repository';
        case 'repo_hygiene': return 'Repo hygiene';
        case 'npm_package': return 'NPM package used';
        case 'package_check': return 'package.json check';
        case 'part_feature': return map.featureId || 'Part feature';
        case 'part_completed': return map.partId || 'Part completed';
        case 'part1_completed': return 'Part 1 completed';
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

const num = v => (v != null ? v : 0);

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
            results.push({
                desc: mappingDescription(map),
                score: 0,
                maxScore: map.maxScore || 0,
                comment: isCodeSourceType(map) ? `ERROR: ${analysis.extractionError}` : 'N/A (code unavailable)',
                cell: map.cell,
                commentCell: map.commentCell
            });
        }
        for (const { part, fc } of partFeatureMaps(config)) {
            results.push({
                desc: fc.featureId || `${part.id} feature`,
                score: 0,
                maxScore: fc.maxScore || 0,
                comment: 'N/A (code unavailable)',
                cell: fc.cell,
                commentCell: fc.commentCell
            });
        }
        return results;
    }

    for (const map of config.mappings) {
        const handler = getHandler(map.type);
        let score, comment;

        if (handler) {
            const result = await handler(map, student);
            score = result.score;
            comment = result.comment;
        } else {
            score = 0;
            comment = `ERROR: Unknown mapping type "${map.type}"`;
        }

        results.push({
            desc: mappingDescription(map),
            score: num(score),
            maxScore: map.maxScore || 0,
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
            results.push({
                desc: fc.featureId || `${part.id} feature`,
                score: num(result.score),
                maxScore: fc.maxScore || 0,
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

    // API completeness breakdown (Lab 6 specific)
    const api = student.analysis && student.analysis.apiCompleteness;
    if (api && api.steps) {
        lines.push('');
        lines.push(`API Integration Pipeline (${api.version})`);
        lines.push('-'.repeat(40));
        for (const step of api.steps) {
            const check = step.found ? 'YES' : ' no';
            lines.push(`  [${check}]  Step ${step.step}: ${step.name}`);
        }
        lines.push(`  ${api.completed}/${api.total} steps complete`);
    }

    lines.push('');
    lines.push(divider);

    return lines.join('\n');
}

// --- Main export ---

module.exports = async function(students, config, labDir, opts = {}) {
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

    // Pre-compute review score indices for manual mappings
    let reviewIdx = 0;
    for (const map of config.mappings) {
        if (map.type === 'manual') {
            map._reviewIndex = reviewIdx++;
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

                const outputPath = path.join(gradeDir, `${student.name}_Grade.txt`);
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
                        runtimeErrors: rt.errors || []
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

            // Write student name and lab assignment group
            {
                const nameCell = (config.codeReview && config.codeReview.studentNameCell) || 'B1';
                setCellValue(sheet, nameCell, student.name);

                const groupCell = (config.codeReview && config.codeReview.groupCell) || 'C1';
                const cr = student.codeReview || {};
                const group = cr.group
                    || (student.analysis && student.analysis.versionVariation
                        && student.analysis.versionVariation.detected)
                    || '?';
                setCellValue(sheet, groupCell, group);
            }

            // Per-mapping scores/comments — computed once (shared with the text
            // renderer) and written to their configured cells.
            const results = await computeResults(student, config);
            writeResultsToSheet(sheet, results, analysis);

            const outputExt = isXlsm ? '.xlsm' : '.xlsx';
            const outputPath = path.join(gradeDir, `${student.name}_Grade${outputExt}`);
            writeGradeWorkbook(wb, sheet, { templateCols, rubricPath, outputPath, isXlsm });
            if (analysis.extractionError) {
                console.log(`  PARTIAL: ${student.name} -> ${path.basename(outputPath)} (extraction failed)`);
            } else {
                console.log(`  OK: ${student.name} -> ${path.basename(outputPath)}`);
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

module.exports.registerHandler = registerHandler;
module.exports.getHandler = getHandler;
module.exports.VALID_MAPPING_TYPES = VALID_MAPPING_TYPES;
module.exports.isCodeSourceType = isCodeSourceType;
module.exports.computeResults = computeResults;
