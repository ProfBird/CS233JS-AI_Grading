// Unified LLM client supporting Ollama, OpenRouter, and Anthropic.
// API key lookup: environment variable first, then local-config.json.

import { writeLocalConfigFile } from './local_config_file.js';
import http from 'http';
import https from 'https';
import fs from 'fs';

const ENV_KEYS = { openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
const DEFAULTS = {
    ollama:      { baseUrl: 'http://localhost:11434/v1',        model: null },
    openrouter:  { baseUrl: 'https://openrouter.ai/api/v1',    model: 'deepseek/deepseek-chat-v3-0324:free' },
    anthropic:   { baseUrl: 'https://api.anthropic.com/v1',    model: 'claude-haiku-4-5-20251001' },
};

const OPENROUTER_MODELS = [
    { label: 'DeepSeek V4 Pro',          value: 'deepseek/deepseek-v4-pro',                desc: 'DeepSeek V4 Pro — MoE 1.6T params, 1M context (paid)' },
    { label: 'DeepSeek Chat v3 (free)',  value: 'deepseek/deepseek-chat-v3-0324:free',    desc: 'DeepSeek V3 via OpenRouter — free tier' },
    { label: 'LLaMA 3.3 70B (free)',    value: 'meta-llama/llama-3.3-70b-instruct:free', desc: 'Meta LLaMA 3.3 via OpenRouter — free tier' },
];

// OpenRouter's HTTP-Referer/X-Title headers are optional app-attribution metadata (shown
// on OpenRouter's own dashboard) — generic defaults so this shared lib doesn't hardcode
// one institution's domain/name; a deployment can override via LLMClient's appUrl/appTitle.
const DEFAULT_APP_URL = 'https://localhost';
const DEFAULT_APP_TITLE = 'AI Grading Pipeline';

class LLMClient {
    constructor({ provider, apiKey, model, fallbackModel, baseUrl, timeout = 60000, appUrl, appTitle, quiet = false }) {
        this.provider      = provider;
        this.apiKey        = apiKey;
        this.model         = model || DEFAULTS[provider]?.model;
        this.fallbackModel = fallbackModel || null;
        this.baseUrl       = baseUrl || DEFAULTS[provider]?.baseUrl;
        this.timeout       = timeout;
        this.appUrl        = appUrl || DEFAULT_APP_URL;
        this.appTitle      = appTitle || DEFAULT_APP_TITLE;
        // Suppresses this client's own console.error on failure — for callers (e.g.
        // ollama_comments.js, called once per student) that already report the failure
        // themselves and don't want a duplicate line per attempt.
        this.quiet         = quiet;
    }

    // Returns response text or null on failure.
    // On HTTP 429, automatically retries with fallbackModel if configured.
    async chat(systemPrompt, userPrompt) {
        const attempt = async (model, n) => {
            try {
                return this.provider === 'anthropic'
                    ? await this._chatAnthropic(systemPrompt, userPrompt, model)
                    : await this._chatOpenAI(systemPrompt, userPrompt, model);
            } catch (e) {
                if (e.status === 429 && this.fallbackModel && model !== this.fallbackModel) {
                    if (!this.quiet) console.error(`\n  Rate-limited on ${model}, trying fallback: ${this.fallbackModel}`);
                    return attempt(this.fallbackModel, 0);
                }
                if (n < 2) {
                    await new Promise(r => setTimeout(r, Math.pow(2, n) * 1000));
                    return attempt(model, n + 1);
                }
                if (!this.quiet) console.error(`\n  LLM request failed: ${e.message}`);
                return null;
            }
        };
        return attempt(this.model, 0);
    }

    async _chatOpenAI(systemPrompt, userPrompt, model) {
        model = model ?? this.model;
        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: userPrompt });

        const body = JSON.stringify({ model, messages, temperature: 0, stream: false });
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
        };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
        if (this.provider === 'openrouter') {
            headers['HTTP-Referer'] = this.appUrl;
            headers['X-Title'] = this.appTitle;
        }

        const res = await this._request(`${this.baseUrl}/chat/completions`, headers, body);
        if (res.status !== 200) {
            const err = new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return JSON.parse(res.body).choices[0].message.content.trim();
    }

    async _chatAnthropic(systemPrompt, userPrompt, model) {
        const payload = {
            model: model ?? this.model,
            max_tokens: 4096,
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0,
        };
        if (systemPrompt) payload.system = systemPrompt;

        const body = JSON.stringify(payload);
        const headers = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
        };

        const res = await this._request(`${this.baseUrl}/messages`, headers, body);
        if (res.status !== 200) {
            const err = new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return JSON.parse(res.body).content[0].text.trim();
    }

    _request(url, headers, body) {
        return new Promise((resolve, reject) => {
            const urlObj  = new URL(url);
            const lib     = urlObj.protocol === 'https:' ? https : http;
            const options = {
                hostname: urlObj.hostname,
                port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path:     urlObj.pathname + urlObj.search,
                method:   'POST',
                headers,
            };
            const req = lib.request(options, res => {
                let raw = '';
                res.on('data', c => raw += c);
                res.on('end', () => resolve({ status: res.statusCode, body: raw }));
            });
            req.on('error', reject);
            req.setTimeout(this.timeout, () => { req.destroy(); reject(new Error('timeout')); });
            req.write(body);
            req.end();
        });
    }
}

// Reads LLM config from local-config.json; resolves API key from env if not stored.
// Returns an LLMClient or null if no LLM is configured.
function loadLLMClient(localConfigPath) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')); } catch (e) {}

    const llm = cfg.llm;
    if (!llm?.provider) return null;

    const envVar = ENV_KEYS[llm.provider];
    const apiKey = (envVar && process.env[envVar]) || llm.apiKey || null;

    return new LLMClient({ provider: llm.provider, apiKey, model: llm.model, fallbackModel: llm.fallbackModel, baseUrl: llm.baseUrl });
}

