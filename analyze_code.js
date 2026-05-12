/**
 * analyze_code.js
 *
 * Analyzes the extracted code for specific features based on regex mappings in the config.
 * For labs with "parts", counts features per-part using folder names read from the rubric.
 * Attaches results directly to each student object as student.analysis.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
let xlsx;
try { xlsx = require('xlsx'); } catch (e) {}

const ANALYSIS_REPORT = 'analysis_report.json';

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
        if (stats.isSymbolicLink()) return;
        if (stats.isDirectory()) {
            arrayOfFiles = getAllFiles(fullP, arrayOfFiles, exclusions);
        } else {
            arrayOfFiles.push(fullP);
        }
    });

    return arrayOfFiles;
}

function countFeatures(allFiles, configFeatures) {
    const counts = {};
    if (!configFeatures) return counts;
    configFeatures.forEach(f => { counts[f.id] = 0; });

    for (const feat of configFeatures) {
        const fileFilter = feat.fileRegex
            ? f => new RegExp(feat.fileRegex).test(f)
            : f => f.endsWith('.js');
        const filesToSearch = allFiles.filter(fileFilter);
        for (const file of filesToSearch) {
            let content;
            try { content = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
            const searchable = file.endsWith('.js') ? stripComments(content) : content;
            try {
                const regex = new RegExp(feat.regex, 'g');
                const matches = searchable.match(regex);
                if (matches) counts[feat.id] += matches.length;
            } catch (e) {
                console.warn(`  Warning: Invalid regex for feature "${feat.id}": ${feat.regex}`);
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
    } catch (e) { /* skip */ }
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
    try {
        return fs.readdirSync(dirPath).filter(f => {
            if (f.startsWith('.')) return false;
            let stats;
            try { stats = fs.lstatSync(path.join(dirPath, f)); } catch (e) { return false; }
            return stats.isDirectory() && !stats.isSymbolicLink();
        });
    } catch (e) { return []; }
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

        const detectedParts = Object.keys(result).filter(k => k !== 'allPresent');
        result.allPresent = detectedParts.length > 0;
    }
    return result;
}

const KNOWN_PKG_SECTIONS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);

// Common words that appear in many app names and are not useful for distinguishing variations.
const VARIATION_KEYWORD_STOPWORDS = new Set(['web', 'page', 'app', 'list', 'tool', 'maker', 'mini', 'lite', 'plus']);

/**
 * Derives search keywords from an appName by keeping words that are at least
 * 4 chars long and not in the stopword list.
 * @param {string} appName
 * @returns {string[]} lowercase keywords
 */
function variationKeywords(appName) {
    return appName.toLowerCase().split(/\W+/).filter(
        w => w.length >= 4 && !VARIATION_KEYWORD_STOPWORDS.has(w)
    );
}

/**
 * Collects a corpus of searchable text from the repo: HTML title tags,
 * top-level directory names, package.json name fields, and README content.
 * @param {string} extractedDir
 * @returns {string} lowercase combined text
 */
function buildVariationCorpus(extractedDir) {
    const parts = [];
    // Exclude build artifacts, deps, and directory names that mark distributed
    // starter/template files — they often contain ALL variation keywords and
    // would pollute the signal. Match on directory-name components only
    // (checked via path.basename of each directory entry), not full-path substrings,
    // to avoid incorrectly excluding repos whose root folder happens to contain
    // one of these words (e.g., a repo named "LCC-CIT CourseMaterials ...").
    const hardExclusions = new Set(['node_modules', 'dist', '.git']);
    const nameExclusionPatterns = [/_starter$/i, /_template$/i, /^filestostudents$/i];

    function isExcluded(fullPath) {
        const segments = fullPath.split(path.sep);
        return segments.some(seg =>
            hardExclusions.has(seg) ||
            nameExclusionPatterns.some(re => re.test(seg))
        );
    }

    // Top-level directory and file names
    try {
        for (const entry of fs.readdirSync(extractedDir)) {
            parts.push(entry);
        }
    } catch (e) { /* skip */ }

    // HTML title tags (up to 20 HTML files, skipping excluded dirs)
    const allFiles = getAllFiles(extractedDir, [], []).filter(f => !isExcluded(f));
    const htmlFiles = allFiles.filter(f => f.endsWith('.html'));
    for (const f of htmlFiles.slice(0, 20)) {
        try {
            const content = fs.readFileSync(f, 'utf8');
            const m = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            if (m) parts.push(m[1]);
        } catch (e) { /* skip */ }
    }

    // package.json name field
    const pkgFiles = allFiles.filter(f => path.basename(f) === 'package.json');
    for (const f of pkgFiles.slice(0, 5)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (pkg.name) parts.push(pkg.name);
            if (pkg.description) parts.push(pkg.description);
        } catch (e) { /* skip */ }
    }

    // README (first 1 000 chars)
    const readmes = allFiles.filter(f => /README/i.test(path.basename(f)));
    for (const f of readmes.slice(0, 3)) {
        try {
            parts.push(fs.readFileSync(f, 'utf8').substring(0, 1000));
        } catch (e) { /* skip */ }
    }

    return parts.join(' ').toLowerCase();
}

