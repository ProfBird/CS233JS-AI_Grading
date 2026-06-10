/**
 * lab06_analyzer.js — Custom analyzer for Lab 6: Async JS and Web APIs
 *
 * Detects how complete the API integration pipeline is per student.
 * Uses the group letter (A/B/C) from the code review form to target
 * version-specific API domains and response fields.
 *
 * The 5 pipeline steps checked:
 *   1. API domain referenced in code (version-specific or any external URL)
 *   2. fetch response parsed (.json())
 *   3. Response fields extracted (version-specific)
 *   4. Data saved to localStorage
 *   5. API data rendered in lit-html template
 *
 * jsFiles is an array of file paths. This analyzer reads each file to
 * search for patterns in the actual source code.
 *
 * Results are attached as analysis.apiCompleteness.
 */

import fs from 'fs';
import path from 'path';

const VERSIONS = {
    A: {
        label: 'Web Page Bookmarker',
        apiDomain: /linkpreview\.net|linkpreview/i,
        apiLabel: 'linkpreview.net',
        extractFields: /\b(title|image_url|imageUrl)\b/i,
        extractLabel: 'title, image_url/imageUrl',
        renderFields: /\$\{.*\b(title|image|imageUrl|image_url)\b[^}]*\}/i
    },
    B: {
        label: 'Expense Tracker',
        apiDomain: /searchupcdata\.com|searchupcdata|searchupc/i,
        apiLabel: 'searchupcdata.com',
        extractFields: /\b(productName|product_name|category|price|ean|upc)\b/i,
        extractLabel: 'productName, category, price, ean/upc',
        renderFields: /\$\{.*\b(name|product|category|price)\b[^}]*\}/i
    },
    C: {
        label: 'Grocery List',
        apiDomain: /openfoodfacts\.org|openfoodfacts|open\s*food\s*facts/i,
        apiLabel: 'openfoodfacts.org',
        extractFields: /\b(brand|product_name|product|thumbnail|nutriscore|nutri_grade|nutri)\b/i,
        extractLabel: 'brand, product_name, thumbnail, nutriscore',
        renderFields: /\$\{.*\b(brand|thumbnail|nutri|product)\b[^}]*\}/i
    }
};

