import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mockDriver } from './helpers/mock_driver.mjs';
import { selectModel, manageModels, getModels, getEndpoints } from '../src/lib/llm_models.js';

let dir, file;
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const helpersFor = (answers) => {
    const d = mockDriver(answers, { strict: true });
    return { d, h: { ask: d.ask, askBoolean: d.askBoolean, askOptions: d.askOptions } };
};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm_models_'));
    file = path.join(dir, 'local-config.json');
    fs.writeFileSync(file, JSON.stringify({ terms: {} }));
    delete process.env.OPENROUTER_API_KEY;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('manageModels', () => {
    it('adds a model on a brand-new API (name, type, URL, key)', async () => {
        // add -> model name, label, "Another API (new)" (last option; 4 built-in endpoints? 3) ,
        // api name, type (OpenAI-compatible), url, key, then Done
        const { h } = helpersFor(['add', 'gpt-4o-mini', 'GPT mini', '__new_endpoint__', 'OpenAI', '', 'https://api.openai.com/v1', 'sk-test', 'done']);
        await manageModels(h, file);
        const cfg = read();
        expect(cfg.llmEndpoints.OpenAI).toEqual({ type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
        expect(cfg.llmModels).toEqual([{ label: 'GPT mini', model: 'gpt-4o-mini', endpoint: 'OpenAI' }]);
        expect(getModels(cfg).map(m => m.label)).toContain('GPT mini');
    });

    it('lets a new model reuse an API that was already entered', async () => {
        fs.writeFileSync(file, JSON.stringify({ llmEndpoints: { Groq: { type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' } } }));
        const { d, h } = helpersFor(['add', 'llama-3', '', 'Groq', 'done']);
        await manageModels(h, file);
        const asked = d.calls.find(c => c.method === 'askOptions' && /already entered/.test(c.prompt));
        expect(asked.opts.map(o => o.label)).toContain('Groq');
        expect(read().llmModels).toEqual([{ label: 'llama-3', model: 'llama-3', endpoint: 'Groq' }]);
        expect(Object.keys(read().llmEndpoints)).toEqual(['Groq']);   // no duplicate API created
    });

    it('removes a built-in model (hidden) and restores it; removes a custom model outright', async () => {
        fs.writeFileSync(file, JSON.stringify({ llmModels: [{ label: 'Mine', model: 'm', endpoint: 'OpenRouter' }] }));
        const first = getModels(read())[0];
        const { h: h2 } = helpersFor(['remove', '1', 'y', 'done']);
        await manageModels(h2, file);
        expect(getModels(read()).map(m => m.id)).not.toContain(first.id);
        expect(read().llmHidden).toEqual([first.id]);

        const { h: h3 } = helpersFor(['restore', 'done']);
        await manageModels(h3, file);
        expect(getModels(read()).map(m => m.id)).toContain(first.id);

        const all = getModels(read());
        const mineIdx = all.findIndex(m => m.label === 'Mine') + 1;
        const { h: h4 } = helpersFor(['remove', String(mineIdx), 'y', 'done']);
        await manageModels(h4, file);
        expect(read().llmModels).toEqual([]);
    });

    it('refuses to remove an API that models still use', async () => {
        fs.writeFileSync(file, JSON.stringify({
            llmEndpoints: { Groq: { type: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' } },
            llmModels: [{ label: 'L', model: 'l', endpoint: 'Groq' }],
        }));
        const names = Object.keys(getEndpoints(read()));
        const { h } = helpersFor(['endpoints', String(names.indexOf('Groq') + 1), 'remove', '6', 'done']);   // '6' = Back in the APIs list
        await manageModels(h, file);
        expect(read().llmEndpoints.Groq).toBeDefined();
    });
});

describe('selectModel', () => {
    it('can open the manager from the list, then pick the model it just added', async () => {
        // list -> manage; manager: add model on new API, done; list again -> pick the new model (index 5)
        const answers = ['__manage__', 'add', 'gpt-4o-mini', 'GPT mini', '__new_endpoint__', 'OpenAI', '', 'https://api.openai.com/v1', 'sk-test', 'done', 'GPT mini'];
        const { h } = helpersFor(answers);
        const client = await selectModel(file, h);
        expect(client.provider).toBe('openai');
        expect(client.model).toBe('gpt-4o-mini');
        expect(client.baseUrl).toBe('https://api.openai.com/v1');
        expect(client.apiKey).toBe('sk-test');
        expect(read().llm).toEqual({ provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    });

    it('prompts for a missing OpenRouter key once and keeps it on the endpoint', async () => {
        const { h } = helpersFor(['', 'or-key']);
        const client = await selectModel(file, h);
        expect(client.apiKey).toBe('or-key');
        expect(read().llmEndpoints.OpenRouter.apiKey).toBe('or-key');
        // second run (switching away and back) no longer asks
        const { h: h2 } = helpersFor(['']);
        expect((await selectModel(file, h2)).apiKey).toBe('or-key');
    });

    it('falls back to the legacy llm.apiKey for OpenRouter', async () => {
        fs.writeFileSync(file, JSON.stringify({ llm: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', apiKey: 'legacy' } }));
        const { h } = helpersFor(['']);
        expect((await selectModel(file, h)).apiKey).toBe('legacy');
    });
});
