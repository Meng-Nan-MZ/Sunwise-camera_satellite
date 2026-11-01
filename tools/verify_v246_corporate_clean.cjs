/* V2.4.6 native acceptance: Corporate Clean and user-selected counts, isolated GLB-only fixture.
 * Run after UI and var/build/desktop-2.4.6 builds are ready:
 * $env:NODE_PATH='C:/Users/mz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
 * node tools/verify_v246_corporate_clean.cjs
 * NODE_PATH must provide the development-only playwright/pngjs packages; no browser download is used.
 * No simulated picker or production workspace; no product state injection.
 */
'use strict';
// Native QA connects only to its owned loopback host; bypass inherited network proxies.
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'var/verification/v2.4.6-corporate-clean', `${Date.now()}-${process.pid}`);
const workspace = path.join(output, 'workspace');
const project = path.join(output, 'application');
const rootA = output, rootB = output;
const controlPath = path.join(root, 'var/development/v2.4.6/qa-control.json');
const expectedChecks = ['isolated_fixture','count_presets_and_invalid','mode_defaults','real_jobs_and_frozen_counts','distance_policy','saved_results_and_noise','theme_persistence_and_layout','no_browser_errors','owned_process_cleanup'];
const report = { version: '2.4.6', passed: false, output, workspace, project,
  checks: Object.fromEntries(expectedChecks.map(name => [name, { status: 'not_run' }])),
  jobs: [], screenshots: [], pageErrors: [], output_save_requests: [], transport_retries: [] };
let host;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
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
async function modelReady(page) {
  await eventually(()=>page.locator('.render-status').evaluate(el=>el.title==='实时预览'||el.textContent.trim()==='实时预览'),'Model not ready',30000);
}
async function launch(options={}) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const runtime = readJson(path.join(root, 'var/runtime.json'));
  const temporary = path.join(output, 'tmp');
  fs.mkdirSync(temporary, { recursive:true });
  const child = spawn(path.join(root, 'var/build/desktop-'+(options.version??'2.4.6')+'/SatelliteStudio.Desktop.exe'),
    ['--project-root', options.project??project, '--workspace', options.workspace??workspace, '--python', runtime.python],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env, TEMP:temporary, TMP:temporary, TMPDIR:temporary,
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
  page.on('console', message => { if (message.type() === 'error') (report.consoleErrors ??= []).push({text:message.text(),location:message.location()}); });
  page.on('response', response => { if (response.status() >= 400) (report.httpErrors ??= []).push({status:response.status(),url:response.url()}); });
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
  await modelReady(page);
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

const countInput = page => page.getByRole('spinbutton', { name: '采集数量', exact: true });
const modeSelect = page => page.getByRole('combobox', { name: '生成模式', exact: true });
const distanceInput = page => page.getByRole('spinbutton', { name: '拍摄距离数值', exact: true });
async function setTheme(page, theme) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: '外观主题', exact: true }).selectOption(theme);
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
}
async function changeMode(page, mode) { await modeSelect(page).selectOption(mode); }
async function setCount(page, count) {
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await countInput(page).fill(String(count));
}
async function readyGenerate(page, count) {
  await eventually(async () => await page.locator('.generate').isEnabled() &&
    (await page.locator('.generate').innerText()).includes(`生成 ${count} 张图片`), 'Generate count/enabled state not synchronized');
}
async function capture(instance, label, count) {
  await readyGenerate(instance.page, count);
  const responsePromise = instance.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/jobs');
  await instance.page.locator('.generate').click();
  const response = await responsePromise;
  assert(response.ok(), await response.text());
  const sent = response.request().postDataJSON();
  if (count > 1) await setCount(instance.page, count + 1);
  const job = await waitJob(instance, await response.json());
  const snapshot = readJson(path.join(job.output_directory, 'job.json'));
  assert(sent.count === count && snapshot.count === count && job.total_frames === count && job.completed_frames === count,
    `Frozen count mismatch ${label}`);
  const files = inventory(job.output_directory);
  const poses = [];
  for (let i = 1; i <= count; i++) {
    const id = String(i).padStart(6, '0');
    const pose = readJson(path.join(job.output_directory, `poses/${id}.json`));
    const labelValues = fs.readFileSync(path.join(job.output_directory, `labels/${id}.txt`), 'utf8').trim().split(/\s+/).map(Number);
    assert(labelValues.length === 5 && labelValues[0] === 0 && labelValues.slice(1).every((v, n) => Number.isFinite(v) && Math.abs(v - pose.bbox_yolo[n]) < 1e-10), 'YOLO label differs from saved pose');
    assert(pose.model_sha256 && pose.renderer.name && pose.resolution.every(v => v === 1024), 'Real model/renderer provenance missing');
    poses.push({ id, distance_m: pose.distance_m, png: inspectPng(path.join(job.output_directory, `images_clean/${id}.png`)), model_sha256: pose.model_sha256 });
  }
  assert(Object.keys(files).filter(f => /^images_clean[\\/].*png$/.test(f)).length === count, 'Saved PNG count mismatch');
  const evidence = { label, id: job.id, mode: job.mode, directory: job.output_directory, sent, snapshot, poses, files,
    draft_changed_after_submit:count>1 ? count+1 : null };
  report.jobs.push(evidence);
  await closeNotice(instance.page);
  return evidence;
}
async function selectResult(page, modeLabel) {
  await page.locator('.job-row').filter({ hasText: modeLabel }).first().click();
  await eventually(() => page.getByAltText('任务已保存的正式灰度 PNG').evaluate(img => img.complete && img.naturalWidth === 1024), 'Saved image unavailable');
}
async function measureLayout(page, results) {
  return page.evaluate(results => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom }; };
    const scrolls = [...document.querySelectorAll('*')].filter(el => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && !['hidden','clip'].includes(style.overflowX);
    }).map(el => ({ tag:el.tagName, class:el.className, client:el.clientWidth, scroll:el.scrollWidth }));
    return { width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
      action:rect(results ? '.frame-navigation' : '.generate'),
      primary:rect(results ? '.result-panel' : '.scene-panel'), secondary:rect(results ? '.queue-panel' : '.right-column'), horizontalOverflows:scrolls };
  }, results);
}

