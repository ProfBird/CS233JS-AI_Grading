import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeLocalConfigFile } from '../src/lib/local_config_file.js';

describe('writeLocalConfigFile', () => {
    it.skipIf(process.platform === 'win32')('creates and tightens the file to owner-only', () => {
        const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lcf-')), 'local-config.json');
        fs.writeFileSync(f, '{}', { mode: 0o644 });
        writeLocalConfigFile(f, { canvas: { token: 'x' } });
        expect(fs.statSync(f).mode & 0o777).toBe(0o600);
        expect(JSON.parse(fs.readFileSync(f, 'utf8')).canvas.token).toBe('x');
    });
});
