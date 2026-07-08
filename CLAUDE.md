## Overview

AI grading pipeline built for CS233JS (Lane Community College), grading student JavaScript lab submissions downloaded from Moodle. The pipeline extracts student code, runs analysis/lint/runtime checks, then fills in rubric spreadsheets (.xlsx/.xlsm) with scores and comments. Language-specific mechanics (linting, building, running, testing) are behind a pluggable adapter layer (`src/adapters/`, `config.language`, default `"javascript"`) — TypeScript, Python, C++, and C# are also supported for courses that need them; see "Language adapters" below.

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

node bin/rubric-to-md.js path/to/Rubric.xlsm  # dump Grade sheet as Markdown (or: cs233-rubric-to-md)
node bin/configure-lab.js [AssignmentName]    # lab config wizard + copy rubric (or: cs233-configure-lab)
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
- **globals** — browser/node global definitions for ESLint flat config
- **eslint** — v9+ flat config
- **typescript**, **@typescript-eslint/parser**, **@typescript-eslint/eslint-plugin** — the `typescript` language adapter's lint/build tooling
- **neo-blessed** — terminal UI framework used by `configure-lab.js` wizard
- **vitest** (dev) — test runner

Non-Node toolchains used by the `python`/`cpp`/`csharp` language adapters are **not**
npm dependencies — they must be present on the grading machine (or pointed to via
`configs/local-config.json`'s `toolchains` section if not on PATH): a Python
interpreter + `ruff` + `pytest` (`pip install ruff pytest`), a C++ compiler
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
- **python** (`python.js`) — `requirements.txt` manifest (flat, no dependencies/devDependencies split); `ruff` for lint (JSON output normalized to the shared diagnostics shape); `py_compile` for a syntax-only "build"; `pytest` (text-summary parsed, no JSON-report plugin dependency) for `runTests`. No `runScript` — no npm-style named-script concept.
- **cpp** (`cpp.js`) — `detectProject` prefers CMakeLists.txt, then a Makefile, then falls back to compiling loose `.cpp`/`.cc`/`.cxx` files directly (the common case for intro submissions). Only the "loose" path gets structured diagnostics (g++/clang SARIF via `-fdiagnostics-format=sarif-stderr` for GCC / `=sarif` for clang — the adapter probes `--version` once to pick the right spelling, since clang, including macOS's `g++`, rejects GCC's); CMake/Makefile builds are success/fail only. `stripComments` protects C++11 raw string literals (`R"(...)"`) before the generic string pass. No manifest/package concept.
- **csharp** (`csharp.js`) — parses a `.sln`/`.slnx` (supports both the classic text format and the newer XML format the .NET SDK now defaults to) for multi-project references (class library + console app + test project is a common student layout), or a loose `.csproj`. Diagnostics come from `dotnet build`'s plain-text MSBuild output (regex-parsed, no binlog/XML dependency); `runTests` parses `dotnet test`'s console summary line. `stripComments` protects verbatim (`@"..."`, where `""` is an escaped quote) and C# 11 raw string literals.

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
trusted-classroom submissions, not deliberately malicious code.

### Pipeline (`bin/grade.js` → `src/pipeline/run_pipeline.js`)

`bin/grade.js` owns CLI parsing, interactive prompts, and path resolution, then calls
code acquisition directly and hands off to **`src/pipeline/run_pipeline.js`**'s
`runPipeline(students, config, dirs, options)` for everything else. The phase list is
data (`PHASES`, each `{ name, run, when }`) rather than a hardcoded sequence of awaits —
a future per-language config key can gate a phase (e.g. skip markup validation for a
non-web language) without touching the loop. `runPipeline` also runs the resolved
adapter's `preflight` check upfront, filters out already-graded students (unless
`--regrade`), then generates grades and writes `grading_log.txt`.

