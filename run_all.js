/**
 * run_all.js
 *
 * Master orchestrator script for CS233JS lab grading.
 *
 * Usage:
 *   node run_all.js                           -> interactive menu
 *   node run_all.js Lab03                     -> first-time grade (skips existing extractions)
 *   node run_all.js Lab03 --regrade           -> re-run analysis/lint/runtime/generation (keeps cloned code)
 *   node run_all.js Lab03 --reclone           -> delete extracted code, re-clone/unzip, and re-grade
 *   node run_all.js Lab03 --regrade --reclone -> same as --reclone (reclone implies regrade)
 *   node run_all.js --help                    -> show help
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const extractCode = require('./extract_code.js');
const analyzeCode = require('./analyze_code.js');
const lintCode = require('./lint_code.js');
const runtimeCheck = require('./runtime_check.js');
const generateGrades = require('./generate_grades.js');

const baseDir = path.resolve(__dirname, '..');

// --- Help ---

function showHelp() {
    console.log(`
CS233JS AI Grader v1.0

USAGE
  node run_all.js [labName] [options]

  If no arguments are given, an interactive menu is shown.

ARGUMENTS
  labName          Name of the lab directory (e.g. Lab03)

OPTIONS
  --regrade        Re-run all grading phases (runtime check, analysis, lint,
                   grade generation) but keep existing extracted/cloned code.
                   Use this after fixing grading scripts or config.

  --reclone        Delete all extracted_code directories and re-clone/unzip
                   from scratch, then run full grading. Use this if student
                   repos have been updated.

  --ai-comments    Generate AI summary sentences for each student's rubric
                   summary cell using a local Ollama model. Falls back to
                   default text if Ollama is not running. Auto-selects the
                   first available model unless --ai-model is specified.

  --ai-model=NAME  Specify which Ollama model to use for AI summaries.
                   Implies --ai-comments. Example: --ai-model=qwen3-coder

  --help, -h       Show this help message.

EXAMPLES
  node run_all.js                              Interactive mode
  node run_all.js Lab03                        First-time grading
  node run_all.js Lab03 --regrade              Re-grade without re-cloning
  node run_all.js Lab03 --reclone              Fresh clone + full grade
  node run_all.js Lab03 --ai-comments          Grade with AI summaries (auto model)
  node run_all.js Lab03 --ai-model=qwen3-coder Grade with a specific model
`);
}

// --- Helpers ---

function getAvailableLabs() {
    return fs.readdirSync(baseDir).filter(f => {
        const isDir = fs.statSync(path.join(baseDir, f)).isDirectory();
        const hasConfig = fs.existsSync(path.join(__dirname, 'configs', `${f.toLowerCase()}_config.json`));
        return isDir && hasConfig;
    });
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);

    // Handle --help
    if (args.includes('--help') || args.includes('-h')) {
        showHelp();
        process.exit(0);
    }

    const positional = args.filter(a => !a.startsWith('--'));
    const hasRegradeFlag = args.includes('--regrade');
    const hasRecloneFlag = args.includes('--reclone');
    const aiModelFlag = (args.find(a => a.startsWith('--ai-model=')) || '').split('=')[1] || null;
    const aiComments = args.includes('--ai-comments') || !!aiModelFlag;
    const hasAnyFlag = hasRegradeFlag || hasRecloneFlag;

    let labName = positional[0];
    let reclone = hasRecloneFlag;
    // regrade is true if --regrade OR --reclone is passed (reclone implies regrade)
    let regrade = hasRegradeFlag || hasRecloneFlag;

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askRl = q => new Promise(resolve => rl.question(q, resolve));

    try {
        const labs = getAvailableLabs();

        // If no lab name was provided, show the lab menu
        if (!labName) {
            console.log('\n╔══════════════════════════════════╗');
            console.log('║     CS233JS AI Grader v1.0       ║');
            console.log('╚══════════════════════════════════╝');
            console.log('  (Run with --help to see all command-line options)\n');

            console.log('Available labs:');
            labs.forEach((lab, i) => console.log(`  ${i + 1}) ${lab}`));
            console.log();

            while (!labName) {
                const input = await askRl('Select a lab (number or name): ');
                const num = parseInt(input);
                if (!isNaN(num) && num >= 1 && num <= labs.length) {
                    labName = labs[num - 1];
                } else if (labs.includes(input.trim())) {
                    labName = input.trim();
                } else {
                    console.log('  Invalid selection, try again.');
                }
            }
        }

        // If no flags were specified on the command line, ask
        if (!hasAnyFlag) {
            console.log('\nGrading options:');
            console.log('  1) Normal   — grade new submissions (skip already-extracted)');
            console.log('  2) Regrade  — re-run grading but keep existing cloned code');
            console.log('  3) Reclone  — delete all extracted code, re-clone/unzip, and re-grade');
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

    const labDir = path.join(baseDir, labName);
    const configPath = path.join(__dirname, 'configs', `${labName.toLowerCase()}_config.json`);

    if (!fs.existsSync(labDir)) {
        console.error(`ERROR: Directory not found at ${labDir}`);
        process.exit(1);
    }
    if (!fs.existsSync(configPath)) {
        console.error(`ERROR: Config file not found at ${configPath}`);
        process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const modeLabel = reclone ? 'RECLONE' : (regrade ? 'REGRADE' : 'NORMAL');
    const aiLabel = aiComments ? ' +AI' : '';
    console.log(`\n================================`);
    console.log(`   Grading: ${labName}  [${modeLabel}${aiLabel}]`);
    console.log(`================================\n`);

    // If recloning, delete all extracted_code directories
    if (reclone) {
        console.log('--- Clearing previous extractions ---');
        const entries = fs.readdirSync(labDir);
        for (const entry of entries) {
            const extractedDir = path.join(labDir, entry, 'extracted_code');
            if (fs.existsSync(extractedDir)) {
                fs.rmSync(extractedDir, { recursive: true, force: true });
                console.log(`  Cleared: ${entry}/extracted_code`);
            }
        }
        console.log();
    }

    // 1. Extraction (always runs — skips existing unless reclone cleared them)
    const students = extractCode(labDir);

    // 2. Runtime Check (browser or build, based on config)
    const runtimeReport = await runtimeCheck(students, config, labDir);

    // 3. Analysis
    const analysisReport = analyzeCode(students, config, labDir);

    // 4. Linting
    const lintReport = await lintCode(students, config, labDir);

    // 5. Generation
    const generateSummary = await generateGrades(analysisReport, lintReport, runtimeReport, config, labDir, { aiComments, aiModel: aiModelFlag });

    // 6. Log
    console.log("\n--- Creating Log Summary ---");
    const logLines = [];
    logLines.push(`Grading Summary for ${labName} [${modeLabel}]`);
    logLines.push(`Date: ${new Date().toISOString()}`);
    logLines.push(`===================================`);

    const errors = [];

    if (generateSummary && generateSummary.errors) {
        errors.push(...generateSummary.errors);
    }
    students.forEach(student => {
        if (student.error) {
            errors.push({ student: student.name, issue: `Extraction: ${student.error}` });
        }
    });
    analysisReport.forEach(report => {
        if (report.results.error) {
            errors.push({ student: report.student, issue: `Analysis: ${report.results.error}` });
        }
    });
    runtimeReport.forEach(report => {
        if (!report.success && report.errors && report.errors.length > 0) {
            errors.push({ student: report.student, issue: `Runtime: ${report.errors.join(', ')}` });
        }
    });

    const successfulStudents = generateSummary ? generateSummary.successful : [];
    logLines.push(`\nSuccessfully Graded (${successfulStudents.length}):`);
    successfulStudents.forEach(s => logLines.push(` - ${s}`));

    logLines.push(`\nIssues Encountered (${errors.length}):`);
    if (errors.length === 0) {
        logLines.push(" None! Great job.");
    } else {
        errors.forEach(e => logLines.push(` - ${e.student}: ${e.issue}`));
    }

    const logPath = path.join(labDir, 'grading_log.txt');
    fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');

    console.log(`\nAll Done! Summary written to ${logPath}\n`);
}

main().catch(err => {
    console.error("Fatal error during grading:", err);
});
