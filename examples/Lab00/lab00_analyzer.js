// Example custom analyzer for Lab 0.
//
// A custom analyzer is OPTIONAL. The generic pipeline already counts regex
// features (see `analysis.features` in lab00_config.json). Reach for an analyzer
// only when detection needs logic a single regex can't express.
//
// Contract: a default-exported function `(jsFiles, analysis, config, student)`
// that returns an object; the return value is merged into `student.analysis`.
// `jsFiles` is an array of absolute paths to the student's .js/.mjs files.
//
// This example flags whether any submitted file uses async/await, exposing the
// result as `analysis.usesAsync` (a mapping of type "manual"/"feature" could
// then reference it, or a report section could print it).
import fs from 'fs';

export default function lab00Analyzer(jsFiles) {
    let usesAsync = false;
    for (const file of jsFiles) {
        let code = '';
        try { code = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        if (/\basync\b/.test(code)) { usesAsync = true; break; }
    }
    return { usesAsync };
}
