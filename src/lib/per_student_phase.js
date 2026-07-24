/**
 * per_student_phase.js
 *
 * Shared scaffold for pipeline phases that loop over `students` and attach a
 * per-student result. Fixes two recurring hazards found across analyze_code.js,
 * lint_code.js, and check_web_content.js: an unguarded per-student loop where one
 * bad submission (an unreadable file, a malformed config regex) throws and aborts
 * the phase for every remaining student, and a phase that never writes an
 * Artifacts/*.json report.
 *
 * Pattern: banner -> extraction-skip guard -> try/catch -> attach -> (caller writes report).
 */
import fs from 'fs';
import path from 'path';

/**
 * Runs `checkStudent(student)` (sync or async) once per student in `students`,
 * attaching its return value to `student[attachKey]`. Isolates failures per
 * student: a thrown error is logged and `errorResult(e, student)` is attached
 * instead, but the loop continues for the remaining students.
 *
 * @param {Array} students
 * @param {object} opts
 * @param {string} opts.name - phase name, logged as a banner
 * @param {string} opts.attachKey - field name on `student` to attach the result to
 * @param {(student: object) => any} opts.checkStudent
 * @param {boolean} [opts.skipIfNoCode=true] - when true, students with `student.error`
 *   set or a missing/nonexistent `student.extractedDir` never reach `checkStudent`
 * @param {(student: object) => any} [opts.noCodeResult] - result attached when skipped
 *   for lack of code; called fresh per student so returned objects/arrays are never
 *   shared references (a stale bug some of the original per-phase EMPTY_RESULT
 *   constants had — one downstream mutation would otherwise corrupt every skipped
 *   student's result)
 * @param {(error: Error, student: object) => any} [opts.errorResult] - result attached
 *   when checkStudent throws
 */
async function runPerStudentPhase(students, opts) {
    const {
        name,
        attachKey,
        checkStudent,
        skipIfNoCode = true,
        noCodeResult = () => ({ error: 'No code found to analyze.' }),
        errorResult = (e) => ({ error: e.message }),
    } = opts;

    console.log(`--- ${name} ---`);
    for (const student of students) {
        if (skipIfNoCode && (student.error || !student.extractedDir || !fs.existsSync(student.extractedDir))) {
            student[attachKey] = noCodeResult(student);
            continue;
        }
        try {
            student[attachKey] = await checkStudent(student);
        } catch (e) {
            console.warn(`  WARNING: ${name} failed for ${student.name}: ${e.message}`);
            student[attachKey] = errorResult(e, student);
        }
    }
}

/**
 * Writes `<labDir>/<reportFileName>` as JSON: one row per student, built by
 * `toRow(student)`. Consolidates the six near-identical report-writing copies
 * that used to live inline in each phase.
 */
function writePhaseReport(labDir, reportFileName, students, toRow) {
    const report = students.map(toRow);
    fs.writeFileSync(path.join(labDir, reportFileName), JSON.stringify(report, null, 2));
    console.log(`Created ${reportFileName} for ${report.length} students.`);
    return report;
}

export { runPerStudentPhase, writePhaseReport };
