# CS233JS AI Grader — Developer Guide



[TOC]



---

## Module Dependency Diagram

```mermaid
graph TD
    subgraph "Entry Points"
        run_all[run_all.js]
        rubric_to_md[rubric_to_md.js]
    end

    subgraph "Pipeline Modules"
        extract[extract_code.js]
        runtime[runtime_check.js]
        analyze[analyze_code.js]
        lint[lint_code.js]
        grades[generate_grades.js]
    end

    subgraph "Supporting Modules"
        ollama[ollama_comments.js]
    end

    subgraph "External Dependencies"
        puppeteer
        xlsx_npm[xlsx npm package]
        eslint
    end

    subgraph "Configuration"
        env_json[env.json]
        lab_configs[configs/labXX_config.json]
        lab_env[<labDir>/_env.json]
        eslint_config[eslint.config.mjs]
    end

    %% Entry → Pipeline
    run_all --> extract
    run_all --> runtime
    run_all --> analyze
    run_all --> lint
    run_all --> grades

    %% Config loading
    run_all -.-> env_json
    run_all -.-> lab_configs
    run_all -.-> lab_env

    %% Module internal deps
    grades --> ollama

    %% External deps
    runtime --> puppeteer
    grades --> xlsx_npm
    analyze --> xlsx_npm
    lint --> eslint
    lint -.-> eslint_config

    %% Data flow direction (for readability)
    extract --> analyze
    analyze --> grades
    runtime --> grades
    lint --> grades

    style run_all fill:#4a90d9,color:#fff
    style rubric_to_md fill:#4a90d9,color:#fff
    style extract fill:#50b86c,color:#fff
    style runtime fill:#50b86c,color:#fff
    style analyze fill:#50b86c,color:#fff
    style lint fill:#50b86c,color:#fff
    style grades fill:#50b86c,color:#fff
```

---

## Startup & Configuration Flow

```mermaid
sequenceDiagram
    participant User
    participant run_all as run_all.js
    participant env as env.json
    participant config as labXX_config.json
    participant labEnv as _env.json

    User->>run_all: node run_all.js [LabXX] [flags]

    Note over run_all: === Startup ===
    run_all->>env: read labRoot
    alt labRoot missing
        User->>run_all: enter path interactively
        run_all->>env: save for next run
    end

    Note over run_all: === Lab Selection ===
    run_all->>run_all: scan labRoot for directories with matching configs

    alt no labName arg
        User->>run_all: select lab from menu
    end

    run_all->>config: read lab config
    run_all->>labEnv: read repoClonePath

    alt repoClonePath missing
        User->>run_all: enter path interactively
        run_all->>labEnv: save for next run
    end

    alt --reclone flag
        run_all->>run_all: delete all extracted_code/ and repo/ dirs
        run_all->>run_all: delete entire repoClonePath tree
    end
```

## Pipeline Phases 1-2: Code Acquisition & Runtime Check

```mermaid
sequenceDiagram
    participant run_all as run_all.js
    participant extract as extract_code.js
    participant runtime as runtime_check.js

    Note over run_all: === Phase 1: Code Acquisition ===
    run_all->>extract: extractCode(labDir, repoClonePath)
    extract->>extract: getStudents() — scan Moodle submission dirs
    par for each student
        extract->>extract: extractUrls() — read onlinetext.html
        alt has .zip file
            extract->>extract: unzip to repoClonePath/Student/extracted_code/
        else has GitHub URL
            extract->>extract: git clone --depth 1 to repoClonePath/Student/repo/
        end
    end
    extract-->>run_all: return students[] array

    Note over run_all: === Phase 2: Runtime Check ===
    run_all->>runtime: runtimeCheck(students, config, labDir)
    alt config.runtimeCheck == "build"
        runtime->>runtime: find package.json dirs
        runtime->>runtime: npm install && npm run build (20s timeout each)
    else "browser"
        runtime->>runtime: launch headless Chrome (Puppeteer)
        runtime->>runtime: find index.html dirs
        runtime->>runtime: serve + check for console errors
    end
    runtime-->>run_all: return runtimeReport[]
```

## Pipeline Phases 3-5: Analysis, Lint & Grade Generation

