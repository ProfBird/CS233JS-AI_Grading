/**
 * runtime_check.js
 * 
 * Checks student apps for runtime errors using one of two methods:
 *   "browser" — serves each app and opens in headless Chrome to capture console errors
 *   "build"   — runs npm install + npm run build
 * 
 * The method is set per-lab in the config via config.runtimeCheck ("browser" or "build").
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// ========== Browser-based check ==========

let puppeteer;
try { puppeteer = require('puppeteer'); } catch(e) { /* loaded on demand */ }

function serveDir(dir) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            let urlPath = decodeURIComponent(req.url.split('?')[0]);
            if (urlPath === '/') urlPath = '/index.html';
            const resolved = path.resolve(path.join(dir, urlPath));
            const root = path.resolve(dir);
            // Prevent path traversal outside the served directory
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

        server.on('error', (err) => {
            reject(err);
        });

        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            resolve({ server, port });
        });
    });
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
            if (stats.isSymbolicLink()) return; // skip symlinks to avoid infinite loops
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

// Find all directories containing index.html (recursive, skipping node_modules/dist)
function findAllIndexHtmlDirs(dir, results = []) {
    try {
        const files = fs.readdirSync(dir);
        if (files.includes('index.html')) {
            results.push(dir);
        }
        for (const f of files) {
            if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue;
            const full = path.join(dir, f);
            let stats;
            try { stats = fs.lstatSync(full); } catch (e) { continue; }
            if (stats.isSymbolicLink()) continue; // skip symlinks to avoid infinite loops
            if (stats.isDirectory()) {
                findAllIndexHtmlDirs(full, results);
            }
        }
    } catch(e) {}
    return results;
}

// ========== Main export ==========

module.exports = async function(students, config, labDir) {
    const mode = config.runtimeCheck || 'build';
    console.log(`--- Runtime Check Phase (${mode} mode) ---`);

    if (mode === 'browser' && !puppeteer) {
        console.error('  ERROR: Puppeteer not installed. Run: npm install puppeteer');
        return students.map(s => ({ student: s.name, success: false, errors: ['Puppeteer not installed'] }));
    }

    // For browser mode, launch a single browser instance and reuse it
    let browser;
    if (mode === 'browser') {
        browser = await puppeteer.launch({
            headless: true
        });
    }

    const report = [];

    for (const student of students) {
        if (!student.extractedDir || !fs.existsSync(student.extractedDir) || student.error) {
            report.push({ student: student.name, success: false, errors: [] });
            continue;
        }

        if (mode === 'build') {
            const result = await checkBuild(student.extractedDir);
            report.push({ student: student.name, ...result });
            if (result.success) {
                console.log(`  ✅ ${student.name}: Build successful`);
            } else {
                console.log(`  ❌ ${student.name}: Build failed (${result.errors.join(', ')})`);
            }
        } else {
            // Browser mode: find ALL directories with index.html and check each
            const htmlDirs = findAllIndexHtmlDirs(student.extractedDir);
            const allErrors = [];
            let allSuccess = true;

            if (htmlDirs.length === 0) {
                allErrors.push('No index.html found anywhere');
                allSuccess = false;
            }

            for (const htmlDir of htmlDirs) {
                const label = path.relative(student.extractedDir, htmlDir) || 'root';

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
                const jsErrors = [];       // JS runtime exceptions
                const resourceErrors = [];  // Failed .js/.css loads
                let pageLoaded = false;

                try {
                    const page = await browser.newPage();

                    // Track actual JS runtime exceptions
                    page.on('pageerror', err => {
                        jsErrors.push(err.message || String(err));
                    });

                    // Track failed resource requests — only flag scripts and stylesheets
                    page.on('requestfailed', request => {
                        const url = request.url();
                        const resourceType = request.resourceType();
                        // Only report missing scripts and stylesheets as real errors
                        if (resourceType === 'script' || resourceType === 'stylesheet') {
                            const filename = url.split('/').pop().split('?')[0];
                            resourceErrors.push(`Missing ${resourceType}: ${filename}`);
                        }
                    });

                    const response = await page.goto(`http://127.0.0.1:${port}/`, {
                        waitUntil: 'networkidle0',
                        timeout: 10000
                    }).catch(() => null);

                    if (response && response.ok()) {
                        pageLoaded = true;
                    }

                    // Wait for any delayed JS to execute
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

            report.push({ student: student.name, success: allSuccess, errors: allErrors });
            if (allSuccess) {
                console.log(`  ✅ ${student.name}: No console errors`);
            } else {
                console.log(`  ❌ ${student.name}: ${allErrors.join('; ')}`);
            }
        }
    }

    if (browser) await browser.close();

    fs.writeFileSync(path.join(labDir, 'runtime_report.json'), JSON.stringify(report, null, 2));
    console.log(`Created runtime_report.json for ${report.length} students.`);

    return report;
};