/**
 * Detects which lab variation a student implemented by matching keywords
 * from each variation's appName against the code corpus.
 * Only applies when top-level config.variations exists.
 * @param {string} extractedDir
 * @param {Object} variations  config.variations map (letter → { appName })
 * @returns {{ detected: string|null, appName: string|null, scores: Object }}
 */
function checkVersionVariation(extractedDir, variations) {
    const corpus = buildVariationCorpus(extractedDir);
    const scores = {};

    for (const [letter, info] of Object.entries(variations)) {
        if (!info.appName) continue;
        const keywords = variationKeywords(info.appName);
        scores[letter] = keywords.filter(kw => corpus.includes(kw)).length;
    }

    const best = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (best.length === 0 || best[0][1] === 0) {
        return { detected: null, appName: null, scores };
    }
    // Ambiguous if top two scores are tied (and non-zero)
    if (best.length > 1 && best[0][1] === best[1][1]) {
        return { detected: null, appName: null, scores, ambiguous: true };
    }
    const letter = best[0][0];
    return { detected: letter, appName: variations[letter].appName, scores };
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
        } catch (e) { /* fall through to empty string */ }

        const trackedPaths = trackedFiles.split('\n').filter(Boolean);
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

    // Fallback for zip-based submissions: scan the filesystem
    const found = [];

    function searchDir(dirPath, depth) {
        if (depth > 4) return;
        let entries;
        try { entries = fs.readdirSync(dirPath); } catch (e) { return; }
        for (const entry of entries) {
            if (!hygiene.excludedFromRepo.includes(entry)) {
                const fullPath = path.join(dirPath, entry);
                let stat;
                try { stat = fs.lstatSync(fullPath); } catch (e) { continue; }
                if (!stat.isSymbolicLink() && stat.isDirectory()) searchDir(fullPath, depth + 1);
                continue;
            }
            if (!found.includes(entry)) found.push(entry);
            // don't recurse into excluded dirs/files
        }
    }

    searchDir(extractedDir, 0);
    return { passed: found.length === 0, foundDirs: found };
}

function extractUsedPackages(extractedDir, pkgJsonPaths) {
    const exclusions = ['node_modules', 'dist', '.git'];
    const allFiles = getAllFiles(extractedDir, [], exclusions);
    const sourceFiles = allFiles.filter(f => /\.(js|mjs|cjs|jsx|ts|tsx)$/.test(f));

    const used = new Set();

    function normalizePkgName(raw) {
        if (raw.startsWith('@')) return raw.split('/').slice(0, 2).join('/');
        return raw.split('/')[0];
    }

    // Patterns that capture a package specifier (not a relative path)
    const patterns = [
        /\bfrom\s+['"]([^'"./][^'"]*)['"]/g,           // import ... from 'pkg'
        /\bimport\s+['"]([^'"./][^'"]*)['"]/g,          // import 'pkg' (side-effect)
        /\bimport\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g, // import('pkg') dynamic
        /\brequire\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g, // require('pkg')
    ];

    for (const file of sourceFiles) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            for (const re of patterns) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(content)) !== null) {
                    used.add(normalizePkgName(m[1]));
                }
            }
        } catch (e) { /* skip unreadable files */ }
    }

    // Also treat the first token in each package.json script as a used CLI tool.
    // This covers tools like "vite", "vitest", "eslint" that are invoked but not imported.
    for (const pkgPath of pkgJsonPaths) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            for (const scriptVal of Object.values(pkg.scripts || {})) {
                const tokens = String(scriptVal).trim().split(/\s+/);
                // skip "npx" / "node" prefixes and pick the actual tool name
                let toolIdx = 0;
                if (tokens[toolIdx] === 'npx' || tokens[toolIdx] === 'node') toolIdx++;
                if (tokens[toolIdx]) used.add(normalizePkgName(tokens[toolIdx]));
            }
        } catch (e) { /* skip */ }
    }

    return used;
}

