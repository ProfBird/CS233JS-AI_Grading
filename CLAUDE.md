## Overview

AI grading pipeline for CS233JS (Lane Community College). Automates grading of student JavaScript lab submissions downloaded from Moodle. The pipeline extracts student code, runs analysis/lint/runtime checks, then fills in rubric spreadsheets (.xlsx/.xlsm) with scores and comments.

## Commands

```bash
node run_all.js              # interactive menu
node run_all.js Lab03        # first-time grade
node run_all.js Lab03 --regrade   # re-run grading phases, keep extracted code
node run_all.js Lab03 --reclone         # delete extracted code, re-clone, then grade
node run_all.js Lab03 --ai-comments     # grade with Ollama-generated rubric summary sentences
node run_all.js Lab06 --text-report     # grade without rubric spreadsheet, generates .txt reports
node run_all.js TermProject ApiDoc      # grade one step of a multi-step lab
npx eslint --format json path/to/files/*.js

node bin/rubric_to_md.js path/to/Rubric.xlsm   # dump Grade sheet as Markdown (output alongside spreadsheet)
node bin/configure_lab.js [AssignmentName]    # interactive wizard to create a new lab/assignment config + copy rubric
node archive/update_lab04_rubric.js            # one-time: rewrites Lab04 rubric cells to match Lab04 point design
```

```bash
npx vitest run              # run all tests
npx vitest                  # watch mode
```

### Dependencies

- **puppeteer** — headless Chrome for browser runtime checks
- **xlsx** — read/write rubric spreadsheets
- **adm-zip** — read/write ZIP entries to preserve VBA macros/buttons in `.xlsm` output files
- **mammoth** — read `.docx` code review forms and convert to HTML for table parsing
- **html-validate** — offline HTML validator used by `validate_html.js`
- **csstree-validator** — offline CSS validator used by `validate_css.js`
- **globals** — browser/node global definitions for ESLint flat config
- **eslint** — v9+ flat config
- **vitest** (dev) — test runner

## Architecture

### Pipeline (`run_all.js`)

1. **pipeline/extract_code.js** — Reads Moodle submission dirs. Unzips `.zip` files or clones GitHub repos from URLs in `onlinetext.html`. Attaches `student.extractedDir`, `student.urls`, `student.filesDir`.
2. **pipeline/runtime_check.js** — `"browser"` mode: Puppeteer captures console errors and failed loads. `"build"` mode: deletes any existing `node_modules/` then runs `npm install && npm run build`. `"both"` mode: runs build first, then browser check; stores `buildSuccess`/`browserSuccess` sub-results separately. Also runs a `scripts_check` sub-phase (verifies npm run dev/build/preview scripts exist and succeed) when `scripts_check` mappings are present in the config. Attaches to `student.runtimeCheck` and `student.scriptsCheck`.
3. **pipeline/read_code_review.js** — Reads each student's code review form (`.docx`). Parses the HTML table (via mammoth) to extract per-item beta and production scores, plus the lab assignment group letter. Attaches `student.codeReview` with `items[{betaScore, prodScore}]`, `productionCompleted`, and `group`. Runs *before* analysis so the group letter is available to the analyzer.
4. **pipeline/analyze_code.js** — Regex-based feature detection per-lab config. For multi-part labs, matches subdirs to game names from config. Checks repo hygiene *before* runtime modifications. Attaches to `student.analysis`. A configured `customAnalyzer` is invoked via `applyCustomAnalyzer()`, whose return object is merged into `analysis` (a throwing analyzer is logged and skipped). A custom analyzer can attach `analysis.reportSections` (see below) to add lab-specific output to text reports without touching generic code.
5. **pipeline/lint_code.js** — Runs ESLint (flat config) against each student's `.js` files using `~/.eslint/eslint.config.mjs` — the same config VS Code uses, ensuring consistent results. Attaches to `student.lint`.
5b. **pipeline/validate_html.js** — Validates `.html`/`.htm` files with `html-validate` (pure JS, offline). Attaches `student.htmlValidation` with `{ htmlFiles, errors, warnings, messages, ruleCounts }`. Respects `config.validate.exclude`. Ruleset overrideable via `config.validate.htmlExtends` / `config.validate.htmlRules`; `no-trailing-whitespace` is off by default.
5c. **pipeline/validate_css.js** — Validates `.css` files with `csstree-validator` (pure JS, offline). Attaches `student.cssValidation` with `{ cssFiles, errors, warnings, messages, ruleCounts }`. Reports validity errors only (no warning tier). Respects `config.validate.exclude`.
5d. **pipeline/check_names.js** — Checks every file and folder name in the submission for Linux/web portability. A name is invalid if it contains any character outside `[A-Za-z0-9._-]` (spaces, parens, accented chars, etc.). Attaches `student.nameCheck` with `{ entriesChecked, errors, messages, badNames }`. Extra allowed characters configurable via `config.nameCheck.extraAllowed`.

