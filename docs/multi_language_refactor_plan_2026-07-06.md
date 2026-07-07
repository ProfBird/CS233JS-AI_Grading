# Refactoring Plan: Multi-Language Grading Support

**Goal:** prepare the grading pipeline to grade Python, TypeScript, C++, and C#
assignments in addition to JavaScript, without disrupting CS233JS grading.

**Guiding rule for every phase:** the JS/CS233JS path must keep passing
`npm test` and `npm run lint` after each phase. No phase before Phase 8 should
change JS grading behavior — this is extraction and generalization, not a
rewrite. New languages only get added once the abstraction exists to hold them.

---

## Phase 0 — Safety net before touching anything

The two most language-coupled files, `lint_code.js` and `runtime_check.js`,
currently have **zero test coverage**. They must not be refactored blind.

1. Write `test/lint_code.spec.mjs` characterizing current behavior of
   [lint_code.js](../src/pipeline/lint_code.js): ESLint config resolution
   priority (step override > lab override > shipped default), exclusion
   filtering, the `jsFiles`/`errors`/`warnings`/`ruleCounts` output shape, the
   "no JS files" branch, and the "ESLint not installed" branch.
2. Write `test/runtime_check.spec.mjs` characterizing
   [runtime_check.js](../src/pipeline/runtime_check.js)'s `"browser"` /
   `"build"` / `"both"` modes and the `scripts_check` sub-phase. Mock
   `child_process.exec`/`spawn` for the npm paths (follow the existing
   precedent of mocking git while using real zips in
   `test/extract_code.spec.mjs`) rather than shelling out to real `npm
   install`. Test the pure helpers directly — `findDistIndexHtmlDirs`,
   `runNpmScript`'s package.json parsing, the timeout/kill classification
   logic in `spawnScript`. Keep at most one real-Chrome integration test,
   and mark it skippable in CI if Puppeteer/Chrome isn't available.
3. Run both new suites against current `main` and commit them alone, before
   any refactor. They are the regression fence for Phases 2–3.

## Phase 1 — Introduce the adapter interface (extraction only)

4. Create `src/adapters/base.js` documenting the interface shape (plain
   object contract, no class needed):
   ```js
   {
     sourceExtensions: ['.js', '.mjs'],
     stripComments(code),
     manifest: { fileName, parse },       // e.g. package.json vs requirements.txt
     extractImports(source),
     lint(files, cwd, configOverride),    // → normalized diagnostics shape (Phase 2)
     lintConfigCandidates(configsDir, labName, stepName), // resolves override files
     detectProject(dir),                  // → { type, entryPoint, buildCommand, artifactPath }
     install(dir), build(dir), runScript(dir, name)
   }
   ```
