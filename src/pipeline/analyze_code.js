/**
 * analyze_code.js
 *
 * Analyzes the extracted code for specific features based on regex mappings in the config.
 * For labs with "parts", counts features per-part using folder names read from the rubric.
 * Attaches results directly to each student object as student.analysis.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { walk, toPosix, getAllFiles } from '../lib/file_walker.js';
import xlsx from '../lib/xlsx.js';
import jsAdapter from '../adapters/javascript.js';
import { resolveAdapter } from '../adapters/index.js';
import { checkVersionVariation } from '../lib/variation_detect.js';
import { runPerStudentPhase, writePhaseReport } from '../lib/per_student_phase.js';

const ANALYSIS_REPORT = 'analysis_report.json';

// Comment-stripping is language-specific (adapter.stripComments); re-exported here,
// delegating to the JS adapter, for backward compatibility with existing callers/tests.
const stripComments = code => jsAdapter.stripComments(code);

function escapeRegex(word) {
    return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Evaluate a nested match node against the already-read file contents, codebase-wide.
// A leaf { regex, flags? } is true if it matches in ANY of the files; allOf/anyOf combine
// leaf results. This lets a feature require AND/OR of patterns (e.g. "import AND export",
// or "scale() OR (lineTo() AND a mouse handler)") — the cases that previously needed a
// per-lab custom analyzer. Combination is at the leaf level (each pattern's presence is
// computed across all files first), so "lineTo in file A AND mousedown in file B" matches.
function evalMatchNode(node, contents, featId) {
    if (node.allOf) return node.allOf.every(n => evalMatchNode(n, contents, featId));
    if (node.anyOf) return node.anyOf.some(n => evalMatchNode(n, contents, featId));
    let re;
    try { re = new RegExp(node.regex, node.flags || ''); }
    catch (e) {
        console.warn(`  Warning: Invalid match regex for feature "${featId}": ${node.regex}`);
        return false;
    }
    return contents.some(c => re.test(c));
}

// adapter defaults to the JS adapter so existing 2-arg callers (config-driven feature
// detection on a JS lab, and tests) are unaffected; other languages pass their adapter explicitly.
function countFeatures(allFiles, configFeatures, adapter = jsAdapter) {
    const counts = {};
    if (!configFeatures) return counts;
    configFeatures.forEach(f => { counts[f.id] = 0; });

    const isSourceFile = f => adapter.sourceExtensions.some(ext => f.toLowerCase().endsWith(ext));

    for (const feat of configFeatures) {
        const fileFilter = feat.fileRegex
            // Normalize to forward slashes so path-segment patterns (e.g. "src/")
            // match on Windows, where file paths are backslash-separated.
            ? f => new RegExp(feat.fileRegex).test(toPosix(f))
            : isSourceFile;
        const filesToSearch = allFiles.filter(fileFilter);

        // Read each searched file once; strip comments from source files so neither match
        // counting nor boolean match-evaluation sees commented-out code.
        const contents = [];
        for (const file of filesToSearch) {
            let content;
            try { content = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
            contents.push(isSourceFile(file) ? adapter.stripComments(content) : content);
        }

        if (feat.match) {
            // Boolean feature: 1 if the nested allOf/anyOf/regex tree is satisfied across
            // the searched files, else 0. (Replaces lab-specific analyzers.)
            counts[feat.id] = evalMatchNode(feat.match, contents, feat.id) ? 1 : 0;
        } else if (feat.regex) {
            for (const searchable of contents) {
                try {
                    const matches = searchable.match(new RegExp(feat.regex, 'g'));
                    if (matches) counts[feat.id] += matches.length;
                } catch (e) {
                    console.warn(`  Warning: Invalid regex for feature "${feat.id}": ${feat.regex}`);
                }
            }
        }
    }
    return counts;
}

function readGameNamesFromRubric(rubricPath, rubricTitleRow) {
    if (!rubricPath || !xlsx || !fs.existsSync(rubricPath)) return [];
    try {
        const wb = xlsx.readFile(rubricPath);
        const sheet = wb.Sheets['Grade'];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
        const row = data[rubricTitleRow - 1];
        if (row && row[4]) {
            return row[4].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        }
        // rubricTitleRow is always caller-supplied when this function runs (see call
        // sites), so an empty result here means it's misconfigured — surface it instead
        // of letting findPartDir() silently fail to match every part.
        console.warn(`  WARNING: readGameNamesFromRubric: no game names found at row ${rubricTitleRow}, column E of ${rubricPath} — check "rubricTitleRow" in the lab config`);
    } catch (e) {
        console.warn(`  WARNING: readGameNamesFromRubric: failed to read ${rubricPath}: ${e.message}`);
    }
    return [];
}

function normalizeDirName(dir) {
    return dir
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .replace(/[-_]/g, ' ');
}

function dirMatchesGameNames(dir, gameNames) {
    const lowerDir = normalizeDirName(dir);
    const dirWords = lowerDir.split(/\s+/).filter(w => w.length > 2);

    for (const name of gameNames) {
        const nameWords = name.split(/\s+/).filter(w => w.length > 2);

        const gameWordInFolder = nameWords.some(word => {
            if (new RegExp(`\\b${escapeRegex(word)}\\b`).test(lowerDir)) return true;
            if (word.length >= 5 && lowerDir.includes(word)) return true;
            return false;
        });
        const folderWordInGame = dirWords.some(word => {
            if (new RegExp(`\\b${escapeRegex(word)}\\b`).test(name)) return true;
            if (word.length >= 5 && name.includes(word)) return true;
            return false;
        });

        if (gameWordInFolder || folderWordInGame) return true;
    }
    return false;
}

function getSubdirs(dirPath) {
    const names = [];
    walk(dirPath, {
        shouldSkip: (full, name) => name.startsWith('.'),
        shouldDescend: () => false,
        onDir: (full, name) => names.push(name)
    });
    return names;
}

function findPartDir(extractedDir, gameNames, folderPattern) {
    const topLevelDirs = getSubdirs(extractedDir);
    if (topLevelDirs.length === 0) return null;

    for (const dir of topLevelDirs) {
        if (dirMatchesGameNames(dir, gameNames)) {
            return path.join(extractedDir, dir);
        }
    }

    for (const dir of topLevelDirs) {
        const subDirs = getSubdirs(path.join(extractedDir, dir));
        for (const sub of subDirs) {
            if (dirMatchesGameNames(sub, gameNames)) {
                return path.join(extractedDir, dir, sub);
            }
        }
    }

    if (topLevelDirs.length === 1) {
        const result = findPartDir(path.join(extractedDir, topLevelDirs[0]), gameNames, folderPattern);
        if (result) return result;
    }

    if (folderPattern) {
        const regex = new RegExp(folderPattern, 'i');
        for (const dir of topLevelDirs) {
            if (regex.test(dir)) return path.join(extractedDir, dir);
        }
        for (const dir of topLevelDirs) {
            const subDirs = getSubdirs(path.join(extractedDir, dir));
            for (const sub of subDirs) {
                if (regex.test(sub)) return path.join(extractedDir, dir, sub);
            }
        }
    }

    return null;
}

// Detect which parts are present by examining directory structure.
// Returns { allPresent: bool, [partId]: bool }.
// When config.parts is defined, uses configured patterns and game names.
// Otherwise auto-detects directories matching common part naming patterns.
function detectPartsPresent(extractedDir, config, partGameNames) {
    const result = { allPresent: false };

    if (!extractedDir || !fs.existsSync(extractedDir)) return result;

    if (config.parts && config.parts.length) {
        config.parts.forEach(part => {
            const gameNames = partGameNames[part.id] || [];
            result[part.id] = findPartDir(extractedDir, gameNames, part.folderPattern) !== null;
        });
        result.allPresent = config.parts.every(p => result[p.id]);
    } else {
        // Auto-detect part directories using common naming patterns
        const subdirs = getSubdirs(extractedDir);
        const partPatterns = [/^(?:part|pt)\s*[_-]?\s*\d+$/i];
        // Also detect multi-level: e.g. root has a single subdir that contains part dirs
        let dirsToCheck = subdirs;
        if (subdirs.length === 1) {
            const nested = getSubdirs(path.join(extractedDir, subdirs[0]));
            if (nested.some(d => partPatterns.some(p => p.test(d)))) {
                dirsToCheck = nested.map(d => path.join(subdirs[0], d));
            }
        }

        for (const dir of dirsToCheck) {
            const basename = path.basename(dir);
            const match = basename.match(/^(?:part|pt)\s*[_-]?\s*(\d+)$/i);
            if (match) {
                const partId = `part${match[1]}`;
                result[partId] = true;
            }
        }

        // Fallback: if no part directories were found, look for part-numbered filenames.
        // Handles submissions where Part 1 files sit at the repo root instead of a
        // dedicated subfolder (e.g. CS233JS_Lab01_Part1.html placed at the top level).
        if (!Object.keys(result).some(k => k !== 'allPresent')) {
            const allFiles = getAllFiles(extractedDir, ['node_modules', 'dist', '.git']);
            for (const f of allFiles) {
                const basename = path.basename(f);
                const match = basename.match(/(?:^|[^a-zA-Z])(?:part|pt)[_-]?(\d+)/i);
                if (match) {
                    result[`part${match[1]}`] = true;
                }
            }
        }

        const detectedParts = Object.keys(result).filter(k => k !== 'allPresent');
        result.allPresent = detectedParts.length > 0;
    }
    return result;
}

function checkRepoHygiene(extractedDir, hygiene) {
    if (!hygiene || !Array.isArray(hygiene.excludedFromRepo)) return null;

    // If this is a git repo, use git ls-files to check what's actually tracked.
    // Scanning the filesystem would falsely flag dirs created by npm install / vite build
    // during the runtime-check phase (which runs before this analysis phase).
    const gitDir = path.join(extractedDir, '.git');
    if (fs.existsSync(gitDir)) {
        let trackedFiles = '';
        try {
            trackedFiles = execFileSync(
                'git', ['ls-files'],
                { cwd: extractedDir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }
            ).toString();
        } catch (e) {
            // A broken git invocation (missing binary, corrupt repo, timeout) must not be
            // mistaken for "no tracked files" -> hygiene passed. Fail closed and flag for
            // manual review instead of silently awarding a clean-repo score.
            console.warn(`  WARNING: checkRepoHygiene: "git ls-files" failed in ${extractedDir}: ${e.message}`);
            return { passed: false, foundDirs: [], error: `git ls-files failed: ${e.message}` };
        }

        const trackedPaths = trackedFiles.split(/\r?\n/).filter(Boolean);
        const found = [];
        for (const dirName of hygiene.excludedFromRepo) {
            const otherExcluded = hygiene.excludedFromRepo.filter(d => d !== dirName);
            const isFound = trackedPaths.some(filePath => {
                const parts = filePath.split('/');
                const idx = parts.indexOf(dirName);
                if (idx === -1) return false;
                // Only flag if not nested inside another excluded directory
                const prefix = parts.slice(0, idx);
                return !otherExcluded.some(other => prefix.includes(other));
            });
            if (isFound && !found.includes(dirName)) found.push(dirName);
        }
        return { passed: found.length === 0, foundDirs: found };
    }

    // Fallback for zip-based submissions: scan the filesystem (max 4 levels deep).
    // Report any excluded entry name we encounter, and don't descend into excluded dirs.
    const found = [];
    walk(extractedDir, {
        maxDepth: 4,
        visit: (d, names) => {
            for (const name of names) {
                if (hygiene.excludedFromRepo.includes(name) && !found.includes(name)) {
                    found.push(name);
                }
            }
        },
        shouldDescend: (full, name) => !hygiene.excludedFromRepo.includes(name)
    });
    return { passed: found.length === 0, foundDirs: found };
}

// Developer-header detection. Every pattern is only ever tested against COMMENT text, never
// raw code (raw code would match `name = input()` in Python).
//
// name: an author/name keyword ("Author:", "@author", "Name =", "Written by") or the student's
//       own first/last name (built per student in checkDeveloperComments).
const NAME_KEYWORD_RE = /@(?:author|name)\b|\b(author|name|developer|programmer)\s*[:=]|\b(written|created|coded|developed|modified)\s+by\b/i;
// date: a date keyword or an actual date — 1/5/2026, 2026-01-05, "Jan 5", "January 2026",
//       or a term like "Fall 2025".
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_RE = new RegExp([
    '@date\\b', '\\bdate\\s*[:=]',
    '\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b',
    '\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b',
    `\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`,
    `\\b${MONTH},?\\s+\\d{4}\\b`,
    '\\b(?:fall|winter|spring|summer)\\s+(?:term\\s+)?\\d{4}\\b',
].join('|'), 'i');
// ai: an AI-use disclosure ("AI used: Copilot for …", "No AI was used", "Written with ChatGPT").
//     Distinctive product names match in any case; short/ambiguous ones ("AI", "Cursor",
//     "Bard", "Grok", "Llama") only as written, so "cursor"/"said" don't count.
const AI_DISCLOSURE_RES = [
    /\b(?:chat\s?gpt|gpt[-\s]?\d|copilot|claude|gemini|codex|deepseek|perplexity|windsurf|llms?|artificial intelligence|generative ai)\b/i,
    /(?<![A-Za-z])(?:AI|A\.I\.)(?![A-Za-z])|\b(?:Cursor|Bard|Grok|Llama)\b/,
];
// The AI disclosure must be in the file's header (its first lines), not anywhere: in an AI
// course, comments deeper in the code legitimately talk about Gemini, LLMs, etc.
const HEADER_LINES = 40;


/**
 * Checks each source file's COMMENTS (adapter.extractComments; docstrings count for Python)
 * for developer-header elements: `name` (author keyword or the student's first/last name as a
 * whole word), `date` (date keyword or an actual date), and `ai` (an AI-use disclosure within
 * the first HEADER_LINES lines). Empty files (e.g. a blank __init__.py) are not counted.
 *
 * filesWith/missing use the default rule — a file "has a developer header" when it has a name
 * or a date — which is what analysis.hasDeveloperComments and a plain developer_comments
 * mapping use. A mapping with `require` re-evaluates `files` itself.
 *
 * opts.ignoreCommentsBy: comment lines containing any of these strings (case-insensitive) are
 * ignored for all three checks — e.g. the instructor's own header on starter files ("By Brian
 * Bird, winter term 2026, using GitHub Copilot"), which students often keep and which would
 * otherwise count as the student's own name/date/AI disclosure. A line that ALSO names the
 * student is kept: it's the student's own attribution ("Andy Still, Jan 2026, based on code
 * by Brian Bird").
 *
 * @returns {{ filesChecked: number, filesWith: number, missing: string[],
 *             files: {path: string, name: boolean, date: boolean, ai: boolean}[] }} — paths are
 *   posix, relative to baseDir.
 */
