#!/usr/bin/env node
// Usage: node bin/rubric-to-md.js <path/to/Rubric.xlsm> [output.md | -o output.md]
// Writes a Markdown version of the rubric's Grade sheet. Without an output path, the .md is
// written next to the spreadsheet (same name, .md extension).

import XLSX from '../src/lib/xlsx.js';
import fs from 'fs';
import path from 'path';
import { renderGradeSheet } from '../src/lib/rubric_markdown.js';

const USAGE = 'Usage: node bin/rubric-to-md.js <path/to/Rubric.xlsm> [output.md | -o output.md]';

// Positional input, then an output path given either positionally or after -o/--output.
// Any other "-…" argument is an error — never treated as a file name to write.
function parseArgs(argv) {
    const positional = [];
    let output = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') return { help: true };
        if (a === '-o' || a === '--output') {
            output = argv[++i];
            if (!output) return { error: `${a} needs an output file path` };
        } else if (a.startsWith('-')) {
            return { error: `Unknown option: ${a}` };
        } else {
            positional.push(a);
        }
    }
    if (positional.length === 0) return { error: 'No rubric spreadsheet given' };
    if (positional.length > 2 || (positional.length === 2 && output)) return { error: 'Too many arguments' };
    return { input: positional[0], output: output || positional[1] || null };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(USAGE); process.exit(0); }
if (args.error) { console.error(`${args.error}\n${USAGE}`); process.exit(1); }

const absInput = path.resolve(args.input);
const outputPath = args.output ? path.resolve(args.output) : absInput.replace(/\.[^.]+$/, '.md');

const wb = XLSX.readFile(absInput);
const ws = wb.Sheets['Grade'];
if (!ws) {
    console.error('No "Grade" sheet found in', absInput);
    process.exit(1);
}

const { markdown, foundTable } = renderGradeSheet(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }));
if (!foundTable) {
    console.error(`No header row (Possible / Points / Pts / Max) found in the Grade sheet of ${absInput}`);
    process.exit(1);
}
fs.writeFileSync(outputPath, markdown + '\n');
console.log(`Written: ${outputPath}`);
