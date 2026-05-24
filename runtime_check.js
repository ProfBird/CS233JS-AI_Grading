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
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

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

function findAllIndexHtmlDirs(dir, results = []) {
    try {
        const files = fs.readdirSync(dir);
        if (files.includes('index.html')) results.push(dir);
        for (const f of files) {
            if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue;
            const full = path.join(dir, f);
            let stats;
            try { stats = fs.lstatSync(full); } catch (e) { continue; }
            if (stats.isSymbolicLink()) continue;
            if (stats.isDirectory()) findAllIndexHtmlDirs(full, results);
        }
    } catch (e) {}
    return results;
}

// Finds dist/ subdirectories that contain index.html (used after a successful build).
function findDistIndexHtmlDirs(dir, results = []) {
    try {
        const files = fs.readdirSync(dir);
        if (files.includes('dist')) {
            const distPath = path.join(dir, 'dist');
            try {
                if (fs.lstatSync(distPath).isDirectory()) {
                    const distFiles = fs.readdirSync(distPath);
                    if (distFiles.includes('index.html')) results.push(distPath);
                }
            } catch (e) {}
        }
        for (const f of files) {
            if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue;
            const full = path.join(dir, f);
            let stats;
            try { stats = fs.lstatSync(full); } catch (e) { continue; }
            if (stats.isSymbolicLink()) continue;
            if (stats.isDirectory()) findDistIndexHtmlDirs(full, results);
        }
    } catch (e) {}
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

function findPackageJsonDirs(dirPath, arrayOfDirs = []) {
    try {
        const files = fs.readdirSync(dirPath);
        if (files.includes('package.json')) {
            arrayOfDirs.push(dirPath);
        }
        files.forEach(file => {
            const fullP = path.join(dirPath, file);
            let stats;
            try { stats = fs.lstatSync(fullP); } catch (e) { return; }
            if (stats.isSymbolicLink()) return;
            if (stats.isDirectory() && !file.includes('node_modules') && !file.startsWith('.') && file !== 'dist') {
                findPackageJsonDirs(fullP, arrayOfDirs);
            }
        });
    } catch (e) {}
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
            // "both": build first, then browser-check the built dist/
            const buildResult = await checkBuild(student.extractedDir);
            if (!buildResult.success) {
                student.runtimeCheck = buildResult;
                console.log(`  FAIL: ${student.name}: Build failed (${buildResult.errors.join(', ')})`);
            } else {
                const distDirs = findDistIndexHtmlDirs(student.extractedDir);
                const browserResult = await runBrowserCheck(distDirs, browser, student.extractedDir);
                student.runtimeCheck = {
                    success: browserResult.success,
                    errors: [...buildResult.errors, ...browserResult.errors]
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

    const report = students.map(s => ({
        student: s.name,
        success: s.runtimeCheck ? s.runtimeCheck.success : false,
        errors: s.runtimeCheck ? s.runtimeCheck.errors : []
    }));
    fs.writeFileSync(path.join(labDir, RUNTIME_REPORT), JSON.stringify(report, null, 2));
    console.log(`Created ${RUNTIME_REPORT} for ${report.length} students.`);
};
