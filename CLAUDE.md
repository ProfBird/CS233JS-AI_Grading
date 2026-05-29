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
npx eslint --format json path/to/files/*.js

node bin/rubric_to_md.js path/to/Rubric.xlsm   # dump Grade sheet as Markdown (output alongside spreadsheet)
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
- **globals** — browser/node global definitions for ESLint flat config
- **eslint** — v9+ flat config
- **vitest** (dev) — test runner

## Architecture

### Pipeline (`run_all.js`)

1. **pipeline/extract_code.js** — Reads Moodle submission dirs. Unzips `.zip` files or clones GitHub repos from URLs in `onlinetext.html`. Attaches `student.extractedDir`, `student.urls`, `student.filesDir`.
2. **pipeline/analyze_code.js** — Regex-based feature detection per-lab config. For multi-part labs, matches subdirs to game names from config. Checks repo hygiene *before* runtime modifications. Attaches to `student.analysis`.
3. **pipeline/runtime_check.js** — `"browser"` mode: Puppeteer captures console errors and failed loads. `"build"` mode: deletes any existing `node_modules/` then runs `npm install && npm run build`. Attaches to `student.runtimeCheck`.
4. **pipeline/lint_code.js** — Runs ESLint (flat config) against each student's `.js` files using `~/.eslint/eslint.config.mjs` — the same config VS Code uses, ensuring consistent results. Attaches to `student.lint`.
4.5. **pipeline/read_code_review.js** — Reads each student's code review form (`.docx`). Parses the HTML table (via mammoth) to extract per-item beta and production scores, plus the lab assignment group letter. Attaches `student.codeReview` with `items[{betaScore, prodScore}]`, `productionCompleted`, and `group`.

5. **pipeline/generate_grades.js** — Reads from `student.analysis`, `student.lint`, `student.runtimeCheck`, `student.codeReview`. Fills rubric `.xlsx`/`.xlsm` cells using handler functions per mapping type. For `.xlsm` rubrics, delegates OOXML/ZIP surgery to `lib/rubric_writer.js`. With `--ai-comments`, calls `lib/ollama_comments.js` to generate a one-sentence summary for `config.summaryCell`. With `--text-report`, produces `.txt` grade reports instead of spreadsheets — useful when a rubric template isn't available yet.

### Shared utilities (`lib/`)

- **lib/file_walker.js** — Recursive directory traversal primitive used by the pipeline phases. Options: `visit`, `onFile`, `shouldSkip`, `shouldDescend`, `followSymlinks`, `maxDepth`.
- **lib/rubric_writer.js** — Low-level OOXML/ZIP surgery: column-width recovery, drawing/button preservation, reducing the workbook to the Grade sheet, restoring non-Grade sheets as `veryHidden` for VBA binding.
- **lib/ollama_comments.js** — HTTP client for a local Ollama server; generates one-sentence AI rubric summaries.

### Config files (`configs/LabXX/labXX_config.json`)

Per-lab JSON specifying rubric filename, runtime check mode, feature regexes, and cell mappings. The `parts` key (optional) handles multi-part labs with per-part feature counts. The rubric template (`.xlsx`/`.xlsm`) is stored alongside the config in the same `configs/LabXX/` directory.

### Directory structure

```
AI_Grading/   ← this directory
  ├── run_all.js                   # primary entry point
  ├── pipeline/                    # grading phases (run in order by run_all.js)
  │   ├── extract_code.js
  │   ├── analyze_code.js
  │   ├── lint_code.js
  │   ├── runtime_check.js
  │   ├── read_code_review.js
  │   └── generate_grades.js
  ├── lib/                         # shared utilities used by pipeline phases
  │   ├── file_walker.js
  │   ├── rubric_writer.js
  │   └── ollama_comments.js
  ├── bin/                         # secondary CLI tools
  │   └── rubric_to_md.js
  ├── configs/
  │   ├── local-config.json        # labRoot + codeRoot (machine-specific, gitignored, auto-created)
  │   └── LabXX/
  │       ├── labXX_config.json    # rubric config, feature regexes, cell mappings
  │       ├── CS233JS_LabXX_Rubric.xlsm  # rubric template (tracked in git)
  │       └── labXX_analyzer.js   # optional custom analyzer (if any)
  └── ...

<labRoot>/    (on Google Drive — raw Moodle downloads only, nothing created here)
  └── LabXX/
      ├── StudentName_12345_assignsubmission_file/
      │   └── (zip files uploaded by student, if any)
      └── StudentName_12345_assignsubmission_onlinetext/
          └── onlinetext.html

<codeRoot>/   (local, outside Google Drive)
  └── LabXX/  ← created automatically; keeps different labs separate
      ├── ArtifactsAndRubrics/   ← grader-produced files (reports, log)
      │   ├── analysis_report.json
      │   ├── lint_report.json
      │   ├── runtime_report.json
      │   └── grading_log.txt
      └── SubmissionsAndAssessment/  ← student code + per-student grade spreadsheets
          └── StudentName/
              ├── repo/  (GitHub clone)  or  extracted_code/  (unzipped)
              └── StudentName_Grade.xlsx
```


- ESLint config: `~/.eslint/eslint.config.mjs` — shared with VS Code; not stored in this repo.
- `--reclone` implies `--regrade`.
- In **normal mode** (no flags), students whose grade spreadsheet already exists are skipped entirely — no runtime check, analysis, linting, or spreadsheet rewrite. Use `--regrade` to re-process them.
- Each pipeline phase attaches data to the shared `students` array; `generate_grades` consumes the combined output.

### Config schema (configs/LabXX/labXX_config.json)

  - rubricName: string — rubric filename in the lab directory

  - runtimeCheck: "browser" | "build"

  - summaryCell: string (optional) — cell for AI/manual summary comment
  - titleCell, titleText: (optional) — cell and text for lab title

  - analysis.features[]: { id, regex, fileRegex } — features to count via regex
  - analysis.customAnalyzer: string (optional) — path (relative to configs/LabXX/) to a JS module that receives (jsFiles, analysis, config, student) and merges its return into analysis

  - parts[]: { id, gameNames[], folderPattern, featureCounts[] } — multi-part lab config (optional). gameNames is the list of expected game/project names for that part; folderPattern is a regex fallback for "Part1/Pt2"-style folder naming.

  - mappings[] — rubric cell assignments (types listed below)
    - types: feature | part1_completed | part_completed | apps_in_repo | developer_comments | code_review | url_check | deploy_check | lint | build_check | manual | part_feature | repo_hygiene | github_repo | package_check
    - lint mappings accept an optional `severity: "errors" | "warnings"` to report only errors (syntax) or only warnings (style) into separate cells
    - `code_review` mappings: comment reports both review presence and production column completion as "yes and yes" / "yes and no" / "no and no". Full points only when both are true.
    - `manual` mappings: assigned `_reviewIndex` sequentially (order in config). Uses production score from code review form; falls back to beta score when production cell is empty. Comment indicates which column was used.
    - `deploy_check` mappings: async — fetches the citstudent URL, checks HTTP reachability (10s timeout), then inspects `<script>` tags for bundling indicators (hashed filenames, assets/dist/static paths, bundle/min/chunk). Full points for reachable + bundled; half points for reachable but unbundled; 0 for unreachable.

  - lint.exclude[]: path substrings to skip during linting
  - repoHygiene.excludedFromRepo[]: folder names that should not be committed (checked via `git ls-files`; only applies to git-cloned repos) 
