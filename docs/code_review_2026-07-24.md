# Architecture / Extensibility / Maintainability Review — 2026-07-24

**Reviewer:** Kimi K3 (AI), at the maintainer's request
**Context:** Whole-tree review after the multi-course (CS233JS + CIS195), multi-term, and
multi-language-adapter work landed. Three lenses: **architecture**, **extensibility**,
**maintainability**. Builds on `docs/code_review_2026-06-11.md`; findings that were fixed
since (phase registry, config-validation extraction, analyzer deprecation) are noted as
resolved, not re-litigated.

**Method:** core files read directly (`bin/grade.js`, `run_pipeline.js`, `generate_grades.js`,
`handler_registry.js`, `runtime_check.js`, `config_validation.js`, `adapters/base.js`,
`adapters/index.js`, `sandbox.js`, `analyze_code.js`); `src/pipeline/`, `src/adapters/`,
`src/lib/`, `test/`, and `bin/configure-lab.js` + `bin/rubric-to-md.js` surveyed in full.
High-impact claims spot-verified against the tree.

---

## Overall verdict

The codebase is in genuinely good architectural health for a tool that grew from a
single-course script into a multi-course, multi-language pipeline. The layering is clean,
the extension mechanisms are real (not aspirational), and the comments consistently explain
*why* rather than *what*. The main debts are **horizontal duplication** (the same helper
re-implemented 4–6 times with divergent semantics), an **implicit `student` object contract**
that every phase reads/writes ad hoc, and a cluster of **fail-open paths that can inflate
grades when the grader's own tooling breaks**. None of these are structural crises; all are
fixable incrementally.

---

## 1. Architecture

### 1.1 What's working well

- **Clean layer separation:** `bin/` (CLI/prompts) → `src/pipeline/` (phases) →
  `src/adapters/` (language mechanics) / `src/lib/` (utilities). Exactly **one upward
  import** exists: `config_validation.js:12` pulls `VALID_RUNTIME_MODES` from
  `pipeline/runtime_check.js` — and it works by import side-effect (strategies self-register
  on module load). It functions, but it's the one place where layering depends on load order.
  The clean fix mirrors what `handler_registry.js` already did: a registry that lives in
  `lib` and the pipeline registers into.
- **Phases as data** (`run_pipeline.js:40-81`): `PHASES` is an array of `{name, run, when}` —
  adding/gating a phase doesn't touch the loop. The `checkWebContent` gate
  (`when: config => !!config.webContent`) proves the mechanism works. *(Resolves the
  2026-06-11 "no phase registry" finding.)*
- **Acquisition-source symmetry:** Moodle and Canvas produce the same `students[]` shape and
  reuse `acquireCode`/`matchUrlCategories`/`applyGithubSubdir` rather than re-implementing
  them. Downstream phases genuinely don't care which source ran.
- **Single source of truth for scoring:** `computeResults()` (`generate_grades.js:845`) feeds
  both the spreadsheet and text-report renderers, with `pushResult` coercing scores through
  `num()` at the boundary — exactly the right chokepoint.
- **Extract-for-testability trend:** `config_validation.js`, `resolve_lab_dir.js`,
  `config_prompts.js`, `variation_detect.js` were all pulled out of `bin/grade.js` precisely
  because they weren't testable inside it. The right instinct — continue it.

### 1.2 The `student` object is an implicit, untyped contract — HIGH

Ten phases attach ad-hoc fields (`analysis`, `lint`, `runtimeCheck`, `scriptsCheck`,
`testCheck`, `htmlValidation`, `cssValidation`, `nameCheck`, `webContent`, `codeReview`), and
30+ handlers in `generate_grades.js` read them back with `|| {}` fallbacks. Nothing defines
the shape:

- The two acquisition sources already drift: Canvas's error path pushes
  `{name, gradeDir: null, urls: {}, error}` **without** `extractedDir`/`filesDir` keys
  (`extract_code_canvas.js:135-139`); Moodle always sets them. Canvas `online_upload`
  students get `urls = {}` where Moodle gives key-per-pattern-with-nulls. Works today only
  by falsiness accident.
- `extract_code.js:292-294` sets `student.extractedDir` to a *hypothetical* path on
  extraction failure; downstream phases skip via `fs.existsSync` — an unstated invariant
  ("the fallback path happens not to exist") is load-bearing in ~8 places.
- Two contradictory fields coexist: `analyze_code.js:411-421` computes `hasCodeReview`
  recursively over docx/pdf/txt, while `read_code_review.js:19-31` only looks at top-level
  `.docx` — a nested PDF review yields `hasCodeReview: true` but `codeReview.found: false`
  on the same student.

