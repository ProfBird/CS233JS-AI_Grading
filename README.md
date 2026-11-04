<h1>AI Grading Assistant</h1>

[TOC]

## Introduction

This is an AI-assisted grading pipeline built for **CS233JS** (Lane Community College), but designed to be extensible so that it can be used for grading any kind of programming assignment. It automates grading of student lab submissions downloaded from an LMS by: extracting student code, running analysis/lint/build/runtime checks, and filling in rubric spreadsheets (`.xlsx`/`.xlsm`) with scores and comments.

It was originally built for JavaScript labs, but language-specific mechanics (linting, building, running, testing) sit behind a pluggable adapter layer, so it also grades **TypeScript, Python, C++, and C#** assignments — the language is a per-lab config setting, and JavaScript remains the default so existing labs need no changes.

The pipeline is designed for a workflow where some rubric items are auto-graded (code features, lint results, build/runtime success, HTML/CSS validation, file naming, etc.) and others are left for manual instructor review (code quality, design decisions, and the like).

## Other Documentation

- **[User Guide](USER_GUIDE.md)** — installation, directory setup, configuring and running labs, the `cs233-grade` / `cs233-configure-lab` / `cs233-rubric-to-md` commands, and the rubric mapping types.
- **[Developer Guide](DEVELOPER_GUIDE.md)** — architecture, module dependency diagram, pipeline phases, the language adapter interface, and how to extend the grader (new mapping types, new adapters, new check strategies).
- **[CLAUDE.md](CLAUDE.md)** — condensed architecture reference kept up to date for AI coding assistants working in this repo; also a handy quick-reference for humans.

## Related project

This repo is a from-scratch successor to [GradingAssistant](https://github.com/ProfBird/GradingAssistant), an earlier grading tool the author wrote mainly for checking **HTML and CSS** in web-authoring lab assignments (originally for a Web Authoring course, with JavaScript checking added later). CS233JS AI Grader generalizes that idea into a multi-language, adapter-based pipeline with spreadsheet rubric integration.

GradingAssistant's HTML/CSS evaluation capabilities have now been fully integrated here: the `check_web_content` pipeline phase checks required HTML elements (real CSS-selector queries), required CSS selectors/properties (external, embedded, and inline styles), and file-count minimums — and the **CIS 195** Web Authoring course ships under `configs/CIS195/` with converted configs for all eight auto-gradable labs, producing per-student text grade reports. See [docs/CIS195_INTEGRATION.md](docs/CIS195_INTEGRATION.md) for the capability mapping and conversion notes.

## Contributing

If you would like to help with development, take a look at the GitHub Issues, then send a message so work can stay coordinated. Feel free to:

- Ask which open issue would be useful to pick up, or propose an enhancement/new feature you'd like to work on.
- Ask for more documentation or context on a particular part of the pipeline.

### Development workflow

We follow the [GitHub flow](https://docs.github.com/en/get-started/quickstart/github-flow): make changes on a branch, open a PR for review, and merge into `main` once approved.

### Testing

[Vitest](https://vitest.dev) unit tests live in the `test/` directory. Each bug fix or enhancement should include a test if one doesn't already exist.

```bash
npm test          # run the full suite once
npm run test:watch  # watch mode
```

A pre-commit hook (`githooks/pre-commit`, wired up automatically by `npm install`) runs the test suite before every commit; bypass in an emergency with `git commit --no-verify`.

### Linting

The grader's own source is linted with ESLint's flat config (`eslint.config.mjs`), which is also the CI gate:

```bash
npm run lint
```

### Adding language support or mapping types

New languages are added as adapters in `src/adapters/` (see the interface contract in `src/adapters/base.js`); new rubric mapping types are registered via `src/lib/handler_registry.js`. See the [Developer Guide](DEVELOPER_GUIDE.md) for details before adding either — most new checks can be expressed with existing generic building blocks (feature regexes, nested `match` trees) rather than new code.
