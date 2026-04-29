# Code Review Report

**Reviewed:** 2026-04-26  
**Reviewer:** architecture-code-reviewer agent

---

## Executive Summary

This is a pragmatic, well-structured pipeline for an educational grading task. The five-phase architecture (extract → runtime → analyze → lint → generate) is logical, and the code is generally readable. However, the codebase has **critical, unmitigated security vulnerabilities** arising from running untrusted student code with no sandboxing — a student can achieve remote code execution on the grader's machine through multiple independent vectors. Beyond security, there are grading-correctness bugs (wrong student matched, wrong folder counted) that could quietly misgrade students, and no config validation that would make silent failures detectable. These issues need to be addressed before the pipeline is used on real submissions.

---

## Architectural Assessment

**Pipeline shape and data flow**

The orchestrator (`run_all.js`) threads a shared `students` array through all five phases. `extract_code` mutates the objects in-place (attaching `extractedDir`, `urls`, `error`), then each downstream phase reads those fields. This creates invisible, implicit coupling: if you reorder phases, the pipeline silently breaks because downstream phases depend on fields attached by upstream ones. There is no type contract, no validation between phases, and no documented interface for the student object shape.

Each phase also exhibits dual persistence: it returns its report array *and* writes a JSON file to disk. This makes the data flow hard to follow — are the JSON files the authoritative source, or are they just logs? Currently they are written but never re-read by subsequent phases in the same run, making them redundant within a single execution (though they are useful for debugging). The pattern should be made explicit.

**Config as schema, without validation**

The `configs/labXX_config.json` files drive all grading logic: cell references, regex patterns, mapping types, and per-part definitions. A typo in a `featureId` produces a silent 0 score; a typo in a `cell` reference writes to the wrong spreadsheet cell; an unknown `type` in a mapping silently skips the `switch` case and writes `score = 0, comment = ''`. There is no JSON Schema, no startup validation, and no warning when a mapping is unhandled. For a grading system, silent wrong scores are worse than loud errors.

**No isolation architecture**

Student code is executed with the same OS privileges as the grader. There is no container, no seccomp profile, no network namespace, and no resource limit beyond a loose `timeout` option. This is the foundational architectural risk that all security findings below stem from.

**`build_code.js` is dead code**

Per the CLAUDE.md, `build_code.js` is a "legacy standalone build-check script; not called by the orchestrator." Yet it lives at the root alongside active modules, duplicates `findPackageJsonDirs` entirely, and has behavioral differences from the version in `runtime_check.js` (notably, it runs builds in parallel via `Promise.all`, while `runtime_check.js` runs them serially). This duplication will cause drift. It should be deleted or clearly namespaced.

---

## Module Design Assessment

**Cohesion**: Each module has one clear job, which is good. The boundary between `build_code.js` and `runtime_check.js` is blurred because the build logic was duplicated rather than extracted.

**Coupling**: `generate_grades.js` re-scans the lab directory with `fs.readdirSync` to find each student's `_file` directory, even though `extract_code.js` already resolved this path and attached it to the student object. This is redundant work and a source of the name-prefix collision bug described below.

**Extensibility**: The `switch` statement in `generate_grades.js` over `map.type` is the right structure for a config-driven system, but adding a new mapping type requires modifying both the config schema (undocumented) and the switch block. A registry pattern (a `Map` of handler functions keyed by type name) would make this open for extension without modification.

**`checkBrowserErrors` is dead code**: `runtime_check.js` defines `checkBrowserErrors` but the exported function never calls it. The dead function also has a path-traversal vulnerability. It should be removed.

---

## Code Quality Assessment

**Correctness — grading accuracy bugs**

1. In `analyze_code.js`, `stripComments` uses a regex that also strips `//` and `/* */` sequences inside string literals and template literals. Code like `const url = "https://example.com"` becomes `const url = "https:"` after stripping. The `templateStrings` feature regex (counting backticks) runs on the stripped output, which has already had template literal content corrupted.

2. The `modules` feature detection in `analyze_code.js` is inconsistent. `countFeatures` sets `results.features['modules']` to a `Number`. Immediately after, the Lab02 compatibility block overwrites it with a `Boolean`. In `generate_grades.js`, the handler checks `typeof results.features[map.featureId] === 'number'` — so the boolean falls through and is cast as `result.features[map.featureId] ? 1 : 0`. It works, but by accident.

3. In `analyze_code.js`, `findPartDir` uses `lowerDir.includes(word)` as a substring match. A game named `"car"` matches `"cards"`, `"part"` matches `"partial"`. The wrong game folder gets its features counted for the wrong part, silently producing incorrect scores.

4. In `generate_grades.js`, the student-to-directory match uses `f.startsWith(student)`. Students "Johnson_Alice" and "Johnson_Bob" share a prefix. The wrong `filesDir` is selected, so the grade spreadsheet is written into the wrong student's submission folder.

**Error handling**

