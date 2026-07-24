/**
 * diagnostics_aggregator.js
 *
 * Shared accumulation logic for adapters/base.js's Diagnostics shape — hand-duplicated
 * across all four language adapters (javascript.js's ESLint output, python.js's ruff JSON,
 * cpp.js's SARIF results, csharp.js's MSBuild regex matches), differing only in how each
 * caller extracts a rule code / error-vs-warning classification / friendly display name
 * from its own tool's raw output shape.
 */

/**
 * @param {Iterable} items - one entry per diagnostic (a lint message, a SARIF result, an
 *        MSBuild regex match, ...)
 * @param {Object} opts
 * @param {(item: any) => string} opts.code - the rule/diagnostic code for an item
 * @param {(item: any) => boolean} opts.isError - true for error severity, false for warning
 * @param {(code: string) => string} [opts.friendlyName] - display name for a code; defaults
 *        to the code itself
 * @returns {import('../adapters/base.js').Diagnostics}
 */
function aggregateDiagnostics(items, { code, isError, friendlyName = c => c }) {
    const ruleCounts = {}, errorRuleCounts = {}, warningRuleCounts = {};
    let errors = 0, warnings = 0;

    for (const item of items) {
        const c = code(item);
        ruleCounts[c] = (ruleCounts[c] || 0) + 1;
        if (isError(item)) {
            errors++;
            errorRuleCounts[c] = (errorRuleCounts[c] || 0) + 1;
        } else {
            warnings++;
            warningRuleCounts[c] = (warningRuleCounts[c] || 0) + 1;
        }
    }

    const toMessages = counts => Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([c, count]) => `${friendlyName(c)}: ${count}`);

    return {
        errors, warnings,
        messages: toMessages(ruleCounts),
        errorMessages: toMessages(errorRuleCounts),
        warningMessages: toMessages(warningRuleCounts),
        ruleCounts,
    };
}

export { aggregateDiagnostics };