1. **src/pipeline/extract_code.js** — Reads Moodle submission dirs. Unzips `.zip` files or clones GitHub repos from URLs in `onlinetext.html`. URL categories are config-driven via `config.urlPatterns` (default `{ github: "github.com", citstudent: "citstudent.lanecc.edu" }` — same behavior as before for existing labs); `github` is structurally special (decides clone-vs-zip), other keys are just labels for `url_check`/`deploy_check` mappings. Attaches `student.extractedDir`, `student.urls`, `student.filesDir`.
2. **src/pipeline/runtime_check.js** — Dispatches to a named check **strategy** registered via `registerCheckStrategy(name, fn, opts)` (mirrors the mapping-handler registry). Built-in strategies: `"browser"` — Puppeteer captures console errors and failed loads (generic, not language-specific). `"build"` — delegates to the resolved adapter's `install`/`build`. `"both"` — build first, then browser-checks the built `dist/`; stores `buildSuccess`/`browserSuccess` sub-results separately. `"run_check"` — builds (if needed) then executes the produced artifact via the sandbox chokepoint above, matching stdout against `config.runCheck.expectPatterns`. `VALID_RUNTIME_MODES` (exported, used by `bin/grade.js`'s config validation) is populated automatically as strategies register — a new strategy doesn't require editing the validator. Also runs a `scripts_check` sub-phase (adapter-delegated; verifies named scripts are defined/pass) when `scripts_check` mappings are present, and a `test_check` sub-phase (adapter's `runTests`) when `test_check` mappings are present. Attaches to `student.runtimeCheck`, `student.scriptsCheck`, `student.testCheck`.
3. **src/pipeline/read_code_review.js** — Reads each student's code review form (`.docx`). Parses the HTML table (via mammoth) to extract per-item beta and production scores, plus the lab assignment group letter. Attaches `student.codeReview` with `items[{betaScore, prodScore}]`, `productionCompleted`, and `group`. Runs *before* analysis so the group letter is available to the analyzer.
4. **src/pipeline/analyze_code.js** — Regex-based feature detection per-lab config, driven by the resolved adapter's `sourceExtensions`/`stripComments`/`checkManifest`/`extractUsedPackages` (default JS). For multi-part labs, matches subdirs to game names from config. Checks repo hygiene *before* runtime modifications. Attaches to `student.analysis`. A configured `customAnalyzer` is invoked via `applyCustomAnalyzer()`, whose return object is merged into `analysis` (a throwing analyzer is logged and skipped). A custom analyzer can attach `analysis.reportSections` (see below) to add lab-specific output to text reports without touching generic code.
5. **src/pipeline/lint_code.js** — Delegates to the resolved adapter's `lint()`/`lintConfigCandidates()`. For JS: runs ESLint (flat config) against each student's source files; ruleset resolution is a per-step or per-lab `configs/{Lab}/eslint.config.mjs` override if present, else the shipped `eslint/student.eslint.config.mjs`; the resolved config is also copied into the lab folder for editor consistency. Attaches to `student.lint` with `{ sourceFiles, errors, warnings, errorMessages, warningMessages, messages, ruleCounts }`.
5b. **src/pipeline/validate_html.js** — Validates `.html`/`.htm` files with `html-validate` (pure JS, offline). Attaches `student.htmlValidation` with `{ htmlFiles, errors, warnings, messages, ruleCounts }`. Respects `config.validate.exclude`. Ruleset overrideable via `config.validate.htmlExtends` / `config.validate.htmlRules`; `no-trailing-whitespace` is off by default.
5c. **src/pipeline/validate_css.js** — Validates `.css` files with `csstree-validator` (pure JS, offline). Attaches `student.cssValidation` with `{ cssFiles, errors, warnings, messages, ruleCounts }`. Reports validity errors only (no warning tier). Respects `config.validate.exclude`.
5d. **src/pipeline/check_names.js** — Checks every file and folder name in the submission for Linux/web portability. A name is invalid if it contains any character outside `[A-Za-z0-9._-]` (spaces, parens, accented chars, etc.). Attaches `student.nameCheck` with `{ entriesChecked, errors, messages, badNames }`. Extra allowed characters configurable via `config.nameCheck.extraAllowed`.

