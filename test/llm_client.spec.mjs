/**
 * llm_client.spec.mjs
 *
 * Unit tests for LLMClient's HTTP behavior (path resolution, retry/backoff, fallback
 * model on 429). Uses a real http.Server as a fake Ollama/OpenRouter endpoint rather
 * than mocking http/https, so the assertions exercise the actual request path — this
 * is what pins the Ollama /v1 endpoint bug (see docs/code_review_2026-07-24.md §3.1
 * "Ollama client" duplication finding).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'http';
import { LLMClient, detectOllamaModel } from '../src/lib/llm_client.js';

// Starts a throwaway HTTP server driven by a request handler; returns { url, close }.
function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
        });
    });
}

function readBody(req) {
    return new Promise(resolve => {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => resolve(raw));
    });
}

describe('LLMClient (ollama provider)', () => {
    let server;
    afterEach(() => { if (server) server.close(); });

    it('POSTs chat requests to /v1/chat/completions, not /chat/completions', async () => {
        let requestedPath = null;
        server = await startServer(async (req, res) => {
            requestedPath = req.url;
            await readBody(req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        });

        const client = new LLMClient({ provider: 'ollama', model: 'llama3', baseUrl: `${server.url}/v1` });
        const result = await client.chat(null, 'hello');

        expect(requestedPath).toBe('/v1/chat/completions');
        expect(result).toBe('ok');
    });

    it('default Ollama baseUrl includes /v1', () => {
        const client = new LLMClient({ provider: 'ollama', model: 'llama3' });
        expect(client.baseUrl).toBe('http://localhost:11434/v1');
    });

    it('retries with fallbackModel on HTTP 429', async () => {
        const modelsSeen = [];
        server = await startServer(async (req, res) => {
            const body = JSON.parse(await readBody(req));
            modelsSeen.push(body.model);
            if (body.model === 'primary') {
                res.writeHead(429, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'rate limited' }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: 'fallback-ok' } }] }));
            }
        });

        const client = new LLMClient({
            provider: 'ollama', model: 'primary', fallbackModel: 'secondary', baseUrl: server.url,
        });
        const result = await client.chat(null, 'hello');

        expect(modelsSeen).toEqual(['primary', 'secondary']);
        expect(result).toBe('fallback-ok');
    });

    it('retries with backoff on transient network error, then succeeds', async () => {
        let attempts = 0;
        server = await startServer(async (req, res) => {
            attempts++;
            await readBody(req);
            if (attempts < 2) {
                req.socket.destroy();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }));
        });

        const client = new LLMClient({ provider: 'ollama', model: 'llama3', baseUrl: server.url });
        const result = await client.chat(null, 'hello');

        expect(attempts).toBe(2);
        expect(result).toBe('recovered');
    });

    it('returns null after exhausting retries', async () => {
        server = await startServer(req => { req.socket.destroy(); });

        const client = new LLMClient({ provider: 'ollama', model: 'llama3', baseUrl: server.url });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await client.chat(null, 'hello');
        errSpy.mockRestore();

        expect(result).toBeNull();
    });

    it('suppresses console.error when quiet:true', async () => {
        server = await startServer(req => { req.socket.destroy(); });

        const client = new LLMClient({ provider: 'ollama', model: 'llama3', baseUrl: server.url, quiet: true });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await client.chat(null, 'hello');

        expect(result).toBeNull();
        expect(errSpy).not.toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it('times out and returns null when the server never responds', async () => {
        server = await startServer(() => { /* never respond, never close socket */ });

        const client = new LLMClient({ provider: 'ollama', model: 'llama3', baseUrl: server.url, timeout: 50 });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const result = await client.chat(null, 'hello');
        errSpy.mockRestore();

        expect(result).toBeNull();
    }, 10000);
});

describe('detectOllamaModel', () => {
    let server;
    afterEach(() => { if (server) server.close(); });

    it('probes /api/tags at the host root, not under /v1', async () => {
        let requestedPath = null;
        server = await startServer((req, res) => {
            requestedPath = req.url;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [{ name: 'qwen3-coder' }] }));
        });

        const result = await detectOllamaModel(`${server.url}/v1`);

        expect(requestedPath).toBe('/api/tags');
        expect(result).toBe('qwen3-coder');
    });

    it('resolves null when no models are installed', async () => {
        server = await startServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: [] }));
        });

        const result = await detectOllamaModel(`${server.url}/v1`);
        expect(result).toBeNull();
    });

    it('resolves null when the server is unreachable', async () => {
        const result = await detectOllamaModel('http://127.0.0.1:1');
        expect(result).toBeNull();
    });
});

describe('LLMClient — cloud request shapes', () => {
    let server;
    afterEach(() => { if (server) server.close(); });

    it('anthropic: POSTs to /messages with x-api-key, the system prompt separate, and reads content[0].text', async () => {
        let seen;
        server = await startServer(async (req, res) => {
            seen = { url: req.url, headers: req.headers, body: JSON.parse(await readBody(req)) };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content: [{ type: 'text', text: '  {"score": 2}  ' }] }));
        });
        const client = new LLMClient({ provider: 'anthropic', apiKey: 'k-1', model: 'm', baseUrl: `${server.url}/v1`, quiet: true });
        expect(await client.chat('SYS', 'USER')).toBe('{"score": 2}');
        expect(seen.url).toBe('/v1/messages');
        expect(seen.headers['x-api-key']).toBe('k-1');
        expect(seen.headers['anthropic-version']).toBeTruthy();
        expect(seen.body).toMatchObject({ model: 'm', system: 'SYS', messages: [{ role: 'user', content: 'USER' }], temperature: 0 });
    });

    it('openrouter: sends a Bearer key and the attribution headers', async () => {
        let headers;
        server = await startServer(async (req, res) => {
            headers = req.headers;
            await readBody(req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        });
        const client = new LLMClient({ provider: 'openrouter', apiKey: 'or-key', baseUrl: server.url, appTitle: 'T', quiet: true });
        expect(client.model).toBeTruthy();              // provider default model
        expect(await client.chat(null, 'hi')).toBe('ok');
        expect(headers.authorization).toBe('Bearer or-key');
        expect(headers['x-title']).toBe('T');
        expect(headers['http-referer']).toBeTruthy();
    });

    it('a non-429 HTTP error is retried, then gives null (no fallback model involved)', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
        let calls = 0;
        server = await startServer(async (req, res) => {
            calls++;
            await readBody(req);
            res.writeHead(500); res.end('boom');
        });
        const client = new LLMClient({ provider: 'openai', apiKey: 'k', model: 'm', fallbackModel: 'f', baseUrl: server.url, quiet: true });
        expect(await client.chat(null, 'x')).toBeNull();
        expect(calls).toBe(3);
        vi.useRealTimers();
    });
});
