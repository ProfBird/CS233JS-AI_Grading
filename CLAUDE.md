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

No test suite — scripts run directly via `node <script>.js`.

## Architecture

### Pipeline (`run_all.js`)

1. **extract_code.js** — Reads Moodle submission dirs. Unzips `.zip` files or clones GitHub repos from URLs in `onlinetext.html`.
2. **runtime_check.js** — `"browser"` mode: Puppeteer captures console errors and failed loads. `"build"` mode: runs `npm install && npm run build`.
3. **analyze_code.js** — Regex-based feature detection per-lab config. For multi-part labs, matches subdirs to game names from rubric title rows.
4. **lint_code.js** — Runs ESLint (flat config from `eslint.config.mjs`) against each student's `.js` files.
5. **generate_grades.js** — Fills rubric `.xlsx`/`.xlsm` cells using config mappings. Writes one graded spreadsheet per student. With `--ai-comments`, calls `ollama_comments.js` to generate a one-sentence summary for `config.summaryCell`.

### Config files (`configs/labXX_config.json`)

Per-lab JSON specifying rubric filename, runtime check mode, feature regexes, and cell mappings. The `parts` key (optional) handles multi-part labs with per-part feature counts.

### Directory structure

```
.. (StudentLabWork parent)
  └── Lab02/
      ├── CS233JS_Lab02_Rubric.xlsx
      ├── StudentName_12345_assignsubmission_file/
      └── StudentName_12345_assignsubmission_onlinetext/
          └── onlinetext.html
AI_Grading/   ← this directory
  ├── run_all.js
  ├── configs/lab02_config.json
  └── ...
```

### Dependencies

- **puppeteer** — headless Chrome for browser runtime checks
- **xlsx** — read/write rubric spreadsheets
- **eslint** — v9+ flat config

### Design notes

- `--reclone` implies `--regrade`.
- Each pipeline phase attaches data to the shared `students` array; `generate_grades` consumes the combined output.

### Config schema (configs/labXX_config.json)       

  - rubricFile: string — rubric filename in the lab directory

  - runtimeMode: "browser" | "build"                                                       

  - analysis.features[]: { id, regex, description } — features to count                                     

  - grading.mappings[]: { cell, type, featureId, ... } — rubric cell assignments                                 
    - types: featureCount | featurePresent | lintErrors | lintWarnings | runtimeErrors | developerComments | bothPartsPresent          

  - parts[]: { id, rubricTitleRow, folderPattern } — multi-part lab config (optional)                              

  - lint.exclude[]: path substrings to skip during linting 