6. **src/pipeline/generate_grades.js** — Reads from `student.analysis`, `student.lint`, `student.runtimeCheck`, `student.codeReview`, `student.htmlValidation`, `student.cssValidation`, `student.nameCheck`, `student.scriptsCheck`, `student.testCheck`. Fills rubric `.xlsx`/`.xlsm` cells using handler functions per mapping type, registered via `../lib/handler_registry.js` (`registerHandler`/`getHandler`/`VALID_MAPPING_TYPES` — a standalone module so `bin/grade.js` can load `config.handlerModules` and validate mapping types without pulling in this file's heavier ollama/rubric_writer dependencies). For `.xlsm` rubrics, delegates OOXML/ZIP surgery to `src/lib/rubric_writer.js`. With `--ai-comments`, calls `src/lib/ollama_comments.js` to generate a one-sentence summary for `config.summaryCell`. With `--text-report`, produces `.txt` grade reports instead of spreadsheets — useful when a rubric template isn't available yet. If `config.graderCell` is set, writes "Computer" into that cell; on regrade, creates a versioned copy (`-V2`, `-V3`, …) rather than overwriting a spreadsheet that has been manually reviewed.

### Shared utilities (`src/lib/`)

- **src/lib/file_walker.js** — Recursive directory traversal. Exports: `walk(dir, opts)` (core traversal with `visit`, `onFile`, `onDir`, `shouldSkip`, `shouldDescend`, `followSymlinks`, `maxDepth`); `getAllFilesByExt(dir, ext, exclusions)` (collect files by one extension or an array of extensions); `DEFAULT_SKIP_DIRS` (Set of dirs never scanned: `node_modules`, `dist`, `build`, `.git`, `__MACOSX`).
- **src/lib/handler_registry.js** — The mapping-type handler registry (`registerHandler`, `getHandler`, `VALID_MAPPING_TYPES`), extracted from `generate_grades.js` into its own lightweight module. Wizard-facing metadata (labels/descriptions/field prompts) still lives separately in `lab_config.js`'s `MAPPING_TYPES`/`MAPPING_TYPE_SCHEMA` — deliberately not merged in yet (see `test/generate_grades.spec.mjs`'s "mapping-type lists stay in sync" test, which fails loudly if the two drift; full metadata consolidation is a documented future step for whenever the wizard's schema next needs to change anyway).
- **src/lib/config_validation.js** — `validateConfig(config, labName)` and `loadHandlerModules(config, labConfigDir)`, extracted out of `bin/grade.js` so they're unit-testable without stubbing `process.exit` (`validateConfig` throws an `Error` on failure instead; `bin/grade.js` catches it and exits). Depends only on `VALID_MAPPING_TYPES` (`handler_registry.js`), `VALID_RUNTIME_MODES` (`runtime_check.js`), and `fs`/`path`/`url` — no CLI/readline machinery.
- **src/lib/sandbox.js** — `runStudentArtifact()`, the native-code-execution isolation chokepoint. See the "Language adapters" section above.
- **src/lib/rubric_writer.js** — Low-level OOXML/ZIP surgery: column-width recovery, drawing/button preservation, reducing the workbook to the Grade sheet, restoring non-Grade sheets as `veryHidden` for VBA binding.
- **src/lib/ollama_comments.js** — HTTP client for a local Ollama server; generates one-sentence AI rubric summaries.
- **src/lib/lab_config.js** — Pure, UI-agnostic functions for lab configuration. Exports spreadsheet helpers (`readRubricRows`, `detectRubricLayout`), assignment discovery (`getExistingAssignments`, `getExistingSteps`), config assembly (`buildConfig`, `writeLab`), mapping type schemas (`MAPPING_TYPES`, `MAPPING_TYPE_SCHEMA`), and `guessMappingType`. No readline/TUI/process.exit — safe to import from anywhere including tests.
- **src/lib/llm_client.js** — Unified LLM client supporting Ollama, OpenRouter, and Anthropic. Used by `configure-lab.js` to generate AI-assisted config drafts. Exports `LLMClient`, `loadLLMClient` (reads provider/key from `local-config.json`), `setupLLMInteractive`, and `selectModel`. Handles HTTP 429 rate-limit retries with fallback model.
- **src/lib/tui.js** — Terminal UI primitives for `configure-lab.js` wizard (neo-blessed). Provides a scrollable log pane, text input bar, arrow-key option popup, full-screen review table, and spinner. Redirects `console.log`/`console.error` to the TUI pane while active.
- **src/lib/config_prompts.js** — Driver-based rubric prompt functions shared between the TUI wizard and tests. Implements `promptRubricRows`, `promptRubricCriteria`, `copyRubric`, `promptFields`, and `buildMappingEntry`. Uses a driver interface (`ask`, `askBoolean`, `askInt`, `askOptions`, `print`, `exit`) so the same logic runs in both interactive and test contexts.
- **src/lib/variation_detect.js** — `checkVersionVariation(extractedDir, variations)` and its helpers (`buildVariationCorpus`, `variationKeywords`, `VARIATION_KEYWORD_STOPWORDS`), extracted out of `analyze_code.js` — self-contained, no dependency on `analyze_code.js`'s per-student state. Keyword-matches each `config.variations` entry's `appName` against a corpus of repo text (top-level names, HTML `<title>`s, `package.json` name/description, README excerpts) to detect which lab variation a student implemented.

### Config files

Two layouts are supported — flat (single submission set) and multi-step (multiple submission sets, e.g., Proposal + DevEnv + ApiDoc + Beta + Production).

**Flat lab** — one config at the assignment level:
```
configs/{AssignmentName}/
  {assignmentname}_config.json          # e.g. lab06_config.json
  CS233JS_{AssignmentName}_Rubric.xlsm  # rubric template lives alongside config
```
- `rubricName` in the config is the filename only (e.g. `"CS233JS_Lab06_Rubric.xlsm"`), resolved relative to the config's directory.
- Run: `node bin/grade.js Lab06`

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
- Run: `node bin/grade.js TermProject DevEnvAndStaticSite` (or just `node bin/grade.js TermProject` for an interactive step picker).
- If the labRoot has a matching step subdirectory (e.g. `<labRoot>/TermProject/DevEnvAndStaticSite/`), submissions are read from there. If not, submissions are read from `<labRoot>/TermProject/` directly — the labRoot step layout is optional.
- `configure-lab.js` asks "Will there be multiple sets of submissions for this lab?" when creating a brand-new lab; run it once per step to set up each step's config.

**Converting a flat lab to multi-step:**
1. `mkdir configs/{Lab}/{StepName}`
2. `mv configs/{Lab}/{lab}_config.json configs/{Lab}/{StepName}/{stepname_lower}_config.json`
3. `mv configs/{Lab}/*.xlsm configs/{Lab}/{StepName}/` (move rubric into step subdir)
4. Update `rubricName` in the moved config to remove any path prefix — just the filename.
5. Organize the Moodle labRoot downloads into `<labRoot>/{Lab}/{StepName}/` subdirectories.

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
  │   │   ├── runtime_check.js     # check-strategy registry (browser/build/both/run_check)
  │   │   ├── read_code_review.js
  │   │   ├── analyze_code.js
  │   │   ├── lint_code.js
  │   │   ├── validate_html.js
  │   │   ├── validate_css.js
  │   │   ├── check_names.js
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
  │   │   ├── sandbox.js           # runStudentArtifact() — native-code execution isolation chokepoint
  │   │   ├── rubric_writer.js
  │   │   ├── ollama_comments.js
  │   │   ├── lab_config.js        # pure config helpers (spreadsheet parsing, mapping schemas)
  │   │   ├── llm_client.js        # unified LLM client (Ollama / OpenRouter / Anthropic)
  │   │   ├── tui.js               # neo-blessed TUI for the configure-lab wizard
  │   │   ├── config_prompts.js    # driver-based rubric prompt logic (TUI + test shared)
  │   │   ├── variation_detect.js  # checkVersionVariation() + helpers, extracted out of analyze_code.js
  │   │   └── xlsx.js              # ESM wrapper around the xlsx package
  │   └── analyzers/               # (deprecated; now empty) former per-lab custom analyzers
  ├── configs/
  │   ├── local-config.json        # labRoot + codeRoot + optional toolchains (machine-specific, gitignored, auto-created)
  │   └── {AssignmentName}/
  │       ├── {assignmentname}_config.json    # flat-lab: rubric config, feature/match rules, cell mappings
  │       ├── CS233JS_{AssignmentName}_Rubric.xlsm  # rubric template (tracked in git)
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


- ESLint ruleset: shipped at `eslint/student.eslint.config.mjs`, overridable per-lab via `configs/{Lab}/eslint.config.mjs` (or per-step); `lint_code.js` copies the resolved config into the lab folder for VS Code consistency. The grader's *own* source is linted via the repo's root ESLint config (`npm run lint`, the CI gate).
- `--reclone` implies `--regrade`.
- In **normal mode** (no flags), students whose grade spreadsheet already exists are skipped entirely — no runtime check, analysis, linting, or spreadsheet rewrite. Use `--regrade` to re-process them.
- **`--regrade` without `--reclone`** automatically runs `git pull` on each student's cloned repo before re-grading, so updated submissions are picked up without a full re-clone.
- When `labDir` contains no direct Moodle submissions but has subdirectories that do (e.g., Moodle exported Beta/Production as separate groups), `bin/grade.js` prompts you to pick which group to grade.
- `configs/local-config.json` is tried first; `default-config.json` (shipped with the repo) is the fallback for new machines.
- Each pipeline phase attaches data to the shared `students` array; `generate_grades` consumes the combined output.

### Config schema (configs/{AssignmentName}/{assignmentname}_config.json)

  - extractOnly: boolean (optional) — when `true`, only the extraction phase runs; no runtime check, analysis, lint, or grade generation. Useful for previewing what was submitted before configuring the full rubric.

  - language: string (optional, default `"javascript"`) — selects the language adapter (`src/adapters/`) used by analysis/lint/runtime-check: `javascript` | `typescript` | `python` | `cpp` | `csharp`. Existing labs need no change — the default preserves current behavior exactly.

  - rubricName: string — rubric filename in the lab directory

  - runtimeCheck: "browser" | "build" | "both" | "run_check" | (any name registered via `registerCheckStrategy`)
    - `"browser"` serves the submission's source `index.html` directly. This only works for plain static sites; a Vite/bundled project has bare module imports (`import x from 'pkg'`) that the browser can't resolve unbuilt, so `"browser"` reports false load failures for them. For anything that needs a build step, use `"build"` (or `"both"` to also browser-check the built `dist/`).
    - `"both"` runs build first, then Puppeteer browser check against the built output. Use `build_check` / `browser_check` / `build_and_browser_check` mapping types to score them separately or together.
    - `"run_check"` builds (if the adapter has a build step) then executes the produced artifact directly — see `config.runCheck` below and the `run_check` mapping type. Intended for non-web languages (Python/C++/C#) whose runtime signal is "did the program run and produce the right output," not a browser check.

  - runCheck: { stdin, expectPatterns[], timeoutMs } (optional) — used only when `runtimeCheck: "run_check"`. `stdin` is fed to the program; `expectPatterns` are regex strings matched against combined stdout (all must match for success); `timeoutMs` (default 10000) is the kill-tree timeout.

  - execution: { mode, timeoutMs } (optional) — isolation tier for `run_check`'s artifact execution (see `src/lib/sandbox.js`). `mode`: `"direct"` (default; implemented — spawn + timeout + kill-tree + fresh throwaway cwd, NOT a security sandbox, trusted-classroom use only) | `"restricted-user"` | `"container"` (both documented, loud-failing stubs — never silently fall back to `"direct"`).

  - urlPatterns: { [label]: hostnameSubstring } (optional) — overrides/extends the URL categories `extract_code.js` looks for in `onlinetext.html`. Default: `{ github: "github.com", citstudent: "citstudent.lanecc.edu" }`. `github` is structurally special (decides clone-vs-zip); other keys are just labels read by `url_check`/`deploy_check` mappings' `urlType` field.

  - handlerModules: string[] (optional) — paths (relative to the lab's config dir) to JS modules that call `registerHandler()` as a side effect on import, so a lab can add mapping types without editing `generate_grades.js`. Loaded by `bin/grade.js` immediately after the config is parsed and **before** `validateConfig()` runs — a mapping type registered by one of these modules must already be recognized as valid when validation checks every mapping's `type`.

  - toolchains: { python, cpp: { compiler }, csharp: { dotnet } } (optional, machine-specific — normally set in `configs/local-config.json`, not a per-lab config) — compiler/interpreter commands or full paths, for when they're not on the default PATH (e.g. a WinGet-installed MinGW g++ under `%LOCALAPPDATA%\Microsoft\WinGet\Packages\...`, not PATH by default). `bin/grade.js` merges `local-config.json`'s `toolchains` into the lab config (lab config can override individual entries) before grading starts.

  - summaryCell: string (optional) — cell for AI/manual summary comment
  - graderCell: string (optional) — cell written with "Computer" on every new spreadsheet. On `--regrade`, if the cell still contains "Computer" the file is overwritten; if it has been changed (e.g. to "Brian Bird" after manual review) a new versioned copy is written (`StudentName_Grade-V2.xlsm`, `-V3`, …) instead.
  - titleCell, titleText: (optional) — cell and text for lab title

  - codeReview: { studentNameCell, groupCell, manualFallback } (optional) — `studentNameCell`/`groupCell` name the cells where the student name and lab group letter are written. There is **no default**: if a cell is not specified, that value is not written (generic code makes no assumption about rubric layout). All current lab rubrics use `B1`/`C1`.

  - variations: { "A": { appName }, "B": { appName }, "C": { appName } } (optional) — maps group letters to expected app names for labs where each group builds a different version of the project (e.g., group A builds "Double Trouble Domino"). When present, `analyze_code.js` scans the extracted directory for a folder whose name best matches the group's `appName` and records the detected variation in `analysis.versionVariation`.

  - analysis.features[] — features detected per file. Each entry has `{ id, fileRegex }` plus **either**:
    - **counted:** `{ regex }` — counts regex matches; the `feature` mapping passes when count ≥ `minCount` (default 1).
    - **boolean (match):** `{ match }` where `match` is a nested tree of `{ regex, flags? }` leaves combined with `allOf` / `anyOf`. The feature is `1` if the tree is satisfied across the searched files, else `0`. Each leaf's presence is computed **codebase-wide**, so an `allOf` matches even when its patterns appear in different files. Use it for checks needing AND/OR of patterns — e.g. `modules` = import AND export, or a group-variation row = any-of several implementations. Comments are stripped from `.js` before matching. (See `evalMatchNode` in analyze_code.js.) `validateConfig` accepts `regex` or `match`.
  - analysis.customAnalyzer: string (optional) — **⚠️ DEPRECATED — do not write new custom analyzers.** The grading system runs on flexible, reusable, config-driven modules. Express every check with a generic mapping type / feature check; if the logic exceeds a single regex, use a nested `match` (allOf/anyOf) feature (above) rather than a per-lab analyzer. A custom analyzer is a documented last resort, allowed only when a check genuinely cannot be expressed generically.
    - **Status: no analyzers currently exist.** All former analyzers were removed — Lab02 (`modules`) and Lab05 (`c12`/`c13`) migrated to nested `match` features; Lab06's was text-report-only and deleted. The `src/analyzers/` directory was removed entirely; if a custom analyzer is ever re-added as a documented last resort, recreate the directory and place the module there.
    - Mechanics (if one is ever re-added as a last resort): filename of a JS module in `src/analyzers/` that receives (jsFiles, analysis, config, student) and merges its return into `analysis`. May set `analysis.features[id]` and/or `analysis.reportSections: [{ title, lines[] }]` (text-report output only — not used for spreadsheets).

  - parts[]: { id, gameNames[], folderPattern, featureCounts[] } — multi-part lab config (optional). gameNames is the list of expected game/project names for that part; folderPattern is a regex fallback for "Part1/Pt2"-style folder naming.

  - validate: (optional) — config for HTML and CSS validation phases
    - exclude[]: path substrings to skip (shared by both validators and name check)
    - htmlExtends[]: override the html-validate preset list (default: `['html-validate:recommended']`)
    - htmlRules: object — per-rule overrides (e.g. `{ "no-inline-style": "error" }`)

  - nameCheck: (optional)
    - extraAllowed: string — additional characters to allow in file/folder names beyond `[A-Za-z0-9._-]`

  - mappings[] — rubric cell assignments (types listed below)
    - types: feature | part1_completed | part_completed | apps_in_repo | developer_comments | code_review | url_check | deploy_check | lint | build_check | browser_check | build_and_browser_check | run_check | test_check | html_validate | css_validate | name_check | manual | part_feature | repo_hygiene | github_repo | collaborator_check | gitignore_check | scripts_check | npm_package | package_usage | package_check | manifest_check | env_file_check | path_exists
    - `package_usage`/`manifest_check` are language-neutral aliases of `npm_package`/`package_check` (same handler functions) — the underlying logic reads adapter-populated `analysis.npmPackages`/`analysis.packageCheck` and isn't actually npm-specific; use whichever name reads better for the lab's language.
    - `run_check` mappings score the `"run_check"` runtime strategy's result (`student.runtimeCheck`): full credit if the program ran and matched `config.runCheck.expectPatterns`, else 0 with the failure detail (exit code, timeout, or which pattern was missing) preserved via `keepComment: true`.
    - `test_check` mappings score proportionally against `student.testCheck` (`{ total, passed, failures[] }`, from the adapter's `runTests` — pytest/dotnet test/CTest): `score = maxScore × passed/total`, full credit if all pass, comment lists up to 5 failing test names.
    - any mapping may include `stockComments: { full, partial, zero }` — short strings written into the comment cell instead of the verbose auto-generated comment. `keepComment: true` handlers (e.g. `deploy_check` manual-review flags, `lint`) are **not** overridden by `stockComments.zero`.
    - lint mappings accept an optional `severity: "errors" | "warnings"` to report only errors (syntax) or only warnings (style) into separate cells. The comment cell is written with the actual linter findings (top issues by frequency), not a stock comment — lint sets `keepComment: true` so `stockComments` is ignored for this type.
    - `html_validate` / `css_validate` mappings accept `tolerance` (default 3) — errors ≤ tolerance score half points; more score zero
    - `name_check` mappings accept `tolerance` (default 2) — same half/zero tier logic
    - `scripts_check` mappings accept `scripts` (comma-separated string or array, default `"dev,build,test"`) — list of npm script names to verify. Score is proportional to how many pass.
    - `code_review` mappings: comment reports both review presence and production column completion as "yes and yes" / "yes and no" / "no and no". Full points when both are true; half points (maxScore/2) when review submitted but production column incomplete; 0 when no review.
    - `manual` mappings: assigned `_reviewIndex` sequentially (order in config). Uses production score from code review form; falls back to beta score when production cell is empty. Comment indicates which column was used.
    - `deploy_check` mappings: async — fetches the citstudent URL with up to 3 attempts (10s timeout each, 2s delay between retries), then inspects `<script>` tags for bundling indicators (hashed filenames, assets/dist/static paths, bundle/min/chunk). Full points for reachable + bundled; half points for reachable but unbundled. When the URL cannot be verified — a thrown fetch (DNS/connection/TLS/timeout) or an HTTP error response — the handler scores 0 **but flags the row for manual review** with a `NEEDS MANUAL CHECK: … — verify deployment manually` comment that carries the real failure reason (e.g. `ECONNRESET`, `HTTP 503`). It sets `keepComment: true` so this diagnostic is **not** overwritten by `stockComments.zero`; this prevents a transient grader-side network failure from silently zeroing a student whose app is actually live. A genuinely missing URL still scores 0 with the plain stock "zero" comment. Any handler may return `keepComment: true` to protect its comment from the stock-tier override.
    - `env_file_check` mappings: full points if a `.env` file containing at least one `KEY=VALUE` pair is present in the submission. When not found, scores 0 but flags for manual review (normal if the file is gitignored and the student submitted via GitHub).
    - `path_exists` mappings: full points if any file whose path contains `pathPattern` (substring or regex) exists in the submission. Use for "required file created" checks (e.g., verify a specific config or output file is present). Requires `pathPattern` field.

  - lint.exclude[]: path substrings to skip during linting
  - repoHygiene.excludedFromRepo[]: folder names that should not be committed (checked via `git ls-files`; only applies to git-cloned repos)
  - packageCheck: { dependencies[], devDependencies[], allowedExtras[] } — expected npm package sections; `allowedExtras` whitelists packages the student may add beyond the required ones
