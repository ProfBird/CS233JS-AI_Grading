## Overview

AI grading pipeline originally built for CS233JS (Lane Community College), now generalized to grade multiple **courses** across multiple **terms** (e.g. "Spring 2026") — not just one course, one semester. The pipeline extracts student code (from a Moodle download or directly from Canvas), runs analysis/lint/runtime checks, then fills in rubric spreadsheets (.xlsx/.xlsm) with scores and comments — or, for labs with `"textReport": true` (or the `--text-report` flag), per-student `.txt` grade reports instead. A second shipped course, **CIS195** (Web Authoring — static HTML/CSS labs), uses the web-content check phase (`webContent` config + `element_check`/`css_selector_check`/`css_property_check`/`file_count` mappings, `runtimeCheck: "none"`, text reports) and supersedes the old standalone GradingAssistant repo — see `docs/CIS195_INTEGRATION.md`. A third course, **CS212** (AI Programming 1 — Python labs), is being onboarded: `configs/CS212/` has its course config (Python by default) and a course ruff ruleset but no lab configs yet; `docs/code_review_2026-11-04_cs212.md` tracks what's left (running uv-based Python projects, per-group overrides). Language-specific mechanics (linting, building, running, testing) are behind a pluggable adapter layer (`src/adapters/`, `config.language`, default `"javascript"`) — TypeScript, Python, C++, and C# are also supported for courses that need them; see "Language adapters" below. Every course/assignment/step config path is scoped under `configs/{Course}/…` (see "Courses" below), and `labRoot`/`codeRoot` are resolved per named term (see "Terms" below) rather than a single fixed pair. `bin/grade.js`'s plain interactive menu (no arguments) always shows a course picker, then a term picker (even with one option each), then a submission-source choice — the assignment's configured source (Moodle folder, or Canvas if already set up) vs. "Download from Canvas", the menu equivalent of `--canvas`; any shortcut invocation (`node bin/grade.js Lab03`) auto-resolves a single course/term silently and skips the source prompt, so existing usage is unchanged.

## Commands

The entry point is `bin/grade.js` (also installed as the `cs233-grade` bin). The codebase is ESM (`"type": "module"`).

```bash
node bin/grade.js              # interactive menu  (or: cs233-grade)
node bin/grade.js Lab03        # first-time grade
node bin/grade.js Lab03 --regrade   # re-run grading phases, keep extracted code
node bin/grade.js Lab03 --reclone         # delete extracted code, re-clone, then grade
node bin/grade.js Lab03 --ai-comments     # grade with Ollama-generated rubric summary sentences
node bin/grade.js Lab03 --ai-model=qwen3-coder  # grade with a specific Ollama model (implies --ai-comments)
node bin/grade.js Lab06 --text-report     # grade without rubric spreadsheet, generates .txt reports
node bin/grade.js TermProject ApiDoc      # grade one step of a multi-step lab
node bin/grade.js Lab03 --canvas          # import submissions from Canvas instead of a Moodle folder
node bin/grade.js CS233JS Lab03           # explicit course — only needed once 2+ courses exist under configs/

node bin/rubric-to-md.js path/to/Rubric.xlsm [-o out.md]  # dump Grade sheet as Markdown (or: cs233-rubric-to-md); header row found by detectRubricLayout (Possible/Points/Pts/Max)
node bin/configure-lab.js [AssignmentName]    # lab config wizard + copy rubric; asks about versions (lab groups) and writes `variations` letters/appNames — per-group `overrides` are hand-edited (or: cs233-configure-lab)
```

```bash
npm test                    # run all tests (vitest)
npm run lint                # eslint . (the CI lint gate)
npx vitest                  # watch mode
```

### Dependencies

- **puppeteer** — headless Chrome for browser runtime checks
- **xlsx** — read/write rubric spreadsheets
- **adm-zip** — read/write ZIP entries to preserve VBA macros/buttons in `.xlsm` output files
- **mammoth** — read `.docx` code review forms and convert to HTML for table parsing
- **html-validate** — offline HTML validator used by `validate_html.js`
- **csstree-validator** — offline CSS validator used by `validate_css.js`
- **jsdom** — DOM parser for `check_web_content.js`'s required-element selector queries
- **css-tree** — CSS AST parser for `check_web_content.js`'s selector/property scans (also csstree-validator's engine)
- **globals** — browser/node global definitions for ESLint flat config
- **eslint** — v9+ flat config
- **typescript**, **@typescript-eslint/parser**, **@typescript-eslint/eslint-plugin** — the `typescript` language adapter's lint/build tooling
- **neo-blessed** — terminal UI framework (`src/lib/tui.js`), shared by `configure-lab.js`'s wizard and `bin/grade.js`'s interactive menu (via `prompt_driver.js`, only when both stdin and stdout are a real TTY)
- **vitest** (dev) — test runner