6. **pipeline/generate_grades.js** — Reads from `student.analysis`, `student.lint`, `student.runtimeCheck`, `student.codeReview`, `student.htmlValidation`, `student.cssValidation`, `student.nameCheck`, `student.scriptsCheck`. Fills rubric `.xlsx`/`.xlsm` cells using handler functions per mapping type. For `.xlsm` rubrics, delegates OOXML/ZIP surgery to `lib/rubric_writer.js`. With `--ai-comments`, calls `lib/ollama_comments.js` to generate a one-sentence summary for `config.summaryCell`. With `--text-report`, produces `.txt` grade reports instead of spreadsheets — useful when a rubric template isn't available yet. If `config.graderCell` is set, writes "Computer" into that cell; on regrade, creates a versioned copy (`-V2`, `-V3`, …) rather than overwriting a spreadsheet that has been manually reviewed.

### Shared utilities (`lib/`)

- **lib/file_walker.js** — Recursive directory traversal. Exports: `walk(dir, opts)` (core traversal with `visit`, `onFile`, `onDir`, `shouldSkip`, `shouldDescend`, `followSymlinks`, `maxDepth`); `getAllFilesByExt(dir, ext, exclusions)` (collect files by extension); `DEFAULT_SKIP_DIRS` (Set of dirs never scanned: `node_modules`, `dist`, `build`, `.git`, `__MACOSX`).
- **lib/rubric_writer.js** — Low-level OOXML/ZIP surgery: column-width recovery, drawing/button preservation, reducing the workbook to the Grade sheet, restoring non-Grade sheets as `veryHidden` for VBA binding.
- **lib/ollama_comments.js** — HTTP client for a local Ollama server; generates one-sentence AI rubric summaries.

### Config files

Two layouts are supported — flat (single submission set) and multi-step (multiple submission sets, e.g., Proposal + DevEnv + ApiDoc + Beta + Production).

**Flat lab** — one config at the assignment level:
```
configs/{AssignmentName}/
  {assignmentname}_config.json          # e.g. lab06_config.json
  CS233JS_{AssignmentName}_Rubric.xlsm  # rubric template lives alongside config
  {assignmentname}_analyzer.js          # optional custom analyzer
```
- `rubricName` in the config is the filename only (e.g. `"CS233JS_Lab06_Rubric.xlsm"`), resolved relative to the config's directory.
- Run: `node run_all.js Lab06`

**Multi-step lab** — one subdirectory per submission step, no top-level config:
```
configs/{AssignmentName}/
  {StepName}/                                     # e.g. DevEnvAndStaticSite/
    {stepname_lower}_config.json                  # e.g. devenvandstaticsite_config.json
    CS233JS_{StepName}_Rubric.xlsm                # rubric lives in the step subdir
  {AnotherStep}/
    {anotherstep_lower}_config.json
    CS233JS_{AnotherStep}_Rubric.xlsm
```
- Detection rule: top-level `{assignmentname}_config.json` is **absent**, but one or more subdirectories each contain a `{subdir_lower}_config.json`.
- `rubricName` in each step config is the filename only (e.g. `"CS233JS_DevEnvAndStaticSite_Rubric.xlsm"`), resolved relative to that step's subdirectory.
- Run: `node run_all.js TermProject DevEnvAndStaticSite` (or just `node run_all.js TermProject` for an interactive step picker).
- If the labRoot has a matching step subdirectory (e.g. `<labRoot>/TermProject/DevEnvAndStaticSite/`), submissions are read from there. If not, submissions are read from `<labRoot>/TermProject/` directly — the labRoot step layout is optional.
- `configure_lab.js` asks "Will there be multiple sets of submissions for this lab?" when creating a brand-new lab; run it once per step to set up each step's config.

**Converting a flat lab to multi-step:**
1. `mkdir configs/{Lab}/{StepName}`
2. `mv configs/{Lab}/{lab}_config.json configs/{Lab}/{StepName}/{stepname_lower}_config.json`
3. `mv configs/{Lab}/*.xlsm configs/{Lab}/{StepName}/` (move rubric into step subdir)
4. Update `rubricName` in the moved config to remove any path prefix — just the filename.
5. Organize the Moodle labRoot downloads into `<labRoot>/{Lab}/{StepName}/` subdirectories.

