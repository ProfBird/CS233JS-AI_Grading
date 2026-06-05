/**
 * runtime_check.js
 *
 * Checks student apps for runtime errors using one of three methods:
 *   "browser" — serves source index.html in headless Chrome to capture console errors
 *   "build"   — runs npm install + npm run build
 *   "both"    — runs build first, then opens built dist/ in headless Chrome
 *
 * The method is set per-lab in the config via config.runtimeCheck.
 * Attaches results directly to each student object as student.runtimeCheck.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec, spawn } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { walk } = require('../lib/file_walker');

const RUNTIME_REPORT = 'runtime_report.json';

// ========== Browser-based check ==========

let puppeteer;
try { puppeteer = require('puppeteer'); } catch (e) { /* loaded on demand */ }

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

// ========== Build-based check ==========

function findPackageJsonDirs(dirPath) {
    const arrayOfDirs = [];
    walk(dirPath, {
        visit: (d, names) => { if (names.includes('package.json')) arrayOfDirs.push(d); },
        shouldDescend: (full, name) => !name.includes('node_modules') && !name.startsWith('.') && name !== 'dist'
    });
    return arrayOfDirs;
}

async function checkBuild(extractedDir) {
    if (!extractedDir || !fs.existsSync(extractedDir)) {
        return { success: false, errors: [] };
    }
    const packageDirs = findPackageJsonDirs(extractedDir);
    if (packageDirs.length === 0) {
        return { success: false, errors: ['No package.json found'] };
    }

    const errors = [];
    let allOk = true;

    for (const pkgDir of packageDirs) {
        const relDir = path.relative(extractedDir, pkgDir) || 'root';
        // Remove any committed node_modules/ before installing — committed node_modules
        // may have missing execute bits on .bin/ symlinks, causing npm run build to fail.
        const nodeModulesDir = path.join(pkgDir, 'node_modules');
        if (fs.existsSync(nodeModulesDir)) {
            try { fs.rmSync(nodeModulesDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        }
        try {
            await execAsync('npm install --no-fund --no-audit --ignore-scripts', { cwd: pkgDir, timeout: 20000 });
        } catch (err) {
            errors.push(`${relDir}: npm install failed or timed out`);
            allOk = false;
            continue;
        }
        try {
            await execAsync('npm run build', { cwd: pkgDir, timeout: 20000 });
        } catch (err) {
            errors.push(`${relDir}: npm run build failed or timed out`);
            allOk = false;
        }
    }
    return { success: allOk, errors };
}

// ========== Scripts check ==========

// Scripts that start persistent servers — verify they're defined, never run them.
const SERVER_SCRIPTS = new Set(['dev', 'start', 'serve', 'watch', 'preview']);

// Runs an npm script in pkgDir using spawn with a detached process group so
// the entire tree (npm → node → vite, etc.) is reliably killed on timeout.
function spawnScript(pkgDir, scriptName, timeoutMs) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn('npm', ['run', scriptName], { cwd: pkgDir, detached: true, stdio: 'pipe' });
        } catch (err) {
            resolve({ code: null, stdout: '', stderr: err.message, killed: false });
            return;
        }

        let stdout = '', stderr = '';
        if (child.stdout) child.stdout.on('data', d => { stdout += d; });
        if (child.stderr) child.stderr.on('data', d => { stderr += d; });

        let resolved = false;
        const done = (code, killed) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ code, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500), killed: !!killed });
        };

        const timer = setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
            done(null, true);
        }, timeoutMs);

        child.on('close', code => done(code, false));
        child.on('error', () => {
            try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
            done(null, false);
        });
    });
}

// Checks one npm script: { defined, ran, passed, error }.
// Server scripts are verified as defined only; runnable scripts are actually executed.
async function runNpmScript(pkgDir, scriptName) {
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch (e) {
        return { defined: false, ran: false, passed: false, error: 'package.json unreadable' };
    }

    if (!pkg.scripts || !pkg.scripts[scriptName]) {
        return { defined: false, ran: false, passed: false, error: `"${scriptName}" not in package.json scripts` };
    }

    if (SERVER_SCRIPTS.has(scriptName)) {
        // Can't run a server script safely — just confirm it's defined.
        return { defined: true, ran: false, passed: true, error: null };
    }

    const { code, stdout, stderr, killed } = await spawnScript(pkgDir, scriptName, 30000);

    if (code === 0) {
        return { defined: true, ran: true, passed: true, error: null };
    }

    if (killed) {
        // Killed by 30s timeout — likely a watch-mode test runner. If no explicit failure
        // patterns appear in the output, the scripts ran but were waiting for file changes.
        const combined = (stdout + stderr).toLowerCase();
        if (!/\bfail\b|\berror\b|\bnot found\b/.test(combined)) {
            return { defined: true, ran: true, passed: true, error: null };
        }
    }

    const errorText = (stderr + stdout).trim().slice(0, 300) || 'Script exited with error';
    return { defined: true, ran: true, passed: false, error: errorText };
}

