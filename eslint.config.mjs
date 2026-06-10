// eslint.config.mjs
//
// Minimal lint config for THIS tool's OWN source — a syntax/correctness gate for
// CI and the editor, deliberately free of stylistic/formatting rules so it never
// fails on spacing, quotes, semicolons, trailing commas, etc.
//
// NOTE: this does NOT govern how student submissions are linted. That path uses
// configs/eslint.config.mjs (the VS Code-shared ruleset) passed explicitly via
// `overrideConfigFile` in pipeline/lint_code.js, which bypasses config discovery.
//
// It flags real problems only (parse errors are always fatal; plus the rules
// below) and demotes unused variables to a non-failing warning.

import globals from 'globals';

// Correctness rules only — no formatting/style. Every rule here catches a likely
// bug, not an opinion.
const correctnessRules = {
    'no-undef': 'error',            // references to undeclared variables (typos)
    'no-unreachable': 'error',      // code after return/throw/break
    'no-dupe-keys': 'error',        // duplicate object literal keys
    'no-dupe-args': 'error',        // duplicate function parameters
    'no-duplicate-case': 'error',   // duplicate switch cases
    'no-cond-assign': 'error',      // assignment where a comparison was meant
    'no-const-assign': 'error',     // reassigning a const
    'no-func-assign': 'error',      // reassigning a function declaration
    'no-obj-calls': 'error',        // calling non-callable globals, e.g. Math()
    'no-redeclare': 'error',        // declaring the same variable twice
    'no-self-assign': 'error',      // x = x
    'no-sparse-arrays': 'error',    // [ , , ] holes from stray commas
    'no-unsafe-negation': 'error',  // !a in b / !a instanceof b precedence traps
    'use-isnan': 'error',           // x === NaN (always false)
    'valid-typeof': 'error',        // typeof x === 'strnig' typos
    // noise -> warning; ignore unused fn args prefixed _, unused catch bindings
    // (this codebase intentionally uses `catch (e) {}` to swallow errors), and
    // rest siblings (the `const { a, ...rest } = obj` key-omission idiom).
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
};

export default [
    {
        // configs/ holds lab data and the student-facing ruleset (configs/eslint.config.mjs).
        // ESLint flat config resolves the nearest config per file, so files there are linted
        // with the student rules, not this gate — exclude them so the gate covers only the
        // grader engine (pipeline/lib/bin/run_all.js) and its tests.
        ignores: ['**/node_modules/**', '**/dist/**', '**/build/**', 'coverage/**', 'archive/**', 'configs/**'],
    },
    {
        // Pipeline/lib/bin and run_all.js are CommonJS (require / module.exports).
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        rules: correctnessRules,
    },
    {
        // Tests and this config are ES modules.
        files: ['**/*.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: correctnessRules,
    },
];
