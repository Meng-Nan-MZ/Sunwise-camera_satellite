'use strict';

/* Installed Windows acceptance. Node 18+ and Playwright are test dependencies,
 * not application dependencies. No development runtime configuration is read.
 * Usage: node verify_installed.cjs --app-dir ABS --workspace ABS --output ABS
 *                                  [--debug-port 9234]
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function parseArguments(args) {
  const values = {};
  const allowed = new Set(['--app-dir', '--workspace', '--output', '--debug-port']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    assert(allowed.has(key), 'Unknown argument: ' + key);
    assert(!(key in values), 'Duplicate argument: ' + key);
    assert(value && !value.startsWith('--'), 'Missing value for ' + key);
    values[key] = value;
  }
  for (const key of ['--app-dir', '--workspace', '--output'])
    assert(values[key] && path.isAbsolute(values[key]), key + ' requires an absolute path');
  const options = { appDir: path.resolve(values['--app-dir']), workspace: path.resolve(values['--workspace']),
    output: path.resolve(values['--output']), debugPort: Number(values['--debug-port'] || 9234) };
  assert(Number.isInteger(options.debugPort) && options.debugPort > 1023 && options.debugPort <= 65535, 'Invalid debugging port');
  assert(!isWithin(options.appDir, options.workspace), 'Workspace must be outside the installation');
  assert(!isWithin(options.appDir, options.output), 'Evidence output must be outside the installation');
  return options;
}

function childEnvironment(original, port) {
  const result = {};
  for (const [key, value] of Object.entries(original)) {
    const upper = key.toUpperCase();
    if (upper === 'PATH' || upper.startsWith('PYTHON') || upper.startsWith('DOTNET_ROOT') ||
        upper.startsWith('WEBVIEW2_') || upper.startsWith('SATELLITE_') ||
        ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].includes(upper)) continue;
    result[key] = value;
  }
  const windows = original.SystemRoot || original.SYSTEMROOT || original.WINDIR || 'C:\\Windows';
  result.PATH = path.join(windows, 'System32') + ';' + windows;
  result.HTTP_PROXY = result.HTTPS_PROXY = result.ALL_PROXY = 'http://127.0.0.1:9';
  result.NO_PROXY = '127.0.0.1,localhost,::1';
  result.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} ` +
    '--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=127.0.0.1;localhost;[::1] --disable-quic --disable-background-networking';
  return result;
}

function sameProcess(expected, observed) {
  return Boolean(expected && observed && expected.pid === observed.pid && expected.created === observed.created);
}

function pngInfo(bytes) {
  assert(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG signature');
  assert(bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(8) === 13, 'Missing PNG IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bitDepth: bytes[24], colorType: bytes[25], bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function canonicalPath(input) {
  let existing = input;
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    assert(parent !== existing, 'Path has no accessible existing ancestor: ' + input);
    suffix.unshift(path.basename(existing)); existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function fileInventory(root) {
  const files = new Map();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), 'Installed payload contains a symbolic link: ' + filename);
      if (entry.isDirectory()) visit(filename);
      else { const stat = fs.statSync(filename); files.set(path.relative(root, filename), `${stat.size}:${stat.mtimeMs}`); }
    }
  }
  visit(root);
  return files;
}

async function powershell(script, input = {}) {
  const windows = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
  const executable = path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const prefix = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    "$inputData=ConvertFrom-Json $env:SDS_VERIFY_INPUT; ";
  const { stdout } = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', prefix + script], {
    windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')),
      PSModulePath: path.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'), SDS_VERIFY_INPUT: JSON.stringify(input) },
  });
  return stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : null;
}

// Query only exact owned IDs and their descendants; never enumerate every
// Windows process or terminate by image name. Creation time protects PID reuse.
const SNAPSHOT = `
function Describe($p) { @{pid=[int]$p.ProcessId; parentPid=[int]$p.ParentProcessId;
 created=$p.CreationDate.ToUniversalTime().ToString('o'); executable=$p.ExecutablePath; commandLine=$p.CommandLine} }
$found=@{}; $queue=[Collections.Generic.Queue[int]]::new();
foreach($known in $inputData.known) {
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$known.pid);
 if($p) { $row=Describe $p;
  if(($known.created -and $row.created -eq $known.created) -or
    (!$known.created -and [int]$known.pid -eq [int]$inputData.rootPid -and $row.executable -eq $inputData.rootExecutable)) {
   $found[[int]$row.pid]=$row; $queue.Enqueue([int]$row.pid)
  }
 }
}
while($queue.Count) {
 $owner=$queue.Dequeue();
 foreach($p in @(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$owner))) {
  $row=Describe $p;
  if(!$found.ContainsKey([int]$row.pid) -and $row.created -ge $found[$owner].created) {
   $found[[int]$row.pid]=$row; $queue.Enqueue([int]$row.pid)
  }
 }
}
ConvertTo-Json -InputObject @($found.Values) -Depth 4 -Compress`;

async function waitUntil(description, action, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await pause(500);
  }
  throw new Error('Timed out: ' + description);
}

async function assertPortFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(error => error ? reject(error) : resolve()));
  });
}

async function run(options) {
  assert(process.platform === 'win32', 'Installed desktop verification requires Windows');
  for (const field of ['appDir', 'workspace', 'output']) options[field] = canonicalPath(options[field]);
  assert(!isWithin(options.appDir, options.workspace) && !isWithin(options.appDir, options.output), 'Workspace/output resolves into the installed payload');
  assert(!fs.existsSync(options.workspace) || fs.readdirSync(options.workspace).length === 0, 'Use an empty workspace; existing user jobs must never be started by acceptance');
  assert(!fs.existsSync(path.join(options.output, 'report.json')), 'Use a fresh evidence output directory');
  const executable = path.join(options.appDir, 'SatelliteStudio.Desktop.exe');
  assert(fs.existsSync(executable), 'Installed desktop EXE not found: ' + executable);
  await assertPortFree(options.debugPort);
  const { chromium } = require('playwright');
  fs.mkdirSync(options.output, { recursive: true });
  fs.mkdirSync(options.workspace, { recursive: true });
  const cwd = path.join(options.output, 'launch-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const beforeFiles = fileInventory(options.appDir);
  const report = { startedAt: new Date().toISOString(), options, passed: false, steps: [], models: [], jobs: [], screenshots: [],
    pageErrors: [], consoleErrors: [], failedRequests: [], externalRequests: [], cleanupErrors: [],
    isolation: { cwd, arguments: ['--workspace', options.workspace], path: childEnvironment(process.env, options.debugPort).PATH,
      cleared: ['PYTHON*', 'DOTNET_ROOT*', 'WEBVIEW2_*', 'SATELLITE_*'], proxy: 'http://127.0.0.1:9',
      scope: 'Child-process environment and browser proxy only; system network settings unchanged. Not an OS firewall.' } };
  const tracked = new Map();
  let child, childExit = null, browser, page, origin, monitoring, monitorBusy = false, closing = false;
  const progress = message => { report.steps.push({ at: new Date().toISOString(), message }); console.log(message); };
  async function snapshot() {
    if (!child?.pid) return [];
    const rows = await powershell(SNAPSHOT, { rootPid: child.pid, rootExecutable: executable,
      known: tracked.size ? [...tracked.values()].map(({ pid, created }) => ({ pid, created })) : [{ pid: child.pid }] });
    for (const row of rows || []) tracked.set(row.pid, row);
    return rows || [];
  }
  async function api(relative, body) {
    const response = await fetch(origin + relative, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`${relative}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  }
  async function waitJob(id, predicate = job => job.status === 'completed') {
    return waitUntil('job ' + id, async () => {
      const job = await api('/api/jobs/' + id);
      assert(!['failed', 'interrupted'].includes(job.status), 'Job failed: ' + JSON.stringify(job));
      if (predicate(job)) return job;
      assert(!['completed', 'canceled'].includes(job.status), 'Unexpected terminal job: ' + JSON.stringify(job));
      return false;
    }, 600000);
  }
  async function inspectJob(job, expectedCount, expectedStatus = 'completed') {
    assert(/^[a-f0-9]{32}$/.test(job.id), 'Invalid job identifier');
    assert(job.status === expectedStatus && job.completed_frames === expectedCount, 'Unexpected frame count/status');
    const directory = path.join(options.workspace, 'jobs', job.id);
    assert(path.resolve(job.output_directory) === directory && fs.realpathSync(directory) === directory, 'Job output escaped selected workspace');
    const result = { ...job, files: [] };
    for (const folder of ['images_clean', 'images_noisy'])
      assert(fs.readdirSync(path.join(directory, folder)).filter(name => name.toLowerCase().endsWith('.png')).length === expectedCount, 'PNG count differs from completed frame count');
    for (let n = 1; n <= expectedCount; n++) {
      const id = String(n).padStart(6, '0');
      for (const folder of ['images_clean', 'images_noisy']) {
        const relative = `${folder}/${id}.png`, local = fs.readFileSync(path.join(directory, relative));
        const info = pngInfo(local);
        assert(info.width === 1024 && info.height === 1024 && info.bitDepth === 8 && info.colorType === 0, 'Wrong formal PNG format');
        const response = await fetch(`${origin}/data/${job.id}/${relative}`, { signal: AbortSignal.timeout(10000) });
        assert(response.ok, 'Saved PNG not available over local API');
        const served = pngInfo(Buffer.from(await response.arrayBuffer()));
        assert(served.sha256 === info.sha256, 'Downloaded PNG differs from workspace file');
        result.files.push({ relative, ...info });
      }
      const label = fs.readFileSync(path.join(directory, 'labels', id + '.txt'), 'utf8').trim().split(/\s+/);
      assert(label.length === 5 && label[0] === '0' && label.slice(1).every(value => Number.isFinite(+value) && +value >= 0 && +value <= 1), 'Invalid YOLO label');
      const pose = JSON.parse(fs.readFileSync(path.join(directory, 'poses', id + '.json'), 'utf8'));
      assert(pose.frame_id === id && pose.resolution[0] === 1024 && pose.resolution[1] === 1024, 'Invalid pose JSON');
    }
    if (job.mode === 'coverage' && job.status === 'completed')
      assert(JSON.parse(fs.readFileSync(path.join(directory, 'coverage.json'), 'utf8')).completed_frames === expectedCount, 'Coverage report count mismatch');
    report.jobs.push(result);
    return JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8'));
  }
  async function screenshot(name) {
    await page.screenshot({ path: path.join(options.output, name), fullPage: true });
    report.screenshots.push(name);
  }
  try {
    // A denied CIM query must never be mistaken for an empty process tree.
    await powershell("Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$inputData.pid) | Select-Object ProcessId | ConvertTo-Json -Compress", { pid: process.pid });
    progress('Launching installed desktop with only --workspace and an unrelated CWD');
    child = spawn(executable, ['--workspace', options.workspace], { cwd, windowsHide: true, stdio: 'ignore',
      env: childEnvironment(process.env, options.debugPort) });
    let startupError;
    child.on('error', error => { startupError = error; });
    child.on('exit', (code, signal) => { childExit = { code, signal, at: new Date().toISOString() }; });
    await waitUntil('owned desktop process identity', async () => {
      if (startupError) throw startupError;
      assert(!childExit, 'Desktop exited before initialization');
      return (await snapshot()).find(item => item.pid === child.pid);
    });
    monitoring = setInterval(async () => {
      if (monitorBusy) return;
      monitorBusy = true;
      try { await snapshot(); } catch (error) { report.cleanupErrors.push('Process monitor: ' + error.message); }
      finally { monitorBusy = false; }
    }, 2000);
    await waitUntil('owned WebView2 debugging listener', async () => {
      assert(!childExit, 'Desktop exited before WebView2 initialized');
      const owners = await powershell("$owners=@(); try { $owners=@(Get-NetTCPConnection -LocalPort $inputData.port -State Listen -ErrorAction Stop | ForEach-Object { $_.OwningProcess }) } catch { if($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }; ConvertTo-Json -InputObject $owners -Compress", { port: options.debugPort });
      if (!owners?.length) return false;
      const rows = await snapshot();
      assert(owners.every(pid => rows.some(row => row.pid === pid && isWithin(path.join(options.appDir, 'runtime', 'webview2'), row.executable || ''))), 'Debugging port belongs to another process; refusing to attach');
      return true;
    }, 120000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${options.debugPort}`, { timeout: 30000 });
    const session = await browser.newBrowserCDPSession();
    report.cdpVersion = await session.send('Browser.getVersion');
    await session.detach();
    report.fixedRuntimeVersion = await powershell("[Diagnostics.FileVersionInfo]::GetVersionInfo($inputData.file).ProductVersion | ConvertTo-Json -Compress", { file: path.join(options.appDir, 'runtime', 'webview2', 'msedgewebview2.exe') });
    assert(report.cdpVersion.product.match(/\d+/)?.[0] === report.fixedRuntimeVersion.match(/\d+/)?.[0], 'CDP and bundled WebView2 major versions differ');
    page = await waitUntil('local application tab', async () => browser.contexts().flatMap(context => context.pages()).find(candidate => /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())));
    page.on('pageerror', error => { if (!closing) report.pageErrors.push(error.message); });
    page.on('console', message => { if (!closing && message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('requestfailed', request => { if (!closing) report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }); });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
        report.externalRequests.push(url.href); return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    origin = new URL(page.url()).origin;
    report.origin = origin;
    report.health = await api('/api/health');
    assert(report.health.status === 'ok' && report.health.renderer_available, 'Packaged backend/renderer is unavailable');
    assert((await api('/api/jobs')).length === 0, 'Fresh verification workspace unexpectedly contains jobs');
    const models = await api('/api/models');
    assert(models.length === 6 && new Set(models.map(model => model.id)).size === 6, 'Expected six distinct installed models');
    for (const [index, model] of models.entries()) {
      assert(/^[a-zA-Z0-9_-]+$/.test(model.id), 'Unsafe model identifier');
      progress('Loading installed model ' + model.id);
      const button = page.locator('.model-list .model-card').filter({ hasText: model.name });
      assert(await button.count() === 1, 'Model selector not unique: ' + model.name);
      await button.click();
      await page.locator('.render-status.ready').waitFor({ state: 'visible', timeout: 90000 });
      await page.waitForFunction(() => !document.querySelector('.viewport-message') && !!document.querySelector('canvas'));
      await pause(500);
      assert(await page.locator('[role="alert"]').count() === 0, 'UI reported an error for ' + model.id);
      assert(report.pageErrors.length === 0 && report.consoleErrors.length === 0, 'Browser errors while loading ' + model.id);
      await screenshot(`${index + 1}-${model.id}.png`);
      report.models.push({ id: model.id, name: model.name, preview: model.preview_url, loaded: true });
    }
    progress('Submitting a real single-frame capture through the UI');
    const posted = page.waitForResponse(response => response.url() === origin + '/api/jobs' && response.request().method() === 'POST', { timeout: 30000 });
    await page.getByRole('button', { name: '生成当前单帧', exact: true }).click();
    const created = await (await posted).json();
    const single = await waitJob(created.id);
    const initial = await inspectJob(single, 1);
    await page.getByRole('link', { name: '打开已保存 PNG ↗', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    await screenshot('7-single-frame.png');
    progress('Queueing two coverage frames and two sequence frames');
    const coverage = await api('/api/jobs', { mode: 'coverage', count: 2, scene: initial.scene });
    const sequence = await api('/api/jobs', { mode: 'sequence', count: 2, scene: initial.scene });
    await inspectJob(await waitJob(coverage.id), 2);
    await inspectJob(await waitJob(sequence.id), 2);
    progress('Canceling a running long task after at least one complete frame');
    const long = await api('/api/jobs', { mode: 'coverage', count: 1000, scene: initial.scene });
    await waitJob(long.id, job => job.status === 'running' && job.completed_frames >= 1);
    report.cancelAcknowledgment = await api('/api/jobs/' + long.id + '/cancel', {});
    const canceled = await waitJob(long.id, job => job.status === 'canceled');
    assert(canceled.completed_frames >= 1 && canceled.completed_frames < 1000, 'Canceled task did not preserve a partial result');
    await inspectJob(canceled, canceled.completed_frames, 'canceled');
    await screenshot('8-batch-and-cancellation.png');
    const running = await snapshot();
    const hasExecutable = expected => running.some(row => row.executable && path.resolve(row.executable).toLowerCase() === expected.toLowerCase());
    assert(hasExecutable(path.join(options.appDir, 'runtime', 'python', 'python.exe')), 'Service did not use packaged Python');
    assert(hasExecutable(path.join(options.appDir, 'runtime', 'blender', 'blender.exe')), 'Renderer did not use packaged Blender');
    report.webviewUserData = path.join(options.workspace, 'userdata');
    assert(fs.existsSync(report.webviewUserData) && running.some(row => row.executable &&
      isWithin(path.join(options.appDir, 'runtime', 'webview2'), row.executable) &&
      row.commandLine?.toLowerCase().includes(report.webviewUserData.toLowerCase())), 'Fixed WebView2 did not use workspace/userdata');
    assert(report.pageErrors.length === 0 && report.consoleErrors.length === 0 && report.failedRequests.length === 0 && report.externalRequests.length === 0, 'Browser errors, failed requests or external requests occurred');
    progress('Closing the owned native window and checking every observed child');
    closing = true;
    const root = tracked.get(child.pid);
    assert(sameProcess(root, (await snapshot()).find(row => row.pid === child.pid)), 'Desktop PID identity changed before native close');
    const closeResult = await powershell("$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$inputData.pid); if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $inputData.created) { [Diagnostics.Process]::GetProcessById([int]$inputData.pid).CloseMainWindow() | ConvertTo-Json } else { 'false' }", root);
    assert(closeResult, 'Owned desktop window could not be closed');
    await waitUntil('desktop exit', async () => childExit, 30000);
    await waitUntil('all observed owned descendants exit', async () => (await snapshot()).length === 0, 30000);
    let serviceResponded = false;
    try { await fetch(origin + '/api/health', { signal: AbortSignal.timeout(2000) }); serviceResponded = true; } catch { }
    assert(!serviceResponded, 'Owned local service survived native window closure');
    report.nativeCloseVerified = true;
    report.serviceStopped = true;
    report.hostExit = childExit;
    report.passed = true;
  } catch (error) {
    report.error = { message: error.message, stack: error.stack };
    if (page && !page.isClosed()) { try { await screenshot('failure.png'); } catch { } }
  } finally {
    closing = true;
    clearInterval(monitoring);
    while (monitorBusy) await pause(100);
    try {
      const remaining = await snapshot();
      if (remaining.length) {
        report.passed = false;
        report.forcedCleanup = remaining.map(({ pid, created, executable }) => ({ pid, created, executable }));
        await powershell(`foreach($known in $inputData.known) {
          $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$known.pid);
          if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $known.created) { Stop-Process -Id ([int]$known.pid) -Force -ErrorAction SilentlyContinue }
        }; 'true'`, { known: remaining });
        await waitUntil('forced owned-process cleanup', async () => (await snapshot()).length === 0, 20000);
      }
      report.remainingOwnedProcesses = await snapshot();
    } catch (error) {
      report.cleanupErrors.push(error.message); report.passed = false;
      // If CIM itself fails, retain the stronger Windows process-handle identity
      // for the one child we spawned. Do not guess which other PIDs are safe.
      if (child && !childExit) {
        child.kill();
        report.cleanupErrors.push('Owned desktop stopped through its retained process handle; descendant cleanup could not be verified.');
      }
    }
    report.processes = [...tracked.values()].map(row => ({ ...row, commandLine: row.commandLine?.replace(/(--token\s+)(?:"[^"]*"|\S+)/g, '$1[redacted]') }));
    report.fixedRuntimeProcesses = report.processes.filter(row => row.executable && isWithin(path.join(options.appDir, 'runtime', 'webview2'), row.executable));
    try {
      const after = fileInventory(options.appDir);
      report.installationChanges = [...new Set([...beforeFiles.keys(), ...after.keys()])].filter(name => beforeFiles.get(name) !== after.get(name));
      if (report.installationChanges.length) { report.passed = false; report.cleanupErrors.push('Installed payload changed during runtime'); }
    } catch (error) { report.cleanupErrors.push(error.message); report.passed = false; }
    if (report.cleanupErrors.length) report.passed = false;
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(options.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    // The native app was closed/killed above; do not send Browser.close to an
    // arbitrary CDP endpoint as a substitute for host lifecycle verification.
  }
  console.log(JSON.stringify({ passed: report.passed, report: path.join(options.output, 'report.json') }));
  return report;
}

module.exports = { parseArguments, childEnvironment, isWithin, sameProcess, pngInfo };
if (require.main === module) {
  run(parseArguments(process.argv.slice(2))).then(report => { process.exitCode = report.passed ? 0 : 1; })
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