### Directory structure

```
AI_Grading/   ← this directory
  ├── run_all.js                   # primary entry point
  ├── pipeline/                    # grading phases (run in order by run_all.js)
  │   ├── extract_code.js
  │   ├── runtime_check.js
  │   ├── read_code_review.js
  │   ├── analyze_code.js
  │   ├── lint_code.js
  │   ├── validate_html.js
  │   ├── validate_css.js
  │   ├── check_names.js
  │   └── generate_grades.js
  ├── lib/                         # shared utilities used by pipeline phases
  │   ├── file_walker.js
  │   ├── rubric_writer.js
  │   └── ollama_comments.js
  ├── bin/                         # secondary CLI tools
  │   ├── rubric_to_md.js
  │   └── configure_lab.js         # interactive lab config creation wizard
  ├── configs/
  │   ├── local-config.json        # labRoot + codeRoot (machine-specific, gitignored, auto-created)
  │   └── {AssignmentName}/
  │       ├── {assignmentname}_config.json    # flat-lab: rubric config, feature regexes, cell mappings
  │       ├── CS233JS_{AssignmentName}_Rubric.xlsm  # rubric template (tracked in git)
  │       ├── {assignmentname}_analyzer.js   # optional custom analyzer (if any)
  │       └── {StepName}/                    # multi-step lab: one subdir per submission step
  │           ├── {stepname}_config.json     # step-level config (e.g. apidoc_config.json)
  │           └── CS233JS_{StepName}_Rubric.xlsm
  └── ...

<labRoot>/    (on Google Drive — raw Moodle downloads only, nothing created here)
  └── {AssignmentName}/
      ├── StudentName_12345_assignsubmission_file/
      │   └── (zip files uploaded by student, if any)
      └── StudentName_12345_assignsubmission_onlinetext/
          └── onlinetext.html

  # Multi-step: Moodle downloads are in step subdirectories
  └── {AssignmentName}/
      └── {StepName}/
          ├── StudentName_12345_assignsubmission_file/
          └── StudentName_12345_assignsubmission_onlinetext/

<codeRoot>/   (local, outside Google Drive)
  └── {AssignmentName}/  ← flat lab: created automatically; keeps different assignments separate
      ├── Artifacts/   ← grader-produced files (reports, log)
      │   ├── analysis_report.json
      │   ├── lint_report.json
      │   ├── runtime_report.json
      │   ├── html_validation_report.json
      │   ├── css_validation_report.json
      │   ├── name_check_report.json
      │   └── grading_log.txt
      └── SubmissionsAndAssessment/  ← student code + per-student grade spreadsheets
          └── StudentName/
              ├── repo/  (GitHub clone)  or  extracted_code/  (unzipped)
              └── StudentName_Grade.xlsx

  # Multi-step: each step gets its own Artifacts + SubmissionsAndAssessment tree
  └── {AssignmentName}/
      └── {StepName}/
          ├── Artifacts/
          └── SubmissionsAndAssessment/
              └── StudentName/
                  └── StudentName_Grade.xlsx
```


- ESLint config: `~/.eslint/eslint.config.mjs` — shared with VS Code; not stored in this repo.
- `--reclone` implies `--regrade`.
- In **normal mode** (no flags), students whose grade spreadsheet already exists are skipped entirely — no runtime check, analysis, linting, or spreadsheet rewrite. Use `--regrade` to re-process them.
- **`--regrade` without `--reclone`** automatically runs `git pull` on each student's cloned repo before re-grading, so updated submissions are picked up without a full re-clone.
- When `labDir` contains no direct Moodle submissions but has subdirectories that do (e.g., Moodle exported Beta/Production as separate groups), `run_all.js` prompts you to pick which group to grade.
- `configs/local-config.json` is tried first; `default-config.json` (shipped with the repo) is the fallback for new machines.
- Each pipeline phase attaches data to the shared `students` array; `generate_grades` consumes the combined output.

