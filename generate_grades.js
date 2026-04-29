/**
 * generate_grades.js
 * 
 * Generates graded spreadsheets for each student based on the config cell mappings
 * and the outputs of the analysis and linting phases.
 */

const fs = require('fs');
const path = require('path');
let xlsx;
try {
    xlsx = require('xlsx');
} catch(e) {
    console.error("Please run `npm install xlsx` in AI_Grading directory.");
    process.exit(1);
}
const { getAvailableModel, generateSummary: ollamaGenerateSummary } = require('./ollama_comments');

function setCellValue(sheet, cellRef, value) {
    sheet[cellRef] = { v: value, t: typeof value === 'number' ? 'n' : 's' };
}

function forceRecalc(sheet) {
    for (const ref of Object.keys(sheet)) {
        if (ref[0] === '!') continue;
        const cell = sheet[ref];
        if (cell.f && typeof cell.v === 'number') {
            delete cell.v;
        }
    }
}

module.exports = async function(analysisReport, lintReport, runtimeReport, config, labDir, opts = {}) {
    console.log("--- Grade Generation Phase ---");

    let aiModel = null;
    if (opts.aiComments) {
        const detected = await getAvailableModel();
        if (!detected) {
            console.warn('  WARNING: --ai-comments requested but Ollama not reachable or no models installed; using fallback text.');
        } else {
            aiModel = opts.aiModel || detected;
            const source = opts.aiModel ? 'specified' : 'auto-detected';
            console.log(`  AI comments: using model "${aiModel}" (${source}).`);
        }
    }

    const rubricPath = path.join(labDir, config.rubricName);
    const isXlsm = rubricPath.toLowerCase().endsWith('.xlsm');
    if (!fs.existsSync(rubricPath)) {
        console.error(`ERROR: Rubric file not found at ${rubricPath}`);
        return;
    }

    const summary = { successful: [], errors: [] };
    let generated = 0;
    let skipped = 0;

    for (const entry of analysisReport) {
        const student = entry.student;
        const results = entry.results;

        // Use filesDir from the analysis report (resolved by extract_code.js)
        let filesDir = entry.filesDir || null;

        if (!filesDir) {
            console.log(`  SKIP: ${student} - no _file directory found`);
            summary.errors.push({ student, issue: 'No _file directory found.' });
            skipped++;
            continue;
        }

        try {
            const wb = xlsx.readFile(rubricPath);
            const sheet = wb.Sheets['Grade'];

            if (config.titleCell && config.titleText) {
                setCellValue(sheet, config.titleCell, config.titleText);
            }

            if (config.summaryCell) {
                let summaryText;
                if (results.error) {
                    summaryText = `Issue: ${results.error}`;
                } else if (aiModel) {
                    const lintEntry = lintReport.find(l => l.student === student) || { errors: 0, warnings: 0, messages: [] };
                    const runtimeEntry = runtimeReport.find(b => b.student === student) || { success: false, errors: [] };
                    process.stdout.write(`    Generating AI summary for ${student}... `);
                    const aiResult = await ollamaGenerateSummary({
                        model: aiModel,
                        student,
                        features: results.features || {},
                        lintErrors: lintEntry.errors,
                        lintWarnings: lintEntry.warnings,
                        lintTopIssues: lintEntry.messages || [],
                        runtimeSuccess: runtimeEntry.success,
                        runtimeErrors: runtimeEntry.errors || []
                    });
                    if (aiResult) {
                        console.log('OK');
                        summaryText = aiResult;
                    } else {
                        console.log('FAILED (Ollama returned no result; using fallback)');
                        summaryText = 'Pending manual checks for full verification.';
                    }
                } else {
                    summaryText = 'Pending manual checks for full verification.';
                }
                setCellValue(sheet, config.summaryCell, summaryText);
            }

            const lintEntry = lintReport.find(l => l.student === student) || { errors: 0, warnings: 0, jsFiles: 0, messages: [] };
            const runtimeEntry = runtimeReport.find(b => b.student === student) || { success: false, errors: ['No runtime data'] };

            // If code could not be extracted, write the reason to the relevant cell and mark everything else N/A
            if (results.extractionError) {
                for (const map of config.mappings) {
                    const isCodeSourceMap = map.type === 'apps_in_repo' ||
                        map.type === 'part1_completed' ||
                        (map.type === 'url_check' && map.urlType === 'github');
                    if (isCodeSourceMap) {
                        setCellValue(sheet, map.cell, 0);
                        if (map.commentCell) setCellValue(sheet, map.commentCell, `ERROR: ${results.extractionError}`);
                    } else {
                        if (map.cell) setCellValue(sheet, map.cell, 0);
                        if (map.commentCell) setCellValue(sheet, map.commentCell, 'N/A (code unavailable)');
                    }
                }
                // Also mark part feature cells N/A
                if (config.parts) {
                    for (const part of config.parts) {
                        if (!part.featureCounts) continue;
                        for (const fc of part.featureCounts) {
                            if (fc.cell) setCellValue(sheet, fc.cell, 0);
                            if (fc.commentCell) setCellValue(sheet, fc.commentCell, 'N/A (code unavailable)');
                        }
                    }
                }
                // Write the grade file and move to next student
                if (!isXlsm) {
                    wb.SheetNames = ['Grade'];
                    wb.Sheets = { 'Grade': sheet };
                }
                forceRecalc(sheet);
                const outputExt = isXlsm ? '.xlsm' : '.xlsx';
                const outputPath = path.join(filesDir, `${student}_Grade${outputExt}`);
                xlsx.writeFile(wb, outputPath, isXlsm ? { bookType: 'xlsm' } : undefined);
                console.log(`  PARTIAL: ${student} -> ${path.basename(outputPath)} (extraction failed)`);
                summary.successful.push(student);
                generated++;
                continue;
            }

            for (const map of config.mappings) {
                let score = 0;
                let comment = '';

                switch (map.type) {
                    case 'feature':
                        const count = (results.features && typeof results.features[map.featureId] === 'number') 
                                        ? results.features[map.featureId] 
                                        : (results.features && results.features[map.featureId] ? 1 : 0);
                        const minRequired = map.minCount || 1;
                        if (count >= minRequired) {
                            score = map.maxScore;
                            comment = map.successMsg ? `${map.successMsg} (${count} found)` : `Yes (${count} found)`;
                        } else {
                            score = 0;
                            comment = map.failMsg ? `${map.failMsg} (only ${count} found)` : `Missing (only ${count} found)`;
                        }
                        break;
                    case 'part1_completed':
                        if (results.part1Completed) {
                            score = map.maxScore;
                            comment = 'Part 1 files found';
                        } else {
                            score = 0;
                            comment = 'Part 1 files not found';
                        }
                        break;
                    case 'apps_in_repo':
                        if (results.bothAppsPresent && results.urls && results.urls.github) {
                            score = map.maxScore;
                            comment = 'Yes (Both apps found in GitHub repo)';
                        } else if (!results.urls || !results.urls.github) {
                            score = 0;
                            comment = 'Missing GitHub repository';
                        } else {
                            score = 0;
                            comment = `Missing folders (Part 1: ${results.part1Completed ? 'Yes' : 'No'}, Part 2: ${results.part2Completed ? 'Yes' : 'No'})`;
                        }
                        break;
                    case 'developer_comments':
                        if (results.hasDeveloperComments) {
                            score = map.maxScore;
                            comment = 'Yes';
                        } else {
                            score = 0;
                            comment = 'Missing name/date comments';
                        }
                        break;
                    case 'code_review':
                        if (results.hasCodeReview) {
                            score = map.maxScore;
                            comment = 'Yes';
                        } else {
                            score = 0;
                            comment = 'Not found in submission';
                        }
                        break;
                    case 'url_check':
                        const url = results.urls && results.urls[map.urlType];
                        if (url) {
                            score = ''; // leave blank for manual grading
                            comment = `NEEDS CHECK: ${url}`;
                        } else {
                            score = 0;
                            comment = `No ${map.urlType} URL provided`;
                        }
                        break;
                    case 'lint':
                        if (lintEntry.jsFiles > 0) {
                            const totalIssues = lintEntry.errors + lintEntry.warnings;
                            if (totalIssues === 0) {
                                score = map.maxScore;
                                comment = 'Excellent - no lint issues';
                            } else if (totalIssues <= 10) {
                                score = map.maxScore;
                                comment = `Good - ${totalIssues} minor issues (${lintEntry.messages.slice(0, 3).join(', ')})`;
                            } else if (totalIssues <= 30) {
                                score = Math.max(1, Math.floor(map.maxScore / 2));
                                comment = `${totalIssues} issues (${lintEntry.messages.slice(0, 3).join(', ')})`;
                            } else {
                                score = 0;
                                comment = `${totalIssues} issues (${lintEntry.messages.slice(0, 3).join(', ')})`;
                            }
                        } else {
                            score = '';
                            comment = 'No JS files to lint';
                        }
                        break;
                    case 'build_check':
                        if (runtimeEntry.success) {
                            score = map.maxScore;
                            comment = 'No runtime errors';
                        } else {
                            score = 0;
                            comment = `Errors found: ${runtimeEntry.errors.join(', ')}`;
                        }
                        break;
                    case 'manual':
                        score = map.maxScore || '';
                        comment = map.msg || 'NEEDS MANUAL CHECK';
                        break;
                    default:
                        score = 0;
                        comment = `ERROR: Unknown mapping type "${map.type}" — check config`;
                        console.warn(`  WARNING: Unknown map.type "${map.type}" for ${student}`);
                        break;
                }

                if (map.cell) setCellValue(sheet, map.cell, score);
                if (map.commentCell) setCellValue(sheet, map.commentCell, comment);
                if (map.linkCell && map.linkUrlType && results.urls && results.urls[map.linkUrlType]) {
                    setCellValue(sheet, map.linkCell, results.urls[map.linkUrlType]);
                }
            }

            // Per-part feature counts (e.g. classes in part1 vs part2)
            if (config.parts && results.partFeatures) {
                for (const part of config.parts) {
                    const partCounts = results.partFeatures[part.id];
                    if (!part.featureCounts) continue;
                    for (const fc of part.featureCounts) {
                        let count, comment, score;
                        if (partCounts === null) {
                            // Folder for this part was not found
                            score = 0;
                            comment = `${fc.failMsg || 'Missing'} (folder not found)`;
                        } else {
                            count = partCounts[fc.featureId] || 0;
                            const minRequired = fc.minCount || 1;
                            if (count >= minRequired) {
                                score = fc.maxScore;
                                comment = fc.successMsg ? `${fc.successMsg} (${count} found)` : `Yes (${count} found)`;
                            } else {
                                score = 0;
                                comment = fc.failMsg ? `${fc.failMsg} (only ${count} found)` : `Missing (only ${count} found)`;
                            }
                        }
                        if (fc.cell) setCellValue(sheet, fc.cell, score);
                        if (fc.commentCell) setCellValue(sheet, fc.commentCell, comment);
                    }
                }
            }

            // Keep only the 'Grade' sheet (skip for .xlsm — preserve macros and other sheets)
            if (!isXlsm) {
                wb.SheetNames = ['Grade'];
                wb.Sheets = { 'Grade': sheet };
            }
            forceRecalc(sheet);

            const outputExt = isXlsm ? '.xlsm' : '.xlsx';
            const outputPath = path.join(filesDir, `${student}_Grade${outputExt}`);
            xlsx.writeFile(wb, outputPath, isXlsm ? { bookType: 'xlsm' } : undefined);
            console.log(`  OK: ${student} -> ${path.basename(outputPath)}`);
            summary.successful.push(student);
            generated++;

        } catch (err) {
            console.log(`  ERROR: ${student} - ${err.message}`);
            summary.errors.push({ student, issue: `Spreadsheet generation error: ${err.message}` });
            skipped++;
        }
    }

    console.log(`\nGenerated ${generated} spreadsheets, skipped ${skipped}.`);
    return summary;
};
