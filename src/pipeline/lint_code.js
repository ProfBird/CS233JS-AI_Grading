/**
 * lint_code.js
 *
 * Lints the extracted code, ignoring paths defined in the config.
 * Attaches results directly to each student object as student.lint.
 */

import fs from 'fs';
import path from 'path';
import { getAllFilesByExt } from '../lib/file_walker.js';
import { resolveAdapter } from '../adapters/index.js';
import { runPerStudentPhase, writePhaseReport } from '../lib/per_student_phase.js';

const LINT_REPORT = 'lint_report.json';

// Collects source files under dir for the given adapter's sourceExtensions. Exclusions
// are case-insensitive substring matches. Skips dot-dirs, node_modules/dist/build, and
// "__MACOSX"; does not descend into symlinks. Delegates to the shared collector so the
// skip list stays in one place.
function getAllJsFiles(dir, exclusions = [], adapter = resolveAdapter({})) {
    return getAllFilesByExt(dir, adapter.sourceExtensions, exclusions);
}

export default async function(students, config, labDir, labName, stepName, courseName, configsDirOverride) {
    const adapter = resolveAdapter(config);

    // labName/stepName come directly from the caller (bin/grade.js's resolved
    // assignment/step names, threaded through run_pipeline.js) instead of being
    // re-derived by climbing up from labDir — see refactoring_plan_2026-07-07.md
    // Priority 3: path-climbing baked in the codeRoot/Lab/Artifacts (flat) and
    // codeRoot/Lab/Step/Artifacts (multi-step) layout assumption, silently resolving
    // the wrong config directory if that layout ever changed. courseName (added for the
    // course tier) follows the same principle — passed in, not re-derived.
    const adapterLabName = stepName || labName;
    const adapterParentName = stepName ? labName : null;
    const labRoot = path.dirname(labDir);

    // Grader uses a config from inside this repo so that node_modules (globals, etc.) resolve correctly.
    // Priority: per-lab override in configs/{Course}/{Parent}/{Step}/ or configs/{Course}/{Lab}/ >
    // the shipped default.
    const repoRoot = path.join(import.meta.dirname, '..', '..');
    // configsDirOverride is test-only: it lets lint_code.spec.mjs point config-file
    // resolution at a scratch directory instead of writing/cleaning up scratch subfolders
    // inside the real repo configs/ tree (a killed test run used to leave those behind,
    // where getExistingCourses() would pick them up as real courses).
    const configsDir = configsDirOverride || path.join(repoRoot, 'configs');
    const candidates = adapter.lintConfigCandidates
        ? adapter.lintConfigCandidates(configsDir, adapterLabName, adapterParentName, courseName, repoRoot)
        : [];
    const lintConfigFile = candidates.find(c => fs.existsSync(c)) || null;
    if (!lintConfigFile && adapter.lintConfigCandidates) {
        const labConfigsLabel = courseName ? `configs/${courseName}/${adapterLabName}/` : `configs/${adapterLabName}/`;
        console.warn(`WARNING: No lint config found in ${labConfigsLabel} or configs/. Linting may fail.`);
    }

    // Also copy the resolved override into the lab folder so an editor can find it when
    // browsing student code (e.g. VS Code + eslint.config.mjs).
    if (lintConfigFile) {
        const vsCodeCopy = path.join(labRoot, path.basename(lintConfigFile));
        // Always refresh (not just write-if-absent) — an updated ruleset must propagate to
        // the editor copy on the next grading run, not just the first time this lab is graded.
        try {
            fs.copyFileSync(lintConfigFile, vsCodeCopy);
            console.log(`  Copied ${path.basename(lintConfigFile)} to ${path.basename(labRoot)}/ (for editor use)`);
        } catch (e) { /* non-fatal */ }
    }

    const exclusions = (config.lint && config.lint.exclude) ? config.lint.exclude : [];
    const emptyLint = () => ({ sourceFiles: 0, errors: 0, warnings: 0, messages: [], ruleCounts: {} });

    await runPerStudentPhase(students, {
        name: 'Linting Phase',
        attachKey: 'lint',
        noCodeResult: emptyLint,
        errorResult: (e) => ({ ...emptyLint(), toolError: e.message }),
        checkStudent: async (student) => {
            const sourceFiles = getAllJsFiles(student.extractedDir, exclusions, adapter);
            if (sourceFiles.length === 0 || !adapter.lint) {
                if (sourceFiles.length === 0) console.log(`  SKIP LINT: ${student.name} - no source files found to lint`);
                return emptyLint();
            }

            const result = await adapter.lint(sourceFiles, student.extractedDir, lintConfigFile, config);
            console.log(`  ${student.name}: ${sourceFiles.length} files, ${result.errors} errors, ${result.warnings} warnings`);

            return {
                sourceFiles: sourceFiles.length,
                errors: result.errors,
                warnings: result.warnings,
                messages: result.messages,
                errorMessages: result.errorMessages || [],
                warningMessages: result.warningMessages || [],
                ruleCounts: result.ruleCounts || {},
                ...(result.toolError ? { toolError: result.toolError } : {})
            };
        }
    });

    writePhaseReport(labDir, LINT_REPORT, students, s => ({
        student: s.name,
        sourceFiles: s.lint ? s.lint.sourceFiles : 0,
        errors: s.lint ? s.lint.errors : 0,
        warnings: s.lint ? s.lint.warnings : 0,
        messages: s.lint ? s.lint.messages : [],
        ruleCounts: (s.lint && s.lint.ruleCounts) || {}
    }));
};

export { getAllJsFiles };
