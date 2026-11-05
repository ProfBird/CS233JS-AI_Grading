/**
 * llm_check.js
 *
 * The `llm_check` mapping type: an AI model reads the student's code and suggests a score for
 * one qualitative rubric row ("rule design", "moderately complex", "explanations in comments")
 * that regex features can't judge. Always a SUGGESTION — every result is flagged
 * "NEEDS REVIEW (AI suggestion …)" with keepComment, so the instructor confirms or changes it.
 *
 * Where the code goes: the default provider is a local Ollama model, so student code never
 * leaves the grading machine. A lab (or course defaults) can set `llmCheck.provider` to
 * "openrouter" or "anthropic" — which sends student code, including the names in its header
 * comments, to that service; only do that where your institution's student-privacy rules
 * allow it. The provider is never taken from local-config.json's `llm` block (the lab wizard's
 * setting), so choosing a cloud model for drafting configs can't silently send student work.
 *
 * Config:
 *   mapping: { type: "llm_check", criterion, guidance?, files?, maxScore, cell, commentCell }
 *     criterion — the rubric row as a question or requirement (required)
 *     guidance  — what full / partial / no credit look like (optional, improves consistency)
 *     files     — regex on the file's project-relative path choosing what the model reads
 *                 (default: the language's source files, notebooks included)
 *   lab: llmCheck: { provider, model, baseUrl, maxChars, timeoutMs, concurrency, redactNames, redactTerms, cache }
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { LLMClient, detectOllamaModel } from './llm_client.js';
import { getAllFiles, toPosix } from './file_walker.js';
import { readSourceFile } from './notebook.js';
import { resolveAdapter } from '../adapters/index.js';

const DEFAULT_MAX_CHARS = 40000;
const DEFAULT_TIMEOUT_MS = 120000;
const SKIP_DIRS = ['node_modules', 'dist', 'build', '.git', '.venv', 'venv', '__pycache__', '.pytest_cache'];
const PROVIDERS = ['ollama', 'openrouter', 'anthropic', 'openai'];
const API_KEY_ENV = { openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'LLM_API_KEY' };

const SYSTEM_PROMPT = `You are a careful teaching assistant helping an instructor grade a student's programming lab.
You suggest a score for ONE rubric criterion; the instructor reviews every suggestion and makes the final decision.
Judge only that criterion, using only the code shown. Partial credit is allowed.
Reply with JSON only, no other text: {"score": <number from 0 to the maximum>, "reason": "<one or two specific sentences, naming files or functions>"}`;

/**
 * The student's code for the model to read, as one text with a header per file, cut at
 * maxChars (the cut is noted so the model doesn't judge a truncated file as unfinished).
 */
function collectCode(extractedDir, config, map, maxChars = DEFAULT_MAX_CHARS) {
    const adapter = resolveAdapter(config);
    let filesRe = null;
    if (map.files) filesRe = new RegExp(map.files);
    const rel = f => toPosix(path.relative(extractedDir, f));
    const files = getAllFiles(extractedDir, SKIP_DIRS)
        .filter(f => (filesRe ? filesRe.test(rel(f)) : adapter.sourceExtensions.some(ext => f.toLowerCase().endsWith(ext))))
        .sort();
    let text = '';
    let included = 0;
    let truncated = false;
    for (const f of files) {
        let content;
        try { content = readSourceFile(f); } catch (e) { continue; }
        const block = `\n===== ${rel(f)} =====\n${content}\n`;
        if (text.length + block.length > maxChars) {
            const room = maxChars - text.length;
            if (room > 200) { text += block.slice(0, room); included++; }
            truncated = true;
            break;
        }
        text += block;
        included++;
    }
    if (truncated) text += '\n===== (more code not shown — the submission is longer than this review covers) =====\n';
    return { text, fileCount: included, totalFiles: files.length, truncated };
}

function buildPrompt(map, code) {
    const lines = [
        `Rubric criterion: ${map.criterion}`,
        `Maximum score: ${map.maxScore ?? 0}`,
    ];
    if (map.guidance) lines.push(`Scoring guidance: ${map.guidance}`);
    lines.push('', `The student's code (${code.fileCount} file${code.fileCount === 1 ? '' : 's'}):`, code.text);
    return lines.join('\n');
}

/**
 * Reads the model's reply. Accepts the JSON object anywhere in the text (models often wrap it
 * in prose or a code fence). Score is clamped to [0, maxScore] and rounded to the nearest 0.5.
 * @returns {{ score: number, reason: string } | null}
 */