// Generic code patterns
const FETCH_CALL = /fetch\s*\(/;
const FETCH_URL = /fetch\s*\(\s*["'`][^"'`]*(?:api\.|\.com\/|\.org\/|\.net\/|\.io\/)[^"'`]*["'`]/i;
const JSON_PARSE = /\.json\s*\(\s*\)/;
const LOCAL_STORAGE = /localStorage/;
const LIT_HTML = /html\s*`/;

/**
 * Read a file's contents, returning empty string on any error.
 */
function readFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return '';
    }
}

/**
 * Search all JS files for a regex match in file contents.
 * Returns an array of filenames (basename only) where the pattern was found.
 */
function findInFiles(jsFiles, regex) {
    const matches = [];
    for (const filePath of jsFiles) {
        const content = readFile(filePath);
        if (regex.test(content)) {
            matches.push(path.basename(filePath));
        }
    }
    return matches;
}

/**
 * Main analyzer entry point.
 * @param {string[]} jsFiles — array of .js file paths
 * @param {object} analysis — current analysis object
 * @param {object} config — lab config
 * @param {object} student — student object with codeReview, etc.
 */
/**
 * Auto-detect which version the student implemented by scanning for
 * version-specific API domains. Returns the version key (A/B/C) with
 * the most file matches, or null if none found.
 */
function detectVersion(jsFiles) {
    let best = null;
    let bestCount = 0;
    for (const [key, v] of Object.entries(VERSIONS)) {
        const count = findInFiles(jsFiles, v.apiDomain).length;
        if (count > bestCount) {
            bestCount = count;
            best = key;
        }
    }
    return best;
}

export default function (jsFiles, analysis, config, student) {
    const group = (student.codeReview && student.codeReview.group) || null;
    let version = VERSIONS[group] || null;

    // If group is unknown, try to auto-detect from code
    if (!version) {
        const detected = detectVersion(jsFiles);
        if (detected) {
            version = VERSIONS[detected];
        }
    }

    const steps = [];

    // Step 1: API domain referenced
    if (version) {
        const apiFiles = findInFiles(jsFiles, version.apiDomain);
        const extFetchFiles = findInFiles(jsFiles, FETCH_URL);
        const allApiFiles = [...new Set([...apiFiles, ...extFetchFiles])];
        steps.push({
            step: 1,
            name: `API called (${version.apiLabel})`,
            found: apiFiles.length > 0 || extFetchFiles.length > 0,
            evidence: allApiFiles
        });
    } else {
        // No version detected — check all API patterns
        const anyApiRe = /linkpreview\.net|searchupcdata\.com|openfoodfacts\.org|openfoodfacts/i;
        const apiFiles = findInFiles(jsFiles, anyApiRe);
        const extFetchFiles = findInFiles(jsFiles, FETCH_URL);
        const allApiFiles = [...new Set([...apiFiles, ...extFetchFiles])];
        steps.push({
            step: 1,
            name: 'API domain referenced',
            found: allApiFiles.length > 0,
            evidence: allApiFiles
        });
    }

    // Step 2: JSON response parsed
    const jsonFiles = findInFiles(jsFiles, JSON_PARSE);
    steps.push({
        step: 2,
        name: 'fetch response parsed (.json())',
        found: jsonFiles.length > 0,
        evidence: jsonFiles
    });

    // Step 3: Response fields extracted
    if (version) {
        const extractFiles = findInFiles(jsFiles, version.extractFields);
        steps.push({
            step: 3,
            name: `Fields extracted — ${version.extractLabel}`,
            found: extractFiles.length > 0,
            evidence: extractFiles
        });
    } else {
        const allFieldRes = Object.values(VERSIONS).map(v => v.extractFields.source).join('|');
        const anyFields = new RegExp(allFieldRes, 'i');
        const fieldFiles = findInFiles(jsFiles, anyFields);
        steps.push({
            step: 3,
            name: 'Response fields extracted',
            found: fieldFiles.length > 0,
            evidence: fieldFiles
        });
    }

    // Step 4: Data saved to localStorage
    const storageFiles = findInFiles(jsFiles, LOCAL_STORAGE);
    steps.push({
        step: 4,
        name: 'Data saved to localStorage',
        found: storageFiles.length > 0,
        evidence: storageFiles
    });

    // Step 5: API data rendered in lit-html
    const litFiles = findInFiles(jsFiles, LIT_HTML);
    if (version && version.renderFields) {
        const renderFiles = findInFiles(jsFiles, version.renderFields);
        const found = renderFiles.length > 0;
        steps.push({
            step: 5,
            name: 'API data rendered in lit-html',
            found,
            evidence: found ? renderFiles : (litFiles.length > 0 ? litFiles : [])
        });
    } else {
        steps.push({
            step: 5,
            name: 'API data rendered in lit-html',
            found: litFiles.length > 0,
            evidence: litFiles
        });
    }

    const completed = steps.filter(s => s.found).length;
    const versionLabel = version ? version.label : 'unknown';

    return {
        apiCompleteness: {
            version: versionLabel,
            group: group || '?',
            detected: !group || !VERSIONS[group],
            steps,
            completed,
            total: 5
        },
        // Formatted lines for the generic text-report renderer (analysis.reportSections).
        // Keeping the formatting here means generic code stays lab-agnostic.
        reportSections: [{
            title: `API Integration Pipeline (${versionLabel})`,
            lines: [
                ...steps.map(s => `[${s.found ? 'YES' : ' no'}]  Step ${s.step}: ${s.name}`),
                `${completed}/5 steps complete`
            ]
        }]
    };
};
