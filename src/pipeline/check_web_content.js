/**
 * check_web_content.js
 *
 * Checks each student's HTML/CSS files for required page content, driven by
 * config.webContent (the phase is skipped entirely when that block is absent):
 *
 *   - requiredElements: CSS-selector queries (jsdom querySelectorAll) summed
 *     across all .html/.htm files — "does the site contain a <figure> with an
 *     <img> in it", "is there a mailto link", etc.
 *   - requiredCssSelectors / requiredCssProperties: css-tree scans of external
 *     .css files, embedded <style> elements, and (properties only) inline
 *     style="" attributes. A required property may be a bare name ("grid-area")
 *     or a "property: value" pair ("display: grid").
 *   - fileCounts: minimum counts of files matching a filename regex (e.g. at
 *     least 4 HTML files).
 *
 * Attaches results as student.webContent; scored by the element_check,
 * css_selector_check, css_property_check, and file_count mapping types.
 */

import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';
import { parse as parseCss, walk as walkCss, generate as generateCss } from 'css-tree';
import { walk as walkDir, getAllFilesByExt, toPosix, DEFAULT_SKIP_DIRS } from '../lib/file_walker.js';
import { runPerStudentPhase, writePhaseReport } from '../lib/per_student_phase.js';
import { configForStudent } from '../lib/student_group.js';

const WEB_CONTENT_REPORT = 'web_content_report.json';

// Normalizes a selector or "prop: value" string for comparison: collapse all
// whitespace runs to a single space, trim, lowercase. Property strings then have
// the remaining spaces removed so "display: grid" == "display:grid".
function normalizeSelector(s) {
    return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}
function normalizeProperty(s) {
    return String(s).replace(/\s+/g, '').toLowerCase();
}

// Parses CSS text, collecting normalized rule selectors (each comma-separated
// selector individually) into `selectors` and normalized declarations (both the
// bare property name and "prop:value") into `properties`. Parse failures are
// tolerated — students submit broken CSS; the validators report that separately.
function collectFromCss(cssText, selectors, properties) {
    let ast;
    try {
        ast = parseCss(cssText, { onParseError: () => {} });
    } catch {
        return;
    }
    walkCss(ast, (node) => {
        if (node.type === 'Rule' && node.prelude) {
            let preludeText;
            try {
                preludeText = generateCss(node.prelude);
            } catch {
                return;
            }
            for (const sel of preludeText.split(',')) {
                selectors.add(normalizeSelector(sel));
            }
        } else if (node.type === 'Declaration') {
            let value = '';
            try {
                value = generateCss(node.value);
            } catch { /* keep bare property */ }
            properties.add(normalizeProperty(node.property));
            if (value) properties.add(normalizeProperty(`${node.property}:${value}`));
        }
    });
}

// Collects declarations from an inline style="" attribute (properties only —
// inline styles have no selectors).
function collectFromInlineStyle(styleText, properties) {
    try {
        const ast = parseCss(styleText, { context: 'declarationList', onParseError: () => {} });
        walkCss(ast, (node) => {
            if (node.type === 'Declaration') {
                let value = '';
                try {
                    value = generateCss(node.value);
                } catch { /* keep bare property */ }
                properties.add(normalizeProperty(node.property));
                if (value) properties.add(normalizeProperty(`${node.property}:${value}`));
            }
        });
    } catch { /* unparseable inline style — ignore */ }
}

/**
 * Runs all configured web-content checks against one extracted submission dir.
 * Exported for direct unit testing.
 */