**Fix:** a JSDoc `@typedef Student` (the codebase already uses JSDoc typedefs well in
`adapters/base.js`) plus a `makeStudent()` factory both acquisition sources call. Cheap, no
runtime change, turns a dozen implicit invariants into one document.

### 1.3 Per-student error isolation is inconsistent — HIGH (one bad submission can abort a phase)

Only `extract_code.js` and `read_code_review.js` wrap per-student work in try/catch.
Verified in `analyze_code.js`: the `students.forEach` loop (L377) does unguarded
`fs.readdirSync(student.filesDir)` (L418) and `fs.readFileSync(js)` (L432) — one unreadable
file kills analysis for **all remaining students**. Same hazard class in `lint_code.js:80`
and `check_web_content.js` (invalid config regexes constructed per-student at L120/195).

**Fix:** a shared `runPerStudentPhase({name, attachKey, checkStudent})` scaffold —
"banner → extraction-skip guard → try/catch → attach → write report" — would fix this by
construction and simultaneously absorb the six near-identical report-writing copies
(`read_code_review.js` currently writes no report at all).

### 1.4 `bin/grade.js` is still a god-script (~850 lines) — MEDIUM

Course/term selection, Canvas setup, labRoot/codeRoot resolution + migrations, rubric
prompts, mode selection, reclone mechanics — interactive prompts interleaved with fs
mutations and config writes, none of it unit-tested. The number-or-name select loop is
re-implemented ~6× inside the file (course/term/assignment/step/Canvas-assignment/
group-picker); `configure-lab.js` re-implements the course/step pickers again with a
different UI toolkit. A `selectFromList` helper belongs in `src/lib`, and the extraction
trend (§1.1) should continue.

---

## 2. Extensibility

### 2.1 What's genuinely good

Three registries, all self-populating so validators never need editing:

| Extension point | Mechanism | Validator sync |
|---|---|---|
| Mapping types | `registerHandler()` (`handler_registry.js`) | `VALID_MAPPING_TYPES` auto-populated; `handlerModules` config key lets a **lab** add types without touching the repo |
| Runtime strategies | `registerCheckStrategy()` (`runtime_check.js:42`) | `VALID_RUNTIME_MODES` auto-populated |
| Languages | `registerAdapter()` (`adapters/index.js`) | nullable methods = explicit capability gaps; `REQUIRED_ADAPTER_KEYS` + `isValidDiagnostics` guard drift via tests |

The nullable-method contract in `base.js` is well-designed — C++'s `checkManifest: null`
("no manifest concept") vs. an error is exactly the right semantic, and callers honor it.
The TypeScript adapter's inheritance-via-spread of the JS adapter is the *good* reuse
pattern in the codebase (the other four adapters duplicate instead — see §3.1).

### 2.2 Contract conformance drift — LOW/MEDIUM

Verified against `base.js`:

- JS/TS *omit* `runTests` instead of setting it `null` (`base.js:9-12` documents null).
- The `Manifest` typedef (`base.js:22-29`) documents a shape nothing returns — misleading
  to a future adapter author.
- csharp's `runTests` returns an undocumented `_failed` field; cpp/csharp `Project` extras
  (`sourceFiles`, `csprojPath`) aren't in the typedef.
- The typedef is the contract — it should be the strictest thing in the system.

### 2.3 Adapter capability leaks — MEDIUM

- **csharp `detectProject` treats every `.csproj` as runnable** (`csharp.js:100-107`),
  including class libraries, while `run_check` executes `projects[0]`
  (`runtime_check.js:250`). The "class library + console + tests" layout the header comment
  itself cites will spuriously fail. Needs an OutputType/Exe filter.
- **cpp cmake/makefile projects have no `artifactPath`/`runCommand`** — `run_check` can
  never execute them; `validateConfig` doesn't warn on `run_check` + cmake.
- **`handlerModules` is config-driven; strategy/adapter registration is code-only.** Fine
  for now; document that a handler module can technically register a runtime strategy via
  import side-effect — or explicitly forbid it.
- **Metadata split brain (accepted, test-guarded debt):** `handler_registry.js`'s type list
  vs. `lab_config.js`'s `MAPPING_TYPES`/`MAPPING_TYPE_SCHEMA` are two sources of truth kept
  in sync only by the drift test in `generate_grades.spec.mjs`. Every new mapping type pays
  the double-entry cost until consolidated (documented future step).
