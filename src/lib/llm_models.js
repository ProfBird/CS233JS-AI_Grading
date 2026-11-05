/**
 * llm_models.js — the model picker for configure-lab.js and its model/API manager.
 *
 * What is stored in configs/local-config.json (machine-local, gitignored, written 0600):
 *   llm           the model currently selected, in the shape loadLLMClient() reads
 *                 ({ provider, model, baseUrl?, apiKey? }) — unchanged, so
 *                 ollama_comments.js and friends keep working.
 *   llmEndpoints  { [name]: { type, baseUrl, apiKey? } } — the APIs ("endpoints") models
 *                 live on, so several models share one URL and key. Entries named after
 *                 a built-in endpoint (OpenRouter, Anthropic, Ollama (local)) only hold
 *                 the saved key / URL override.
 *   llmModels     [{ label, model, endpoint }] — models the user added.
 *   llmHidden     [id] — built-in models the user removed from the list.
 *
 * An endpoint's `type` picks the wire protocol: "anthropic" (Messages API) or any of
 * "openai" (any OpenAI-compatible chat endpoint), "openrouter", "ollama" (all
 * /chat/completions). API keys: env var (OpenRouter/Anthropic) first, then the stored key.
 *
 * All prompts go through the passed helpers ({ ask, askBoolean, askOptions }), so the
 * same code runs in the TUI and under a mock driver in tests.
 */
import fs from 'fs';
import { LLMClient, detectOllamaModel, ENV_KEYS } from './llm_client.js';
import { writeLocalConfigFile } from './local_config_file.js';

const ENDPOINT_TYPES = [
    { label: 'OpenAI-compatible', value: 'openai',     desc: 'Any /chat/completions API (OpenAI, Together, Groq, LM Studio, vLLM, …)' },
    { label: 'OpenRouter',        value: 'openrouter', desc: 'openrouter.ai — many models behind one key' },
    { label: 'Anthropic',         value: 'anthropic',  desc: 'Claude models (Messages API)' },
    { label: 'Ollama',            value: 'ollama',     desc: 'A local or LAN Ollama server — no key needed' },
];
const DEFAULT_URLS = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    anthropic: 'https://api.anthropic.com/v1',
    ollama: 'http://localhost:11434/v1',
};

const BUILTIN_ENDPOINTS = {
    'OpenRouter':     { type: 'openrouter', baseUrl: DEFAULT_URLS.openrouter },
    'Anthropic':      { type: 'anthropic',  baseUrl: DEFAULT_URLS.anthropic },
    'Ollama (local)': { type: 'ollama',     baseUrl: DEFAULT_URLS.ollama },
};

const BUILTIN_MODELS = [
    { id: 'builtin:deepseek-v4-pro', label: 'DeepSeek V4 Pro', model: 'deepseek/deepseek-v4-pro', endpoint: 'OpenRouter',
      desc: 'DeepSeek V4 Pro via OpenRouter — MoE 1.6T params, 1M context (paid)' },
    { id: 'builtin:deepseek-chat-v3', label: 'DeepSeek Chat v3 (free)', model: 'deepseek/deepseek-chat-v3-0324:free', endpoint: 'OpenRouter',
      desc: 'DeepSeek V3 via OpenRouter — fast, high quality, free tier' },
    { id: 'builtin:llama-3.3-70b', label: 'LLaMA 3.3 70B (free)', model: 'meta-llama/llama-3.3-70b-instruct:free', endpoint: 'OpenRouter',
      desc: 'Meta LLaMA 3.3 via OpenRouter — free tier' },
    { id: 'builtin:ollama', label: 'Local model (Ollama)', model: null, endpoint: 'Ollama (local)',
      desc: 'Running at localhost:11434 — no API key needed' },
];

const MANAGE = '__manage__';
const NEW_ENDPOINT = '__new_endpoint__';

// ── store access ─────────────────────────────────────────────────────────

