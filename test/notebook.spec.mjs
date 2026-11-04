/**
 * notebook.spec.mjs
 *
 * Jupyter/Colab notebooks: read as Python for analysis (features, developer comments,
 * imports), and downloaded from a Colab link when that's the whole submission.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { notebookToSource, readSourceFile } from '../src/lib/notebook.js';
import { countFeatures, checkDeveloperComments } from '../src/pipeline/analyze_code.js';
import { acquireColabNotebook, colabFileId, extractStudentCode } from '../src/pipeline/extract_code.js';
import pyAdapter from '../src/adapters/python.js';

const nb = cells => JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells });
const md = source => ({ cell_type: 'markdown', metadata: {}, source });
const code = source => ({ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source });
const NOTEBOOK = nb([
    md(['# Lab 5: KMNIST\n', 'Ana Ruiz, 2/3/2026\n', 'AI used: Gemini in Colab for the plotting code\n']),
    code(['import tensorflow as tf\n', 'import tensorflow_datasets as tfds\n', 'model = tf.keras.Sequential([\n', '    tf.keras.layers.Dropout(0.2),\n', '])']),
    code('model.fit(train_images, train_labels, epochs=10)  # train'),
    { cell_type: 'raw', metadata: {}, source: 'ignored' },
]);

describe('notebookToSource', () => {
    it('turns code cells into code and markdown cells into # comments, with # %% markers', () => {
        expect(notebookToSource(NOTEBOOK)).toBe([
            '# %% [markdown]', '# # Lab 5: KMNIST', '# Ana Ruiz, 2/3/2026', '# AI used: Gemini in Colab for the plotting code', '',
            '# %%', 'import tensorflow as tf', 'import tensorflow_datasets as tfds', 'model = tf.keras.Sequential([', '    tf.keras.layers.Dropout(0.2),', '])', '',
            '# %%', 'model.fit(train_images, train_labels, epochs=10)  # train', '',
        ].join('\n'));
    });

    it('returns null for something that is not a notebook', () => {
        expect(notebookToSource('<html>Sign in</html>')).toBeNull();
        expect(notebookToSource('{"not": "a notebook"}')).toBeNull();
    });
});

describe('notebooks in analysis', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nb-')); writeFileSync(join(dir, 'lab05.ipynb'), NOTEBOOK); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('readSourceFile converts notebooks and reads other files as text', () => {
        writeFileSync(join(dir, 'a.py'), 'x = 1\n');
        expect(readSourceFile(join(dir, 'lab05.ipynb'))).toContain('model.fit(');
        expect(readSourceFile(join(dir, 'a.py'))).toBe('x = 1\n');
    });

    it('feature checks see code cells (and not the JSON escaping)', () => {
        const file = join(dir, 'lab05.ipynb');
        const counts = countFeatures([file], [
            { id: 'dropout', fileRegex: '\\.(py|ipynb)$', regex: 'layers\\.Dropout\\(' },
            { id: 'fit', fileRegex: '\\.(py|ipynb)$', match: { allOf: [{ regex: 'Sequential\\(\\[' }, { regex: 'epochs=10' }] } },
        ], pyAdapter);
        expect(counts).toEqual({ dropout: 1, fit: 1 });
    });

    it('the developer header in a markdown cell counts as name, date and AI-use disclosure', () => {
        expect(checkDeveloperComments([join(dir, 'lab05.ipynb')], 'Ana Ruiz', pyAdapter, dir).files[0])
            .toEqual({ path: 'lab05.ipynb', name: true, date: true, ai: true });
    });

    it('imports in notebooks count for the dependency check', () => {
        expect([...pyAdapter.extractUsedPackages(dir)].sort()).toEqual(['tensorflow', 'tensorflow_datasets']);
        expect(pyAdapter.sourceExtensions).toContain('.ipynb');
    });
});

describe('Colab links', () => {
    it('finds the notebook id in Colab and Drive links', () => {
        expect(colabFileId('https://colab.research.google.com/drive/1FBrABO2L1DFKRn1v0zRknHS57eiktzgm?usp=sharing')).toBe('1FBrABO2L1DFKRn1v0zRknHS57eiktzgm');
        expect(colabFileId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view')).toBe('1AbCdEfGhIjKlMnOp');
        expect(colabFileId('https://colab.research.google.com/')).toBeNull();
    });

    let root;
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'colab-')); });
    afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllGlobals(); });

    const respond = (body, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 403, text: async () => body }));

    it('downloads a publicly shared notebook as the code, clearing the "no code" error', async () => {
        const fetchImpl = respond(NOTEBOOK);
        const student = { name: 'Ana', error: 'No ZIP file, GitHub URL, or uploaded source files found' };
        const codeDir = join(root, 'extracted_code');
        const ok = await acquireColabNotebook(student, codeDir, { colab: 'https://colab.research.google.com/drive/1FBrABO2L1DFKRn1v0zRknHS57eiktzgm' }, fetchImpl);
        expect(ok).toBe(true);
        expect(fetchImpl.mock.calls[0][0]).toBe('https://drive.google.com/uc?export=download&id=1FBrABO2L1DFKRn1v0zRknHS57eiktzgm');
        expect(student.extractedDir).toBe(codeDir);
        expect(student.error).toBeUndefined();
        expect(readdirSync(codeDir)).toEqual(['colab_notebook.ipynb']);
    });

    it("explains a notebook that isn't shared publicly (Drive answers with a sign-in page)", async () => {
        const student = { name: 'Bo' };
        const ok = await acquireColabNotebook(student, join(root, 'x'), { colab: 'https://colab.research.google.com/drive/1FBrABO2L1DFKRn1v0zRknHS57eiktzgm' }, respond('<html>Sign in</html>'));
        expect(ok).toBe(false);
        expect(student.error).toMatch(/not shared as "Anyone with the link"/);
    });

    it('does nothing when code was already found, or there is no Colab link', async () => {
        const fetchImpl = respond(NOTEBOOK);
        expect(await acquireColabNotebook({ extractedDir: '/x' }, root, { colab: 'https://colab.research.google.com/drive/1FBrABO2L1DFKRn1v0zRknHS57eiktzgm' }, fetchImpl)).toBe(false);
        expect(await acquireColabNotebook({}, root, { colab: null }, fetchImpl)).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('a Moodle submission that is only a Colab link gets its notebook (with urlPatterns.colab)', async () => {
        vi.stubGlobal('fetch', respond(NOTEBOOK));
        const textDir = join(root, 'Ana_1_assignsubmission_onlinetext');
        mkdirSync(textDir, { recursive: true });
        writeFileSync(join(textDir, 'onlinetext.html'), '<p><a href="https://colab.research.google.com/drive/1FBrABO2L1DFKRn1v0zRknHS57eiktzgm">my notebook</a></p>');
        const student = { name: 'Ana', textDir, filesDir: '', zipFile: null };
        const out = join(root, 'out');
        mkdirSync(out);
        await extractStudentCode(student, root, out, { github: 'github.com', colab: 'colab.research.google.com' });
        expect(student.error).toBeUndefined();
        expect(readdirSync(student.extractedDir)).toEqual(['colab_notebook.ipynb']);
    });
});