Non-Node toolchains used by the `python`/`cpp`/`csharp` language adapters are **not**
npm dependencies — they must be present on the grading machine (or pointed to via
`configs/local-config.json`'s `toolchains` section if not on PATH): a Python
interpreter + `ruff` + `pytest` (`pip install ruff pytest`) and, for uv projects
(`pyproject.toml` — all of CS212), [uv](https://docs.astral.sh/uv/), a C++ compiler
(g++/clang), and the .NET SDK, respectively. Each adapter's `preflight()` reports
whether its toolchain is available with an actionable install/config hint.

## Architecture

### Language adapters (`src/adapters/`)

Every pipeline phase that used to hardcode JS/npm/ESLint logic now calls into a
**language adapter**, resolved via `resolveAdapter(config)` (`src/adapters/index.js`)
keyed by `config.language` (default `"javascript"` — existing labs need no config
changes). See `src/adapters/base.js` for the full interface contract (JSDoc typedefs)
and `isValidDiagnostics()`/`REQUIRED_ADAPTER_KEYS`, used by adapter tests.

- **javascript** (`javascript.js`) — the original implementation, extracted verbatim: ESLint invocation + config resolution, npm install/build, npm script running, package.json manifest checking, import/require specifier extraction.
- **typescript** (`typescript.js`) — extends the JS adapter (reuses its manifest/package logic and comment-stripping); swaps in a `@typescript-eslint` ESLint config and `tsc --noEmit` (invoked via the grader's own locally-installed `node_modules/.bin/tsc`, not the student's — same principle as ESLint) as the build/type-check step.
- **python** (`python.js`) — two project styles. **uv projects** (a `pyproject.toml`; CS212's standard, made with `uv init`): the shallowest folder holding `pyproject.toml` is the project folder; `install()` builds a grader-owned environment with `uv sync --no-install-project`, run in a scratch folder holding only `pyproject.toml`/`uv.lock`/`.python-version` (never in the submission — that would write `uv.lock`/`.venv` into it and could break `--regrade`'s `git pull`), cached at `<execution.envCacheDir>/<hash of those files>` (default `<tmp>/grader-python-envs`) so students with identical dependencies share one environment; programs and tests then run with that environment's own Python (`bin/python`, or `Scripts\python.exe` on Windows). **Loose scripts / `requirements.txt`**: the system interpreter, `requirements.txt` installed with pip. The entry point is `runCheck.entry` (bare filename or project-relative path), else `main.py` (exact name), else the only/shallowest `.py`. Manifest: `pyproject.toml`'s `[project].dependencies` (dev groups/extras count as declared but needn't be imported), else `requirements.txt`; a distribution→import-name map (`scikit-learn`→`sklearn`, `z3-solver`→`z3`, …, extendable via `packageCheck.importAliases`) decides "never imported". `ruff` for lint (JSON output normalized to the shared diagnostics shape); `py_compile` for a syntax-only "build". `runTests` runs through the sandbox in a copy of the project: `testCheck.mode` `"pytest"` (default; pytest is added to a uv environment on first use) or `"script"` (runs the student's own test script and counts `PASS`/`FAIL` lines — CS212 Lab02's driver format). `preflight` also warns when uv is missing for a lab that runs or tests code. **Notebooks:** `sourceExtensions` is `['.py', '.ipynb']` — analysis reads a Jupyter/Colab notebook through `src/lib/notebook.js` as a Python script (code cells as code, markdown cells as `#` comments, `# %%` cell markers), so feature checks, the developer-comment check and import scanning see its cells; ruff lints notebooks natively (`extend-include = ["*.ipynb"]` in the shipped and CS212 rulesets). Notebooks are analyzed and linted, not run. No `runScript` — no npm-style named-script concept.
- **cpp** (`cpp.js`) — `detectProject` prefers CMakeLists.txt, then a Makefile, then falls back to compiling loose `.cpp`/`.cc`/`.cxx` files directly (the common case for intro submissions). Only the "loose" path gets structured diagnostics (g++/clang SARIF via `-fdiagnostics-format=sarif-stderr` for GCC / `=sarif` for clang — the adapter probes `--version` once to pick the right spelling, since clang, including macOS's `g++`, rejects GCC's); CMake/Makefile builds are success/fail only. `stripComments` protects C++11 raw string literals (`R"(...)"`) before the generic string pass. No manifest/package concept.
- **csharp** (`csharp.js`) — parses a `.sln`/`.slnx` (supports both the classic text format and the newer XML format the .NET SDK now defaults to) for multi-project references (class library + console app + test project is a common student layout), or a loose `.csproj`. Diagnostics come from `dotnet build`'s plain-text MSBuild output (regex-parsed, no binlog/XML dependency); `runTests` parses `dotnet test`'s console summary line. `stripComments` protects verbatim (`@"..."`, where `""` is an escaped quote) and C# 11 raw string literals.

Every adapter also exposes `extractComments` — the inverse of `stripComments`, built from the same grammar (`src/lib/comment_stripper.js`'s `makeCommentExtractor`) — so comment-only checks (developer name/date) see exactly what stripping removes.

Each adapter's methods are individually **nullable** — `null` means "this language has
no such concept" (e.g. `checkManifest: null` for C++), and callers must treat that as a
capability gap, not an error. Methods that shell out to an external tool (`lint`,
`install`, `build`, `runTests`, `preflight`) accept an optional trailing `config`
argument carrying `config.toolchains` (machine-specific interpreter/compiler paths not
on the default PATH — see the config schema below). `preflight(config)` checks the
toolchain is available with an actionable hint; `run_pipeline.js` calls it once,
upfront, for a clear message instead of the same failure repeated per student.

Execution of a compiled/interpreted student artifact (the `run_check` runtime-check
strategy) always routes through `src/lib/sandbox.js`'s `runStudentArtifact()` — see that
file's header comment for the isolation-tier documentation (`direct` implemented now;
`restricted-user`/`container` are documented, loud-failing stubs, never a silent
fallback). `direct` mode is NOT a security sandbox — it protects against accidental
damage (timeout+kill-tree, a fresh throwaway working directory) from bugs in
trusted-classroom submissions, not deliberately malicious code. The throwaway directory is
empty by default; with `execution.cwd: "copy"` it starts as a copy of the student's project
folder (minus `.venv`/`.git`/`__pycache__`/`node_modules`, no symlinks), so a program that
opens files relative to its project folder works, and `runCheck.supportFiles` (instructor
files, resolved against the lab's config folder) are added wherever the student has no file
at that path. The child gets the grader's environment minus secrets (`*_TOKEN`, `*_API_KEY`,
`*SECRET`, `CANVAS_*`, …), so student code can't read the grader's Canvas/LLM credentials.
Tests (`test_check`) execute through the same chokepoint.

### Pipeline (`bin/grade.js` → `src/pipeline/run_pipeline.js`)

`bin/grade.js` owns CLI parsing and path resolution; its interactive setup phase
(course/term/submission-source/assignment/step/Canvas/rubric/mode resolution) is
`src/lib/grade_setup.js`'s `resolveGradeSetup()`, prompting over a **driver**
(`src/lib/prompt_driver.js`) — the same full-screen neo-blessed TUI `bin/configure-lab.js`
uses (`src/lib/tui.js`) when both stdin and stdout are a real TTY, or a plain readline
fallback otherwise (piped/redirected invocations, e.g. `node bin/grade.js Lab03 --regrade
> out.txt`, never touch neo-blessed). The TUI is constructed lazily on the first prompt, so
a fully non-interactive shortcut run (course/term/lab all unambiguous, e.g. `node
bin/grade.js Lab03 --regrade`) never flashes the alt-screen open. `main()` closes the
driver once setup resolves, then replays `driver.takeNotes()` (messages that must survive
the TUI's alt-buffer closing — saved term/course, Canvas assignment picked, legacy-path
fallback, rubric outcome, etc.) to real stdout before the grading banner, mirroring
`configure-lab.js`'s buffered-summary pattern. `resolveGradeSetup` throws a `SetupError`
(an array of message lines) on any unrecoverable problem instead of calling
`process.exit` directly, so the driver can be torn down first; `main()`'s top-level catch
prints `err.lines` to `process.stderr` and exits 1. It then calls code acquisition directly
and hands off to **`src/pipeline/run_pipeline.js`**'s
`runPipeline(students, config, dirs, options)` for everything else. The phase list is
data (`PHASES`, each `{ name, run, when }`) rather than a hardcoded sequence of awaits —
a future per-language config key can gate a phase (e.g. skip markup validation for a
non-web language) without touching the loop. `runPipeline` also runs the resolved
adapter's `preflight` check upfront, filters out already-graded students (unless
`--regrade`), then generates grades and writes `grading_log.txt`.

1. **src/pipeline/extract_code.js** — Reads Moodle submission dirs. Unzips `.zip` files or clones GitHub repos from URLs in `onlinetext.html`; with neither, falls back to copying the submission's loose uploaded files (bare `.py`/`.csv` etc. — hidden files, archives and Word docs skipped) into `extracted_code/`. Loose files uploaded *alongside* a zip are merged in after extraction (the zip's copy wins a name collision); if the zip won't extract, the loose files are used alone. A GitHub repo, when linked, is the only source. A submission whose only code is a **Colab link** (`urls.colab` — needs a `colab` entry in `config.urlPatterns`, as CS212's course defaults have) gets its notebook downloaded as `colab_notebook.ipynb` by `acquireColabNotebook()` through Google Drive's public download URL; that works only when the student shared it as "Anyone with the link" — otherwise the student's `error` says so (Moodle and Canvas paths both call it after `acquireCode`). URL categories are config-driven via `config.urlPatterns` (default `{ github: "github.com", citstudent: "citstudent.lanecc.edu" }` — same behavior as before for existing labs); `github` is structurally special (decides clone-vs-zip), other keys are just labels for `url_check`/`deploy_check` mappings. Attaches `student.extractedDir`, `student.urls`, `student.filesDir`. Exports `toSafeName`, `matchUrlCategories`, `acquireCode`, `applyGithubSubdir` so other acquisition sources reuse the same directory-naming, URL-category-matching, and clone/unzip-with-fallback mechanics instead of reimplementing them.
   - **src/pipeline/extract_code_canvas.js** — Alternative acquisition source: imports one assignment's submissions directly from Canvas via `src/lib/canvas_client.js` instead of scanning a Moodle folder, when a lab's config has `config.canvas.assignmentId` set (or `--canvas` is passed). `online_upload` submissions are downloaded and unzipped (loose non-Word attachments become the code, or are merged in next to a zip's contents — e.g. CS212's bare `.py` uploads; the review `.docx` stays in `canvas_files/`); `online_text_entry`/`online_url` submissions are scanned for a GitHub link the same way Moodle's `onlinetext.html` is. Produces the identical `students[]` shape (`name`/`extractedDir`/`gradeDir`/`filesDir`/`urls`/`error`) and writes into the same `submissionsDir/<Student>/{repo,extracted_code}/` layout, so every downstream phase and `bin/grade.js`'s `--reclone`/`--regrade` handling work unchanged regardless of acquisition source.