function checkDeveloperComments(files, studentName, adapter = jsAdapter, baseDir = '', opts = {}) {
    // Whole-word, Unicode-aware name matching; 1-letter parts (initials) are ignored since
    // they'd match nearly anything.
    const nameParts = (studentName || '').split(/\s+/).filter(p => p.length > 1);
    const candidates = [nameParts[0], nameParts.length > 1 ? nameParts[nameParts.length - 1] : null].filter(Boolean);
    const nameRes = candidates.map(n => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(n)}(?![\\p{L}\\p{N}_])`, 'iu'));
    const extractRaw = adapter.extractComments || (s => s);
    const ignore = (opts.ignoreCommentsBy || []).map(s => String(s).toLowerCase()).filter(Boolean);
    const extract = ignore.length === 0
        ? extractRaw
        : code => extractRaw(code).split(/\r?\n/)
            .filter(line => !ignore.some(s => line.toLowerCase().includes(s)) || nameRes.some(re => re.test(line)))
            .join('\n');

    const result = { filesChecked: 0, filesWith: 0, missing: [], files: [] };
    for (const file of files) {
        let content;
        try { content = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        if (!content.trim()) continue;
        result.filesChecked++;
        const comments = extract(content);
        const headerComments = extract(content.split(/\r?\n/).slice(0, HEADER_LINES).join('\n'));
        const relPath = toPosix(baseDir ? path.relative(baseDir, file) : file);
        const entry = {
            path: relPath,
            name: NAME_KEYWORD_RE.test(comments) || nameRes.some(re => re.test(comments)),
            date: DATE_RE.test(comments),
            ai: AI_DISCLOSURE_RES.some(re => re.test(headerComments)),
        };
        result.files.push(entry);
        if (entry.name || entry.date) result.filesWith++;
        else result.missing.push(relPath);
    }
    return result;
}

/**
 * Custom analyzer extension point. Invokes a lab's custom analyzer and merges its
 * returned object into the analysis. A throwing analyzer is logged and skipped
 * (analysis is left intact); a non-object return is ignored.
 * @param {function} customAnalyzer — (jsFiles, analysis, config, student) => object|undefined
 *   May itself be async; the return value is always awaited before merging, so an async
 *   analyzer's result lands in `analysis` rather than a pending Promise being assigned.
 */
async function applyCustomAnalyzer(customAnalyzer, jsFiles, analysis, config, student) {
    try {
        const customResults = await customAnalyzer(jsFiles, analysis, config, student);
        if (customResults && typeof customResults === 'object') {
            Object.assign(analysis, customResults);
        }
    } catch (e) {
        const name = (student && student.name) || 'unknown';
        console.warn(`  WARNING: Custom analyzer failed for ${name}: ${e.message}`);
    }
}

export default async function(students, config, labDir, configDir = null) {
    const adapter = resolveAdapter(config);

    const rubricPath = config.rubricName
        ? path.join(configDir || labDir, config.rubricName)
        : null;
    const partGameNames = {};
    if (config.parts) {
        config.parts.forEach(part => {
            if (part.rubricName) {
                const partRubricPath = path.join(configDir || labDir, part.rubricName);
                partGameNames[part.id] = readGameNamesFromRubric(partRubricPath, 1);
            } else if (part.rubricTitleRow != null) {
                partGameNames[part.id] = readGameNamesFromRubric(rubricPath, part.rubricTitleRow);
            } else {
                partGameNames[part.id] = [];
            }
            console.log(`  Part "${part.id}" game names from rubric: ${partGameNames[part.id].join(', ') || '(none found)'}`);
        });
    }

    // Load custom analyzer if configured
    let customAnalyzer = null;
    if (config.analysis && config.analysis.customAnalyzer) {
        // Resolve repo-shipped analyzers (src/analyzers/) first — these are canonical
        // and unit-tested — then fall back to one supplied beside the external lab config.
        const repoAnalyzerPath = path.join(import.meta.dirname, '..', 'analyzers', config.analysis.customAnalyzer);
        const analyzerPath = fs.existsSync(repoAnalyzerPath)
            ? repoAnalyzerPath
            : path.resolve(configDir || labDir, config.analysis.customAnalyzer);
        if (fs.existsSync(analyzerPath)) {
            try {
                customAnalyzer = (await import(pathToFileURL(analyzerPath).href)).default;
                console.log(`  Custom analyzer loaded: ${config.analysis.customAnalyzer}`);
            } catch (e) {
                console.warn(`  WARNING: Failed to load custom analyzer "${config.analysis.customAnalyzer}": ${e.message}`);
            }
        } else {
            console.warn(`  WARNING: Custom analyzer not found at ${analyzerPath}`);
        }
    }

    // Base analysis shape shared by both a fresh per-student analysis and the
    // no-code/error fallback — built fresh each call so the zeroed `features` map and
    // empty `partFeatures`/`partPresence` objects are never shared references between
    // students (the bug class described in per_student_phase.js's noCodeResult docs).
    const baseAnalysis = (student) => {
        const analysis = {
            error: null,
            urls: student.urls || {},
            hasCodeReview: false,
            hasDeveloperComments: false,
            features: {},
            partFeatures: {},
            partPresence: {}
        };
        if (config.analysis && config.analysis.features) {
            config.analysis.features.forEach(feat => {
                analysis.features[feat.id] = 0;
            });
        }
        return analysis;
    };

    await runPerStudentPhase(students, {
        name: 'Analysis Phase',
        attachKey: 'analysis',
        noCodeResult: (student) => {
            const analysis = baseAnalysis(student);
            analysis.error = 'No code found to analyze.';
            analysis.extractionError = student.error || 'Code directory not found';
            return analysis;
        },
        errorResult: (e, student) => {
            const analysis = baseAnalysis(student);
            analysis.error = 'Analysis failed.';
            analysis.extractionError = e.message;
            return analysis;
        },
        checkStudent: async (student) => {
        const analysis = baseAnalysis(student);
        // Path-segment exclusions: build output, VCS metadata, and dependency/virtual-env
        // folders a student may have submitted by mistake (a stray Python .venv would
        // otherwise add thousands of library files to feature counts and comment checks).
        const exclusions = ['node_modules', 'dist', '.git', '.venv', 'venv', '__pycache__'];
        const allExtractedFiles = getAllFiles(student.extractedDir, exclusions);

        // Loose existence check ("did they submit anything review-named"), deliberately
        // more permissive than read_code_review.js's student.codeReview.found (which
        // requires a top-level, parseable .docx). See src/lib/student.js's Student typedef
        // doc for why these two flags are expected to disagree sometimes.
        const checkCodeReview = (fileName) => {
            const basename = path.basename(fileName).toLowerCase();
            if (basename.includes('review') && (basename.endsWith('.docx') || basename.endsWith('.pdf') || basename.endsWith('.txt'))) {
                analysis.hasCodeReview = true;
            }
        };
        if (student.filesDir) {
            const outsideFiles = fs.readdirSync(student.filesDir);
            outsideFiles.forEach(f => checkCodeReview(path.join(student.filesDir, f)));
        }
        allExtractedFiles.forEach(checkCodeReview);

        // node_modules/dist are already excluded by path segment above — a substring test
        // here would wrongly drop e.g. "distance.py".
        const jsFiles = allExtractedFiles.filter(f => {
            const lf = f.toLowerCase();
            return adapter.sourceExtensions.some(ext => lf.endsWith(ext));
        });

        // ignoreCommentsBy lives on the developer_comments mapping(s); analysis runs before
        // grading, so collect it here.
        const ignoreCommentsBy = (config.mappings || [])
            .filter(m => m.type === 'developer_comments' && Array.isArray(m.ignoreCommentsBy))
            .flatMap(m => m.ignoreCommentsBy);
        analysis.developerComments = checkDeveloperComments(jsFiles, student.name, adapter, student.extractedDir, { ignoreCommentsBy });
        analysis.hasDeveloperComments = analysis.developerComments.filesWith > 0;

        // Whole-repo feature counts — used by feature-type mappings in generate_grades
        const wholeCounts = countFeatures(allExtractedFiles, config.analysis && config.analysis.features, adapter);
        Object.assign(analysis.features, wholeCounts);

        // Per-part feature counts
        if (config.parts) {
            config.parts.forEach(part => {
                const gameNames = partGameNames[part.id] || [];
                const partDir = findPartDir(student.extractedDir, gameNames, part.folderPattern);
                if (partDir) {
                    const partFiles = getAllFiles(partDir, exclusions);
                    analysis.partFeatures[part.id] = countFeatures(partFiles, config.analysis && config.analysis.features, adapter);
                    const featureLog = (config.analysis && config.analysis.features || []).map(f =>
                        `${f.id}=${analysis.partFeatures[part.id][f.id] || 0}`
                    ).join(', ');
                    console.log(`    ${student.name} / ${part.id} (${path.basename(partDir)}): ${featureLog}`);
                } else {
                    analysis.partFeatures[part.id] = null;
                    console.log(`    ${student.name} / ${part.id}: folder not found`);
                }
            });
        }

        // Part presence detection
        analysis.partPresence = detectPartsPresent(student.extractedDir, config, partGameNames);

        // Custom analyzer hook — merges additional data into analysis
        if (customAnalyzer) {
            await applyCustomAnalyzer(customAnalyzer, jsFiles, analysis, config, student);
        }

        if (config.packageCheck && adapter.checkManifest) {
            analysis.packageCheck = adapter.checkManifest(student.extractedDir, config.packageCheck);
            if (!analysis.packageCheck.passed) {
                console.log(`    ${student.name} package.json: ${analysis.packageCheck.issues.join('; ')}`);
            }
        }

        // Always extract used packages/modules in source code (for npm_package handler),
        // when the adapter supports the concept (some languages have no such notion).
        if (adapter.extractUsedPackages) {
            const allFiles = getAllFiles(student.extractedDir, ['node_modules', 'dist', '.git']);
            const pkgFiles = allFiles.filter(f => path.basename(f) === 'package.json');
            analysis.npmPackages = [...adapter.extractUsedPackages(student.extractedDir, pkgFiles)].sort();
        } else {
            analysis.npmPackages = [];
        }

        if (config.repoHygiene) {
            analysis.repoHygiene = checkRepoHygiene(student.extractedDir, config.repoHygiene);
            if (analysis.repoHygiene && !analysis.repoHygiene.passed) {
                console.log(`    ${student.name} repo hygiene: found ${analysis.repoHygiene.foundDirs.join(', ')}`);
            }
        }

        if (config.variations) {
            analysis.versionVariation = checkVersionVariation(student.extractedDir, config.variations, config.variationExcludeNamePatterns);
            const vv = analysis.versionVariation;
            if (vv.detected) {
                console.log(`    ${student.name} version: ${vv.detected} (${vv.appName})`);
            } else if (vv.ambiguous) {
                console.log(`    ${student.name} version: AMBIGUOUS - ${JSON.stringify(vv.scores)}`);
            } else {
                console.log(`    ${student.name} version: UNKNOWN - no variation keywords found`);
            }
        }

        return analysis;
        }
    });

    writePhaseReport(labDir, ANALYSIS_REPORT, students, s => ({
        student: s.name,
        results: s.analysis || {},
        filesDir: s.filesDir
    }));
};

export { stripComments, normalizeDirName, getAllFiles, getSubdirs, checkRepoHygiene, detectPartsPresent, applyCustomAnalyzer, countFeatures, readGameNamesFromRubric, checkDeveloperComments };