- In `run_all.js`, if `main()` throws an exception between readline creation (line 90) and `rl.close()` (line 135), the `.catch()` handler at line 230 never calls `rl.close()`, leaking the readline interface. (Note: `rl.close()` is already called *before* the `process.exit(1)` calls at lines 142/146, so those specific exit paths are safe.) Wrapping the interactive section in `try/finally { rl.close() }` would fix the leak-on-exception scenario.

- In `runtime_check.js` (build mode), `execAsync` sends `SIGTERM` on timeout but does not kill the entire process group. A malicious `npm run build` script that spawns children is not terminated.

- The `serveDir` function in `runtime_check.js` has no error handler on the HTTP server. An `EADDRINUSE` or `EACCES` error on `server.listen` will throw an unhandled rejection and crash the pipeline mid-run.

---

## Findings Summary

### 🚨 Critical Security Vulnerabilities

**1. Command injection / RCE via `git clone` URL** — `extract_code.js`

Student-controlled GitHub URLs are interpolated directly into `execSync`:
```js
execSync(`git clone --depth 1 "${urls.github}" "${unzippedDir}"`, { stdio: 'ignore' });
```
A URL like `--upload-pack=/path/to/malicious` causes git to execute an arbitrary binary.

**Fix**: Use `execFileSync` with `['--', validatedUrl, unzippedDir]` as separate argv entries. Validate the URL against `^https://github\.com/[\w.\-]+/[\w.\-]+(\.git)?\/?$` before use.

---

**2. `npm install` executes arbitrary student code (RCE)** — `runtime_check.js`, `build_code.js`

A `postinstall` script in a student `package.json` runs with full grader privileges. The 20-second timeout only sends `SIGTERM`, which can be trapped.

**Fix**: Pass `--ignore-scripts` to `npm install`.

---

**3. Path traversal in `serveDir`** — `runtime_check.js`

```js
const filePath = path.join(dir, urlPath);
```
`path.join` does not constrain the result to `dir`. A request for `/../../../../etc/passwd` resolves outside the student directory.

**Fix**:
```js
const resolved = path.resolve(path.join(dir, urlPath));
const root = path.resolve(dir);
if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    res.writeHead(403); res.end('Forbidden'); return;
}
```

---

**4. Puppeteer launched with `--no-sandbox`** — `runtime_check.js`

Disables Chrome's renderer sandbox while running student-controlled HTML/JS, giving student code a direct path to kernel exploits.

**Fix**: Remove `--no-sandbox`. Fix the underlying OS permission issue rather than disabling the sandbox.

---

### ⚠️ Grading Correctness Bugs (High Priority)

**5. Student directory matched by name prefix** — `generate_grades.js`

`f.startsWith(student)` ambiguously matches students sharing a name prefix. Grade file is written to the wrong student's folder.

**Fix**: Use `student.filesDir` already resolved by `extract_code.js`.

---

**6. `findPartDir` substring match causes wrong folder to be selected** — `analyze_code.js`

`lowerDir.includes(word)` is too broad: `"car"` matches `"cardsGame"`. Features for the wrong game get counted for the wrong part.

**Fix**: Use word-boundary regex `new RegExp(\`\\b${word}\\b\`).test(lowerDir)`, or allow config to specify folder names directly.

---

**7. `stripComments` corrupts string and template literal content** — `analyze_code.js`

Regex-based comment stripping removes `//` sequences inside string literals, corrupting subsequent feature detection regexes.

**Fix**: Use a proper tokenizer or the `strip-comments` npm package.

---

**8. `modules` feature set as Boolean, overwriting a Number** — `analyze_code.js`

`countFeatures` sets `results.features['modules']` to a number; the Lab02 compatibility block overwrites it with a Boolean. Works today by accident.

**Fix**: Normalize to `? 1 : 0` in the Lab02 override block.

---

### 🔧 Module Design & Code Quality Issues

**9. Grade file output path resolved redundantly** — `generate_grades.js`

