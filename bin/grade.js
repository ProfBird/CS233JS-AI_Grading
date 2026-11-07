#!/usr/bin/env node
/**
 * grade.js
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
import { pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import extractCode, { CODE_DIR, REPO_DIR } from '../src/pipeline/extract_code.js';
import importFromCanvas from '../src/pipeline/extract_code_canvas.js';
import { runPipeline, configLocationLines } from '../src/pipeline/run_pipeline.js';
import { resolveGradeSetup, SetupError } from '../src/lib/grade_setup.js';
import { createDriver } from '../src/lib/prompt_driver.js';
import { setRecentPathsFile } from '../src/lib/path_browser.js';

const LOG_FILE = 'grading_log.txt';

// --- Help ---

function showHelp() {
    console.log(`
AI Grader v1.0

USAGE
  node bin/grade.js [courseName] [labName] [stepName] [options]

  If no arguments are given, an interactive menu is shown: it always asks you
  to pick a course, then a term (e.g. "Spring 2026"), even when there's only
  one of each — with "Add new course"/"Add new term" options (also offered
  automatically the very first time, when none exist yet). After the term it
  asks where submissions come from: the assignment's configured source
  (Moodle folder, or Canvas if already set up), or "Download from Canvas"
  (same as the --canvas flag). Shortcuts like "node bin/grade.js Lab03" skip
  these prompts and auto-resolve the single course/term, so existing
  muscle-memory usage keeps working unchanged.
  courseName is only needed as an argument once more than one course exists.
  For multi-step labs, stepName selects which submission set to grade.

ARGUMENTS
  courseName       Course directory under configs/ (e.g. CS233JS) — only
                   needed when more than one course exists
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

  --canvas         Import submissions directly from Canvas instead of a Moodle
                   download folder. First use prompts for a Canvas course ID,
                   confirms the course name before continuing, then lets you
                   pick the assignment; the choice is saved to the lab's config
                   file so later runs (even without --canvas) use Canvas again.
                   The interactive menu offers the same thing as a "Download
                   from Canvas" submission-source option after the term prompt.

  --help, -h       Show this help message.

EXAMPLES
  node bin/grade.js                              Interactive mode
  node bin/grade.js Lab03                        First-time grading
  node bin/grade.js Lab03 --regrade              Re-grade without re-cloning
  node bin/grade.js Lab03 --reclone              Fresh clone + full grade
  node bin/grade.js Lab03 --ai-comments          Grade with AI summaries (auto model)
  node bin/grade.js Lab03 --ai-model=qwen3-coder Grade with a specific model
  node bin/grade.js TermProject ApiDoc           Grade one step of a multi-step lab
  node bin/grade.js Lab03 --canvas               Import from Canvas instead of Moodle
  node bin/grade.js CS233JS Lab03                Explicit course (only needed with 2+ courses)
`);
}

// --- Main ---

async function main() {
    setRecentPathsFile(path.join(import.meta.dirname, '..', 'configs', 'local-config.json'));
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        process.exit(0);
    }

    const driver = await createDriver({ title: 'AI Grader v1.0' });
    let setup;
    try {
        setup = await resolveGradeSetup(driver, { argv: args });
    } finally {
        driver.close();
    }
    driver.takeNotes().forEach(l => process.stdout.write(l + '\n'));

    const {
        course, labName, stepName,
        config, labConfigDir, labDir,
        artifactsDir, submissionsDir,
        usingCanvas, courseId, assignmentId, canvasConfig,
        regrade, reclone, skipRubric, textReport, aiComments, aiModelFlag,
    } = setup;

    const modeLabel = config.extractOnly
        ? (reclone ? 'RECLONE' : (regrade ? 'REEXTRACT' : 'EXTRACT'))
        : (reclone ? 'RECLONE' : (regrade ? 'REGRADE' : 'NORMAL'));
    const aiLabel = aiComments ? ' +AI' : '';
    const txtLabel = textReport ? ' +TXT' : '';
    const canvasLabel = usingCanvas ? ' +CANVAS' : '';
    console.log(`\n================================`);
    console.log(`   Grading: ${course.courseName} / ${labName}${stepName ? '/' + stepName : ''}  [${modeLabel}${aiLabel}${txtLabel}${canvasLabel}]`);
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
    const students = usingCanvas
        ? await importFromCanvas({ courseId, assignmentId, submissionsDir, canvasConfig, urlPatterns: config.urlPatterns })
        : await extractCode(labDir, submissionsDir, config);

    // In extract-only mode, skip all checking and grade-generation phases
    if (config.extractOnly) {
        const extracted = students.filter(s => s.extractedDir);
        console.log(`  Extract-only mode: ${extracted.length} repo(s) extracted. No grading.\n`);

        console.log("--- Creating Log Summary ---");
        const logLines = [];
        logLines.push(`Extraction Summary for ${labName} [${modeLabel}]`);
        logLines.push(`Date: ${new Date().toISOString()}`);
        logLines.push(`===================================`);
        logLines.push(...configLocationLines(config, labConfigDir));
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
        { artifactsDir, labConfigDir, courseName: course.name },
        { regrade, skipRubric, textReport, aiComments, aiModelFlag, labName, stepName, modeLabel }
    );
}

export { main, showHelp };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => {
        if (err instanceof SetupError) {
            err.lines.forEach(l => process.stderr.write(l + '\n'));
        } else {
            process.stderr.write(`Fatal error during grading: ${err.stack || err.message}\n`);
        }
        process.exit(1);
    });
}