function checkPackageJson(extractedDir, packageCheckConfig) {
    const allFiles = getAllFiles(extractedDir, [], ['node_modules', 'dist', '.git']);
    const pkgFiles = allFiles.filter(f => path.basename(f) === 'package.json');

    if (pkgFiles.length === 0) {
        return { found: false, passed: false, issues: ['package.json not found'] };
    }

    const parsed = [];
    for (const f of pkgFiles) {
        try {
            parsed.push({ path: f, pkg: JSON.parse(fs.readFileSync(f, 'utf8')) });
        } catch (e) { /* skip unparseable */ }
    }

    if (parsed.length === 0) {
        return { found: true, passed: false, issues: ['package.json could not be parsed'] };
    }

    const issues = [];
    const allSections = [...KNOWN_PKG_SECTIONS];

    for (const [section, packages] of Object.entries(packageCheckConfig)) {
        if (!KNOWN_PKG_SECTIONS.has(section) || !Array.isArray(packages)) continue;
        const wrongSections = allSections.filter(s => s !== section);

        for (const pkgName of packages) {
            const inCorrect = parsed.some(({ pkg }) => pkg[section] && pkgName in pkg[section]);
            if (inCorrect) continue;

            const inWrong = wrongSections.find(s => parsed.some(({ pkg }) => pkg[s] && pkgName in pkg[s]));
            if (inWrong) {
                issues.push(`"${pkgName}" is in ${inWrong} but should be in ${section}`);
            } else {
                issues.push(`"${pkgName}" not found in package.json`);
            }
        }
    }

    // Check for extra packages declared in package.json but never imported or used as CLI tools.
    const allowedExtras = new Set(Array.isArray(packageCheckConfig.allowedExtras) ? packageCheckConfig.allowedExtras : []);
    const usedPackages = extractUsedPackages(extractedDir, pkgFiles);

    for (const { pkg } of parsed) {
        for (const section of KNOWN_PKG_SECTIONS) {
            if (!pkg[section]) continue;
            for (const pkgName of Object.keys(pkg[section])) {
                if (!usedPackages.has(pkgName) && !allowedExtras.has(pkgName)) {
                    issues.push(`extra package "${pkgName}" in ${section} is never imported`);
                }
            }
        }
    }

    return { found: true, passed: issues.length === 0, issues };
}

module.exports = function(students, config, labDir, configDir = null) {
    console.log("--- Analysis Phase ---");

    const rubricPath = config.rubricName
        ? path.join(configDir || labDir, config.rubricName)
        : null;
    const partGameNames = {};
    if (config.parts) {
        config.parts.forEach(part => {
            partGameNames[part.id] = readGameNamesFromRubric(rubricPath, part.rubricTitleRow);
            console.log(`  Part "${part.id}" game names from rubric: ${partGameNames[part.id].join(', ') || '(none found)'}`);
        });
    }

    // Load custom analyzer if configured
    let customAnalyzer = null;
    if (config.analysis && config.analysis.customAnalyzer) {
        const analyzerPath = path.resolve(configDir || path.join(__dirname, 'configs'), config.analysis.customAnalyzer);
        if (fs.existsSync(analyzerPath)) {
            try {
                customAnalyzer = require(analyzerPath);
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
        const allExtractedFiles = getAllFiles(student.extractedDir, [], exclusions);

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

        const jsFiles = allExtractedFiles.filter(f => f.endsWith('.js') && !f.includes('node_modules') && !f.includes('dist'));

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
        const wholeCounts = countFeatures(allExtractedFiles, config.analysis && config.analysis.features);
        Object.assign(analysis.features, wholeCounts);

        // Per-part feature counts
        if (config.parts) {
            config.parts.forEach(part => {
                const gameNames = partGameNames[part.id] || [];
                const partDir = findPartDir(student.extractedDir, gameNames, part.folderPattern);
                if (partDir) {
                    const partFiles = getAllFiles(partDir, [], exclusions);
                    analysis.partFeatures[part.id] = countFeatures(partFiles, config.analysis && config.analysis.features);
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
            try {
                const customResults = customAnalyzer(jsFiles, analysis, config, student);
                if (customResults && typeof customResults === 'object') {
                    Object.assign(analysis, customResults);
                }
            } catch (e) {
                console.warn(`  WARNING: Custom analyzer failed for ${student.name}: ${e.message}`);
            }
        }

        if (config.packageCheck) {
            analysis.packageCheck = checkPackageJson(student.extractedDir, config.packageCheck);
            if (!analysis.packageCheck.passed) {
                console.log(`    ${student.name} package.json: ${analysis.packageCheck.issues.join('; ')}`);
            }
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

module.exports.stripComments = stripComments;
module.exports.normalizeDirName = normalizeDirName;
