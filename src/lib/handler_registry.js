/**
 * handler_registry.js
 *
 * Canonical registry for rubric mapping-type handlers, shared by generate_grades.js
 * (which registers the built-in handlers and scores against them) and bin/grade.js
 * (which must be able to load config.handlerModules and validate mapping types BEFORE
 * generate_grades.js's heavier dependencies — ollama client, rubric writer — are needed).
 *
 * A handler is a function (map, student) => { score, comment, keepComment? }.
 */

const _registry = new Map();
const VALID_MAPPING_TYPES = new Set();

/**
 * Register a handler for a mapping type.
 * @param {string} type — mapping type name (must match "type" in config mappings)
 * @param {function} handlerFn — (map, student) => { score, comment }
 */
function registerHandler(type, handlerFn) {
    if (_registry.has(type)) {
        throw new Error(`Handler "${type}" is already registered`);
    }
    _registry.set(type, handlerFn);
    VALID_MAPPING_TYPES.add(type);
}

function getHandler(type) {
    return _registry.get(type);
}

export { registerHandler, getHandler, VALID_MAPPING_TYPES };
