'use strict';

import fs from 'fs';

/**
 * Decides whether to use the legacy pre-course-tier flat labRoot/<LabName> path
 * instead of the course-scoped labRoot/<Course>/<LabName> path.
 *
 * With only one known course, the flat folder can only belong to that course, so
 * the fallback is used automatically. With multiple courses, the flat folder might
 * actually be a different course's submissions, so confirm before using it.
 *
 * @param {Object} opts
 * @param {string} opts.labDir - course-scoped path (<labRoot>/<Course>/<LabName>)
 * @param {string} opts.legacyLabDir - flat pre-course-tier path (<labRoot>/<LabName>)
 * @param {string} opts.courseName
 * @param {string} opts.labName
 * @param {boolean} opts.usingCanvas
 * @param {Array} opts.courses - list of discovered courses
 * @param {Object} opts.driver - prompt driver (src/lib/prompt_driver.js); uses
 *        driver.askBoolean and driver.note
 * @returns {Promise<string>} resolved labDir
 */
export async function resolveLegacyLabDir({
    labDir,
    legacyLabDir,
    courseName,
    labName,
    usingCanvas,
    courses,
    driver,
}) {
    if (usingCanvas || fs.existsSync(labDir) || !fs.existsSync(legacyLabDir)) {
        return labDir;
    }

    if (courses.length === 1) {
        driver.note(`  Note: reading submissions from ${legacyLabDir} (not yet moved under <labRoot>/${courseName}/).`);
        driver.note(`  Consider moving it under <labRoot>/${courseName}/${labName}/ to match the course-scoped layout.`);
        return legacyLabDir;
    }

    driver.print(`  Found a pre-course-tier submissions folder at ${legacyLabDir}.`);
    const confirm = await driver.askBoolean('This folder may belong to a different course — use it?', false);
    if (confirm) {
        driver.note(`  Note: reading submissions from ${legacyLabDir} (not yet moved under <labRoot>/${courseName}/).`);
        driver.note(`  Consider moving it under <labRoot>/${courseName}/${labName}/ to match the course-scoped layout.`);
        return legacyLabDir;
    }
    return labDir;
}