2. **src/pipeline/read_code_review.js** — Reads each student's code review form (`.docx`). Parses the HTML table (via mammoth) to extract per-item beta and production scores, plus the lab assignment group letter. Attaches `student.codeReview` with `items[{label, betaScore, prodScore, prodFilled, prodAffirmative}]` (one per row of every Beta/Prod-headed table, in document order — forms often split criteria across tables, e.g. General / Part 1 / Part 2 — spacer rows included with `label: ''`), `productionCompleted`, and `group`. The production column is the header matching `/prod|release|final/i` (CS233JS forms say "Prod.", several CS212 forms say "Release"). Runs first after acquisition so the group letter is available to everything after it.
2b. **resolveGroups** (`src/lib/student_group.js`) — sets `student.group = { letter, source, reason? }`: the review form's letter when it's one of `config.variations`' groups, else the group detected from the code (`variation_detect.js`), else unknown (`letter: null`, with a `reason`); a form/code disagreement keeps the form's letter and logs the conflict. Runs before the runtime check because a group may override run settings.
3. **src/pipeline/runtime_check.js** — Dispatches to a named check **strategy** registered via `registerCheckStrategy(name, fn, opts)` (mirrors the mapping-handler registry). Built-in strategies: `"browser"` — Puppeteer captures console errors and failed loads (generic, not language-specific). `"build"` — delegates to the resolved adapter's `install`/`build`. `"both"` — build first, then browser-checks the built `dist/`; stores `buildSuccess`/`browserSuccess` sub-results separately. `"run_check"` — installs dependencies (adapter `install`, e.g. a cached uv environment), builds (if needed), then executes the produced artifact via the sandbox chokepoint above, matching stdout against `config.runCheck.expectPatterns`; with `runCheck` as a list, does this once per run and adds `runs[id]`. Each student is checked with their group's settings (`configForStudent`); when a group overrides run settings and the student's group is unknown, the student isn't run (`groupUnknown: true`). `VALID_RUNTIME_MODES` (exported, used by `bin/grade.js`'s config validation) is populated automatically as strategies register — a new strategy doesn't require editing the validator. Also runs a `scripts_check` sub-phase (adapter-delegated; verifies named scripts are defined/pass) when `scripts_check` mappings are present, and a `test_check` sub-phase (adapter's `runTests`) when `test_check` mappings are present. Attaches to `student.runtimeCheck`, `student.scriptsCheck`, `student.testCheck`.
4. **src/pipeline/analyze_code.js** — Regex-based feature detection per-lab config, driven by the resolved adapter's `sourceExtensions`/`stripComments`/`checkManifest`/`extractUsedPackages` (default JS). For multi-part labs, matches subdirs to game names from config. Checks repo hygiene *before* runtime modifications. Attaches to `student.analysis`. A configured `customAnalyzer` is invoked via `applyCustomAnalyzer()`, whose return object is merged into `analysis` (a throwing analyzer is logged and skipped). A custom analyzer can attach `analysis.reportSections` (see below) to add lab-specific output to text reports without touching generic code.
5. **src/pipeline/lint_code.js** — Delegates to the resolved adapter's `lint()`/`lintConfigCandidates()`. For JS: runs ESLint (flat config) against each student's source files; ruleset resolution is a per-step or per-lab `configs/{Course}/{Lab}/eslint.config.mjs` override if present, else a course-wide `configs/{Course}/eslint.config.mjs` (Python: `ruff.toml` at each level), else the shipped `eslint/student.eslint.config.mjs`; the resolved config is also copied into the lab folder for editor consistency. `lintConfigCandidates(configsDir, labName, stepName, courseName)` takes `courseName` as an optional 4th arg — `configsDir` itself stays the repo-root-level `configs/` dir (so the shipped-default fallback, derived via `configsDir/..`, stays course-agnostic) while `courseName` only affects where the override candidates are looked for. Attaches to `student.lint` with `{ sourceFiles, errors, warnings, errorMessages, warningMessages, messages, ruleCounts }`.
5b. **src/pipeline/validate_html.js** — Validates `.html`/`.htm` files with `html-validate` (pure JS, offline). Like 5c and 5e, loaded by `run_pipeline.js` with `import()` only when the phase runs; 5b/5c run for web-language labs (javascript/typescript) or labs with an `html_validate`/`css_validate` mapping, so a Python/C++/C# lab never loads the web libraries. Attaches `student.htmlValidation` with `{ htmlFiles, errors, warnings, messages, ruleCounts }`. Respects `config.validate.exclude`. Ruleset overrideable via `config.validate.htmlExtends` / `config.validate.htmlRules`; `no-trailing-whitespace` is off by default.
5c. **src/pipeline/validate_css.js** — Validates `.css` files with `csstree-validator` (pure JS, offline). Attaches `student.cssValidation` with `{ cssFiles, errors, warnings, messages, ruleCounts }`. Reports validity errors only (no warning tier). Respects `config.validate.exclude`.
5d. **src/pipeline/check_names.js** — Checks every file and folder name in the submission for Linux/web portability. A name is invalid if it contains any character outside `[A-Za-z0-9._-]` (spaces, parens, accented chars, etc.). Attaches `student.nameCheck` with `{ entriesChecked, errors, messages, badNames }`. Extra allowed characters configurable via `config.nameCheck.extraAllowed`.
5e. **src/pipeline/check_web_content.js** — Runs only when `config.webContent` is present (the first phase to use a real `when` gate in `run_pipeline.js`'s `PHASES`). Checks required HTML elements via jsdom CSS-selector queries summed across all `.html`/`.htm` files, required CSS selectors/properties via css-tree scans of external `.css` files + embedded `<style>` + inline `style=""` attributes (a required property may be a bare name or a normalized `prop: value` pair), and minimum file counts by filename regex. Attaches `student.webContent`; scored by the `element_check` / `css_selector_check` / `css_property_check` / `file_count` mapping types. Built for CIS195's HTML/CSS labs (ported from the old GradingAssistant app) but fully generic.

6. **src/pipeline/generate_grades.js** — Reads from `student.analysis`, `student.lint`, `student.runtimeCheck`, `student.codeReview`, `student.htmlValidation`, `student.cssValidation`, `student.nameCheck`, `student.scriptsCheck`, `student.testCheck`. Fills rubric `.xlsx`/`.xlsm` cells using handler functions per mapping type, registered via `../lib/handler_registry.js` (`registerHandler`/`getHandler`/`VALID_MAPPING_TYPES` — a standalone module so `bin/grade.js` can load `config.handlerModules` and validate mapping types without pulling in this file's heavier ollama/rubric_writer dependencies). For `.xlsm` rubrics, delegates OOXML/ZIP surgery to `src/lib/rubric_writer.js`. With `--ai-comments`, calls `src/lib/ollama_comments.js` to generate a one-sentence summary for `config.summaryCell`. With `--text-report`, produces `.txt` grade reports instead of spreadsheets — useful when a rubric template isn't available yet. If `config.graderCell` is set, writes "Computer" into that cell; on regrade, creates a versioned copy (`-V2`, `-V3`, …) rather than overwriting a spreadsheet that has been manually reviewed.

### Shared utilities (`src/lib/`)

- **src/lib/file_walker.js** — Recursive directory traversal. Exports: `walk(dir, opts)` (core traversal with `visit`, `onFile`, `onDir`, `shouldSkip`, `shouldDescend`, `followSymlinks`, `maxDepth`); `getAllFilesByExt(dir, ext, exclusions)` (collect files by one extension or an array of extensions); `DEFAULT_SKIP_DIRS` (Set of dirs never scanned: `node_modules`, `dist`, `build`, `.git`, `__MACOSX`).
- **src/lib/handler_registry.js** — The mapping-type handler registry (`registerHandler`, `getHandler`, `VALID_MAPPING_TYPES`), extracted from `generate_grades.js` into its own lightweight module. Wizard-facing metadata (labels/descriptions/field prompts) still lives separately in `lab_config.js`'s `MAPPING_TYPES`/`MAPPING_TYPE_SCHEMA` — deliberately not merged in yet (see `test/generate_grades.spec.mjs`'s "mapping-type lists stay in sync" test, which fails loudly if the two drift; full metadata consolidation is a documented future step for whenever the wizard's schema next needs to change anyway).
- **src/lib/config_validation.js** — `validateConfig(config, labName)` and `loadHandlerModules(config, labConfigDir)`, extracted out of `bin/grade.js` so they're unit-testable without stubbing `process.exit` (`validateConfig` throws an `Error` on failure instead; `bin/grade.js` catches it and exits). Depends only on `VALID_MAPPING_TYPES` (`handler_registry.js`), `VALID_RUNTIME_MODES` (`runtime_check.js`), and `fs`/`path`/`url` — no CLI/readline machinery. Checks include compiling every `analysis.features` regex (`regex`, `fileRegex`, `match` leaves) so a typo fails at startup, and validating each lab group's merged config (`variations[group].overrides`) with the same checks.
- **src/lib/grade_setup.js** — `resolveGradeSetup(driver, { argv, configsDir, localConfigPath, defaultConfigPath })`, `bin/grade.js`'s interactive setup phase (course/term/submission-source/assignment/step/Canvas/rubric/mode resolution) extracted so it's unit-testable against a scratch `configs/`/labRoot/codeRoot tree and a fake driver, without spawning a real process. Also exports `parseGradeArgs(argv)` (CLI flag/positional parsing, separately testable) and the `SetupError` class (thrown instead of calling `process.exit` directly — see `prompt_driver.js` below). `driver` lifecycle (creation, teardown, notes replay) is owned by `bin/grade.js`'s `main()`, not this module.
- **src/lib/path_browser.js** — `askPath(driver, { prompt, kind: 'dir'|'file', start, extensions, baseDir })`. In the full-screen TUI it uses the arrow-key picker (`inquirer-file-selector`, the one GradingAssistant's `Menu.mjs` uses) via `driver.pickPath` → `TUI.pickPath` (`tui.js`), which hands the terminal to `src/lib/file_picker_cli.mjs` through blessed's `screen.spawn` and reads the answer back from a temp file; Esc there falls back to typing a path (which also allows a folder that doesn't exist yet). `configure-lab.js`'s rubric prompt (`copyRubric`) uses it too. Without `driver.pickPath` (readline fallback, tests) it is a browser built only on `askOptions`/`ask` (numbered list). That fallback: Each screen offers [Use this folder] (folders), [Type a path...], [Up one level], quick jumps (Home; macOS `/Volumes` and Google Drive under `~/Library/CloudStorage`; Windows drive letters), then subfolders and matching files (hidden files and Excel `~$` lock files left out; 300 entries max); [Cancel] returns `''`. **Recent paths:** when an entry point calls `setRecentPathsFile(local-config.json)` (`grade.js` and `configure-lab.js` do; tests don't), each prompt first lists its last 8 chosen paths that still exist (`recentPaths` in `local-config.json`, keyed by `recentKey` or the prompt text) with a "Browse for another…" entry; a chosen path moves to the top. Used by `grade_setup.js` for the term's lab root / code storage root, a replacement writable code root, and a missing rubric (a spreadsheet chosen outside the lab's config folder is copied into it and `rubricName` saved).
- **src/lib/prompt_driver.js** — `createDriver({ title, interactive })` selects a prompt backend: the neo-blessed `TUI` (`tui.js`) when `interactive` (default: both stdin and stdout are a real TTY), or `createReadlineDriver()` otherwise. Both implement the 6-method interface `config_prompts.js` already documents (`ask`/`askBoolean`/`askInt`/`askOptions`/`print`/`exit`) plus 4 extensions: `note`/`takeNotes` (buffer a message for replay after the driver closes), `banner` (course-code title/box), and `close`. Call sites must pass a bare, single-line prompt string plus a separate `def` — each backend decorates it itself (`[default]:`, a numbered list, etc.); embedding `[default]` or a trailing `:` in the prompt renders doubled decoration. The readline backend's `askOptions` delegates number-or-name resolution to `select_from_list.js` but resolves to the matched *option object* (never `getValue: o => o.value`), since that module's resolve loop treats a falsy value as "keep prompting" and would hang on an option whose `value` is `null`/`''`/`false`. The TUI backend is constructed lazily, on the first prompt call, so a zero-prompt shortcut run never opens the alt-screen.
- **src/lib/sandbox.js** — `runStudentArtifact()`, the native-code-execution isolation chokepoint. See the "Language adapters" section above.
- **src/lib/rubric_writer.js** — Low-level OOXML/ZIP surgery: column-width recovery, drawing/button preservation, reducing the workbook to the Grade sheet, restoring non-Grade sheets as `veryHidden` for VBA binding.
- **src/lib/ollama_comments.js** — Generates one-sentence AI rubric summaries. A thin wrapper around `llm_client.js`'s `LLMClient` (Ollama provider, 8s per-student timeout, `quiet: true` since callers already report failures) — owns only the grading-specific prompt template; HTTP/retry/model-probe machinery is shared with `llm_client.js`.
- **src/lib/lab_config.js** — Pure, UI-agnostic functions for lab configuration. Exports spreadsheet helpers (`readRubricRows`, `detectRubricLayout`), assignment discovery (`getExistingAssignments`, `getExistingSteps`), course discovery (`getExistingCourses`, `readCourseConfig`, `writeCourseConfig` — see "Courses" below), config assembly (`buildConfig`, `writeLab`), mapping type schemas (`MAPPING_TYPES`, `MAPPING_TYPE_SCHEMA`), and `guessMappingType`. No readline/TUI/process.exit — safe to import from anywhere including tests.
- **src/lib/llm_client.js** — Unified LLM client supporting Ollama, OpenRouter, and Anthropic. Used by `configure-lab.js` to generate AI-assisted config drafts, and by `ollama_comments.js` for AI rubric summaries. Exports `LLMClient`, `loadLLMClient` (reads provider/key from `local-config.json`), `setupLLMInteractive`, `ENV_KEYS`/`DEFAULTS`, and `detectOllamaModel(baseUrl)` (probes `{host}/api/tags`, stripping a trailing `/v1` off the given chat `baseUrl` first — Ollama's tag-listing endpoint lives at the host root, not under `/v1`). Handles HTTP 429 rate-limit retries with fallback model. `DEFAULTS.ollama.baseUrl` is `http://localhost:11434/v1` — Ollama's OpenAI-compatible chat endpoint lives under `/v1`, unlike its native `/api/*` endpoints.
- **src/lib/llm_models.js** — `configure-lab.js`'s model picker (`selectModel`) and the add/edit/remove manager behind its "Add, edit or remove models…" entry (`manageModels`). Stores in `local-config.json`: `llm` (the selected model, the shape `loadLLMClient` reads), `llmEndpoints` (`{ name: { type, baseUrl, apiKey? } }` — APIs shared by several models; `type` is `openai` | `openrouter` | `anthropic` | `ollama`), `llmModels` (user-added `{ label, model, endpoint }`), `llmHidden` (removed built-in model ids). Adding a model offers the already-entered APIs before asking for a new URL/key. Keys: env var (OpenRouter/Anthropic built-ins) → endpoint's stored key → legacy `llm.apiKey`.
- **src/lib/tui.js** — Terminal UI primitives (neo-blessed), used by both `configure-lab.js`'s wizard and, via `prompt_driver.js`, `bin/grade.js`'s interactive menu. Provides a scrollable log pane, text input bar, arrow-key option popup, full-screen review table, spinner, and `setTitle`/`setStatus` for the header/status strips. Redirects `console.log`/`console.error` to the TUI pane while active.
- **src/lib/config_prompts.js** — Driver-based rubric prompt functions shared between the TUI wizard and tests. Implements `promptRubricRows`, `promptRubricCriteria`, `copyRubric`, `promptFields`, and `buildMappingEntry`. Uses a driver interface (`ask`, `askBoolean`, `askInt`, `askOptions`, `print`, `exit`) so the same logic runs in both interactive and test contexts.
- **src/lib/student_group.js** — lab groups: `resolveStudentGroup`/`resolveGroups` (the pipeline phase), `configForStudent(config, student)` (the lab config with the student's `variations[group].overrides` merged in, cached per group; used by the runtime-check, analysis and web-content phases), `groupUnknownWithOverrides`/`mappingDependsOnGroup` (generate_grades flags group-dependent rows `NEEDS MANUAL CHECK: lab group unknown …` instead of scoring them with another group's settings), `OVERRIDABLE_KEYS`.
- **src/lib/notebook.js** — `notebookToSource(jsonText)` (an `.ipynb` as a Python script: code cells as code, markdown cells as `#` comments, `# %%` markers; `null` if not a notebook) and `readSourceFile(file)` — the reader analysis uses for source files (notebooks converted, everything else as text).
- **src/lib/llm_check.js** — the `llm_check` mapping type: `runLLMCheck(map, student, config)` reads the student's code (`collectCode` — the language's source files, notebooks included, or `map.files`; cut at `llmCheck.maxChars`, default 40000, with a note), asks a model for `{score, reason}` on one rubric criterion (`buildPrompt`/`parseVerdict` — score clamped and rounded to 0.5), and returns `NEEDS REVIEW (AI suggestion, <model>): …` with `keepComment`. Default provider is a local Ollama model (student code stays on the machine); a cloud provider only when `llmCheck.provider` sets one — never from `local-config.json`'s `llm` block. Any failure → 0 + `NEEDS MANUAL CHECK: AI check unavailable (…)`. One client per lab config; `setLLMCheckClientFactory` lets tests substitute a fake model.
- **src/lib/merge_config.js** — `mergeConfig(base, over)`, the one merge rule (objects merge key by key, arrays/values replace) shared by course `defaults` and group `overrides`; dependency-free so `config_validation.js` stays light.
- **src/lib/variation_detect.js** — `checkVersionVariation(extractedDir, variations)` and its helpers (`buildVariationCorpus`, `variationKeywords`, `VARIATION_KEYWORD_STOPWORDS`), extracted out of `analyze_code.js` — self-contained, no dependency on `analyze_code.js`'s per-student state. Keyword-matches each `config.variations` entry's `appName` against a corpus of repo text (top-level names, HTML `<title>`s, `package.json` name/description, README excerpts) to detect which lab variation a student implemented.
- **src/lib/canvas_client.js** — Thin Canvas LMS REST API wrapper (native `fetch`, no dependency) used by `src/pipeline/extract_code_canvas.js` and `bin/grade.js`'s `--canvas` setup flow. Exports `getCourse`, `listAssignments` (filters out quizzes/graded discussions), `listSubmissions` (paginated, `include[]=user`), `downloadFile`, `CanvasError`, and `sanitize` (redacts the API token from any error message before it's logged).

### Courses

Every assignment lives under a **course** directory: `configs/{Course}/{AssignmentName}/…`. A
course is any subdirectory of `configs/` that either has its own `course_config.json` or (for
a not-yet-migrated install) contains at least one assignment with a config —
`getExistingCourses()` (`src/lib/lab_config.js`) discovers them this way, tolerantly.

`configs/{Course}/course_config.json` (all fields optional; missing ones default to the
directory name):
```json
{
  "courseName": "CS212",
  "courseCode": "CS212",
  "rubricPrefix": "CS212",
  "canvasCourseId": 12345,
  "defaults": { "language": "python", "execution": { "cwd": "copy" } }
}
```
- `courseName` — display name shown in menus/banners.
- `courseCode` — shown in the interactive banner title (`{courseCode} AI Grader v1.0`).
- `rubricPrefix` — used when suggesting/generating a new rubric filename (`{rubricPrefix}_{Lab}_Rubric.xlsm`).
- `canvasCourseId` — the course's Canvas course ID, resolved once via `--canvas`'s interactive
  setup and reused by every lab in the course (see the Canvas section below) — an individual
  lab's config only stores its own `canvas.assignmentId`.
- `defaults` — course-wide lab-config settings (`src/lib/lab_config.js`'s `applyCourseDefaults`,
  applied by `grade_setup.js` right after a lab/step config is read, before validation). Any
  setting the lab config doesn't set comes from here; the lab config wins where both set one,
  nested objects (`execution`, `codeReview`, `lint`, …) merge key by key, and arrays replace
  (a lab's `lint.exclude` is the whole list). In memory only — never written into a lab's file.
  May not set per-assignment keys (`mappings`, `rubricName`, `canvas`, `handlerModules`).
  `writeCourseConfig` preserves fields it isn't updating, so saving a Canvas course ID keeps
  `defaults`. CS212 uses `"defaults": { "language": "python" }`.
- A course-wide lint ruleset can sit next to `course_config.json`: `configs/{Course}/ruff.toml`
  (Python) or `configs/{Course}/eslint.config.mjs` (JS/TS). Priority: step > lab > course >
  shipped default. CS212's adds ruff `N` (pep8-naming) and `I` (import order) for its style
  checklist.

**Course resolution in `bin/grade.js`:** the **plain interactive menu** (`node bin/grade.js`
with no arguments at all) always shows a course picker first — even with only one course —
plus an "Add new course" option; same for the term picker described below. A **shortcut**
invocation that supplies a positional arg (`node bin/grade.js Lab03`,
`node bin/grade.js TermProject ApiDoc`) skips both prompts and auto-resolves the single
course/term silently, so existing single-course, single-term muscle-memory usage is
unaffected. Once a second course exists, position 0 of the CLI args is always the course
(`node bin/grade.js CS233JS Lab03`) for shortcut usage too. `bin/configure-lab.js` prompts
for (or creates) a course first, the same way, before its assignment/step prompts — but has
no term concept (lab configs are term-agnostic; see "Terms" below).

**Student data layout** mirrors the config-side course tier: `<labRoot>/{Course}/{Assignment}/…`
(Moodle downloads) and `<codeRoot>/{Course}/{Assignment}/{Artifacts,SubmissionsAndAssessment}/…`
(graded output). For a pre-course-tier install, `bin/grade.js` falls back to the flat
`<labRoot>/{Assignment}/` path if the nested one doesn't exist yet (Moodle downloads are
external/Google-Drive-managed, so no forced reorganization), and offers a one-time interactive
move of already-graded `<codeRoot>/{Assignment}/…` output into the nested location the first
time a lab is graded post-upgrade (so `--regrade` doesn't treat everyone as new).

### Terms

A **term** (e.g. "Spring 2026", id `2026Spring`) is a named `{ label, labRoot, codeRoot }`
triple, stored flat in `configs/local-config.json`'s `terms` map — orthogonal to course. It's
what actually determines `labRoot`/`codeRoot` for a run; course is still layered underneath
each term's roots exactly as described above (`<term.labRoot>/{Course}/{Assignment}/…`).
Multiple courses in the same semester share one term.

```json
{
  "terms": {
    "2026Spring": {
      "label": "Spring 2026",
      "labRoot": "G:\\My Drive\\Courses\\CS233JS\\2026-Sp\\StudentLabWork",
      "codeRoot": "D:\\Repos\\CS233JS-Repos\\CS233JS-StudentWork\\2026Spring"
    }
  }
}
```

- **Migration:** `migrateLocalConfigTerms()` (`bin/grade.js`) runs once — if `local-config.json`
  still has the old flat `labRoot`/`codeRoot` keys and no `terms` map yet, it synthesizes a
  single `"2026Spring"` / `"Spring 2026"` term from them and rewrites the file (dropping the
  flat keys; `local-config.json` is gitignored/machine-local, so no dual-shape support is
  kept going forward). A brand-new install starts with an empty `terms` map.
- **Selection:** same always-prompt-in-the-plain-menu / auto-select-on-shortcut rule as course
  selection above. With zero terms, one must be created immediately (this absorbs what used
  to be the unconditional first-run "enter your lab root / code storage root" prompts — those
  prompts now only run as part of creating a term, via `createTerm()` in `bin/grade.js`).
- `bin/configure-lab.js` doesn't prompt for a term — its two best-effort
  `labRoot`/`codeRoot` reads (a step-hint message, an auto-detected-rubric search) just use
  the first entry in `terms` via a small `firstTermRoots()` helper, since lab *configs* don't
  vary by term.

### Config files

Two layouts are supported — flat (single submission set) and multi-step (multiple submission sets, e.g., Proposal + DevEnv + ApiDoc + Beta + Production). Both live under a course directory (see "Courses" above); a single-course install can ignore the `{Course}/` segment mentally — `configs/{Course}/{AssignmentName}/…` behaves exactly like `configs/{AssignmentName}/…` did before.

**Flat lab** — one config at the assignment level:
```
configs/{Course}/{AssignmentName}/
  {assignmentname}_config.json          # e.g. lab06_config.json
  CS233JS_{AssignmentName}_Rubric.xlsm  # rubric template lives alongside config
```
- `rubricName` in the config is the filename only (e.g. `"CS233JS_Lab06_Rubric.xlsm"`), resolved relative to the config's directory.
- Run: `node bin/grade.js Lab06` (or `node bin/grade.js {Course} Lab06` once 2+ courses exist)

**Multi-step lab** — one subdirectory per submission step, no top-level config:
```
configs/{Course}/{AssignmentName}/
  {StepName}/                                     # e.g. DevEnvAndStaticSite/
    {stepname_lower}_config.json                  # e.g. devenvandstaticsite_config.json
    CS233JS_{StepName}_Rubric.xlsm                # rubric lives in the step subdir
  {AnotherStep}/
    {anotherstep_lower}_config.json
    CS233JS_{AnotherStep}_Rubric.xlsm
```
- Detection rule: top-level `{assignmentname}_config.json` is **absent**, but one or more subdirectories each contain a `{subdir_lower}_config.json`.
- `rubricName` in each step config is the filename only (e.g. `"CS233JS_DevEnvAndStaticSite_Rubric.xlsm"`), resolved relative to that step's subdirectory.
- Run: `node bin/grade.js TermProject DevEnvAndStaticSite` (or just `node bin/grade.js TermProject` for an interactive step picker).
- If the labRoot has a matching step subdirectory (e.g. `<labRoot>/{Course}/TermProject/DevEnvAndStaticSite/`), submissions are read from there. If not, submissions are read from `<labRoot>/{Course}/TermProject/` directly — the labRoot step layout is optional.
- `configure-lab.js` asks "Is this assignment turned in in more than one stage (e.g. Beta and Production)?" when creating a brand-new lab; run it once per step to set up each step's config.

**Converting a flat lab to multi-step:**
1. `mkdir configs/{Course}/{Lab}/{StepName}`
2. `mv configs/{Course}/{Lab}/{lab}_config.json configs/{Course}/{Lab}/{StepName}/{stepname_lower}_config.json`
3. `mv configs/{Course}/{Lab}/*.xlsm configs/{Course}/{Lab}/{StepName}/` (move rubric into step subdir)
4. Update `rubricName` in the moved config to remove any path prefix — just the filename.
5. Organize the Moodle labRoot downloads into `<labRoot>/{Course}/{Lab}/{StepName}/` subdirectories.

### Directory structure

```
AI_Grading/   ← repo root (ESM; "type": "module")
  ├── bin/                         # entry points (mapped to cs233-* commands in package.json)
  │   ├── grade.js                 # primary entry point (cs233-grade)
  │   ├── configure-lab.js         # lab config wizard (cs233-configure-lab)
  │   └── rubric-to-md.js          # dump rubric Grade sheet as Markdown (cs233-rubric-to-md)
  ├── src/
  │   ├── pipeline/
  │   │   ├── extract_code.js
  │   │   ├── extract_code_canvas.js  # alternative acquisition source: imports submissions from Canvas
  │   │   ├── runtime_check.js     # check-strategy registry (browser/build/both/run_check)
  │   │   ├── read_code_review.js
  │   │   ├── analyze_code.js
  │   │   ├── lint_code.js
  │   │   ├── validate_html.js
  │   │   ├── validate_css.js
  │   │   ├── check_names.js
  │   │   ├── check_web_content.js # required HTML elements / CSS selectors+properties / file counts (config.webContent)
  │   │   ├── generate_grades.js
  │   │   └── run_pipeline.js      # orchestrator: runs the phases above + generation + log (called by bin/grade.js)
  │   ├── adapters/                 # language adapters — see "Language adapters" above
  │   │   ├── base.js               # interface docs (JSDoc typedefs) + isValidDiagnostics/REQUIRED_ADAPTER_KEYS
  │   │   ├── index.js              # resolveAdapter(config) / registerAdapter
  │   │   ├── javascript.js
  │   │   ├── typescript.js
  │   │   ├── python.js
  │   │   ├── cpp.js
  │   │   └── csharp.js
  │   ├── lib/                     # shared utilities used by pipeline phases + wizard
  │   │   ├── file_walker.js
  │   │   ├── handler_registry.js  # mapping-type handler registry (registerHandler/getHandler/VALID_MAPPING_TYPES)
  │   │   ├── config_validation.js # validateConfig()/loadHandlerModules(), extracted out of bin/grade.js
  │   │   ├── grade_setup.js       # bin/grade.js's interactive setup phase, extracted for testability
  │   │   ├── prompt_driver.js     # createDriver(): TUI or readline backend for bin/grade.js's prompts
  │   │   ├── path_browser.js      # askPath(): folder/file browser over the prompt driver (grade.js path prompts)
  │   │   ├── select_from_list.js  # shared "number or name" picker loop (the readline driver's askOptions)
  │   │   ├── sandbox.js           # runStudentArtifact() — native-code execution isolation chokepoint
  │   │   ├── rubric_writer.js
  │   │   ├── ollama_comments.js
  │   │   ├── lab_config.js        # pure config helpers (spreadsheet parsing, mapping schemas)
  │   │   ├── llm_client.js        # unified LLM client (Ollama / OpenRouter / Anthropic)
  │   │   ├── tui.js               # neo-blessed TUI, shared by configure-lab.js and bin/grade.js
  │   │   ├── config_prompts.js    # driver-based rubric prompt logic (TUI + test shared)
  │   │   ├── variation_detect.js  # checkVersionVariation() + helpers, extracted out of analyze_code.js
  │   │   ├── student_group.js     # lab groups (A/B/C): resolve each student's group, per-group config overrides
  │   │   ├── merge_config.js      # mergeConfig() — shared by course defaults and group overrides
  │   │   ├── notebook.js          # .ipynb → Python script for analysis (readSourceFile)
  │   │   ├── llm_check.js         # llm_check mapping type: AI-suggested score for a qualitative row
  │   │   ├── canvas_client.js     # thin Canvas LMS REST API wrapper (native fetch, no dependency)
  │   │   └── xlsx.js              # ESM wrapper around the xlsx package
  │   └── analyzers/               # (deprecated; now empty) former per-lab custom analyzers
  ├── configs/
  │   ├── local-config.json        # terms{label,labRoot,codeRoot} + optional toolchains/llm/canvas (machine-specific, gitignored, auto-created)
  │   └── {Course}/                # e.g. CS233JS — see "Courses" above
  │       ├── course_config.json   # courseName/courseCode/rubricPrefix/canvasCourseId/defaults (optional; names default to dir name)
  │       ├── ruff.toml / eslint.config.mjs  # optional course-wide lint ruleset (e.g. configs/CS212/ruff.toml)
  │       └── {AssignmentName}/
  │           ├── {assignmentname}_config.json    # flat-lab: rubric config, feature/match rules, cell mappings
  │           ├── CS233JS_{AssignmentName}_Rubric.xlsm  # rubric template (tracked in git)
  │           └── {StepName}/                    # multi-step lab: one subdir per submission step
  │               ├── {stepname}_config.json     # step-level config (e.g. apidoc_config.json)
  │               └── CS233JS_{StepName}_Rubric.xlsm
  └── ...

<labRoot>/    (on Google Drive — raw Moodle downloads only, nothing created here)
  └── {Course}/
      └── {AssignmentName}/
          ├── StudentName_12345_assignsubmission_file/
          │   └── (zip files uploaded by student, if any)
          └── StudentName_12345_assignsubmission_onlinetext/
              └── onlinetext.html

  # Multi-step: Moodle downloads are in step subdirectories
  └── {Course}/
      └── {AssignmentName}/
          └── {StepName}/
              ├── StudentName_12345_assignsubmission_file/
              └── StudentName_12345_assignsubmission_onlinetext/

  # Pre-course-tier fallback: bin/grade.js reads from the flat <labRoot>/{AssignmentName}/
  # path too if the nested one above doesn't exist yet — Moodle downloads are external, so
  # no upfront reorganization is required to adopt the course tier.

<codeRoot>/   (local, outside Google Drive)
  └── {Course}/
      └── {AssignmentName}/  ← flat lab: created automatically; keeps different assignments separate
          ├── Artifacts/   ← grader-produced files (reports, log)
          │   ├── analysis_report.json
          │   ├── lint_report.json
          │   ├── runtime_report.json
          │   ├── html_validation_report.json
          │   ├── css_validation_report.json
          │   ├── name_check_report.json
          │   ├── web_content_report.json  (only for labs with config.webContent)
          │   └── grading_log.txt
          └── SubmissionsAndAssessment/  ← student code + per-student grade spreadsheets
              └── StudentName/
                  ├── repo/  (GitHub clone)  or  extracted_code/  (unzipped)
                  └── StudentName_Grade.xlsx

  # Multi-step: each step gets its own Artifacts + SubmissionsAndAssessment tree
  └── {Course}/
      └── {AssignmentName}/
          └── {StepName}/
              ├── Artifacts/
              └── SubmissionsAndAssessment/
                  └── StudentName/
                      └── StudentName_Grade.xlsx
```


- ESLint ruleset: shipped at `eslint/student.eslint.config.mjs`, overridable course-wide via `configs/{Course}/eslint.config.mjs` and per-lab via `configs/{Course}/{Lab}/eslint.config.mjs` (or per-step); Python's `ruff.toml` follows the same levels; `lint_code.js` copies the resolved config into the lab folder for VS Code consistency. The grader's *own* source is linted via the repo's root ESLint config (`npm run lint`, the CI gate).
- `--reclone` implies `--regrade`.
- In **normal mode** (no flags), students whose grade spreadsheet already exists are skipped entirely — no runtime check, analysis, linting, or spreadsheet rewrite. Use `--regrade` to re-process them.
- **`--regrade` without `--reclone`** automatically runs `git pull` on each student's cloned repo before re-grading, so updated submissions are picked up without a full re-clone.
- When `labDir` contains no direct Moodle submissions but has subdirectories that do (e.g., Moodle exported Beta/Production as separate groups), `bin/grade.js` prompts you to pick which group to grade.
- `configs/local-config.json` is tried first; `default-config.json` (shipped with the repo) is the fallback for new machines.
- Each pipeline phase attaches data to the shared `students` array; `generate_grades` consumes the combined output.
- **Canvas as a code-acquisition source (`--canvas`):** an alternative to the default Moodle-folder flow — imports one assignment's submissions directly via the Canvas API (`src/pipeline/extract_code_canvas.js`) instead of scanning `<labRoot>/<Course>/<LabName>/`. The plain interactive menu offers the same thing without the flag: a "Download from Canvas" submission-source option right after the term picker (it just sets the same internal flag). First use (`--canvas`/the menu option, or whenever a lab's config has no `canvas.assignmentId` yet) prompts for a Canvas course ID — defaulting to the course's already-known `course_config.json`'s `canvasCourseId` if set — fetches and prints the course name for confirmation (re-prompts on "n" or a 404), then lists the course's assignments (auto-guessing a match against the lab/step name) for you to pick from. The confirmed Canvas course ID is saved onto the **course** (`configs/{Course}/course_config.json`'s `canvasCourseId`) since it doesn't change lab-to-lab; only `{ assignmentId }` is saved into the individual lab's own config file. The Canvas URL/API token resolve `CANVAS_URL`/`CANVAS_TOKEN` env vars first, then `configs/local-config.json`'s `canvas.{url,token}` block (prompted and saved on first use) — the same precedence `llm_client.js` uses for its API keys. Once downloaded, Canvas-sourced submissions live in the exact same `submissionsDir/<Student>/{repo,extracted_code}/` layout the Moodle path uses, so every other phase and `--reclone`/`--regrade` behave identically regardless of source.

### Config schema (configs/{Course}/{AssignmentName}/{assignmentname}_config.json)

  - extractOnly: boolean (optional) — when `true`, only the extraction phase runs; no runtime check, analysis, lint, or grade generation. Useful for previewing what was submitted before configuring the full rubric.

  - textReport: boolean (optional) — when `true`, this lab always produces per-student `.txt` grade reports (same effect as passing `--text-report` every run) and `rubricName` becomes optional. Used by courses with no rubric spreadsheets (all CIS195 labs).

  - language: string (optional, default `"javascript"`) — selects the language adapter (`src/adapters/`) used by analysis/lint/runtime-check: `javascript` | `typescript` | `python` | `cpp` | `csharp`. Existing labs need no change — the default preserves current behavior exactly.

  - rubricName: string — rubric filename in the lab directory

  - runtimeCheck: "none" | "browser" | "build" | "both" | "run_check" | (any name registered via `registerCheckStrategy`)
    - `"none"` is a no-op for labs with nothing to run (static multi-page markup labs, e.g. all of CIS195) — runtimeCheck is a required key, so markup-only labs set this rather than paying for a browser pass.
    - `"browser"` serves the submission's source `index.html` directly. This only works for plain static sites; a Vite/bundled project has bare module imports (`import x from 'pkg'`) that the browser can't resolve unbuilt, so `"browser"` reports false load failures for them. For anything that needs a build step, use `"build"` (or `"both"` to also browser-check the built `dist/`).
    - `"both"` runs build first, then Puppeteer browser check against the built output. Use `build_check` / `browser_check` / `build_and_browser_check` mapping types to score them separately or together.
    - `"run_check"` builds (if the adapter has a build step) then executes the produced artifact directly — see `config.runCheck` below and the `run_check` mapping type. Intended for non-web languages (Python/C++/C#) whose runtime signal is "did the program run and produce the right output," not a browser check.

  - runCheck: { stdin, expectPatterns[], timeoutMs, entry, supportFiles[] } (optional) — used when `runtimeCheck: "run_check"` (`supportFiles` also applies to `test_check`). `stdin` is fed to the program; `expectPatterns` are regex strings matched against combined stdout (all must match for success); `timeoutMs` (default 10000) is the kill-tree timeout. `entry` — the program to run (Python: bare filename, project-relative path, or a list of either tried in order for programs students name differently; default `main.py`; not found → `NEEDS MANUAL CHECK`). **Several programs:** `runCheck` may instead be a list of runs, each `{ "id": ..., entry, stdin, expectPatterns, supportFiles, timeoutMs }` (e.g. CS212 Lab01's two programs); a `run_check` mapping with `runId` scores one run, without it every run must pass. `supportFiles` — instructor files/folders added to the run directory where the student has none, each a path relative to the lab's config folder (`"Data"`) or `{ "from": "GroupA-Data", "to": "Data" }`.

  - testCheck: { mode, entry, passPattern, failPattern, timeoutMs, supportFiles } (optional) — how `test_check` runs tests (Python). `supportFiles` as for runCheck; when absent, a single-object `runCheck`'s `supportFiles` are used (a `runCheck` list's per-run files are not shared with tests). `mode`: `"pytest"` (default) or `"script"` — run the student's own test script `entry` and count lines matching `passPattern`/`failPattern` (default `^\s*PASS\b` / `^\s*FAIL\b`); a crash/traceback/timeout counts as one more failure, and a script printing neither counts as one test decided by its exit code. `timeoutMs` default `execution.timeoutMs`, else 60000. **Several test scripts:** `testCheck` may be a list, each with an `id`; a `test_check` mapping with `testId` scores one script, without it the totals across all scripts (a script that can't run counts as one failure). A missing test script is `NEEDS MANUAL CHECK`.

  - execution: { mode, timeoutMs, cwd, envCacheDir, installTimeoutMs } (optional) — `cwd`: `"scratch"` (default — an empty throwaway directory) or `"copy"` (a throwaway copy of the student's project folder, for programs that open files relative to it; CS212's course default). `envCacheDir`: where Python uv environments are cached (default `<tmp>/grader-python-envs`). `installTimeoutMs`: dependency-install timeout (default 10 minutes). `mode` is the isolation tier for `run_check`'s artifact execution (see `src/lib/sandbox.js`). `mode`: `"direct"` (default; implemented — spawn + timeout + kill-tree + fresh throwaway cwd, NOT a security sandbox, trusted-classroom use only) | `"restricted-user"` | `"container"` (both documented, loud-failing stubs — never silently fall back to `"direct"`).

  - urlPatterns: { [label]: hostnameSubstring } (optional) — overrides/extends the URL categories `extract_code.js` looks for in `onlinetext.html` (and, for a Canvas-sourced lab, in `extract_code_canvas.js`'s `online_text_entry`/`online_url` submissions). Default: `{ github: "github.com", citstudent: "citstudent.lanecc.edu" }`. `github` is structurally special (decides clone-vs-zip); `colab` is too (a Colab link with no other code → the notebook is downloaded; see `extract_code.js` above); other keys are just labels read by `url_check`/`deploy_check` mappings' `urlType` field.

  - canvas: { assignmentId } (optional) — set once, either by hand or by `bin/grade.js --canvas`'s interactive setup, to make this lab always acquire code from Canvas instead of a Moodle folder. The Canvas course ID itself lives one level up, on the course (`configs/{Course}/course_config.json`'s `canvasCourseId`) — not per-lab, since a course's Canvas ID doesn't change assignment to assignment. `bin/grade.js` resolves the Canvas URL/token from `CANVAS_URL`/`CANVAS_TOKEN` env vars first, then `configs/local-config.json`'s `canvas.{url,token}` block.

  - handlerModules: string[] (optional) — paths (relative to the lab's config dir) to JS modules that call `registerHandler()` as a side effect on import, so a lab can add mapping types without editing `generate_grades.js`. Loaded by `bin/grade.js` immediately after the config is parsed and **before** `validateConfig()` runs — a mapping type registered by one of these modules must already be recognized as valid when validation checks every mapping's `type`.

  - toolchains: { python, uv, cpp: { compiler }, csharp: { dotnet } } (optional, machine-specific — normally set in `configs/local-config.json`, not a per-lab config) — compiler/interpreter commands or full paths, for when they're not on the default PATH (e.g. a WinGet-installed MinGW g++ under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\...`, not PATH by default). `bin/grade.js` merges `local-config.json`'s `toolchains` into the lab config (lab config can override individual entries) before grading starts.

  - llmCheck: { provider, model, baseUrl, maxChars, timeoutMs } (optional) — the model `llm_check` rows use. `provider`: `"ollama"` (default — local, student code never leaves the machine) | `"openai"` (any OpenAI-compatible API, e.g. DeepSeek: set `baseUrl`; key from `LLM_API_KEY`, else the matching `llmEndpoints`/`llm` entry in `local-config.json`, model from `model` or that entry; CS212 Lab01 uses it) | `"openrouter"` | `"anthropic"` (sends student code, including names in its header comments, to that service — only where student-privacy rules allow; API key from `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`, else `local-config.json`'s `llm.apiKey` when that block is for the same provider). `model`: default the first installed Ollama model (or the provider's default). `maxChars`: code budget per request (default 40000). `timeoutMs`: per request (default 120000). Can go in course `defaults`.

  - summaryCell: string (optional) — cell for AI/manual summary comment
  - graderCell: string (optional) — cell written with "Computer" on every new spreadsheet. On `--regrade`, if the cell still contains "Computer" the file is overwritten; if it has been changed (e.g. to "Brian Bird" after manual review) a new versioned copy is written (`StudentName_Grade-V2.xlsm`, `-V3`, …) instead.
  - titleCell, titleText: (optional) — cell and text for lab title

  - codeReview: { studentNameCell, groupCell, manualFallback } (optional) — `studentNameCell`/`groupCell` name the cells where the student name and lab group letter are written. There is **no default**: if a cell is not specified, that value is not written (generic code makes no assumption about rubric layout). All current lab rubrics use `B1`/`C1`.

  - variations: { "A": { appName, overrides }, "B": { … }, "C": { … } } (optional) — the lab's groups, for labs where each group builds a different version (e.g., group A builds "Double Trouble Domino"; CS212 Lab02's groups schedule sections, flights or deliveries). `appName` lets `variation_detect.js` detect the group from the code (folder names, HTML titles, package.json / pyproject.toml names, README), recorded in `analysis.versionVariation` and used when the review form gives no group. `overrides` (optional) — settings merged into the lab config for that group's students: only `runCheck`, `testCheck`, `execution`, `analysis`, `packageCheck`, `webContent` (validation rejects others, e.g. `mappings`/`parts`, which the per-student phases don't read). Merge rule as for course defaults: nested objects merge, arrays replace — keep feature `id`s the same across groups so the shared rubric rows find them. Validation checks each group's merged config on its own (a `runId`/`testId` must exist for every group). The instructor can also assign groups by name for one term's run with `<codeRoot>/…/Artifacts/group_overrides.json` (`{ "Student Name": "A" }`), which wins over the review form and detection (`student_group.js`). A student whose group is unknown gets every row that depends on an overridden setting flagged `NEEDS MANUAL CHECK: lab group unknown …`.
  - variationExcludeNamePatterns: string[] (optional) — extra regex-source strings (matched against directory-name components) to exclude from `checkVersionVariation`'s search corpus, in addition to the built-in defaults (`_starter`, `_template`, `filestostudents` — CS233JS's own distributed-starter-file naming convention, kept as the default for backward compatibility, not a universal one). Use this if a course's starter files follow a different naming pattern.

  - analysis.features[] — features detected per file. Each entry has `{ id, fileRegex }` plus **either**:
    - **counted:** `{ regex }` — counts regex matches; the `feature` mapping passes when count ≥ `minCount` (default 1).
    - **boolean (match):** `{ match }` where `match` is a nested tree of `{ regex, flags? }` leaves combined with `allOf` / `anyOf`. The feature is `1` if the tree is satisfied across the searched files, else `0`. Each leaf's presence is computed **codebase-wide**, so an `allOf` matches even when its patterns appear in different files. Use it for checks needing AND/OR of patterns — e.g. `modules` = import AND export, or a group-variation row = any-of several implementations. Comments are stripped from `.js` before matching. (See `evalMatchNode` in analyze_code.js.) `validateConfig` accepts `regex` or `match`.
  - analysis.customAnalyzer: string (optional) — **⚠️ DEPRECATED — do not write new custom analyzers.** The grading system runs on flexible, reusable, config-driven modules. Express every check with a generic mapping type / feature check; if the logic exceeds a single regex, use a nested `match` (allOf/anyOf) feature (above) rather than a per-lab analyzer. A custom analyzer is a documented last resort, allowed only when a check genuinely cannot be expressed generically.
    - **Status: no analyzers currently exist.** All former analyzers were removed — Lab02 (`modules`) and Lab05 (`c12`/`c13`) migrated to nested `match` features; Lab06's was text-report-only and deleted. The `src/analyzers/` directory was removed entirely; if a custom analyzer is ever re-added as a documented last resort, recreate the directory and place the module there.
    - Mechanics (if one is ever re-added as a last resort): filename of a JS module in `src/analyzers/` that receives (jsFiles, analysis, config, student) and merges its return into `analysis`. May set `analysis.features[id]` and/or `analysis.reportSections: [{ title, lines[] }]` (text-report output only — not used for spreadsheets).

  - parts[]: { id, gameNames[], folderPattern, featureCounts[] } — multi-part lab config (optional). gameNames is the list of expected game/project names for that part; folderPattern is a regex fallback for "Part1/Pt2"-style folder naming.

  - webContent: (optional) — drives the `check_web_content.js` phase (skipped entirely when absent). All checks are offline.
    - requiredElements[]: { id, selector, minCount, description, dirPattern } — jsdom `querySelectorAll(selector)` counts summed across all HTML files; passes when total ≥ minCount (default 1). `id` defaults to the selector string; optional `dirPattern` (regex on the file's relative path) restricts which files an entry is checked in. Invalid selectors fail the entry with an error, never crash.
    - requiredCssSelectors[]: strings — each must appear as a rule selector in external/embedded CSS (comma lists split, whitespace-normalized; raw-substring fallback).
    - requiredCssProperties[]: strings — bare property name (`grid-area`) or `prop: value` pair (`display: grid`, whitespace/case-insensitive); found in external CSS, embedded `<style>`, or inline `style=""` attributes.
    - fileCounts[]: { id, pattern, min } — count of files whose basename matches the regex `pattern` (case-insensitive) must be ≥ min. Referenced by `file_count` mappings via `countId`.
    - exclude[]: path substrings to skip (falls back to `validate.exclude`).

  - validate: (optional) — config for HTML and CSS validation phases
    - exclude[]: path substrings to skip (shared by both validators and name check)
    - htmlExtends[]: override the html-validate preset list (default: `['html-validate:recommended']`)
    - htmlRules: object — per-rule overrides (e.g. `{ "no-inline-style": "error" }`)

  - nameCheck: (optional)
    - extraAllowed: string — additional characters to allow in file/folder names beyond `[A-Za-z0-9._-]`

  - mappings[] — rubric cell assignments (types listed below)
    - types: feature | part1_completed | part_completed | apps_in_repo | developer_comments | code_review | url_check | deploy_check | lint | build_check | browser_check | build_and_browser_check | run_check | test_check | html_validate | css_validate | name_check | manual | part_feature | repo_hygiene | github_repo | collaborator_check | gitignore_check | scripts_check | npm_package | package_usage | package_check | manifest_check | env_file_check | path_exists | element_check | css_selector_check | css_property_check | file_count | llm_check
    - `element_check` / `css_selector_check` / `css_property_check` mappings score `student.webContent` proportionally (passed/required, rounded); an optional `ids` / `selectors` / `properties` field (array or comma-separated string) scores a subset — e.g. one mapping per lab part. Comments list up to 5 missing items with `keepComment: true` so `stockComments.zero` never masks the diagnostic.
    - `file_count` mappings are all-or-nothing per counter: full credit when the `webContent.fileCounts` entry named by `countId` meets its `min`, else 0 with a "Found N, expected M" comment. Requires `countId`.
    - `package_usage`/`manifest_check` are language-neutral aliases of `npm_package`/`package_check` (same handler functions) — the underlying logic reads adapter-populated `analysis.npmPackages`/`analysis.packageCheck` and isn't actually npm-specific; use whichever name reads better for the lab's language.
    - `run_check` mappings score the `"run_check"` runtime strategy's result (`student.runtimeCheck`): full credit if the program ran and matched `config.runCheck.expectPatterns`, else 0 with the failure detail (exit code + the last lines of stderr, e.g. a traceback's error line; timeout; or which pattern was missing) preserved via `keepComment: true`. Optional `runId` scores one run of a `runCheck` list.
    - `test_check` mappings score proportionally against `student.testCheck` (`{ total, passed, failures[] }`, from the adapter's `runTests` — pytest, a PASS/FAIL test script (`testCheck.mode: "script"`), dotnet test): `score = maxScore × passed/total`, full credit if all pass, comment lists up to 5 failing test names. Optional `testId` scores one script of a `testCheck` list.
    - any mapping may include `stockComments: { full, partial, zero }` — short strings written into the comment cell instead of the verbose auto-generated comment. `keepComment: true` handlers (e.g. `deploy_check` manual-review flags, `lint`) are **not** overridden by `stockComments.zero`.
    - lint mappings accept an optional `severity: "errors" | "warnings"` to report only errors (syntax) or only warnings (style) into separate cells. The comment cell is written with the actual linter findings (top issues by frequency), not a stock comment — lint sets `keepComment: true` so `stockComments` is ignored for this type.
    - `html_validate` / `css_validate` mappings accept `tolerance` (default 3) — errors ≤ tolerance score half points; more score zero
    - `name_check` mappings accept `tolerance` (default 2) — same half/zero tier logic
    - `scripts_check` mappings accept `scripts` (comma-separated string or array, default `"dev,build,test"`) — list of npm script names to verify. Score is proportional to how many pass.
    - `code_review` mappings: comment reports both review presence and production column completion as "yes and yes" / "yes and no" / "no and no". Full points when both are true; half points (maxScore/2) when review submitted but production column incomplete; 0 when no review.
    - `manual` mappings: without `reviewRow`, a pure placeholder (maxScore + `msg`, for the grader to confirm). With `reviewRow` — a case-insensitive substring of a code-review criterion, or an array of them for a rubric row covering several questions — the row is pre-scored from the student's review form: production column (fraction or Yes/No), falling back to a beta fraction; for an array every row must be answerable and the lowest score wins (any "No" → 0). `reviewRowOccurrence` (1-based) picks a repeated question in a later table (e.g. Lab03's Part 2 "Does the game work correctly?"). A `reviewRow` that matches nothing flags the row for manual review with the maxScore placeholder. (There is no positional matching: review forms have blank spacer rows, so mapping order never lined up with criteria.)
    - `llm_check` mappings: `{ criterion, guidance?, files?, maxScore }` — an AI model reads the student's code and suggests a score for one qualitative row (`criterion`, e.g. "Is I/O separated from the inference code?"; optional `guidance` describes full/partial/no credit; optional `files` regex on project-relative paths chooses what it reads, e.g. `"\\.(py|csv)$"` to include a rule file). Always a suggestion: the comment is `NEEDS REVIEW (AI suggestion, <model>): <reason>` (`keepComment`), so the instructor confirms every one. If no model is available or the reply is unusable, scores 0 with `NEEDS MANUAL CHECK: AI check unavailable (…)`. Model settings: `llmCheck` above. Implementation: `src/lib/llm_check.js`.
    - `developer_comments` mappings: checks source-file **comments only** (via the adapter's `extractComments`; Python docstrings count). Per file it records `name` (an author/name keyword like `Author:`/`Written by`, or the student's first/last name as a whole word), `date` (a date keyword or an actual date — `1/5/2026`, `2026-01-05`, `Jan 5`, `Fall 2025`), and `ai` (an AI-use disclosure — "AI", ChatGPT, Copilot, Claude, Gemini, LLM, …; "No AI was used" counts — within the file's first 40 lines, since code deeper in an AI-course project legitimately mentions these). Optional `require`: array of `"name"`/`"date"`/`"ai"` a file must ALL have (default: name OR date). Optional `requireAiDisclosure`: `true`/`false` — the on/off switch that adds the AI-use disclosure to whatever else is required (CS233JS Lab01–04 set `true`, matching their review forms' "description of any AI used (and how)"; later labs set `false`). Optional `ignoreCommentsBy`: array of strings — comment lines containing one (e.g. `"Brian Bird"`) are ignored, so the instructor's starter-file header ("By Brian Bird, winter term 2026, using GitHub Copilot…") doesn't count as the student's name/date/AI disclosure; a line that also names the student is kept ("Andy Still, Jan 2026, based on code by Brian Bird"). Optional `scope`: `"any"` (default — one file passes) or `"each"` (every non-empty source file must; the comment lists failing files with what each lacks, kept through `stockComments`). CS212 review forms ask for name, AI use and date in each file: `"require": ["name", "date", "ai"], "scope": "each"`.
    - `deploy_check` mappings: async — fetches the citstudent URL with up to 3 attempts (10s timeout each, 2s delay between retries), then inspects `<script>` tags for bundling indicators (hashed filenames, assets/dist/static paths, bundle/min/chunk). Full points for reachable + bundled; half points for reachable but unbundled. When the URL cannot be verified — a thrown fetch (DNS/connection/TLS/timeout) or an HTTP error response — the handler scores 0 **but flags the row for manual review** with a `NEEDS MANUAL CHECK: … — verify deployment manually` comment that carries the real failure reason (e.g. `ECONNRESET`, `HTTP 503`). It sets `keepComment: true` so this diagnostic is **not** overwritten by `stockComments.zero`; this prevents a transient grader-side network failure from silently zeroing a student whose app is actually live. A genuinely missing URL still scores 0 with the plain stock "zero" comment. Any handler may return `keepComment: true` to protect its comment from the stock-tier override.
    - `env_file_check` mappings: full points if a `.env` file containing at least one `KEY=VALUE` pair is present in the submission. When not found, scores 0 but flags for manual review (normal if the file is gitignored and the student submitted via GitHub).
    - `path_exists` mappings: full points if any file whose path contains `pathPattern` (substring or regex) exists in the submission. Use for "required file created" checks (e.g., verify a specific config or output file is present). Requires `pathPattern` field.

  - lint.exclude[]: path substrings to skip during linting
  - repoHygiene.excludedFromRepo[]: folder names that should not be committed (checked via `git ls-files`; only applies to git-cloned repos)
  - packageCheck: { dependencies[], devDependencies[], allowedExtras[], importAliases{} } — expected npm package sections; `allowedExtras` whitelists packages the student may add beyond the required ones. Python reads `pyproject.toml` (else `requirements.txt`); `importAliases` maps extra distribution names to their import names (`{ "my-dist": "mymod" }`).
