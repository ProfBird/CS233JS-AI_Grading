// AI-generated one-sentence rubric summaries via a local Ollama server. Thin wrapper
// around LLMClient (src/lib/llm_client.js) — this module owns only the grading-specific
// prompt template and the shorter per-student timeout; the HTTP/retry/model-probe
// machinery is shared with llm_client.js's other providers.
import { LLMClient, detectOllamaModel } from './llm_client.js';

const TIMEOUT_MS = 8000;

// Returns the name of the first available model, or null if Ollama is unreachable or has no models.
function getAvailableModel() {
    return detectOllamaModel();
}

// Returns a one-sentence summary string, or null on failure.
// Retries with exponential backoff (via LLMClient) to handle cold-start delays.
function generateSummary({ model, features, lintErrors, lintWarnings, lintTopIssues, runtimeSuccess, runtimeErrors, language = 'code' }) {
    const topIssues = lintTopIssues.length ? ` (${lintTopIssues.slice(0, 3).join(', ')})` : '';
    const prompt =
        `Write one brief sentence (under 20 words) for an instructor's rubric summarizing this ${language} lab submission.\n\n` +
        `Features detected: ${JSON.stringify(features)}\n` +
        `Lint: ${lintErrors} errors, ${lintWarnings} warnings${topIssues}\n` +
        `Runtime: ${runtimeSuccess ? 'clean' : 'errors: ' + runtimeErrors.slice(0, 2).join('; ')}\n\n` +
        `Summary:`;

    const client = new LLMClient({ provider: 'ollama', model, timeout: TIMEOUT_MS, quiet: true });
    return client.chat(null, prompt);
}

export { getAvailableModel, generateSummary };
