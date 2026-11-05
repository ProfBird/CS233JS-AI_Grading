#!/usr/bin/env node
// Copies a lab's instructor check scripts (Group<X>/drivers in the course-materials repo) into the
// grader's lab config folder. `--check` only reports differences (exit 1 if any).
//   node bin/sync-drivers.js <course-materials lab folder> <lab config folder> [--check]
import path from 'path';
import { syncDrivers } from '../src/lib/sync_drivers.js';

const args = process.argv.slice(2);
const check = args.includes('--check');
const [source, dest] = args.filter(a => !a.startsWith('--'));
if (!source || !dest) {
    console.error('Usage: node bin/sync-drivers.js <lab folder with Group<X>/drivers> <lab config folder> [--check]');
    process.exit(2);
}
const { groups, differences } = syncDrivers(path.resolve(source), path.resolve(dest), { check });
console.log(`${groups.length} group(s): ${groups.join(', ') || '(none)'}`);
if (differences.length === 0) console.log('Already in sync.');
else console.log(`${check ? 'Out of sync' : 'Updated'}: ${differences.join(', ')}`);
process.exit(check && differences.length ? 1 : 0);