function readStore(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** All endpoints by name: built-ins (with any stored key/URL override) plus user-added ones. */
function getEndpoints(cfg) {
    const stored = cfg.llmEndpoints || {};
    const out = {};
    for (const [name, base] of Object.entries(BUILTIN_ENDPOINTS)) {
        out[name] = { ...base, ...stored[name], type: base.type, name, builtin: true };
    }
    for (const [name, ep] of Object.entries(stored)) {
        if (!out[name]) out[name] = { ...ep, name, builtin: false };
    }
    return out;
}

/** Models to show, in order: built-ins (minus removed ones), then user-added. */
function getModels(cfg) {
    const hidden = new Set(cfg.llmHidden || []);
    return [
        ...BUILTIN_MODELS.filter(m => !hidden.has(m.id)).map(m => ({ ...m, builtin: true })),
        ...(cfg.llmModels || []).map(m => ({ ...m, id: `custom:${m.endpoint}:${m.model}`, builtin: false })),
    ];
}

/** Env var first (OpenRouter/Anthropic), then the key stored on the endpoint, then the legacy llm.apiKey. */
function resolveApiKey(cfg, ep) {
    const envVar = ENV_KEYS[ep.type];
    if (envVar && ep.builtin && process.env[envVar]) return process.env[envVar];
    if (ep.apiKey) return ep.apiKey;
    if (ep.builtin && cfg.llm?.provider === ep.type && cfg.llm.apiKey) return cfg.llm.apiKey;
    return null;
}

function keyStatus(cfg, ep) {
    if (ep.type === 'ollama') return 'no key needed';
    const envVar = ENV_KEYS[ep.type];
    if (envVar && ep.builtin && process.env[envVar]) return `key from ${envVar}`;
    return resolveApiKey(cfg, ep) ? 'key saved' : 'no key yet';
}

// ── manager screens ──────────────────────────────────────────────────────

async function askRequired(helpers, prompt, def = '') {
    while (true) {
        const v = (await helpers.ask(prompt, def)).trim();
        if (v) return v;
        console.log('  A value is required.');
    }
}

async function askKey(helpers, type) {
    const hint = ENV_KEYS[type] ? ` (blank to use ${ENV_KEYS[type]} from the environment)` : ' (blank for none)';
    return (await helpers.ask(`API key${hint}`)).trim() || null;
}

/** Create an endpoint (prompts for name/type/URL/key), save it, return its name. */
async function addEndpoint(helpers, file) {
    let cfg = readStore(file);
    const existing = getEndpoints(cfg);
    let name;
    while (true) {
        name = await askRequired(helpers, 'Name for this API (e.g. Together, Groq, Lab server)');
        if (existing[name]) { console.log(`  "${name}" already exists — pick another name.`); continue; }
        break;
    }
    const type = await helpers.askOptions('What kind of API is it?', ENDPOINT_TYPES, 0);
    const baseUrl = (await askRequired(helpers, 'Endpoint URL', DEFAULT_URLS[type])).replace(/\/+$/, '');
    const apiKey = type === 'ollama' ? null : await askKey(helpers, type);
    cfg = readStore(file);
    cfg.llmEndpoints = { ...(cfg.llmEndpoints || {}), [name]: { type, baseUrl, ...(apiKey ? { apiKey } : {}) } };
    writeLocalConfigFile(file, cfg);
    if (apiKey) console.log('  Key saved to local-config.json (gitignored, plaintext, owner-readable only).');
    return name;
}

/** "Which API is this model on?" — existing APIs first, then "New API…". Returns an endpoint name. */
async function pickEndpoint(helpers, file) {
    const cfg = readStore(file);
    const eps = Object.values(getEndpoints(cfg));
    const opts = [
        ...eps.map(ep => ({ label: ep.name, value: ep.name, status: keyStatus(cfg, ep), desc: `${ep.type} — ${ep.baseUrl}` })),
        { label: 'Another API (new)…', value: NEW_ENDPOINT, color: 'green', desc: 'Enter a new endpoint URL and API key' },
    ];
    const choice = await helpers.askOptions('Is this model on an API you already entered?', opts, 0);
    return choice === NEW_ENDPOINT ? addEndpoint(helpers, file) : choice;
}

async function addModel(helpers, file) {
    const model = await askRequired(helpers, 'Model name as the API expects it (e.g. gpt-4o-mini)');
    const label = await helpers.ask('Name to show in the list', model);
    const endpoint = await pickEndpoint(helpers, file);
    const cfg = readStore(file);
    cfg.llmModels = [...(cfg.llmModels || []), { label: label.trim() || model, model, endpoint }];
    writeLocalConfigFile(file, cfg);
    console.log(`  Added "${label.trim() || model}".`);
}

async function pickModel(helpers, file, prompt, { customOnly = false } = {}) {
    const models = getModels(readStore(file)).filter(m => !customOnly || !m.builtin);
    if (models.length === 0) { console.log('  No models to choose from.'); return null; }
    return helpers.askOptions(prompt, [
        ...models.map(m => ({ label: m.label, value: m, status: m.endpoint, desc: m.desc || m.model || '' })),
        { label: 'Cancel', value: null },
    ], 0);
}

async function editModel(helpers, file) {
    const m = await pickModel(helpers, file, 'Edit which model?', { customOnly: true });
    if (!m) { console.log('  (Built-in models can be removed but not edited; add a model of your own to customize.)'); return; }
    const model = await askRequired(helpers, 'Model name as the API expects it', m.model);
    const label = (await helpers.ask('Name to show in the list', m.label)).trim() || model;
    const endpoint = await pickEndpoint(helpers, file);
    const cfg = readStore(file);
    cfg.llmModels = (cfg.llmModels || []).map(x => (x.model === m.model && x.endpoint === m.endpoint) ? { label, model, endpoint } : x);
    writeLocalConfigFile(file, cfg);
    console.log(`  Updated "${label}".`);
}

async function removeModel(helpers, file) {
    const m = await pickModel(helpers, file, 'Remove which model?');
    if (!m) return;
    if (!await helpers.askBoolean(`Remove "${m.label}" from the list?`, false)) return;
    const cfg = readStore(file);
    if (m.builtin) cfg.llmHidden = [...new Set([...(cfg.llmHidden || []), m.id])];
    else cfg.llmModels = (cfg.llmModels || []).filter(x => !(x.model === m.model && x.endpoint === m.endpoint));
    writeLocalConfigFile(file, cfg);
    console.log(`  Removed "${m.label}".${m.builtin ? ' (Restore it any time from the manager.)' : ''}`);
}

async function manageEndpoints(helpers, file) {
    while (true) {
        const cfg = readStore(file);
        const eps = Object.values(getEndpoints(cfg));
        const opts = [
            ...eps.map(ep => ({ label: ep.name, value: ep.name, status: keyStatus(cfg, ep), desc: `${ep.type} — ${ep.baseUrl}` })),
            { label: 'Add a new API…', value: NEW_ENDPOINT, color: 'green' },
            { label: 'Back', value: null },
        ];
        const choice = await helpers.askOptions('APIs (endpoints and keys)', opts, 0);
        if (choice === null) return;
        if (choice === NEW_ENDPOINT) { await addEndpoint(helpers, file); continue; }

        const ep = eps.find(e => e.name === choice);
        const action = await helpers.askOptions(`${ep.name}`, [
            { label: 'Change API key', value: 'key' },
            { label: 'Change endpoint URL', value: 'url' },
            ...(ep.builtin ? [] : [{ label: 'Remove this API', value: 'remove' }]),
            { label: 'Back', value: null },
        ], 0);
        if (!action) continue;
        const fresh = readStore(file);
        fresh.llmEndpoints = { ...(fresh.llmEndpoints || {}) };
        const cur = { ...(fresh.llmEndpoints[ep.name] || { type: ep.type, baseUrl: ep.baseUrl }) };
        if (action === 'key') {
            const k = await askKey(helpers, ep.type);
            if (k) cur.apiKey = k; else delete cur.apiKey;
            fresh.llmEndpoints[ep.name] = cur;
        } else if (action === 'url') {
            cur.baseUrl = (await askRequired(helpers, 'Endpoint URL', ep.baseUrl)).replace(/\/+$/, '');
            fresh.llmEndpoints[ep.name] = cur;
        } else if (action === 'remove') {
            const users = (fresh.llmModels || []).filter(m => m.endpoint === ep.name);
            if (users.length) { console.log(`  Can't remove "${ep.name}" — ${users.length} model(s) use it. Remove or edit those first.`); continue; }
            if (!await helpers.askBoolean(`Remove the API "${ep.name}" and its saved key?`, false)) continue;
            delete fresh.llmEndpoints[ep.name];
        }
        writeLocalConfigFile(file, fresh);
        console.log('  Saved.');
    }
}

async function restoreModels(helpers, file) {
    const cfg = readStore(file);
    cfg.llmHidden = [];
    writeLocalConfigFile(file, cfg);
    console.log('  Built-in models restored.');
}

/** The model/API manager screen. Returns when the user picks Done. */
async function manageModels(helpers, file) {
    while (true) {
        const hidden = (readStore(file).llmHidden || []).length > 0;
        const action = await helpers.askOptions('Add, edit or remove models', [
            { label: 'Add a model', value: 'add', desc: 'Enter a model name, then pick or enter the API it runs on' },
            { label: 'Edit a model', value: 'edit', desc: 'Change a model you added' },
            { label: 'Remove a model', value: 'remove', desc: 'Remove any model from the list' },
            { label: 'APIs (endpoints and keys)', value: 'endpoints', desc: 'Change a saved key or URL, or add/remove an API' },
            ...(hidden ? [{ label: 'Restore removed built-in models', value: 'restore' }] : []),
            { label: 'Done', value: 'done', color: 'green' },
        ], 0);
        if (action === 'done') return;
        if (action === 'add') await addModel(helpers, file);
        else if (action === 'edit') await editModel(helpers, file);
        else if (action === 'remove') await removeModel(helpers, file);
        else if (action === 'endpoints') await manageEndpoints(helpers, file);
        else if (action === 'restore') await restoreModels(helpers, file);
    }
}

// ── the picker ───────────────────────────────────────────────────────────

/**
 * Model picker for configure-lab.js. Shows the model list (with a "manage" entry that
 * opens the add/edit/remove screens), saves the choice to local-config.json's `llm` block
 * and returns an LLMClient, or null when no usable model/key is available.
 */
async function selectModel(localConfigPath, helpers) {
    let choice;
    while (true) {
        const cfg = readStore(localConfigPath);
        const models = getModels(cfg);
        const cur = cfg.llm;
        const defIdx = Math.max(0, models.findIndex(m => cur && m.model && m.model === cur.model));
        const opts = [
            ...models.map(m => ({ label: m.label, value: m, desc: m.desc || `${m.model} via ${m.endpoint}` })),
            { label: 'Add, edit or remove models…', value: MANAGE, color: 'green', desc: 'Manage the model list and API keys' },
        ];
        choice = await helpers.askOptions('AI model for draft generation', opts, defIdx);
        if (choice !== MANAGE) break;
        await manageModels(helpers, localConfigPath);
    }

    const cfg = readStore(localConfigPath);
    const ep = getEndpoints(cfg)[choice.endpoint];
    if (!ep) { console.log(`  The API "${choice.endpoint}" no longer exists — skipping AI.`); return null; }

    let model = choice.model;
    let apiKey = null;
    if (ep.type === 'ollama') {
        if (!model) {
            const detected = await detectOllamaModel(ep.baseUrl);
            if (detected) { console.log(`  Using Ollama model: ${detected}`); model = detected; }
            else model = (await helpers.ask('Ollama model name')).trim();
            if (!model) { console.log('  No Ollama model configured — skipping AI.'); return null; }
        }
    } else {
        apiKey = resolveApiKey(cfg, ep);
        if (!apiKey) {
            apiKey = (await helpers.ask(`${ep.name} API key${ENV_KEYS[ep.type] ? ` (${ENV_KEYS[ep.type]})` : ''}`)).trim();
            if (!apiKey) { console.log('  No API key — skipping AI.'); return null; }
            cfg.llmEndpoints = { ...(cfg.llmEndpoints || {}), [ep.name]: { type: ep.type, baseUrl: ep.baseUrl, ...(cfg.llmEndpoints?.[ep.name] || {}), apiKey } };
        }
    }

    cfg.llm = { provider: ep.type, model, baseUrl: ep.baseUrl, ...(apiKey ? { apiKey } : {}) };
    writeLocalConfigFile(localConfigPath, cfg);
    return new LLMClient({ provider: ep.type, apiKey, model, baseUrl: ep.baseUrl });
}

export { selectModel, manageModels, getModels, getEndpoints, resolveApiKey, BUILTIN_MODELS, BUILTIN_ENDPOINTS };