- **Deprecated `customAnalyzer` path is still wired in** (`analyze_code.js:356-375`)
  referencing the deleted `src/analyzers/`, and its `applyCustomAnalyzer` call isn't awaited
  (L321-323) — an async analyzer would merge a pending Promise. Since policy is "no
  analyzers currently exist," delete the loader outright rather than keep a broken-if-async
  dead path.

---

## 3. Maintainability

### 3.1 Horizontal duplication — the dominant structural debt

| Duplicated logic | Copies | Problem |
|---|---|---|
| `getAllFiles` (walk + exclusions) | **6** (`javascript.js:36`, `python.js:42`, `cpp.js:64`, `csharp.js:52`, `variation_detect.js:19`, `analyze_code.js:32`) | **Two divergent semantics**: substring vs path-segment matching. cpp/csharp fixed it locally — a dir named `mydist/` or `distutils/` is still falsely excluded in js/python/analyze. Belongs in `file_walker.js` beside `getAllFilesByExt`. |
| `killProcessTree` | 2, verbatim identical (`javascript.js:367`, `sandbox.js:51`) | sandbox.js's own comment acknowledges the copy |
| spawn + timeout + kill-tree + collect | 2 (`javascript.js:329`, `sandbox.js:61`) | different output caps, same machinery |
| `stripComments` placeholder engine | 4 | only literal-grammar regexes differ — a `makeCommentStripper({...})` factory serves all four |
| Diagnostics aggregation | 4 | only `friendlyName` differs |
| Ollama client | 2 (`ollama_comments.js`, `llm_client.js`) | `ollama_comments.js:53` also hardcodes "**JS** lab submission" — wrong for python/cpp/csharp labs |
| Rubric parsing | 2 (`rubric-to-md.js`, `lab_config.js`) | rubric-to-md is the weaker copy: no alt header names, no layout detection, hardcodes comment column E — and it's **untestable** (executes on import, no main-guard) |
| Menu select loop | ~6 in `grade.js` + pickers in `configure-lab.js` | two UI toolkits, one flow |
| Per-phase report writer | 6 near-identical copies | `read_code_review.js` writes none |

`file_walker.js`'s header says it was created to end hand-rolled walkers; the roll-your-own
copies continued anyway. Consolidating `getAllFiles` alone fixes a real correctness bug in
three places.

### 3.2 Fail-open grading hazards — HIGHEST PRIORITY (grades affected)

These silently produce wrong scores:

1. **js/python lint returns `errors: 0` when the grader's own tooling breaks** — ESLint
   missing/crash (`javascript.js:251,262`), ruff missing/unparseable
   (`python.js:152,158`) → lint mappings award **full credit for a broken grader**.
   cpp/csharp fail closed; js/python fail open.
2. **`checkRepoHygiene` reports *passed* when `git ls-files` fails**
   (`analyze_code.js:270-295`) — warns, but the report says passed; also no timeout on the
   git call (the clone has 60s, this has none).
3. `deploy_check`'s `keepComment` pattern (tool failure ≠ student failure) is the right
   model — apply the same thinking to the two items above.

### 3.3 Concrete bugs (verified)

- **`sandbox.js:105-106`** — `child.stdin.write/end` with no error handler: a fast-crashing
  program + nonempty `runCheck.stdin` → `EPIPE` → unhandled rejection → grader crash. Also
  **`sandbox.js:83-84`** unbounded `stdout +=` — a runaway printer exhausts memory inside
  the timeout window.
- **`check_web_content.js:196-204`** — `fileCounts` walk has no skip-dirs: descends into
  `node_modules`/`dist`/`build` left by a build → over-counting (latent today because
  webContent labs use `runtimeCheck: "none"`).
- **Windows path bugs:** `check_web_content.js:143` tests `dirPattern` against backslash
  `path.relative` output; `check_names.js:50` and `check_web_content.js:198` do exclusion
  matching without `toPosix` — config written with `/` silently doesn't match.
- **`check_web_content.js:230`** — `{...EMPTY_RESULT}` shallow-copies shared nested arrays
  to every skipped student; one downstream mutation corrupts all of them.
- **`extract_code.js:207`** — dead `e.stderr` branch: clone uses `stdio: 'ignore'`, so
  failure diagnostics the code thinks it captures are always lost.
- **`lint_code.js:57`** — the VS Code eslint-config copy is written only `if (!existsSync)`
  and never refreshed; updated rulesets never propagate. Its own comment (L28-34) disowns
  the path-climbing the next lines reintroduce.
- **`typescript.js:25`** — `execFile(TSC_BIN, …, {shell: true})`: breaks when the repo path
  contains spaces; `TSC_BIN` computed at module load so `config.toolchains` can't override
  it (inconsistent with python/cpp/csharp).