```mermaid
sequenceDiagram
    participant run_all as run_all.js
    participant analyze as analyze_code.js
    participant lint as lint_code.js
    participant grades as generate_grades.js
    participant xlsx as Rubric .xlsx/.xlsm

    Note over run_all: === Phase 3: Analysis ===
    run_all->>analyze: analyzeCode(students, config, labDir)
    analyze->>analyze: getAllFiles() — recursive directory walk
    analyze->>analyze: countFeatures() — regex matching per feature
    alt config has parts[]
        analyze->>analyze: findPartDir() — match subdirectories to game names
        analyze->>analyze: per-part feature counts
    end
    analyze->>analyze: check for developer comments, code review docs
    analyze->>analyze: write analysis_report.json
    analyze-->>run_all: return analysisReport[]

    Note over run_all: === Phase 4: Linting ===
    run_all->>lint: lintCode(students, config, labDir)
    lint->>lint: getAllJsFiles() — recursive .js file collection
    lint->>lint: ESLint.lintFiles() against eslint.config.mjs
    lint->>lint: write lint_report.json
    lint-->>run_all: return lintReport[]

    Note over run_all: === Phase 5: Grade Generation ===
    run_all->>grades: generateGrades(analysisReport, lintReport, runtimeReport, config, labDir)
    grades->>xlsx: read rubric spreadsheet
    par for each student
        grades->>grades: compute scores per mapping type
        grades->>grades: write cells (score, comment, link)
        alt --ai-comments
            grades->>grades: call Ollama for summary sentence
        end
        alt rubric is .xlsm
            grades->>grades: preserve all sheets + macros
        else .xlsx
            grades->>grades: keep only Grade sheet
        end
        grades->>grades: write StudentName_Grade.xlsx/.xlsm
    end
    grades-->>run_all: return { successful, errors }

    Note over run_all: === Log ===
    run_all->>run_all: write grading_log.txt to labDir
    run_all-->>User: All Done!
```

---

## File-by-File Reference

### `run_all.js` — Master Orchestrator

The entry point. Handles CLI argument parsing, interactive menus, env configuration, and orchestrates the five pipeline phases.

**Key behaviors:**
- Reads `labRoot` from `AI_Grading/env.json` (prompts & creates if missing)
- Scans `labRoot` for subdirectories matching configs for the lab menu
- Reads `repoClonePath` from `<labDir>/_env.json` (prompts & creates if missing)
- `--reclone` wipes both old-style dirs (inside submission folders) and the entire `repoClonePath`
- Each phase attaches data to the shared `students` array; `generate_grades` consumes the combined output
- Writes `grading_log.txt` to `labDir` on completion

### `extract_code.js` — Code Acquisition

Handles extracting student code from submissions.

| Function | Purpose |
|---|---|
| `readFileWithTimeout()` | Read a file with a 10s timeout guard (protects against Google Drive blocking reads) |
| `normalizeGithubUrl()` | Normalize various GitHub URL formats to `https://github.com/owner/repo.git` |
| `getGithubSubdir()` | Extract subdirectory path from tree URLs (e.g., `/tree/main/Lab04` → `Lab04`) |
| `getStudents()` | Scan lab directory for Moodle submission folders matching `Name_ID_assignsubmission_*` |
| `extractUrls()` | Parse `onlinetext.html` for citstudent and GitHub URLs |
| `extractStudentCode()` | Unzip or git clone per student; sets `student.extractedDir` |

**Directory naming:**
- GitHub clones → `<repoClonePath>/StudentName/repo/`
- ZIP extractions → `<repoClonePath>/StudentName/extracted_code/`

If `repoClonePath` is not configured, falls back to placing code inside the student's submission directory on Google Drive.

**Git clone safety:**
- 60-second timeout with SIGKILL to prevent hangs
- `--depth 1` for shallow clones (faster)

### `runtime_check.js` — Runtime Error Detection

Two modes, controlled by `config.runtimeCheck`:

**`"build"` mode:**
- Recursively finds `package.json` files (skipping `node_modules`, hidden, and `dist` dirs)
- For each: runs `npm install --no-fund --no-audit --ignore-scripts` then `npm run build`
- Both commands have a 20-second timeout

**`"browser"` mode:**
- Launches headless Chrome via Puppeteer
- Finds all `index.html` files (recursively)
- Serves each directory on a random port
- Tracks JS runtime exceptions and failed script/stylesheet loads
- Waits for `networkidle0` plus 2s for delayed execution

### `analyze_code.js` — Feature Detection

Regex-based analysis of student JavaScript files.

**Key logic:**
- `getAllFiles()` — recursive directory walk (skips symlinks to prevent infinite loops from circular references)
- `countFeatures()` — counts regex matches per feature across all JS files, after stripping comments
- `findPartDir()` — multi-pass search for part subdirectories (game name matching, folder pattern fallback)
- Special case for Lab02: `modules` requires both `import` AND `export`
- Checks for developer comments (name/date markers in files) and code review documents

### `lint_code.js` — ESLint Runner

Runs ESLint v9+ with flat config.

- Loads ESLint from `eslint.config.mjs` in the AI_Grading directory
- `getAllJsFiles()` collects `.js` files recursively, respecting per-lab exclusions (e.g., `node_modules`, `dist`, `part1`)
- Outputs human-readable rule descriptions (42 rules mapped)
- Writes `lint_report.json`

### `generate_grades.js` — Rubric Spreadsheet Filler

Reads the rubric template and writes per-student graded spreadsheets.

**Cell mapping types:**

| Type | Auto-grades? | Behavior |
|---|---|---|
| `feature` | Yes | Score based on feature count vs. `minCount` |
| `part1_completed` | Yes | Score if Part 1 files exist |
| `apps_in_repo` | Yes | Score if both parts found in GitHub repo |
| `developer_comments` | Yes | Score if name/date markers found |
| `code_review` | Yes | Score if review document found |
| `url_check` | Partial | Writes URL for manual verification; score left blank |
| `lint` | Yes | Score based on ESLint issue count |
| `build_check` | Yes | Score based on build/run success |
| `manual` | No | Writes "NEEDS MANUAL CHECK" — instructor fills in |

