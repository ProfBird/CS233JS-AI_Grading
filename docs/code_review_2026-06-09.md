# Code Review — Modularity, Separation of Concerns, Extensibility

**Reviewed:** 2026-06-09
**Reviewer:** Claude (Opus 4.8), at Brian's request
**Lens:** "I want a codebase I can build on for a variety of grading tasks not yet implemented."

This review is scoped to that goal. For each finding the discriminating question is: *to add a new kind of grading task, what must I touch, and in how many places?* Correctness bugs are covered in the prior review (`archive/code_review.md`, 2026-04-26) and not re-litigated here. Security gets a short status check below, because the stated goal — a platform that runs **more** untrusted student code — directly amplifies it.

## Security status (because the goal amplifies it)

The 2026-04-26 review flagged four 🚨 **critical RCE vectors**. I spot-checked all four against current code — **all four are fixed**, plus the lint argument-injection finding:

| Prior critical | Status | Evidence |
|---|---|---|
| git-clone command injection | ✅ Fixed | `execFileSync('git', ['clone', …, normalizedUrl, codeDir])` — separate argv (extract_code.js:177) |
| `npm install` runs arbitrary scripts | ✅ Fixed | `--ignore-scripts` at both call sites (runtime_check.js:197, 307) |
| `serveDir` path traversal | ✅ Fixed | resolve + `startsWith(root + sep)` guard (runtime_check.js:33–37) |
| Puppeteer `--no-sandbox` | ✅ Fixed | now `launch({ headless: 'shell' })`, renderer sandbox on (runtime_check.js:338) |
| Lint shell argument injection (#16) | ✅ Fixed | ESLint Node API, no shell (lint_code.js:32–36) |

**But point-fixes are not isolation, and that gap grows with your goal.** The prior review's *foundational* finding — "No isolation architecture" — still stands: student code runs with full grader OS privileges. `npm run build` still executes arbitrary student build config (a malicious `vite.config.js` runs as you); the browser still executes student JS (sandboxed at the renderer, but in your user session). The four fixes closed the *known specific* vectors; they did not change the trust model. **Every new phase that executes student code (a test-runner phase, a dev-server phase, anything that runs their scripts) reopens this surface.** Before this becomes a multi-purpose platform, the highest-value security investment is a container/VM boundary (run the whole pipeline in a throwaway Docker container with no host mounts and a network policy), after which individual phases stop being individually dangerous. That's an architecture decision worth making *before* you add code-executing phases, not after.

The structural review below assumes that boundary is a known, accepted gap — the architecture is **structurally** in good shape; the security posture is "specific holes patched, trust model unchanged."

---

## What has improved since the 2026-04-26 review

Worth stating up front — several of the earlier review's structural findings are **resolved**:

- **Handler registry replaced the `switch`** (old finding #12/#42). `generate_grades.js` now dispatches via a `Map` keyed by type (`registerHandler`/`getHandler`), and `VALID_MAPPING_TYPES` is derived from the registry — so config validation and dispatch share one source of truth. An unknown type now produces an explicit `ERROR: Unknown mapping type` comment instead of a silent 0.
- **Config validation on startup** (`validateConfig`, run_all.js:107) — catches bad cell refs, unknown mapping types, missing feature ids, etc.
- **Shared file walker** (`lib/file_walker.js`) consolidated the five hand-rolled traversals (old S3).
- **Four phases added cleanly** (code review, HTML, CSS, name check) — evidence the phase pattern *does* scale, even if manually.
- **`student.filesDir`/`gradeDir` now threaded** rather than re-derived by name prefix (old #5/#9).

The architecture is structurally in good shape (security posture per the table above). The findings below are about the *next* level: turning a well-factored single-purpose pipeline into a platform.

---

## The core finding: two extension axes, two very different experiences

A "new kind of grading task" lands on one of two axes. The codebase treats them asymmetrically.

### Axis 1 — New **mapping type** (a new per-rubric-row check): GOOD mechanism, SCATTERED metadata

The registry is the right pattern, but the knowledge about one mapping type is spread across **6 sites in 2 files + docs**. To add one type you touch:

1. `registerHandler('x', fn)` — the actual scoring logic (`generate_grades.js:65+`)
2. `mappingDescription()` switch case — the text-report label (`generate_grades.js:651`). Has a `default`, so this degrades gracefully, but the friendly label lives *200 lines away* from the handler.
3. `MAPPING_TYPES[]` — wizard checklist entry (`lib/lab_config.js:294`)
4. `MAPPING_TYPE_SCHEMA{}` — wizard field prompts (`lib/lab_config.js:322`; falls back to `GENERIC_MAPPING_SCHEMA`, so technically optional)
5. `guessMappingType()` — rubric-label auto-detection regex (`lib/lab_config.js:410`)
6. Docs — CLAUDE.md type list + DEVELOPER_GUIDE table

**To be precise about what's mandatory vs. nice-to-have:** only site #1 is *required* for a working type — `VALID_MAPPING_TYPES` derives from the registry, so a hand-written config with the new type validates and grades correctly with just `registerHandler`. Sites #2–#6 are for *first-class integration*: the wizard can't offer the type (#3/#4), the auto-detector can't guess it from a rubric label (#5), and text reports show the raw type name instead of a friendly label (#2). So the dispatch is genuinely open-for-extension — it's the *surrounding metadata* that's scattered. That's the real critique: a type is easy to make *work* and tedious to make *first-class*, and nothing keeps the six sites in sync (add a handler, forget the schema, and the wizard silently can't configure it).

**The registry's headline promise is unproven.** The file comment says *"external modules can add new types without editing this file"* — but all **28** `registerHandler` calls are in-file, and nothing in `pipeline/`, `lib/`, `bin/`, or `configs/` registers a handler externally. The seam exists but isn't load-bearing. The *only* load-bearing plugin seam in the whole system is `customAnalyzer` (analyze_code.js:506–548), which `require`s a config-specified module and merges its return into `analysis`.

**Recommendation — make a mapping type one cohesive object, and make the registry actually external:**

```js
// e.g. lib/mapping_types/deploy_check.js
module.exports = {
  type: 'deploy_check',
  label: 'Deployed and running on citstudent',   // replaces the switch case
  wizard: { fields: [{ key: 'maxScore', type: 'int', default: 0 }], fixed: { urlType: 'citstudent' } },
  guess: /deploy|live\s*site|citstudent/,          // replaces guessMappingType branch
  handle: async (map, student) => ({ score, comment }),
};
```

Then `generate_grades.js` and `lab_config.js` both *iterate a directory of these* instead of hardcoding parallel lists. Adding a type becomes **one new file, zero edits to existing files** — which is the actual definition of open-for-extension, and the thing that lets you (or a future contributor) add grading tasks without spelunking. This directly fulfills the registry comment that's currently aspirational. `guessMappingType`'s ordering dependencies (lab_config.js:414–446, where comments note "must be tested first") become per-type `priority` fields instead of positional fragility.

### Axis 2 — New **pipeline phase** (a new data source / check): THIS IS THE CEILING

Adding a mapping type reuses data already gathered. Adding a genuinely *new kind* of grading — say, a plagiarism/similarity check, a git-history analysis, an accessibility audit, a test-runner that executes the student's own unit tests — usually needs a **new phase** that gathers new data. Here the architecture offers no help:

- **No phase registry.** The 9 phases are 9 hardcoded `require`s (run_all.js:20–28) and 9 hardcoded calls in a fixed sequence (run_all.js:619–694). Adding one = edit two spots in the orchestrator, in the right order.
- **The inter-phase contract is implicit and undocumented.** Every phase mutates the shared `students` array in place; downstream phases read fields by convention (`student.analysis`, `student.lint`, `student.runtimeCheck`, …). There is no typedef, no schema, no declared "this phase requires X, produces Y." Reorder phases and it breaks silently — `read_code_review` *must* run before `analyze_code` so the group letter exists, but nothing encodes that dependency except a comment.
- **Phase signatures are inconsistent.** `analyzeCode(students, config, artifactsDir, labConfigDir)` is sync; `runtimeCheck`/`lintCode`/`validateHtml` are async and take `(students, config, artifactsDir)`; `readCodeReview(students, config)` takes no artifactsDir; `generateGrades(students, config, artifactsDir, opts)` takes an options bag. There's no single "phase interface" to implement against.

**This asymmetry — extensible handlers, hardcoded phases — is the real limit on "new kinds of grading tasks,"** because new kinds usually need new inputs, and new inputs need a phase.

**Recommendation — give phases the same treatment the handlers got.** Define a uniform phase shape and an ordered registry:

```js
// each phase module exports:
module.exports = {
  name: 'analyze',
  reads: ['extractedDir', 'codeReview'],   // declared dependencies (validate the order)
  produces: 'analysis',                    // declared output field
  async run(students, ctx) { /* ctx = { config, artifactsDir, labConfigDir } */ }
};
```

`run_all.js` then builds the sequence from a registry and can (a) topologically validate `reads`/`produces`, (b) let a lab config *opt into extra phases* the way it opts into a `customAnalyzer` today. Even the minimal version — a `PHASES = [...]` array of uniform `{name, run}` objects threaded with a single `ctx` object — removes the inconsistent-signature problem and makes the sequence data, not control flow. That's the unlock for the stated goal.

### Axis 3 — New **output format**: partially factored

`generate_grades.js` already separates **computation** (`computeResults`, the single source of truth) from **rendering** (`writeResultsToSheet` vs `formatTextReport`). That's the right seam and worth preserving. But the function is still a 1,051-line module doing computation + xlsx rendering + xlsm ZIP surgery dispatch + txt rendering + AI summary + versioned-output logic. A third format (HTML report, CSV export, Moodle-import file) means another branch inside the big `module.exports` function (the `if (opts.textReport)` / spreadsheet split at :886/:923). Pulling the two renderers into `lib/renderers/{xlsx,text}.js` behind a `render(results, student, config)` interface would make output format a fourth registry rather than another `if`.

---

## Cross-cutting structural notes

**A. The implicit `student` object is the spine of the system and has no definition.** Every phase reads and writes it; `generate_grades` consumes ~10 fields off it. This was flagged as an open item before and remains the highest-leverage piece of documentation you could add — a single typedef (JSDoc `@typedef` in a `lib/types.js`, or even just a table in DEVELOPER_GUIDE) listing each field, which phase produces it, and its shape. Without it, every new phase author reverse-engineers the contract. This is cheap and pays off on *every* future task.

**B. `validateConfig` is a third parallel knowledge site.** It hand-codes awareness of every config section (run_all.js:107–202). It correctly pulls `VALID_MAPPING_TYPES` from the registry — good — but `packageCheck`, `codeReview`, `parts`, `repoHygiene` validation is all bespoke. As config grows this drifts from the wizard's schema in `lab_config.js`. Longer-term, the wizard's `MAPPING_TYPE_SCHEMA` and the validator want to be the *same* schema (one declaration, used to prompt, to validate, and ideally to document). Not urgent, but worth knowing it's a third copy of "what a valid config looks like."

**C. Dual persistence is still unexplained.** Each phase returns data *and* writes a `*_report.json`. Within a run the JSON is never re-read (the in-memory `students` array is authoritative); the files are debug artifacts. That's a legitimate choice, but it isn't stated, so a newcomer can't tell whether the JSON is a checkpoint they could resume from. If you ever want "re-run grade generation from yesterday's analysis without re-extracting," those files are *almost* a resume cache — making that explicit (load-if-present) would turn an incidental artifact into a feature.

**D. `lib/` now mixes two concerns.** It holds both pipeline runtime utilities (`file_walker`, `rubric_writer`, `ollama_comments`) and the config-wizard stack (`lab_config`, `config_prompts`, `tui`, `llm_client`). They don't share consumers — the wizard libs are only used by `bin/configure_lab.js`. As this grows, `lib/wizard/` vs `lib/` (or `lib/grading/`) would keep the two subsystems from appearing coupled when they aren't.

---

## Strengths worth preserving (don't refactor these away)

- **`computeResults` as the single source of truth** for both renderers — textbook separation of compute from presentation. Keep this seam sacred when adding formats.
- **The `customAnalyzer` hook** — the one proven extension seam, and a good model for what the handler/phase registries should become. Note it already supports `reportSections` for lab-specific report output without touching generic code (analyze_code.js) — that's exactly the right escape hatch.
- **`keepComment` / `stockComments` tiering** — a clean, composable convention for letting handlers protect diagnostics from being overwritten.
- **Per-student error isolation** — one bad submission never aborts the run; every phase try/catches per student.
- **The driver abstraction in `config_prompts.js`** — decoupling wizard logic from the TUI so it's testable is genuinely good design and the template for testing future interactive pieces.

---

## Prioritized recommendations

**If you do nothing else:**
1. **Write the `student` object typedef** (Note A). Cheapest, highest-leverage, unblocks every future phase author.
2. **Collapse mapping-type metadata into one object per type** (Axis 1). Turns a 6-site edit into a 1-file add and makes the registry's external-extension promise real.

**For the stated "many new grading tasks" goal:**
3. **Introduce a uniform phase interface + ordered registry** (Axis 2). This is the structural change that actually removes the ceiling; everything else is polish.

**When convenient:**
4. Pull renderers behind a `render()` interface (Axis 3).
5. Unify the wizard schema and `validateConfig` into one declaration (Note B).
6. Split `lib/` into grading vs wizard subdirs (Note D); document the report-JSON persistence intent (Note C).

The order matters: #1 and #3 together make adding *new kinds* of grading cheap; #2 makes adding *new checks* cheap. Those are the two things you said you want.

---
---

# Addendum — the `configure_lab` wizard (second pass, 2026-06-09)

The review above was a grader-pipeline review; it only touched the wizard at the seam. This addendum covers `bin/configure_lab.js` and its lib stack (`lab_config.js`, `config_prompts.js`, `tui.js`, `llm_client.js`) as a first-class subject, same lens. **The wizard matters to your platform goal because it's the on-ramp: a new mapping type or phase that the wizard can't configure isn't truly first-class — instructors fall back to hand-editing JSON.**

## What's well-designed (preserve)

- **The algorithmic core is cleanly extracted and unit-testable.** `heuristicDraft`, `mergeLLMResponse`, `guardFeatureType`, `findCriteria`, `buildLLMPrompt`, `extractJSON` are pure and exported (configure_lab.js:604). The TUI-coupled orchestration is separated from them.
- **The `driver` abstraction** (`config_prompts.js`) — already praised above; it's what makes the prompt logic testable against a mock instead of the real TUI.
- **Defensive LLM handling.** `mergeLLMResponse` never trusts the model: it re-validates each `type` against the known set, falls back to `guessMappingType` on garbage, clamps `maxScore`, and re-derives cells from the rubric rather than the response. `extractJSON` tolerates fenced/unfenced output. Three-tier degradation (LLM → heuristic → manual review) means the wizard works with no AI at all.
- **`buildTypeRef()` is data-driven** — it generates the LLM's type menu by iterating `MAPPING_TYPES` + `MAPPING_TYPE_SCHEMA` (configure_lab.js:38). This is the *right* pattern and the model for fixing the problems below.

## Finding W1 — 🐛 The wizard is not round-trip-safe; it silently drops config it doesn't know about

> **✅ Update (same session, 2026-06-09): FIXED.** Replaced the rebuild-from-allowlist path with `assembleConfig(existingConfig, responses)` (lib/lab_config.js) — deep-clones the existing config and overwrites only the seven wizard-owned keys, so `customAnalyzer`/`validate`/`nameCheck`/etc. survive a re-run. The now-dead `buildConfig` was removed and the extract-only path repointed to `assembleConfig`. Covered by 7 new tests and verified against the real Lab02 config. The finding below is retained as the record of the original problem.

This is the headline, and it's a live bug, not a smell. Re-running the wizard on an existing lab is an explicitly supported flow (the menu shows "has config", and `existingConfig` is loaded "for defaults … and preservation", configure_lab.js:521). But preservation is a **hand-maintained allowlist** in `buildConfig` (lab_config.js:451–490) and the `buildConfig` call site (configure_lab.js:567–585). Anything outside that allowlist is silently discarded on save.

Concretely, **re-running `configure_lab` on Lab02 or Lab05 strips `analysis.customAnalyzer`** — the wizard hardcodes `analyzerName: null` (configure_lab.js:575) and never reads `existingConfig.analysis.customAnalyzer` back. Those two labs' custom analyzers (Lab02's import+export module check, Lab05's analyzer) just vanish from the config, silently degrading grading on the next run. `validate` (HTML/CSS rule overrides) and `nameCheck.extraAllowed` are also outside the allowlist — latent today (no lab uses them yet) but the same trap for any future lab that does.

**Why it matters for the platform goal:** every new config section you add (and a platform will add many) is a new field the wizard will silently eat unless you remember to extend this allowlist. The preservation model is inverted — it's opt-in (enumerate what to keep) when it should be opt-out (keep everything, override what the wizard manages).

(`configs/` is git-tracked, so the deletion does show up in `git diff` — but that's a partial net: it relies on spotting a dropped block amid rubric-mapping churn, and it's gone for good the moment a wizard re-run is committed without line-by-line review.)

**Fix:** make `buildConfig` start from a deep clone of `existingConfig` and overwrite only the keys the wizard actually owns (mappings, rubricName, runtimeCheck, the prompted cells), rather than constructing a fresh object from an allowlist. Then unknown/future fields survive by default. At minimum, immediately: read `customAnalyzer` back and add `validate`/`nameCheck` to the passthrough — but the clone-and-overwrite restructure is the real fix and it's what keeps the wizard from becoming a liability as config grows.

## Finding W2 — the LLM prompt is a 4th (and 5th) copy of mapping-type knowledge

This *deepens Axis 1 from the main review.* I counted 6 scatter sites for a mapping type; the wizard adds more:

- **`buildLLMPrompt` "Type selection rules" (configure_lab.js:90–103)** — hand-written prose telling the LLM when to pick each type. Add a mapping type and you must hand-write its rule here or the AI will never select it.
- **"Type-specific extra fields" + the worked example (configure_lab.js:105–118)** — also hand-maintained per type.
- **`summaryNotes` (configure_lab.js:237)** — a hardcoded per-type switch deciding what to show in the review table; a new type with an important field shows nothing useful until you add a branch.

So a *fully* first-class new mapping type touches **~8–9 sites across 3 files + docs**, not 6. The good news: the fix is the same one recommended in the main review. If each mapping type becomes one cohesive object, that object can carry `llmRule`, `example`, and `summaryNote` fields, and `buildLLMPrompt`/`summaryNotes` iterate them — exactly as `buildTypeRef` already iterates the type list today. **The unified-type-object recommendation (main review #2) should explicitly absorb the wizard's per-type prose.** That turns the strongest argument for the refactor into an even stronger one.

## Finding W3 — `main()` is a 270-line god function (same shape as `run_all.js`)

`main()` (configure_lab.js:334–602) runs LLM selection, assignment-name resolution, multi-step detection, rubric discovery (including a codeRoot fallback search), existing-config loading, rubric reading, draft generation, the review loop, global-settings prompts, config assembly, and writing — inline. Two sub-procedures stand out as independently complex: multi-step resolution (385–428) and rubric discovery/copy (443–518).

The cost is **testability**: the exports (configure_lab.js:604) are only the pure helpers. None of the orchestration — assignment resolution, the rubric-discovery decision tree, settings assembly, or the round-trip preservation in W1 — is reachable by a test. That's precisely why W1 could regress unnoticed. Extracting `resolveAssignmentAndStep()`, `discoverOrCopyRubric()`, and `assembleConfig(existingConfig, responses)` as exported functions would make the wizard's decisions testable and shrink `main` to a readable sequence. (This mirrors the `run_all.js` god-function note — it's the same lesson in the second entry point.)

## Finding W4 — the wizard structurally can't configure the most lab-specific grading

`buildLLMPrompt` explicitly instructs "Do NOT use type `feature`" (configure_lab.js:88), and `guardFeatureType` downgrades any `feature` guess to `manual` unless the `featureId` already exists (configure_lab.js:128). So regex `feature` mappings and `customAnalyzer` logic — the two most lab-specific, highest-value grading mechanisms — are exactly what the wizard punts to hand-editing. That's a defensible scoping choice today (a regex can't be auto-drafted safely), but for a platform it means the wizard covers the generic checks and abandons the bespoke ones. Worth a deliberate decision: is the wizard's job "configure the boilerplate, humans handle the custom logic" (fine — document it), or should it grow a guided flow for defining a feature regex / scaffolding an analyzer? Right now it's implicit, and W1 actively *punishes* the hand-edited custom config by eating it on re-run.

## Wizard recommendations (folded into the main priority list)

- **W1 is the one to fix soon** — it's a silent data-loss bug affecting two current labs. The clone-and-overwrite restructure of `buildConfig` is the durable fix; the read-back of `customAnalyzer`/`validate`/`nameCheck` is the stopgap. This raises the priority of main-review Note B (unify wizard schema with `validateConfig`): one schema that both *validates* and *enumerates what the wizard owns* would make round-trip safety fall out for free.
- **W2 merges into main-review recommendation #2** (one object per mapping type) — just make that object carry the wizard's per-type prose too. Same edit, bigger payoff.
- **W3 mirrors the `run_all.js` god-function item** — extract testable sub-procedures; do it alongside any W1 work so the fix is covered by tests.
- **W4 is a product decision, not a bug** — decide and document the wizard's intended scope re: features/analyzers.

Net: the wizard's *foundations are good* (pure core, driver abstraction, data-driven type menu, defensive AI handling), but it has one real bug (W1) and it amplifies the same metadata-scatter and god-function patterns the grader has. Fixing the unified-type-object (main #2) and adding round-trip safety (W1) would make the wizard scale with the grader instead of lagging it.
