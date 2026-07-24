/**
 * variation_detect.js
 *
 * Detects which lab variation (config.variations letter -> { appName }) a student
 * implemented, by keyword-matching each variation's appName against a corpus of
 * searchable text collected from the repo (top-level names, HTML titles, package.json
 * name/description, README excerpts). Extracted out of analyze_code.js — self-contained,
 * no dependency on analyze_code.js's per-student state (see refactoring_plan_2026-07-07.md
 * Priority 6).
 */
import fs from 'fs';
import path from 'path';
import { getAllFiles } from './file_walker.js';

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
function buildVariationCorpus(extractedDir, extraNameExclusions = []) {
    const parts = [];
    // Exclude build artifacts, deps, and directory names that mark distributed
    // starter/template files — they often contain ALL variation keywords and
    // would pollute the signal. Match on directory-name components only
    // (checked via path.basename of each directory entry), not full-path substrings,
    // to avoid incorrectly excluding repos whose root folder happens to contain
    // one of these words (e.g., a repo named "LCC-CIT CourseMaterials ...").
    //
    // The defaults below (_starter/_template/filestostudents) are CS233JS's own
    // Moodle-distribution naming convention, not a universal one — kept as the default
    // for backward compatibility, but a course with different conventions can add its
    // own via config.variations.excludeNamePatterns (threaded through from
    // checkVersionVariation) rather than this generic lib assuming CS233JS's naming.
    const hardExclusions = new Set(['node_modules', 'dist', '.git']);
    const nameExclusionPatterns = [/_starter$/i, /_template$/i, /^filestostudents$/i, ...extraNameExclusions];

    function isExcluded(fullPath) {
        const segments = fullPath.split(path.sep);
        return segments.some(seg =>
            hardExclusions.has(seg) ||
            nameExclusionPatterns.some(re => re.test(seg))
        );
    }

    // Top-level directory and file names. Callers only reach this after confirming
    // extractedDir exists, so a failure here is a real IO error, not expected absence.
    try {
        for (const entry of fs.readdirSync(extractedDir)) {
            parts.push(entry);
        }
    } catch (e) {
        console.warn(`  WARNING: buildVariationCorpus: could not read directory ${extractedDir}: ${e.message}`);
    }

    // HTML title tags (up to 20 HTML files, skipping excluded dirs)
    const allFiles = getAllFiles(extractedDir).filter(f => !isExcluded(f));
    const htmlFiles = allFiles.filter(f => f.toLowerCase().endsWith('.html'));
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
        } catch (e) {
            console.warn(`  WARNING: buildVariationCorpus: could not parse ${f}: ${e.message}`);
        }
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
 * @param {string[]} [excludeNamePatterns]  extra regex-source strings (directory-name
 *        components) to exclude from the corpus, beyond the built-in CS233JS-convention
 *        defaults (_starter/_template/filestostudents) — for a course whose distributed
 *        starter files use a different naming convention.
 * @returns {{ detected: string|null, appName: string|null, scores: Object }}
 */
function checkVersionVariation(extractedDir, variations, excludeNamePatterns = []) {
    const corpus = buildVariationCorpus(extractedDir, excludeNamePatterns.map(p => new RegExp(p, 'i')));
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

export { checkVersionVariation, variationKeywords, buildVariationCorpus, VARIATION_KEYWORD_STOPWORDS };
