/**
 * analyze_code.js
 * 
 * Analyzes the extracted code for specific features based on regex mappings in the config.
 * For labs with "parts", counts features per-part using folder names read from the rubric.
 */

const fs = require('fs');
const path = require('path');
let xlsx;
try { xlsx = require('xlsx'); } catch(e) {}

// Strip single-line (//) and multi-line (/* */) comments from JS source.
// Preserves string/template literal contents to avoid stripping // inside URLs, etc.
// NOTE: block comments are stripped first to prevent apostrophes in JSDoc comments
// (e.g. "user's") from being mistakenly treated as the start of a string literal.
function stripComments(code) {
    // Step 1: strip /* */ block comments first (unambiguous delimiters)
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    // Step 2: protect string literals
    const strings = [];
    code = code.replace(/(['"`])((?:\\[\s\S]|(?!\1)[^\\])*?)\1/g, match => {
        strings.push(match);
        return `\x00${strings.length - 1}\x00`;
    });
    // Step 3: strip single-line comments
    code = code.replace(/\/\/[^\n]*/g, '');
    // Step 4: restore string literals
    code = code.replace(/\x00(\d+)\x00/g, (_, i) => strings[+i]);
    return code;
}

function escapeRegex(word) {
    return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAllFiles(dirPath, arrayOfFiles, exclusions = []) {
    let files;
    try { files = fs.readdirSync(dirPath); } catch (e) { return arrayOfFiles; }

    arrayOfFiles = arrayOfFiles || [];
    files.forEach(function (file) {
        let fullP = path.join(dirPath, file);
        if (exclusions.some(ex => fullP.includes(ex))) return;
        let stats;
        try { stats = fs.lstatSync(fullP); } catch (e) { return; }
        if (stats.isSymbolicLink()) return; // skip symlinks to avoid infinite loops
        if (stats.isDirectory()) {
            arrayOfFiles = getAllFiles(fullP, arrayOfFiles, exclusions);
        } else {
            arrayOfFiles.push(fullP);
        }
    });

    return arrayOfFiles;
}

// Count feature occurrences in a set of JS files
function countFeatures(jsFiles, configFeatures) {
    const counts = {};
    if (configFeatures) configFeatures.forEach(f => { counts[f.id] = 0; });

    jsFiles.forEach(js => {
        const content = fs.readFileSync(js, 'utf8');
        const stripped = stripComments(content);
        if (configFeatures) {
            configFeatures.forEach(feat => {
                try {
                    const regex = new RegExp(feat.regex, 'g');
                    const matches = stripped.match(regex);
                    if (matches) counts[feat.id] += matches.length;
                } catch (e) {
                    console.warn(`  Warning: Invalid regex for feature "${feat.id}": ${feat.regex}`);
                }
            });
        }
    });
    return counts;
}

// Read game names from rubric title row (column E, comma-separated)
function readGameNamesFromRubric(rubricPath, rubricTitleRow) {
    if (!rubricPath || !xlsx || !fs.existsSync(rubricPath)) return [];
    try {
        const wb = xlsx.readFile(rubricPath);
        const sheet = wb.Sheets['Grade'];
        const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
        const row = data[rubricTitleRow - 1]; // rubricTitleRow is 1-indexed
        // Game names are in column E (index 4)
        if (row && row[4]) {
            return row[4].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        }
    } catch(e) { /* skip */ }
    return [];
}

// Normalize a directory name for matching: split camelCase, lowercase, replace separators with spaces
function normalizeDirName(dir) {
    return dir
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .replace(/[-_]/g, ' ');
}

// Test if a directory name matches any game name
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
    try {
        return fs.readdirSync(dirPath).filter(f => {
            if (f.startsWith('.')) return false;
            let stats;
            try { stats = fs.lstatSync(path.join(dirPath, f)); } catch (e) { return false; }
            return stats.isDirectory() && !stats.isSymbolicLink();
        });
    } catch(e) { return []; }
}

// Find the subdirectory in extractedDir that best matches game names or folder pattern
function findPartDir(extractedDir, gameNames, folderPattern) {
    const topLevelDirs = getSubdirs(extractedDir);
    if (topLevelDirs.length === 0) return null;

    // Pass 1: match top-level dirs against game names
    for (const dir of topLevelDirs) {
        if (dirMatchesGameNames(dir, gameNames)) {
            return path.join(extractedDir, dir);
        }
    }

    // Pass 2: match subdirectories of top-level dirs against game names
    // (handles structures like Lab3p1C/BoneYardBluff)
    for (const dir of topLevelDirs) {
        const subDirs = getSubdirs(path.join(extractedDir, dir));
        for (const sub of subDirs) {
            if (dirMatchesGameNames(sub, gameNames)) {
                return path.join(extractedDir, dir, sub);
            }
        }
    }

    // Pass 3: if only one top-level dir, recurse into it (handles Lab3/Lab3Part1)
    if (topLevelDirs.length === 1) {
        const result = findPartDir(path.join(extractedDir, topLevelDirs[0]), gameNames, folderPattern);
        if (result) return result;
    }

    // Pass 4: fallback to folderPattern (e.g. "part1", "part-1", "pt2")
    if (folderPattern) {
        const regex = new RegExp(folderPattern, 'i');
        // Check top-level dirs
        for (const dir of topLevelDirs) {
            if (regex.test(dir)) return path.join(extractedDir, dir);
        }
        // Check subdirectories too
        for (const dir of topLevelDirs) {
            const subDirs = getSubdirs(path.join(extractedDir, dir));
            for (const sub of subDirs) {
                if (regex.test(sub)) return path.join(extractedDir, dir, sub);
            }
        }
    }

    return null;
}

module.exports = function(students, config, labDir) {
    console.log("--- Analysis Phase ---");
    const report = [];

    // Pre-load game names from rubric for each part if configured
    const rubricPath = config.rubricName ? path.join(labDir, config.rubricName) : null;
    const partGameNames = {};
    if (config.parts) {
        config.parts.forEach(part => {
            partGameNames[part.id] = readGameNamesFromRubric(rubricPath, part.rubricTitleRow);
            console.log(`  Part "${part.id}" game names from rubric: ${partGameNames[part.id].join(', ') || '(none found)'}`);
        });
    }

    students.forEach(student => {
        const results = {
            error: null,
            urls: student.urls,
            hasCodeReview: false,
            hasDeveloperComments: false,
            features: {},
            partFeatures: {}  // per-part feature counts: { part1: { classes: 2 }, part2: { classes: 4 } }
        };

        if (config.analysis && config.analysis.features) {
            config.analysis.features.forEach(feat => {
                results.features[feat.id] = 0;
            });
        }

        // If extraction failed (e.g. clone failed, unzip failed), flag immediately
        if (student.error) {
            results.error = "No code found to analyze.";
            results.extractionError = student.error;
            report.push({ student: student.name, results, filesDir: student.filesDir });
            return;
        }

        if (!student.extractedDir || !fs.existsSync(student.extractedDir)) {
            results.error = "No code found to analyze.";
            results.extractionError = 'Code directory not found';
            report.push({ student: student.name, results, filesDir: student.filesDir });
            return;
        }

        const exclusions = ['node_modules', 'dist', '.git'];
        const allExtractedFiles = getAllFiles(student.extractedDir, [], exclusions);

        // Check for Code Review in root or inside extracted code
        const checkCodeReview = (fileName) => {
            const basename = path.basename(fileName).toLowerCase();
            if (basename.includes('review') && (basename.endsWith('.docx') || basename.endsWith('.pdf') || basename.endsWith('.txt'))) {
                results.hasCodeReview = true;
            }
        };
        if (student.filesDir) {
            const outsideFiles = fs.readdirSync(student.filesDir);
            outsideFiles.forEach(f => checkCodeReview(path.join(student.filesDir, f)));
        }
        allExtractedFiles.forEach(checkCodeReview);

        // All JS files for whole-repo checks
        const jsFiles = allExtractedFiles.filter(f => f.endsWith('.js') && !f.includes('node_modules') && !f.includes('dist'));

        // Developer name check
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
                results.hasDeveloperComments = true;
            }
        });

        // Whole-repo feature counts
        const wholeCounts = countFeatures(jsFiles, config.analysis && config.analysis.features);
        Object.assign(results.features, wholeCounts);

        // Per-part feature counts
        if (config.parts) {
            config.parts.forEach(part => {
                const gameNames = partGameNames[part.id] || [];
                const partDir = findPartDir(student.extractedDir, gameNames, part.folderPattern);
                if (partDir) {
                    const partFiles = getAllFiles(partDir, [], exclusions).filter(f => f.endsWith('.js') && !f.includes('node_modules') && !f.includes('dist'));
                    results.partFeatures[part.id] = countFeatures(partFiles, config.analysis && config.analysis.features);
                    console.log(`    ${student.name} / ${part.id} (${path.basename(partDir)}): classes=${results.partFeatures[part.id].classes || 0}`);
                } else {
                    results.partFeatures[part.id] = null; // folder not found
                    console.log(`    ${student.name} / ${part.id}: folder not found`);
                }
            });
        }

        // Lab02 compatibility: modules requires BOTH import and export
        if (config.analysis && config.analysis.features && config.analysis.features.find(f => f.id === 'modules')) {
            let hasImport = false;
            let hasExport = false;
            jsFiles.forEach(js => {
                const content = fs.readFileSync(js, 'utf8');
                if (content.match(/import\s+.*from/)) hasImport = true;
                if (content.match(/export\s+/)) hasExport = true;
            });
            results.features['modules'] = (hasImport && hasExport) ? 1 : 0;
        }

        // Detect if both parts are present
        // Only check top-level directory relative to extractedDir to avoid
        // false positives from unrelated lab files in student repos
        let hasPart1 = false;
        let hasPart2 = false;
        allExtractedFiles.forEach(f => {
            const rel = path.relative(student.extractedDir, f);
            const topDir = rel.split(path.sep)[0].toLowerCase().replace(/[-_]/g, ' ');
            if (topDir.match(/\b(?:part|pt)\s*1\b/)) hasPart1 = true;
            if (topDir.match(/\b(?:part|pt)\s*2\b/)) hasPart2 = true;
        });
        // Also count parts found via game-name matching
        if (results.partFeatures.part1) hasPart1 = true;
        if (results.partFeatures.part2) hasPart2 = true;
        results.part1Completed = hasPart1;
        results.part2Completed = hasPart2;
        results.bothAppsPresent = hasPart1 && hasPart2;

        report.push({ student: student.name, results, filesDir: student.filesDir });
    });

    fs.writeFileSync(path.join(labDir, 'analysis_report.json'), JSON.stringify(report, null, 2));
    console.log(`Created analysis_report.json for ${report.length} students.`);

    return report;
};
