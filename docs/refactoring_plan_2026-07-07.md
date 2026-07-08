<!-- markdownlint-disable MD022 MD024 MD032 -->
# Refactoring Plan — Architecture & Code Improvements

This document records the recommended improvements identified during the 2026-07-07 code
review, revised after a second-model verification pass that checked every claim against the
code (all confirmed; Priority 2's diagnosis was corrected — see that item). It is **a plan,
not a mandate** — each item is independently shippable and ordered by impact-to-effort
ratio. Items already fixed (doc/comment drift) are not listed here; see the review summary
in the chat transcript for those.

Each item has: **Why** (the problem), **What** (the change), **Steps** (ordered, concrete),
and **Risk** (what could break + how to verify).

**Suggested execution order:** P1 → P4 → P3 → P2 → P7 (config_prompts + multi-step tests
first) → P5/P6 whenever convenient. P1, P3, and P4 alone capture most of the value; total
effort for everything is roughly a day.

---

## Priority 1 — Extract config validation out of `bin/grade.js`

### Why
`bin/grade.js` is a ~700-line module mixing CLI parsing, interactive prompts, path
resolution, rubric fallback, and `validateConfig()` (~90 lines of pure logic).
`validateConfig()` and `loadHandlerModules()` are pure/testable functions trapped inside
the CLI entry point, so they are only exercised end-to-end via `run_pipeline.spec.mjs`
rather than unit-tested directly. This is the single largest cohesion risk in the codebase.

### What
Move `validateConfig()` and `loadHandlerModules()` into a new `src/lib/config_validation.js`.
Both already depend only on `VALID_MAPPING_TYPES` (from `handler_registry.js`),
`VALID_RUNTIME_MODES` (from `runtime_check.js`), and `fs`/`path`/`url` — all importable
without pulling in the CLI's `readline`/interactive machinery.

### Steps
1. Create `src/lib/config_validation.js` exporting `validateConfig(config, labName)` and
   `loadHandlerModules(config, labConfigDir)`. Copy the bodies verbatim from `bin/grade.js`
   (no behavior change).
2. In `bin/grade.js`, replace the inline definitions with imports:
   `import { validateConfig, loadHandlerModules } from '../src/lib/config_validation.js';`
3. Add `test/config_validation.spec.mjs` covering:
   - Missing `rubricName` / `runtimeCheck` / `mappings` each error and exit.
   - Unknown mapping `type` errors (proves the `VALID_MAPPING_TYPES` wiring).
   - Invalid `runtimeCheck` value errors against `VALID_RUNTIME_MODES`.
   - `extractOnly: true` short-circuits (returns without checking).
   - Invalid cell refs (`cell: "A1A"`, `commentCell: "1A"`) error.
   - `packageCheck` unknown section errors.
   - `codeReview.manualFallback` invalid value errors.
   - A fully-valid config passes silently (process does not exit).
4. Run `npm test` and `npm run lint`; both must stay green.

### Risk
Low. Pure move + new tests; no logic change. `validateConfig` calls `process.exit(1)` on
failure — tests should either stub `process.exit` or refactor to throw and have `bin/grade.js`
catch+exit (preferred — makes it unit-testable without process stubs). Pick the throw approach
in step 1.

---

## Priority 2 — No non-numeric score may reach `results[]` (fix the `''` fallback)

### Why
The `manual` and `url_check` handlers return `score: map.maxScore ?? ''`. Note what this
actually does: in the normal case (mapping has a `maxScore`, which validated configs do)
these handlers award **full `maxScore` as a placeholder pending manual review** — the `''`
is only the fallback when `maxScore` is missing from the mapping. The original review
mischaracterized `''` as the routine "blank cell" sentinel; it is a rare edge path.

But that edge path hides a **real latent bug**: `num(v) => (v != null ? v : 0)` passes
`''` through unchanged (`'' != null` is `true`), so an `''` score lands in `results[]`
verbatim. `formatTextReport()` then computes `totalScore += r.score` — and `12 + '' + 5`
in JavaScript is the string `"125"`. A single `maxScore`-less manual/url_check mapping
would silently corrupt the text-report total via string concatenation.

### What
Reframe from "swap sentinels" to an invariant: **every `score` in `results[]` is a
number.** Make the two handlers fall back to a number, and make `computeResults()` /
`num()` enforce the invariant defensively.

### Steps
1. In `src/pipeline/generate_grades.js`:
   - `manual` handler: `return { score: map.maxScore ?? 0, comment: ... }`
   - `url_check` handler: `return { score: map.maxScore ?? 0, comment: ... }`
   (Both keep their "NEEDS … CHECK" comments, so a `0` placeholder is still flagged for
   human attention; the score was a placeholder either way.)
2. Harden `num()` to coerce any non-finite/non-number value to `0` (e.g.
   `v => (Number.isFinite(v) ? v : 0)`), so no future handler can reintroduce the bug.
3. Add tests in `test/generate_grades.spec.mjs`:
   - A `manual`/`url_check` mapping **without** `maxScore` yields a numeric score and
     keeps its manual-review comment.
   - A text report whose mappings include that case produces a numeric total (guards
     the string-concatenation bug directly).
4. Run `npm test`.

### Risk
Low–medium. The only behavior change is on the `maxScore`-missing edge path (blank-ish
cell → `0`), and that path currently corrupts text-report totals anyway. If a visually
blank cell is ever wanted for "needs manual review," that's a deliberate feature for
later — it would need `setCellValue`/`num()` to treat `null` as skip-the-write, which is
out of scope here. Inspect one real graded `.xlsm` after the change to confirm the cells
look right.

---

## Priority 3 — Pass `labName`/`stepName` into `lint_code.js` instead of path-climbing

### Why
`lint_code.js` derives `labName` and `parentName` by climbing `path.dirname(labDir)`
from `artifactsDir` (`labRoot = path.dirname(labDir)`). This encodes the
`codeRoot/Lab/Artifacts` (flat) and `codeRoot/Lab/Step/Artifacts` (multi-step) layout
assumptions directly into the linter. If the layout ever changes, the linter silently
resolves the wrong config directory. `run_pipeline.js` already has `dirs.labConfigDir`
and knows the lab/step names — passing them in is more robust.

### What
Extend the `dirs` object (or add explicit params) so `lintCode()` receives `labName`
and `parentName` (or just `labConfigDir`) directly, removing the `path.dirname` climb.

### Steps
1. In `run_pipeline.js`, the `lintCode` phase currently calls
   `lintCode(students, config, dirs.artifactsDir)`. Change to pass `dirs` (or add
   `dirs.labName`, `dirs.parentName`).
2. In `lint_code.js`, replace the `path.dirname` derivation with the passed-in values.
   Keep `labConfigDir`/`repoRoot` resolution (those still need `import.meta.dirname`
   climbing to find the repo root — that's correct and unavoidable).
3. Update `test/lint_code.spec.mjs` to pass the new signature.
4. Run `npm test`.

### Risk
Low. Mechanical signature change; the logic is unchanged. The existing test will catch
any caller mismatch.

---

## Priority 4 — Surface silent failures in `analyze_code.js`

### Why
`readGameNamesFromRubric()` catches all errors with `catch (e) { /* skip */ }`. A
misconfigured `rubricTitleRow` produces empty game names with no diagnostic, causing
`findPartDir()` to silently fail and score every part as "not found." Several other
`catch (e) { /* skip */ }` blocks in the file have the same issue.

### What
Replace bare `/* skip */` catches with `console.warn` diagnostics that include the
context (function name, what failed, the path involved). Reserve silent skipping for
truly expected cases (e.g., a file that's legitimately absent).

### Steps
1. In `analyze_code.js`, audit every `catch` block. For each, decide:
   - **Expected absence** (e.g., a student with no `.docx`) → keep silent or log at
     debug level.
   - **Config/IO error** (e.g., rubric unreadable, JSON parse fail) → `console.warn`
     with the function name and path.
2. Specifically fix `readGameNamesFromRubric` to warn on non-ENOENT errors and on an
   empty result when a `rubricTitleRow` was configured.
3. Add/extend tests in `test/analyze.spec.mjs` asserting a warn is emitted for a
   corrupt rubric.
4. Run `npm test`.

### Risk
Low. Warnings are non-fatal; behavior unchanged except for added log lines.

---

## Priority 5 — Split `generate_grades.js` handler-push duplication

### Why
`computeResults()` has two near-duplicate `results.push({...})` loops: one iterating
`config.mappings`, one iterating `config.parts[].featureCounts` (via `partFeatureMaps`).
Both build the same result object shape. Minor duplication, but it's a maintenance
hazard as the result shape evolves.

### What
Extract a `pushResult(results, { desc, score, maxScore, comment, cell, commentCell, ... })`
helper and use it from both loops.

### Steps
1. Add a local `pushResult(results, r)` helper in `generate_grades.js`.
2. Replace both `results.push({ ... })` blocks (and the error-state push at the top of
   `computeResults`) with calls to it.
3. Run `npm test` (the `generate_grades.spec.mjs` suite covers `computeResults`
   thoroughly).

### Risk
Very low. Pure refactor; existing tests are comprehensive.

---

## Priority 6 — Extract version-variation detection from `analyze_code.js`

### Why
`analyze_code.js` is ~700 lines mixing feature counting, part detection, manifest
checks, developer-comment detection, report writing, and the self-contained
version-variation sub-system (`buildVariationCorpus`, `variationKeywords`,
`checkVersionVariation`, `VARIATION_KEYWORD_STOPWORDS`). The variation code is
logically independent and could be its own module.

### What
Move the variation-detection functions into `src/lib/variation_detect.js`, exporting
`checkVersionVariation(extractedDir, variations)` and its helpers.

### Steps
1. Create `src/lib/variation_detect.js` with the four functions/constants.
2. In `analyze_code.js`, `import { checkVersionVariation } from '../lib/variation_detect.js'`
   and remove the inline definitions.
3. Add `test/variation_detect.spec.mjs` with focused tests (currently only exercised
   indirectly via `analyze.spec.mjs`).
4. Run `npm test`.

### Risk
Low. The functions are already self-contained (no closure over `analyze_code.js` state).
Nothing is broken here — this is a navigability win for a ~700-line file. Cheapest done
opportunistically while already editing `analyze_code.js` for Priority 4.

---

## Priority 7 — Add tests for currently-untested modules

### Why
Review identified test gaps: `lib/tui.js`, `lib/config_prompts.js`, `lib/ollama_comments.js`
(beyond availability), and multi-step lab integration. `config_prompts.js` is specifically
designed to be testable via a `driver` abstraction but has no direct tests.

### What
Add spec files, in value order: `config_prompts.js` first (pure, driver-based — it was
*designed* around a driver seam for exactly this and has zero direct tests), then a
multi-step integration test (guards the most config-sensitive real workflow, TermProject).
The `ollama_comments.js` test is lower value — that code changes rarely — do it last or
skip it if time is short.

### Steps
1. `test/config_prompts.spec.mjs` — use a `mockDriver` (pattern already in
   `configure_lab.spec.mjs`) to test `promptRubricRows`, `promptRubricCriteria`,
   `buildMappingEntry`, `promptFields`.
2. `test/multi_step_integration.spec.mjs` — a fixture with `configs/TermProject/`-style
   step subdirs; assert `getExistingSteps` + `runPipeline` pick the right step and write
   to the right `Artifacts/` subdir.
3. `test/ollama_comments.spec.mjs` — mock `fetch` to test retry/backoff and the
   cold-start path; assert `null` return on total failure. (Lowest value of the three —
   skippable.)
4. `tui.js` is harder (neo-blessed, terminal-bound); defer unless a testable seam is added.
5. Run `npm test`.

### Risk
None (additive). These tests document expected behavior and guard against regressions.

---

## Deferred / Not recommended now

- **Splitting `generate_grades.js` beyond Priority 5.** The 35+ inline handlers are
  individually small and consistent; the file is a natural aggregation point. Splitting
  into per-handler files would add import overhead without meaningful cohesion gain
  unless a second consumer appears. Revisit if handler count grows past ~50.
- **Async git cloning in `extract_code.js`.** `execFileSync` blocks the event loop, but
  students are processed sequentially anyway, so there's no concurrency benefit. The
  60s timeout is the real safety net. Low ROI.
- **`restricted-user`/`container` sandbox tiers.** Documented loud-failing stubs; only
  implement if a course involves less-trusted submissions. Not a refactor, a feature.

---

## Verification checklist (after any item is applied)

```bash
npm test            # all specs green
npm run lint        # CI gate clean
node bin/grade.js Lab03 --text-report   # smoke test (if sample data available)
```
