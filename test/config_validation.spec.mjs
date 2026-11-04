/**
 * config_validation.spec.mjs
 *
 * Unit tests for src/lib/config_validation.js, extracted out of bin/grade.js so this
 * logic is directly testable instead of only exercised end-to-end via run_pipeline.spec.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

import { validateConfig, loadHandlerModules } from '../src/lib/config_validation.js';
// Side-effect import: generate_grades.js registers all built-in mapping-type handlers
// (registerHandler calls at module load), populating VALID_MAPPING_TYPES. In the real
// app this happens because bin/grade.js's import chain pulls in generate_grades.js;
// this test imports config_validation.js in isolation, so it must trigger that
// registration itself for "lint" etc. to be recognized as valid mapping types.
import '../src/pipeline/generate_grades.js';

function validBaseConfig() {
    return {
        rubricName: 'Rubric.xlsm',
        runtimeCheck: 'browser',
        mappings: [
            { type: 'lint', cell: 'B2', commentCell: 'C2', maxScore: 5 },
        ],
    };
}

describe('validateConfig', () => {
    it('passes silently for a fully-valid config', () => {
        expect(() => validateConfig(validBaseConfig(), 'Lab03')).not.toThrow();
    });

    it('short-circuits (does not throw) when extractOnly is true, even with no other fields', () => {
        expect(() => validateConfig({ extractOnly: true }, 'Lab03')).not.toThrow();
    });

    it('throws when rubricName is missing', () => {
        const config = validBaseConfig();
        delete config.rubricName;
        expect(() => validateConfig(config, 'Lab03')).toThrow(/rubricName/);
    });

    it('throws when runtimeCheck is missing', () => {
        const config = validBaseConfig();
        delete config.runtimeCheck;
        expect(() => validateConfig(config, 'Lab03')).toThrow(/runtimeCheck/);
    });

    it('throws when mappings is missing or empty', () => {
        const config = validBaseConfig();
        config.mappings = [];
        expect(() => validateConfig(config, 'Lab03')).toThrow(/mappings/);
    });

    it('throws for an unknown mapping type (proves VALID_MAPPING_TYPES wiring)', () => {
        const config = validBaseConfig();
        config.mappings = [{ type: 'not_a_real_type', cell: 'B2' }];
        expect(() => validateConfig(config, 'Lab03')).toThrow(/unknown type "not_a_real_type"/);
    });

    it('throws for an invalid runtimeCheck value against VALID_RUNTIME_MODES', () => {
        const config = validBaseConfig();
        config.runtimeCheck = 'not_a_real_mode';
        expect(() => validateConfig(config, 'Lab03')).toThrow(/Invalid runtimeCheck/);
    });

    it('throws for an invalid cell reference', () => {
        const config = validBaseConfig();
        config.mappings = [{ type: 'lint', cell: 'A1A' }];
        expect(() => validateConfig(config, 'Lab03')).toThrow(/cell.*not a valid cell reference/);
    });

    it('throws for an invalid commentCell reference', () => {
        const config = validBaseConfig();
        config.mappings = [{ type: 'lint', cell: 'B2', commentCell: '1A' }];
        expect(() => validateConfig(config, 'Lab03')).toThrow(/commentCell.*not a valid cell reference/);
    });

    it('throws for an unknown packageCheck section', () => {
        const config = validBaseConfig();
        config.packageCheck = { bogusSection: ['foo'] };
        expect(() => validateConfig(config, 'Lab03')).toThrow(/packageCheck: unknown section "bogusSection"/);
    });

    it('throws for a non-array packageCheck section', () => {
        const config = validBaseConfig();
        config.packageCheck = { dependencies: 'not-an-array' };
        expect(() => validateConfig(config, 'Lab03')).toThrow(/packageCheck\.dependencies must be an array/);
    });

    it('throws for an invalid codeReview.manualFallback value', () => {
        const config = validBaseConfig();
        config.codeReview = { manualFallback: 'bogus' };
        expect(() => validateConfig(config, 'Lab03')).toThrow(/codeReview\.manualFallback/);
    });

    it('throws for an invalid codeReview.studentNameCell reference', () => {
        const config = validBaseConfig();
        config.codeReview = { studentNameCell: 'not-a-cell' };
        expect(() => validateConfig(config, 'Lab03')).toThrow(/codeReview\.studentNameCell/);
    });

    it('accepts developer_comments scope/require and rejects bad values', () => {
        const withDev = extra => ({
            ...validBaseConfig(),
            mappings: [{ type: 'developer_comments', cell: 'B3', maxScore: 1, ...extra }],
        });
        expect(() => validateConfig(withDev({ scope: 'each', require: ['name', 'date', 'ai'] }), 'Lab01')).not.toThrow();
        expect(() => validateConfig(withDev({ scope: 'every' }), 'Lab01')).toThrow(/scope/);
        expect(() => validateConfig(withDev({ require: ['name', 'email'] }), 'Lab01')).toThrow(/require/);
        expect(() => validateConfig(withDev({ require: 'name' }), 'Lab01')).toThrow(/require/);
        expect(() => validateConfig(withDev({ requireAiDisclosure: true }), 'Lab01')).not.toThrow();
        expect(() => validateConfig(withDev({ requireAiDisclosure: 'yes' }), 'Lab01')).toThrow(/requireAiDisclosure/);
        expect(() => validateConfig(withDev({ ignoreCommentsBy: ['Brian Bird'] }), 'Lab01')).not.toThrow();
        expect(() => validateConfig(withDev({ ignoreCommentsBy: 'Brian Bird' }), 'Lab01')).toThrow(/ignoreCommentsBy/);
    });

    it('accepts manual reviewRow (string or list) / reviewRowOccurrence and rejects bad values', () => {
        const withManual = extra => ({
            ...validBaseConfig(),
            mappings: [{ type: 'manual', cell: 'B3', maxScore: 1, ...extra }],
        });
        expect(() => validateConfig(withManual({ reviewRow: 'game work' }), 'Lab01')).not.toThrow();
        expect(() => validateConfig(withManual({ reviewRow: ['private', 'collaborators'], reviewRowOccurrence: 2 }), 'Lab01')).not.toThrow();
        expect(() => validateConfig(withManual({ reviewRow: [] }), 'Lab01')).toThrow(/reviewRow/);
        expect(() => validateConfig(withManual({ reviewRow: 3 }), 'Lab01')).toThrow(/reviewRow/);
        expect(() => validateConfig(withManual({ reviewRow: 'x', reviewRowOccurrence: 0 }), 'Lab01')).toThrow(/reviewRowOccurrence/);
    });

    it('accepts and checks execution / runCheck / testCheck settings', () => {
        const withCfg = extra => ({ ...validBaseConfig(), ...extra });
        expect(() => validateConfig(withCfg({
            execution: { cwd: 'copy', envCacheDir: '/tmp/envs', timeoutMs: 20000, installTimeoutMs: 600000 },
            runCheck: { entry: 'main.py', supportFiles: ['Data', { from: 'GroupA-Data', to: 'Data' }], expectPatterns: ['sections: \\d+'] },
            testCheck: { mode: 'script', entry: 'test_scheduler.py', passPattern: '^PASS', failPattern: '^FAIL' },
        }), 'Lab02')).not.toThrow();
        expect(() => validateConfig(withCfg({ execution: { cwd: 'here' } }), 'x')).toThrow(/execution\.cwd/);
        expect(() => validateConfig(withCfg({ execution: { installTimeoutMs: -1 } }), 'x')).toThrow(/installTimeoutMs/);
        expect(() => validateConfig(withCfg({ runCheck: { supportFiles: 'Data' } }), 'x')).toThrow(/supportFiles/);
        expect(() => validateConfig(withCfg({ runCheck: { supportFiles: [{ to: 'Data' }] } }), 'x')).toThrow(/supportFiles/);
        expect(() => validateConfig(withCfg({ runCheck: { expectPatterns: ['('] } }), 'x')).toThrow(/expectPatterns/);
        expect(() => validateConfig(withCfg({ testCheck: { mode: 'unittest' } }), 'x')).toThrow(/testCheck\.mode/);
        expect(() => validateConfig(withCfg({ testCheck: { mode: 'script' } }), 'x')).toThrow(/testCheck\.entry/);
        expect(() => validateConfig(withCfg({ testCheck: { failPattern: '[' } }), 'x')).toThrow(/failPattern/);
    });

    it('accumulates multiple errors into a single thrown message', () => {
        const config = validBaseConfig();
        delete config.rubricName;
        delete config.runtimeCheck;
        try {
            validateConfig(config, 'Lab03');
            expect.unreachable('expected validateConfig to throw');
        } catch (e) {
            expect(e.message).toMatch(/rubricName/);
            expect(e.message).toMatch(/runtimeCheck/);
        }
    });
});

describe('validateConfig: textReport and webContent', () => {
    function webBaseConfig() {
        return {
            textReport: true,
            runtimeCheck: 'none',
            webContent: {
                requiredElements: [{ id: 'title', selector: 'title' }],
                requiredCssSelectors: ['nav'],
                requiredCssProperties: ['display: grid'],
                fileCounts: [{ id: 'html', pattern: '\\.html?$', min: 2 }],
            },
            mappings: [
                { type: 'element_check', maxScore: 1 },
                { type: 'file_count', countId: 'html', maxScore: 1 },
            ],
        };
    }

    it('textReport: true allows a missing rubricName (and "none" is a valid runtimeCheck)', () => {
        expect(() => validateConfig(webBaseConfig(), 'Lab01')).not.toThrow();
    });

    it('still requires rubricName without textReport', () => {
        const config = webBaseConfig();
        delete config.textReport;
        expect(() => validateConfig(config, 'Lab01')).toThrow(/rubricName/);
    });

    it('throws when web-content mappings are used without a webContent block', () => {
        const config = webBaseConfig();
        delete config.webContent;
        expect(() => validateConfig(config, 'Lab01')).toThrow(/require a "webContent" config block/);
    });

    it('throws for a requiredElements entry with no selector', () => {
        const config = webBaseConfig();
        config.webContent.requiredElements = [{ id: 'oops' }];
        expect(() => validateConfig(config, 'Lab01')).toThrow(/missing "selector"/);
    });

    it('throws for duplicate requiredElements ids', () => {
        const config = webBaseConfig();
        config.webContent.requiredElements = [
            { id: 'x', selector: 'title' },
            { id: 'x', selector: 'h1' },
        ];
        expect(() => validateConfig(config, 'Lab01')).toThrow(/duplicate id "x"/);
    });

    it('throws for a non-positive minCount', () => {
        const config = webBaseConfig();
        config.webContent.requiredElements = [{ id: 'x', selector: 'title', minCount: 0 }];
        expect(() => validateConfig(config, 'Lab01')).toThrow(/minCount/);
    });

    it('throws for a fileCounts entry missing id or pattern, or with a bad regex', () => {
        const config = webBaseConfig();
        config.webContent.fileCounts = [{ pattern: '\\.css$' }];
        expect(() => validateConfig(config, 'Lab01')).toThrow(/missing "id"/);

        const config2 = webBaseConfig();
        config2.webContent.fileCounts = [{ id: 'html', pattern: '(' }];
        expect(() => validateConfig(config2, 'Lab01')).toThrow(/not a valid regex/);
    });

    it('throws when a file_count mapping references an unknown countId', () => {
        const config = webBaseConfig();
        config.mappings[1].countId = 'bogus';
        expect(() => validateConfig(config, 'Lab01')).toThrow(/countId "bogus" has no matching/);
    });

    it('throws for a non-string-array requiredCssSelectors', () => {
        const config = webBaseConfig();
        config.webContent.requiredCssSelectors = 'nav';
        expect(() => validateConfig(config, 'Lab01')).toThrow(/requiredCssSelectors must be an array of strings/);
    });
});

describe('loadHandlerModules', () => {
    let root;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'handlermods-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('does nothing when config.handlerModules is not an array', async () => {
        await expect(loadHandlerModules({}, root)).resolves.toBeUndefined();
    });

    it('warns and continues when a listed module file does not exist', async () => {
        await expect(loadHandlerModules({ handlerModules: ['does_not_exist.js'] }, root)).resolves.toBeUndefined();
    });

    it('loads a real module and registers its handler as a side effect', async () => {
        const registryUrl = pathToFileURL(join(process.cwd(), 'src', 'lib', 'handler_registry.js')).href;
        const modulePath = join(root, 'custom_handler.js');
        writeFileSync(
            modulePath,
            `import { registerHandler } from ${JSON.stringify(registryUrl)};\n` +
            `registerHandler('custom_test_type', () => ({ score: 1, comment: 'ok' }));\n`
        );
        await loadHandlerModules({ handlerModules: ['custom_handler.js'] }, root);
        const { getHandler } = await import('../src/lib/handler_registry.js');
        expect(typeof getHandler('custom_test_type')).toBe('function');
    });
});