Re-scans the lab directory to find `filesDir` instead of using `student.filesDir` already populated by `extract_code.js`. Creates the name-prefix bug (#5) and is redundant work.

**10. `checkBrowserErrors` is dead code** — `runtime_check.js`

Defined but never called. Contains an independent path-traversal vulnerability. Delete it.

**11. `build_code.js` is dead code** duplicating `runtime_check.js` logic with behavioral differences (parallel vs serial). Delete it.

**12. Unknown `map.type` produces silent 0 scores** — `generate_grades.js`

No `default` case in the `switch` over `map.type`. A config typo silently writes a 0 score.

**Fix**: Add a `default` case that writes a warning string to the comment cell.

**13. `readline` interface leaks on exception** — `run_all.js`

The `.catch()` handler doesn't close the readline. If `main()` throws between readline creation and `rl.close()`, the interface keeps the process alive. Wrap the interactive section in `try/finally`.

**14. `getAllFiles` doesn't skip `node_modules` or `dist`** — `analyze_code.js`

Feature counts include library code and transpiled output.

**Fix**: Apply the same exclusions used in `lint_code.js`.

**15. `findIndexHtml` (shallow) vs `findAllIndexHtmlDirs` (deep) are inconsistent** — `runtime_check.js`

`findIndexHtml` is only used in the dead `checkBrowserErrors` function. Delete both when removing that function.

**16. File paths interpolated into shell command string** — `lint_code.js`

```js
const fileArgs = jsFiles.map(f => `"${f}"`).join(' ');
```
A student file with a `"` in its name breaks this. More critically, a file named e.g. `-c /etc/passwd.js` is interpreted as an ESLint CLI flag, not a file path (argument injection via student-controlled filenames). Use `execFileSync` with separate argv entries or ESLint's Node API.

---

### Additional Findings

**17. Invalid config regex crashes the pipeline** — `analyze_code.js`

`new RegExp(feat.regex, 'g')` inside `countFeatures` throws an unhandled `SyntaxError` if a config file contains a malformed regex pattern, crashing the entire run mid-phase. Belongs alongside the config validation suggestion (S1).

**Fix**: Wrap `new RegExp()` construction in a `try/catch` that logs a warning and skips the feature.

**18. `hasDeveloperComments` produces false positives** — `analyze_code.js`

The patterns `name[:\s]` and `date[:\s]` match against raw file content with no word boundaries. These match filenames like `classname`, `filename`, and keywords like `update`, `candidate`, silently over-crediting the developer-comments rubric item.

**Fix**: Use `\b(name|author|date)\s*[:=]` to require a word boundary before keyword matches.

**19. Part-number detection regex is too broad** — `analyze_code.js`

The regex `part\s*[_-]?\s*1` applied against full file paths matches filenames like `party_planner.js`, `apartment1.js`, or `departments.js`. This incorrectly sets the `part1Completed` and `bothAppsPresent` flags used in grading.

**Fix**: Anchor with `\bpart` and `1\b` to require word boundaries.

**20. URL extraction from HTML is fragile** — `extract_code.js`

Two regexes (`href="..."` and a plain URL pattern) parse `onlinetext.html` for GitHub and citstudent URLs. URLs in single quotes, URLs broken across HTML lines, or URLs inside HTML comments would be silently missed, producing a "No GitHub URL found" error for valid submissions.

**Fix**: Use a more robust HTML parser or at minimum handle single-quoted hrefs and normalize whitespace.

---

### 💡 Suggestions

**S1. Add config schema validation on startup** — Use `ajv` to validate `labXX_config.json` before any phase runs. Catches `featureId` typos, unknown `type` values, and malformed regex patterns before they produce silent bad grades.

**S2. Add a sandbox warning** — If not running inside a container, print a prominent warning before executing any student code. Makes the security assumption explicit.

**S3. Consolidate file-traversal utilities** — Five overlapping directory-traversal functions with inconsistent skip rules. Consolidate into a shared `utils.js`.

**S4. Use ESLint's Node API instead of shelling out** — Avoids argument quoting issues, is faster (no process startup per student), and eliminates the path-injection surface.

**S5. Clean up stale grade files on `--reclone`** — `--reclone` deletes `extracted_code/` but leaves old `*_Grade.xlsx` files. A student removed from the roster keeps an orphan grade file.

---

### ✅ Strengths

- **Clean phase separation.** The five-stage pipeline is easy to reason about; adding a new phase requires touching only `run_all.js`.
- **Config-driven design is correct.** Externalizing per-lab rubric mappings into JSON means the grading logic rarely needs code changes between labs.
- **Shared Puppeteer instance.** One browser with multiple tabs rather than one browser per student is a meaningful performance improvement.
- **Per-student error isolation.** Each phase handles per-student errors without aborting the whole run.
- **`--reclone` / `--regrade` semantics are well-implemented.** The implication rule is documented and correct.
- **Config-driven ESLint exclusions.** Allowing per-lab exclusion paths in `config.lint.exclude` is the right way to handle partial-lab structures.

---

## Recommended Action Plan

### Immediate — before running on any real submissions

1. **Fix #1** — Switch `git clone` to `execFileSync` with URL validation
2. **Fix #2** — Add `--ignore-scripts` to `npm install`
3. **Fix #3** — Add path-traversal guard in `serveDir`
4. **Fix #4** — Remove `--no-sandbox` from Puppeteer launch

### High priority — grading correctness

5. **Fix #5** — Use `student.filesDir` in `generate_grades.js`
6. **Fix #6** — Word-boundary matching in `findPartDir`
7. **Fix #7** — Replace `stripComments` regex with a proper parser
8. **Fix #8** — Normalize `modules` feature to number

### Medium priority — maintainability

9. **Fix #12** — Add `default` case to mapping `switch`
10. **Fix #14** — Add `node_modules`/`dist` exclusions to `getAllFiles`
11. **Fix #16** — Use `execFileSync` with separate argv in `lint_code.js`
12. **Fix #17** — Add `try/catch` around config regex construction
13. **Fix #18** — Use word boundaries in `hasDeveloperComments` patterns
14. **Fix #19** — Use word boundaries in part-number detection regex
15. **Fix #13** — Wrap readline usage in `try/finally`
16. **Delete** `build_code.js`, `checkBrowserErrors`, `findIndexHtml`
17. **Add** config schema validation (S1)
