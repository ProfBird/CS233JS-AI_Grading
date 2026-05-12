/**
 * run_all.js
 *
 * Master orchestrator script for CS233JS lab grading.
 * Each pipeline phase attaches results directly to student objects.
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
const { spawnSync } = require('child_process');
const extractCode = require('./extract_code.js');
const analyzeCode = require('./analyze_code.js');
const lintCode = require('./lint_code.js');
const runtimeCheck = require('./runtime_check.js');
const generateGrades = require('./generate_grades.js');

const { VALID_MAPPING_TYPES } = generateGrades;
const { CODE_DIR, REPO_DIR } = extractCode;

const ARTIFACTS_DIR = 'ArtifactsAndRubrics';
const SUBMISSIONS_DIR = 'SubmissionsAndAssessment';
const LOG_FILE = 'grading_log.txt';

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

  --reclone        Delete all extracted_code and repo directories, re-clone/unzip
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

// --- Config validation ---

const VALID_RUNTIME_MODES = new Set(['browser', 'build']);

// Validate that a cell reference looks like "A1" or "AA23"
function isValidCellRef(ref) {
    return typeof ref === 'string' && /^[A-Z]+\d+$/.test(ref);
}

function validateConfig(config, labName) {
    const errors = [];

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
            if (!feat.regex) errors.push(`${prefix}: missing "regex"`);
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

    if (config.parts) {
        if (!Array.isArray(config.parts)) {
            errors.push(`"parts" must be an array`);
        } else {
            config.parts.forEach((part, i) => {
                const prefix = `parts[${i}]`;
                if (!part.id) errors.push(`${prefix}: missing "id"`);
                if (part.rubricTitleRow == null) errors.push(`${prefix}: missing "rubricTitleRow"`);
                if (!part.folderPattern) errors.push(`${prefix}: missing "folderPattern"`);
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

const localConfigPath = path.join(__dirname, 'configs', 'local-config.json');

function readLocalConfig() {
    try {
        return JSON.parse(fs.readFileSync(localConfigPath, 'utf8'));
    } catch (e) {}
    // Fall back to default-config.json (shipped with the repo) as a starting point
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'default-config.json'), 'utf8'));
    } catch (e) {}
    // Migrate from old env.json
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'env.json'), 'utf8'));
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
    const hasAnyFlag = hasRegradeFlag || hasRecloneFlag;

    let labName = positional[0];
    let reclone = hasRecloneFlag;
    let regrade = hasRegradeFlag || hasRecloneFlag;
    let config, labDir, labConfigDir, artifactsDir, submissionsDir;
    let skipRubric = false;

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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

        const configsDir = path.join(__dirname, 'configs');
        const labs = fs.readdirSync(configsDir)
            .filter(f => {
                const subdir = path.join(configsDir, f);
                try { return fs.statSync(subdir).isDirectory(); } catch (e) { return false; }
            })
            .filter(name => fs.existsSync(path.join(configsDir, name, `${name.toLowerCase()}_config.json`)))
            .map(name => {
                // Restore original casing from labRoot if the directory exists
                const match = fs.existsSync(labRoot)
                    ? fs.readdirSync(labRoot).find(d => d.toLowerCase() === name.toLowerCase())
                    : null;
                return match || name;
            })
            .sort();

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

        labConfigDir = path.join(__dirname, 'configs', labName);
        const configPath = path.join(labConfigDir, `${labName.toLowerCase()}_config.json`);
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
                console.error(`ERROR: Directory not found at ${labDir}`);
                console.error(`  Make sure your lab root (${labRoot}) is the folder that contains the ${labName} subdirectory.`);
                process.exit(1);
            }
        }

        // Per-lab paths under codeRoot
        artifactsDir = path.join(codeRoot, labName, ARTIFACTS_DIR);
        submissionsDir = path.join(codeRoot, labName, SUBMISSIONS_DIR);

        // Validate codeRoot is writable before proceeding — ask for a new one if not
        let codeRootConfirmed = false;
        while (!codeRootConfirmed) {
            try {
                fs.mkdirSync(artifactsDir, { recursive: true });
                fs.mkdirSync(submissionsDir, { recursive: true });
                codeRootConfirmed = true;
            } catch (e) {
                console.error(`\nERROR: Cannot write to code storage directory:`);
                console.error(`  ${path.join(codeRoot, labName)}`);
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
                artifactsDir = path.join(codeRoot, labName, ARTIFACTS_DIR);
                submissionsDir = path.join(codeRoot, labName, SUBMISSIONS_DIR);
            }
        }
        if (configChanged) {
            saveLocalConfig({ labRoot, codeRoot });
            console.log(`  Saved updated codeRoot to local-config.json\n`);
        }

        // Validate rubric exists before starting the pipeline
        while (!skipRubric) {
            const rubricCheckPath = path.join(labConfigDir, config.rubricName);
            if (fs.existsSync(rubricCheckPath)) {
                break;
            } else {
                console.error(`\nERROR: Rubric file not found at expected path:`);
                console.error(`  ${rubricCheckPath}`);
                console.error(`  (Copy the rubric template into configs/${labName}/ or check the filename.)\n`);
                const newName = await askRl(
                    'Enter the correct rubric filename\n' +
                    '  (e.g. CS233JS_Lab04_Rubric.xlsm, or type "skip" to continue anyway): '
                );
                if (!newName.trim() || newName.trim().toLowerCase() === 'skip') {
                    console.log('  Continuing without rubric — grade generation will be skipped.\n');
                    skipRubric = true;
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

    const modeLabel = reclone ? 'RECLONE' : (regrade ? 'REGRADE' : 'NORMAL');
    const aiLabel = aiComments ? ' +AI' : '';
    console.log(`\n================================`);
    console.log(`   Grading: ${labName}  [${modeLabel}${aiLabel}]`);
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
    const students = await extractCode(labDir, submissionsDir);

    // In normal mode, skip students whose grade spreadsheet already exists
    let toGrade = students;
    if (!regrade) {
        const outputExt = config.rubricName.endsWith('.xlsm') ? '.xlsm' : '.xlsx';
        const alreadyDone = [];
        toGrade = students.filter(s => {
            if (!s.gradeDir) return true;
            const gradePath = path.join(s.gradeDir, `${s.name}_Grade${outputExt}`);
            if (fs.existsSync(gradePath)) { alreadyDone.push(s.name); return false; }
            return true;
        });
        if (alreadyDone.length > 0) {
            console.log(`  Skipping ${alreadyDone.length} already-graded: ${alreadyDone.join(', ')}\n`);
        }
    }

    // 2. Runtime Check — attaches to student.runtimeCheck
    await runtimeCheck(toGrade, config, artifactsDir);

    // 3. Analysis — attaches to student.analysis
    analyzeCode(toGrade, config, artifactsDir, labConfigDir);

    // 4. Linting — attaches to student.lint
    await lintCode(toGrade, config, artifactsDir);

    // 5. Generation — reads from student objects
    let generateSummary;
    if (!skipRubric) {
        generateSummary = await generateGrades(toGrade, config, artifactsDir, { aiComments, aiModel: aiModelFlag, rubricDir: labConfigDir });
    } else {
        generateSummary = { successful: [], errors: [] };
        console.log("--- Grade Generation Phase (skipped) ---\n");
    }

    // 6. Log Summary
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
        if (student.analysis && student.analysis.error) {
            errors.push({ student: student.name, issue: `Analysis: ${student.analysis.error}` });
        }
        if (student.runtimeCheck && !student.runtimeCheck.success && student.runtimeCheck.errors && student.runtimeCheck.errors.length > 0) {
            errors.push({ student: student.name, issue: `Runtime: ${student.runtimeCheck.errors.join(', ')}` });
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

    const logPath = path.join(artifactsDir, LOG_FILE);
    fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');

    console.log(`\nAll Done! Summary written to ${logPath}\n`);
}

main().catch(err => {
    console.error("Fatal error during grading:", err);
});
