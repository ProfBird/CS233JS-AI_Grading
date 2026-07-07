#!/usr/bin/env node
/**
 * grade.js (formerly run_all.js)
 *
 * Master orchestrator script for CS233JS lab grading.
 * Each pipeline phase attaches results directly to student objects.
 *
 * Usage:
 *   node bin/grade.js                           -> interactive menu
 *   node bin/grade.js Lab03                     -> first-time grade (skips existing extractions)
 *   node bin/grade.js Lab03 --regrade           -> re-run analysis/lint/runtime/generation (keeps cloned code)
 *   node bin/grade.js Lab03 --reclone           -> delete extracted code, re-clone/unzip, and re-grade
 *   node bin/grade.js Lab03 --regrade --reclone -> same as --reclone (reclone implies regrade)
 *   node bin/grade.js --help                    -> show help
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import extractCode, { CODE_DIR, REPO_DIR } from '../src/pipeline/extract_code.js';
import { VALID_RUNTIME_MODES } from '../src/pipeline/runtime_check.js';
import { VALID_MAPPING_TYPES } from '../src/pipeline/generate_grades.js';
import { runPipeline } from '../src/pipeline/run_pipeline.js';

import { getExistingSteps } from '../src/lib/lab_config.js';

// This file lives in bin/; course config + the default-config template live at the repo root.
const REPO_ROOT = path.join(import.meta.dirname, '..');

const ARTIFACTS_DIR = 'Artifacts';
const SUBMISSIONS_DIR = 'SubmissionsAndAssessment';
const LOG_FILE = 'grading_log.txt';

// --- Help ---

function showHelp() {
    const courseCode = (readLocalConfig().courseCode) || 'CS233JS';
    console.log(`
${courseCode} AI Grader v1.0

USAGE
  node bin/grade.js [labName] [stepName] [options]

  If no arguments are given, an interactive menu is shown.
  For multi-step labs, stepName selects which submission set to grade.

ARGUMENTS
  labName          Name of the lab directory (e.g. Lab03, TermProject)
  stepName         Step within a multi-step lab (e.g. ApiDoc, TermProjectProposal)

OPTIONS
  --regrade        Re-run all grading phases (runtime check, analysis, lint,
                   grade generation) but keep existing extracted/cloned code.
                   Use this after fixing grading scripts or config.

  --reclone        Delete all extracted_code and repo directories, re-clone/unzip
                   from scratch, then run full grading. Use this if student
                   repos have been updated.

  --ai-comments    Generate AI summary sentences for each student's rubric
                   summary cell using a local Ollama model. Falls back to
                   default text if Ollama is not running. Auto-selects the
                   first available model unless --ai-model is specified.

  --ai-model=NAME  Specify which Ollama model to use for AI summaries.
                   Implies --ai-comments. Example: --ai-model=qwen3-coder

	  --text-report    Generate .txt grade reports instead of spreadsheets.
	                   Use when a rubric spreadsheet is not yet available.

  --help, -h       Show this help message.

EXAMPLES
  node bin/grade.js                              Interactive mode
  node bin/grade.js Lab03                        First-time grading
  node bin/grade.js Lab03 --regrade              Re-grade without re-cloning
  node bin/grade.js Lab03 --reclone              Fresh clone + full grade
  node bin/grade.js Lab03 --ai-comments          Grade with AI summaries (auto model)
  node bin/grade.js Lab03 --ai-model=qwen3-coder Grade with a specific model
  node bin/grade.js TermProject ApiDoc           Grade one step of a multi-step lab
`);
}

const MOODLE_DIR_PATTERN = /^.*_\d+_assignsubmission_(file|onlinetext)$/;

function hasMoodleSubmissions(dir) {
    try {
        return fs.readdirSync(dir).some(
            f => MOODLE_DIR_PATTERN.test(f) && fs.statSync(path.join(dir, f)).isDirectory()
        );
    } catch (e) { return false; }
}

// --- Config validation ---
// VALID_RUNTIME_MODES is imported from runtime_check.js, where it's populated by
// registerCheckStrategy() calls at module load — new strategies (e.g. run_check) are
// automatically accepted here without editing this file.

// Validate that a cell reference looks like "A1" or "AA23"
function isValidCellRef(ref) {
    return typeof ref === 'string' && /^[A-Z]+\d+$/.test(ref);
}

// Loads config.handlerModules (paths to JS modules that call registerHandler() as a
// side effect on import, relative to the lab's config dir) BEFORE validateConfig() runs
// — a mapping type registered by one of these modules must be recognized as valid before
// validation checks every mapping's "type" against VALID_MAPPING_TYPES. Mirrors the
// custom-analyzer loading pattern in analyze_code.js: a failing module is logged and
// skipped, never a hard crash.
async function loadHandlerModules(config, labConfigDir) {
    if (!Array.isArray(config.handlerModules)) return;
    for (const rel of config.handlerModules) {
        const modulePath = path.resolve(labConfigDir, rel);
        if (!fs.existsSync(modulePath)) {
            console.warn(`  WARNING: handlerModules entry not found: ${modulePath}`);
            continue;
        }
        try {
            await import(pathToFileURL(modulePath).href);
            console.log(`  Loaded handler module: ${rel}`);
        } catch (e) {
            console.warn(`  WARNING: Failed to load handler module "${rel}": ${e.message}`);
        }
    }
}

function validateConfig(config, labName) {
    const errors = [];

    // Extract-only configs need no rubric, runtimeCheck, or mappings
    if (config.extractOnly === true) {
        return;
    }

    if (!config.rubricName || typeof config.rubricName !== 'string') {
        errors.push(`Missing or invalid "rubricName" (must be a string)`);
    }

    if (!config.runtimeCheck) {
        errors.push(`Missing "runtimeCheck" (must be "${[...VALID_RUNTIME_MODES].join('" or "')}")`);
    } else if (!VALID_RUNTIME_MODES.has(config.runtimeCheck)) {
        errors.push(`Invalid runtimeCheck "${config.runtimeCheck}" (must be one of: ${[...VALID_RUNTIME_MODES].join(', ')})`);
    }

    if (!Array.isArray(config.mappings) || config.mappings.length === 0) {
        errors.push(`Missing or empty "mappings" array`);
    } else {
        config.mappings.forEach((map, i) => {
            const prefix = `mappings[${i}]`;
            if (!map.type) {
                errors.push(`${prefix}: missing "type"`);
            } else if (!VALID_MAPPING_TYPES.has(map.type)) {
                errors.push(`${prefix}: unknown type "${map.type}"`);
            }
            if (map.cell && !isValidCellRef(map.cell)) {
                errors.push(`${prefix}.cell: "${map.cell}" is not a valid cell reference`);
            }
            if (map.commentCell && !isValidCellRef(map.commentCell)) {
                errors.push(`${prefix}.commentCell: "${map.commentCell}" is not a valid cell reference`);
            }
        });
    }

    if (config.analysis && config.analysis.customAnalyzer && typeof config.analysis.customAnalyzer !== 'string') {
        errors.push(`"analysis.customAnalyzer" must be a string (file path relative to configs/)`);
    }

    if (config.analysis && Array.isArray(config.analysis.features)) {
        config.analysis.features.forEach((feat, i) => {
            const prefix = `analysis.features[${i}]`;
            if (!feat.id) errors.push(`${prefix}: missing "id"`);
            // A feature needs either a single "regex" (counted) or a nested "match"
            // tree of allOf/anyOf/regex (boolean) — see analyze_code.js evalMatchNode.
            if (!feat.regex && !feat.match) errors.push(`${prefix}: needs "regex" or "match"`);
        });
    }

    if (config.repoHygiene) {
        if (!config.repoHygiene.excludedFromRepo || !Array.isArray(config.repoHygiene.excludedFromRepo)) {
            errors.push(`"repoHygiene.excludedFromRepo" must be an array of directory names`);
        }
    }

    if (config.packageCheck) {
        const KNOWN_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
        for (const [section, packages] of Object.entries(config.packageCheck)) {
            if (!KNOWN_SECTIONS.includes(section)) {
                errors.push(`packageCheck: unknown section "${section}" (expected: ${KNOWN_SECTIONS.join(', ')})`);
            } else if (!Array.isArray(packages)) {
                errors.push(`packageCheck.${section} must be an array of package names`);
            }
        }
    }

    if (config.codeReview) {
        if (config.codeReview.studentNameCell && !isValidCellRef(config.codeReview.studentNameCell)) {
            errors.push(`codeReview.studentNameCell: "${config.codeReview.studentNameCell}" is not a valid cell reference`);
        }
        if (config.codeReview.groupCell && !isValidCellRef(config.codeReview.groupCell)) {
            errors.push(`codeReview.groupCell: "${config.codeReview.groupCell}" is not a valid cell reference`);
        }
        if (config.codeReview.manualFallback && !['maxScore', 'zero', 'skip'].includes(config.codeReview.manualFallback)) {
            errors.push(`codeReview.manualFallback: "${config.codeReview.manualFallback}" must be one of: maxScore, zero, skip`);
        }
    }

    if (config.parts) {
        if (!Array.isArray(config.parts)) {
            errors.push(`"parts" must be an array`);
        } else {
            config.parts.forEach((part, i) => {
                const prefix = `parts[${i}]`;
                if (!part.id) errors.push(`${prefix}: missing "id"`);
            });
        }
    }

    if (errors.length > 0) {
        console.error(`\nERROR: Config validation failed for ${labName}:`);
        errors.forEach(e => console.error(`  - ${e}`));
        console.error();
        process.exit(1);
    }
}

// --- Helpers ---

const localConfigPath = path.join(REPO_ROOT, 'configs', 'local-config.json');

function readLocalConfig() {
    try {
        return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
    } catch (e) {}
    // Fall back to default-config.json (shipped with the repo) as a starting point
    try {
        return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'default-config.json'), 'utf8'));
    } catch (e) {}
    return {};
}

function saveLocalConfig(cfg) {
    fs.writeFileSync(localConfigPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        process.exit(0);
    }

    const positional = args.filter(a => !a.startsWith('--'));
    const hasRegradeFlag = args.includes('--regrade');
    const hasRecloneFlag = args.includes('--reclone');
    const aiModelFlag = (args.find(a => a.startsWith('--ai-model=')) || '').split('=')[1] || null;
    const aiComments = args.includes('--ai-comments') || !!aiModelFlag;
    let textReport = args.includes('--text-report');
    const hasAnyFlag = hasRegradeFlag || hasRecloneFlag;

    let labName = positional[0];
    let stepName = null;     // set for multi-step labs (e.g. node bin/grade.js TermProject ApiDoc)
    let reclone = hasRecloneFlag;
    let regrade = hasRegradeFlag || hasRecloneFlag;
    let config, labDir, labConfigDir, artifactsDir, submissionsDir;
    let skipRubric = false;

    let completions = [];
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        completer: line => {
            const hits = completions.filter(c => c.toLowerCase().startsWith(line.toLowerCase()));
            return [hits, line];
        }
    });
    const askRl = q => new Promise(resolve => rl.question(q, resolve));

    try {
        const localConfig = readLocalConfig();
        let labRoot = localConfig.labRoot || '';
        let codeRoot = localConfig.codeRoot || '';
        let configChanged = false;

        if (!labRoot || !fs.existsSync(labRoot)) {
            const input = await askRl(
                'Lab root - path to the folder containing the students submissions\n' +
                '  (e.g. /Volumes/GoogleDrive/StudentLabWork): '
            );
            if (!input.trim()) {
                console.error('ERROR: A lab root path is required.');
                process.exit(1);
            }
            labRoot = input.trim();
            configChanged = true;
        }

        if (!codeRoot) {
            const input = await askRl(
                'Code storage root — path to a LOCAL folder (outside Google Drive) where student\n' +
                '  code will be cloned or unzipped. A subfolder per lab is created automatically\n' +
                '  (e.g. /Users/brian/GradingCode): '
            );
            if (!input.trim()) {
                console.error('ERROR: A code storage root path is required.');
                process.exit(1);
            }
            codeRoot = input.trim();
            configChanged = true;
        }

        if (configChanged) {
            saveLocalConfig({ labRoot, codeRoot });
            console.log(`  Saved lab root and code storage root to local-config.json`);
        }

        const configsDir = path.join(REPO_ROOT, 'configs');
        const labs = fs.readdirSync(configsDir)
            .filter(f => {
                const subdir = path.join(configsDir, f);
                try { return fs.statSync(subdir).isDirectory(); } catch (e) { return false; }
            })
            .filter(name =>
                // flat lab: top-level config exists
                fs.existsSync(path.join(configsDir, name, `${name.toLowerCase()}_config.json`)) ||
                // multi-step lab: at least one step subdir has its own config
                getExistingSteps(name).length > 0
            )
            .map(name => {
                // Restore original casing from labRoot if the directory exists
                const match = fs.existsSync(labRoot)
                    ? fs.readdirSync(labRoot).find(d => d.toLowerCase() === name.toLowerCase())
                    : null;
                return match || name;
            })
            .sort();

        if (!labName) {
            const courseCode = localConfig.courseCode || 'CS233JS';
            const title = `${courseCode} AI Grader v1.0`;
            const boxWidth = Math.max(36, title.length + 6);
            const pad = boxWidth - 2 - title.length;
            const leftPad = Math.floor(pad / 2), rightPad = pad - leftPad;
            console.log(`\n╔${'═'.repeat(boxWidth - 2)}╗`);
            console.log(`║${' '.repeat(leftPad)}${title}${' '.repeat(rightPad)}║`);
            console.log(`╚${'═'.repeat(boxWidth - 2)}╝`);
            console.log('  (Run with --help to see all command-line options)\n');

            console.log('Available assignments:');
            labs.forEach((lab, i) => console.log(`  ${i + 1}) ${lab}`));
            console.log();

            completions = labs;
            while (!labName) {
                const input = await askRl('Select an assignment (number or name): ');
                const num = parseInt(input);
                if (!isNaN(num) && num >= 1 && num <= labs.length) {
                    labName = labs[num - 1];
                } else if (labs.find(l => l.toLowerCase() === input.trim().toLowerCase())) {
                    labName = labs.find(l => l.toLowerCase() === input.trim().toLowerCase());
                } else {
                    console.log('  Invalid selection, try again.');
                }
            }
            completions = [];
        }

        // Multi-step lab: detect available steps and resolve which one to grade
        {
            const existingSteps = getExistingSteps(labName);
            if (existingSteps.length > 0) {
                const stepArg = positional[1]; // e.g. node bin/grade.js TermProject ApiDoc
                if (stepArg) {
                    const match = existingSteps.find(s => s.toLowerCase() === stepArg.toLowerCase());
                    if (!match) {
                        console.error(`ERROR: Step "${stepArg}" not found in ${labName}.`);
                        console.error(`  Available steps: ${existingSteps.join(', ')}`);
                        process.exit(1);
                    }
                    stepName = match;
                } else {
                    console.log(`\n${labName} has multiple submission steps:`);
                    existingSteps.forEach((s, i) => console.log(`  ${i + 1}) ${s}`));
                    console.log();
                    completions = existingSteps;
                    while (!stepName) {
                        const input = await askRl('Select a step (number or name): ');
                        const num = parseInt(input);
                        if (!isNaN(num) && num >= 1 && num <= existingSteps.length) {
                            stepName = existingSteps[num - 1];
                        } else if (existingSteps.find(s => s.toLowerCase() === input.trim().toLowerCase())) {
                            stepName = existingSteps.find(s => s.toLowerCase() === input.trim().toLowerCase());
                        } else {
                            console.log('  Invalid selection, try again.');
                        }
                    }
                    completions = [];
                }
                console.log(`  Step: ${stepName}\n`);
            }
        }

        labConfigDir = stepName
            ? path.join(REPO_ROOT, 'configs', labName, stepName)
            : path.join(REPO_ROOT, 'configs', labName);
        const configPath = path.join(labConfigDir, `${path.basename(labConfigDir).toLowerCase()}_config.json`);
        if (!fs.existsSync(configPath)) {
            console.error(`ERROR: Config file not found at ${configPath}`);
            process.exit(1);
        }
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (e) {
            console.error(`ERROR: Could not parse config file ${configPath}: ${e.message}`);
            process.exit(1);
        }
        // toolchains (compiler/SDK paths not on the default PATH) are machine-specific, so
        // they live in local-config.json; a lab config may override individual entries.
        if (localConfig.toolchains) {
            config.toolchains = { ...localConfig.toolchains, ...(config.toolchains || {}) };
        }
        await loadHandlerModules(config, labConfigDir);
        validateConfig(config, labName);

        labDir = path.join(labRoot, labName);
        if (!fs.existsSync(labDir)) {
            // Common mistake: user entered the lab subdirectory as labRoot instead of its parent
            if (path.basename(labRoot).toLowerCase() === labName.toLowerCase()) {
                const correctedRoot = path.dirname(labRoot);
                console.log(`\nIt looks like your lab root points to the ${labName} folder itself.`);
                console.log(`  Entered:   ${labRoot}`);
                console.log(`  Should be: ${correctedRoot}`);
                const confirm = await askRl('Use the parent folder and update your saved settings? (y/n): ');
                if (confirm.trim().toLowerCase() === 'y') {
                    labRoot = correctedRoot;
                    labDir = path.join(labRoot, labName);
                    saveLocalConfig({ labRoot, codeRoot });
                    console.log('  Updated lab root saved to local-config.json\n');
                } else {
                    console.error('Aborted. Re-run and enter the correct lab root path.');
                    process.exit(1);
                }
            } else {
                // labRoot exists (verified at startup) but has no subfolder for this lab.
                // Distinguish "submissions not downloaded yet" from "labRoot misconfigured":
                // if labRoot already holds other lab folders, the root is clearly correct and
                // the likely cause is that this lab's Moodle submissions haven't been downloaded.
                let siblings = [];
                try {
                    siblings = fs.readdirSync(labRoot)
                        .filter(d => {
                            try { return fs.statSync(path.join(labRoot, d)).isDirectory(); }
                            catch (e) { return false; }
                        })
                        .sort();
                } catch (e) { /* labRoot unreadable — fall through to the generic hint */ }

                console.error(`\nERROR: No submissions folder found for ${labName} at:`);
                console.error(`  ${labDir}`);
                if (siblings.length > 0) {
                    console.error(`\n  Your lab root looks correct — it already contains: ${siblings.join(', ')}`);
                    console.error(`  It just has no ${labName} folder yet. Have you downloaded the ${labName}`);
                    console.error(`  submissions from Moodle into <labRoot>/${labName}/ ?`);
                } else {
                    console.error(`  Make sure your lab root (${labRoot}) is the folder that contains the ${labName} subdirectory.`);
                }
                process.exit(1);
            }
        }

        // For multi-step labs: descend into the step subdir within labRoot/labName.
        // Case-insensitively resolve the step folder name in case labRoot casing differs.
        // If the step subdir doesn't exist in labRoot, fall back to the lab root itself —
        // Moodle downloads don't need to mirror the configs step layout.
        if (stepName) {
            let stepDirName = stepName;
            try {
                const m = fs.readdirSync(labDir).find(d => d.toLowerCase() === stepName.toLowerCase());
                if (m) stepDirName = m;
            } catch (e) { /* use stepName as-is */ }
            const stepPath = path.join(labDir, stepDirName);
            if (fs.existsSync(stepPath)) {
                labDir = stepPath;
            } else {
                console.log(`  Note: no "${stepName}" subfolder found in labRoot — using submissions from ${labDir}\n`);
            }
        }

        // If labDir has no direct Moodle submissions but contains subdirectories that do
        // (e.g. Moodle exported Lab05-Beta and Lab05-Production as separate groups),
        // ask the user which group to grade.
        if (!hasMoodleSubmissions(labDir)) {
            const subdirs = fs.readdirSync(labDir).filter(f => {
                const fp = path.join(labDir, f);
                try { return fs.statSync(fp).isDirectory() && hasMoodleSubmissions(fp); } catch (e) { return false; }
            });
            if (subdirs.length > 0) {
                console.log(`\nNo submissions found directly in ${labName}/. Found these submission groups:`);
                subdirs.forEach((d, i) => console.log(`  ${i + 1}) ${d}`));
                console.log();
                let chosen = false;
                while (!chosen) {
                    const input = await askRl(`Select which group to grade (number) [${subdirs.length}]: `);
                    const trimmed = input.trim();
                    if (trimmed === '') {
                        labDir = path.join(labDir, subdirs[subdirs.length - 1]);
                        chosen = true;
                    } else {
                        const num = parseInt(trimmed);
                        if (!isNaN(num) && num >= 1 && num <= subdirs.length) {
                            labDir = path.join(labDir, subdirs[num - 1]);
                            chosen = true;
                        } else {
                            console.log('  Invalid selection, try again.');
                        }
                    }
                }
                console.log(`  Using: ${labDir}\n`);
                // If this is a multi-step lab and the chosen folder doesn't match the step
                // name, the only reason we had to ask is the folder naming. Point the fix out.
                if (stepName) {
                    const chosenName = path.basename(labDir);
                    if (chosenName.toLowerCase() !== stepName.toLowerCase()) {
                        console.log(`  Tip: rename "${chosenName}" to "${stepName}" under your lab root to skip this prompt next time.\n`);
                    }
                }
            }
        }

        // Per-lab (or per-step) paths under codeRoot.
        // For multi-step labs the layout is codeRoot/{labName}/{stepName}/Artifacts...
        const labSubPath = stepName ? path.join(labName, stepName) : labName;
        artifactsDir = path.join(codeRoot, labSubPath, ARTIFACTS_DIR);
        submissionsDir = path.join(codeRoot, labSubPath, SUBMISSIONS_DIR);

        // Validate codeRoot is writable before proceeding — ask for a new one if not
        let codeRootConfirmed = false;
        while (!codeRootConfirmed) {
            try {
                fs.mkdirSync(artifactsDir, { recursive: true });
                fs.mkdirSync(submissionsDir, { recursive: true });
                codeRootConfirmed = true;
            } catch (e) {
                console.error(`\nERROR: Cannot write to code storage directory:`);
                console.error(`  ${path.join(codeRoot, labSubPath)}`);
                console.error(`  ${e.message}\n`);
                const newRoot = await askRl(
                    'Enter a writable path for storing cloned/extracted student code\n' +
                    '  (e.g. /Users/brian/GradingCode): '
                );
                if (!newRoot.trim()) {
                    console.error('ERROR: A code storage root path is required.');
                    process.exit(1);
                }
                codeRoot = newRoot.trim();
                configChanged = true;
                artifactsDir = path.join(codeRoot, labSubPath, ARTIFACTS_DIR);
                submissionsDir = path.join(codeRoot, labSubPath, SUBMISSIONS_DIR);
            }
        }
        if (configChanged) {
            saveLocalConfig({ labRoot, codeRoot });
            console.log(`  Saved updated codeRoot to local-config.json\n`);
        }

        // Validate rubric exists before starting the pipeline (skip for extract-only)
        while (!skipRubric && !config.extractOnly) {
            const rubricCheckPath = path.join(labConfigDir, config.rubricName);
            if (fs.existsSync(rubricCheckPath)) {
                break;
            } else if (textReport) {
                console.log(`  Rubric not found, but --text-report is set. Will generate .txt reports.\n`);
                skipRubric = true;
                break;
            } else {
                console.log(`\nRubric file not found at expected path:`);
                console.log(`  ${rubricCheckPath}\n`);
                const provideRubric = await askRl('Would you like to provide a rubric spreadsheet? (y/n): ');
                if (provideRubric.trim().toLowerCase() !== 'y' && provideRubric.trim().toLowerCase() !== 'yes') {
                    console.log('  Continuing without rubric — will generate .txt grade reports.\n');
                    skipRubric = true;
                    textReport = true;
                    break;
                }
                const newName = await askRl(
                    'Enter the rubric filename\n' +
                    `  (e.g. CS233JS_${labName}_Rubric.xlsm): `
                );
                if (!newName.trim()) {
                    console.log('  No filename entered — will generate .txt grade reports.\n');
                    skipRubric = true;
                    textReport = true;
                    break;
                }
                config.rubricName = newName.trim();
                // Persist to config file on disk
                const cfgOnDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                cfgOnDisk.rubricName = config.rubricName;
                fs.writeFileSync(configPath, JSON.stringify(cfgOnDisk, null, 2) + '\n', 'utf8');
                console.log(`  Updated rubricName in ${labName.toLowerCase()}_config.json\n`);
            }
        }

        if (!hasAnyFlag) {
            if (config.extractOnly) {
                console.log('\nExtract options:');
                console.log('  1) Normal     — extract new submissions (skip already-cloned)');
                console.log('  2) Re-extract — keep existing code, run git pull on repos');
                console.log('  3) Reclone    — delete all extracted code, re-clone/unzip from scratch');
            } else {
                console.log('\nGrading options:');
                console.log('  1) Normal   — grade new submissions (skip already-extracted)');
                console.log('  2) Regrade  — re-run grading but keep existing cloned code');
                console.log('  3) Reclone  — delete all extracted code, re-clone/unzip, and re-grade');
            }
            console.log();
            const modeInput = await askRl('Select option [1]: ');
            const choice = modeInput.trim();
            if (choice === '2') {
                regrade = true;
            } else if (choice === '3') {
                reclone = true;
                regrade = true;
            }
        }
    } finally {
        rl.close();
    }

    const modeLabel = config.extractOnly
        ? (reclone ? 'RECLONE' : (regrade ? 'REEXTRACT' : 'EXTRACT'))
        : (reclone ? 'RECLONE' : (regrade ? 'REGRADE' : 'NORMAL'));
    const aiLabel = aiComments ? ' +AI' : '';
    const txtLabel = textReport ? ' +TXT' : '';
    console.log(`\n================================`);
    console.log(`   Grading: ${labName}  [${modeLabel}${aiLabel}${txtLabel}]`);
    console.log(`================================\n`);

    if (reclone) {
        console.log('--- Clearing previous code ---');

        if (fs.existsSync(submissionsDir)) {
            const entries = fs.readdirSync(submissionsDir);
            for (const entry of entries) {
                for (const dir of [CODE_DIR, REPO_DIR]) {
                    const codeDir = path.join(submissionsDir, entry, dir);
                    if (fs.existsSync(codeDir)) {
                        fs.rmSync(codeDir, { recursive: true, force: true });
                        console.log(`  Cleared: ${entry}/${dir}`);
                    }
                }
            }
        }

        console.log();
    }

    if (regrade && !reclone && fs.existsSync(submissionsDir)) {
        console.log('--- Pulling latest code from repositories ---');
        const entries = fs.readdirSync(submissionsDir);
        for (const entry of entries) {
            const repoDir = path.join(submissionsDir, entry, REPO_DIR);
            if (!fs.existsSync(repoDir)) continue;
            const result = spawnSync('git', ['pull'], { cwd: repoDir, encoding: 'utf8' });
            if (result.status === 0) {
                const summary = (result.stdout || '').trim().split('\n').pop();
                console.log(`  ${entry}: ${summary}`);
            } else {
                console.log(`  ${entry}: pull failed — ${(result.stderr || result.stdout || '').trim()}`);
            }
        }
        console.log();
    }

    // 1. Code Acquisition
    const students = await extractCode(labDir, submissionsDir, config);

    // In extract-only mode, skip all checking and grade-generation phases
    if (config.extractOnly) {
        const extracted = students.filter(s => s.extractedDir);
        console.log(`  Extract-only mode: ${extracted.length} repo(s) extracted. No grading.\n`);

        console.log("--- Creating Log Summary ---");
        const logLines = [];
        logLines.push(`Extraction Summary for ${labName} [${modeLabel}]`);
        logLines.push(`Date: ${new Date().toISOString()}`);
        logLines.push(`===================================`);
        logLines.push(`\nExtracted (${extracted.length}):`);
        extracted.forEach(s => logLines.push(` - ${s.name}`));
        const extractErrors = students.filter(s => s.error);
        logLines.push(`\nIssues Encountered (${extractErrors.length}):`);
        if (extractErrors.length === 0) {
            logLines.push(" None! Great job.");
        } else {
            extractErrors.forEach(e => logLines.push(` - ${e.name}: ${e.error}`));
        }
        const logPath = path.join(artifactsDir, LOG_FILE);
        fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');
        console.log(`\nAll Done! Summary written to ${logPath}\n`);
        return;
    }

    // Runtime check, code review, analysis, lint, markup validation, name check, grade
    // generation, and the log summary are all orchestrated by run_pipeline.js.
    await runPipeline(
        students,
        config,
        { artifactsDir, labConfigDir },
        { regrade, skipRubric, textReport, aiComments, aiModelFlag, labName, modeLabel }
    );
}

main().catch(err => {
    console.error("Fatal error during grading:", err);
});
