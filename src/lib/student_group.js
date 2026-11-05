/**
 * student_group.js
 *
 * Lab groups (A/B/C): which version of a lab each student did, and the group-specific
 * settings that follow from it.
 *
 * Some courses give each lab group a different problem, not just a differently named app:
 * CS212's Lab02 groups schedule class sections, flights or van deliveries, each with its own
 * data files and expected output. A lab config describes that with per-group `overrides`:
 *
 *   "variations": {
 *     "A": { "appName": "...", "overrides": { "runCheck": { "supportFiles": [{ "from": "GroupA-Data", "to": "Data" }] } } },
 *     "B": { "appName": "...", "overrides": { ... } }
 *   }
 *
 * The group comes from the student's code review form ("Developer's lab version (A, B, or C)",
 * read by read_code_review.js), falling back to keyword detection of the variation's appName
 * in the code (variation_detect.js). When neither yields a group the lab defines, the group is
 * unknown. The instructor can also assign groups by hand for one term's run: a
 * `group_overrides.json` in the lab's Artifacts folder, `{ "Student Name": "A" }`, wins over both.
 * When the group is unknown: grading flags every rubric row that depends on group-specific settings for manual
 * review instead of scoring it with the wrong group's settings (see generate_grades.js).
 */

import fs from 'fs';
import { checkVersionVariation } from './variation_detect.js';
import { mergeConfig } from './merge_config.js';

/**
 * The config keys a group's `overrides` may set — exactly the settings the per-student phases
 * read through configForStudent() (runtime check, analysis, web content). Anything else would
 * be silently ignored, so config validation rejects it.
 */
const OVERRIDABLE_KEYS = ['runCheck', 'testCheck', 'execution', 'analysis', 'packageCheck', 'webContent'];

/** The rubric mapping types whose result depends on each overridable key. */
const MAPPING_TYPES_BY_KEY = {
    runCheck: ['run_check', 'test_check'],      // test_check also uses runCheck.supportFiles
    execution: ['run_check', 'test_check'],
    testCheck: ['test_check'],
    analysis: ['feature', 'part_feature'],
    packageCheck: ['package_check', 'manifest_check'],
    webContent: ['element_check', 'css_selector_check', 'css_property_check', 'file_count'],
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** True when any group in config.variations has `overrides`. */
function hasGroupOverrides(config) {
    return !!config.variations && Object.values(config.variations).some(v => v && v.overrides);
}

/** The override keys used by any group (e.g. ["runCheck", "analysis"]). */
function overriddenKeys(config) {
    const keys = new Set();
    for (const v of Object.values(config.variations || {})) {
        for (const k of Object.keys((v && v.overrides) || {})) keys.add(k);
    }
    return [...keys];
}

/**
 * Works out which group a student is in.
 * @returns {{ letter: string|null, source: 'instructor'|'codeReview'|'detected'|null,
 *             detected?: string|null, conflict?: boolean, reason?: string }}
 *   letter is null when unknown; then `reason` says why. `conflict` is true when the review
 *   form and the code disagree (the form wins — the student declared their version there).
 */
function resolveStudentGroup(student, config, manualGroups = {}) {
    const formLetter = (student.codeReview && student.codeReview.group) || null;
    const variations = config.variations;
    if (!variations) return { letter: formLetter, source: formLetter ? 'codeReview' : null };

    const known = l => !!l && hasOwn(variations, l);
    let detected = null;
    const canDetect = Object.values(variations).some(v => v && v.appName);
    if (canDetect && student.extractedDir && fs.existsSync(student.extractedDir)) {
        detected = checkVersionVariation(student.extractedDir, variations, config.variationExcludeNamePatterns).detected;
    }

    const manual = manualGroups && manualGroups[student.name];
    if (known(manual)) {
        return { letter: manual, source: 'instructor', detected, formLetter, conflict: !!formLetter && formLetter !== manual };
    }
    if (known(formLetter)) {
        return { letter: formLetter, source: 'codeReview', detected, conflict: !!detected && detected !== formLetter };
    }
    if (known(detected)) return { letter: detected, source: 'detected', detected };

    const groups = Object.keys(variations).join('/');
    const reason = formLetter
        ? `the review form says group "${formLetter}", which isn't one of this lab's groups (${groups})`
        : `no group on the code review form, and none could be detected from the code`;
    return { letter: null, source: null, detected, reason };
}

/**
 * Pipeline phase: sets `student.group` for every student (after read_code_review.js, before
 * the runtime check, which may need group-specific settings).
 */
function resolveGroups(students, config, manualGroups = {}) {
    // Only labs with per-group settings get a log section — for labs whose variations are just
    // app names (most CS233JS labs), the group changes nothing about how a student is checked.
    if (!hasGroupOverrides(config)) {
        for (const s of students) s.group = resolveStudentGroup(s, config, manualGroups);
        return;
    }
    console.log('--- Lab Group Resolution ---');
    for (const s of students) {
        s.group = resolveStudentGroup(s, config, manualGroups);
        const g = s.group;
        if (!g.letter) console.log(`  ${s.name}: group UNKNOWN — ${g.reason}`);
        else if (g.source === 'instructor') console.log(`  ${s.name}: group ${g.letter} (set by instructor${g.conflict ? `; the review form says ${g.formLetter}` : ''})`);
        else if (g.conflict) console.log(`  ${s.name}: group ${g.letter} (from review form; the code looks like group ${g.detected})`);
        else console.log(`  ${s.name}: group ${g.letter} (${g.source === 'codeReview' ? 'review form' : 'detected from code'})`);
    }
}

const mergedCache = new WeakMap(); // config -> Map(letter -> merged config)

/**
 * The config to use for this student: the lab config with the student's group `overrides`
 * merged in (nested objects merge key by key; arrays and other values replace). Returns the
 * lab config itself when there are no overrides for the student's group. Cached per group.
 */
function configForStudent(config, student) {
    if (!hasGroupOverrides(config)) return config;
    const letter = student && student.group && student.group.letter;
    const overrides = letter && config.variations[letter] && config.variations[letter].overrides;
    if (!overrides) return config;
    let byLetter = mergedCache.get(config);
    if (!byLetter) { byLetter = new Map(); mergedCache.set(config, byLetter); }
    if (!byLetter.has(letter)) byLetter.set(letter, mergeConfig(config, overrides));
    return byLetter.get(letter);
}

/**
 * True when this student's group is unknown and the lab has group overrides — i.e. any
 * group-specific setting would be a guess for this student.
 */
function groupUnknownWithOverrides(config, student) {
    return hasGroupOverrides(config) && !(student.group && student.group.letter);
}

/** True when a mapping of this type reads settings some group overrides. */
function mappingDependsOnGroup(config, mapType) {
    return overriddenKeys(config).some(k => (MAPPING_TYPES_BY_KEY[k] || []).includes(mapType));
}

export {
    OVERRIDABLE_KEYS, MAPPING_TYPES_BY_KEY,
    hasGroupOverrides, overriddenKeys, resolveStudentGroup, resolveGroups,
    configForStudent, groupUnknownWithOverrides, mappingDependsOnGroup,
};
