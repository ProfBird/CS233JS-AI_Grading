// Lab02: modules feature requires BOTH import and export statements.
// countFeatures only counts import matches; this overrides with a boolean AND check.
const fs = require('fs');

module.exports = function(jsFiles, analysis) {
    let hasImport = false;
    let hasExport = false;
    for (const js of jsFiles) {
        let content;
        try { content = fs.readFileSync(js, 'utf8'); } catch (e) { continue; }
        if (content.match(/import\s+.*from/)) hasImport = true;
        if (content.match(/export\s+/)) hasExport = true;
        if (hasImport && hasExport) break;
    }
    analysis.features.modules = (hasImport && hasExport) ? 1 : 0;
    return null;
};
