/* V2 UI/API/Blender integration. Playwright is a test-only dependency. */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '..');
const run = process.env.SDS_VERIFY_RUN || '';
if (run && !/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Invalid verification run name');
const output = path.join(root, 'var/verification/v2-desktop' + (run ? '-' + run : ''));
const workspace = path.join(output, 'workspace');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'var/runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const sameQuaternion = (a, b) => Math.abs(['W', 'X', 'Y', 'Z'].reduce((s, k) => s + a[k] * b[k], 0)) > 1 - 1e-10;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  assert(!fs.existsSync(path.join(workspace, 'jobs.sqlite3')), 'Use a fresh verification workspace');
  const child = spawn(path.join(root, 'var/build/desktop/SatelliteStudio.Desktop.exe'),
    ['--project-root', root, '--workspace', workspace, '--python', runtime.python, '--blender', runtime.blender],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9227' } });
  let browser;
  const report = { passed: false, models: [], captures: [], pageErrors: [], failedRequests: [] };
  try {
    for (let i = 0; i < 100; i++) {
      assert(child.exitCode === null, 'Desktop exited before browser startup');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9227', { timeout: 1000 }); break; }
      catch { await pause(500); }
    }
    assert(browser, 'WebView2 debugging port unavailable');
    let page;
    for (let i = 0; i < 100; i++) {
      page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:'));
      if (page) break;
      await pause(300);
    }
    assert(page, 'Local workbench page unavailable');
    page.on('pageerror', error => report.pageErrors.push(String(error)));
    page.on('requestfailed', request => {
      if (!request.failure()?.errorText.includes('ABORTED')) report.failedRequests.push(request.url());
    });
    const origin = new URL(page.url()).origin;
    const health = await (await fetch(origin + '/api/health')).json();
    assert(health.schema_version === 'satellite-pose-4.0', 'Desktop loaded an obsolete service');
    assert((await page.title()).includes('V2'), 'Web title missing V2');
    const captureButton = page.getByRole('button', { name: '生成当前单帧', exact: true });
    const models = await (await fetch(origin + '/api/models')).json();
    for (const model of models) {
      await page.getByRole('button', { name: new RegExp(model.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
      await captureButton.waitFor({ state: 'visible' });
      for (let i = 0; i < 200 && !(await captureButton.isEnabled()); i++) await pause(100);
      assert(await captureButton.isEnabled(), 'Model did not become ready: ' + model.id);
      assert(await page.locator('canvas').count() === 1, 'Multiple rendering canvases');
      await pause(200);
      report.models.push(model.id);
    }
    await page.getByRole('button', { name: /INSAT-3B 通信卫星/ }).click();
    for (let i = 0; i < 200 && !(await captureButton.isEnabled()); i++) await pause(100);
    async function capture(name, expected) {
      const pending = page.waitForResponse(r => r.url().endsWith('/api/jobs') && r.request().method() === 'POST');
      await captureButton.click();
      const response = await pending;
      assert(response.status() === 202, 'UI submission was rejected');
      const submitted = response.request().postDataJSON();
      assert(!('quaternion_xyzw' in submitted.scene), 'Legacy scene field still submitted');
      assert(sameQuaternion(submitted.scene.sat_quat, expected), 'UI quaternion disagrees with control values');
      const job = await response.json();
      let current;
      for (let i = 0; i < 240; i++) {
        current = await (await fetch(origin + '/api/jobs/' + job.id)).json();
        if (current.status === 'completed') break;
        assert(['queued', 'running'].includes(current.status), JSON.stringify(current));
        await pause(500);
      }
      assert(current.status === 'completed', 'Capture did not complete');
      const pose = await (await fetch(origin + '/data/' + job.id + '/poses/000001.json')).json();
      assert(sameQuaternion(pose.Location.SatQuat, expected), 'Saved SatQuat disagrees with UI');
      assert(sameQuaternion(pose.Location.CamQuat, { W: .5, X: .5, Y: -.5, Z: .5 }), 'Saved CamQuat mismatch');
      assert(pose.coordinate_convention_id === 'lh-client-world-v2', 'Wrong coordinate version');
      const png = Buffer.from(await (await fetch(origin + current.latest_image_url)).arrayBuffer());
      fs.writeFileSync(path.join(output, name + '.png'), png);
      report.captures.push({ name, id: job.id, Location: pose.Location,
        sha256: crypto.createHash('sha256').update(png).digest('hex') });
      await pause(1500);
      const viewport = PNG.sync.read(await page.locator('canvas').screenshot());
      const axisColors = { red: 0, green: 0, blue: 0 };
      // Inspect the center region, excluding colored DOM badges and legends.
      for (let y = Math.floor(viewport.height * .2); y < viewport.height * .8; y++) {
        for (let x = Math.floor(viewport.width * .2); x < viewport.width * .8; x++) {
          const i = (y * viewport.width + x) * 4;
          const [r, g, b] = viewport.data.subarray(i, i + 3);
          if (r > 100 && r > 1.7 * g && r > 1.7 * b) axisColors.red++;
          if (g > 100 && g > 1.7 * r && g > 1.7 * b) axisColors.green++;
          if (b > 100 && b > 1.7 * r && b > 1.7 * g) axisColors.blue++;
        }
      }
      assert(axisColors.red > 5, 'Capture X helper lost its red color');
      assert(axisColors[name === 'identity' ? 'blue' : 'green'] > 5, 'Capture in-plane helper lost its axis color');
      report.captures.at(-1).axisColors = axisColors;
      await page.screenshot({ path: path.join(output, name + '-workbench.png'), fullPage: true });
    }
    await page.getByRole('button', { name: '归零', exact: true }).click();
    await capture('identity', { W: 1, X: 0, Y: 0, Z: 0 });
    await page.getByRole('spinbutton', { name: 'X 轴旋转数值', exact: true }).fill('90');
    await capture('X90', { W: Math.SQRT1_2, X: Math.SQRT1_2, Y: 0, Z: 0 });
    assert(report.captures[0].sha256 !== report.captures[1].sha256, 'Known different poses produced the same image');
    await page.getByRole('button', { name: '自由观察', exact: true }).click();
    const canvas = await page.locator('canvas').boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.down(); await page.mouse.move(canvas.x + canvas.width / 2 + 80, canvas.y + canvas.height / 2 + 30, { steps: 8 }); await page.mouse.up();
    assert(await page.getByRole('spinbutton', { name: 'X 轴旋转数值', exact: true }).inputValue() === '90', 'Inspection changed acquisition pose');
    await page.screenshot({ path: path.join(output, 'inspect-workbench.png'), fullPage: true });
    assert(report.pageErrors.length === 0, 'Page errors: ' + report.pageErrors.join(';'));
    assert(report.failedRequests.length === 0, 'Resource failures: ' + report.failedRequests.join(';'));
    report.health = health;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true });
    for (let i = 0; i < 80 && child.exitCode === null; i++) await pause(250);
    assert(child.exitCode !== null, 'Native window did not close');
    let alive = false;
    try { await fetch(origin + '/api/health'); alive = true; } catch {}
    assert(!alive, 'Owned backend remained after closing window');
    report.closedWithoutOrphan = true;
    report.passed = true;
    console.log(JSON.stringify({ passed: true, models: report.models.length, captures: report.captures.length, closedWithoutOrphan: true }));
  } finally {
    if (child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
