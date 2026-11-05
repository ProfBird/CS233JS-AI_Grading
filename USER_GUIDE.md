<h1>CS233JS AI Grader — User Guide</h1>



[TOC]

## Overview

The AI Grader automates grading of student lab submissions for CS233JS. It was built
for JavaScript but also grades TypeScript, Python, C++, and C# assignments — pick the
language per-lab (see [Choosing a language](#choosing-a-language) below); JavaScript is
the default, so existing labs need no changes. It handles ZIP uploads, loose uploaded files, and
GitHub repository submissions, runs analysis/lint/runtime/validation checks, and fills in
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
- **Python** — a Python 3 interpreter, plus `pip install ruff pytest`. For labs that run
  or test students' **uv projects** (a `pyproject.toml` — every CS 212 lab), also install
  [uv](https://docs.astral.sh/uv/getting-started/installation/); the grader uses it to
  install each project's dependencies (see [Python labs](#python-labs-uv-projects)).
- **C++** — a compiler (g++ or clang)
- **C#** — the .NET SDK

If a toolchain isn't on your PATH (e.g. a manually-installed MinGW g++), point at it via
`toolchains` in `configs/local-config.json` instead of adding it to PATH:
```json
{
  "terms": { "2026Spring": { "label": "Spring 2026", "labRoot": "...", "codeRoot": "..." } },
  "toolchains": {
    "python": "py",
    "uv": "C:\\Users\\me\\.local\\bin\\uv.exe",
    "cpp": { "compiler": "C:\\path\\to\\mingw64\\bin\\g++.exe" },
    "csharp": { "dotnet": "dotnet" }
  }
}
```
When a lab's toolchain isn't found, the grader prints a one-line warning with an
actionable hint at the start of that lab's run (rather than failing silently or
repeating the same failure for every student).

---

## Quick Start

The short path from "new lab" to "graded spreadsheets." Each step links to the full details.

**One-time setup**

1. In the `AI_Grading/` folder, run `npm install`.
2. For a lab that isn't JavaScript, install its toolchain too — e.g. a Python lab needs
   Python, `pip install ruff pytest`, and [uv](https://docs.astral.sh/uv/) for `pyproject.toml`
   projects (all of CS 212). See [Prerequisites](#prerequisites).
3. The first time you run `node bin/grade.js`, it asks you to create a **term**: a label
   (e.g. `Spring 2026`), the **lab root** (where submission downloads live) and the **code
   storage root** (a local folder for students' code and the graded spreadsheets). See
   [First-time setup](#first-time-setup).

**Set up a lab** — run the wizard (once per lab, or once per step of a multi-step lab):

```bash
node bin/configure-lab.js
```

It asks, in order:

1. **AI model for draft generation** — the model that drafts the checks. If none can be
   used, it falls back to a simpler keyword-based draft.
2. **Course** — pick one, or "Add new course".
3. **Assignment** — pick one, or "Add new assignment" (e.g. `Lab07`). For a new assignment:
   "Will there be multiple sets of submissions for this lab?" (No for an ordinary lab; Yes for
   one with steps like Proposal/Beta/Production).
4. **Rubric** — for a new lab, choose "Provide a rubric file path", enter the path to your
   `.xlsx`/`.xlsm` rubric, and accept the suggested filename (e.g. `CS233JS_Lab07_Rubric.xlsm`);
   it's copied into the lab's config folder. (If a spreadsheet is already in
   `<codeRoot>/{Course}/{Lab}/`, it offers that one first.) Then confirm the detected columns
   ("Are these columns correct?").
5. **Review the draft** — a table with one check per rubric row. Arrow keys move, Enter
   edits a row (change its check type or fields, or mark it graded by hand), `a` accepts.
6. **Assignment settings** — title, **language** (`javascript` by default; `python` for
   CS 212), **runtime check mode** (`browser`/`build`/`both` for web labs, `run_check` to run
   a console program), and optional summary/grader/title cells.

It writes `configs/{Course}/{Lab}/{lab}_config.json` (e.g. `configs/CS233JS/Lab07/lab07_config.json`).
Some settings the wizard doesn't ask about — a Python program's `runCheck` input and expected
output, test scripts, lab groups — you add to that file by hand; see
[Python labs](#python-labs-uv-projects) and
[Lab groups and labs with several programs](#lab-groups-and-labs-with-several-programs).
Full wizard details: [Creating a new lab configuration](#creating-a-new-lab-configuration).

> **No rubric spreadsheet?** The wizard can't draft checks without one; its only other choice
> is "Extract-only" (collect the code, grade nothing). For `.txt` grade reports instead of
> spreadsheets, add `"textReport": true` to the lab config (as the CIS 195 labs do), or run the
> grader with `--text-report`.

**Get the submissions**

- **Moodle:** download the assignment's submissions and unzip them into
  `<labRoot>/{Course}/{Lab}/` (e.g. `<labRoot>/CS233JS/Lab07/`). See [File layout](#file-layout).
- **Canvas:** nothing to download — choose "Download from Canvas" in the grader's menu, or
  add `--canvas`. The first time, it asks for your Canvas URL and an API token (Canvas:
  Account → Settings → New Access Token) unless `CANVAS_URL`/`CANVAS_TOKEN` are set, then the
  Canvas course ID and which assignment to use. All of it is saved, so on later runs the
  default "Assignment's configured source" downloads from Canvas.

**Grade it**

```bash
node bin/grade.js
```

The menu asks for the **course**, **term**, **submission source** ("Assignment's configured
source" — the Moodle folder, or Canvas once the lab is set up for it — or "Download from
Canvas"), **assignment** (and step, for a
multi-step lab), then the grading mode:

- **Normal** — grade new submissions; students who already have a grade spreadsheet are skipped.
- **Regrade** — grade everyone again, keeping their code (cloned repos get a `git pull` first).
- **Reclone** — delete everyone's code, download/clone it again, then grade.

To go straight to an assignment, name the course and lab on the command line (it still asks
for the term if you have more than one). The course name comes first whenever more than one
course exists under `configs/`, as it does now:

```bash
node bin/grade.js CS233JS Lab03              # still asks Normal / Regrade / Reclone
node bin/grade.js CS212 Lab02 --regrade      # no mode menu
node bin/grade.js CS233JS TermProject ApiDoc # one step of a multi-step lab
```

See [Command-line mode](#command-line-mode) and [Flags](#flags) for the rest.

**Review the results**

- Each student's graded rubric is `StudentName_Grade.xlsx` / `.xlsm` (or `StudentName_Grade.txt`
  for a text-report lab) in `<codeRoot>/{Course}/{Lab}/SubmissionsAndAssessment/StudentName/`,
  next to their code. For a multi-step lab, add the step folder: `{Lab}/{Step}/…`.
- `<codeRoot>/{Course}/{Lab}/Artifacts/grading_log.txt` summarizes the run.
- Look for rows marked `NEEDS MANUAL CHECK` and other flagged comments, then fill in those
  scores yourself — see [Manual Grading](#manual-grading).

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
| Python | `python` | `ruff` for style/correctness, `py_compile` for syntax, uv for dependencies, `pytest` or the student's own PASS/FAIL test script for tests |
| C++ | `cpp` | Compiler warnings/errors (g++/clang), direct compile-and-run |
| C# | `csharp` | `dotnet build`/`dotnet test` |

Omit `"language"` entirely for a JavaScript lab — that's the existing behavior, unchanged.

For non-web languages (Python/C++/C#), consider `runtimeCheck: "run_check"` instead of
`"browser"`/`"build"`: it builds (if applicable) and then actually runs the program,
feeding it `runCheck.stdin` and checking its output against `runCheck.expectPatterns`
(a list of regexes) — this suits a console-program assignment far better than a
browser-based check. Score it with the `run_check` mapping type. A `test_check` mapping
type is also available for labs that grade automated tests (pytest, a student's own
PASS/FAIL test script, or dotnet test), scoring proportionally to how many pass.

### Python labs (uv projects)

CS 212 students build each lab as a **uv project** (`uv init`, `uv add …`, run with
`uv run main.py` from the project folder). The grader handles that layout directly:

- **Project folder** — the folder holding `pyproject.toml` (students often zip a parent
  folder around it; that's fine). Programs run *from* this folder, so relative paths like
  `Data/instructors.csv` work the way they do for the student.
- **Dependencies** — installed with `uv sync` into an environment the grader keeps in a
  cache folder, never inside the student's submission. Students whose `pyproject.toml`,
  `uv.lock` and `.python-version` are identical share one environment, so a class that kept
  your starter `pyproject.toml` installs once. The **first** install of a dependency set can
  take minutes (TensorFlow especially); later runs reuse it.
- **Which program runs** — `runCheck.entry` (a filename like `"scheduler.py"` or a path like
  `"src/main.py"`), else `main.py`, else the only `.py` file.
- **Instructor data** — `runCheck.supportFiles` lists files/folders (relative to the lab's
  config folder) to put next to the program, for labs where students don't submit the data.
  Each is added only where the student has no file of their own, so a student who edited
  the data keeps their version.
- **Tests** — `testCheck.mode: "script"` runs the student's own test script (`testCheck.entry`)
  and counts its `PASS:` / `FAIL:` lines — the plain-`assert` driver format CS 212's Lab02
  teaches. A crash partway through counts as one more failure. The default mode,
  `"pytest"`, runs pytest (installed into the environment automatically).

Example — a CS 212 Lab02 config (CS 212's course defaults already set `"language": "python"`
and `"execution": { "cwd": "copy" }`, so the lab doesn't repeat them):

```json
{
  "rubricName": "CS212_Lab02_Rubric.xlsm",
  "runtimeCheck": "run_check",
  "runCheck": {
    "entry": "main.py",
    "supportFiles": ["Data"],
    "expectPatterns": ["S01", "Conflicting rules"],
    "timeoutMs": 60000
  },
  "testCheck": { "mode": "script", "entry": "test_scheduler.py" },
  "packageCheck": { "dependencies": ["z3-solver"] },
  "mappings": [
    { "type": "run_check",  "cell": "C8",  "commentCell": "E8",  "maxScore": 3 },
    { "type": "test_check", "cell": "C9",  "commentCell": "E9",  "maxScore": 8 },
    { "type": "package_check", "cell": "C10", "commentCell": "E10", "maxScore": 1 }
  ]
}
```

Other settings (all optional): `execution.envCacheDir` (where environments are cached;
default your system temp folder), `execution.installTimeoutMs` (default 10 minutes), and
`testCheck.passPattern` / `failPattern` for a test script that prints something other than
`PASS`/`FAIL`. For per-group (A/B/C) settings and labs with several programs, see the
next section.

**Notebooks and Colab links** (CS 212's Lab05, or anyone who submits a `.ipynb`): a
notebook is read as a Python script — its code cells as code and its markdown cells as
comments — so feature checks, the developer name/date/AI-use check, the dependency check and
ruff all see it. (Use a `fileRegex` like `"\\.(py|ipynb)$"` on feature checks that should
look in notebooks.) Notebooks are checked, not run. When a student's whole submission is a
**Colab link**, the grader downloads the notebook itself — but only if the student shared it
as **"Anyone with the link"**; otherwise the student is listed with the error *Colab notebook
could not be downloaded — it is probably not shared…*, and you can download it from the link
and drop it into their `extracted_code/` folder. Colab links are recognized when the lab's
`urlPatterns` has `"colab": "colab.research.google.com"` (CS 212's course defaults include it).

### Lab groups and labs with several programs

**Several programs in one submission** — CS 212's Lab01, for example, has a translated
program and a separate expert system. Make `runCheck` (and `testCheck`) a list, give each
entry an `id`, and point each rubric row at one with `runId` / `testId`:

```json
"runCheck": [
  { "id": "translated", "entry": ["shipping_calculator.py", "shipping_cost.py"], "stdin": "7\nB\n", "expectPatterns": ["Cost: 20"] },
  { "id": "expert", "entry": "recommender.py", "stdin": "long\nhigh\n", "expectPatterns": ["Diversified"] }
],
"testCheck": [
  { "id": "translatedTests", "mode": "script", "entry": ["test_shipping.py", "test_shipping_calculator.py"] },
  { "id": "expertTests", "mode": "script", "entry": "test_recommender.py" }
],
"mappings": [
  { "type": "run_check",  "runId": "translated",      "cell": "C10", "commentCell": "E10", "maxScore": 3 },
  { "type": "test_check", "testId": "translatedTests", "cell": "C9",  "commentCell": "E9",  "maxScore": 4 }
]
```

- `entry` can be a list of names to try in order, since students name their files freely.
  If none is found, the row is flagged `NEEDS MANUAL CHECK` instead of scoring 0, and the
  same goes for a missing test script.
- Each test script gets its own `supportFiles` when it needs instructor data — a run's
  `supportFiles` aren't shared with the tests once `runCheck` is a list.
- Give each run the `stdin` its program reads. A console program that asks for more input
  than it gets crashes (`EOFError`), and the run fails.
- A `run_check` row without `runId` needs every run to pass; a `test_check` row without
  `testId` scores the totals across all the test scripts.

**Per-group settings** — when lab groups solve different problems (CS 212's Lab02 groups
schedule class sections, flights or van deliveries), give each group in `variations` the
settings that differ in `overrides`:

```json
"runCheck": { "entry": "main.py", "timeoutMs": 60000 },
"variations": {
  "A": { "appName": "Class Section Scheduler", "overrides": { "runCheck": { "supportFiles": [{ "from": "GroupA-Data", "to": "Data" }], "expectPatterns": ["S01"] } } },
  "B": { "appName": "Flight Crew Scheduler",   "overrides": { "runCheck": { "supportFiles": [{ "from": "GroupB-Data", "to": "Data" }], "expectPatterns": ["F01"] } } },
  "C": { "appName": "Van Delivery Scheduler",  "overrides": { "runCheck": { "supportFiles": [{ "from": "GroupC-Data", "to": "Data" }], "expectPatterns": ["D01"] } } }
}
```

- **Which group a student is in** comes from their code review form ("Developer's lab
  version (A, B, or C)"). If the form doesn't say, it's detected from the code by matching the
  group's `appName` against folder names, page titles, the `package.json` / `pyproject.toml`
  name, and the README. If the form and the code disagree, the form wins and the log says so.
- **What can be overridden:** `runCheck`, `testCheck`, `execution`, `analysis` (feature
  checks), `packageCheck`, and `webContent`. Settings merge with the lab's own: a nested
  object merges key by key, and a list replaces the lab's list. Keep feature `id`s the same in
  every group, so the shared rubric rows find them.
- **Group unknown:** when a student's group can't be worked out (no form, and nothing
  detected), every rubric row that depends on an overridden setting is flagged
  `NEEDS MANUAL CHECK: lab group unknown …` instead of being checked with another group's
  settings.
- **Validation:** the config check validates each group's combined settings separately. For
  example, a `runId` a rubric row uses must exist for every group.

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
- `run_check` — (needs `runtimeCheck: "run_check"`) the program runs and its output matches `runCheck.expectPatterns` — the console-program equivalent of `browser_check`, for Python/C++/C# labs. `runId` scores one program of a lab with several (see [Lab groups and labs with several programs](#lab-groups-and-labs-with-several-programs)).
- `test_check` — (needs a `test_check`-supporting lab, e.g. Python/C#) proportional credit for how many automated tests pass: pytest, dotnet test, or — with `testCheck.mode: "script"` — the student's own test script, counted by its `PASS`/`FAIL` lines (see [Python labs](#python-labs-uv-projects)). `testId` scores one test script of several.
- `scripts_check` — the named npm scripts (e.g. `dev,build,preview`) are defined and run. JS/TS only — other languages have no npm-style named-script concept.

> **Pick the right `runtimeCheck` mode:** `"browser"` serves the submission's *source* and only suits plain static sites. A Vite/bundled project has bare module imports the browser can't resolve unbuilt, so `"browser"` reports false load failures for it — set `runtimeCheck` to `"build"` (or `"both"` to also browser-check the built `dist/`) for any project with a build step.

**Repository & GitHub:**
- `github_repo` — a GitHub URL was submitted and the repo cloned.
- `collaborator_check` — instructor was added as a collaborator (proven by a successful clone).
- `gitignore_check` — `.gitignore` exists (add `requiredEntry`, e.g. `.env`, to also require an entry).
- `repo_hygiene` — excluded folders (`node_modules`, `dist`, …) were not committed.
- `apps_in_repo` — the app (or all app subfolders) exist in the cloned repo.

**Files & packages:**
- `package_check` (alias `manifest_check`) — the dependency manifest (`package.json` for JS/TS; `pyproject.toml`, else `requirements.txt`, for Python) has the required packages (`packageCheck.dependencies` / `devDependencies` — JS also checks each is in the right section), and every declared package is actually imported somewhere, unless listed in `packageCheck.allowedExtras`. For Python, the grader knows that `scikit-learn` is imported as `sklearn`, `z3-solver` as `z3`, and so on; add others with `packageCheck.importAliases` (e.g. `{ "my-dist": "mymod" }`). Packages in `pyproject.toml`'s dev groups (pytest, ruff) count as declared but needn't be imported.
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
- `code_review` — peer code review submitted and its production column filled in. The production column is whichever is headed "Prod.", "Release" or "Final" (CS 233JS forms say "Prod.", several CS 212 forms say "Release").
- `developer_comments` — source files have a developer header comment. Only **comments** count (a Python file's module docstring included — not function/class docstrings, whose `name:`/`date:` parameter lists would otherwise count), so code like `name = input("Name: ")` doesn't. A file "has" a header when its comments contain a name (an `Author:`/`Written by`-style keyword, or the student's own first or last name) or a date (a `Date:` keyword or an actual date like `1/5/2026`, `Jan 5`, `Fall 2025`). Options:
  - `scope: "each"` — every non-empty source file needs a header (default `"any"`: one file is enough). The comment lists each file that's missing one and what it lacks.
  - `requireAiDisclosure: true` — also require an AI-use disclosure ("AI used: Copilot for …", "No AI was used", any mention of ChatGPT/Copilot/Claude/Gemini/LLM, …) in the file's first 40 lines. CS 233JS Lab01–Lab04 turn this on, because their review forms ask for "description of any AI used (and how)"; later labs set it to `false`.
  - `require: ["name", "date", "ai"]` — require specific parts instead of "name or date".
  - `ignoreCommentsBy: ["Brian Bird"]` — ignore comment lines that mention these names, so your own header on starter files ("By Brian Bird, winter term 2026, using GitHub Copilot") doesn't count as the student's. A line that also names the student still counts ("Andy Still, Jan 2026, based on code by Brian Bird").
- `manual` — a row for you to grade by hand: it's written with `maxScore` and the `msg` comment (default `NEEDS MANUAL CHECK`) for you to confirm or change. Add `reviewRow` to pre-score it from the student's peer code-review form instead: text from the review question (e.g. `"game work correctly"`), matched case-insensitively. The production answer is used — Yes → full credit, No → 0, a fraction like `4/5` → that score — falling back to a beta-column fraction. For a rubric row that covers two review questions, give a list (`["repository private", "collaborators"]`): every answer must be Yes for full credit. When a form repeats a question (e.g. CS 233JS Lab03 asks "Does the game work correctly?" for Part 1 and Part 2), `reviewRowOccurrence: 2` picks the second one. If the review is missing or the question isn't answered, the row stays a placeholder.
- `llm_check` *(config-only or wizard)* — for qualitative rows a pattern can't judge ("rule design", "moderately complex", "explanations in comments"): an AI model reads the student's code and **suggests** a score for one `criterion` (the rubric row as a question), optionally guided by `guidance` (what full / partial / no credit look like). The comment always starts `NEEDS REVIEW (AI suggestion, <model>)` with the model's reason — check each one before you rely on it. Example: `{ "type": "llm_check", "criterion": "Is input/output separated from the inference code?", "guidance": "Full: no input()/print() in the inference module", "cell": "C11", "commentCell": "E11", "maxScore": 2 }`. Add `"files": "\\.(py|csv)$"` to let it read files other than the code (e.g. a rule file).
  - **Where student code goes:** by default a **local Ollama** model on this computer (install Ollama and a model, e.g. `ollama pull qwen3-coder`), so student work never leaves the machine. A lab or course can set `"llmCheck"` to use a cloud model instead: `"provider": "anthropic"`, `"openrouter"`, or `"openai"` for any OpenAI-compatible service such as DeepSeek (`{ "provider": "openai", "baseUrl": "https://api.deepseek.com", "model": "…" }`). That sends student code to that company, so only do it where your college's student-privacy rules allow. The student's name (and e-mail addresses, GitHub account names, and any extra words you list in `redactTerms`) is replaced with `[STUDENT]` etc. before sending (`"redactNames": false` turns this off). The API key comes from the `LLM_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` environment variable, or from `configs/local-config.json`. Other settings: `model`, `maxChars` (how much code it reads, default 40,000 characters), `timeoutMs`, `concurrency` (requests at once, default 4 — all students' rows are requested up front, so a regrade takes minutes, not hours), and `cache` (default on: each answer is saved in the student's folder as `.llm_check_cache.json`, so a regrade of unchanged code makes no AI calls and gives the same suggestion; delete that file or set `"cache": false` to ask again). `node bin/configure-lab.js` asks for the provider and address when a lab has `llm_check` rows.
  - Each row is one model request per student, so a local model may take a while for a whole class.

Any mapping may also carry `stockComments: { full, partial, zero }` to write a short canned comment per score tier instead of the verbose auto-generated one. A few checks keep their own diagnostic comment regardless — `lint` (writes the actual findings), and `deploy_check` when it flags a row for manual review — so `stockComments` is ignored on those rows.

### File layout

```
AI_Grading/                   ← this tool (git repo)
  ├── bin/grade.js              ← main entry point
  └── configs/
      ├── local-config.json   ← machine-specific paths, per term (auto-created, gitignored)
      └── {Course}/            ← e.g. CS233JS — see "Courses & terms" below
          ├── course_config.json  ← courseName/courseCode/rubricPrefix/defaults (optional; names default to dir name)
          ├── ruff.toml / eslint.config.mjs  ← optional course-wide lint rules (e.g. configs/CS212/ruff.toml)
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

- **Course** — a subdirectory of `configs/` with its own assignments (`configs/{Course}/{Lab}/…`), optionally described by a `configs/{Course}/course_config.json` (display name, banner code, rubric-filename prefix, Canvas course ID, and shared lab settings — see below).
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

**CS 212 (AI Programming 1)** is set up as a third course: `configs/CS212/` has its course
config (Python by default) and course lint rules, but **no lab configs yet** — add them with
`node bin/configure-lab.js`. Until then, picking CS212 in the grader's menu stops with a
message telling you to do that. See [Python labs](#python-labs-uv-projects) for how its uv
projects are run and tested.

#### Settings shared by every lab in a course

A `defaults` block in `course_config.json` holds settings every lab in the course should
have, so they aren't repeated in each lab config. CS 212's:

```json
{
  "courseName": "CS212",
  "courseCode": "CS212",
  "rubricPrefix": "CS212",
  "defaults": {
    "language": "python",
    "execution": { "cwd": "copy" }
  }
}
```

- A lab's own config wins wherever it sets the same thing. Nested settings such as
  `execution` or `codeReview` merge key by key (a lab can change just `execution.timeoutMs`);
  lists such as `lint.exclude` replace the course's list rather than adding to it.
- The merge happens each time you grade; the course settings are never copied into your lab
  config files.
- Settings that only make sense per assignment — `mappings`, `rubricName`, `canvas`,
  `handlerModules` — can't go in `defaults`; the grader stops with an error naming the one
  that's there.

A course can also have its own lint rules: `configs/{Course}/ruff.toml` for Python or
`configs/{Course}/eslint.config.mjs` for JavaScript/TypeScript. The grader uses the first it
finds of: the step's file, the lab's file, the course's file, then the shipped default.
CS 212's `ruff.toml` adds the naming-convention (`N`) and import-order (`I`) checks its style
checklist grades.

### First-time setup

The first time you run the grader with no arguments, it walks you through:

1. **Course** — pick from existing courses, or "Add new course" (only one option the very first time, so this is effectively automatic).
2. **Term** — with none set up yet, you're prompted to create one: a label (e.g. `Spring 2026`), an id used as a folder-safe key (defaults to something like `2026Spring`), then the same two paths as before:
   - **Lab root** — the Google Drive folder containing your lab directories (e.g., `StudentLabWork`).
   - **Code storage root** — a folder *outside* Google Drive where student code will be cloned or unzipped. The grader creates subfolders for each course/lab automatically (e.g., `GradingCode/CS233JS/Lab03/SubmissionsAndAssessment/`), so you only need to provide the base path once.

   Both are chosen with a **folder browser**: open folders by name (or number, or arrow keys in the full-screen view), go up a level, or jump to Home, your drives (`/Volumes`) or your Google Drive folder, then pick **[Use this folder]**. **[Type a path...]** lets you paste a path instead.

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

### Leaving students out

Add `"skipStudents": ["Test Student"]` to a lab's config (the lab wizard asks) to leave placeholder or withdrawn students out of grading entirely.

### Instructor check scripts ("drivers")

When students were not given unit tests, give each lab group a folder of check scripts that print one `PASS`/`FAIL` line per case, and score them with `test_check`. The master copies live in the course-materials repo (students get them too); the grader keeps a copy in the lab's config folder so the config needs no path into another repo. Refresh the copy, or just compare, with:

```bash
node bin/sync-drivers.js <course-materials lab folder holding Group<X>/drivers> configs/CS212/Lab01
node bin/sync-drivers.js <same folder> configs/CS212/Lab01 --check
```

Set `"strict": true` on a `testCheck` entry (or `"env": { "LAB_STRICT": "1" }`) once the lab instructions fix the function names, so the scripts call only those functions and guess nothing.

### Viewing a rubric as Markdown

```bash
node bin/rubric-to-md.js configs/CS233JS/Lab03/CS233JS_Lab03_Rubric.xlsm           # writes CS233JS_Lab03_Rubric.md next to it
node bin/rubric-to-md.js configs/CS233JS/Lab03/CS233JS_Lab03_Rubric.xlsm -o rubric.md
```

Writes the rubric's Grade sheet as a Markdown table — handy for checking a rubric's rows
while writing a lab config. Works with rubrics headed "Possible" or "Points".

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

For each student, the grader runs these phases in order. Steps 3, 4, and 5 use whichever
language's tooling the lab is configured for (JavaScript by default) — see
[Choosing a language](#choosing-a-language).

1. **Code Acquisition** — clones the student's GitHub repo if they linked one; otherwise unzips their `.zip`, adding any loose files they uploaded next to it (the zip's copy wins if both have the same file name). A submission of only loose files — e.g. CS 212's bare `.py` and `.csv` uploads — uses those files. Word documents (the review form) and hidden files are never treated as code.
2. **Code Review Reading** — reads the student's `.docx` peer review form: the beta and production answers for every question in every table headed Beta / Prod. (or Release), and the lab group letter (A/B/C). The student's **lab group** is settled here too: the form's letter, else detected from the code (see [Lab groups](#lab-groups-and-labs-with-several-programs)).
3. **Runtime Check** — depending on the lab config: builds (`npm run build` / `tsc` / a Python syntax check / compiling / `dotnet build`), opens the app in headless Chrome, does both, or (`run_check`) installs the program's dependencies (for a Python uv project, a cached environment built with `uv sync`), builds it if needed, then actually runs it and checks its output — in an empty temporary folder, or with `execution.cwd: "copy"` in a temporary copy of the student's project folder plus any `runCheck.supportFiles`. Also verifies that specified npm scripts (dev/build/preview) run without errors when the config includes a `scripts_check` mapping, and runs the lab's tests (pytest, dotnet test, or the student's own PASS/FAIL test script) when it includes a `test_check` mapping.
4. **Analysis** — scans the lab's source files for required features using regex patterns
5. **Linting** — runs the language's linter/analyzer (ESLint for JS/TS, `ruff` for Python, compiler warnings for C++/C#) to flag code quality issues
6. **HTML Validation** — checks `.html`/`.htm` files for validity using `html-validate` (offline). Skipped for Python/C++/C# labs unless the rubric has an `html_validate` row.
7. **CSS Validation** — checks `.css` files for syntax errors using `csstree-validator` (offline). Skipped for Python/C++/C# labs unless the rubric has a `css_validate` row.
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
| `… [Production: Yes]` / `[Production: No]` / `[Production score: 4]` / `[Beta score: 3]` | A `manual` row pre-scored from the student's review form (its `reviewRow`) — check the work agrees before keeping the score |
| `… [review row "…" not found on code review form]` | A `manual` row's `reviewRow` text didn't match any question on this student's form (an older form, or edited questions) — grade it yourself |
| `Missing name/date comments in 2 of 5 files: rules.py (name/date); …` | A `developer_comments` row (with `scope: "each"` or `require`) — the listed files lack the listed parts of the header |
| `No AI use found in any file's header comments` | A `developer_comments` row with `requireAiDisclosure` — no file's header says whether/how AI was used |
| `NEEDS MANUAL CHECK: lab group unknown (…); this row depends on the group` | The lab has per-group settings and this student's group couldn't be worked out (no group on the review form, nothing detected) — check which version they did and grade the row |
| `NEEDS MANUAL CHECK: Entry file "…" not found` / `None of the entry files were found (…)` | The program or test script to run wasn't found — the student may have named it differently; find it and check by hand (or add the name to `entry`) |
| `NEEDS REVIEW (AI suggestion, <model>): …` | An `llm_check` row — the score is the AI model's suggestion with its reason. Read the student's work for that criterion and confirm or change the score |
| `NEEDS MANUAL CHECK: AI check unavailable (…)` | The `llm_check` row couldn't be scored (no model running, no reply, or an unusable reply) and was given 0 — grade it yourself, or fix the cause (e.g. start Ollama) and `--regrade` |
| `Pending manual checks for full verification.` | The summary cell — replace with your own comment (or use `--ai-comments`) |

Open each student's `StudentName_Grade.xlsx` (or `.xlsm`) file in Excel or LibreOffice, review the flagged items, fill in scores, and the formulas will auto-calculate the total.

---

## Tips & Troubleshooting

**Google Drive is slow:** The lab data lives on Google Drive, which can cause file reads to hang. If the pipeline seems stuck, check whether it's waiting on a Google Drive file read. The `codeRoot` setting moves cloned/extracted code off the cloud drive to avoid this.

**AI-suggested scores (`llm_check`) all say "AI check unavailable":** with the default local provider, Ollama must be running (`ollama serve`) with at least one model installed (`ollama list`); set `llmCheck.model` to choose one. With a cloud `llmCheck.provider`, set its API key (`ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`).

**Colab notebook could not be downloaded:** the student's notebook isn't shared as "Anyone with the link". Ask them to change the sharing, or open the link yourself, download the `.ipynb` and put it in that student's `extracted_code/` folder, then `--regrade`.

**AI comments not working:** Ensure Ollama is running (`ollama serve`) and at least one model is installed. Run `ollama list` to check. The grader auto-selects the first available model; use `--ai-model=NAME` to pick a specific one.

**Re-cloning a single student:** If a student's repo changes after the initial clone, use `--reclone` to wipe everything and start fresh, or `--regrade` to run `git pull` on existing clones. There's no per-student reclone option.

**ESLint/TypeScript not installed:** Run `npm install` in the `AI_Grading/` directory — ESLint and the TypeScript tooling are both devDependencies. The ESLint config at `eslint/student.eslint.config.mjs` (or `student.typescript.eslint.config.mjs` for TS) must also exist (shared with VS Code).

**HTML/CSS validator not installed:** Run `npm install`. `html-validate` and `csstree-validator` are listed as dependencies and run offline — no network or browser needed.

**Python/C++/C# toolchain not found:** The grader prints a warning with an actionable hint at the start of that lab's run (e.g. "Install a compiler ... and set config.toolchains.cpp.compiler"). See [Prerequisites](#prerequisites) for what to install, and point `configs/local-config.json`'s `toolchains` section at it if it's not on your PATH.

**`uv not found` warning:** a Python lab that runs or tests programs needs [uv](https://docs.astral.sh/uv/) for students' uv projects (anything with a `pyproject.toml`). Install it, or set `toolchains.uv` in `configs/local-config.json` to its full path. Loose `.py` submissions without a `pyproject.toml` still run without it.

**The first Python run is slow:** the first student with a given set of dependencies triggers a full `uv sync` (minutes for TensorFlow or scikit-learn); everyone after them with the same `pyproject.toml` reuses that environment. Environments are cached in your system temp folder by default — set `execution.envCacheDir` (e.g. in the course's `defaults`) to keep them somewhere permanent, and `execution.installTimeoutMs` if a large install needs more than the default 10 minutes. A failed install shows up as `uv sync failed: …` on the `run_check`/`test_check` row.

**A Python program can't find its data files:** CS 212 programs open files like `Data/instructors.csv` relative to their project folder. Make sure the lab runs with `execution.cwd: "copy"` (CS 212's course default), and if students don't submit the data, list it in `runCheck.supportFiles`.

**`run_check` executes student code directly on this machine:** unlike the browser check (sandboxed by Chrome) or `npm run build` (no arbitrary execution), `run_check` (and `test_check`) compiles/interprets and then *runs* the student's program with your machine's permissions. It runs in a temporary folder (a copy of the project with `execution.cwd: "copy"`), so files it writes there never touch the submission, and it can't see the grader's own secrets — environment variables like `CANVAS_TOKEN` or API keys are removed before it starts. That's protection against accidents, not against a deliberately malicious program: this is appropriate for grading known students in a classroom setting, not for anonymous or adversarial submissions — see `src/lib/sandbox.js`'s documentation if you need to understand the isolation model in more depth.

**Rubric not found:** If the rubric spreadsheet isn't in `configs/{Course}/{AssignmentName}/`, the grader asks whether to provide one — then lets you browse to the `.xlsx`/`.xlsm` file (or type its name), copies it into the lab's config folder if it's somewhere else, and saves its name in the lab config. Otherwise it switches to `--text-report` mode (generates `.txt` files instead).

**Output files:** Each student gets a graded spreadsheet (or `.txt` report) in `<codeRoot>/<courseName>/<labName>/SubmissionsAndAssessment/StudentName/` (flat) or `<codeRoot>/<courseName>/<labName>/<stepName>/SubmissionsAndAssessment/StudentName/` (multi-step) — under that term's `codeRoot` (see [Courses & terms](#courses--terms)). A `grading_log.txt` summary is written to the corresponding `Artifacts/` folder, alongside JSON reports for each pipeline phase.