function checkWebContent(extractedDir, webConfig, exclusions = []) {
    const htmlFiles = getAllFilesByExt(extractedDir, ['.html', '.htm'], exclusions);
    const cssFiles = getAllFilesByExt(extractedDir, '.css', exclusions);

    // --- Gather CSS corpus: external files + embedded <style> + inline style="" ---
    const foundSelectors = new Set();
    const foundProperties = new Set();
    let rawCssText = ''; // substring fallback, matching the old checker's behavior

    for (const file of cssFiles) {
        let source;
        try {
            source = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        rawCssText += source + '\n';
        collectFromCss(source, foundSelectors, foundProperties);
    }

    // --- Element checks (and embedded/inline CSS extraction) per HTML file ---
    const required = (webConfig.requiredElements || []).map(entry => ({
        id: entry.id || entry.selector,
        selector: entry.selector,
        description: entry.description || '',
        minCount: entry.minCount || 1,
        dirPattern: entry.dirPattern ? new RegExp(entry.dirPattern, 'i') : null,
        count: 0,
        files: [],
        error: null
    }));

    for (const file of htmlFiles) {
        let source;
        try {
            source = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        let dom;
        try {
            dom = new JSDOM(source);
        } catch {
            continue; // grossly malformed markup; validation phase reports it
        }
        const doc = dom.window.document;
        const relPath = toPosix(path.relative(extractedDir, file));

        for (const entry of required) {
            if (entry.dirPattern && !entry.dirPattern.test(relPath)) continue;
            try {
                const matches = doc.querySelectorAll(entry.selector);
                if (matches.length > 0) {
                    entry.count += matches.length;
                    entry.files.push(relPath);
                }
            } catch {
                entry.error = `Invalid selector: ${entry.selector}`;
            }
        }

        for (const styleEl of doc.querySelectorAll('style')) {
            rawCssText += styleEl.textContent + '\n';
            collectFromCss(styleEl.textContent, foundSelectors, foundProperties);
        }
        for (const el of doc.querySelectorAll('[style]')) {
            collectFromInlineStyle(el.getAttribute('style') || '', foundProperties);
        }
    }

    const elements = required.map(e => ({
        id: e.id,
        selector: e.selector,
        description: e.description,
        minCount: e.minCount,
        count: e.count,
        passed: !e.error && e.count >= e.minCount,
        files: e.files,
        ...(e.error ? { error: e.error } : {})
    }));

    // --- Required CSS selectors: normalized rule match, raw-substring fallback ---
    const cssSelectors = (webConfig.requiredCssSelectors || []).map(sel => ({
        selector: sel,
        found: foundSelectors.has(normalizeSelector(sel)) || rawCssText.includes(sel)
    }));

    // --- Required CSS properties: bare name or "prop: value" pair ---
    const cssProperties = (webConfig.requiredCssProperties || []).map(prop => ({
        property: prop,
        found: foundProperties.has(normalizeProperty(prop))
    }));

    // --- File counts: every file name in the submission vs. a pattern ---
    const fileCounts = (webConfig.fileCounts || []).map(fc => ({
        id: fc.id,
        pattern: fc.pattern,
        min: fc.min || 1,
        count: 0
    }));
    if (fileCounts.length > 0) {
        const patterns = fileCounts.map(fc => new RegExp(fc.pattern, 'i'));
        walkDir(extractedDir, {
            // Build output left behind by a runtime-check build step (node_modules/dist/
            // build) must not inflate a file-count check — same skip list validate_html.js
            // and validate_css.js use.
            shouldDescend: (full, name) => !name.startsWith('.') && !DEFAULT_SKIP_DIRS.has(name),
            onFile: (filePath) => {
                if (exclusions.some(ex => toPosix(filePath).includes(toPosix(ex)))) return;
                const base = path.basename(filePath);
                fileCounts.forEach((fc, i) => {
                    if (patterns[i].test(base)) fc.count++;
                });
            }
        });
    }
    for (const fc of fileCounts) fc.passed = fc.count >= fc.min;

    return {
        htmlFiles: htmlFiles.length,
        cssFiles: cssFiles.length,
        elements,
        cssSelectors,
        cssProperties,
        fileCounts
    };
}

// A fresh object per call — NOT a shared constant. Spreading one shared object's nested
// arrays (`{...EMPTY_RESULT}`) still hands every skipped student the SAME elements/
// cssSelectors/etc. array references; one downstream mutation would then corrupt every
// other skipped student's result.
const emptyResult = () => ({ htmlFiles: 0, cssFiles: 0, elements: [], cssSelectors: [], cssProperties: [], fileCounts: [] });

export default async function(students, config, labDir) {
    // Per student: a lab group may override webContent (config.variations[group].overrides).
    const settingsFor = student => {
        const sc = configForStudent(config, student);
        const webConfig = sc.webContent || {};
        const exclusions = webConfig.exclude || (sc.validate && sc.validate.exclude) || [];
        return { webConfig, exclusions };
    };

    await runPerStudentPhase(students, {
        name: 'Web Content Check Phase',
        attachKey: 'webContent',
        noCodeResult: emptyResult,
        errorResult: (e) => ({ ...emptyResult(), error: e.message }),
        checkStudent: (student) => {
            const { webConfig, exclusions } = settingsFor(student);
            const result = checkWebContent(student.extractedDir, webConfig, exclusions);
            const elPassed = result.elements.filter(e => e.passed).length;
            const selPassed = result.cssSelectors.filter(s => s.found).length;
            const propPassed = result.cssProperties.filter(p => p.found).length;
            console.log(`  ${student.name}: elements ${elPassed}/${result.elements.length}, ` +
                `selectors ${selPassed}/${result.cssSelectors.length}, ` +
                `properties ${propPassed}/${result.cssProperties.length}`);
            return result;
        }
    });

    writePhaseReport(labDir, WEB_CONTENT_REPORT, students, s => ({ student: s.name, ...(s.webContent || emptyResult()) }));
}

export { checkWebContent, normalizeSelector, normalizeProperty };
