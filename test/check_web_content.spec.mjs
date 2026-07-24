/**
 * check_web_content.spec.mjs
 *
 * Tests the web-content check phase (required HTML elements via CSS-selector queries,
 * required CSS selectors/properties across external/embedded/inline styles, file-count
 * minimums) and the four mapping handlers that score its results. Also validates the
 * shipped CIS195 lab configs against validateConfig.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

import { checkWebContent, normalizeSelector, normalizeProperty } from '../src/pipeline/check_web_content.js';
import { getHandler } from '../src/pipeline/generate_grades.js';
import { validateConfig } from '../src/lib/config_validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── fixture ──────────────────────────────────────────────────────────────────
// A small two-page site exercising every corner the phase must handle.
let dir;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'webcontent_test_'));

    writeFileSync(join(dir, 'index.html'), `<!DOCTYPE html>
<html><head><title>Home</title><!-- header comment -->
<link rel="stylesheet" href="styles.css">
<style>nav a { color: red; } h1, h2 { margin: 0; }</style>
</head>
<body style="background-color: ivory">
<figure><img src="cat.jpg" alt="a cat"><figcaption>Cat</figcaption></figure>
<ol><li>one<ul><li>nested</li></ul></li></ol>
<a href="mailto:someone@example.com">mail</a>
</body></html>`);

    mkdirSync(join(dir, 'part2'));
    writeFileSync(join(dir, 'part2', 'map.html'), `<!DOCTYPE html>
<html><head><title>Map page</title></head><body>
<img src="plan.png" usemap="#plan" alt="plan">
<map name="plan"><area shape="rect" coords="0,0,1,1" href="a.html" alt="a"></map>
</body></html>`);

    writeFileSync(join(dir, 'styles.css'),
        'header, footer { display:grid; grid-template-areas: "a b"; }\n' +
        '.card { display: FLEX; flex-direction: column; }\n');

    // An excluded dir holding decoys that must never be counted.
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'decoy.html'), '<html><head><title>x</title></head></html>');
    writeFileSync(join(dir, 'node_modules', 'decoy.css'), 'body { zzz: 1; }');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ── normalizers ──────────────────────────────────────────────────────────────
describe('normalizers', () => {
    it('normalizeSelector collapses whitespace and lowercases', () => {
        expect(normalizeSelector('  Figure  >  IMG ')).toBe('figure > img');
    });
    it('normalizeProperty strips all whitespace and lowercases', () => {
        expect(normalizeProperty('Display: Grid')).toBe('display:grid');
    });
});

// ── element checks ───────────────────────────────────────────────────────────
describe('checkWebContent: required elements', () => {
    it('sums selector matches across all HTML files and honors minCount', () => {
        const r = checkWebContent(dir, {
            requiredElements: [
                { id: 'titles', selector: 'title', minCount: 2 },
                { id: 'figcaption', selector: 'figure > figcaption' },
                { id: 'mailto', selector: "a[href^='mailto']" },
                { id: 'usemap', selector: 'img[usemap]' },
                { id: 'area', selector: 'map > area[shape]' },
                { id: 'nested', selector: ':is(ol ol), :is(ol ul), :is(ul ol), :is(ul ul)' },
                { id: 'absent', selector: 'blockquote' },
                { id: 'needs3', selector: 'figure', minCount: 3 },
            ],
        }, ['node_modules']);

        const by = Object.fromEntries(r.elements.map(e => [e.id, e]));
        expect(r.htmlFiles).toBe(2);
        expect(by.titles.count).toBe(2);
        expect(by.titles.passed).toBe(true);
        expect(by.figcaption.passed).toBe(true);
        expect(by.mailto.passed).toBe(true);
        expect(by.usemap.passed).toBe(true);
        expect(by.area.passed).toBe(true);
        expect(by.nested.passed).toBe(true);
        expect(by.absent.passed).toBe(false);
        expect(by.absent.count).toBe(0);
        expect(by.needs3.passed).toBe(false); // only 1 figure, needs 3
    });

    it('records which files matched', () => {
        const r = checkWebContent(dir, { requiredElements: [{ id: 't', selector: 'title' }] }, []);
        expect(r.elements[0].files.some(f => f.includes('index.html'))).toBe(true);
        expect(r.elements[0].files.some(f => f.includes('map.html'))).toBe(true);
    });

    it('dirPattern restricts an entry to matching paths', () => {
        const r = checkWebContent(dir, {
            requiredElements: [
                { id: 'p2_title', selector: 'title', dirPattern: 'part2' },
                { id: 'p2_figure', selector: 'figure', dirPattern: 'part2' },
            ],
        }, []);
        const by = Object.fromEntries(r.elements.map(e => [e.id, e]));
        expect(by.p2_title.count).toBe(1);       // only map.html searched
        expect(by.p2_figure.passed).toBe(false); // figure only exists outside part2
    });

    it('flags an invalid selector as an error instead of throwing', () => {
        const r = checkWebContent(dir, { requiredElements: [{ id: 'bad', selector: ':::nope' }] }, []);
        expect(r.elements[0].passed).toBe(false);
        expect(r.elements[0].error).toMatch(/Invalid selector/);
    });

    it('defaults id to the selector string', () => {
        const r = checkWebContent(dir, { requiredElements: [{ selector: 'title' }] }, []);
        expect(r.elements[0].id).toBe('title');
    });
});

// ── CSS selector / property checks ──────────────────────────────────────────
describe('checkWebContent: required CSS selectors and properties', () => {
    it('finds selectors in external CSS, splitting comma lists', () => {
        const r = checkWebContent(dir, { requiredCssSelectors: ['header', 'footer', '.card', 'aside'] }, ['node_modules']);
        const by = Object.fromEntries(r.cssSelectors.map(s => [s.selector, s.found]));
        expect(by.header).toBe(true);   // from "header, footer" comma list
        expect(by.footer).toBe(true);
        expect(by['.card']).toBe(true);
        expect(by.aside).toBe(false);
    });

    it('finds selectors in embedded <style> elements', () => {
        const r = checkWebContent(dir, { requiredCssSelectors: ['nav a', 'h2'] }, []);
        expect(r.cssSelectors.every(s => s.found)).toBe(true);
    });

    it('matches properties as bare names or normalized prop:value pairs', () => {
        const r = checkWebContent(dir, {
            requiredCssProperties: [
                'grid-template-areas',   // bare name, external css
                'display: grid',         // written "display:grid" in the file
                'display: flex',         // written "display: FLEX" — case-insensitive
                'flex-direction',
                'margin',                // embedded <style>
                'background-color: ivory', // inline style attribute
                'position',              // never used
            ],
        }, ['node_modules']);
        const by = Object.fromEntries(r.cssProperties.map(p => [p.property, p.found]));
        expect(by['grid-template-areas']).toBe(true);
        expect(by['display: grid']).toBe(true);
        expect(by['display: flex']).toBe(true);
        expect(by['flex-direction']).toBe(true);
        expect(by.margin).toBe(true);
        expect(by['background-color: ivory']).toBe(true);
        expect(by.position).toBe(false);
    });
});

// ── file counts / exclusions / empty dirs ────────────────────────────────────
describe('checkWebContent: file counts and exclusions', () => {
    it('counts files by pattern, honoring min and exclusions', () => {
        const r = checkWebContent(dir, {
            fileCounts: [
                { id: 'html', pattern: '\\.html?$', min: 2 },
                { id: 'css', pattern: '\\.css$', min: 2 },
            ],
        }, ['node_modules']);
        const by = Object.fromEntries(r.fileCounts.map(f => [f.id, f]));
        expect(by.html.count).toBe(2);   // decoy.html excluded
        expect(by.html.passed).toBe(true);
        expect(by.css.count).toBe(1);    // decoy.css excluded
        expect(by.css.passed).toBe(false);
    });

    it('excludes decoy files from element and CSS scans too', () => {
        const r = checkWebContent(dir, {
            requiredElements: [{ id: 't', selector: 'title', minCount: 3 }],
            requiredCssProperties: ['zzz'],
        }, ['node_modules']);
        expect(r.elements[0].count).toBe(2);            // not 3 — decoy.html skipped
        expect(r.cssProperties[0].found).toBe(false);   // decoy.css skipped
    });
});

// ── mapping handlers ─────────────────────────────────────────────────────────
describe('web content mapping handlers', () => {
    const webContent = {
        htmlFiles: 2,
        cssFiles: 1,
        elements: [
            { id: 'a', selector: 'title', description: 'page title', minCount: 1, count: 2, passed: true, files: [] },
            { id: 'b', selector: 'figure', minCount: 1, count: 0, passed: false, files: [] },
            { id: 'c', selector: 'table', minCount: 1, count: 1, passed: true, files: [] },
            { id: 'd', selector: 'nav', minCount: 1, count: 0, passed: false, files: [] },
        ],
        cssSelectors: [
            { selector: 'header', found: true },
            { selector: 'footer', found: false },
        ],
        cssProperties: [
            { property: 'display: grid', found: true },
            { property: 'grid-area', found: true },
            { property: 'flex-direction', found: false },
        ],
        fileCounts: [
            { id: 'html', pattern: '\\.html?$', min: 4, count: 5, passed: true },
            { id: 'css', pattern: '\\.css$', min: 2, count: 1, passed: false },
        ],
    };
    const student = { name: 'Test Student', webContent };

    it('element_check scores proportionally and lists missing selectors', async () => {
        const result = await getHandler('element_check')({ type: 'element_check', maxScore: 4 }, student);
        expect(result.score).toBe(2);
        expect(result.comment).toMatch(/2\/4 required elements/);
        expect(result.comment).toMatch(/figure/);
        expect(result.comment).toMatch(/nav/);
        expect(result.keepComment).toBe(true);
    });

    it('element_check gives full credit (no keepComment) when everything passes', async () => {
        const result = await getHandler('element_check')(
            { type: 'element_check', maxScore: 2, ids: ['a', 'c'] }, student);
        expect(result.score).toBe(2);
        expect(result.comment).toMatch(/All 2 required elements found/);
    });

    it('element_check accepts ids as a comma-separated string (wizard format)', async () => {
        const result = await getHandler('element_check')(
            { type: 'element_check', maxScore: 2, ids: 'a, c' }, student);
        expect(result.score).toBe(2);
    });

    it('css_selector_check scores its entries with an optional filter', async () => {
        const all = await getHandler('css_selector_check')({ type: 'css_selector_check', maxScore: 2 }, student);
        expect(all.score).toBe(1);
        expect(all.comment).toMatch(/footer/);
        const filtered = await getHandler('css_selector_check')(
            { type: 'css_selector_check', maxScore: 2, selectors: ['header'] }, student);
        expect(filtered.score).toBe(2);
    });

    it('css_property_check scores its entries with an optional filter', async () => {
        const all = await getHandler('css_property_check')({ type: 'css_property_check', maxScore: 3 }, student);
        expect(all.score).toBe(2);
        expect(all.comment).toMatch(/flex-direction/);
        const filtered = await getHandler('css_property_check')(
            { type: 'css_property_check', maxScore: 3, properties: ['display: grid', 'grid-area'] }, student);
        expect(filtered.score).toBe(3);
    });

    it('file_count is all-or-nothing per counter', async () => {
        const ok = await getHandler('file_count')({ type: 'file_count', countId: 'html', maxScore: 1 }, student);
        expect(ok.score).toBe(1);
        const short = await getHandler('file_count')({ type: 'file_count', countId: 'css', maxScore: 1 }, student);
        expect(short.score).toBe(0);
        expect(short.comment).toMatch(/Found 1 file\(s\).*expected 2/);
        expect(short.keepComment).toBe(true);
    });

    it('file_count flags an unknown countId for manual review', async () => {
        const result = await getHandler('file_count')({ type: 'file_count', countId: 'nope', maxScore: 1 }, student);
        expect(result.score).toBe(0);
        expect(result.comment).toMatch(/no fileCounts entry with id "nope"/);
    });

    it('all four handlers flag missing webContent data for manual review', async () => {
        for (const type of ['element_check', 'css_selector_check', 'css_property_check', 'file_count']) {
            const result = await getHandler(type)({ type, maxScore: 1 }, { name: 'X' });
            expect(result.score, type).toBe(0);
            expect(result.comment, type).toMatch(/NEEDS MANUAL CHECK/);
        }
    });

    it('element_check reports an unconfigured (empty) entry list distinctly', async () => {
        const result = await getHandler('element_check')(
            { type: 'element_check', maxScore: 1 }, { name: 'X', webContent: { elements: [] } });
        expect(result.score).toBe(0);
        expect(result.comment).toMatch(/No required elements configured/);
    });
});

// ── shipped CIS195 configs ───────────────────────────────────────────────────
describe('shipped CIS195 lab configs', () => {
    const cis195Dir = join(__dirname, '..', 'configs', 'CIS195');

    it('exist for all eight converted labs', () => {
        const expected = ['Lab01', 'Lab02', 'Lab03', 'Lab04', 'Lab06', 'Lab07', 'Lab08', 'TermProject'];
        for (const lab of expected) {
            const cfg = join(cis195Dir, lab, `${lab.toLowerCase()}_config.json`);
            expect(existsSync(cfg), cfg).toBe(true);
        }
    });

    it('all parse and pass validateConfig', () => {
        for (const lab of readdirSync(cis195Dir)) {
            const cfgPath = join(cis195Dir, lab, `${lab.toLowerCase()}_config.json`);
            if (!existsSync(cfgPath)) continue;
            const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
            expect(() => validateConfig(config, lab), lab).not.toThrow();
            expect(config.textReport, `${lab} textReport`).toBe(true);
            expect(config.runtimeCheck, `${lab} runtimeCheck`).toBe('none');
        }
    });
});
