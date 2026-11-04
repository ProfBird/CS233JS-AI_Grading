/**
 * runtime_check.js
 *
 * Checks student apps for runtime errors using a named check strategy, registered via
 * registerCheckStrategy() below (mirrors the mapping-handler registry pattern in
 * generate_grades.js). Built-in strategies:
 *   "none"      — no-op for labs with nothing to run (static multi-page markup labs)
 *   "browser"   — serves source index.html in headless Chrome to capture console errors
 *   "build"     — runs the language adapter's install + build steps
 *   "both"      — runs build first, then opens built dist/ in headless Chrome
 *   "run_check" — builds (if applicable) then executes the produced artifact directly,
 *                 matching stdout against configured patterns. Execution is routed through
 *                 runStudentArtifact() in ../lib/sandbox.js (the single isolation
 *                 chokepoint — see that module's header comment for the tier documentation).
 *                 Safe for JS/Python/trusted-classroom use only under the default "direct"
 *                 isolation tier, which is NOT a security sandbox.
 *
 * The method is set per-lab in the config via config.runtimeCheck. "browser" is generic
 * (any language that produces a static index.html); "build"/"run_check" and the
 * scripts_check sub-phase delegate their actual mechanics to the resolved language
 * adapter (see src/adapters/) so this file no longer hardcodes npm/ESLint specifics.
 *
 * Attaches results directly to each student object as student.runtimeCheck.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { walk } from '../lib/file_walker.js';
import { resolveAdapter } from '../adapters/index.js';
import { runStudentArtifact } from '../lib/sandbox.js';
import { configForStudent, groupUnknownWithOverrides, overriddenKeys } from '../lib/student_group.js';

const RUNTIME_REPORT = 'runtime_report.json';

// ========== Strategy registry ==========

const _strategies = new Map();
const VALID_RUNTIME_MODES = new Set();

// Registers a named runtime-check strategy. fn(student, config, ctx) => runtimeCheck result,
// where ctx = { adapter, browser } (browser is only launched when needsBrowser is true).
function registerCheckStrategy(name, fn, opts = {}) {
    _strategies.set(name, { fn, needsBrowser: !!opts.needsBrowser });
    VALID_RUNTIME_MODES.add(name);
}

function getCheckStrategy(name) {
    return _strategies.get(name);
}

// ========== Browser-based check (generic — not language-specific) ==========

// Loaded on demand (only when a browser check actually runs) so build-only labs
// don't pay Puppeteer's startup cost. Dynamic import keeps it lazy under ESM.
let puppeteer;
async function loadPuppeteer() {
    if (puppeteer === undefined) {
        try { puppeteer = (await import('puppeteer')).default; }
        catch (e) { puppeteer = null; }
    }
    return puppeteer;
}

function serveDir(dir) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            let urlPath = decodeURIComponent(req.url.split('?')[0]);
            if (urlPath === '/') urlPath = '/index.html';
            const resolved = path.resolve(path.join(dir, urlPath));
            const root = path.resolve(dir);
            if (!resolved.startsWith(root + path.sep) && resolved !== root) {
                res.writeHead(403);
                res.end('Forbidden');
                return;
            }
            const filePath = resolved;

            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
                '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
                '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
            };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
        });

        server.on('error', (err) => reject(err));
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port });
        });
    });
}

// Skips node_modules (substring match), dist, and dot-dirs when recursing.
const skipBuildDirs = (full, name) => !name.includes('node_modules') && name !== 'dist' && !name.startsWith('.');

function findAllIndexHtmlDirs(dir) {
    const results = [];
    walk(dir, {
        visit: (d, names) => { if (names.includes('index.html')) results.push(d); },
        shouldDescend: skipBuildDirs
    });
    return results;
}

// Finds dist/ subdirectories that contain index.html (used after a successful build).
// Descends into dist/ dirs so walk() can visit them directly, but does not descend
// into node_modules or dot-dirs.
function findDistIndexHtmlDirs(dir) {
    const results = [];
    walk(dir, {
        visit: (d, names) => {
            if (path.basename(d) === 'dist' && names.includes('index.html')) {
                results.push(d);
            }
        },
        shouldDescend: (full, name) => !name.includes('node_modules') && !name.startsWith('.')
    });
    return results;
}

async function runBrowserCheck(htmlDirs, browser, baseDir) {
    if (htmlDirs.length === 0) {
        return { success: false, errors: ['No index.html found'] };
    }

    const allErrors = [];
    let allSuccess = true;

    for (const htmlDir of htmlDirs) {
        const label = path.relative(baseDir || htmlDir, htmlDir) || 'root';

        let server, port;
        try {
            const result = await serveDir(htmlDir);
            server = result.server;
            port = result.port;
        } catch (err) {
            allErrors.push(`${label}: Failed to start local server`);
            allSuccess = false;
            continue;
        }

        const jsErrors = [];
        const resourceErrors = [];
        let pageLoaded = false;

        try {
            const page = await browser.newPage();

            page.on('pageerror', err => {
                jsErrors.push(err.message || String(err));
            });

            page.on('requestfailed', request => {
                const url = request.url();
                const resourceType = request.resourceType();
                if (resourceType === 'script' || resourceType === 'stylesheet') {
                    const filename = url.split('/').pop().split('?')[0];
                    resourceErrors.push(`Missing ${resourceType}: ${filename}`);
                }
            });

            const response = await page.goto(`http://127.0.0.1:${port}/`, {
                waitUntil: 'networkidle0',
                timeout: 10000
            }).catch(() => null);

            if (response && response.ok()) pageLoaded = true;

            await new Promise(r => setTimeout(r, 2000));
            await page.close();
        } catch (err) {
            jsErrors.push(`Browser check failed: ${err.message}`);
        } finally {
            server.close();
        }

        const errors = [];
        if (!pageLoaded) errors.push('index.html failed to load');
        errors.push(...resourceErrors);
        errors.push(...jsErrors);

        if (errors.length > 0) {
            allErrors.push(...errors.map(e => `${label}: ${e}`));
            allSuccess = false;
        }
    }

    return { success: allSuccess, errors: allErrors };
}

// ========== Build-based check (delegates project mechanics to the language adapter) ==========

// Kept exported for backward compatibility; defaults to the JS adapter's project detection.
function findPackageJsonDirs(dirPath, adapter = resolveAdapter({}), config = {}) {
    return adapter.detectProject(dirPath, config).map(p => p.dir);
}

async function checkBuild(extractedDir, adapter, config) {
    if (!extractedDir || !fs.existsSync(extractedDir)) {
        return { success: false, errors: [] };
    }
    const projects = adapter.detectProject(extractedDir, config);
    if (projects.length === 0) {
        return { success: false, errors: ['No package.json found'] };
    }

    const errors = [];
    let allOk = true;

    for (const project of projects) {
        const relDir = path.relative(extractedDir, project.dir) || 'root';

        if (adapter.install) {
            const installResult = await adapter.install(project, config);
            if (!installResult.success) {
                errors.push(...installResult.errors.map(e => `${relDir}: ${e}`));
                allOk = false;
                continue;
            }
        }

        const buildResult = await adapter.build(project, config);
        if (!buildResult.success) {
            errors.push(...buildResult.errors.map(e => `${relDir}: ${e}`));
            allOk = false;
        }
    }
    return { success: allOk, errors };
}

// ========== run_check: execute the built/interpreted artifact directly ==========
// Execution is delegated to the runStudentArtifact() chokepoint in ../lib/sandbox.js —
// see that module for the isolation-tier documentation (direct/restricted-user/container).
// This strategy never spawns the artifact itself.

// supportFiles entries — "Data" or { from: "GroupA-Data", to: "Data" } — resolved against
// the lab's config folder, for the sandbox to add to the run directory.
function resolveSupportFiles(entries, configDir) {
    return (entries || []).map(e => {
        const { from, to } = typeof e === 'string' ? { from: e, to: e } : { from: e.from, to: e.to ?? path.basename(e.from) };
        return { from: path.resolve(configDir || '.', from), to };
    });
}

// Which instructor support files a run or a test script gets. A run: its runCheck entry's
// supportFiles. A test script: its own testCheck entry's supportFiles, else (single-object
// runCheck only) runCheck.supportFiles — so a lab whose runCheck is a list of programs
// must give each test script its own, rather than tests silently running without data.
function supportFilesFor(config, kind) {
    const runCheck = Array.isArray(config.runCheck) ? null : config.runCheck;
    if (kind === 'test') {
        const testCheck = Array.isArray(config.testCheck) ? null : config.testCheck;
        return (testCheck && testCheck.supportFiles) || (runCheck && runCheck.supportFiles) || [];
    }
    return (runCheck && runCheck.supportFiles) || [];
}

// The sandbox options shared by run_check and test_check. With execution.cwd "copy" the
// program runs in a copy of its project folder (plus support files) instead of an empty
// directory — what a program that opens files relative to its project folder needs.
function execOptionsFor(project, config, ctx, kind = 'run') {
    const executionConfig = config.execution || {};
    const copying = executionConfig.cwd === 'copy';
    return {
        mode: executionConfig.mode,
        cwdSource: copying ? project.dir : null,
        supportFiles: resolveSupportFiles(supportFilesFor(config, kind), ctx.configDir),
        env: project.env || {},
    };
}

// When running in a copy of the project, argv paths inside the project folder must point at
// the copy — i.e. be relative to it (the copy is the working directory).
function argvForCopy(argv, project) {
    return argv.map(a => (typeof a === 'string' && a.startsWith(project.dir + path.sep) ? path.relative(project.dir, a) : a));
}

// Installs a project's dependencies when the adapter knows how (e.g. a uv environment for a
// Python project). Returns an error list, empty on success.
async function installIfNeeded(adapter, project, config) {
    if (!adapter.install) return [];
    const result = await adapter.install(project, config);
    return result.success ? [] : (result.errors.length ? result.errors : ['Dependency install failed']);
}

// runCheck may be one run (an object) or several (an array of runs, each with an `id`) —
// e.g. CS212 Lab01's two separate programs. Several runs give
// { success: every run passed, errors: each prefixed "[id]", runs: { [id]: result } };
// a run_check mapping with `runId` scores just that run.
// The end of stderr — where a Python traceback's actual error line ("EOFError: …",
// "FileNotFoundError: …") is — rather than its start.
function stderrTail(stderr, maxLines = 3, maxChars = 300) {
    const tail = stderr.trim().split(/\r?\n/).slice(-maxLines).join(' | ');
    return tail.length > maxChars ? '…' + tail.slice(-maxChars) : tail;
}

registerCheckStrategy('run_check', async (student, config, ctx) => {
    if (!Array.isArray(config.runCheck)) return runOneProgram(student, config, ctx);
    const runs = {};
    const errors = [];
    for (const run of config.runCheck) {
        const result = await runOneProgram(student, { ...config, runCheck: run }, ctx);
        runs[run.id] = result;
        errors.push(...result.errors.map(e => `[${run.id}] ${e}`));
    }
    return { success: Object.values(runs).every(r => r.success), errors, runs };
});

async function runOneProgram(student, config, ctx) {
    const { adapter } = ctx;
    const projects = adapter.detectProject(student.extractedDir, config);
    if (projects.length === 0) return { success: false, errors: ['No runnable project found'] };
    // Prefer a project the adapter has tagged executable (e.g. csharp.js's OutputType=Exe
    // check, so a class-library/test project in the same solution isn't picked over the
    // actual console app); adapters that don't tag this (cpp/python) fall back to [0].
    const project = projects.find(p => p.executable) || projects[0];
    // Students name files freely; a program that can't be found is for the grader to look at,
    // not an automatic zero.
    if (project.entryError) return { success: false, errors: [`NEEDS MANUAL CHECK: ${project.entryError}`], entryNotFound: true };

    const installErrors = await installIfNeeded(adapter, project, config);
    if (installErrors.length) return { success: false, errors: installErrors };

    let artifactPath = project.artifactPath;
    if (!project.runCommand && adapter.build) {
        const buildResult = await adapter.build(project, config);
        if (!buildResult.success) return { success: false, errors: buildResult.errors };
        artifactPath = buildResult.artifactPath || artifactPath;
    }

    let runCommand = project.runCommand || (artifactPath ? [artifactPath] : null);
    if (!runCommand) return { success: false, errors: ['No run command available for this project'] };

    const runConfig = config.runCheck || {};
    const executionConfig = config.execution || {};
    const execOptions = execOptionsFor(project, config, ctx);
    if (execOptions.cwdSource) runCommand = argvForCopy(runCommand, project);
    const result = await runStudentArtifact(runCommand, {
        ...execOptions,
        stdin: runConfig.stdin || '',
        timeoutMs: runConfig.timeoutMs || executionConfig.timeoutMs || 10000,
    });

    const errors = [];
    if (result.setupError) errors.push(result.stderr);
    else if (result.timedOut) errors.push('Program timed out (possible infinite loop or unclosed stdin read)');
    else if (result.code !== 0) errors.push(`Exited with code ${result.code}${result.stderr ? `: ${stderrTail(result.stderr)}` : ''}`);

    for (const pattern of (runConfig.expectPatterns || [])) {
        if (!new RegExp(pattern).test(result.stdout)) errors.push(`Expected output pattern not found: ${pattern}`);
    }

    return { success: errors.length === 0, errors, stdout: (result.stdout || '').slice(0, 2000) };
}

// ========== Scripts check (delegates script execution to the language adapter) ==========

// Scripts that start persistent servers — verify they're defined, never run them.
// This is pipeline-level policy (which script *names* are unsafe to actually execute),
// not something the adapter itself has an opinion about.
const SERVER_SCRIPTS = new Set(['dev', 'start', 'serve', 'watch', 'preview']);

// Kept exported for backward compatibility; defaults to the JS adapter.
async function runNpmScript(pkgDir, scriptName, adapter = resolveAdapter({})) {
    return adapter.runScript({ dir: pkgDir }, scriptName, { verifyOnly: SERVER_SCRIPTS.has(scriptName) });
}

// Checks a set of scripts for a student's extracted code, using the resolved adapter.
// Installs dependencies first if not already present. Returns
// { scripts: { [name]: { defined, ran, passed, error } } } or { error: string }.
async function checkStudentScripts(extractedDir, scriptNames, adapter = resolveAdapter({}), config = {}) {
    if (!extractedDir || !fs.existsSync(extractedDir)) {
        return { error: 'No extracted code directory' };
    }
    if (!adapter.runScript) {
        return { error: `Named scripts are not applicable for the "${adapter.language}" language` };
    }
    const projects = adapter.detectProject(extractedDir, config);
    if (projects.length === 0) return { error: 'No package.json found' };

    const project = projects[0];

    if (adapter.install && !fs.existsSync(path.join(project.dir, 'node_modules'))) {
        const installResult = await adapter.install(project, config);
        if (!installResult.success) return { error: 'npm install failed' };
    }

    const scripts = {};
    for (const name of scriptNames) {
        scripts[name] = await adapter.runScript(project, name, { verifyOnly: SERVER_SCRIPTS.has(name) });
    }
    return { scripts };
}

// ========== Test check (delegates to the language adapter's test runner) ==========

// Runs when at least one test_check mapping is configured and the adapter supports
// running tests (pytest/dotnet test/CTest — wired up per-language in later phases).
// Dependencies are installed first (a cached environment makes this free after run_check),
// and the adapter gets the same sandbox options run_check uses (project copy, support files).
async function checkStudentTests(extractedDir, adapter, config = {}, ctx = {}) {
    if (!extractedDir) return { error: 'No code extracted' };
    // Several test scripts (testCheck as an array of entries with an `id`): totals add up across
    // scripts; one script that can't run counts as a failure line, never hiding the others.
    // A test_check mapping with `testId` scores just that script (from `runs`).
    if (Array.isArray(config.testCheck)) {
        const runs = {};
        const combined = { total: 0, passed: 0, failures: [] };
        for (const t of config.testCheck) {
            const r = await checkStudentTests(extractedDir, adapter, { ...config, testCheck: t }, ctx);
            runs[t.id] = r;
            if (r.error) {
                combined.total += 1;
                combined.failures.push(`[${t.id}] ${r.error}`);
            } else {
                combined.total += r.total;
                combined.passed += r.passed;
                combined.failures.push(...(r.failures || []).map(f => `[${t.id}] ${f}`));
            }
        }
        return { ...combined, runs };
    }
    if (!adapter.runTests) return { error: `Test running is not supported for the "${adapter.language}" language yet` };
    const projects = adapter.detectProject(extractedDir, config);
    if (projects.length === 0) return { error: 'No project found' };
    const project = projects[0];
    const installErrors = await installIfNeeded(adapter, project, config);
    if (installErrors.length) return { error: installErrors.join('; ') };
    return adapter.runTests(project, config, execOptionsFor(project, config, ctx, 'test'));
}

// ========== Built-in strategies ==========

// No-op strategy for labs with nothing to run — e.g. static multi-page HTML/CSS sites
// (CIS195) that need neither a build nor a Puppeteer pass. runtimeCheck is a required
// config key, so markup-only labs set "none" rather than paying for a browser check.
registerCheckStrategy('none', async (student) => {
    console.log(`  SKIP: ${student.name}: runtime check disabled ("none")`);
    return { success: true, skipped: true, errors: [] };
});

registerCheckStrategy('build', async (student, config, ctx) => {
    const result = await checkBuild(student.extractedDir, ctx.adapter, config);
    if (result.success) {
        console.log(`  OK: ${student.name}: Build successful`);
    } else {
        console.log(`  FAIL: ${student.name}: Build failed (${result.errors.join(', ')})`);
    }
    return result;
});

registerCheckStrategy('browser', async (student, config, ctx) => {
    const htmlDirs = findAllIndexHtmlDirs(student.extractedDir);
    const result = await runBrowserCheck(htmlDirs, ctx.browser, student.extractedDir);
    if (result.success) {
        console.log(`  OK: ${student.name}: No console errors`);
    } else {
        console.log(`  FAIL: ${student.name}: ${result.errors.join('; ')}`);
    }
    return result;
}, { needsBrowser: true });

registerCheckStrategy('both', async (student, config, ctx) => {
    // Build first, then browser-check the built dist/. Build and browser results are
    // stored as separate fields so that build_check and browser_check mappings can
    // score them independently.
    const buildResult = await checkBuild(student.extractedDir, ctx.adapter, config);
    if (!buildResult.success) {
        console.log(`  FAIL: ${student.name}: Build failed (${buildResult.errors.join(', ')})`);
        return {
            success: false,
            buildSuccess: false,
            buildErrors: buildResult.errors,
            browserSuccess: null,
            browserErrors: [],
            errors: buildResult.errors
        };
    }
    const distDirs = findDistIndexHtmlDirs(student.extractedDir);
    const browserResult = await runBrowserCheck(distDirs, ctx.browser, student.extractedDir);
    if (browserResult.success) {
        console.log(`  OK: ${student.name}: Build and browser checks passed`);
    } else {
        console.log(`  FAIL: ${student.name}: ${browserResult.errors.join('; ')}`);
    }
    return {
        success: browserResult.success,
        buildSuccess: true,
        buildErrors: [],
        browserSuccess: browserResult.success,
        browserErrors: browserResult.errors,
        errors: browserResult.errors
    };
}, { needsBrowser: true });

// ========== Main export ==========

// configDir: the lab's (or step's) config folder — runCheck.supportFiles resolve against it.
export default async function(students, config, labDir, configDir = null) {
    const adapter = resolveAdapter(config);
    const mode = config.runtimeCheck || 'build';
    const strategy = getCheckStrategy(mode);
    console.log(`--- Runtime Check Phase (${mode} mode) ---`);

    if (!strategy) {
        console.error(`  ERROR: Unknown runtimeCheck mode "${mode}". Registered: ${[...VALID_RUNTIME_MODES].join(', ')}`);
        students.forEach(s => { s.runtimeCheck = { success: false, errors: [`Unknown runtimeCheck mode "${mode}"`] }; });
        return;
    }

    if (strategy.needsBrowser) await loadPuppeteer();
    if (strategy.needsBrowser && !puppeteer) {
        console.error('  ERROR: Puppeteer not installed. Run: npm install puppeteer');
        students.forEach(s => {
            s.runtimeCheck = { success: false, errors: ['Puppeteer not installed'] };
        });
        return;
    }

    let browser;
    if (strategy.needsBrowser) {
        try {
            browser = await puppeteer.launch({ headless: 'shell' });
        } catch (e) {
            console.error(`  ERROR: Could not launch Chrome: ${e.message}`);
            console.error(`  Fix: npx puppeteer browsers install chrome-headless-shell`);
            students.forEach(s => {
                s.runtimeCheck = { success: false, errors: ['Chrome could not be launched'] };
            });
            fs.writeFileSync(path.join(labDir, RUNTIME_REPORT), JSON.stringify(
                students.map(s => ({ student: s.name, success: false, errors: s.runtimeCheck.errors })),
                null, 2
            ));
            return;
        }
    }

    const ctx = { adapter, browser, configDir };
    // When a lab group overrides run/test settings, a student whose group is unknown has no
    // right settings to run with: flag them for manual review rather than run another
    // group's program checks and score that failure.
    // Each check is skipped only when a setting IT reads differs by group (matches
    // student_group.js's MAPPING_TYPES_BY_KEY): a run reads runCheck/execution; tests also
    // read testCheck.
    const overridden = overriddenKeys(config);
    const runByGroup = overridden.some(k => ['runCheck', 'execution'].includes(k));
    const testsByGroup = overridden.some(k => ['runCheck', 'execution', 'testCheck'].includes(k));
    const groupUnknown = (student, byGroup) => byGroup && groupUnknownWithOverrides(config, student);
    const groupUnknownMessage = student =>
        `NEEDS MANUAL CHECK: lab group unknown (${(student.group && student.group.reason) || 'no group'}) — run settings differ by group`;
    for (const student of students) {
        if (!student.extractedDir || !fs.existsSync(student.extractedDir) || student.error) {
            student.runtimeCheck = { success: false, errors: [] };
            continue;
        }
        if (groupUnknown(student, runByGroup)) {
            student.runtimeCheck = { success: false, errors: [groupUnknownMessage(student)], groupUnknown: true };
            continue;
        }
        student.runtimeCheck = await strategy.fn(student, configForStudent(config, student), ctx);
    }

    if (browser) await browser.close();

    // Scripts check — runs independently of the build/browser mode.
    // Only runs when at least one scripts_check mapping is configured.
    const scriptsCheckMappings = (config.mappings || []).filter(m => m.type === 'scripts_check');
    if (scriptsCheckMappings.length > 0) {
        const allScriptNames = [...new Set(
            scriptsCheckMappings.flatMap(m => {
                const s = m.scripts;
                if (Array.isArray(s)) return s;
                return (s || 'dev,build,test').split(',').map(x => x.trim()).filter(Boolean);
            })
        )];
        console.log(`--- Scripts Check (${allScriptNames.join(', ')}) ---`);
        for (const student of students) {
            if (!student.extractedDir || student.error) {
                student.scriptsCheck = { error: 'No code extracted' };
                continue;
            }
            student.scriptsCheck = await checkStudentScripts(student.extractedDir, allScriptNames, adapter, config);
            const sc = student.scriptsCheck;
            if (sc.error) {
                console.log(`  FAIL: ${student.name}: ${sc.error}`);
            } else {
                const passing = allScriptNames.filter(s => sc.scripts[s]?.passed);
                const label   = passing.length === allScriptNames.length ? 'OK' : `PARTIAL (${passing.length}/${allScriptNames.length})`;
                console.log(`  ${label}: ${student.name}: ${passing.join(', ') || 'none passed'}`);
            }
        }
    }

    // Test check — runs independently of the build/browser mode. Only runs when at
    // least one test_check mapping is configured.
    const testCheckMappings = (config.mappings || []).filter(m => m.type === 'test_check');
    if (testCheckMappings.length > 0) {
        console.log(`--- Test Check ---`);
        for (const student of students) {
            if (!student.extractedDir || student.error) {
                student.testCheck = { error: 'No code extracted' };
                continue;
            }
            if (groupUnknown(student, testsByGroup)) {
                student.testCheck = { error: groupUnknownMessage(student), groupUnknown: true };
                console.log(`  SKIP: ${student.name}: lab group unknown`);
                continue;
            }
            student.testCheck = await checkStudentTests(student.extractedDir, adapter, configForStudent(config, student), ctx);
            const tc = student.testCheck;
            if (tc.error) {
                console.log(`  FAIL: ${student.name}: ${tc.error}`);
            } else {
                console.log(`  ${student.name}: ${tc.passed}/${tc.total} tests passed`);
            }
        }
    }

    const report = students.map(s => {
        const entry = {
            student:  s.name,
            success:  s.runtimeCheck ? s.runtimeCheck.success : false,
            errors:   s.runtimeCheck ? s.runtimeCheck.errors  : [],
        };
        if (s.scriptsCheck) entry.scriptsCheck = s.scriptsCheck;
        if (s.testCheck) entry.testCheck = s.testCheck;
        return entry;
    });
    fs.writeFileSync(path.join(labDir, RUNTIME_REPORT), JSON.stringify(report, null, 2));
    console.log(`Created ${RUNTIME_REPORT} for ${report.length} students.`);
};

export {
    findAllIndexHtmlDirs, findDistIndexHtmlDirs, findPackageJsonDirs, runNpmScript, checkStudentScripts,
    registerCheckStrategy, getCheckStrategy, VALID_RUNTIME_MODES, checkStudentTests,
};