- **cpp `lint()` links a full executable into the student's cwd** (`cpp.js:233-235`) —
  link errors masquerade as lint errors; a killed grader leaves `a_out_lint.exe` in the
  submission tree.

### 3.4 Tests

The suite (~730 cases, 25 files) is a real strength: hermetic temp dirs, mocked
network/git, self-gating toolchain probes (6 cpp + 5 csharp + 4 python + 2 puppeteer skips
on a clean machine). Gaps:

- **`test/adapters/python.spec.mjs:108` fails on a Node-only CI machine** — the `build()`
  test is ungated (the ruff/pytest tests are gated; this one isn't).
- **`test/lint_code.spec.mjs` writes scratch configs into the real repo `configs/` tree** —
  a killed run leaves a `__scratch_lint_course__` that `getExistingCourses()` would
  discover as a real course.
- **Untested:** `llm_client.js`, `ollama_comments.js`, `tui.js`, `rubric_writer.js` (its
  VBA/drawing preservation is its *raison d'être* and only trivially exercised),
  `rubric-to-md.js` (untestable as written), `bin/grade.js`'s interactive flows, mammoth
  integration in `read_code_review.js`.
- Observed on this machine: `test/adapters/cpp.spec.mjs:214` fails with the compiled
  artifact exiting `0xC0000005` (STATUS_ACCESS_VIOLATION) — looks environment-specific
  (the suite correctly self-gates elsewhere), but worth noting in the test's gating logic.

### 3.5 Documentation drift

`CLAUDE.md` is unusually good, but:

- The `grade.js` help text (L45-52) and CLAUDE.md both claim the plain menu's course picker
  has an **"Add new course"** option — verified absent (`grade.js:244-265` lists courses
  only; only "Add new term" exists at L316). Course creation lives solely in
  `configure-lab.js`.
- `base.js`'s dead `Manifest` typedef, the `runtime_check.spec.mjs` header ("a single
  test" — there are two), and `ollama_comments.js`'s "JS lab" prompt are smaller drifts.
- Institutional hardcoding in generic lib conflicts with the multi-course/multi-language
  positioning: `config_prompts.js:92` ('CS233JS'), `llm_client.js:68-69` (lanecc.edu
  referer), `variation_detect.js:58` (starter/template exclusions), `lab_config.js`
  MAPPING_TYPES descriptions ("Runs ESLint on .js files").

---

## 4. Recommendations, in priority order

1. **Close the fail-open grading holes** (§3.2): lint tool-failure → a distinguishable
   error state that scores 0 with `keepComment`, not a clean pass; hygiene git-failure →
   not-passed. Small diffs, direct grading-correctness impact.
2. **Fix `sandbox.js` stdin/output bugs** (EPIPE handler, cap accumulation) — crash risk in
   the security-sensitive chokepoint.
3. **Consolidate `getAllFiles` into `file_walker.js`** with segment-based matching; delete
   the other 5 copies. Fixes the `dist`/`build` substring bug everywhere at once.
4. **Add a per-student try/catch scaffold** shared by phases (fixes analyze/lint/web-content
   abort hazards + the six report-writing copies).
5. **Define the `Student` typedef + factory**; align Canvas/Moodle shapes.
6. **Gate `python.spec.mjs:108`**; move `lint_code.spec.mjs` scratch dirs to temp.
7. Then the slower structural items: dedupe spawn/comment-stripper/diagnostics helpers
   (typescript.js's spread-inheritance is the model), `selectFromList` for the menus, merge
   `ollama_comments` into `llm_client`, delete or await the customAnalyzer loader,
   consolidate mapping metadata, and keep extracting testable units out of `bin/grade.js`.

Nothing here requires a redesign — the architecture already has the right seams; the work
is pulling duplicated logic through them and making failure modes fail *closed* where
grades are concerned.

---

## Strengths to preserve

- **The three self-populating registries** (handlers / strategies / adapters) — the reason
  adding a check type or language doesn't touch validators.
- **`computeResults()` as the single scoring chokepoint** — both renderers share it; keep
  it that way.
- **`base.js`'s typedef-documented nullable-method contract** — tighten conformance to it,
  don't relax it.
- **The honest-comment culture** (sandbox's "NOT a security sandbox", deploy_check's
  `keepComment` rationale, the documented accepted debts) — this is what makes the next
  review cheaper.
- **The test suite's self-gating toolchain probes** — the reason CI stays green on machines
  without g++/dotnet/Chrome; extend the pattern to the two suites that lack it.
