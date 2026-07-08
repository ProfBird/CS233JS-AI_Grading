/**
 * index.js
 *
 * Adapter registry/resolver. `config.language` (default "javascript") selects which
 * adapter a lab's pipeline phases call into. See base.js for the interface contract.
 */
import javascriptAdapter from './javascript.js';
import typescriptAdapter from './typescript.js';
import pythonAdapter from './python.js';
import cppAdapter from './cpp.js';
import csharpAdapter from './csharp.js';

const ADAPTERS = {
    javascript: javascriptAdapter,
    typescript: typescriptAdapter,
    python: pythonAdapter,
    cpp: cppAdapter,
    csharp: csharpAdapter,
};

// Additional adapters register themselves here as new languages are added.
export function registerAdapter(language, adapter) {
    ADAPTERS[language] = adapter;
}

export function resolveAdapter(config) {
    const language = (config && config.language) || 'javascript';
    const adapter = ADAPTERS[language];
    if (!adapter) {
        throw new Error(`Unknown language "${language}" — no adapter registered. Available: ${Object.keys(ADAPTERS).join(', ')}`);
    }
    return adapter;
}

export { ADAPTERS };
