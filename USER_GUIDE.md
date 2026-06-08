# CS233JS AI Grader — User Guide



[TOC]



## Overview

The AI Grader automates grading of student JavaScript lab submissions for CS233JS. It handles both ZIP uploads and GitHub repository submissions, runs analysis/lint/runtime/validation checks, and fills in rubric spreadsheets with scores and comments.

The pipeline is designed for a workflow where some items are auto-graded and others require manual instructor review.

---

## Prerequisites

- **Node.js** v16 or later
- **npm packages** (install once):
  ```
  npm install
  ```
  This installs `puppeteer`, `xlsx`, `adm-zip`, `mammoth`, `html-validate`, `csstree-validator`, `globals`, `eslint`, and `vitest` (test runner).

- **Git** — required for cloning student repositories
- **unzip** — required for extracting ZIP submissions (pre-installed on macOS/Linux)
- **Ollama** (optional) — for AI-generated summary comments (`--ai-comments` flag)

---

## Directory Setup

### Creating a new lab configuration

Use the interactive wizard to set up grading for a new lab:

```bash
node bin/create_lab.js               # interactive, prompts for assignment name
node bin/create_lab.js Lab07         # pre-specify a lab by number or name
node bin/create_lab.js TermProject   # pre-specify a non-numbered assignment
```

The wizard will:
1. Ask whether the lab has **multiple sets of submissions** (e.g., Proposal, Beta, Production). If yes, it prompts for the first step name and creates a step-level config (`configs/{AssignmentName}/{StepName}/`). Run the wizard again to add more steps.
2. Ask you to provide the rubric spreadsheet (.xlsx or .xlsm)
3. Copy it into `configs/{AssignmentName}/` (or the step subdirectory) with the standard naming convention
4. Guide you through configuring title, runtime mode, feature regexes, and rubric cell mappings
5. Optionally create a custom analyzer skeleton

### File layout

```
AI_Grading/                   ← this tool (git repo)
  ├── run_all.js              ← main entry point
  └── configs/
      ├── local-config.json   ← machine-specific paths (auto-created, gitignored)
      └── {AssignmentName}/
          ├── {assignmentname}_config.json     ← rubric config (flat lab)
          ├── CS233JS_{AssignmentName}_Rubric.xlsx  ← rubric template
          └── {StepName}/                      ← multi-step: one subdir per step
              ├── {stepname}_config.json       ← e.g. apidoc_config.json
              └── CS233JS_{StepName}_Rubric.xlsx

<labRoot>/                    ← your assignment data (on Google Drive)
  └── {AssignmentName}/
      ├── StudentName_12345_assignsubmission_file/
      │   └── submission.zip
      └── StudentName_12345_assignsubmission_onlinetext/
          └── onlinetext.html

  # Multi-step labs: Moodle downloads live in step subdirectories
  └── {AssignmentName}/
      └── {StepName}/
          ├── StudentName_12345_assignsubmission_file/
          └── StudentName_12345_assignsubmission_onlinetext/

<codeRoot>/                   ← local folder outside Google Drive
  └── {AssignmentName}/       ← created automatically per assignment (flat lab)
      ├── ArtifactsAndRubrics/
      │   └── ...
      └── SubmissionsAndAssessment/
          └── StudentName/
              ├── repo/  (or extracted_code/)
              └── StudentName_Grade.xlsx

  # Multi-step labs: each step gets its own output tree
  └── {AssignmentName}/
      └── {StepName}/
          ├── ArtifactsAndRubrics/
          └── SubmissionsAndAssessment/
              └── StudentName/
                  └── StudentName_Grade.xlsx
```

### Flat labs vs. multi-step labs

**Flat lab** — a single submission set graded as one unit (Lab03, Lab06, etc.):
- One config file at `configs/{AssignmentName}/{assignmentname}_config.json`
- Rubric template lives alongside the config
- Run: `node run_all.js Lab06`
- `create_lab.js` creates this layout by default (answer "No" when asked about multiple submission sets)

**Multi-step lab** — separate submission sets for different stages of the same project (e.g., TermProject with DevEnvAndStaticSite, ApiDoc, Beta, Production):
- No top-level config file; each step gets its own subdirectory under `configs/{AssignmentName}/{StepName}/`
- Each step subdir contains `{stepname_lower}_config.json` and its own rubric template
- Moodle labRoot must have matching step subdirectories: `<labRoot>/TermProject/DevEnvAndStaticSite/`
- Run a specific step: `node run_all.js TermProject DevEnvAndStaticSite`
- Run interactively (step picker shown): `node run_all.js TermProject`
- `create_lab.js` asks "Will there be multiple sets of submissions for this lab?" when creating a brand-new lab; run it once per step

**Converting a flat lab to multi-step** (e.g., you want to add a Beta step to a lab that currently only has a Production config):
```bash
mkdir configs/LabName/StepName
mv configs/LabName/labname_config.json configs/LabName/StepName/stepname_config.json
mv configs/LabName/*.xlsm configs/LabName/StepName/
# Then edit rubricName in the moved config to remove any path prefix
```

---

### First-time setup

The first time you run the grader, it will prompt for two paths:

1. **Lab root** — the Google Drive folder containing your lab directories (e.g., `StudentLabWork`). Saved to `AI_Grading/configs/local-config.json`.
2. **Code storage root** — a folder *outside* Google Drive where student code will be cloned or unzipped. The grader creates subfolders for each lab automatically (e.g., `GradingCode/Lab03/SubmissionsAndAssessment/`), so you only need to provide the base path once. Saved to `AI_Grading/configs/local-config.json`.

You only need to enter these once — they're saved for future runs.

---

## Running the Grader

### Interactive mode

```bash
node run_all.js
```

