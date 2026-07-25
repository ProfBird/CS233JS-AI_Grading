# CS233JS AI Grader — User Guide



[TOC]



## Overview

The AI Grader automates grading of student lab submissions for CS233JS. It was built
for JavaScript but also grades TypeScript, Python, C++, and C# assignments — pick the
language per-lab (see [Choosing a language](#choosing-a-language) below); JavaScript is
the default, so existing labs need no changes. It handles both ZIP uploads and GitHub
repository submissions, runs analysis/lint/runtime/validation checks, and fills in
rubric spreadsheets with scores and comments.

The pipeline is designed for a workflow where some items are auto-graded and others require manual instructor review.

---

## Prerequisites

- **Node.js** v20 or later (the grader's CI tooling — vitest 4, eslint 10, puppeteer 24 — and modern syntax like optional chaining / nullish assignment require it; `package.json` declares `"engines": { "node": ">=20" }`)
- **npm packages** (install once):
  ```
  npm install
  ```
  This installs `puppeteer`, `xlsx`, `adm-zip`, `mammoth`, `html-validate`, `csstree-validator`, `globals`, `eslint`, `typescript`/`@typescript-eslint/*`, and `vitest` (test runner).

- **Git** — required for cloning student repositories
- **unzip** — required for extracting ZIP submissions (pre-installed on macOS/Linux)
- **Ollama** (optional) — for AI-generated summary comments (`--ai-comments` flag)

**Only if grading Python/C++/C# labs** — these toolchains aren't npm packages and must
already be installed on the grading machine:
- **Python** — a Python 3 interpreter, plus `pip install ruff pytest`
- **C++** — a compiler (g++ or clang)
- **C#** — the .NET SDK

If a toolchain isn't on your PATH (e.g. a manually-installed MinGW g++), point at it via
`toolchains` in `configs/local-config.json` instead of adding it to PATH:
```json
{
  "terms": { "2026Spring": { "label": "Spring 2026", "labRoot": "...", "codeRoot": "..." } },
  "toolchains": {
    "python": "py",
    "cpp": { "compiler": "C:\\path\\to\\mingw64\\bin\\g++.exe" },
    "csharp": { "dotnet": "dotnet" }
  }
}
```
When a lab's toolchain isn't found, the grader prints a one-line warning with an
actionable hint at the start of that lab's run (rather than failing silently or
repeating the same failure for every student).

---

## Directory Setup

### Creating a new lab configuration

Use the interactive wizard to set up grading for a new lab:

```bash
node bin/configure-lab.js               # interactive, prompts for assignment name
node bin/configure-lab.js Lab07         # pre-specify a lab by number or name
node bin/configure-lab.js TermProject   # pre-specify a non-numbered assignment
```

The wizard will:
1. Ask you to pick a **course** (or create a new one — display name, course code, rubric-filename prefix). Every assignment lives under `configs/{Course}/`; with one course already set up, you can still pick "Add new course" from the list.
2. Ask whether the lab has **multiple sets of submissions** (e.g., Proposal, Beta, Production). If yes, it prompts for the first step name and creates a step-level config (`configs/{Course}/{AssignmentName}/{StepName}/`). Run the wizard again to add more steps.
3. Ask you to provide the rubric spreadsheet (.xlsx or .xlsm) and copy it into the config directory with the standard naming convention (using the course's rubric-filename prefix).
4. Read the rubric's Grade sheet and — using AI (or a heuristic fallback if no model is configured) — **draft a check type for each rubric row**. The types are listed under [Available checks](#available-checks-rubric-mapping-types) below.
5. Let you **review and edit** the drafted checks before saving: a navigable table where you can change a row's check type, adjust its fields (max score, etc.), or mark a row "graded by hand."
6. Prompt for the lab title, **language** (`javascript` by default; `typescript`/`python`/`cpp`/`csharp` also selectable), runtime-check mode (`browser` / `build` / `both` / `run_check`), and the optional summary / grader / title cells, then write `{assignmentname}_config.json`.

> **`feature` / `match` checks in the wizard:** the AI/heuristic draft won't auto-pick `feature` (a code pattern can't be guessed from a rubric label), but you can choose `feature` for any row during the review/edit step. The wizard then guides you through the detection rule — which files to search (a plain extension list like `js, mjs`, which it turns into the right `fileRegex`), then a **single regex**, or a simple **all-of** (AND) / **any-of** (OR) set of patterns — and writes both the rubric mapping and its `analysis.features[]` definition for you. (Nested OR-of-ANDs rules aren't generated — hand-edit the config for those; custom JS analyzers are **deprecated**, use a `match` check instead.) See [Available checks](#available-checks-rubric-mapping-types).

### Choosing a language

Pick a lab's language in the wizard's assignment-settings step, or by adding
`"language"` to the config by hand:

| Language | Value | What's used to grade it |
|---|---|---|
| JavaScript (default) | `javascript` | ESLint, `npm install`/`npm run build`, headless-Chrome console check |
| TypeScript | `typescript` | typescript-eslint, `tsc --noEmit` for type errors |
| Python | `python` | `ruff` for style/correctness, `py_compile` for syntax, `pytest` for tests |
| C++ | `cpp` | Compiler warnings/errors (g++/clang), direct compile-and-run |
| C# | `csharp` | `dotnet build`/`dotnet test` |

Omit `"language"` entirely for a JavaScript lab — that's the existing behavior, unchanged.

For non-web languages (Python/C++/C#), consider `runtimeCheck: "run_check"` instead of
`"browser"`/`"build"`: it builds (if applicable) and then actually runs the program,
feeding it `runCheck.stdin` and checking its output against `runCheck.expectPatterns`
(a list of regexes) — this suits a console-program assignment far better than a
browser-based check. Score it with the `run_check` mapping type. A `test_check` mapping
type is also available for labs that grade automated tests (pytest/dotnet test), scoring
proportionally to how many pass.

### Available checks (rubric mapping types)

Each rubric row in the config is a *mapping* with a `type` that tells the grader what to check, the `cell` / `commentCell` to write, and a `maxScore`. These are the available types — the wizard drafts most of them automatically; the ones marked **config-only** need a pattern you add by hand.

**Code features** — detect language/API usage in the student's source files:
- `feature` *(config-only)* — counts matches of a `regex` (full credit at `minCount`, default 1), **or** evaluates a boolean `match` rule for checks needing AND/OR of several patterns. Example: `"match": { "allOf": [{ "regex": "import\\s+.*from" }, { "regex": "export\\s+" }] }` requires both import and export; use `"anyOf"` for "any one of these implementations" (e.g. group A/B/C variations). Each pattern's presence is computed across all files, so an `allOf` matches even when its patterns live in different files.

**Code quality & validity:**
- `lint` — runs the lab's language-specific linter/analyzer (ESLint for JS/TS, `ruff` for Python, compiler warnings for C++/C#); set `severity: "errors"` (syntax) or `"warnings"` (style). The comment cell gets the actual findings (top issues by frequency), so `stockComments` has no effect on a `lint` row.
- `html_validate` / `css_validate` — validate `.html` / `.css`; partial credit up to a `tolerance` (default 3 errors).
- `name_check` — file/folder names must be Linux-safe (no spaces/special chars); `tolerance` default 2.

**Build & runtime** (require `runtimeCheck` set accordingly):
- `build_check` — the lab's build step succeeds (`npm run build` for JS, `tsc --noEmit` for TS, a syntax check for Python, compiling for C++, `dotnet build` for C#).
- `browser_check` — app loads in headless Chrome with no console errors (JS/TS web labs only).
- `build_and_browser_check` — both; half credit if only one passes.
- `run_check` — (needs `runtimeCheck: "run_check"`) the program runs and its output matches `runCheck.expectPatterns` — the console-program equivalent of `browser_check`, for Python/C++/C# labs.
- `test_check` — (needs a `test_check`-supporting lab, e.g. Python/C#) proportional credit for how many automated tests (pytest/dotnet test) pass.
- `scripts_check` — the named npm scripts (e.g. `dev,build,preview`) are defined and run. JS/TS only — other languages have no npm-style named-script concept.

> **Pick the right `runtimeCheck` mode:** `"browser"` serves the submission's *source* and only suits plain static sites. A Vite/bundled project has bare module imports the browser can't resolve unbuilt, so `"browser"` reports false load failures for it — set `runtimeCheck` to `"build"` (or `"both"` to also browser-check the built `dist/`) for any project with a build step.

**Repository & GitHub:**
- `github_repo` — a GitHub URL was submitted and the repo cloned.
- `collaborator_check` — instructor was added as a collaborator (proven by a successful clone).
- `gitignore_check` — `.gitignore` exists (add `requiredEntry`, e.g. `.env`, to also require an entry).
- `repo_hygiene` — excluded folders (`node_modules`, `dist`, …) were not committed.
- `apps_in_repo` — the app (or all app subfolders) exist in the cloned repo.

**Files & packages:**
- `package_check` (alias `manifest_check`) — the dependency manifest (`package.json` for JS/TS, `requirements.txt` for Python) has the required (and not the forbidden) dependencies.
- `npm_package` (alias `package_usage`) — a specific package/module is imported in the code. Use `package_usage` if it reads better for a non-JS lab — same check either way.
- `env_file_check` — a `.env` file with at least one `KEY=VALUE` was submitted (flags for manual review if absent — normal when gitignored).
- `path_exists` — any file whose path matches `pathPattern` exists (a "required file was created" check).
- `part1_completed` / `part_completed` — files for a lab part are present (multi-part labs with named subfolders).

**Web page content** (require a `webContent` block in the config; built for static HTML/CSS labs like CIS 195, where `runtimeCheck` is usually `"none"` and the lab sets `"textReport": true`):
- `element_check` — required HTML elements are present, found by real CSS-selector queries (`figure > img`, `a[href^='mailto']`, `input[type='tel']`, …) summed across every HTML page; proportional credit, comment lists what's missing. An optional `ids` list scores a subset of the configured elements (e.g. one row per lab part).
- `css_selector_check` — required CSS selectors (e.g. `nav`, `header`) appear as rules in external or embedded styles; optional `selectors` subset.
- `css_property_check` — required CSS properties are used anywhere (external files, `<style>` blocks, or inline `style=""`); accepts bare names (`grid-area`) or `prop: value` pairs (`display: grid`); optional `properties` subset.
- `file_count` — at least N files match a name pattern (e.g. 4 HTML files); `countId` names the `webContent.fileCounts` entry to score.

**Deployment & links:**
- `deploy_check` — fetches the deployment URL (`urlType`, default `citstudent`); full credit if live and bundled, half if live but unbundled (set `checkBundling: false` to skip that check entirely), flags for manual review if unreachable.
- `url_check` — fetches a submitted URL; full credit on HTTP 200.

**Review & manual:**
- `code_review` — peer code review submitted and the production column filled.
- `developer_comments` — code files contain developer name/date/header comments.
- `manual` — no automation; pulls the score from the student's peer code-review form, otherwise flagged `NEEDS MANUAL CHECK` for you to grade.

Any mapping may also carry `stockComments: { full, partial, zero }` to write a short canned comment per score tier instead of the verbose auto-generated one. A few checks keep their own diagnostic comment regardless — `lint` (writes the actual findings), and `deploy_check` when it flags a row for manual review — so `stockComments` is ignored on those rows.

### File layout

```
AI_Grading/                   ← this tool (git repo)
  ├── bin/grade.js              ← main entry point
  └── configs/
      ├── local-config.json   ← machine-specific paths, per term (auto-created, gitignored)
      └── {Course}/            ← e.g. CS233JS — see "Courses & terms" below
          ├── course_config.json  ← courseName/courseCode/rubricPrefix (optional; defaults to dir name)
          └── {AssignmentName}/
              ├── {assignmentname}_config.json     ← rubric config (flat lab)
              ├── CS233JS_{AssignmentName}_Rubric.xlsx  ← rubric template
              └── {StepName}/                      ← multi-step: one subdir per step
                  ├── {stepname}_config.json       ← e.g. apidoc_config.json
                  └── CS233JS_{StepName}_Rubric.xlsx

<labRoot>/                    ← one term's assignment data (on Google Drive)
  └── {Course}/
      └── {AssignmentName}/
          ├── StudentName_12345_assignsubmission_file/
          │   └── submission.zip
          └── StudentName_12345_assignsubmission_onlinetext/
              └── onlinetext.html

  # Multi-step labs: Moodle downloads live in step subdirectories
  └── {Course}/
      └── {AssignmentName}/
          └── {StepName}/
              ├── StudentName_12345_assignsubmission_file/
              └── StudentName_12345_assignsubmission_onlinetext/

  # Pre-course-tier installs: the grader also checks the flat <labRoot>/{AssignmentName}/
  # path if the nested one above doesn't exist yet — no forced reorganization required.

<codeRoot>/                   ← one term's local folder outside Google Drive
  └── {Course}/
      └── {AssignmentName}/   ← created automatically per assignment (flat lab)
          ├── Artifacts/
          │   └── ...
          └── SubmissionsAndAssessment/
              └── StudentName/
                  ├── repo/  (or extracted_code/)
                  └── StudentName_Grade.xlsx

  # Multi-step labs: each step gets its own output tree
  └── {Course}/
      └── {AssignmentName}/
          └── {StepName}/
              ├── Artifacts/
              └── SubmissionsAndAssessment/
                  └── StudentName/
                      └── StudentName_Grade.xlsx
```

### Flat labs vs. multi-step labs

**Flat lab** — a single submission set graded as one unit (Lab03, Lab06, etc.):
- One config file at `configs/{Course}/{AssignmentName}/{assignmentname}_config.json`
- Rubric template lives alongside the config
- Run: `node bin/grade.js Lab06`
- `configure-lab.js` creates this layout by default (answer "No" when asked about multiple submission sets)

**Multi-step lab** — separate submission sets for different stages of the same project (e.g., TermProject with DevEnvAndStaticSite, ApiDoc, Beta, Production):
- No top-level config file; each step gets its own subdirectory under `configs/{Course}/{AssignmentName}/{StepName}/`
- Each step subdir contains `{stepname_lower}_config.json` and its own rubric template
- If the labRoot has a matching step subdirectory (e.g. `<labRoot>/{Course}/TermProject/DevEnvAndStaticSite/`), submissions are read from there. If not, submissions are read from the lab root directly — the labRoot step layout is optional
- Run a specific step: `node bin/grade.js TermProject DevEnvAndStaticSite`
- Run interactively (step picker shown): `node bin/grade.js TermProject`
- `configure-lab.js` asks "Will there be multiple sets of submissions for this lab?" when creating a brand-new lab; run it once per step

**Converting a flat lab to multi-step** (e.g., you want to add a Beta step to a lab that currently only has a Production config):
```bash
mkdir configs/CourseName/LabName/StepName
mv configs/CourseName/LabName/labname_config.json configs/CourseName/LabName/StepName/stepname_config.json
mv configs/CourseName/LabName/*.xlsm configs/CourseName/LabName/StepName/
# Then edit rubricName in the moved config to remove any path prefix
```

---

### Courses & terms

Every assignment lives under a **course** (e.g. `CS233JS`), and `labRoot`/`codeRoot` are
resolved per named **term** (e.g. `"Spring 2026"`) rather than one fixed pair — so you can
keep grading past semesters' data around without it colliding with the current one, and (down
the road) grade more than one course.

- **Course** — a subdirectory of `configs/` with its own assignments (`configs/{Course}/{Lab}/…`), optionally described by a `configs/{Course}/course_config.json` (display name, banner code, rubric-filename prefix).
- **Term** — a named `{ label, labRoot, codeRoot }` entry, e.g. `"Spring 2026"` / id `2026Spring`, stored in `configs/local-config.json`'s `terms` map. This is what used to be the single flat `labRoot`/`codeRoot` pair.

Running `node bin/grade.js` with **no arguments** always shows a course picker and then a term
picker — even with just one option each, so "Add new course"/"Add new term" are always within
reach. A **shortcut** like `node bin/grade.js Lab03` (any invocation with a lab name typed
directly) skips both prompts and silently uses the single existing course/term, so your usual
one-line commands keep working exactly as before. Once you add a second course, position 0 of
the shortcut becomes the course name: `node bin/grade.js CS233JS Lab03`.

**CIS 195 (Web Authoring)** ships as a second course: `configs/CIS195/` has configs for
Lab01–Lab04, Lab06–Lab08, and TermProject, converted from the old standalone GradingAssistant
app (see `docs/CIS195_INTEGRATION.md` for what was converted and how). These are
`"textReport": true` labs — there are no rubric spreadsheets; each student gets a
`<Student>_Grade.txt` report, no `--text-report` flag needed. Put the Moodle downloads under
`<labRoot>/CIS195/Lab02/` (the same raw Moodle export layout as any other lab) and run:

```bash
node bin/grade.js CIS195 Lab02
```

### First-time setup

The first time you run the grader with no arguments, it walks you through:

1. **Course** — pick from existing courses, or "Add new course" (only one option the very first time, so this is effectively automatic).
2. **Term** — with none set up yet, you're prompted to create one: a label (e.g. `Spring 2026`), an id used as a folder-safe key (defaults to something like `2026Spring`), then the same two paths as before:
   - **Lab root** — the Google Drive folder containing your lab directories (e.g., `StudentLabWork`).
   - **Code storage root** — a folder *outside* Google Drive where student code will be cloned or unzipped. The grader creates subfolders for each course/lab automatically (e.g., `GradingCode/CS233JS/Lab03/SubmissionsAndAssessment/`), so you only need to provide the base path once.

Everything here is saved to `AI_Grading/configs/local-config.json` — you only need to enter it
once per term; future runs (and future courses in the same term) reuse it. To grade a new
semester, run the grader and choose "Add new term" when prompted.

---

## Running the Grader

### Interactive mode

```bash
node bin/grade.js
```

Walks through, in order: **course** (always shown, even with one option — see
[Courses & terms](#courses--terms)), **term**, **submission source**, **assignment**, then a
menu of grading modes. Each of these is an arrow-key popup list (the same full-screen
terminal UI `configure-lab.js`'s wizard uses) when your terminal supports it; running the
grader with output redirected to a file or pipe (`node bin/grade.js > log.txt`) falls back
to plain numbered-list prompts instead — either way, you can always answer with a number
or by typing the option's name. The submission-source prompt (shown right after the term) is:

1. **Assignment's configured source** *(default)* — the Moodle download folder, or Canvas for a lab that already has a Canvas assignment saved in its config
2. **Download from Canvas** — same as the `--canvas` flag: runs the interactive Canvas setup (course ID confirmation + assignment picker) so you can set up a lab for the first time or re-select its Canvas assignment, then downloads submissions via the Canvas API

Grading modes:

1. **Normal** — grade new submissions (skips students who already have a grade spreadsheet)
2. **Regrade** — re-run all grading phases but keep existing cloned/extracted code; automatically runs `git pull` on each student's repo to pick up any updates
3. **Reclone** — delete all extracted code, re-clone/unzip from scratch, then re-grade

### Tests

```bash
npm test                # run all tests (Vitest)
npm run test:watch      # re-run tests on file changes
```

### Command-line mode

Any invocation with a lab name skips the course/term pickers entirely and auto-resolves the
single existing course/term — see [Courses & terms](#courses--terms).

```bash
node bin/grade.js Lab04                        # grade Lab04 (normal mode)
node bin/grade.js Lab04 --regrade              # re-grade without re-cloning
node bin/grade.js Lab04 --reclone              # fresh clone + full grade
node bin/grade.js Lab04 --ai-comments          # grade with AI summary comments
node bin/grade.js Lab04 --ai-model=qwen3-coder # use a specific Ollama model
node bin/grade.js Lab04 --text-report          # generate .txt reports instead of spreadsheets
node bin/grade.js TermProject ApiDoc           # grade one step of a multi-step lab
node bin/grade.js TermProject                  # interactive step picker for multi-step lab
node bin/grade.js Lab04 --canvas               # import submissions from Canvas instead of a Moodle folder
node bin/grade.js CS233JS Lab04                # explicit course — only needed once 2+ courses exist
```

### Flags

| Flag | Effect |
|---|---|
| `--regrade` | Re-run analysis/lint/runtime/generation. Keeps existing extracted code. Runs `git pull` on cloned repos to pick up updated submissions. |
| `--reclone` | Delete all extracted code and re-clone/unzip from scratch. Implies `--regrade`. |
| `--ai-comments` | Generate a one-sentence AI summary for each student's rubric using a local Ollama model. Falls back to placeholder text if Ollama is not running. |
| `--ai-model=NAME` | Specify which Ollama model to use. Implies `--ai-comments`. |
| `--text-report` | Generate `.txt` grade reports instead of rubric spreadsheets. Use when a rubric template isn't available yet. |
| `--canvas` | Import submissions directly from Canvas instead of a Moodle download folder. First use prompts for a Canvas course ID, confirms the course name, then lets you pick the assignment; saved for later runs. |
| `--help`, `-h` | Show usage information. |

---

## What the Pipeline Does

For each student, the grader runs these phases in order. Steps 2, 4, and 5 use whichever
language's tooling the lab is configured for (JavaScript by default) — see
[Choosing a language](#choosing-a-language).

1. **Code Acquisition** — unzips `.zip` files or clones GitHub repos
2. **Runtime Check** — depending on the lab config: builds (`npm run build` / `tsc` / a Python syntax check / compiling / `dotnet build`), opens the app in headless Chrome, does both, or (`run_check`) builds and then actually runs the program, checking its output. Also verifies that specified npm scripts (dev/build/preview) run without errors when the config includes a `scripts_check` mapping, and runs the language's test suite (pytest/dotnet test) when it includes a `test_check` mapping.
3. **Code Review Reading** — reads the student's `.docx` peer review form to extract per-item scores and the lab group letter (A/B/C)
4. **Analysis** — scans the lab's source files for required features using regex patterns
5. **Linting** — runs the language's linter/analyzer (ESLint for JS/TS, `ruff` for Python, compiler warnings for C++/C#) to flag code quality issues
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

**ESLint/TypeScript not installed:** Run `npm install` in the `AI_Grading/` directory — ESLint and the TypeScript tooling are both devDependencies. The ESLint config at `eslint/student.eslint.config.mjs` (or `student.typescript.eslint.config.mjs` for TS) must also exist (shared with VS Code).

**HTML/CSS validator not installed:** Run `npm install`. `html-validate` and `csstree-validator` are listed as dependencies and run offline — no network or browser needed.

**Python/C++/C# toolchain not found:** The grader prints a warning with an actionable hint at the start of that lab's run (e.g. "Install a compiler ... and set config.toolchains.cpp.compiler"). See [Prerequisites](#prerequisites) for what to install, and point `configs/local-config.json`'s `toolchains` section at it if it's not on your PATH.

**`run_check` executes student code directly on this machine:** unlike the browser check (sandboxed by Chrome) or `npm run build` (no arbitrary execution), `run_check` compiles/interprets and then *runs* the student's program with your machine's permissions. This is appropriate for grading known students in a classroom setting, not for anonymous or adversarial submissions — see `src/lib/sandbox.js`'s documentation if you need to understand the isolation model in more depth.

**Rubric not found:** If the rubric spreadsheet isn't in `configs/{Course}/{AssignmentName}/`, the grader will prompt you to provide one or automatically switch to `--text-report` mode (generates `.txt` files instead).

**Output files:** Each student gets a graded spreadsheet (or `.txt` report) in `<codeRoot>/<courseName>/<labName>/SubmissionsAndAssessment/StudentName/` (flat) or `<codeRoot>/<courseName>/<labName>/<stepName>/SubmissionsAndAssessment/StudentName/` (multi-step) — under that term's `codeRoot` (see [Courses & terms](#courses--terms)). A `grading_log.txt` summary is written to the corresponding `Artifacts/` folder, alongside JSON reports for each pipeline phase.
