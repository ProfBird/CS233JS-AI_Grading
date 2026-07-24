import http from 'http';

const OLLAMA_BASE = 'http://localhost:11434';
const TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;

function httpRequest(method, path, body = null, timeout = TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const url = `${OLLAMA_BASE}${path}`;
        const req = http.request(url, {
            method,
            headers: body ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            } : {}
        }, res => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        });
        req.on('error', reject);
        req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

// Returns the name of the first available model, or null if Ollama is unreachable or has no models.
function getAvailableModel() {
    return new Promise(resolve => {
        const req = http.get(`${OLLAMA_BASE}/api/tags`, res => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    const models = JSON.parse(raw).models;
                    resolve(models && models.length ? models[0].name : null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    });
}

// Returns a one-sentence summary string, or null on failure.
// Retries with exponential backoff to handle cold-start delays.
function generateSummary({ model, features, lintErrors, lintWarnings, lintTopIssues, runtimeSuccess, runtimeErrors, language = 'code' }) {
    const topIssues = lintTopIssues.length ? ` (${lintTopIssues.slice(0, 3).join(', ')})` : '';
    const prompt =
        `Write one brief sentence (under 20 words) for an instructor's rubric summarizing this ${language} lab submission.\n\n` +
        `Features detected: ${JSON.stringify(features)}\n` +
        `Lint: ${lintErrors} errors, ${lintWarnings} warnings${topIssues}\n` +
        `Runtime: ${runtimeSuccess ? 'clean' : 'errors: ' + runtimeErrors.slice(0, 2).join('; ')}\n\n` +
        `Summary:`;

    const body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        stream: false
    });

    async function attempt(n) {
        try {
            const res = await httpRequest('POST', '/v1/chat/completions', body);
            if (res.status === 200) {
                return JSON.parse(res.body).choices[0].message.content.trim();
            }
        } catch (e) {
            /* retry on timeout or network error */
        }
        if (n < MAX_RETRIES - 1) {
            const delay = Math.pow(2, n) * 1000;
            await new Promise(r => setTimeout(r, delay));
            return attempt(n + 1);
        }
        return null;
    }

    return attempt(0);
}

export { getAvailableModel, generateSummary };
