#!/usr/bin/env node
// Usage: node rubric_to_md.js <path/to/Rubric.xlsm> [output.md]
// Writes a .md version of the Grade sheet table alongside the spreadsheet if no output path given.

import XLSX from '../lib/xlsx.js';
import fs from 'fs';
import path from 'path';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node rubric_to_md.js <path/to/Rubric.xlsm> [output.md]');
  process.exit(1);
}

const absInput = path.resolve(inputPath);
const outputPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : absInput.replace(/\.[^.]+$/, '.md');

const wb = XLSX.readFile(absInput);

function sheetRows(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

function isBlank(row) {
  return row.every(c => c === '' || c === null || c === undefined);
}

function cell(row, i) {
  return (row[i] ?? '').toString().trim();
}

function renderGrade(ws) {
  const rows = sheetRows(ws);
  const lines = [];

  const title = cell(rows[0], 0);
  if (title) lines.push(`# ${title}`, '');

  // Find the header row (contains "Possible")
  let headerRow = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some(c => /^possible$/i.test((c ?? '').toString().trim()))) {
      headerRow = i;
      break;
    }
  }

  // Find where the canned comments section starts so we can stop before it
  let tableEnd = rows.length;
  for (let i = 0; i < rows.length; i++) {
    if (/^comments$/i.test(cell(rows[i], 0))) {
      tableEnd = i;
      break;
    }
  }

  if (headerRow < 0) return lines.join('\n');

  lines.push('| Requirement | Possible | Actual | Comments |');
  lines.push('|---|---:|---:|---|');

  for (let i = headerRow + 1; i < tableEnd; i++) {
    const row = rows[i];
    if (isBlank(row)) continue;

    const label = cell(row, 0);
    if (!label) continue;

    const possible = cell(row, 1);
    const actual = cell(row, 2);
    const comment = cell(row, 4);

    const lower = label.toLowerCase();
    const isTotalLine = lower.startsWith('total') || lower.startsWith('sub-total');
    const isSectionHeader = possible === '' && actual === '' && comment === '';

    if (isSectionHeader) {
      lines.push(`| **${label}** | | | |`);
    } else if (isTotalLine) {
      lines.push(`| **${label.replace(/:$/, '')}** | **${possible}** | **${actual}** | |`);
    } else {
      lines.push(`| ${label} | ${possible} | ${actual} | ${comment} |`);
    }
  }

  return lines.join('\n');
}

const ws = wb.Sheets['Grade'];
if (!ws) {
  console.error('No "Grade" sheet found in', absInput);
  process.exit(1);
}

fs.writeFileSync(outputPath, renderGrade(ws) + '\n');
console.log(`Written: ${outputPath}`);
