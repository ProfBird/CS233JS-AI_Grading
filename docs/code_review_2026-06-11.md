# Post-Restructure Code Review — 2026-06-11

**Reviewer:** Claude (Opus 4.8), at Brian's request
**Context:** Review after the `src/` ESM restructure (PRs #8/#9) and a stretch of cross-machine / cross-session work without fresh Claude sessions.
**Two lenses:**
1. Issues that "fell through the cracks" when switching computers/sessions.
2. Dependency/structural constraints on adding more check types and more lab assignments.

Builds on `docs/code_review_2026-06-09.md` (the pre-restructure extensibility review). Where a finding carries over, I reference it rather than re-deriving.

---

## Part 1 — Cross-session / cross-machine "fell through the cracks"

The signature artifact of carrying work across machines/sessions is **a reference whose target moved or never landed** — the session "believes" something is in place that the committed tree doesn't have. I swept all three reference classes systematically rather than spot-checking.

### 1.1 🐛 Lab06's custom analyzer is orphaned — MEDIUM (loss is real but scoped to `--text-report` mode)

> **✅ Resolved (2026-06-11): deleted, not re-added.** Brian confirmed Lab06 is graded for spreadsheet results only, and the analyzer produced *nothing* the spreadsheet path uses (`reportSections` is text-report-only; `apiCompleteness` is unconsumed). So `src/analyzers/lab06_analyzer.js` was removed rather than re-wired. The broader takeaway became a policy decision — custom analyzers are now deprecated (see CLAUDE.md); the original finding is retained below as the record.

`configs/Lab06/lab06_config.json` has an `analysis.features` block (lines 25–53) but **no `customAnalyzer` key** — while `src/analyzers/lab06_analyzer.js` exists and is referenced by nothing.

**Impact (bounded — and narrower than it first looks):** the analyzer is the *sole* producer of `analysis.apiCompleteness` and `analysis.reportSections` (the "API Integration Pipeline" per-step checklist, `lab06_analyzer.js:209–227`). The *only* consumer of `reportSections` is `generate_grades.js:844`, which lives inside `formatTextReport` — the `--text-report` path. The spreadsheet path (`computeResults` → `writeResultsToSheet`) writes cell values only and never touches it, and no mapping consumes `apiCompleteness`. So:
- Lab06 **scores are unaffected** in either mode — all of Lab06's mappings are generic types (`manual`, `build_and_browser_check`, `lint`, `deploy_check`, …).
- In **`--text-report` mode**, Lab06 lost the per-step `[YES]/[no]` checklist + `X/5 steps complete` summary that exists specifically to help the grader assign the four **manual** API rows (D7–D10) — a real loss of decision-support.
- In **spreadsheet mode** (which `lab06_config.json` defaults to — it carries a `rubricName`), the analyzer's output was going unrendered *regardless*, so the current practical impact there is ≈ nil.

**Discriminating question for severity:** does Brian grade Lab06 via its `.xlsm` rubric or with `--text-report`? Historically Lab06 was *the* `--text-report` lab (its analyzer exists precisely to enrich those reports), which is why this is worth fixing — but if Lab06 is now graded via spreadsheet, the live impact is nil and this drops to "dead analyzer, tidy it up." The fix is correct either way.

**Cause:** `git log -- configs/Lab06/lab06_config.json` points at `72445f2 "Finished auditing… no lab-specific code"` and/or the TUI-wizard work (`f0f8e31`) — i.e. either a well-meaning "remove lab-specific code" pass dropped the reference, or a wizard re-run hit the pre-fix W1 bug. Causation doesn't change the fix.

**Fix:** re-add `"customAnalyzer": "lab06_analyzer.js"` to Lab06's `analysis` block.

**Cross-reference both directions (the rigorous check):** Lab02 and Lab05 configs resolve correctly to their analyzers; there are **no dangling refs** (a config naming a missing analyzer). Lab06 is the *only* orphan. Net: exactly one issue in this class.

> Already fixed this session, same class: the `CONFIGS_DIR` path in `src/lib/lab_config.js` (commit `4f95abe`) — a reference left pointing at the wrong depth after the `src/` move.

### 1.2 No shared repo-root resolver → the path bug that already shipped once — MEDIUM (structural root cause)

Three modules each derive the repo-root / configs location independently, at their own depth:

| Location | Derivation | Status |
|---|---|---|
| `bin/grade.js:34` | `REPO_ROOT = join(import.meta.dirname, '..')` | ✅ correct — and the *right* pattern (a named root anchor) |
| `bin/configure-lab.js:24` | inline `join(import.meta.dirname, '..', 'configs')` | ✅ correct only because `bin/` is one level deep |
| `src/lib/lab_config.js:13` | inline `join(import.meta.dirname, '..', '..', 'configs')` | 🐛 **shipped broken** (single `..` → `src/configs`); fixed this session |

The `CONFIGS_DIR` bug wasn't a typo — it was the predictable failure of having each module recompute its depth-to-root by hand. `grade.js` got it right with a named `REPO_ROOT`; the others reinvent it; one reinvented it wrong. **The next module added at a new depth is the next instance of this bug.**

**Fix:** a single `src/lib/paths.js` exporting `REPO_ROOT`, `CONFIGS_DIR`, `ANALYZERS_DIR`, imported everywhere. Depth is computed once, in one place, and `analyze_code.js`'s `../analyzers` resolution folds in too.

### 1.3 Docs + architecture memory still describe the *pre*-restructure layout — HIGH (corrupts future sessions, not just users)

`CLAUDE.md` — which is loaded as instructions into **every** session — still describes the old tree: `run_all.js` as the entry point and `### Pipeline (run_all.js)` (it's now `bin/grade.js`, or the `cs233-grade` bin), root `pipeline/` (now `src/pipeline/`), `node run_all.js …` throughout the Commands section (~23 stale references), and per-lab `configs/{lab}_analyzer.js` (analyzers now live in `src/analyzers/`).

This isn't cosmetic: **it already misled *this* session** — I assumed `run_all.js` existed and asserted things about a file that had been renamed. `DEVELOPER_GUIDE.md` has the same drift. And the **`project_architecture` memory** is stale too (it records `pipeline/`, `lib/`, `bin/` at the root and "116 tests"; reality is the `src/` layout and 387 tests). Stale context propagating into the next session is the most on-point "cross-session" failure of all.

**Fix (don't rewrite everything — hit the load-bearing parts):** entry point (`run_all.js` → `bin/grade.js` / `cs233-grade`), the directory tree, and the analyzer location (`src/analyzers/`). Update the `project_architecture` memory in the same pass.

---

## Part 2 — Extensibility: adding more checks / more labs

### Carries over from the 2026-06-09 review (confirmed on the ESM tree)

- **Handler registry intact** — 28 `registerHandler` calls in `src/pipeline/generate_grades.js`. Adding a check still *works* via one registration, but making it *first-class* still touches ~8–9 sites (registry + `mappingDescription` + `MAPPING_TYPES` + `MAPPING_TYPE_SCHEMA` + `guessMappingType` + the wizard's `buildLLMPrompt` prose + `summaryNotes` + docs). See 2026-06-09 **Axis 1 / W2**.
- **No phase registry** — `bin/grade.js:638–708` hardcodes the 9-phase sequence with inconsistent signatures (`analyzeCode` takes `labConfigDir`; `readCodeReview` takes no `artifactsDir`; `generateGrades` takes an options bag) and an implicit `student`-object contract. Adding a new *kind* of check (a new data source / phase) still means editing the orchestrator. See 2026-06-09 **Axis 2**.

### New, restructure-specific

**2.1 The analyzer/config split raises the cost of adding a lab with custom analysis — MEDIUM.** Pre-restructure a lab was self-contained: `configs/{Lab}/` held both the config *and* its analyzer, so they moved and were reasoned about together. Now the config lives in `configs/{Lab}/` (data tree) and the analyzer in `src/analyzers/` (source tree) — two distant trees that drift independently. That split is simultaneously the **structural cause of the Lab06 orphan (1.1)** and a **per-lab cohesion cost**: adding a custom-analysis lab now means hand-writing the config, hand-creating the analyzer in a *different* tree, hand-wiring the `customAnalyzer` reference, and nothing validates the link. Combined with the wizard punting on analyzers entirely (2026-06-09 **W4**), the highest-value grading mechanism is also the least supported and the easiest to silently break.

**2.2 Nothing validates the analyzer↔config link — MEDIUM (prevents recurrence of 1.1).** `validateConfig` checks mapping types, cell refs, features, etc., but not that a referenced analyzer exists, nor that a shipped analyzer is referenced. A ~5-line guard — *config's `customAnalyzer` resolves to a real file* plus a test asserting *every `src/analyzers/*.js` is referenced by some config* — would have caught Lab06 at startup instead of silently in a text report.

---

## Strengths to preserve

- **`bin/grade.js`'s `REPO_ROOT` anchor** — the correct path pattern; make it the shared one (1.2).
- **Analyzer resolution prefers `src/analyzers/` with a `configDir` fallback** (`analyze_code.js:546`) — the *resolution* is robust; only the *reference* went missing.
- **Clean ESM move** — `type: module`, no CommonJS leftovers in `src/`/`bin/`, no stale root modules (`run_all.js`/`lib/`/`pipeline/`/`build_code.js` all gone).
- **Handler registry + the `computeResults` compute/render seam** — intact through the restructure.
- **`reportSections` escape hatch** — the right design for lab-specific report output without lab-specific code in the pipeline; Lab06 is a wiring loss, not a design flaw.

---

## Prioritized recommendations

1. **Re-add Lab06's `customAnalyzer`** (1.1) — one line; restores the API-pipeline checklist to Lab06 `--text-report` output (and removes a dead analyzer either way). *Trivial; priority depends on whether Lab06 is graded via text-report or spreadsheet.*
2. **Refresh `CLAUDE.md` / `DEVELOPER_GUIDE.md` entry-points + tree + analyzer location, and the `project_architecture` memory** (1.3) — *HIGH for session hygiene; it actively misleads.*
3. **Add the analyzer↔config validation guard** (2.2) — startup check + test; catches orphans and dangling refs. *MEDIUM, prevents recurrence of 1.1.*
4. **Introduce `src/lib/paths.js`** and route the three root derivations through it (1.2) — *MEDIUM, prevents recurrence of the `CONFIGS_DIR` class.*
5. **(Carried)** unified mapping-type object (Axis 1 / W2) and a phase registry + explicit `student` contract (Axis 2) — the structural moves that make "many new checks/labs" cheap. See `docs/code_review_2026-06-09.md`.

Items 1–4 are the cross-session cleanup; #1 and #2 are the ones I'd do today. #5 is the longer-horizon extensibility work from the prior review, unchanged by the restructure.
