/* Native V2.4.2 acceptance. Playwright/pngjs are development-only dependencies.
 * Run with the bundled Node and NODE_PATH=<runtime>/dependencies/node/node_modules.
 * This creates a NEW workspace. It never uses the user's installed workspace.
 * Folder responses are simulated; frontend handling and service persistence are real.
 * The Windows folder dialog itself requires a separate, visibly supervised check.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'var/verification/v2.4.2-simplification', `${Date.now()}-${process.pid}`);
const workspace = path.join(output, 'workspace');
const project = path.join(output, 'application');
const rootA = path.join(output, '数据集 A');
const rootB = path.join(output, '数据集 B');
const invalidDirectory = path.join(output, '不是文件夹.txt');
const controlPath = path.join(root, 'var/development/v2.4.2/qa-control.json');
const expectedChecks = [
  'isolated_fixture', 'native_compact_default', 'simplified_default_controls',
  'noise_presets_and_custom_stability', 'seed_editable_while_noise_off',
  'picker_selection_automatic_persistence', 'medium_capture_png_and_json',
  'picker_cancellation_no_change', 'invalid_selection_preserves_saved_path',
  'subsequent_capture_uses_new_root', 'none_capture_clean_only',
  'gallery_navigation_zoom_and_targets', 'append_noise_presets_independent',
  'append_noise_real_output_and_immutable_source', 'compact_dark_light_screenshots',
  'preferences_survive_reopen', 'restore_default_in_settings',
  'restored_default_used_by_new_capture', 'no_browser_errors', 'owned_process_cleanup',
];
const report = {
  version: '2.4.2', passed: false, output, workspace, project, rootA, rootB,
  picker_scope: 'Simulated native picker responses; actual frontend FolderPickerClient, controller, HTTP save and service persistence. Does not test the operating-system dialog.',
  checks: Object.fromEntries(expectedChecks.map(name => [name, { status: 'not_run' }])),
  jobs: [], screenshots: [], pageErrors: [], picker_requests: [], output_save_requests: [], transport_retries: [],
};
let host;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const sameNoise = (a, b) => ['enabled', 'gaussian_sigma', 'poisson_peak'].every(key => a?.[key] === b[key]);
const noiseMedium = { enabled: true, gaussian_sigma: 0.012, poisson_peak: 96 };
const noiseLight = { enabled: true, gaussian_sigma: 0.006, poisson_peak: 256 };

function checkpoint(phase, extra = {}) {
  fs.mkdirSync(path.dirname(controlPath), { recursive: true });
  fs.writeFileSync(controlPath, JSON.stringify({ phase, output, workspace, project, rootA, rootB,
    pid: host?.child.pid, port: host?.port, origin: host?.origin, ...extra }, null, 2));
  console.log(phase);
}
async function step(name, action) {
  assert(Object.hasOwn(report.checks, name), `Unregistered check: ${name}`);
  const started = performance.now();
  checkpoint(name);
  try {
    const evidence = await action();
    report.checks[name] = { status: 'passed', seconds: (performance.now() - started) / 1000, ...(evidence === undefined ? {} : { evidence }) };
  } catch (error) {
    report.checks[name] = { status: 'failed', seconds: (performance.now() - started) / 1000, error: String(error) };
    throw error;
  }
}
async function eventually(action, message, milliseconds = 15000) {
  const until = Date.now() + milliseconds;
  let last;
  while (Date.now() < until) {
    try { const result = await action(); if (result) return result; } catch (error) { last = error; }
    await pause(100);
  }
  throw new Error(`${message}${last ? `: ${last}` : ''}`);
}
function inventory(directory) {
  const files = {};
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(directory, full)] = digest(full);
    }
  }
  walk(directory);
  return files;
}
async function screenshot(page, filename) {
  await page.screenshot({ path: path.join(output, filename), fullPage: false });
  report.screenshots.push(filename);
}
async function launch() {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const runtime = readJson(path.join(root, 'var/runtime.json'));
  const child = spawn(path.join(root, 'var/build/desktop-2.4.2/SatelliteStudio.Desktop.exe'),
    ['--project-root', project, '--workspace', workspace, '--python', runtime.python],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` } });
  const instance = { child, port };
  host = instance;
  child.on('error', error => { instance.spawnError = error; });
  await eventually(async () => {
    assert(!instance.spawnError && child.exitCode === null, `Native host exited: ${instance.spawnError ?? child.exitCode}`);
    instance.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 800 });
    return true;
  }, 'Native WebView unavailable', 45000);
  await eventually(() => {
    instance.page = instance.browser.contexts().flatMap(context => context.pages())
      .find(page => page.url().startsWith('http://127.0.0.1:'));
    return instance.page;
  }, 'Native page missing');
  const page = instance.page;
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(String(error)));
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/settings/output-directory')
      report.output_save_requests.push({ url: request.url(), body: request.postDataJSON() });
  });
  await page.getByRole('heading', { name: '卫星数据工作台', exact: true }).waitFor();
  instance.origin = new URL(page.url()).origin;
  instance.raw = async (route, body) => {
    // The local HTTP server may close idle connections between polling calls.
    // Retry a transport failure once for read-only requests; never retry writes.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(instance.origin + route, { signal: AbortSignal.timeout(5000),
          headers: { Connection: 'close', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
        return { status: response.status, value: await response.json() };
      } catch (error) {
        if (body !== undefined || attempt >= 1) throw error;
        (report.transport_retries ??= []).push({ route, error: String(error), cause: String(error.cause ?? '') });
        await pause(100);
      }
    }
  };
  instance.api = async (route, body) => {
    const response = await instance.raw(route, body);
    assert(response.status < 400, `${route}: ${JSON.stringify(response.value)}`);
    return response.value;
  };
  await eventually(async () => (await instance.api('/api/health')).renderers?.threejs.available, 'Renderer not ready', 45000);
  await page.getByText('实时预览', { exact: true }).waitFor();
  await eventually(() => page.getByRole('button', { name: '生成 1 张图片 →', exact: true }).isEnabled(), 'Capture not enabled');
  checkpoint('native-ready');
  return instance;
}
async function close(instance) {
  if (instance.child.exitCode === null) {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$owned = Get-Process -Id ${instance.child.pid} -ErrorAction SilentlyContinue; if ($owned) { $owned.CloseMainWindow() | Out-Null }`], { windowsHide: true, stdio: 'ignore' });
    await eventually(() => instance.child.exitCode !== null, 'Owned host remained alive', 25000);
  }
  if (instance.origin) await eventually(async () => {
    try { await instance.api('/api/health'); return false; } catch { return true; }
  }, 'Owned service remained alive', 15000);
  await instance.browser?.close().catch(() => {});
  if (host === instance) host = null;
}
async function waitJob(instance, job) {
  return eventually(async () => {
    const latest = await instance.api('/api/jobs/' + job.id);
    assert(['queued', 'running', 'completed'].includes(latest.status), JSON.stringify(latest));
    return latest.status === 'completed' ? latest : false;
  }, `Capture ${job.id} failed or timed out`, 180000);
}
async function submitFromUI(instance, button, route, label) {
  const responsePromise = instance.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === route);
  await button.click();
  const response = await responsePromise;
  assert(response.ok(), `UI submission rejected: ${await response.text()}`);
  const created = await response.json();
  const completed = await waitJob(instance, created);
  const snapshot = readJson(path.join(completed.output_directory, 'job.json'));
  report.jobs.push({ label, ...completed, snapshot });
  return completed;
}
function inspectPng(file) {
  assert(fs.existsSync(file), `PNG missing: ${file}`);
  const bytes = fs.readFileSync(file);
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Invalid PNG header: ${file}`);
  assert(bytes.readUInt32BE(16) === 1024 && bytes.readUInt32BE(20) === 1024, `Wrong PNG size: ${file}`);
  assert(bytes[24] === 8 && bytes[25] === 0, `Expected 8-bit grayscale PNG: ${file}`);
  const png = PNG.sync.read(bytes);
  let minimum = 255, maximum = 0, nonzero = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    minimum = Math.min(minimum, png.data[i]); maximum = Math.max(maximum, png.data[i]);
    if (png.data[i]) nonzero++;
  }
  assert(maximum > minimum && nonzero > 100, `PNG contains no rendered image: ${file}`);
  return { file, sha256: digest(file), width: png.width, height: png.height, minimum, maximum, nonzero };
}
async function disclosure(scope, summary, open) {
  const locator = scope.locator('details').filter({ has: scope.page().getByText(summary, { exact: true }) }).first();
  assert(await locator.count() === 1, `Missing disclosure: ${summary}`);
  if ((await locator.getAttribute('open') !== null) !== open) await locator.locator(':scope > summary').click();
}
async function closeNotice(page) {
  const button = page.getByRole('button', { name: '关闭通知', exact: true });
  if (await button.count()) await button.click();
}
async function installPickerSimulation(page) {
  // Keep the actual WebView bridge. Track its real frontend listeners because
  // WebView2 versions do not all expose EventTarget.dispatchEvent publicly.
  await page.addInitScript(() => {
    const bridge = window.chrome?.webview;
    if (!bridge) throw new Error('QA requires the real native WebView bridge');
    const post = bridge.postMessage.bind(bridge);
    const add = bridge.addEventListener.bind(bridge);
    const remove = bridge.removeEventListener.bind(bridge);
    const listeners = new Set();
    const qa = { replies: [], requests: [], delivered: 0, passthrough: 0 };
    window.__v242Picker = qa;
    bridge.addEventListener = function (type, listener, ...rest) {
      if (type === 'message') listeners.add(listener);
      return add(type, listener, ...rest);
    };
    bridge.removeEventListener = function (type, listener, ...rest) {
      if (type === 'message') listeners.delete(listener);
      return remove(type, listener, ...rest);
    };
    bridge.postMessage = function (message) {
      if (message?.type !== 'satellite.select-output-directory') { qa.passthrough++; return post(message); }
      qa.requests.push(message);
      if (!qa.replies.length) throw new Error('No simulated picker response queued');
      const reply = qa.replies.shift();
      setTimeout(() => {
        const data = { type: 'satellite.output-directory-selected', request_id: message.request_id, path: reply.path,
          ...(reply.error ? { error: reply.error } : {}) };
        for (const listener of [...listeners]) {
          if (typeof listener === 'function') listener({ data });
          else listener.handleEvent({ data });
        }
        qa.delivered++;
      }, 40);
    };
  });
  await page.reload();
  await page.getByText('实时预览', { exact: true }).waitFor();
  assert(await page.evaluate(() => !!window.__v242Picker && !!window.chrome?.webview), 'Native bridge simulation failed to install');
}
async function pick(page, selectedPath, expectedStatus) {
  const before = await page.evaluate(() => window.__v242Picker.requests.length);
  await page.evaluate(selectedPath => window.__v242Picker.replies.push({ path: selectedPath }), selectedPath);
  const responsePromise = selectedPath === null ? null : page.waitForResponse(response =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/output-directory');
  await page.locator('.capture-page').getByRole('button', { name: '更改', exact: true }).click();
  await eventually(() => page.evaluate(count => window.__v242Picker.delivered === count + 1, before), 'Simulated reply not delivered');
  if (responsePromise) {
    const response = await responsePromise;
    assert(response.status() === expectedStatus, `Unexpected save response: ${response.status()} ${await response.text()}`);
  }
  await eventually(() => page.locator('.capture-page').getByRole('button', { name: '更改', exact: true }).isEnabled(), 'Folder operation did not finish');
  const requests = await page.evaluate(() => window.__v242Picker.requests);
  assert(requests.length === before + 1, 'Folder button did not issue exactly one native request');
  report.picker_requests.push(requests.at(-1));
}
async function visibleImage(page) {
  const image = page.getByAltText('任务已保存的正式灰度 PNG', { exact: true });
  await image.waitFor();
  await eventually(() => image.evaluate(element => element.complete && element.naturalWidth === 1024 && element.naturalHeight === 1024), 'Saved result image did not load');
  return image;
}
async function selectJob(page, job) {
  await page.getByRole('button', { name: /^任务与结果/ }).click();
  await page.getByRole('textbox', { name: '搜索模型或任务', exact: true }).fill(job.id);
  await eventually(async () => (await page.locator('.job-row').count()) === 1, 'Selected job absent from UI list');
  await page.locator('.job-row').click();
  const image = await visibleImage(page);
  await eventually(async () => (await image.getAttribute('src'))?.includes(job.id), 'UI selected another job');
}
async function layout(page, kind, width, height) {
  await page.setViewportSize({ width, height });
  await page.getByRole('button', { name: kind === 'capture' ? '数据采集' : /^任务与结果/, exact: kind === 'capture' }).click();
  await closeNotice(page);
  const result = await page.evaluate(kind => {
    const rect = selector => {
      const element = document.querySelector(selector), box = element?.getBoundingClientRect();
      return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height } : null;
    };
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight, bodyScrollWidth: document.body.scrollWidth,
      header: rect('.app-header'), action: rect(kind === 'capture' ? '.generate' : '.frame-navigation'),
      viewer: rect(kind === 'capture' ? '.viewport' : '.result-image'),
      sidebar: rect(kind === 'capture' ? '.right-column' : '.result-details') };
  }, kind);
  assert(result.width === width && result.height === height, 'Viewport override not applied');
  assert(result.scrollWidth <= width + 1 && result.bodyScrollWidth <= width + 1, `Horizontal overflow: ${JSON.stringify(result)}`);
  assert(result.scrollHeight <= height + 1, `Global vertical overflow: ${JSON.stringify(result)}`);
  for (const key of ['header', 'action', 'viewer', 'sidebar']) {
    const box = result[key];
    assert(box && box.width > 0 && box.height > 0 && box.left >= -1 && box.right <= width + 1 && box.top >= -1 && box.bottom <= height + 1,
      `Clipped ${kind} ${key}: ${JSON.stringify(result)}`);
  }
  if (kind === 'results') {
    await visibleImage(page);
    for (const name of ['上一帧', '下一帧', '缩小图像', '复位图像显示', '放大图像']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      assert(box && box.width >= 34 && box.height >= 34 && box.y >= 0 && box.y + box.height <= height + 1, `Small/clipped result control ${name}: ${JSON.stringify(box)}`);
    }
  }
  return result;
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  try {
    await step('isolated_fixture', async () => {
      assert(!fs.existsSync(workspace), 'QA workspace must be new');
      fs.mkdirSync(rootA); fs.mkdirSync(rootB);
      fs.writeFileSync(invalidDirectory, 'A file, intentionally not a directory.');
      for (const relative of ['apps/ui/dist', 'python/src']) fs.cpSync(path.join(root, relative), path.join(project, relative),
        { recursive: true, filter: file => !file.includes('__pycache__') });
      fs.cpSync(path.join(root, 'assets/models'), path.join(project, 'assets/models'),
        { recursive: true, filter: file => fs.statSync(file).isDirectory() || ['.json', '.glb'].includes(path.extname(file)) });
      const files = inventory(project);
      assert(!Object.keys(files).some(file => /\.blend\d?$|blender\.exe/i.test(file)), 'Fixture must contain GLB assets only');
      report.build = {
        node: process.version,
        executable: { file: 'var/build/desktop-2.4.2/SatelliteStudio.Desktop.exe', sha256: digest(path.join(root, 'var/build/desktop-2.4.2/SatelliteStudio.Desktop.exe')) },
        ui_dist_sha256: inventory(path.join(project, 'apps/ui/dist')),
      };
      return { new_workspace: true, project_files: Object.keys(files).length, uses_user_workspace: false };
    });
    const first = await launch();
    const page = first.page;
    await step('native_compact_default', async () => {
      const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, outerWidth, outerHeight,
        dpr: devicePixelRatio, availWidth: screen.availWidth, availHeight: screen.availHeight,
        scrollWidth: document.documentElement.scrollWidth }));
      assert(bounds.width <= 1120 && bounds.height <= 680, 'Native default window is not compact');
      assert(bounds.scrollWidth <= bounds.width && bounds.height + 30 <= bounds.availHeight, 'Native default window overflows the work area');
      assert((await first.api('/api/jobs')).length === 0, 'QA workspace unexpectedly contains existing jobs');
      assert(await page.evaluate(() => !!window.chrome?.webview), 'Not running inside native WebView2');
      await screenshot(page, 'native-default.png');
      return bounds;
    });
    await installPickerSimulation(page);
    const capture = page.locator('.capture-page');
    const settings = page.getByRole('complementary', { name: '本次采集参数', exact: true });
    const preset = page.getByRole('combobox', { name: '噪声强度', exact: true });
    await step('simplified_default_controls', async () => {
      assert(await settings.getByRole('heading', { level: 2 }).allTextContents().then(values => JSON.stringify(values) === '["拍摄设置"]'), 'Expected the single shooting-settings heading');
      for (const summary of ['更多参数', '技术详情']) {
        const details = settings.locator('details').filter({ has: page.getByText(summary, { exact: true }) });
        assert(await details.count() === 1 && await details.getAttribute('open') === null, `${summary} must start collapsed`);
      }
      assert(await page.getByRole('button', { name: '恢复默认', exact: true }).count() === 0, 'Restore default leaked onto the home screen');
      const text = await page.locator('body').innerText();
      assert(!/LOCAL DATA WORKBENCH|CAPTURE WORKSPACE|SCENE SETTINGS|SAVE OUTPUT|SATELLITE DATASET STUDIO|LIVE PREVIEW|RESULTS GALLERY|Gaussian|Poisson|satellite-pose|lh-client-world|threejs-detail|CamQuat/i.test(text), 'Decorative English or technical internals visible by default');
      assert(!text.includes('手动姿态四元数') && !text.includes('坐标与输出约定'), 'Technical fields were not collapsed');
      return { heading: '拍摄设置', more_parameters_collapsed: true, technical_details_collapsed: true };
    });
    await step('noise_presets_and_custom_stability', async () => {
      await disclosure(settings, '光照与噪声', true);
      const options = await preset.locator('option').evaluateAll(elements => elements.map(element => ({ value: element.value, label: element.textContent })));
      assert(JSON.stringify(options.map(option => option.value)) === '["none","light","medium","custom"]', 'Noise preset choices differ');
      for (const choice of ['none', 'light', 'medium']) {
        await preset.selectOption(choice);
        assert(await page.getByRole('spinbutton', { name: '高斯 σ数值', exact: true }).count() === 0 &&
          await page.getByRole('spinbutton', { name: '泊松峰值数值', exact: true }).count() === 0, `Technical noise fields visible for ${choice}`);
      }
      await preset.selectOption('custom');
      const sigma = page.getByRole('spinbutton', { name: '高斯 σ数值', exact: true });
      const peak = page.getByRole('spinbutton', { name: '泊松峰值数值', exact: true });
      await sigma.fill('0.006'); await peak.fill('256');
      assert(await preset.inputValue() === 'custom', 'Custom snapped to matching light preset');
      await sigma.fill('0.012'); await peak.fill('96');
      assert(await preset.inputValue() === 'custom', 'Custom snapped to matching medium preset');
      await page.getByRole('button', { name: '重置参数', exact: true }).click();
      assert(await preset.inputValue() === 'none', 'Reset did not reset the preset choice');
      assert(await sigma.count() === 0 && await peak.count() === 0, 'Reset left custom controls visible');
      await closeNotice(page);
      return { options, matching_light_keeps_custom: true, matching_medium_keeps_custom: true, reset: 'none' };
    });
    await step('seed_editable_while_noise_off', async () => {
      await disclosure(settings, '光照与噪声', false);
      await disclosure(settings, '更多参数', true);
      const seed = page.getByRole('spinbutton', { name: '随机种子', exact: true });
      assert(await seed.isEnabled(), 'Seed cannot be edited while noise is off');
      await seed.fill('20261102');
      assert(await seed.inputValue() === '20261102', 'Seed edit was lost');
      await disclosure(settings, '技术详情', true);
      assert(await settings.getByText('手动姿态四元数 [W, X, Y, Z]', { exact: true }).isVisible(), 'Technical disclosure does not expand');
      await screenshot(page, 'capture-expanded.png');
      await disclosure(settings, '技术详情', false);
      await disclosure(settings, '更多参数', false);
      return { noise: 'none', seed: 20261102 };
    });
    const defaults = await first.api('/api/settings/output-directory');
    await step('picker_selection_automatic_persistence', async () => {
      const before = report.output_save_requests.length;
      await pick(page, rootA, 200);
      assert(report.output_save_requests.length === before + 1, 'Selecting a folder did not save exactly once');
      assert(samePath((await first.api('/api/settings/output-directory')).output_directory, rootA), 'Selected folder did not reach service persistence');
      assert(await capture.getByRole('button', { name: '保存', exact: true }).count() === 0, 'Native picker requires an extra save button');
      assert(samePath(report.picker_requests.at(-1).initial_directory, defaults.output_directory), 'Picker initial directory was not the saved directory');
      return { simulated_picker: true, real_http_persistence: true, selected: rootA };
    });
    let medium;
    await step('medium_capture_png_and_json', async () => {
      await disclosure(settings, '光照与噪声', true); await preset.selectOption('medium');
      medium = await submitFromUI(first, page.getByRole('button', { name: '生成 1 张图片 →', exact: true }), '/api/jobs', 'medium-single');
      const snapshot = readJson(path.join(medium.output_directory, 'job.json'));
      const pose = readJson(path.join(medium.output_directory, 'poses/000001.json'));
      assert(samePath(path.dirname(medium.output_directory), rootA), 'Capture did not use folder A');
      assert(sameNoise(snapshot.scene.noise, noiseMedium) && snapshot.scene.seed === 20261102, 'Medium preset/seed not persisted');
      assert(sameNoise(pose.scene.noise, noiseMedium) && pose.master_seed === 20261102, 'Pose JSON did not preserve medium parameters');
      const clean = inspectPng(path.join(medium.output_directory, 'images_clean/000001.png'));
      const noisy = inspectPng(path.join(medium.output_directory, 'images_noisy/000001.png'));
      assert(clean.sha256 !== noisy.sha256, 'Medium noise produced an unchanged image');
      return { id: medium.id, clean, noisy, noise: snapshot.scene.noise, seed: snapshot.scene.seed };
    });
    await step('picker_cancellation_no_change', async () => {
      const before = report.output_save_requests.length;
      await pick(page, null);
      assert(report.output_save_requests.length === before, 'Cancel unexpectedly submitted a save');
      assert(samePath((await first.api('/api/settings/output-directory')).output_directory, rootA), 'Cancel changed the saved directory');
      return { simulated_picker: true, saves: 0, retained: rootA };
    });
    await step('invalid_selection_preserves_saved_path', async () => {
      await pick(page, invalidDirectory, 400);
      assert(samePath((await first.api('/api/settings/output-directory')).output_directory, rootA), 'Invalid selection replaced the saved directory');
      const error = capture.locator('.folder-feedback [role="alert"]');
      await error.waitFor();
      const text = await error.innerText();
      assert(text.trim().length > 0, 'Invalid directory has no visible error');
      assert(samePath(await capture.locator('.folder-summary > span').getAttribute('title'), rootA), 'Displayed saved directory changed after failure');
      await screenshot(page, 'invalid-directory-feedback.png');
      return { rejected: invalidDirectory, saved: rootA, error: text };
    });
    let none;
    await step('subsequent_capture_uses_new_root', async () => {
      await pick(page, rootB, 200);
      assert(await capture.locator('.folder-feedback [role="alert"]').count() === 0, 'Successful selection did not clear the old error');
      await preset.selectOption('none');
      await page.getByRole('combobox', { name: '生成模式', exact: true }).selectOption('coverage');
      await page.getByRole('spinbutton', { name: '采集数量', exact: true }).fill('3');
      await disclosure(settings, '更多参数', true);
      await page.getByRole('spinbutton', { name: '随机种子', exact: true }).fill('20261103');
      none = await submitFromUI(first, page.getByRole('button', { name: '生成 3 张图片 →', exact: true }), '/api/jobs', 'none-coverage-three');
      assert(samePath(path.dirname(none.output_directory), rootB), 'Subsequent task did not use folder B');
      assert(samePath(path.dirname((await first.api('/api/jobs/' + medium.id)).output_directory), rootA), 'Existing task moved after directory selection');
      return { new_job: none.id, new_root: rootB, existing_job_root: rootA };
    });
    await step('none_capture_clean_only', async () => {
      const snapshot = readJson(path.join(none.output_directory, 'job.json'));
      assert(snapshot.scene.noise.enabled === false && snapshot.scene.seed === 20261103, 'Noise-off seed/snapshot changed');
      const frames = [];
      for (let index = 1; index <= 3; index++) {
        const id = String(index).padStart(6, '0');
        const pose = readJson(path.join(none.output_directory, `poses/${id}.json`));
        assert(!fs.existsSync(path.join(none.output_directory, `images_noisy/${id}.png`)) && !Object.hasOwn(pose.files, 'noisy'), 'Noise-off produced a noisy PNG or metadata reference');
        assert(pose.scene.noise.enabled === false && pose.master_seed === 20261103, 'Noise-off pose JSON wrong');
        frames.push(inspectPng(path.join(none.output_directory, `images_clean/${id}.png`)));
      }
      const gallery = await first.api(`/api/jobs/${none.id}/frames?offset=0&limit=3`);
      assert(gallery.total === 3 && gallery.frames.every(frame => frame.images.clean && !frame.images.noisy), 'Noise-off gallery incorrectly advertises noisy images');
      return { frames, seed: snapshot.scene.seed };
    });
    await step('gallery_navigation_zoom_and_targets', async () => {
      await selectJob(page, none); await closeNotice(page);
      const image = await visibleImage(page);
      await eventually(async () => (await image.getAttribute('src')).endsWith('/000001.png'), 'Gallery did not start at frame 1');
      await page.getByRole('button', { name: '下一帧', exact: true }).click();
      await eventually(async () => (await image.getAttribute('src'))?.endsWith('/000002.png'), 'Next-frame navigation failed');
      await visibleImage(page);
      await page.getByRole('button', { name: '上一帧', exact: true }).click();
      await eventually(async () => (await image.getAttribute('src'))?.endsWith('/000001.png'), 'Previous-frame navigation failed');
      await visibleImage(page);
      await page.getByRole('button', { name: '放大图像', exact: true }).click();
      assert((await image.getAttribute('style')).includes('scale(1.25)'), 'Zoom in did not change the image');
      await page.getByRole('button', { name: '缩小图像', exact: true }).click();
      assert((await image.getAttribute('style')).includes('scale(1)'), 'Zoom out did not restore 100%');
      await page.getByRole('button', { name: '放大图像', exact: true }).click();
      await page.getByRole('button', { name: '复位图像显示', exact: true }).click();
      assert((await image.getAttribute('style')).includes('scale(1)'), 'Zoom reset failed');
      const targets = {};
      for (const name of ['上一帧', '下一帧', '缩小图像', '复位图像显示', '放大图像']) {
        const box = await page.getByRole('button', { name, exact: true }).boundingBox();
        assert(box && box.width >= 34 && box.height >= 34, `Target smaller than 34px: ${name}`); targets[name] = box;
      }
      await screenshot(page, 'results-frame-navigation.png');
      return targets;
    });
    const sourceBefore = inventory(medium.output_directory);
    let variant;
    await step('append_noise_presets_independent', async () => {
      await selectJob(page, medium);
      await page.getByRole('button', { name: '基于原图追加噪声', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const variantPreset = dialog.getByRole('combobox', { name: '追加噪声强度', exact: true });
      assert(JSON.stringify(await variantPreset.locator('option').evaluateAll(elements => elements.map(element => element.value))) === '["none","light","medium","custom"]', 'Append dialog does not share presets');
      for (const choice of ['none', 'light', 'medium']) {
        await variantPreset.selectOption(choice);
        assert(await dialog.getByRole('spinbutton', { name: '追加高斯 σ数值', exact: true }).count() === 0, 'Append technical fields shown outside custom');
        if (choice === 'none') assert(await dialog.getByRole('button', { name: '基于原图生成噪声版本', exact: true }).isDisabled(), 'Noise-disabled variant is allowed');
      }
      await variantPreset.selectOption('custom');
      await dialog.getByRole('spinbutton', { name: '追加高斯 σ数值', exact: true }).fill('0.006');
      await dialog.getByRole('spinbutton', { name: '追加泊松峰值数值', exact: true }).fill('256');
      assert(await variantPreset.inputValue() === 'custom', 'Append custom snapped to light');
      await variantPreset.selectOption('light');
      await disclosure(dialog, '更多参数', true);
      await dialog.getByRole('spinbutton', { name: '追加随机种子', exact: true }).fill('42');
      await screenshot(page, 'append-noise-dialog.png');
      variant = await submitFromUI(first, dialog.getByRole('button', { name: '基于原图生成噪声版本', exact: true }), `/api/jobs/${medium.id}/noise-variants`, 'append-light');
      await page.getByRole('button', { name: '数据采集', exact: true }).click();
      assert(await preset.inputValue() === 'none', 'Append settings changed capture draft preset');
      assert(await page.getByRole('spinbutton', { name: '随机种子', exact: true }).inputValue() === '20261103', 'Append settings changed capture draft seed');
      return { variant: variant.id, capture_preset: 'none', capture_seed: 20261103, append_preset: 'light', append_seed: 42 };
    });
    await step('append_noise_real_output_and_immutable_source', async () => {
      const snapshot = readJson(path.join(variant.output_directory, 'job.json'));
      const metadata = readJson(path.join(variant.output_directory, 'noise_meta/000001.json'));
      assert(sameNoise(snapshot.noise, noiseLight) && snapshot.seed === 42, 'Append preset not saved');
      assert(metadata.source_job_id === medium.id && sameNoise(metadata.noise, noiseLight) && metadata.master_seed === 42, 'Append metadata is wrong');
      const png = inspectPng(path.join(variant.output_directory, 'images_noisy/000001.png'));
      assert(metadata.output_sha256 === png.sha256, 'Append metadata hash mismatch');
      assert(samePath(path.dirname(variant.output_directory), rootA), 'Append ignored its original source root');
      assert(JSON.stringify(inventory(medium.output_directory)) === JSON.stringify(sourceBefore), 'Append modified original task files');
      const frames = await first.api(`/api/jobs/${variant.id}/frames?offset=0&limit=1`);
      assert(frames.frames[0].images.clean.includes(medium.id) && frames.frames[0].images.noisy.includes(variant.id), 'Append gallery does not reference the correct files');
      return { png, source_unchanged_files: Object.keys(sourceBefore).length, source_root: rootA };
    });
    await step('compact_dark_light_screenshots', async () => {
      await eventually(async () => (await page.locator('.tab-count').count()) === 0, 'Completed jobs have not reached the polled task list');
      await page.getByRole('combobox', { name: '生成模式', exact: true }).selectOption('single');
      await disclosure(settings, '光照与噪声', false); await disclosure(settings, '更多参数', false);
      await settings.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
      const evidence = [];
      for (const theme of ['dark', 'light']) {
        await page.getByRole('button', { name: '设置', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('combobox', { name: '外观主题', exact: true }).selectOption(theme);
        await eventually(async () => (await first.api('/api/settings/appearance')).theme === theme && (await page.locator('html').getAttribute('data-theme')) === theme, 'Theme did not persist');
        await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
        for (const [width, height] of [[960, 600], [1108, 645]]) for (const kind of ['capture', 'results']) {
          const bounds = await layout(page, kind, width, height);
          await screenshot(page, `${kind}-${theme}-${width}x${height}.png`);
          evidence.push({ theme, kind, ...bounds });
        }
      }
      return evidence;
    });
    const originalOrigin = first.origin;
    await close(first);
    const second = await launch();
    await step('preferences_survive_reopen', async () => {
      assert(samePath((await second.api('/api/settings/output-directory')).output_directory, rootB), 'Folder setting did not survive native restart');
      assert((await second.api('/api/settings/appearance')).theme === 'light', 'Theme setting did not survive restart');
      await eventually(async () => (await second.page.locator('html').getAttribute('data-theme')) === 'light', 'Reopened UI does not use persisted light theme');
      return { before_origin: originalOrigin, reopened_origin: second.origin, output_directory: rootB, theme: 'light' };
    });
    await step('restore_default_in_settings', async () => {
      assert(await second.page.getByRole('button', { name: '恢复默认', exact: true }).count() === 0, 'Restore default appears outside Settings');
      await second.page.getByRole('button', { name: '设置', exact: true }).click();
      const dialog = second.page.getByRole('dialog');
      const restore = dialog.getByRole('button', { name: '恢复默认', exact: true });
      assert(await restore.isEnabled(), 'Restore default is not enabled for custom output root');
      const responsePromise = second.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/settings/output-directory');
      await restore.click();
      assert((await responsePromise).ok(), 'Restore default save failed');
      const saved = await second.api('/api/settings/output-directory');
      assert(samePath(saved.output_directory, defaults.default_output_directory) && samePath(saved.default_output_directory, path.join(workspace, 'jobs')), 'Restored directory is not the QA default');
      await eventually(() => restore.isDisabled(), 'Restore button did not reflect successful save');
      await screenshot(second.page, 'settings-restored-default.png');
      await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
      return saved;
    });
    await step('restored_default_used_by_new_capture', async () => {
      const job = await submitFromUI(second, second.page.getByRole('button', { name: '生成 1 张图片 →', exact: true }), '/api/jobs', 'restored-default-single');
      assert(samePath(path.dirname(job.output_directory), defaults.default_output_directory), 'New job ignored restored default');
      inspectPng(path.join(job.output_directory, 'images_clean/000001.png'));
      assert(fs.existsSync(path.join(medium.output_directory, 'images_clean/000001.png')) && fs.existsSync(path.join(none.output_directory, 'images_clean/000001.png')), 'Restore moved or removed prior output');
      return { id: job.id, output_directory: job.output_directory };
    });
    if (process.argv.includes('--pause-native-picker')) {
      const marker = path.join(output, 'native-picker-continue.json');
      report.manual_native_picker = { status: 'not_performed', marker };
      checkpoint('native-picker-ready', { marker, picker_simulation_installed: false });
      // The second host is fresh: no addInitScript simulation was installed.
      // An observer may inspect the real Windows dialog, then write evidence.
      for (let index = 0; index < 1200 && !fs.existsSync(marker); index++) await pause(100);
      if (fs.existsSync(marker)) report.manual_native_picker = readJson(marker);
    }
    await step('no_browser_errors', async () => { assert(report.pageErrors.length === 0, JSON.stringify(report.pageErrors)); return { page_errors: 0 }; });
    await step('owned_process_cleanup', async () => { await close(second); return { host_closed: true, service_unreachable: true }; });
    report.passed = expectedChecks.every(name => report.checks[name].status === 'passed');
    checkpoint(report.passed ? 'passed' : 'failed');
  } catch (error) {
    report.error = String(error); report.stack = error.stack; report.error_cause = String(error.cause ?? '');
    checkpoint('failed', { error: String(error) });
    if (host?.page) {
      report.body = await host.page.locator('body').innerText().catch(() => '');
      await screenshot(host.page, 'failure.png').catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    if (host) {
      try { await close(host); }
      catch (error) {
        report.cleanup_error = String(error);
        if (host?.child.exitCode === null) {
          try { execFileSync('taskkill.exe', ['/PID', String(host.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
          catch (killError) { report.forced_cleanup_error = String(killError); }
        }
        await host?.browser?.close().catch(() => {});
      }
    }
    report.counts = { total: expectedChecks.length,
      passed: Object.values(report.checks).filter(check => check.status === 'passed').length,
      failed: Object.values(report.checks).filter(check => check.status === 'failed').length,
      not_run: Object.values(report.checks).filter(check => check.status === 'not_run').length,
      transport_retries: report.transport_retries?.length ?? 0 };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(output, '..', 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, output, counts: report.counts }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