Shows a menu of available labs and grading modes:

1. **Normal** — grade new submissions (skips students who already have a grade spreadsheet)
2. **Regrade** — re-run all grading phases but keep existing cloned/extracted code; automatically runs `git pull` on each student's repo to pick up any updates
3. **Reclone** — delete all extracted code, re-clone/unzip from scratch, then re-grade

### Tests

```bash
npm test                # run all tests (Vitest)
npm run test:watch      # re-run tests on file changes
```

### Command-line mode

```bash
node run_all.js Lab04                        # grade Lab04 (normal mode)
node run_all.js Lab04 --regrade              # re-grade without re-cloning
node run_all.js Lab04 --reclone              # fresh clone + full grade
node run_all.js Lab04 --ai-comments          # grade with AI summary comments
node run_all.js Lab04 --ai-model=qwen3-coder # use a specific Ollama model
node run_all.js Lab04 --text-report          # generate .txt reports instead of spreadsheets
node run_all.js TermProject ApiDoc           # grade one step of a multi-step lab
node run_all.js TermProject                  # interactive step picker for multi-step lab
```

### Flags

| Flag | Effect |
|---|---|
| `--regrade` | Re-run analysis/lint/runtime/generation. Keeps existing extracted code. Runs `git pull` on cloned repos to pick up updated submissions. |
| `--reclone` | Delete all extracted code and re-clone/unzip from scratch. Implies `--regrade`. |
| `--ai-comments` | Generate a one-sentence AI summary for each student's rubric using a local Ollama model. Falls back to placeholder text if Ollama is not running. |
| `--ai-model=NAME` | Specify which Ollama model to use. Implies `--ai-comments`. |
| `--text-report` | Generate `.txt` grade reports instead of rubric spreadsheets. Use when a rubric template isn't available yet. |
| `--help`, `-h` | Show usage information. |

---

## What the Pipeline Does

For each student, the grader runs these phases in order:

1. **Code Acquisition** — unzips `.zip` files or clones GitHub repos
2. **Runtime Check** — runs `npm install && npm run build` (build mode), opens the app in headless Chrome (browser mode), or both (both mode), depending on the lab config. Also verifies that specified npm scripts (dev/build/preview) run without errors when the config includes a `scripts_check` mapping.
3. **Code Review Reading** — reads the student's `.docx` peer review form to extract per-item scores and the lab group letter (A/B/C)
4. **Analysis** — scans JavaScript files for required features using regex patterns
5. **Linting** — runs ESLint to flag code quality issues
6. **HTML Validation** — checks `.html`/`.htm` files for validity using `html-validate` (offline)
7. **CSS Validation** — checks `.css` files for syntax errors using `csstree-validator` (offline)
8. **File/Folder Name Check** — flags names with spaces or special characters that would break Linux deploys
9. **Grade Generation** — fills in the rubric spreadsheet with scores and comments

---

## Submission Groups

If Moodle exported submissions as separate groups (e.g., a Beta folder and a Production folder inside the lab directory), the grader will detect this automatically and ask which group to grade:

```
No submissions found directly in Lab05/. Found these submission groups:
  1) Lab05-Beta
  2) Lab05-Production

Select which group to grade (number) [2]:
```

Press Enter to accept the default (last group) or type a number.

---

## Manual Grading

The pipeline leaves some items for you to review manually:

| Comment in spreadsheet | What it means |
|---|---|
| `NEEDS MANUAL CHECK` | Score cell was left blank or pre-filled — inspect the student's work and enter the grade |
| `NEEDS CHECK: <url>` | The student provided a URL — visit it and verify the submission |
| `NEEDS MANUAL CHECK: … — verify deployment manually` | The deploy check couldn't reach the URL (network error, timeout) — check the site yourself before changing the score |
| `Pending manual checks for full verification.` | The summary cell — replace with your own comment (or use `--ai-comments`) |

Open each student's `StudentName_Grade.xlsx` (or `.xlsm`) file in Excel or LibreOffice, review the flagged items, fill in scores, and the formulas will auto-calculate the total.

---

## Tips & Troubleshooting

**Google Drive is slow:** The lab data lives on Google Drive, which can cause file reads to hang. If the pipeline seems stuck, check whether it's waiting on a Google Drive file read. The `codeRoot` setting moves cloned/extracted code off the cloud drive to avoid this.

**AI comments not working:** Ensure Ollama is running (`ollama serve`) and at least one model is installed. Run `ollama list` to check. The grader auto-selects the first available model; use `--ai-model=NAME` to pick a specific one.

**Re-cloning a single student:** If a student's repo changes after the initial clone, use `--reclone` to wipe everything and start fresh, or `--regrade` to run `git pull` on existing clones. There's no per-student reclone option.

**ESLint not installed:** Run `npm install` in the `AI_Grading/` directory. ESLint is a devDependency. The ESLint config at `~/.eslint/eslint.config.mjs` must also exist (shared with VS Code).

**HTML/CSS validator not installed:** Run `npm install`. `html-validate` and `csstree-validator` are listed as dependencies and run offline — no network or browser needed.

**Rubric not found:** If the rubric spreadsheet isn't in `configs/{AssignmentName}/`, the grader will prompt you to provide one or automatically switch to `--text-report` mode (generates `.txt` files instead).

**Output files:** Each student gets a graded spreadsheet (or `.txt` report) in `<codeRoot>/<labName>/SubmissionsAndAssessment/StudentName/` (flat) or `<codeRoot>/<labName>/<stepName>/SubmissionsAndAssessment/StudentName/` (multi-step). A `grading_log.txt` summary is written to the corresponding `ArtifactsAndRubrics/` folder, alongside JSON reports for each pipeline phase.