// Probes Ollama for an available model name. `baseUrl` is the client-facing chat
// baseUrl (e.g. "http://localhost:11434/v1", DEFAULTS.ollama.baseUrl by default) —
// Ollama's tag-listing endpoint lives at the host root, not under /v1, so a
// trailing /v1 is stripped before appending /api/tags.
function detectOllamaModel(baseUrl = DEFAULTS.ollama.baseUrl) {
    const tagsUrl = `${baseUrl.replace(/\/v1\/?$/, '')}/api/tags`;
    return new Promise(resolve => {
        const req = http.get(tagsUrl, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try {
                    const models = JSON.parse(raw).models;
                    resolve(models?.length ? models[0].name : null);
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    });
}

// Interactive guided setup. Saves config to local-config.json.
// rl helpers (ask, askBoolean, askOptions) are passed in to keep this module independent.
async function setupLLMInteractive(localConfigPath, { ask, askBoolean, askOptions }) {
    console.log('\n--- LLM Setup ---');

    const provider = await askOptions('Which LLM provider?', [
        { label: 'Ollama (local)', value: 'ollama',     desc: 'Running at localhost:11434 — no API key needed' },
        { label: 'OpenRouter',     value: 'openrouter', desc: 'Cloud API, many free/cheap models' },
        { label: 'Anthropic',      value: 'anthropic',  desc: 'Claude models (paid, best quality)' },
    ]);

    let model = '', apiKey = null, saveKey = false;

    if (provider === 'ollama') {
        const detected = await detectOllamaModel();
        const raw = await ask(detected ? `  Model [${detected}]: ` : '  Model name: ');
        model = raw || detected || '';
        if (!model) { console.log('  No Ollama model found. Configure manually.'); return null; }
    } else {
        const envVar = ENV_KEYS[provider];
        if (process.env[envVar]) {
            console.log(`  Found ${envVar} in environment.`);
            apiKey = process.env[envVar];
        } else {
            apiKey = await ask(`  API key (${envVar}): `);
            if (!apiKey) { console.log('  No API key provided. Skipping LLM setup.'); return null; }
            saveKey = await askBoolean('  Save key to local-config.json? (gitignored, plaintext on disk)', true);
            if (!saveKey) {
                console.log(`  To avoid re-entering: export ${envVar}="${apiKey}"`);
            }
        }
        if (provider === 'openrouter') {
            const currentDefault = DEFAULTS.openrouter.model;
            const defIdx = Math.max(0, OPENROUTER_MODELS.findIndex(m => m.value === currentDefault));
            model = await askOptions('Model', OPENROUTER_MODELS, defIdx);
        } else {
            const def = DEFAULTS[provider].model;
            const raw = await ask(`  Model [${def}]: `);
            model = raw || def;
        }
    }

    // Persist config
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')); } catch (e) {}
    stored.llm = { provider, model };
    if (saveKey && apiKey) stored.llm.apiKey = apiKey;
    writeLocalConfigFile(localConfigPath, stored);
    console.log('  LLM configuration saved.\n');

    return new LLMClient({ provider, apiKey, model });
}

// Simplified model picker for configure_lab.js.
// Always shows a 3-option list immediately, pre-selects the current model.
// For OpenRouter: reads stored API key — prompts only if missing (first run).
// For Ollama: auto-detects running model, prompts only if none found.
// Saves selection to local-config.json. Returns LLMClient or null.
const MODEL_OPTIONS = [
    {
        label: 'DeepSeek V4 Pro',
        value: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' },
        desc:  'DeepSeek V4 Pro via OpenRouter — MoE 1.6T params, 1M context (paid)',
    },
    {
        label: 'DeepSeek Chat v3 (free)',
        value: { provider: 'openrouter', model: 'deepseek/deepseek-chat-v3-0324:free' },
        desc:  'DeepSeek V3 via OpenRouter — fast, high quality, free tier',
    },
    {
        label: 'LLaMA 3.3 70B (free)',
        value: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' },
        desc:  'Meta LLaMA 3.3 via OpenRouter — free tier',
    },
    {
        label: 'Local model (Ollama)',
        value: { provider: 'ollama', model: null },
        desc:  'Running at localhost:11434 — no API key needed',
    },
];

async function selectModel(localConfigPath, { ask, askOptions }) {
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(localConfigPath, 'utf8')); } catch (e) {}

    const currentModel = stored.llm?.model;
    const defIdx = Math.max(0, MODEL_OPTIONS.findIndex(o => o.value.model === currentModel));

    const choice = await askOptions('AI model for draft generation', MODEL_OPTIONS, defIdx);

    let apiKey = null;
    let model  = choice.model;

    if (choice.provider === 'openrouter') {
        const envVar = ENV_KEYS.openrouter;
        apiKey = process.env[envVar] || stored.llm?.apiKey || null;
        if (!apiKey) {
            apiKey = await ask(`OpenRouter API key (${envVar})`);
            if (!apiKey) { console.log('  No API key — skipping AI.'); return null; }
        }
    } else {
        const detected = await detectOllamaModel();
        if (detected) {
            console.log(`  Using Ollama model: ${detected}`);
            model = detected;
        } else {
            model = await ask('Ollama model name');
            if (!model) { console.log('  No Ollama model configured — skipping AI.'); return null; }
        }
    }

    stored.llm = { provider: choice.provider, model };
    if (apiKey) stored.llm.apiKey = apiKey;
    writeLocalConfigFile(localConfigPath, stored);

    return new LLMClient({ provider: choice.provider, apiKey, model });
}

export { LLMClient, loadLLMClient, setupLLMInteractive, selectModel, detectOllamaModel };