**Macro support:** When the rubric is `.xlsm`, all sheets are preserved and VBA macros are written back. When `.xlsx`, only the `Grade` sheet is kept.

**AI summaries:** With `--ai-comments`, calls `ollama_comments.js` to generate a one-sentence summary for `config.summaryCell`.

### `ollama_comments.js` — AI Summary Generator

Hits a local Ollama instance (`http://localhost:11434`) to generate one-sentence rubric summaries.

- Discovers available models via `/api/tags`
- Sends a prompt with feature counts, lint issues, and runtime results
- Requests a 20-word-max sentence at `temperature: 0`

### `rubric_to_md.js` — Standalone Utility

Dumps a rubric spreadsheet's Grade sheet as Markdown. Not part of the grading pipeline.

Usage: `node rubric_to_md.js path/to/Rubric.xlsm [output.md]`

---

## Configuration Reference

### `env.json` (AI_Grading root)

```json
{
  "labRoot": "/path/to/StudentLabWork"
}
```

Machine-specific. Created on first run. Single field pointing to the parent directory of all lab folders.

### `_env.json` (inside each lab directory)

```json
{
  "repoClonePath": "/path/outside/google/drive"
}
```

Per-lab machine-specific config. Created on first run per lab. Path to a local directory where student code is extracted/cloned (outside Google Drive to avoid sync issues).

### `configs/labXX_config.json` schema

```json
{
  "rubricName": "CS233JS_LabXX_Rubric.xlsx",
  "titleCell": "A1",
  "titleText": "Lab X: Title",
  "summaryCell": "A2",
  "runtimeCheck": "build" | "browser",
  "lint": {
    "exclude": ["node_modules", "dist"]
  },
  "analysis": {
    "features": [
      {
        "id": "feature_name",
        "regex": "regex pattern",
        "fileRegex": "\\.js$"
      }
    ]
  },
  "parts": [
    {
      "id": "part1",
      "rubricTitleRow": 7,
      "folderPattern": "regex pattern",
      "featureCounts": [
        { "featureId": "classes", "minCount": 1, "cell": "C8", "commentCell": "E8", "maxScore": 5 }
      ]
    }
  ],
  "mappings": [
    { "cell": "C10", "commentCell": "E10", "type": "feature", "featureId": "modules", "maxScore": 6 }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `rubricName` | Yes | Filename of the rubric spreadsheet in the lab directory |
| `titleCell` | No | Cell to write the lab title |
| `titleText` | No | Lab title text |
| `summaryCell` | No | Cell for the AI-generated or manual summary comment |
| `runtimeCheck` | Yes | `"build"` or `"browser"` |
| `lint.exclude` | No | Path substrings to skip during linting |
| `analysis.features` | Yes | Array of features to detect via regex |
| `parts` | No | Multi-part lab configuration |
| `mappings` | Yes | Array of rubric cell assignments |

## Adding a New Lab

1. Create `configs/labXX_config.json` following the schema above
2. Place the rubric spreadsheet (`CS233JS_LabXX_Rubric.xlsx` or `.xlsm`) in the lab directory on Google Drive
3. Run `node run_all.js` — the new lab will appear in the menu automatically (the menu scans `labRoot` for directories with matching configs)

## Data Flow

```mermaid
graph LR
    subgraph "Pipeline Data"
        students["students[] array"]
        runtimeR["runtimeReport[]"]
        analysisR["analysisReport[]"]
        lintR["lintReport[]"]
        gradeSummary["{ successful, errors }"]
    end

    extract --> students
    runtime -.->|per student| runtimeR
    analyze -.->|per student| analysisR
    lint -.->|per student| lintR
    grades --> gradeSummary

    students --> runtime
    students --> analyze
    students --> lint
    analysisR --> grades
    lintR --> grades
    runtimeR --> grades
    students --> grades
```

Each phase enriches or produces data about the students. The `students` array carries file paths and extracted code references. The analysis, lint, and runtime reports are indexed by student name and consumed by the grade generator.

## Google Drive Considerations

The lab directories live on Google Drive, which uses on-demand file syncing. This causes two issues:

1. **File reads can block** — `fs.readFileSync()` on an unsynced file hangs while Google Drive downloads it. Mitigated by `readFileWithTimeout()` in `extract_code.js` and the `repoClonePath` setting that moves code off the cloud drive.

2. **Recursive directory walks can hang** — walking a directory tree on Google Drive triggers sync for each directory entry. Mitigated by skipping symlinks (`fs.lstatSync` instead of `fs.statSync`) and excluding `node_modules`, `dist`, and hidden directories.

3. **Git operations on Google Drive** — `git clone` writing to a Google Drive path can stall. All code extraction now uses `repoClonePath` which should point to a local (non-cloud) filesystem.