function parseVerdict(text, maxScore) {
    if (!text) return null;
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj;
    try { obj = JSON.parse(m[0]); } catch (e) { return null; }
    const raw = Number(obj.score);
    if (!Number.isFinite(raw)) return null;
    const max = Number(maxScore) || 0;
    const score = Math.round(Math.min(max, Math.max(0, raw)) * 2) / 2;
    const reason = String(obj.reason || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    return { score, reason };
}

// ---------- privacy and caching ----------

/** The text with the student's full name and each name part (3+ letters) replaced by [STUDENT]; also e-mail addresses ([EMAIL]), the account in a GitHub/GitLab URL ([USER]) and any extra terms. */
function redactNames(text, name, extraTerms = []) {
    const escape = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = String(name || '').split(/[\s,]+/).filter(p => p.replace(/[^A-Za-z]/g, '').length >= 3);
    const patterns = [];
    if (parts.length > 1) patterns.push(parts.map(escape).join('\\s+'));
    for (const p of parts) {
        patterns.push(escape(p));
        for (const q of p.split(/[-']/)) if (q.length >= 3 && q !== p) patterns.push(escape(q));
    }
    // Anything else that identifies a person: e-mail addresses, the account in a GitHub/GitLab URL,
    // and any names the instructor lists in llmCheck.redactTerms (a lab partner, a nickname).
    for (const t of extraTerms) if (String(t).trim()) patterns.push(escape(String(t).trim()));
    let out = text
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
        .replace(/\b((?:github|gitlab)\.com\/)[A-Za-z0-9-]+/gi, '$1[USER]');
    for (const pat of patterns.sort((x, y) => y.length - x.length)) {
        out = out.replace(new RegExp(`\\b${pat}\\b`, 'gi'), '[STUDENT]');
    }
    return out;
}

// Answers are kept per student, keyed by a hash of (model, instructions, criterion, code), so a
// regrade with unchanged code costs nothing and gives the same suggestion; any change re-asks.
const CACHE_FILE = '.llm_check_cache.json';
function readCache(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { return {}; }
}
function writeCache(file, key, verdict) {
    try {
        const cache = readCache(file);
        cache[key] = verdict;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(cache, null, 1));
    } catch (e) { /* a cache that can't be written just means asking again next time */ }
}

// ---------- the model client ----------

function readLocalConfig(localConfigPath) {
    try { return JSON.parse(fs.readFileSync(localConfigPath, 'utf8')) || {}; } catch (e) { return {}; }
}
function readLocalLlmSettings(localConfigPath) { return readLocalConfig(localConfigPath).llm || {}; }

const sameUrl = (a, b) => !!a && !!b && String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');

/**
 * The client for a lab's llm_check rows, or { error } when no model is available.
 * Ollama (default): llmCheck.model, else the first installed model. Cloud providers: only
 * when llmCheck.provider names one; API key from the provider's environment variable, else
 * local-config.json's llm.apiKey when that block is for the same provider.
 */
const DEFAULT_LOCAL_CONFIG = path.join(import.meta.dirname, '..', '..', 'configs', 'local-config.json');

async function defaultClientFactory(config, { localConfigPath = DEFAULT_LOCAL_CONFIG } = {}) {
    const settings = config.llmCheck || {};
    const provider = settings.provider || 'ollama';
    const timeout = settings.timeoutMs || DEFAULT_TIMEOUT_MS;
    if (provider === 'ollama') {
        const model = settings.model || await detectOllamaModel(settings.baseUrl);
        if (!model) return { error: 'no local Ollama model found (is "ollama serve" running with a model installed?)' };
        return { client: new LLMClient({ provider, model, baseUrl: settings.baseUrl, timeout, quiet: true }), label: `ollama/${model}` };
    }
    if (provider === 'openai') {
        // Any OpenAI-compatible API (DeepSeek, a campus server, …): llmCheck.baseUrl names it.
        // The key and default model come from the environment (LLM_API_KEY) or from the machine's
        // local-config.json: the matching `llmEndpoints` entry, else its `llm` block when that
        // block is for the same baseUrl.
        if (!settings.baseUrl) return { error: 'llmCheck.baseUrl is required for provider "openai"' };
        const cfg = localConfigPath ? readLocalConfig(localConfigPath) : {};
        const llm = cfg.llm || {};
        const endpoint = Object.values(cfg.llmEndpoints || {}).find(e => sameUrl(e && e.baseUrl, settings.baseUrl));
        const llmMatches = sameUrl(llm.baseUrl, settings.baseUrl);
        const apiKey = process.env[API_KEY_ENV.openai] || (endpoint && endpoint.apiKey) || (llmMatches ? llm.apiKey : null);
        if (!apiKey) return { error: `no API key for ${settings.baseUrl} (set ${API_KEY_ENV.openai}, or add the endpoint in local-config.json)` };
        const model = settings.model || (llmMatches ? llm.model : undefined);
        if (!model) return { error: 'no model set (llmCheck.model)' };
        return { client: new LLMClient({ provider, apiKey, model, baseUrl: settings.baseUrl, timeout, quiet: true }), label: `${model}` };
    }
    const local = localConfigPath ? readLocalLlmSettings(localConfigPath) : {};
    const apiKey = process.env[API_KEY_ENV[provider]] || (local.provider === provider ? local.apiKey : null);
    if (!apiKey) return { error: `no API key for ${provider} (set ${API_KEY_ENV[provider]})` };
    const model = settings.model || (local.provider === provider ? local.model : undefined);
    const client = new LLMClient({ provider, apiKey, model, timeout, quiet: true });
    return { client, label: `${provider}/${client.model}` };
}

let clientFactory = defaultClientFactory;
/** Tests: replace how the client is made (pass null to restore the default). */
function setLLMCheckClientFactory(fn) { clientFactory = fn || defaultClientFactory; }

const clientCache = new WeakMap(); // config -> Promise<{client,label}|{error}>
let warnedCloud = false;

function clientFor(config, opts) {
    if (!clientCache.has(config)) {
        const provider = (config.llmCheck && config.llmCheck.provider) || 'ollama';
        if (provider !== 'ollama' && !warnedCloud) {
            warnedCloud = true;
            console.warn(`  NOTE: llm_check rows send student code to ${provider} (llmCheck.provider).`);
        }
        clientCache.set(config, Promise.resolve(clientFactory(config, opts)));
    }
    return clientCache.get(config);
}

/**
 * Scores one llm_check row for one student.
 * @returns {Promise<{score: number, comment: string, keepComment: true}>}
 */
async function runLLMCheckNow(map, student, config, opts = {}) {
    const unavailable = why => ({ score: 0, comment: `NEEDS MANUAL CHECK: AI check unavailable (${why})`, keepComment: true });
    if (!student.extractedDir || !fs.existsSync(student.extractedDir)) return unavailable('no code to review');

    const settings = config.llmCheck || {};
    const code = collectCode(student.extractedDir, config, map, settings.maxChars || DEFAULT_MAX_CHARS);
    if (code.fileCount === 0) return unavailable('no matching files to review');

    const { client, label, error } = await clientFor(config, opts);
    if (error) return unavailable(error);

    // Cloud models never see the student's name (header comments often hold it).
    const redact = settings.redactNames !== undefined ? settings.redactNames !== false : (settings.provider || 'ollama') !== 'ollama';
    if (redact) code.text = redactNames(code.text, student.name, settings.redactTerms);

    const prompt = buildPrompt(map, code);
    const cacheFile = settings.cache === false || !student.gradeDir ? null : path.join(student.gradeDir, CACHE_FILE);
    const key = crypto.createHash('sha256').update(`${label}\n${SYSTEM_PROMPT}\n${prompt}`).digest('hex');
    let verdict = cacheFile ? readCache(cacheFile)[key] : null;
    if (!verdict) {
        const reply = await client.chat(SYSTEM_PROMPT, prompt);
        if (reply === null) return unavailable(`${label} did not respond`);
        verdict = parseVerdict(reply, map.maxScore);
        if (!verdict) return unavailable(`${label} gave no usable score`);
        if (cacheFile) writeCache(cacheFile, key, verdict);
    }

    const partial = code.truncated ? ` [reviewed ${code.fileCount} of ${code.totalFiles} files]` : '';
    return {
        score: verdict.score,
        comment: `NEEDS REVIEW (AI suggestion, ${label}): ${verdict.reason || 'no reason given'}${partial}`,
        keepComment: true,
    };
}

// ---------- running the rows in parallel ----------
// The model is the slow part (seconds per call), so a lab's rows are requested up front,
// several at a time, and the grading loop then just collects each finished answer.

const DEFAULT_CONCURRENCY = 4;
const prefetched = new WeakMap(); // student -> Map(mapping -> Promise<result>)

/** Scores one llm_check row for one student (reusing an answer requested by prefetchLLMChecks). */
function runLLMCheck(map, student, config, opts = {}) {
    const hit = prefetched.get(student) && prefetched.get(student).get(map);
    return hit || runLLMCheckNow(map, student, config, opts);
}

/**
 * Starts every student's llm_check rows now, at most `llmCheck.concurrency` (default 4) model
 * calls at a time. Resolves when all are answered; later runLLMCheck calls return the stored
 * answers. Harmless to call when the lab has no llm_check rows.
 */
async function prefetchLLMChecks(students, config, opts = {}) {
    const maps = (config.mappings || []).filter(m => m.type === 'llm_check' && m.criterion);
    if (maps.length === 0) return;
    const limit = Math.max(1, Number((config.llmCheck || {}).concurrency) || DEFAULT_CONCURRENCY);
    const jobs = [];
    for (const student of students) {
        if (!student.extractedDir) continue;
        const byMap = new Map();
        prefetched.set(student, byMap);
        for (const map of maps) jobs.push({ map, student, byMap });
    }
    let next = 0;
    let done = 0;
    const worker = async () => {
        while (next < jobs.length) {
            const { map, student, byMap } = jobs[next++];
            const p = runLLMCheckNow(map, student, config, opts);
            byMap.set(map, p);
            await p;
            done++;
            if (done % 10 === 0 || done === jobs.length) console.log(`  AI checks: ${done}/${jobs.length}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
}

export {
    redactNames, prefetchLLMChecks,
    runLLMCheck, collectCode, buildPrompt, parseVerdict, setLLMCheckClientFactory,
    defaultClientFactory, PROVIDERS, SYSTEM_PROMPT, DEFAULT_MAX_CHARS,
};