(async () => {
  fs.mkdirSync(output, { recursive:true });
  try {
    await step('isolated_fixture', async () => {
      assert(!fs.existsSync(workspace), 'QA workspace must be new');
      for (const relative of ['apps/ui/dist', 'python/src']) fs.cpSync(path.join(root, relative), path.join(project, relative), { recursive:true, filter:file => !file.includes('__pycache__') });
      fs.cpSync(path.join(root,'assets/models'), path.join(project,'assets/models'), { recursive:true, filter:file => fs.statSync(file).isDirectory() || ['.json','.glb'].includes(path.extname(file)) });
      const files = inventory(project);
      assert(!Object.keys(files).some(f => /\.blend\d?$|blender\.exe/i.test(f)), 'GLB-only fixture violated');
      report.build = { executable_sha256:digest(path.join(root,'var/build/desktop-2.4.6/SatelliteStudio.Desktop.exe')), ui_dist_sha256:inventory(path.join(project,'apps/ui/dist')) };
      return { uses_user_workspace:false, files:Object.keys(files).length };
    });
    const instance = await launch(), page = instance.page;
    assert(await page.evaluate(() => !!window.chrome?.webview), 'Not native WebView2');
    report.input_events=[];
    await page.exposeFunction('recordAcceptanceInputEvent', event=>report.input_events.push(event));
    // Passive diagnostics only: never alter product state or browser event propagation.
    await page.evaluate(()=>{
      for(const type of ['input','change','wheel']) document.addEventListener(type,event=>{
        const el=event.target;
        void window.recordAcceptanceInputEvent({type,time:performance.now(),trusted:event.isTrusted,
          label:el.getAttribute?.('aria-label')??el.labels?.[0]?.textContent??'',tag:el.tagName,value:el.value??null,
          deltaY:event.deltaY??null,distance:document.querySelector('[aria-label="拍摄距离数值"]')?.value??null,
          mode:document.querySelector('[aria-label="生成模式"]')?.value??null});
      },{capture:true,passive:true});
    });
    report.native_startup = await page.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
    report.native_host = { pid:instance.child.pid, origin:instance.origin, debug_port:instance.port };
    await page.setViewportSize({width:1648,height:956});
    assert((await instance.api('/api/jobs')).length === 0, 'Fixture contains tasks');
    await step('count_presets_and_invalid', async () => {
      await changeMode(page,'coverage');
      const rows=[];
      for (const value of [100,500,1000]) {
        const button=page.getByRole('button',{name:String(value),exact:true}); await button.click();
        assert(await countInput(page).inputValue()===String(value) && await button.getAttribute('aria-pressed')==='true','Preset/input state mismatch');
        await readyGenerate(page,value); rows.push({preset:value,button:await page.locator('.generate').innerText()});
      }
      await setCount(page,300); await readyGenerate(page,300);
      await countInput(page).fill('100');
      assert(await page.getByRole('button',{name:'自定义',exact:true}).getAttribute('aria-pressed')==='true', 'Typing preset value exited custom');
      await page.getByRole('button',{name:'500',exact:true}).click();
      assert(await page.getByRole('button',{name:'自定义',exact:true}).getAttribute('aria-pressed')==='false','Preset did not leave custom state');
      await countInput(page).fill('120');
      assert(await page.getByRole('button',{name:'自定义',exact:true}).getAttribute('aria-pressed')==='true','Editing preset did not activate custom');
      const before=(await instance.api('/api/jobs')).length;
      let posts=0; const watch=request=>{if(request.method()==='POST' && new URL(request.url()).pathname==='/api/jobs') posts++;};page.on('request',watch);
      for(const value of ['', '0','-1','1.5','100001']) {
        await countInput(page).fill(value);
        assert(await countInput(page).inputValue()===value,'Invalid draft silently altered');
        assert(await page.locator('.generate').isDisabled(),'Invalid draft allows generation');
        await countInput(page).press('Enter'); await pause(100);
      }
      page.off('request',watch);
      assert(posts===0 && (await instance.api('/api/jobs')).length===before,'Invalid counts submitted jobs');
      await countInput(page).fill('');
      await page.getByRole('button',{name:'重置参数',exact:true}).click();
      await readyGenerate(page,1);
      assert(await modeSelect(page).inputValue()==='single' && await countInput(page).count()===0 && Number(await distanceInput(page).inputValue())===20,'Reset from invalid draft did not restore single defaults');
      await closeNotice(page);await changeMode(page,'coverage');
      await setCount(page,300); await readyGenerate(page,300);
      return {presets:rows, custom:300, invalid:['blank',0,-1,1.5,100001],invalid_post_requests:posts,invalid_reset_restores_single:true};
    });
    await step('mode_defaults',async()=>{
      const rows=[];
      for(const [mode,count] of [['single',1],['coverage',1000],['sequence',120],['custom_sequence',120]]) {
        await changeMode(page,mode); await readyGenerate(page,count);
        if(mode==='single') assert(await countInput(page).count()===0,'Single count editable');
        else assert(await countInput(page).inputValue()===String(count),'Mode default changed');
        rows.push({mode,count,distance_km:Number(await distanceInput(page).inputValue())});
      }
      await setCount(page,1); assert(await page.locator('.generate').isDisabled(),'Start/end sequence accepts one frame');
      await setCount(page,2); await readyGenerate(page,2);
      return rows;
    });
    await step('real_jobs_and_frozen_counts',async()=>{
      const rows=[];
      for(const [mode,count] of [['single',1],['coverage',3],['sequence',3],['custom_sequence',3]]) {
        await changeMode(page,mode);
        (report.fixed_capture_preconditions??=[]).push({mode,distance_km:Number(await distanceInput(page).inputValue())});
        if(mode!=='single') await setCount(page,count);
        if(mode==='custom_sequence') {
          await page.getByRole('button',{name:'起点使用当前姿态',exact:true}).click();
          const angle=page.getByRole('spinbutton',{name:'X 轴旋转数值',exact:true});await angle.fill('30');await angle.press('Tab');
          await page.getByRole('button',{name:'终点使用当前姿态',exact:true}).click();
          await setCount(page,120);
          await page.getByRole('button',{name:'播放预览',exact:true}).click();
          await page.getByRole('button',{name:'暂停预览',exact:true}).waitFor();
          await setCount(page,4);
          await page.getByRole('button',{name:'播放预览',exact:true}).waitFor();
          assert(await page.getByRole('button',{name:'退出预览',exact:true}).count()===0 && await page.getByRole('slider',{name:'预览帧',exact:true}).getAttribute('max')==='3','Count change did not exit/rebuild trajectory');
          assert((await page.getByLabel('当前预览帧',{exact:true}).innerText()).trim()==='1 / 4','Trajectory frame not reset for new count');
          report.trajectory_count_change={from:120,to:4,playing_stopped:true,frame_reset:true};
          await setCount(page,3);
          await page.getByRole('button',{name:'播放预览',exact:true}).click(); await pause(100);
          await page.getByRole('button',{name:'退出预览',exact:true}).click();
          await readyGenerate(page,3);
        }
        const job=await capture(instance,mode,count);
        assert(job.sent.mode===mode && job.poses.every(p=>p.distance_m===20000),'Fixed distance/mode changed');rows.push({mode,id:job.id,count});
      }
      return rows;
    });
    await step('distance_policy',async()=>{
      const rows=[];
      for(const mode of ['coverage','sequence']) {
        await changeMode(page,mode);await setCount(page,3);
        const policy=page.getByRole('combobox',{name:'拍摄距离方式',exact:true});await policy.selectOption('automatic');
        assert(await page.getByRole('button',{name:'重置距离',exact:true}).isDisabled(),'Automatic distance reset enabled');
        const job=await capture(instance,`${mode}-automatic`,3),distances=job.poses.map(p=>p.distance_m);
        assert(job.sent.distance_policy==='automatic' && distances.every(d=>d>=10000 && d<=30000) && new Set(distances).size>1,'Automatic distances changed');
        if(mode==='sequence')assert(distances[0]===30000 && distances.at(-1)===10000,'Sequence distance endpoints changed');
        await policy.selectOption('fixed');assert(Number(await distanceInput(page).inputValue())===20,'Retained fixed distance lost');
        rows.push({mode,id:job.id,distances});
      }return rows;
    });
    await step('saved_results_and_noise',async()=>{
      await page.getByRole('button',{name:'任务与结果',exact:true}).click();
      await selectResult(page,'起止姿态序列');
      assert(await page.getByRole('button',{name:'噪声图',exact:true}).isDisabled(),'Clean-only result exposes noisy image');
      assert(await page.getByRole('button',{name:'原图',exact:true}).isEnabled(),'Original image unavailable');
      await page.getByRole('button',{name:'下一帧',exact:true}).click();
      await eventually(async()=> (await page.locator('.frame-navigation').innerText()).includes('第 2 / 3 张'),'Next frame failed');
      await page.getByRole('button',{name:'上一帧',exact:true}).click();
      await eventually(async()=> (await page.locator('.frame-navigation').innerText()).includes('第 1 / 3 张'),'Previous frame failed');
      await page.getByRole('button',{name:'放大图像',exact:true}).click();
      assert(await page.getByRole('button',{name:'复位图像显示',exact:true}).innerText()==='125%','Zoom failed');
      await page.getByRole('button',{name:'复位图像显示',exact:true}).click();
      const source=report.jobs.find(j=>j.label==='custom_sequence'),before=inventory(source.directory);
      await page.getByRole('button',{name:'基于原图追加噪声',exact:true}).click();
      const dialog=page.getByRole('dialog');
      await dialog.getByRole('combobox',{name:'追加噪声强度',exact:true}).selectOption('medium');
      const job=await submitFromUI(instance,dialog.getByRole('button',{name:'基于原图生成噪声版本',exact:true}),`/api/jobs/${source.id}/noise-variants`,'derived-noise');
      assert(job.mode==='noise_variant' && job.source_job_id===source.id && job.completed_frames===3,'Invalid derived noise job');
      assert(JSON.stringify(before)===JSON.stringify(inventory(source.directory)),'Noise variant modified original assets');
      await closeNotice(page);
      if(await page.getByRole('dialog').count())await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
      await selectResult(page,'噪声版本');
      assert(await page.getByRole('button',{name:'噪声图',exact:true}).isEnabled() && await page.getByRole('button',{name:'原图',exact:true}).isEnabled(),'Derived images unavailable');
      await page.getByRole('button',{name:'原图',exact:true}).click();
      await eventually(()=>page.getByAltText('任务已保存的正式灰度 PNG').evaluate(img=>img.complete && img.naturalWidth===1024),'Derived original unavailable');
      await page.getByRole('button',{name:'噪声图',exact:true}).click();
      inspectPng(path.join(job.output_directory,'images_noisy/000001.png'));
      return {source_id:source.id,derived_id:job.id,source_hashes_unchanged:true};
    });
    await step('theme_persistence_and_layout',async()=>{
      const rows=[];
      for(const theme of ['light','dark']) {
        await setTheme(page,theme);await page.reload();
        await page.getByRole('button',{name:'设置',exact:true}).click();
        assert(await page.getByRole('combobox',{name:'外观主题',exact:true}).inputValue()===theme,'Theme preference lost on reload');
        assert(await page.evaluate(()=>document.documentElement.dataset.theme)===theme,'Persisted theme not applied');
        await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
        for(const size of [{width:1648,height:956},{width:1108,height:620},{width:960,height:600}]) {
          await page.setViewportSize(size);
          for(const results of [false,true]) {
            await page.getByRole('button',{name:results?'任务与结果':'数据采集',exact:true}).click();
            if(results) {
              await selectResult(page,'起止姿态序列');
              await page.getByRole('button',{name:'下一帧',exact:true}).click();
              await eventually(async()=> (await page.locator('.frame-navigation').innerText()).includes('第 2 / 3 张'),'Screenshot frame selection failed');
            }
            else {
              await changeMode(page,'single');
              for(const [axis,value] of [['X',45],['Y',-25],['Z',0]]) {
                const field=page.getByRole('spinbutton',{name:`${axis} 轴旋转数值`,exact:true});await field.fill(String(value));await field.press('Tab');
              }
              report.reference_capture_pose={xyz_deg:[45,-25,0],distance_m:20000,reason:'Show actual satellite surfaces at unchanged physical distance'};
              await changeMode(page,'coverage');await setCount(page,300);
              await page.getByRole('button',{name:/^(拖动调姿|模型预览)$/}).click();await modelReady(page);await readyGenerate(page,300);
            }
            await pause(180);
            const measurement=await measureLayout(page,results);
            assert(measurement.scrollWidth<=size.width+1 && measurement.scrollHeight<=size.height+1,'Document overflow');
            assert(measurement.horizontalOverflows.length===0,`Horizontal control overflow: ${JSON.stringify(measurement.horizontalOverflows)}`);
            const action=measurement.action;assert(action.width>0 && action.y>=0 && action.bottom<=size.height && action.right<=size.width,'Generate/frame controls outside viewport');
            if(!results)assert(measurement.primary.width>measurement.secondary.width,'Capture smaller than settings');
            await screenshot(page,`${results?'results':'capture'}-${theme}-${size.width}x${size.height}.png`);
            rows.push({theme,results,...measurement});
          }
        }
      }return rows;
    });
    await step('no_browser_errors',async()=>{
      assert(report.pageErrors.length===0 && (report.consoleErrors??[]).length===0,JSON.stringify({page:report.pageErrors,console:report.consoleErrors}));
      return {page_errors:0,console_errors:0};
    });
    await step('owned_process_cleanup',async()=>{await close(instance);return{host_closed:true,service_closed:true};});
    report.passed=expectedChecks.every(name=>report.checks[name].status==='passed');checkpoint(report.passed?'passed':'failed');
  } catch(error) {
    report.error=String(error);report.stack=error.stack;checkpoint('failed',{error:String(error)});
    if(host?.page){report.body=await host.page.locator('body').innerText().catch(()=>'');await screenshot(host.page,'failure.png').catch(()=>{});}process.exitCode=1;
  } finally {
    if(host){try{await close(host);}catch(error){report.cleanup_error=String(error);if(host?.child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch(killError){report.forced_cleanup_error=String(killError);}}await host?.browser?.close().catch(()=>{});}}
    report.counts={total:expectedChecks.length,passed:Object.values(report.checks).filter(v=>v.status==='passed').length,failed:Object.values(report.checks).filter(v=>v.status==='failed').length,not_run:Object.values(report.checks).filter(v=>v.status==='not_run').length};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,output,counts:report.counts}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
