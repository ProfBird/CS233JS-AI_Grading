/**
 * rubric_markdown.spec.mjs
 *
 * bin/rubric-to-md.js's renderer. Regression: the old renderer looked only for a header
 * cell reading exactly "Possible", so rubrics headed "Points" (all of CS212's, and CS233JS
 * Lab01/Lab02/TermProject Final) produced just a title line; it also ignored sub-rows
 * labeled in column B and read comments from the wrong column.
 */
import { describe, it, expect } from 'vitest';
import { renderGradeSheet } from '../src/lib/rubric_markdown.js';

describe('renderGradeSheet', () => {
    it('renders a "Points"-headed rubric (CS212 layout)', () => {
        const rows = [
            ['Lab 1: Python Review'],
            ['Requirements', 'Points', 'Actual', '', 'Comments', ''],
            ['Code review with "Prod" column completed', 2, 2, '', 'Yes', 'Yes'],
            ['Translated App', '', '', '', '', ''],
            ['Has all functionality of original', 5, 5, '', 'Yes', ''],
            ['Total:', 50, 50, '', '', ''],
            ['Comments'],
            ['Excellent!'],
        ];
        const { markdown, foundTable } = renderGradeSheet(rows);
        expect(foundTable).toBe(true);
        expect(markdown).toBe([
            '# Lab 1: Python Review', '',
            '| Requirement | Points | Actual | Comments |',
            '|---|---:|---:|---|',
            '| Code review with "Prod" column completed | 2 | 2 | Yes |',
            '| **Translated App** | | | |',
            '| Has all functionality of original | 5 | 5 | Yes |',
            '| **Total** | **50** | **50** | |',
        ].join('\n'));
    });

    it('reads sub-rows labeled in column B, and a comment one column right of "Comments"', () => {
        const rows = [
            ['Lab 6'],
            ['Requirements:', '', 'Possible', 'Score', '', 'Comments', ''],
            ['Web API Call', '', '', '', '', '', ''],
            ['', 'fetch used with .then or await', 5, 5, '', '', 'Yes'],
        ];
        const { markdown } = renderGradeSheet(rows);
        expect(markdown).toContain('| **Web API Call** | | | |');
        expect(markdown).toContain('| fetch used with .then or await | 5 | 5 | Yes |');
    });

    it('reports when no header row is found', () => {
        expect(renderGradeSheet([['Just a title'], ['no header here']])).toEqual({ markdown: '# Just a title\n', foundTable: false });
    });
});
