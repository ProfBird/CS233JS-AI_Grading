# CIS 195 Integration — Implementation Steps

Integrate the evaluation capabilities of the older **GradingAssistant** app
(`D:\Repos\GradingAssistant` — the CIS 195 Web Authoring HTML/CSS grader) into this
grading system, and add **CIS195** as a new course with converted lab configs.

This document is the implementation spec. It is written so that any developer (or
model) can execute it without access to the planning conversation.

**Decisions already made (by the instructor):**

- Every automated check gets a nominal **`maxScore: 1`** (point values adjustable later in config JSON).
- CIS195 labs are **text-report labs by default** via a new per-lab `"textReport": true` config key (no rubric `.xlsm` exists for CIS195; no `--text-report` flag should be needed).
- The old app's **JsChecker** (Mocha instructor-test runner, built for CS133JS, unfinished) is **not** ported.
- Convert exactly the **eight labs** that have requirement CSVs: Lab01–Lab04, Lab06–Lab08, TermProject. (No Lab05 CSV exists anywhere.)

**Current status: ALL STEPS IMPLEMENTED.** This document now serves as the record of
what was built and why. Highlights of the as-built implementation:

- `jsdom` + `css-tree` dependencies; `src/pipeline/check_web_content.js` phase (gated on
  `config.webContent` in `run_pipeline.js`'s `PHASES`); `"none"` runtime strategy;
  `element_check` / `css_selector_check` / `css_property_check` / `file_count` handlers +
  wizard metadata; `textReport` config key; nine `configs/CIS195/**` files;
  `test/check_web_content.spec.mjs` plus additions to `config_validation.spec.mjs` and
  `run_pipeline.spec.mjs`; CLAUDE.md / USER_GUIDE / DEVELOPER_GUIDE / README updates.
- One deviation from the spec below: the subset-filter fields (`ids`/`selectors`/
  `properties`) accept an array **or** a comma-separated string (the wizard's field
  prompts produce strings — same convention as `scripts_check.scripts`).
- Phase output verified against real Summer-23 submissions (see §12) — the new
  `_Grade.txt` findings agree with the old grader's `_report.txt` answer keys.

---

## 1. Background: what the old grader can do (gap analysis)

The old app reads a per-lab requirements CSV, walks each `StudentName_file/` folder, and
writes a per-student `_report.txt`. Its check types, and their status in this system:

| Old capability | Old mechanism | Status here |
|---|---|---|
| Required HTML elements by CSS selector (`figure > img`, `a[href^='mailto']`, `:is(ol ol)`, …) | JSDOM `querySelectorAll` over every `.html` file | **GAP → new `webContent.requiredElements` + `element_check` mapping** |
| Required CSS selectors (external `.css` + embedded `<style>`) | css-tree walk + substring match | **GAP → `webContent.requiredCssSelectors` + `css_selector_check`** |
| Required CSS properties, bare `prop` or `prop: value` (external + embedded + inline `style=""`) | css-tree walk + whitespace-stripped substring | **GAP → `webContent.requiredCssProperties` + `css_property_check`** |
| Minimum HTML/CSS file counts | file counting | **GAP → `webContent.fileCounts` + `file_count` mapping** |
| HTML validation | W3C online validator (network) | ✔ already covered, better: offline `validate_html.js` + `html_validate` mapping |
| CSS validation | W3C online validator (network) | ✔ already covered: offline `validate_css.js` + `css_validate` mapping |
| Regex searches with descriptions (comment in `<head>`, `&copy;`, external/internal links) | `RegExp.test` per file | ✔ already covered: `analysis.features` + `feature` mappings (HTML files are not comment-stripped, so `<!--` patterns work) |
| Special file name required (e.g. `index`) | filename substring | ✔ already covered: `path_exists` mapping |
| Two-part element sets (`requiredElements1`/`requiredElements2`) | per-part loop — **note: the old tool searched ALL files for both parts**, it never actually scoped by subfolder | ✔ expressible: one `element_check` mapping per part using the `ids` filter |
| Per-student text report | `_report.txt` | ✔ `--text-report` exists → make it config-default via new `textReport` key (step 7) |
| Moodle bulk-download unzip (`UnzipFiles.mjs`, 7-zip shell-out) | separate program | ✔ `extract_code.js` handles raw Moodle export dirs + zips natively |
| CSS rule-count / unique-property-count minimums | inconsistent (old code indexed the wrong CSV columns) | **Dropped intentionally** — no lab CSV actually uses it; add later as a `css_stats` mapping only if ever needed |
| JsChecker: Mocha instructor tests vs. a named student `.js` file | mocha API + `TESTED_FILE` env var | **Skipped** per decision above; the adapter `runTests`/`test_check` machinery is the natural home if ever wanted |

Requirement CSV sources (authoritative, newest wins where duplicates exist):

- `D:\Repos\CIS195-CourseMaterials\LabAutoGrading\` — `Lab1Requirements.csv`, `CIS195Lab02GradeAssist.csv` (prefer over `Lab2Requirements.csv`/`CIS195Lab2Requirements.csv`), `CIS195Lab03GradeAssist.csv` (prefer over `Lab3Requirements.csv`), `Lab4Requirements.csv`, `Lab6Requirements.csv`, `Lab7Requirements.csv`, `Lab8Requirements.csv`, `TermProjectRequirements.csv`
- `D:\Repos\GradingAssistant\docs\` — `CIS195Lab06GradeAssist.csv` (prefer over `Lab6Requirements.csv`), `CIS195TermProjectGradeAssist.csv` (prefer over `TermProjectRequirements.csv`)

---

## 2. Step 1 — Dependencies ✅ DONE

`jsdom` (selector queries; parity with the old checker incl. `:is()`) and `css-tree`
(direct dep; previously only transitive via `csstree-validator`) are installed and in
`package.json`.

---

## 3. Step 2 — New pipeline phase `src/pipeline/check_web_content.js` ✅ DONE

Already written. Contract (for review / tests):

- Exports: default phase function `(students, config, labDir)`, plus `checkWebContent(extractedDir, webConfig, exclusions)`, `normalizeSelector`, `normalizeProperty` for unit tests.
- Driven by `config.webContent`:

```json
"webContent": {
  "requiredElements": [
    { "id": "figureImg", "selector": "figure > img", "minCount": 1,
      "description": "Image inside a figure", "dirPattern": "optional-path-regex" }
  ],
  "requiredCssSelectors": ["nav", "header"],
  "requiredCssProperties": ["grid-area", "display: grid"],
  "fileCounts": [ { "id": "html", "pattern": "\\.html?$", "min": 4 } ],
  "exclude": ["node_modules"]
}
```

- **Elements**: each `.html`/`.htm` file (via `getAllFilesByExt`) is parsed with jsdom;
  `querySelectorAll(selector)` counts are summed across files; entry passes when total
  ≥ `minCount` (default 1). `id` defaults to the selector string. An invalid selector
  sets `error` on the entry and fails it (never crashes). Optional `dirPattern` regex
  filters which files (by path relative to the extracted dir) an entry is checked in.
- **CSS corpus**: external `.css` files (css-tree AST), embedded `<style>` elements,
  and inline `style=""` attributes (properties only). A required property matches as a
  bare name (`grid-area`) or a normalized `prop:value` pair (`display: grid` ≡
  `display:grid`). A required selector matches when any rule's comma-separated selector
  list contains it (whitespace-normalized, case-insensitive), with a raw-text substring
  fallback (the old checker's external-file behavior). Unparseable CSS is tolerated
  (the validation phase reports syntax separately).
- **File counts**: `pattern` is a case-insensitive regex tested against each file's
  basename over the whole submission tree (`walk` from `file_walker.js`, honoring
  `exclude` substrings; `exclude` falls back to `config.validate.exclude`).
- Attaches `student.webContent = { htmlFiles, cssFiles, elements: [{id, selector, description, minCount, count, passed, files, error?}], cssSelectors: [{selector, found}], cssProperties: [{property, found}], fileCounts: [{id, pattern, min, count, passed}] }`.
  Students with no `extractedDir` get an all-empty result object.
- Writes `Artifacts/web_content_report.json` (same pattern as the other phase reports).

**Remaining wiring for this step** — register the phase in
`src/pipeline/run_pipeline.js`'s `PHASES` array (after `checkNames`):

```js
{
    name: 'checkWebContent',
    run: (students, config, dirs) => checkWebContent(students, config, dirs.artifactsDir),
    when: (config) => !!config.webContent,
},
```

(This is the first phase to use a real `when` gate — the array was designed for it.)

---

## 4. Step 3 — `"none"` runtime strategy

In `src/pipeline/runtime_check.js`, register a built-in no-op strategy alongside
`browser`/`build`/`both`/`run_check`:

```js
registerCheckStrategy('none', async () => ({ success: true, skipped: true, errors: [] }));
```

Match the exact result shape the other strategies attach to `student.runtimeCheck`
(read a neighboring strategy first). Purpose: `runtimeCheck` is a required config key,
and CIS195's static multi-page sites need neither a build nor a Puppeteer pass.
`VALID_RUNTIME_MODES` picks the name up automatically, so `validateConfig` accepts it
with no change. The phase should log that the runtime check was skipped.

---

## 5. Step 4 — Four new mapping handlers in `src/pipeline/generate_grades.js`

Register with `registerHandler` (same style as the `html_validate`/`name_check`
handlers around line 285). All read `student.webContent`; if it's absent (phase didn't
run), return `{ score: 0, comment: 'No web content check data (config.webContent missing?)' }`.

1. **`element_check`** — optional `ids: []` mapping field selects a subset of
   `webContent.elements` (default: all). Let `passed` = entries with `.passed`,
   `total` = entries checked. Score `Math.round(map.maxScore * passed / total)`
   (`total === 0` → score 0, comment "No required elements configured"). Comment: all
   passed → `All ${total} required elements found`; otherwise list up to 5 missing
   selectors (append the entry's `description` in parens when present, and note
   `(optional)` entries — see per-lab notes) and set `keepComment: true` so
   `stockComments.zero` never masks the diagnostic.
2. **`css_selector_check`** — optional `selectors: []` filter over
   `webContent.cssSelectors`. Same proportional scoring/comment/`keepComment` pattern
   ("Missing selectors: nav, footer").
3. **`css_property_check`** — optional `properties: []` filter over
   `webContent.cssProperties`. Same pattern.
4. **`file_count`** — required `countId` field referencing a `webContent.fileCounts`
   entry id. Full `maxScore` when `count >= min`, else 0 with comment
   `Found ${count} file(s) matching ${pattern}, expected ${min}` and `keepComment: true`.
   Unknown `countId` → score 0, comment naming the bad id.

Also add cases to `mappingDescription()` (same file, ~line 700) — these become the
text-report row labels:

```js
case 'element_check':      return map.description || 'Required HTML elements present';
case 'css_selector_check': return map.description || 'Required CSS selectors used';
case 'css_property_check': return map.description || 'Required CSS properties used';
case 'file_count':         return map.description || `File count: ${map.countId || ''}`;
```

(If `mappingDescription` already honors a generic `map.description`/`map.desc` field,
follow the existing convention instead of inventing a second one — check the `feature`
case first.)

---

## 6. Step 5 — Wizard metadata in `src/lib/lab_config.js`

`test/generate_grades.spec.mjs` has a "mapping-type lists stay in sync" test that fails
unless `MAPPING_TYPES` (and `MAPPING_TYPE_SCHEMA`) cover every registered handler type.

Add to `MAPPING_TYPES` (~line 351):

```js
{ label: 'element_check',      value: 'element_check',      desc: 'Required HTML elements (CSS selector queries) found in student pages' },
{ label: 'css_selector_check', value: 'css_selector_check', desc: 'Required CSS selectors present in external or embedded styles' },
{ label: 'css_property_check', value: 'css_property_check', desc: 'Required CSS properties (or property: value pairs) used anywhere' },
{ label: 'file_count',         value: 'file_count',         desc: 'Minimum number of files matching a name pattern (e.g. 4 HTML files)' },
```

Add matching `MAPPING_TYPE_SCHEMA` entries (mirror `html_validate`'s shape): each needs
at least `maxScore`; `element_check` gets an optional `ids` (string/comma list),
`css_selector_check` an optional `selectors`, `css_property_check` an optional
`properties`, `file_count` a required `countId` (string). Optionally extend
`guessMappingType()`: `/required (html )?(element|tag)/ → element_check`,
`/css selector/ → css_selector_check`, `/css propert/ → css_property_check`,
`/number of (html|css|.*files)/ → file_count`.

---

## 7. Step 6 — `config_validation.js`: `textReport` + `webContent` validation

In `validateConfig` (`src/lib/config_validation.js`):

- **Relax rubricName**: skip the `rubricName` required-check when
  `config.textReport === true` (keep everything else validating — do NOT early-return
  like `extractOnly`).
- **Validate `webContent`** when present:
  - `requiredElements` entries: must have a `selector` string; `minCount` if present must be a positive integer; duplicate resolved `id`s are an error.
  - `fileCounts` entries: must have `id` and `pattern`; `pattern` must compile as a RegExp; `min` positive integer.
  - `requiredCssSelectors`/`requiredCssProperties`: arrays of strings if present.
- **Cross-checks**: an `element_check`/`css_selector_check`/`css_property_check`/
  `file_count` mapping with no `config.webContent` block is a validation error; a
  `file_count` mapping whose `countId` doesn't match any `fileCounts[].id` is an error.

---

## 8. Step 7 — `bin/grade.js`: config-level `textReport`

Right after the lab config is loaded/merged (before the rubric-exists loop at
`bin/grade.js:745`), add:

```js
textReport = textReport || config.textReport === true;
```

The existing `else if (textReport)` branch in the rubric-missing loop then already
prints "Rubric not found, but text-report is set" and proceeds — but that loop indexes
`config.rubricName` into `path.join`, which throws if `rubricName` is absent. Guard it:
treat a missing/empty `config.rubricName` the same as "file not found" (i.e. skip the
`path.join` when `!config.rubricName`), so a rubric-less `textReport` config flows into
the same branch. Verify the summary label (`+TXT`, line ~812) still reflects the merged
value (it will if the reassignment happens before that line).

---

## 9. Step 8 — CIS195 course + eight lab configs

Create `configs/CIS195/course_config.json`:

```json
{
  "courseName": "CIS195",
  "courseCode": "CIS195",
  "rubricPrefix": "CIS195"
}
```

Create `configs/CIS195/{Lab01,Lab02,Lab03,Lab04,Lab06,Lab07,Lab08,TermProject}/` each
with `{labname_lower}_config.json` (e.g. `lab01_config.json`, `termproject_config.json`).

**Common skeleton for every CIS195 lab config** (order the mappings as listed):

```json
{
  "titleText": "CIS 195 Lab N: <short name>",
  "textReport": true,
  "runtimeCheck": "none",
  "webContent": { ... per-lab, see below ... },
  "analysis": { "features": [ ... per-lab regex checks, fileRegex "\\.html?$" ... ] },
  "mappings": [
    ...one or two element_check mappings (maxScore 1)...,
    ...css_selector_check / css_property_check if the lab has them (maxScore 1)...,
    ...one file_count mapping per fileCounts entry (maxScore 1)...,
    ...one path_exists mapping when an index file is required:
       { "type": "path_exists", "pathPattern": "index.htm", "maxScore": 1 }...,
    ...one feature mapping per analysis feature:
       { "type": "feature", "featureId": "<id>", "maxScore": 1 }...,
    { "type": "html_validate", "maxScore": 1, "tolerance": 3 },
    { "type": "css_validate",  "maxScore": 1, "tolerance": 3 },
    { "type": "name_check",    "maxScore": 1 }
  ]
}
```

No `rubricName`, no `cell`/`commentCell` (text reports don't need them). Skip
`css_validate` only if you prefer, but every CIS195 lab may legitimately have CSS from
Lab04 on; keeping it everywhere is fine (0 CSS files scores are handled by the handler).

### Per-lab requirement data (converted from the CSVs)

Shared regex features (JSON-escaped, use `fileRegex: "\\.html?$"`):

- `head_comment` — `"<head>[\\s\\S]*<!--"` (a comment inside/after `<head>`)
- `special_symbol` — `"&[a-zA-Z0-9]*;"` (an HTML character entity)
- `external_link` — `"<a\\s*href\\s*=\\s*[\"']http"`
- `internal_link` — `"<a\\s*href\\s*=\\s*[\"'](?!http)"`
- `copyright` — `"\\u00A9|&#169;|&#x000A9;|&copy;"`

**Lab01** (`Lab1Requirements.csv`) — title "Text and links".
- requiredElements (minCount in parens when >1): `title`; `h1, h2, h3, h4, h5, h6` (2); `a[href]` (2); `img[alt]`; `br`; `ol > li` (2); `ul > li`; `b, strong`; `i, em`
  (the CSV's `I, em` is a typo for `i, em`)
- features: `external_link`, `internal_link`, `head_comment`
- fileCounts: html ≥ 2 (`"\\.html?$"`); path_exists `index.htm`

**Lab02** (`CIS195Lab02GradeAssist.csv`) — "Lists, quotes, figures".
- requiredElements: `title`; `a[href]`; `figure > img`; `figure > figcaption`; `img[alt]`; `hr`; `blockquote`; `li`; `:is(ol ol), :is(ol ul), :is(ul ol), :is(ul ul)` (nested list — one selector string, id it `nested_list`)
- features: `head_comment`, `special_symbol`
- fileCounts: html ≥ 4; path_exists `index.htm`

**Lab03** (`CIS195Lab03GradeAssist.csv`) — "Links and image maps", two parts.
- requiredElements part 1 (ids `p1_*`): `title`; `nav a[href]`; `a[href^='#']`; `a[href] img`; `a[href^='mailto']`; `*[id]`
- requiredElements part 2 (ids `p2_*`): `img[usemap]`; `map[name]`; `map > area[shape]`; `area[href]`
- Two `element_check` mappings: `{ "ids": ["p1_..."], "description": "Part 1 required elements" }` and the `p2_*` twin. (No `dirPattern` — the old tool searched all files for both parts.)
- features: `head_comment`; fileCounts: html ≥ 5. No index-file requirement.

**Lab04** (`Lab4Requirements.csv`) — "Intro to CSS (inline, embedded, external)".
- requiredElements: `title`; `style`; `link[href][rel='stylesheet']`; `[style]`; `[id]`; `[class]`
- No features/fileCounts.

**Lab06** (`CIS195Lab06GradeAssist.csv`) — "Page layout (grid and flexbox)".
- requiredElements: `header`; `footer`; `title`; `a`; `link[href][rel='stylesheet']`
- requiredCssSelectors: `footer`, `nav`, `header` — the CSV marks these *optional*: keep them in a single `css_selector_check` mapping with `"description": "Layout selectors styled (footer/nav/header — optional in original rubric)"`.
- requiredCssProperties: `grid-template-areas`; `grid-area`; `display: grid`; `display: flex`; `flex-direction`; `align-items`; `justify-content` (last two were "optional" — same treatment: keep, note in the mapping description).
- features: `head_comment`; fileCounts: html ≥ 4, css ≥ 2; path_exists `index.htm`.

**Lab07** (`Lab7Requirements.csv`) — "Tables", two parts.
- requiredElements part 1 (ids `p1_*`): `title`; `table`; `tr`; `th`; `td`; `caption`; `td[rowspan]`; `td[colspan]`; `thead`; `tbody`; `tfoot`; `colgroup`; `col`
- Part 2 was the subset title/table/tr/th/td — searched across all files it adds no information beyond part 1, so **one** `element_check` mapping suffices (note this judgment call in the config's description or a JSON `_comment`-style key is NOT allowed — put it in this doc only).
- requiredCssProperties: `border`; `background-color`; `text-align` (CSV said bare `text`, which the old substring matcher would match against any `text-*` property; `text-align` is the Lab07 lesson's property — judgment call).

**Lab08** (`Lab8Requirements.csv`) — "Forms".
- requiredElements: `title`; `header`; `h1`; `input[name][id]`; `input[type='tel']`; `input[type='submit']`; `textarea`; `fieldset`; `legend`; `label[for]`; `footer`
- requiredCssProperties: `background-color`

**TermProject** (`CIS195TermProjectGradeAssist.csv`) — "Term Project web site".
- requiredElements: `head`; `title`; `link[href][rel='stylesheet']`; `style`; `body`; `header`; `h1`; `nav`; `a`; `figure`; `img`; `img[alt]`; `table`; `table th`; `section`; `article`; `footer`
- requiredCssSelectors (optional in original): `footer`; `nav`; `header`
- features: `head_comment`, `copyright`
- fileCounts: html ≥ 5, css ≥ 1; path_exists `index.htm`
- The CSV's "Validate HTML TRUE / Validate CSS TRUE" flags are simply the `html_validate`/`css_validate` mappings every lab already gets.

Student data layout (no code change; document in USER_GUIDE): Moodle downloads go to
`<term.labRoot>/CIS195/Lab01/…` with the standard raw Moodle export naming
(`StudentName_12345_assignsubmission_file/` containing zips, and/or
`…_assignsubmission_onlinetext/`). Graded output lands in
`<term.codeRoot>/CIS195/Lab01/{Artifacts,SubmissionsAndAssessment}/`.

---

## 10. Step 9 — Tests (vitest; mirror existing spec style)

- **`test/check_web_content.spec.mjs`** (new; build temp fixtures with `fs.mkdtempSync`
  like the other specs):
  - element counting summed across multiple HTML files; `minCount` honored
  - attribute/pseudo selectors: `img[alt]`, `a[href^='mailto']`, `:is(ol ol), :is(ol ul), :is(ul ol), :is(ul ul)`
  - invalid selector → entry `error` + `passed: false`, no throw
  - `dirPattern` filters which files an entry is checked in
  - required CSS property found in: external `.css`, embedded `<style>`, inline `style=""`; `"display: grid"` matches `display:grid;` (whitespace/case normalization)
  - required CSS selector found via rule match and via raw-substring fallback; comma lists split (`h1, h2 {}` satisfies required `h2`)
  - fileCounts counting + `min` threshold; `exclude` substrings skip files
  - empty/absent extractedDir → empty result shape
- **`test/generate_grades.spec.mjs`** additions: handler unit tests for the four new
  types (score proportions, `ids`/`selectors`/`properties` filters, `keepComment`,
  missing `student.webContent`, `file_count` unknown `countId`). The existing
  "mapping-type lists stay in sync" test guards the lab_config metadata automatically.
- **config validation tests** (wherever `validateConfig` is currently tested —
  `test/configure_lab.spec.mjs` or a dedicated spec): `textReport: true` allows a
  missing `rubricName`; bad `webContent` shapes rejected; `element_check` without
  `webContent` rejected; `file_count` with unknown `countId` rejected; `runtimeCheck:
  "none"` accepted.
- **CIS195 config smoke test** (new small spec): glob `configs/CIS195/**/​*_config.json`,
  `JSON.parse` each, and run `validateConfig` — all eight must pass.

---

## 11. Step 10 — Documentation updates

- **CLAUDE.md**: add phase 5e (`check_web_content.js`) to the pipeline list; add the
  four mapping types to the `mappings[]` type list (with the `ids`/`selectors`/
  `properties`/`countId` fields); document `webContent`, `textReport`, and
  `runtimeCheck: "none"` in the config schema section; mention CIS195 as a second
  course under `configs/` and that jsdom/css-tree are dependencies.
- **DEVELOPER_GUIDE.md / USER_GUIDE.md**: same content, appropriate depth; USER_GUIDE
  gets the CIS195 quick-start (`node bin/grade.js CIS195 Lab02`, labRoot layout above,
  reports land as `SubmissionsAndAssessment/<Student>/<Student>_Grade.txt`).
- **README.md**: one-liner that the grader now also covers CIS 195 HTML/CSS labs
  (superseding the old GradingAssistant repo).

---

## 12. Step 11 — Verification

1. `npm test` and `npm run lint` both pass.
2. **End-to-end smoke test with real data.** `D:\Repos\GradingAssistant\Temp\CIS195_Su23TermProjects\` contains genuine student term-project sites *with the old grader's `_report.txt` files still in them* — a ready-made answer key.
   - Create a scratch labRoot: `<scratch>/CIS195/TermProject/`.
   - For two students (e.g. `AshleyBakker_file`, `TimothyRussell_file`): zip the site folder (e.g. `Term-Project/`) and place the zip in `<scratch>/CIS195/TermProject/AshleyBakker_12345_assignsubmission_file/`.
   - Point a term's `labRoot` at `<scratch>` (or temporarily add a test term in `configs/local-config.json`), run `node bin/grade.js CIS195 TermProject`, and confirm no flag is needed for text reports.
   - Diff the generated `*_Grade.txt` findings against the old `_report.txt` in each student folder: same missing-element findings should appear (e.g. Ashley's report shows all required elements found; pick a second student whose old report shows misses).
3. **Regression**: run an existing CS233JS lab config through `validateConfig` and the test suite — no `webContent` block means the new phase must be skipped and nothing else changes.

---

## 13. Judgment calls (recorded for posterity)

- `Lab07` CSS requirement `text` → `text-align` (old substring matching was that loose).
- `Lab01` `I, em` → `i, em` (CSV typo).
- Lab03/Lab07 "part 2" element sets are separate `element_check` mappings (Lab03) or folded into part 1 (Lab07, pure subset) — the old tool never scoped parts to subfolders anyway.
- CSS rule-count / unique-property-count minimums dropped (never actually configured by any lab CSV; the old implementation indexed the wrong columns).
- "Optional" selectors/properties from the CSVs are kept in the checks but labeled optional in the mapping descriptions, still worth 1 point collectively via the proportional score.
- W3C online validators replaced by the repo's existing offline validators (no network, no rate limits).
- Every CIS195 config sets `validate.htmlRules` to turn off `no-inline-style`, `attr-quotes`, `element-case`, `no-implicit-button-type`, and `wcag/h63` — html-validate's *recommended* preset treats these stylistic/accessibility-audit rules as errors, but the old W3C validator only reported genuine conformance errors (and Lab04 explicitly **requires** inline styles). Verified against the Summer-23 answer keys: with these off, the error counts line up with what the W3C validator reported (e.g. DrazdonFenton's one real `</p>` close-order error survives; AshleyBakker's stylistic noise disappears).
- JsChecker not ported; `UnzipFiles.mjs` obsolete (extract_code covers it).
