/**
 * prompt_driver.spec.mjs
 *
 * Unit tests for the readline-backed driver in src/lib/prompt_driver.js (the piped/
 * non-TTY fallback for bin/grade.js's interactive prompts — see
 * docs/code_review_2026-07-24.md and this session's grade.js TUI-conversion plan).
 * The TUI-backed driver (src/lib/tui.js) is not covered here — neo-blessed needs a real
 * TTY and cannot be driven by injected streams; that backend is verified manually.
 *
 * These tests exercise createReadlineDriver directly against PassThrough streams,
 * asserting BOTH the resolved value and the rendered prompt text — the prompt-string
 * rule (bare label + separate `def`, decorated once by the backend) is the crux of the
 * grade.js conversion, and a doubled "[default] [default]" would be a silent UX bug that
 * no functional test alone would catch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { createReadlineDriver } from '../src/lib/prompt_driver.js';

function makeStreams() {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', c => { out += c.toString(); });
    return { input, output, getOut: () => out };
}

// Feeds a line to the driver's input stream on the next tick, so the readline
// interface's `question()` listener is already attached before it arrives.
function type(input, line) {
    setImmediate(() => input.write(line + '\n'));
}

describe('createReadlineDriver', () => {
    let driver;
    afterEach(() => { if (driver) driver.close(); });

    describe('ask', () => {
        it('returns the default on empty input and decorates the prompt with [def]', async () => {
            const { input, output, getOut } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.ask('Course display name', 'CS233JS');
            type(input, '');
            const result = await promise;

            expect(result).toBe('CS233JS');
            expect(getOut()).toContain('Course display name [CS233JS]: ');
            // Must not double-decorate — the call site passed a bare label.
            expect(getOut()).not.toContain('[CS233JS] [CS233JS]');
        });

        it('trims and returns typed input', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.ask('Term id', 'default');
            type(input, '  2026Spring  ');
            const result = await promise;

            expect(result).toBe('2026Spring');
        });

        it('returns empty string on empty input with no default (the fatal-blank contract)', async () => {
            const { input, output, getOut } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.ask('Canvas URL', '');
            type(input, '');
            const result = await promise;

            expect(result).toBe('');
            // No default -> no "[...]" decoration at all.
            expect(getOut()).toContain('Canvas URL: ');
            expect(getOut()).not.toMatch(/Canvas URL \[.*\]/);
        });
    });

    describe('askBoolean', () => {
        it.each([
            ['y', true], ['yes', true], ['Y', true],
            ['n', false], ['no', false], ['N', false],
        ])('resolves %s -> %s', async (answer, expected) => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askBoolean('Is this correct?', false);
            type(input, answer);
            expect(await promise).toBe(expected);
        });

        it('returns the default on empty input', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askBoolean('Move it now?', true);
            type(input, '');
            expect(await promise).toBe(true);
        });

        it('re-prompts on invalid input before accepting a valid answer', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askBoolean('Correct?', false);
            type(input, 'maybe');
            setTimeout(() => type(input, 'y'), 10);
            expect(await promise).toBe(true);
        });
    });

    describe('askInt', () => {
        it('rejects a negative number then accepts a valid one', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askInt('Count', 0);
            type(input, '-1');
            setTimeout(() => type(input, '3'), 10);
            expect(await promise).toBe(3);
        });

        it('returns the default on empty input', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askInt('Count', 5);
            type(input, '');
            expect(await promise).toBe(5);
        });
    });

    describe('askOptions', () => {
        const opts = [
            { label: 'Alpha', value: 'a', match: ['alpha-dir'] },
            { label: 'Beta', value: 'b' },
            { label: 'Gamma', value: null },
        ];

        it('resolves a 1-based numeric choice', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askOptions('Select a course', opts, 0);
            type(input, '2');
            expect(await promise).toBe('b');
        });

        it('resolves by label name, case-insensitive', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askOptions('Select a course', opts, 0);
            type(input, 'alpha');
            expect(await promise).toBe('a');
        });

        it('resolves by a match[] alias', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askOptions('Select a course', opts, 0);
            type(input, 'alpha-dir');
            expect(await promise).toBe('a');
        });

        it('resolves defIdx on empty input', async () => {
            const { input, output, getOut } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askOptions('Select a course', opts, 1);
            type(input, '');
            expect(await promise).toBe('b');
            expect(getOut()).toContain('[2]');
        });

        it('re-prompts on invalid input, then accepts a valid answer', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askOptions('Select a course', opts, 0);
            type(input, '99');
            setTimeout(() => type(input, '1'), 10);
            expect(await promise).toBe('a');
        });

        // Regression test for the falsy-value trap: an option whose value is null/''/false
        // must still resolve, not spin selectFromList's `while (!selected)` loop forever
        // (configure-lab.js ships a real `value: null` option for its "no AI" choice).
        it('resolves an option whose value is null, rather than hanging', async () => {
            const { input, output } = makeStreams();
            driver = createReadlineDriver({ input, output });

            const promise = driver.askOptions('Select a course', opts, 0);
            type(input, '3');
            expect(await promise).toBeNull();
        });
    });

    describe('banner', () => {
        it('prints a boxed banner containing the title text', () => {
            const { input, output, getOut } = makeStreams();
            driver = createReadlineDriver({ input, output });

            driver.banner('CS233JS AI Grader v1.0');

            expect(getOut()).toContain('CS233JS AI Grader v1.0');
            expect(getOut()).toContain('╔');
            expect(getOut()).toContain('╚');
        });
    });

    describe('note / takeNotes', () => {
        it('prints immediately and buffers for replay', () => {
            const { input, output, getOut } = makeStreams();
            driver = createReadlineDriver({ input, output });

            driver.note('Saved term "Spring 2026" to local-config.json');
            driver.print('  (not a note)');

            expect(getOut()).toContain('Saved term "Spring 2026"');
            expect(driver.takeNotes()).toEqual(['Saved term "Spring 2026" to local-config.json']);
            // Draining notes doesn't reprint or affect subsequent calls.
            expect(driver.takeNotes()).toEqual([]);
        });
    });
});
