const http = require('http');

const OLLAMA_BASE = 'http://localhost:11434';
const TIMEOUT_MS = 8000;

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

// Returns a one-sentence summary string, or null if Ollama is unreachable/slow.
function generateSummary({ model, student, features, lintErrors, lintWarnings, lintTopIssues, runtimeSuccess, runtimeErrors }) {
    const topIssues = lintTopIssues.length ? ` (${lintTopIssues.slice(0, 3).join(', ')})` : '';
    const prompt =
        `Write one brief sentence (under 20 words) for an instructor's rubric summarizing this JS lab submission.\n\n` +
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

    return new Promise(resolve => {
        const req = http.request(
            `${OLLAMA_BASE}/v1/chat/completions`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            },
            res => {
                let raw = '';
                res.on('data', chunk => raw += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(raw).choices[0].message.content.trim());
                    } catch {
                        resolve(null);
                    }
                });
            }
        );
        req.on('error', () => resolve(null));
        req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

module.exports = { getAvailableModel, generateSummary };
