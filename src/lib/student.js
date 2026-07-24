/**
 * student.js
 *
 * Documents and constructs the shared shape acquisition sources (extract_code.js's
 * Moodle-folder scan, extract_code_canvas.js's Canvas import) attach fields to, and every
 * later pipeline phase (runtime_check.js, analyze_code.js, lint_code.js, generate_grades.js,
 * ...) reads/writes ad hoc. Nothing enforced this shape before — the two acquisition sources
 * had drifted (Canvas's error path omitted extractedDir/filesDir entirely; Moodle always set
 * them, even to a path that doesn't exist). `makeStudent()` is the one place both sources
 * build a student object from, so the drift can't recur silently.
 *
 * @typedef {Object} Student
 * @property {string} name - display name, used for directory naming (via toSafeName) and logging
 * @property {string|null} extractedDir - path to extracted/cloned student code, or null if none
 *           is available yet. NOTE: on an acquisition failure this may be set to a path that
 *           does NOT exist on disk (extract_code.js's fallback-path convention) — every reader
 *           must gate on `fs.existsSync(student.extractedDir)`, not just truthiness.
 * @property {string|null} filesDir - path to the raw submitted files (Moodle's
 *           *_assignsubmission_file dir, or Canvas's downloaded attachments dir), or null
 * @property {string|null} gradeDir - path this student's grade output (spreadsheet/report) is
 *           written to, or null
 * @property {Object<string, string|null>} urls - URL category (from config.urlPatterns, e.g.
 *           "github"/"citstudent") -> the matching URL found, or null if none was found for
 *           that category. Always has one key per configured pattern, even when nothing
 *           matched — never a bare `{}` — so `student.urls.github` is a reliable check
 *           regardless of acquisition source.
 * @property {string} [error] - set when code acquisition failed outright (no submission, no
 *           parseable zip/URL, clone failure, storage error). Downstream phases treat a set
 *           `error` as "skip — no code to analyze" via per_student_phase.js's skipIfNoCode.
 * @property {string} [zipFile] - path to a submitted zip file, if any, before extraction
 *
 * Two related-but-distinct per-student flags exist elsewhere and are easy to conflate:
 *   - analyze_code.js's `student.analysis.hasCodeReview` — true if ANY file whose name
 *     contains "review" and ends in .docx/.pdf/.txt was submitted (existence only).
 *   - read_code_review.js's `student.codeReview.found` — true only if a TOP-LEVEL .docx
 *     review was found AND successfully parsed for scores. A nested or non-.docx review can
 *     leave these disagreeing on the same student; that's expected, not a bug in either flag
 *     alone — but a caller reading only one of the two can be misled about "did they submit a
 *     review", so prefer checking both when that's the actual question.
 */

/**
 * Builds a fresh Student object. Every acquisition source should build student objects
 * through this factory (spreading in whatever it already knows via `overrides`) rather than
 * constructing ad hoc object literals, so a field neither source explicitly sets still ends
 * up with the documented default instead of being silently absent.
 * @param {Partial<Student>} overrides
 * @returns {Student}
 */
function makeStudent(overrides = {}) {
    return {
        name: overrides.name,
        extractedDir: null,
        filesDir: null,
        gradeDir: null,
        urls: {},
        ...overrides,
    };
}

export { makeStudent };
