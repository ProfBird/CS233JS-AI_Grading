# Example lab: Lab00

A minimal, self-contained lab configuration used as a **template**. Copy this
folder into your external assignments directory and adapt it when creating a new
lab by hand (or use `cs233-configure-lab` to generate one interactively).

## Files

| File | Purpose |
|---|---|
| `lab00_config.json` | The lab config: rubric name, runtime-check mode, feature regexes, and the rubric cell mappings. |
| `CS233JS_Lab00_Rubric.xlsx` | The rubric template. Must contain a sheet named **`Grade`**; the grader writes scores/comments into the cells named by the mappings. |
| `lab00_analyzer.js` | An **optional** custom analyzer (see comments inside). The generic regex feature-counting covers most needs; only add an analyzer for detection a regex can't express. |

## Where course data lives

The tool's **source** lives in this repo; your **course data** (each lab's
config, rubric, code-review forms, instructions) lives **outside** it, under an
`assignmentsRoot` folder you choose. Point the grader at it via the machine
config (`~/.config/cs233js-grader/config.json`) or the first-run prompt, then:

```
cs233-grade Lab00        # or: node bin/grade.js Lab00
```

## Analyzers are special

Custom analyzers are **code**, so the canonical, unit-tested ones ship in the
repo under `src/analyzers/` and are resolved **by name, repo-first**. A
`customAnalyzer` that isn't found there falls back to a file beside the lab's
config (like this `lab00_analyzer.js`) — handy for a one-off without editing the
tool. Long-term the project aims to reduce lab-specific analyzer code in favor
of declarative, config-driven detection.

## Config schema

See the "Config schema" section of [`CLAUDE.md`](../../CLAUDE.md) for the full
list of mapping types and options.
