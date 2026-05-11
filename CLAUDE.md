## Overview

AI grading pipeline for CS233JS (Lane Community College). Automates grading of student JavaScript lab submissions downloaded from Moodle. The pipeline extracts student code, runs analysis/lint/runtime checks, then fills in rubric spreadsheets (.xlsx/.xlsm) with scores and comments.

## Commands

```bash
node run_all.js              # interactive menu
node run_all.js Lab03        # first-time grade
node run_all.js Lab03 --regrade   # re-run grading phases, keep extracted code
node run_all.js Lab03 --reclone         # delete extracted code, re-clone, then grade
node run_all.js Lab03 --ai-comments     # grade with Ollama-generated rubric summary sentences
npx eslint --format json path/to/files/*.js

node rubric_to_md.js path/to/Rubric.xlsm   # dump Grade sheet as Markdown (output alongside spreadsheet)
node update_lab04_rubric.js                 # one-time: rewrites Lab04 rubric cells to match Lab04 point design
```

```bash
npx vitest run              # run all tests
npx vitest                  # watch mode
```

### Dependencies

- **puppeteer** — headless Chrome for browser runtime checks
- **xlsx** — read/write rubric spreadsheets
- **eslint** — v9+ flat config
- **vitest** (dev) — test runner

## Architecture

### Pipeline (`run_all.js`)

1. **extract_code.js** — Reads Moodle submission dirs. Unzips `.zip` files or clones GitHub repos from URLs in `onlinetext.html`. Attaches `student.extractedDir`, `student.urls`, `student.filesDir`.
2. **runtime_check.js** — `"browser"` mode: Puppeteer captures console errors and failed loads. `"build"` mode: runs `npm install && npm run build`. Attaches to `student.runtimeCheck`.
3. **analyze_code.js** — Regex-based feature detection per-lab config. For multi-part labs, matches subdirs to game names from rubric title rows. Attaches to `student.analysis`.
4. **lint_code.js** — Runs ESLint (flat config from `eslint.config.mjs`) against each student's `.js` files. Attaches to `student.lint`.
5. **generate_grades.js** — Reads from `student.analysis`, `student.lint`, `student.runtimeCheck`. Fills rubric `.xlsx`/`.xlsm` cells using handler functions per mapping type. With `--ai-comments`, calls `ollama_comments.js` to generate a one-sentence summary for `config.summaryCell`.

### Config files (`configs/LabXX/labXX_config.json`)

Per-lab JSON specifying rubric filename, runtime check mode, feature regexes, and cell mappings. The `parts` key (optional) handles multi-part labs with per-part feature counts. The rubric template (`.xlsx`/`.xlsm`) is stored alongside the config in the same `configs/LabXX/` directory.

### Directory structure

```
AI_Grading/   ← this directory
  ├── run_all.js
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


- `--reclone` implies `--regrade`.
- Each pipeline phase attaches data to the shared `students` array; `generate_grades` consumes the combined output.

### Config schema (configs/LabXX/labXX_config.json)

  - rubricName: string — rubric filename in the lab directory

  - runtimeCheck: "browser" | "build"

  - summaryCell: string (optional) — cell for AI/manual summary comment
  - titleCell, titleText: (optional) — cell and text for lab title

  - analysis.features[]: { id, regex, fileRegex } — features to count via regex
  - analysis.customAnalyzer: string (optional) — path (relative to configs/LabXX/) to a JS module that receives (jsFiles, analysis, config, student) and merges its return into analysis

  - parts[]: { id, rubricTitleRow, folderPattern, featureCounts[] } — multi-part lab config (optional)

  - mappings[] — rubric cell assignments (types listed below)
    - types: feature | part1_completed | part_completed | apps_in_repo | developer_comments | code_review | url_check | lint | build_check | manual | part_feature

  - lint.exclude[]: path substrings to skip during linting 