### Config schema (configs/{AssignmentName}/{assignmentname}_config.json)

  - rubricName: string — rubric filename in the lab directory

  - runtimeCheck: "browser" | "build" | "both"
    - `"both"` runs build first, then Puppeteer browser check. Use `build_check` / `browser_check` / `build_and_browser_check` mapping types to score them separately or together.

  - summaryCell: string (optional) — cell for AI/manual summary comment
  - graderCell: string (optional) — cell written with "Computer" on every new spreadsheet. On `--regrade`, if the cell still contains "Computer" the file is overwritten; if it has been changed (e.g. to "Brian Bird" after manual review) a new versioned copy is written (`StudentName_Grade-V2.xlsm`, `-V3`, …) instead.
  - titleCell, titleText: (optional) — cell and text for lab title

  - codeReview: { studentNameCell, groupCell, manualFallback } (optional) — `studentNameCell`/`groupCell` name the cells where the student name and lab group letter are written. There is **no default**: if a cell is not specified, that value is not written (generic code makes no assumption about rubric layout). All current lab rubrics use `B1`/`C1`.

  - analysis.features[]: { id, regex, fileRegex } — features to count via regex
  - analysis.customAnalyzer: string (optional) — path (relative to configs/{AssignmentName}/) to a JS module that receives (jsFiles, analysis, config, student) and merges its return into analysis. The return may include `reportSections: [{ title, lines[] }]` — the text-report renderer prints these generically (used by Lab06 for its "API Integration Pipeline" breakdown), so lab-specific report content lives in the analyzer, not in pipeline code.

  - parts[]: { id, gameNames[], folderPattern, featureCounts[] } — multi-part lab config (optional). gameNames is the list of expected game/project names for that part; folderPattern is a regex fallback for "Part1/Pt2"-style folder naming.

  - validate: (optional) — config for HTML and CSS validation phases
    - exclude[]: path substrings to skip (shared by both validators and name check)
    - htmlExtends[]: override the html-validate preset list (default: `['html-validate:recommended']`)
    - htmlRules: object — per-rule overrides (e.g. `{ "no-inline-style": "error" }`)

  - nameCheck: (optional)
    - extraAllowed: string — additional characters to allow in file/folder names beyond `[A-Za-z0-9._-]`

  - mappings[] — rubric cell assignments (types listed below)
    - types: feature | part1_completed | part_completed | apps_in_repo | developer_comments | code_review | url_check | deploy_check | lint | build_check | browser_check | build_and_browser_check | html_validate | css_validate | name_check | manual | part_feature | repo_hygiene | github_repo | collaborator_check | gitignore_check | scripts_check | npm_package | package_check
    - any mapping may include `stockComments: { full, partial, zero }` — short strings written into the comment cell instead of the verbose auto-generated comment. `keepComment: true` handlers (e.g. `deploy_check` manual-review flags) are **not** overridden by `stockComments.zero`.
    - lint mappings accept an optional `severity: "errors" | "warnings"` to report only errors (syntax) or only warnings (style) into separate cells
    - `html_validate` / `css_validate` mappings accept `tolerance` (default 3) — errors ≤ tolerance score half points; more score zero
    - `name_check` mappings accept `tolerance` (default 2) — same half/zero tier logic
    - `scripts_check` mappings accept `scripts` (comma-separated string or array, default `"dev,build,test"`) — list of npm script names to verify. Score is proportional to how many pass.
    - `code_review` mappings: comment reports both review presence and production column completion as "yes and yes" / "yes and no" / "no and no". Full points when both are true; half points (maxScore/2) when review submitted but production column incomplete; 0 when no review.
    - `manual` mappings: assigned `_reviewIndex` sequentially (order in config). Uses production score from code review form; falls back to beta score when production cell is empty. Comment indicates which column was used.
    - `deploy_check` mappings: async — fetches the citstudent URL with up to 3 attempts (10s timeout each, 2s delay between retries), then inspects `<script>` tags for bundling indicators (hashed filenames, assets/dist/static paths, bundle/min/chunk). Full points for reachable + bundled; half points for reachable but unbundled. When the URL cannot be verified — a thrown fetch (DNS/connection/TLS/timeout) or an HTTP error response — the handler scores 0 **but flags the row for manual review** with a `NEEDS MANUAL CHECK: … — verify deployment manually` comment that carries the real failure reason (e.g. `ECONNRESET`, `HTTP 503`). It sets `keepComment: true` so this diagnostic is **not** overwritten by `stockComments.zero`; this prevents a transient grader-side network failure from silently zeroing a student whose app is actually live. A genuinely missing URL still scores 0 with the plain stock "zero" comment. Any handler may return `keepComment: true` to protect its comment from the stock-tier override.

  - lint.exclude[]: path substrings to skip during linting
  - repoHygiene.excludedFromRepo[]: folder names that should not be committed (checked via `git ls-files`; only applies to git-cloned repos)
  - packageCheck: { dependencies[], devDependencies[], allowedExtras[] } — expected npm package sections; `allowedExtras` whitelists packages the student may add beyond the required ones
