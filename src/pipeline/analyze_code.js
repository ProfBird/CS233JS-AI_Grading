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
import { walk, toPosix } from '../lib/file_walker.js';
import xlsx from '../lib/xlsx.js';
import jsAdapter from '../adapters/javascript.js';
import { resolveAdapter } from '../adapters/index.js';
import { checkVersionVariation } from '../lib/variation_detect.js';

const ANALYSIS_REPORT = 'analysis_report.json';

// Comment-stripping is language-specific (adapter.stripComments); re-exported here,
// delegating to the JS adapter, for backward compatibility with existing callers/tests.
const stripComments = code => jsAdapter.stripComments(code);

function escapeRegex(word) {
    return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Collects every file under dirPath. Exclusions are substring matches against
// the full path, applied to both files and directories. Does not descend into
// symlinks; does NOT skip dot-dirs unless they match an exclusion.
function getAllFiles(dirPath, exclusions = []) {
    const results = [];
    walk(dirPath, {
        shouldSkip: full => exclusions.some(ex => toPosix(full).includes(toPosix(ex))),
        onFile: full => results.push(full)
    });
    return results;
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
                { cwd: extractedDir, stdio: ['ignore', 'pipe', 'ignore'] }
            ).toString();
        } catch (e) {
            // Falls through to empty string (treated as "no tracked files"), but that
            // silently reports hygiene as passed — warn so a broken git invocation
            // (missing binary, corrupt repo) isn't mistaken for a clean submission.
            console.warn(`  WARNING: checkRepoHygiene: "git ls-files" failed in ${extractedDir}: ${e.message}`);
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

/**
 * Custom analyzer extension point. Invokes a lab's custom analyzer and merges its
 * returned object into the analysis. A throwing analyzer is logged and skipped
 * (analysis is left intact); a non-object return is ignored.
 * @param {function} customAnalyzer — (jsFiles, analysis, config, student) => object|undefined
 */
function applyCustomAnalyzer(customAnalyzer, jsFiles, analysis, config, student) {
    try {
        const customResults = customAnalyzer(jsFiles, analysis, config, student);
        if (customResults && typeof customResults === 'object') {
            Object.assign(analysis, customResults);
        }
    } catch (e) {
        const name = (student && student.name) || 'unknown';
        console.warn(`  WARNING: Custom analyzer failed for ${name}: ${e.message}`);
    }
}

export default async function(students, config, labDir, configDir = null) {
    console.log("--- Analysis Phase ---");

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

    students.forEach(student => {
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

        if (student.error) {
            analysis.error = "No code found to analyze.";
            analysis.extractionError = student.error;
            student.analysis = analysis;
            return;
        }

        if (!student.extractedDir || !fs.existsSync(student.extractedDir)) {
            analysis.error = "No code found to analyze.";
            analysis.extractionError = 'Code directory not found';
            student.analysis = analysis;
            return;
        }

        const exclusions = ['node_modules', 'dist', '.git'];
        const allExtractedFiles = getAllFiles(student.extractedDir, exclusions);

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

        const jsFiles = allExtractedFiles.filter(f => {
            const lf = f.toLowerCase();
            return adapter.sourceExtensions.some(ext => lf.endsWith(ext)) && !lf.includes('node_modules') && !lf.includes('dist');
        });

        const nameParts = student.name.toLowerCase().split(/\s+/);
        const firstName = nameParts.length > 0 ? nameParts[0] : null;
        const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;
        jsFiles.forEach(js => {
            const content = fs.readFileSync(js, 'utf8');
            const lowerContent = content.toLowerCase();
            if (content.match(/@author\s|@name\s|@date\s/i) ||
                content.match(/\b(name|author|date)\s*[:=]/i) ||
                (firstName && lowerContent.includes(firstName)) ||
                (lastName && lowerContent.includes(lastName))) {
                analysis.hasDeveloperComments = true;
            }
        });

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
            applyCustomAnalyzer(customAnalyzer, jsFiles, analysis, config, student);
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
            analysis.versionVariation = checkVersionVariation(student.extractedDir, config.variations);
            const vv = analysis.versionVariation;
            if (vv.detected) {
                console.log(`    ${student.name} version: ${vv.detected} (${vv.appName})`);
            } else if (vv.ambiguous) {
                console.log(`    ${student.name} version: AMBIGUOUS - ${JSON.stringify(vv.scores)}`);
            } else {
                console.log(`    ${student.name} version: UNKNOWN - no variation keywords found`);
            }
        }

        student.analysis = analysis;
    });

    const report = students.map(s => ({
        student: s.name,
        results: s.analysis || {},
        filesDir: s.filesDir
    }));
    fs.writeFileSync(path.join(labDir, ANALYSIS_REPORT), JSON.stringify(report, null, 2));
    console.log(`Created ${ANALYSIS_REPORT} for ${report.length} students.`);
};

export { stripComments, normalizeDirName, getAllFiles, getSubdirs, checkRepoHygiene, detectPartsPresent, applyCustomAnalyzer, countFeatures, readGameNamesFromRubric };