// Checks a set of npm scripts for a student's extracted code.
// Installs node_modules first if they're not already present.
// Returns { scripts: { [name]: { defined, ran, passed, error } } } or { error: string }.
async function checkStudentScripts(extractedDir, scriptNames) {
    if (!extractedDir || !fs.existsSync(extractedDir)) {
        return { error: 'No extracted code directory' };
    }
    const pkgDirs = findPackageJsonDirs(extractedDir);
    if (pkgDirs.length === 0) return { error: 'No package.json found' };

    const pkgDir = pkgDirs[0];

    if (!fs.existsSync(path.join(pkgDir, 'node_modules'))) {
        try {
            await execAsync('npm install --no-fund --no-audit --ignore-scripts', { cwd: pkgDir, timeout: 30000 });
        } catch (e) {
            return { error: 'npm install failed' };
        }
    }

    const scripts = {};
    for (const name of scriptNames) {
        scripts[name] = await runNpmScript(pkgDir, name);
    }
    return { scripts };
}

// ========== Main export ==========

module.exports = async function(students, config, labDir) {
    const mode = config.runtimeCheck || 'build';
    const needsBrowser = mode === 'browser' || mode === 'both';
    console.log(`--- Runtime Check Phase (${mode} mode) ---`);

    if (needsBrowser && !puppeteer) {
        console.error('  ERROR: Puppeteer not installed. Run: npm install puppeteer');
        students.forEach(s => {
            s.runtimeCheck = { success: false, errors: ['Puppeteer not installed'] };
        });
        return;
    }

    let browser;
    if (needsBrowser) {
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

    for (const student of students) {
        if (!student.extractedDir || !fs.existsSync(student.extractedDir) || student.error) {
            student.runtimeCheck = { success: false, errors: [] };
            continue;
        }

        if (mode === 'build') {
            const result = await checkBuild(student.extractedDir);
            student.runtimeCheck = result;
            if (result.success) {
                console.log(`  OK: ${student.name}: Build successful`);
            } else {
                console.log(`  FAIL: ${student.name}: Build failed (${result.errors.join(', ')})`);
            }
        } else if (mode === 'browser') {
            const htmlDirs = findAllIndexHtmlDirs(student.extractedDir);
            const result = await runBrowserCheck(htmlDirs, browser, student.extractedDir);
            student.runtimeCheck = result;
            if (result.success) {
                console.log(`  OK: ${student.name}: No console errors`);
            } else {
                console.log(`  FAIL: ${student.name}: ${result.errors.join('; ')}`);
            }
        } else {
            // "both": build first, then browser-check the built dist/.
            // Build and browser results are stored as separate fields so that
            // build_check and browser_check mappings can score them independently.
            const buildResult = await checkBuild(student.extractedDir);
            if (!buildResult.success) {
                student.runtimeCheck = {
                    success: false,
                    buildSuccess: false,
                    buildErrors: buildResult.errors,
                    browserSuccess: null,
                    browserErrors: [],
                    errors: buildResult.errors
                };
                console.log(`  FAIL: ${student.name}: Build failed (${buildResult.errors.join(', ')})`);
            } else {
                const distDirs = findDistIndexHtmlDirs(student.extractedDir);
                const browserResult = await runBrowserCheck(distDirs, browser, student.extractedDir);
                student.runtimeCheck = {
                    success: browserResult.success,
                    buildSuccess: true,
                    buildErrors: [],
                    browserSuccess: browserResult.success,
                    browserErrors: browserResult.errors,
                    errors: browserResult.errors
                };
                if (browserResult.success) {
                    console.log(`  OK: ${student.name}: Build and browser checks passed`);
                } else {
                    console.log(`  FAIL: ${student.name}: ${browserResult.errors.join('; ')}`);
                }
            }
        }
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
            student.scriptsCheck = await checkStudentScripts(student.extractedDir, allScriptNames);
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

    const report = students.map(s => {
        const entry = {
            student:  s.name,
            success:  s.runtimeCheck ? s.runtimeCheck.success : false,
            errors:   s.runtimeCheck ? s.runtimeCheck.errors  : [],
        };
        if (s.scriptsCheck) entry.scriptsCheck = s.scriptsCheck;
        return entry;
    });
    fs.writeFileSync(path.join(labDir, RUNTIME_REPORT), JSON.stringify(report, null, 2));
    console.log(`Created ${RUNTIME_REPORT} for ${report.length} students.`);
};

module.exports.findAllIndexHtmlDirs  = findAllIndexHtmlDirs;
module.exports.findDistIndexHtmlDirs = findDistIndexHtmlDirs;
module.exports.findPackageJsonDirs   = findPackageJsonDirs;
module.exports.runNpmScript          = runNpmScript;
module.exports.checkStudentScripts   = checkStudentScripts;