5. Create `src/adapters/javascript.js` and move into it, **verbatim**:
   - comment-stripping logic from
     [analyze_code.js:22-36](../src/pipeline/analyze_code.js#L22)
   - the ESLint invocation, `ruleDescriptions` table, and the config-file
     resolution logic (step > lab > shipped default,
     [lint_code.js:139-159](../src/pipeline/lint_code.js#L139)) from
     `lint_code.js`
   - `findPackageJsonDirs`/`checkBuild`/npm-script logic from
     `runtime_check.js`
   - `extractUsedPackages`/`checkPackageJson` from
     [analyze_code.js:424-530](../src/pipeline/analyze_code.js#L424)
6. **Preserve test imports.** `test/analyze.spec.mjs`,
   `test/walkers.spec.mjs`, and others import `stripComments`,
   `countFeatures`, `getAllJsFiles`, `findPackageJsonDirs`, etc. directly
   from the pipeline modules. Either re-export these from their original
   locations (thin `export { x } from '../adapters/javascript.js'` shims)
   or update every importing test in the same commit as step 5. Do not let
   this be discovered by a failing test run after the fact.
7. Create `src/adapters/index.js` with `resolveAdapter(config)` returning
   the JS adapter when `config.language` is unset or `"javascript"` — the
   only new branch point in the whole phase.
8. Update `analyze_code.js`, `lint_code.js`, `runtime_check.js` to call the
   resolved adapter instead of inlined logic. Two inline spots are easy to
   miss and must be included:
   - the developer-comments file filter in
     [analyze_code.js:638](../src/pipeline/analyze_code.js#L638)
     (hardcoded `.js`/`.mjs`) — key off `adapter.sourceExtensions`
   - `countFeatures`'s default file filter and its "only strip comments for
     `.js` files" decision in
     [analyze_code.js:82-91](../src/pipeline/analyze_code.js#L82) — same fix
9. Re-run Phase 0's tests plus the full existing suite. Output must be
   identical for JS labs. This is the highest-value, lowest-risk step in the
   whole plan — do it alone, with nothing else bundled into the commit/PR.

## Phase 2 — Normalize result shapes

10. Rename `student.lint.jsFiles` → `student.lint.sourceFiles`. Grep every
    reader (`generate_grades.js`'s `lintResult()`, report writers, tests) and
    update all of them in the same commit.
11. Define one shared diagnostics shape in `base.js` as the contract every
    adapter's `lint()` must return: `{ errors, warnings, messages,
    errorMessages, warningMessages, ruleCounts }`. Add a shape-validator used
    only in tests (not production) to catch adapter drift early.
12. Confirm `lintResult()`/`scoreValidation()`'s tiering in
    `generate_grades.js` needs zero changes — it already depends only on the
    normalized shape, not on ESLint specifics.

## Phase 3 — Generalize the runtime-check phase into a strategy registry

13. Refactor `runtime_check.js`'s mode dispatch into a registry:
    `registerCheckStrategy(name, fn)` where
    `fn(student, config) => { success, errors, ...subResults }`, mirroring
    the `generate_grades.js` handler-registry pattern. Register `browser`,
    `build`, `both` as the current implementations, unchanged.
14. **Update `VALID_RUNTIME_MODES` in
    [bin/grade.js:101](../bin/grade.js#L101).** It is currently a hardcoded
    `Set(['browser', 'build', 'both'])` checked by `validateConfig()` at
    startup. It must derive from the strategy registry's registered names,
    or any config referencing a new strategy (e.g. `"run_check"`) will fail
    validation and `process.exit(1)` before grading even starts.
15. Keep the three original string values working exactly as today — no
    config migration needed for existing labs.
16. Add a `run_check` strategy stub: execute a built artifact with
    configured stdin, capture stdout/exit code, match `expectPatterns`.
    **Define the artifact hand-off now:** the `build` strategy must attach
    `student.runtimeCheck.artifactPath` (or equivalent) so `run_check` and
    the Phase 3b `test_check` mapping type have something to execute. JS
    labs can populate this trivially (e.g. the served `dist/` dir); leaving
    the contract undefined here forces a breaking rework of `run_check` when
    the C++/C# adapters land in Phase 8.
17. Leave sandboxing unimplemented in this stub — that's Phase 7. The point
    here is only to land the shape.
18. Add a `test_check` mapping type in `generate_grades.js` — proportional
    scoring identical to the existing `scripts_check` pattern (score =
    maxScore × passed/total) — as the landing spot for `pytest`/`dotnet
    test`/CTest results in Phase 8.

## Phase 4 — Decouple course/institution specifics from source

19. Replace the hardcoded `citstudent`/`github` URL detection in
    [extract_code.js:97-110](../src/pipeline/extract_code.js#L97) with a
    config-driven `urlPatterns` map, defaulting to today's values
    (`{ github: "github.com", deploy: "citstudent.lanecc.edu" }`) so no
    existing config needs edits.
20. Update `deploy_check` in `generate_grades.js` to read its target URL
    type from `map.urlType` (default `"citstudent"`), and make the
    bundling-heuristic `<script>`-tag check opt-in via `map.checkBundling`
    (default `true`, preserving current behavior).
21. Add `courseCode`/`courseName` to `local-config.json`'s schema (fallback
    `"CS233JS"`), threaded into `showHelp()`'s banner and any hardcoded
    `CS233JS_` filename conventions. Low priority — fold into another
    phase's commit rather than doing it standalone.

## Phase 5 — Make the handler/mapping-type registry the single source of truth

There are effectively **four** places mapping-type information lives today,
not two: `VALID_MAPPING_TYPES` (generate_grades.js), `MAPPING_TYPES` +
`MAPPING_TYPE_SCHEMA` (lab_config.js, with wizard labels/descriptions/field
prompts), and the `mappingDescription()` switch (generate_grades.js, text-report
row labels). A rename-one-list-to-match-the-other approach can't work — the
wizard needs descriptions the handler names don't carry.

22. Extract the registry into its own module, `src/lib/handler_registry.js`,
    with `registerHandler(type, fn, meta)` where `meta` optionally carries
    `{ desc, reportLabel, fields }`. Migrate all built-in handlers to
    register through it with their existing descriptions/schema fields
    folded in as `meta`.
23. Update `lab_config.js` (wizard) and `generate_grades.js`'s
    `mappingDescription()` to read from this single registry instead of
    maintaining their own parallel lists.
24. **Load order fix:** `config.handlerModules: string[]` (paths to JS
    modules that call `registerHandler()` on import, mirroring the existing
    custom-analyzer loading pattern in `analyze_code.js` — same
    try/catch-and-warn-don't-crash behavior) must be loaded **during config
    resolution in `bin/grade.js`, immediately after the config file is
    parsed and before `validateConfig()` runs.** `validateConfig()` checks
    every mapping's `type` against the registry at startup — if
    `handlerModules` is loaded later (e.g. inside `generate_grades.js`, as
    originally proposed), any lab using an externally-registered type will
    fail validation and exit before that module ever loads. Putting the
    registry in its own lightweight module (step 22) makes this easy:
    `bin/grade.js` can import just the registry, without pulling in
    `generate_grades.js`'s heavier dependencies (ollama client, rubric
    writer), to load handler modules before validation.
25. While migrating, add generic aliases for the two mapping types whose
    *names* are npm-specific even though their logic (after Phase 1) is not:
    register `package_usage` alongside `npm_package` and `manifest_check`
    alongside `package_check`, both pointing at the same handler functions.
    A Python lab grading "approved pip package used" shouldn't have to write
    `npm_package` in its config.

## Phase 6 — Extract the orchestrator out of bin/grade.js

26. Pull the phase-execution block
    ([bin/grade.js:647-722](../bin/grade.js#L647)) into
    `src/pipeline/run_pipeline.js`, exporting
    `runPipeline(students, config, dirs, options)` where the phase list is
    data: `const PHASES = [{ name, run, when: config => bool }]`. This lets
    a lab config skip `validate_html`/`validate_css` cleanly for non-web
    languages, rather than every phase silently no-op'ing on empty file
    lists as it does today.
27. Leave `bin/grade.js` responsible only for CLI parsing, interactive
    prompts, path resolution, and calling `runPipeline()` (plus, per step 24,
    loading `handlerModules` before config validation).
28. Add `test/run_pipeline.spec.mjs` exercising the phase-list/`when` logic
    directly, without the readline/CLI layer.
29. No config changes required for existing labs — this phase is pure
    internal restructuring, validated by the full existing suite passing
    unchanged.

## Phase 7 — Isolation hook for native code execution

Required before Phase 8 lands any compiled-language adapter. Running a
student-compiled binary is arbitrary native code execution on the grading
machine — a materially different risk than `npm run build` or headless
Chrome.

30. Add an `execution` config block:
    `{ mode: "direct" | "restricted-user" | "container", timeoutMs }` and a
    single chokepoint function, `runStudentArtifact(cmd, args, cwd,
    execConfig)`, that every current and future `build`/`run_check`/
    `test_check` strategy calls instead of `spawn`/`exec` directly.
31. Implement `"direct"` now — today's behavior, unchanged, sufficient for
    JS/Python/TS which don't execute untrusted native binaries the same way
    compiled languages do.
32. Stub `"restricted-user"`/`"container"` with an explicit "not yet
    implemented" error. **Do not silently fall back to `"direct"`** — a
    silent fallback here is a security footgun, not a convenience.
33. Add a `toolchains` section to `local-config.json`
    (e.g. `{ "python": "py", "cpp": { "compiler": "g++" } }`) since tool
    invocation is machine-specific in ways npm/Node isn't on this
    grader's Windows setup (`python` vs `py` vs `python3`; g++ via
    MSYS2/MinGW; `dotnet` may not be on PATH). Adapters read from this with
    sane per-OS defaults rather than hardcoding a binary name.
34. Document in `CLAUDE.md` that any adapter compiling/running native
    student code must go through the `runStudentArtifact` chokepoint, and
    that `"direct"` mode is acceptable only for trusted-classroom use.

## Phase 8 — Land new language adapters, cheapest first

35. **TypeScript adapter** — cheapest, and the best validation of the whole
    abstraction. Reuse the JS adapter's ESLint plumbing with the
    `@typescript-eslint` parser; `build()` = `tsc --noEmit`; `manifest`
    stays `package.json`. Should mostly be config (a
    `configs/{Lab}/eslint.config.mjs` override) plus a thin
    `src/adapters/typescript.js` extending the JS adapter. Validate against
    one real or synthetic TS submission end-to-end.
36. **Python adapter** — `sourceExtensions: ['.py']`; `stripComments`
    handles `#` and triple-quoted docstrings; `lint()` shells to
    `ruff --output-format json` (or pylint's JSON output) normalized to the
    Phase 2 diagnostics shape; `manifest` = `requirements.txt`/
    `pyproject.toml`; `lintConfigCandidates` resolves `ruff.toml`/
    `pyproject.toml` overrides the same way the JS adapter resolves
    `eslint.config.mjs`; `build()` is a syntax/dependency sanity check;
    `test_check` wired to `pytest --json-report`.
37. **C++ adapter** — `detectProject()` handles CMake/Makefile/loose-`.cpp`-
    files cases; `build()` invokes the discovered command and captures
    compiler diagnostics via `-fdiagnostics-format=json` (gcc/clang)
    normalized to the shared shape; `run_check`/`test_check` route through
    the Phase 7 chokepoint; comment-stripping must handle raw strings
    (`R"(...)"`) — a naive string-literal scanner will misparse these and
    corrupt feature-regex matching. `sourceExtensions` should be
    role-aware: `.h`/`.hpp` are scanned for features and linted but are not
    independently compiled as translation units.
38. **C# adapter** — `detectProject()` parses `.sln`/`.csproj` (a solution
    may contain multiple projects); `build()` = `dotnet build` with MSBuild
    diagnostics normalized; `test_check` parses `dotnet test` TRX output;
    comment-stripping handles verbatim (`@"..."`, where `""` is an escaped
    quote, not a close-quote) and raw (`"""`) string literals.
39. Each adapter ships a preflight check for its toolchain (compiler/SDK on
    PATH, informed by the Phase 7 `toolchains` config) with an actionable
    error message, mirroring the existing "Puppeteer not installed — run:
    npm install puppeteer" pattern in `runtime_check.js`.
40. Add `test/adapters/{lang}.spec.mjs` per adapter covering
    comment-stripping edge cases and diagnostic-shape normalization — the
    parts most likely to silently misbehave.

## Phase 9 — Close the loop

41. Update `CLAUDE.md`'s Config Schema section to document `language`,
    `urlPatterns`, `handlerModules`, `execution`, and `toolchains`, each
    noted as defaulting to current behavior so existing lab configs need no
    changes.
42. Update `configure-lab.js`'s wizard to prompt for `language` when
    creating a new lab (defaulting to `javascript`), and to route
    rubric-mapping suggestions through the unified registry from Phase 5.

---

## Sequencing notes

- **Phases 0–2 are prerequisites** and should land as separate, reviewable
  commits/PRs in order. Phase 1 touches the riskiest files and deserves to
  be its own PR with nothing else mixed in.
- **Phases 3–6 can proceed in parallel** once 0–2 are done — they touch
  different files (`runtime_check.js` vs. `extract_code.js`/
  `generate_grades.js` vs. `bin/grade.js`).
- **Phase 7 must land before Phase 8's C++/C# adapters go live** against any
  real grading run. Don't wire a compiled-language adapter into real student
  binaries on `"direct"` execution mode without an explicit, documented
  decision that that's acceptable for the course in question.
- **Do TypeScript (35) before Python/C++/C#**, even though it isn't the most
  urgent course need — it's the cheapest real-world check that the Phase 1
  interface design actually holds up, before three more adapters are built
  against it.
