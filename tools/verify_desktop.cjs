/* Archived QA for an earlier application version. */
if (require.main === module) throw new Error('Retired historical QA: use its original checkout. V2.4: tools/verify_v24_workbench.cjs; see tools/OFFLINE-AUTHORING.md.');
/* Windows integration acceptance. Playwright must be on NODE_PATH or installed. */
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'var/runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
const output = path.join(root, 'var/verification/desktop');
const workspace = path.join(output, 'workspace');
const executable = path.join(root, 'var/build/desktop/SatelliteStudio.Desktop.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const child = spawn(executable, ['--project-root', root, '--workspace', workspace,
    '--python', runtime.python, '--blender', runtime.blender], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223' }
  });
  let browser;
  try {
    for (let attempt = 0; attempt < 90; attempt++) {
      if (child.exitCode !== null) throw new Error('Desktop exited before WebView initialization');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 1000 }); break; }
      catch { await pause(500); }
    }
    if (!browser) throw new Error('WebView2 debugging endpoint did not start');
    let page;
    for (let attempt = 0; attempt < 60; attempt++) {
      page = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('127.0.0.1'));
      if (page) break;
      await pause(500);
    }
    if (!page) throw new Error('Desktop did not navigate to local application');
    await page.waitForSelector('canvas', { timeout: 60000 });
    await page.waitForTimeout(3000);
    const health = await page.evaluate(async () => (await fetch('/api/health')).json());
    if (health.status !== 'ok') throw new Error('Backend health failed');
    const origin = new URL(page.url()).origin;
    await page.getByRole('button', { name: /Sputnik-1 人造卫星/ }).click();
    const submitted = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '生成当前单帧', exact: true }).click();
    const job = await (await submitted).json();
    for (let attempt = 0; attempt < 120; attempt++) {
      const current = await (await fetch(origin + '/api/jobs/' + job.id)).json();
      if (current.status === 'completed') break;
      if (current.status !== 'running' && current.status !== 'queued') throw new Error(JSON.stringify(current));
      if (attempt === 119) throw new Error('Desktop capture timed out');
      await pause(1000);
    }
    const saved = page.getByRole('link', { name: '打开已保存 PNG ↗' });
    await saved.waitFor({ state: 'visible', timeout: 10000 });
    await saved.click();
    await pause(500);
    await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ hostStarted: true, webviewLoaded: true, captureJob: job.id, savedPngLinkClicked: true, health, origin }, null, 2));
    // Closing the native window must close its owned service, not any other task.
    await page.evaluate(() => window.close());
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true });
    for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt++) await pause(250);
    if (child.exitCode === null) throw new Error('Desktop did not exit after CloseMainWindow');
    let stillRunning = false;
    try { await fetch(origin + '/api/health'); stillRunning = true; } catch { }
    if (stillRunning) throw new Error('Owned service survived window closure');
    console.log(JSON.stringify({ passed: true, hostExitCode: child.exitCode, orphanService: false }));
  } finally {
    if (child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { }
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
