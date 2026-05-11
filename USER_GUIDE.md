# CS233JS AI Grader — User Guide



[TOC]



## Overview

The AI Grader automates grading of student JavaScript lab submissions for CS233JS. It handles both ZIP uploads and GitHub repository submissions, runs analysis/lint/runtime checks, and fills in rubric spreadsheets with scores and comments.

The pipeline is designed for a workflow where some items are auto-graded and others require manual instructor review.

---

## Prerequisites

- **Node.js** v16 or later
- **npm packages** (install once):
  ```
  npm install
  ```
  This installs `puppeteer`, `xlsx`, `eslint`, and `vitest` (test runner).

- **Git** — required for cloning student repositories
- **unzip** — required for extracting ZIP submissions (pre-installed on macOS/Linux)
- **Ollama** (optional) — for AI-generated summary comments (`--ai-comments` flag)

---

## Directory Setup

### File layout

```
AI_Grading/                   ← this tool (git repo)
  ├── run_all.js              ← main entry point
  └── configs/
      ├── local-config.json   ← machine-specific paths (auto-created, gitignored)
      └── LabXX/
          ├── labXX_config.json        ← per-lab rubric configuration
          └── CS233JS_LabXX_Rubric.xlsx  ← rubric template

<labRoot>/                    ← your lab data (on Google Drive)
  └── LabXX/
      ├── StudentName_12345_assignsubmission_file/
      │   └── submission.zip
      └── StudentName_12345_assignsubmission_onlinetext/
          └── onlinetext.html

<codeRoot>/                   ← local folder outside Google Drive
  └── LabXX/                  ← created automatically per lab
      └── StudentName/
          └── repo/  (or extracted_code/)
```

### First-time setup

The first time you run the grader, it will prompt for two paths:

1. **Lab root** — the Google Drive folder containing your lab directories (e.g., `StudentLabWork`). Saved to `AI_Grading/configs/local-config.json`.
2. **Code storage root** — a folder *outside* Google Drive where student code will be cloned or unzipped. The grader creates a subfolder for each lab automatically (e.g., `GradingCode/Lab03/`), so you only need to provide the base path once. Saved to `AI_Grading/configs/local-config.json`.

You only need to enter these once — they're saved for future runs.

---

## Running the Grader

### Interactive mode

```bash
node run_all.js
```

Shows a menu of available labs and grading modes:

1. **Normal** — grade new submissions (skips students who already have extracted code)
2. **Regrade** — re-run all grading phases but keep existing cloned/extracted code
3. **Reclone** — delete all extracted code, re-clone/unzip from scratch, then re-grade

### Tests

```bash
npm test                # run smoke tests (Vitest)
npm run test:watch      # re-run tests on file changes
```

### Command-line mode

```bash
node run_all.js Lab04                   # grade Lab04 (normal mode)
node run_all.js Lab04 --regrade         # re-grade without re-cloning
node run_all.js Lab04 --reclone         # fresh clone + full grade
node run_all.js Lab04 --ai-comments     # grade with AI summary comments
node run_all.js Lab04 --ai-model=qwen3-coder   # use a specific Ollama model
```

### Flags

| Flag | Effect |
|---|---|
| `--regrade` | Re-run analysis/lint/runtime/generation. Keeps existing extracted code. |
| `--reclone` | Delete all extracted code and re-clone/unzip from scratch. Implies `--regrade`. |
| `--ai-comments` | Generate a one-sentence AI summary for each student's rubric using a local Ollama model. Falls back to placeholder text if Ollama is not running. |
| `--ai-model=NAME` | Specify which Ollama model to use. Implies `--ai-comments`. |
| `--help`, `-h` | Show usage information. |

---

## What the Pipeline Does

For each student, the grader runs these phases in order:

1. **Code Acquisition** — unzips `.zip` files or clones GitHub repos
2. **Runtime Check** — runs `npm install && npm run build` (build mode) or opens the app in headless Chrome (browser mode), depending on the lab
3. **Analysis** — scans JavaScript files for required features using regex patterns
4. **Linting** — runs ESLint to flag code quality issues
5. **Grade Generation** — fills in the rubric spreadsheet with scores and comments

---

## Manual Grading

The pipeline leaves some items for you to review manually:

| Comment in spreadsheet | What it means |
|---|---|
| `NEEDS MANUAL CHECK` | Score cell was left blank or pre-filled — inspect the student's work and enter the grade |
| `NEEDS CHECK: <url>` | The student provided a URL — visit it and verify the submission |
| `Pending manual checks for full verification.` | The summary cell — replace with your own comment (or use `--ai-comments`) |

Open each student's `StudentName_Grade.xlsx` (or `.xlsm`) file in Excel or LibreOffice, review the flagged items, fill in scores, and the formulas will auto-calculate the total.

---

## Tips & Troubleshooting

**Google Drive is slow:** The lab data lives on Google Drive, which can cause file reads to hang. If the pipeline seems stuck, check whether it's waiting on a Google Drive file read. The `codeRoot` setting moves cloned/extracted code off the cloud drive to avoid this.

**AI comments not working:** Ensure Ollama is running (`ollama serve`) and at least one model is installed. Run `ollama list` to check. The grader auto-selects the first available model.

**Re-cloning a single student:** If a student's repo changes after the initial clone, use `--reclone` to wipe everything and start fresh. There's no per-student reclone option.

**ESLint not installed:** Run `npm install` in the `AI_Grading/` directory. ESLint is a devDependency.

**Output files:** Each student gets a graded spreadsheet in their submission directory (e.g., `StudentName_12345_assignsubmission_file/StudentName_Grade.xlsx`). A `grading_log.txt` summary is written to the lab directory.
