/* Archived QA for an earlier application version. */
if (require.main === module) throw new Error('Retired historical QA: use its original checkout. V2.4: tools/verify_v24_workbench.cjs; see tools/OFFLINE-AUTHORING.md.');
/* Actual WPF acceptance for clean-only results and renderer-free noise versions. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const apiOutput = path.resolve(process.argv[2] || path.join(root, 'var/verification/v2.2-api'));
const apiReport = JSON.parse(fs.readFileSync(path.join(apiOutput, 'report.json'), 'utf8'));
const output = path.join(root, 'var/verification/v2.2-desktop', String(Date.now()));
const workspace = path.join(output, 'workspace');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'var/runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, why) => { if (!ok) throw new Error(why); };
function hashes(folder) {
  const result = {};
  function visit(current) {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) visit(file);
      else result[path.relative(folder, file).replaceAll('\\', '/')] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  visit(folder);
  return result;
}

(async () => {
  assert(apiReport.passed, 'Real API acceptance must pass first');
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(apiOutput, 'workspace'), workspace, { recursive: true });
  const source = apiReport.source;
  const sourceDir = path.join(workspace, 'jobs', source.id);
  const before = hashes(sourceDir);
  const missingBlender = path.join(output, 'missing-blender.exe');
  assert(!fs.existsSync(missingBlender), 'Acceptance requires Blender to be unavailable');
  const debugPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selected = probe.address().port;
      probe.close(() => resolve(selected));
    });
  });
  const child = spawn(path.join(root, 'var/build/desktop/SatelliteStudio.Desktop.exe'),
    ['--project-root', root, '--workspace', workspace, '--python', runtime.python, '--blender', missingBlender],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${debugPort}` } });
  fs.writeFileSync(path.join(output, 'desktop.pid'), String(child.pid));
  let browser, page;
  const report = { passed: false, output, debugPort, source: source.id, pageErrors: [], resourceFailures: [] };
  try {
    for (let i = 0; i < 100; i++) {
      assert(child.exitCode === null, 'Native application exited before ready');
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 1000 }); break; }
      catch { await pause(300); }
    }
    assert(browser, 'Desktop browser unavailable');
    for (let i = 0; i < 100; i++) {
      page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:'));
      if (page) break;
      await pause(100);
    }
    assert(page, 'Workbench page not found');
    page.on('pageerror', e => report.pageErrors.push(String(e)));
    page.on('requestfailed', r => { if (!r.failure()?.errorText.includes('ABORTED')) report.resourceFailures.push(r.url()); });
    await page.getByRole('heading', { name: 'Satellite Dataset Studio V2.2', exact: true }).waitFor();
    const origin = new URL(page.url()).origin;
    const health = await (await fetch(origin + '/api/health')).json();
    assert(health.renderer_available === false, 'Renderer must be unavailable in this acceptance');
    await page.locator('.job-row').first().waitFor();
    const expand = page.getByRole('button', { name: /显示全部任务|展开全部任务/ });
    if (await expand.count()) await expand.click();
    await page.locator('.job-row').filter({ hasText: source.id.slice(0, 16) }).click();
    await page.locator('.result-details .job-id').filter({ hasText: source.id }).waitFor();
    assert(!(await page.getByRole('button', { name: /^开始生成/ }).isEnabled()), 'New render enabled without Blender');
    const clean = page.getByRole('button', { name: '干净图像', exact: true });
    const noisy = page.getByRole('button', { name: '含噪声', exact: true });
    assert(await clean.isEnabled() && !(await noisy.isEnabled()), 'Clean-only image availability incorrect');
    await page.getByText('本任务未生成含噪声图像', { exact: true }).waitFor();
    const image = page.locator('.result-image img');
    await image.evaluate(img => img.decode());
    assert((await image.getAttribute('src')).includes('/' + source.id + '/images_clean/'), 'Clean image URL wrong');
    const action = page.getByRole('button', { name: '基于原图生成噪声版本', exact: true });
    const toggle = page.getByRole('checkbox', { name: '启用像素噪声', exact: true });
    await toggle.focus();
    await toggle.press('Space');
    assert(!(await toggle.isChecked()), 'Noise checkbox did not switch off');
    assert(!(await action.isEnabled()), 'Disabled noise allowed a meaningless new version');
    await toggle.press('Space');
    assert(await toggle.isChecked(), 'Noise checkbox did not switch on');
    // Live scene deliberately differs from source; only noise and seed may be sent.
    await page.getByRole('spinbutton', { name: 'X 轴旋转数值', exact: true }).fill('123');
    await page.getByRole('spinbutton', { name: '目标距离数值', exact: true }).fill('25');
    await page.locator('.mode-option').filter({ hasText: '自定义姿态序列' }).click();
    await page.getByRole('spinbutton', { name: '采集数量', exact: true }).fill('9');
    await page.getByRole('button', { name: '播放预览', exact: true }).click();
    await pause(150);
    await page.getByRole('button', { name: '暂停预览', exact: true }).click();
    await page.getByRole('button', { name: '退出预览', exact: true }).click();
    assert(await page.getByRole('spinbutton', { name: 'X 轴旋转数值', exact: true }).inputValue() === '123', 'V2.1 manual restoration regressed');
    await page.getByRole('spinbutton', { name: '高斯 σ数值', exact: true }).fill('0.018');
    await page.getByRole('spinbutton', { name: '泊松峰值数值', exact: true }).fill('80');
    await page.getByRole('spinbutton', { name: '随机种子', exact: true }).fill('42');
    assert(await action.isEnabled(), 'Noise action unavailable without Blender');
    await page.screenshot({ path: path.join(output, 'clean-only-no-renderer.png'), fullPage: true });
    async function submit() {
      const [response] = await Promise.all([
        page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/noise-variants') && r.request().method() === 'POST'),
        action.click({ timeout: 10000 }),
      ]);
      assert(response.status() === 202, 'Noise version submission failed: ' + await response.text());
      const body = response.request().postDataJSON();
      assert(Object.keys(body).sort().join(',') === 'noise,seed', 'Live scene leaked into noise-only request');
      return { job: await response.json(), request: body };
    }
    async function wait(job) {
      for (let i = 0; i < 200; i++) {
        const state = await (await fetch(origin + '/api/jobs/' + job.id)).json();
        if (state.status === 'completed') return state;
        assert(['queued', 'running'].includes(state.status), JSON.stringify(state));
        await pause(100);
      }
      throw new Error('Noise job timed out');
    }
    const first = await submit();
    assert(first.job.source_job_id === source.id && first.job.total_frames === 3, 'Wrong canonical source/count');
    assert(first.request.seed === 42 && first.request.noise.gaussian_sigma === .018, 'Current noise settings not captured');
    await wait(first.job);
    await page.locator('.result-details .status-badge.completed').waitFor();
    await noisy.click();
    assert((await image.getAttribute('src')).includes('/' + first.job.id + '/images_noisy/'), 'Noisy image did not use variant URL');
    await clean.click();
    assert((await image.getAttribute('src')).includes('/' + source.id + '/images_clean/'), 'Clean image did not reuse original URL');
    await image.evaluate(img => img.decode());
    await page.getByLabel('原始任务', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, 'noise-version-source-reuse.png'), fullPage: true });
    await page.getByRole('spinbutton', { name: '高斯 σ数值', exact: true }).fill('0.04');
    const second = await submit();
    await wait(second.job);
    assert(second.job.source_job_id === source.id && second.job.id !== first.job.id, 'Second variant did not reuse canonical original');
    assert(JSON.stringify(hashes(sourceDir)) === JSON.stringify(before), 'Native operation changed original files');
    for (const item of [first, second]) {
      const directory = path.join(workspace, 'jobs', item.job.id);
      assert(!['images_clean', 'labels', 'poses'].some(name => fs.existsSync(path.join(directory, name))), 'Variant copied source dataset');
    }
    assert(report.pageErrors.length === 0 && report.resourceFailures.length === 0, 'Page/resource errors');
    report.jobs = [first, second];
    report.originalUnchanged = true;
    report.noBlender = true;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`], { windowsHide: true });
    for (let i = 0; i < 80 && child.exitCode === null; i++) await pause(100);
    assert(child.exitCode !== null, 'Native window failed to close');
    let alive = false; try { await fetch(origin + '/api/health'); alive = true; } catch {}
    assert(!alive, 'Owned service remained after native close');
    report.closedWithoutOrphan = true;
    report.passed = true;
    console.log(JSON.stringify({ passed: true, output, noBlender: true, variants: 2, originalUnchanged: true }));
  } catch (error) {
    report.error = String(error);
    if (page) {
      report.body = await page.locator('body').innerText().catch(() => 'unavailable');
      await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    if (child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(output, '..', 'report.json'), JSON.stringify(report, null, 2));
    if (browser) await browser.close().catch(() => {});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
