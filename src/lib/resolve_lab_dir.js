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
 * @param {Function} opts.askRl - async prompt function
 * @returns {Promise<string>} resolved labDir
 */
export async function resolveLegacyLabDir({
    labDir,
    legacyLabDir,
    courseName,
    labName,
    usingCanvas,
    courses,
    askRl,
}) {
    if (usingCanvas || fs.existsSync(labDir) || !fs.existsSync(legacyLabDir)) {
        return labDir;
    }

    if (courses.length === 1) {
        console.log(`  Note: reading submissions from ${legacyLabDir} (not yet moved under <labRoot>/${courseName}/).`);
        console.log(`  Consider moving it under <labRoot>/${courseName}/${labName}/ to match the course-scoped layout.\n`);
        return legacyLabDir;
    }

    console.log(`  Found a pre-course-tier submissions folder at ${legacyLabDir}.`);
    const confirm = await askRl('This folder may belong to a different course — use it? (y/n): ');
    if (confirm.trim().toLowerCase() === 'y') {
        console.log(`  Note: reading submissions from ${legacyLabDir} (not yet moved under <labRoot>/${courseName}/).`);
        console.log(`  Consider moving it under <labRoot>/${courseName}/${labName}/ to match the course-scoped layout.\n`);
        return legacyLabDir;
    }
    return labDir;
}
