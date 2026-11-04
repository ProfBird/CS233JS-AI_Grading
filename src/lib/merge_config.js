/**
 * merge_config.js
 *
 * The one config-merge rule, shared by course defaults (lab_config.js's applyCourseDefaults)
 * and lab-group overrides (student_group.js's configForStudent): `over` wins; plain objects
 * merge key by key; arrays and scalars from `over` replace the base value outright (an array
 * in a config is a complete list, e.g. lint.exclude or a runCheck list, not an addition).
 * Kept dependency-free so config_validation.js can use it without loading spreadsheet code.
 */

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Returns a new object; neither input is modified. */
function mergeConfig(base, over) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        out[k] = isPlainObject(v) && isPlainObject(base[k]) ? mergeConfig(base[k], v) : v;
    }
    return out;
}

export { mergeConfig, isPlainObject };
