/**
 * llm_check.spec.mjs
 *
 * The llm_check mapping type (src/lib/llm_check.js): an AI model's suggested score for a
 * qualitative rubric row, always flagged for the instructor's review. The model is replaced by
 * a fake client (setLLMCheckClientFactory) — no network, no real model.
 *
 * Note: clients are cached per config object, so every test builds a fresh config.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    runLLMCheck, prefetchLLMChecks, redactNames, collectCode, buildPrompt, parseVerdict, setLLMCheckClientFactory, defaultClientFactory, SYSTEM_PROMPT,
} from '../src/lib/llm_check.js';
import { computeResults, getHandler } from '../src/pipeline/generate_grades.js';
import { validateConfig } from '../src/lib/config_validation.js';
import { buildMappingEntry } from '../src/lib/config_prompts.js';
import { mockDriver } from './helpers/mock_driver.mjs';

function write(root, rel, content) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
}

const NOTEBOOK = JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: [{ cell_type: 'code', metadata: {}, outputs: [], execution_count: null, source: ['model.fit(x, y, epochs=10)\n'] }],
});

// A fake model: records each call, answers with `reply` (a string, or a function of the prompt).
function fakeClient(reply) {
    const calls = [];
    const client = {
        async chat(system, user) {
            calls.push({ system, user });
            return typeof reply === 'function' ? reply(user) : reply;
        },
    };
    return { calls, factory: async () => ({ client, label: 'ollama/fake-model' }) };
}

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'llmcheck-')); });
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setLLMCheckClientFactory(null);
});

const rulesMap = () => ({
    type: 'llm_check', cell: 'C12', commentCell: 'E12', maxScore: 6,
    criterion: 'Are the rules well designed for forward chaining?',
    guidance: 'Full: 6+ rules, consistent conditions. Partial: few or overlapping rules.',
});

describe('parseVerdict', () => {
    it('reads the JSON object even inside prose or a code fence', () => {
        expect(parseVerdict('{"score": 4, "reason": "Good rules."}', 6)).toEqual({ score: 4, reason: 'Good rules.' });
        expect(parseVerdict('Sure!\n```json\n{"score": 5, "reason": "Six rules in rules.csv."}\n```', 6))
            .toEqual({ score: 5, reason: 'Six rules in rules.csv.' });
    });

    it('clamps to [0, max] and rounds to the nearest half point', () => {
        expect(parseVerdict('{"score": 9, "reason": "x"}', 6).score).toBe(6);
        expect(parseVerdict('{"score": -2, "reason": "x"}', 6).score).toBe(0);
        expect(parseVerdict('{"score": 3.7, "reason": "x"}', 6).score).toBe(3.5);
        expect(parseVerdict('{"score": "4", "reason": "x"}', 6).score).toBe(4);
    });

    it('returns null for an unusable reply', () => {
        expect(parseVerdict(null, 6)).toBeNull();
        expect(parseVerdict('I think it deserves a 4.', 6)).toBeNull();
        expect(parseVerdict('{"score": "four"}', 6)).toBeNull();
        expect(parseVerdict('{"score": 4, ', 6)).toBeNull();
    });
});

describe('collectCode', () => {
    it("reads the language's source files (notebooks included), skipping .venv and the like", () => {
        write(dir, 'engine.py', 'def infer(): pass\n');
        write(dir, 'lab05.ipynb', NOTEBOOK);
        write(dir, 'rules.csv', 'if,then\n');
        write(dir, '.venv/lib/site.py', 'library code\n');
        write(dir, '__pycache__/engine.cpython-312.pyc', 'x');
        const code = collectCode(dir, { language: 'python' }, {});
        expect(code.fileCount).toBe(2);
        expect(code.text).toContain('===== engine.py =====');
        expect(code.text).toContain('===== lab05.ipynb =====\n# %%\nmodel.fit(x, y, epochs=10)');
        expect(code.text).not.toContain('library code');
        expect(code.text).not.toContain('rules.csv');
        expect(code.truncated).toBe(false);
    });

    it('a mapping `files` regex chooses what the model reads (e.g. the rule file too)', () => {
        write(dir, 'engine.py', 'x = 1\n');
        write(dir, 'Data/rules.csv', 'if,then\n');
        const code = collectCode(dir, { language: 'python' }, { files: '\\.(py|csv)$' });
        expect(code.fileCount).toBe(2);
        expect(code.text).toContain('===== Data/rules.csv =====');
    });

    it('cuts long submissions and says so', () => {
        write(dir, 'a.py', 'a = 1\n'.repeat(400));
        write(dir, 'b.py', 'b = 2\n'.repeat(400));
        const code = collectCode(dir, { language: 'python' }, {}, 3000);
        expect(code.truncated).toBe(true);
        expect(code.totalFiles).toBe(2);
        expect(code.text).toMatch(/more code not shown/);
        expect(code.text.length).toBeLessThan(3200);
    });
});

describe('buildPrompt', () => {
    it('states the criterion, maximum and guidance before the code', () => {
        const prompt = buildPrompt(rulesMap(), { text: '\n===== engine.py =====\nx\n', fileCount: 1 });
        expect(prompt).toMatch(/^Rubric criterion: Are the rules well designed for forward chaining\?\nMaximum score: 6\nScoring guidance: Full: 6\+ rules/);
        expect(prompt).toContain("The student's code (1 file):");
        expect(SYSTEM_PROMPT).toMatch(/instructor reviews every suggestion/);
    });
});

describe('runLLMCheck', () => {
    const student = () => ({ name: 'Ana', extractedDir: dir });
    beforeEach(() => write(dir, 'engine.py', 'RULES = []\n'));

    it("returns the model's score as a suggestion flagged for review", async () => {
        const fake = fakeClient('{"score": 4.5, "reason": "Seven rules; two overlap on the same conditions."}');
        setLLMCheckClientFactory(fake.factory);
        const result = await runLLMCheck(rulesMap(), student(), { language: 'python' });
        expect(result).toEqual({
            score: 4.5,
            comment: 'NEEDS REVIEW (AI suggestion, ollama/fake-model): Seven rules; two overlap on the same conditions.',
            keepComment: true,
        });
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0].user).toContain('===== engine.py =====\nRULES = []');
    });

    it('notes when only part of a long submission was reviewed', async () => {
        write(dir, 'big.py', 'x = 1\n'.repeat(2000));
        setLLMCheckClientFactory(fakeClient('{"score": 3, "reason": "ok"}').factory);
        const result = await runLLMCheck(rulesMap(), student(), { language: 'python', llmCheck: { maxChars: 2000 } });
        expect(result.comment).toMatch(/\[reviewed 1 of 2 files\]$/);
    });

    it('scores 0 and flags the row when the AI check cannot run', async () => {
        const cases = [
            [async () => ({ error: 'no local Ollama model found' }), /AI check unavailable \(no local Ollama model found\)/],
            [fakeClient(null).factory, /AI check unavailable \(ollama\/fake-model did not respond\)/],
            [fakeClient('Looks fine to me!').factory, /AI check unavailable \(ollama\/fake-model gave no usable score\)/],
        ];
        for (const [factory, expected] of cases) {
            setLLMCheckClientFactory(factory);
            const result = await runLLMCheck(rulesMap(), student(), { language: 'python' });
            expect(result.score).toBe(0);
            expect(result.keepComment).toBe(true);
            expect(result.comment).toMatch(/^NEEDS MANUAL CHECK: /);
            expect(result.comment).toMatch(expected);
        }
    });

    it('flags a submission with no code (or no matching files) without calling the model', async () => {
        const fake = fakeClient('{"score": 6, "reason": "x"}');
        setLLMCheckClientFactory(fake.factory);
        expect((await runLLMCheck(rulesMap(), { name: 'X', extractedDir: join(dir, 'nope') }, {})).comment)
            .toBe('NEEDS MANUAL CHECK: AI check unavailable (no code to review)');
        expect((await runLLMCheck({ ...rulesMap(), files: '\\.java$' }, student(), {})).comment)
            .toBe('NEEDS MANUAL CHECK: AI check unavailable (no matching files to review)');
        expect(fake.calls).toHaveLength(0);
    });

    it('makes one client per lab config, shared by all of its rows and students', async () => {
        let made = 0;
        const fake = fakeClient('{"score": 1, "reason": "x"}');
        setLLMCheckClientFactory(async (...args) => { made++; return fake.factory(...args); });
        const config = { language: 'python' };
        await runLLMCheck(rulesMap(), student(), config);
        await runLLMCheck({ ...rulesMap(), criterion: 'Is I/O separated from inference?' }, student(), config);
        expect(made).toBe(1);
        expect(fake.calls).toHaveLength(2);
    });

    it("a cloud provider is used only when set explicitly, and needs that provider's API key", async () => {
        setLLMCheckClientFactory(null);   // the real factory — no request is made without a key
        const saved = process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        try {
            const result = await runLLMCheck(rulesMap(), student(), { language: 'python', llmCheck: { provider: 'anthropic' } },
                { localConfigPath: join(dir, 'no-local-config.json') });
            expect(result).toMatchObject({ score: 0, comment: 'NEEDS MANUAL CHECK: AI check unavailable (no API key for anthropic (set ANTHROPIC_API_KEY))' });
        } finally {
            if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
        }
    });
});

describe('llm_check in grading', () => {
    it('computeResults passes the lab config to the handler; the comment survives stock comments', async () => {
        write(dir, 'engine.py', 'RULES = []\n');
        const fake = fakeClient('{"score": 5, "reason": "Rules are clear."}');
        setLLMCheckClientFactory(fake.factory);
        const config = {
            language: 'python',
            mappings: [{ ...rulesMap(), stockComments: { full: 'Great', partial: 'OK', zero: 'Missing' } }],
        };
        const [row] = await computeResults({ name: 'Ana', extractedDir: dir }, config);
        expect(row).toMatchObject({ cell: 'C12', score: 5, desc: 'Are the rules well designed for forward chaining?' });
        expect(row.comment).toBe('NEEDS REVIEW (AI suggestion, ollama/fake-model): Rules are clear.');
        expect(typeof getHandler('llm_check')).toBe('function');
    });
});

describe('llm_check validation', () => {
    const cfg = (map, extra = {}) => ({ rubricName: 'R.xlsx', runtimeCheck: 'none', mappings: [{ type: 'llm_check', cell: 'C5', maxScore: 4, ...map }], ...extra });

    it('needs a criterion, and checks guidance/files', () => {
        expect(() => validateConfig(cfg({ criterion: 'Is it moderately complex?', guidance: 'Full: 3+ classes', files: '\\.py$' }), 'x')).not.toThrow();
        expect(() => validateConfig(cfg({}), 'x')).toThrow(/criterion: llm_check needs the rubric criterion/);
        expect(() => validateConfig(cfg({ criterion: 'x', files: '(' }), 'x')).toThrow(/files: must be a valid regular expression/);
        expect(() => validateConfig(cfg({ criterion: 'x', guidance: 3 }), 'x')).toThrow(/guidance: must be text/);
    });

    it('checks the llmCheck block', () => {
        const ok = { criterion: 'x' };
        expect(() => validateConfig(cfg(ok, { llmCheck: { provider: 'ollama', model: 'qwen3-coder', maxChars: 30000, timeoutMs: 90000 } }), 'x')).not.toThrow();
        expect(() => validateConfig(cfg(ok, { llmCheck: { provider: 'gemini' } }), 'x')).toThrow(/llmCheck\.provider: "gemini" must be one of ollama, openrouter, anthropic, openai/);
        expect(() => validateConfig(cfg(ok, { llmCheck: { provider: 'openai', baseUrl: 'https://api.deepseek.com' } }), 'x')).not.toThrow();
        expect(() => validateConfig(cfg(ok, { llmCheck: { maxChars: 0 } }), 'x')).toThrow(/llmCheck\.maxChars/);
        expect(() => validateConfig(cfg(ok, { llmCheck: 'ollama' }), 'x')).toThrow(/llmCheck: must be an object/);
    });
});

describe('llm_check in the lab wizard', () => {
    const rubricRow = { scoreCell: 'C8', commentCell: 'E8', label: 'Moderately complex' };

    it('prompts for max score, the criterion and optional guidance', async () => {
        const driver = mockDriver(['10', 'Is the app moderately complex (several classes, real logic)?', 'Full: 3+ classes'], { strict: true });
        expect(await buildMappingEntry(driver, 'llm_check', rubricRow)).toEqual({
            type: 'llm_check', cell: 'C8', commentCell: 'E8', maxScore: 10,
            criterion: 'Is the app moderately complex (several classes, real logic)?',
            guidance: 'Full: 3+ classes',
        });
    });

    it('leaves guidance out when blank, and skips the row when the criterion is blank', async () => {
        expect(await buildMappingEntry(mockDriver(['10', 'Is it complex?', ''], { strict: true }), 'llm_check', rubricRow))
            .not.toHaveProperty('guidance');
        expect(await buildMappingEntry(mockDriver(['10', ''], { strict: true }), 'llm_check', rubricRow)).toBeNull();
    });
});

describe('openai-compatible provider (e.g. DeepSeek)', () => {
    const localCfg = () => {
        const d = mkdtempSync(join(tmpdir(), 'llmcfg-'));
        const p = join(d, 'local-config.json');
        writeFileSync(p, JSON.stringify({
            llm: { provider: 'openai', model: 'ds-model', baseUrl: 'https://api.example.com/', apiKey: 'k-llm' },
            llmEndpoints: { x: { type: 'openai', baseUrl: 'https://other.example.com', apiKey: 'k-other' } },
        }));
        return p;
    };
    const saved = process.env.LLM_API_KEY;
    afterEach(() => { if (saved === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = saved; });

    it('takes the key and model from the machine config entry for the same baseUrl', async () => {
        delete process.env.LLM_API_KEY;
        const r = await defaultClientFactory({ llmCheck: { provider: 'openai', baseUrl: 'https://api.example.com' } }, { localConfigPath: localCfg() });
        expect(r.client.apiKey).toBe('k-llm');
        expect(r.client.model).toBe('ds-model');
        expect(r.client.baseUrl).toBe('https://api.example.com');
    });

    it('prefers the endpoint entry, then reports a missing key, model or baseUrl', async () => {
        delete process.env.LLM_API_KEY;
        const p = localCfg();
        const r = await defaultClientFactory({ llmCheck: { provider: 'openai', baseUrl: 'https://other.example.com', model: 'm' } }, { localConfigPath: p });
        expect(r.client.apiKey).toBe('k-other');
        expect((await defaultClientFactory({ llmCheck: { provider: 'openai', baseUrl: 'https://nope.example.com', model: 'm' } }, { localConfigPath: p })).error).toMatch(/no API key/);
        expect((await defaultClientFactory({ llmCheck: { provider: 'openai', baseUrl: 'https://other.example.com' } }, { localConfigPath: p })).error).toMatch(/no model/);
        expect((await defaultClientFactory({ llmCheck: { provider: 'openai' } }, { localConfigPath: p })).error).toMatch(/baseUrl is required/);
    });
});

describe('prefetchLLMChecks', () => {
    it('answers every row with limited concurrency and reuses the answers', async () => {
        let running = 0, peak = 0, calls = 0;
        setLLMCheckClientFactory(async () => ({
            label: 'fake',
            client: { chat: async () => { calls++; running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 20)); running--; return '{"score": 1, "reason": "ok"}'; } },
        }));
        const students = [1, 2, 3, 4].map(i => { write(dir, `s${i}/a.py`, 'x = 1\n'); return { name: `S${i}`, extractedDir: join(dir, `s${i}`) }; });
        const config = { language: 'python', llmCheck: { concurrency: 2 }, mappings: [rulesMap(), { ...rulesMap(), criterion: 'Other' }] };
        await prefetchLLMChecks(students, config);
        expect(calls).toBe(8);
        expect(peak).toBe(2);
        const r = await runLLMCheck(config.mappings[0], students[0], config);
        expect(r.score).toBe(1);
        expect(calls).toBe(8);
    });
});

describe('redactNames and the answer cache', () => {
    it('replaces the full name and each name part, case-insensitively', () => {
        expect(redactNames('# Josha Chapman-Dodson, Fall\n# by chapman\nx = dodson', 'Josha Chapman-Dodson'))
            .toBe('# [STUDENT], Fall\n# by [STUDENT]\nx = [STUDENT]');
        expect(redactNames('print("hi")', 'Al Bo')).toBe('print("hi")');   // too-short parts are left alone
    });

    it('sends no student name to a cloud model, and asks again only when something changed', async () => {
        const gradeDir = join(dir, 'grade'); mkdirSync(gradeDir, { recursive: true });
        write(dir, 'code/a.py', '# Ana Lopez\nx = 1\n');
        const student = { name: 'Ana Lopez', extractedDir: join(dir, 'code'), gradeDir };
        const prompts = [];
        setLLMCheckClientFactory(async () => ({ label: 'fake', client: { chat: async (_s, u) => { prompts.push(u); return '{"score": 2, "reason": "fine"}'; } } }));
        const config = () => ({ language: 'python', llmCheck: { provider: 'openai', baseUrl: 'http://x' } });
        const first = await runLLMCheck(rulesMap(), student, config());
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).not.toMatch(/Ana|Lopez/);
        expect(prompts[0]).toContain('[STUDENT]');
        const again = await runLLMCheck(rulesMap(), student, config());
        expect(prompts).toHaveLength(1);                  // answered from the cache
        expect(again).toEqual(first);
        write(dir, 'code/a.py', '# Ana Lopez\nx = 2\n');
        await runLLMCheck(rulesMap(), student, config());
        expect(prompts).toHaveLength(2);                  // code changed -> asked again
    });
});
