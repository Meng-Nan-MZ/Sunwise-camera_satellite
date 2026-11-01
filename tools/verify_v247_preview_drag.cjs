/* V2.4.7 native acceptance: editable capture poses and preview-only drag, isolated GLB-only fixture.
 * Run after UI and var/build/desktop-2.4.7 builds are ready:
 * $env:NODE_PATH='C:/Users/mz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
 * node tools/verify_v247_preview_drag.cjs
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
const output = path.join(root, 'var/verification/v2.4.7-inspection-drag', `${Date.now()}-${process.pid}`);
const workspace = path.join(output, 'workspace');
const project = path.join(output, 'application');
const rootA = output, rootB = output;
const controlPath = path.join(root, 'var/development/v2.4.7/acceptance-control.json');
const expectedChecks = ['isolated_fixture','single_custom_drag','random_preview_only_and_formal','preview_reset','custom_play_pause_takeover','distance_rotation','no_browser_errors','owned_process_cleanup'];
const report = { version: '2.4.7', passed: false, output, workspace, project,
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
  const child = spawn(path.join(root, 'var/build/desktop-'+(options.version??process.env.STUDIO_QA_DESKTOP_VERSION??'2.4.7')+'/SatelliteStudio.Desktop.exe'),
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

async function state(page) {
  const technical=page.locator('.right-column details.technical-details');
  if(await technical.getAttribute('open')===null)await technical.locator('summary').click();
  return page.evaluate(()=>{
    const input=label=>{const el=document.querySelector(`[aria-label="${label}"]`);return el?{value:el.value,disabled:el.disabled||!!el.closest('fieldset:disabled')}:null;};
    const box=document.querySelector('.canvas-host canvas').getBoundingClientRect();
    return {quaternion_wxyz:document.querySelector('.right-column .technical-details code').textContent.trim().split(/\s+/).map(Number),
      xyz:['X','Y','Z'].map(axis=>input(`${axis} 轴旋转数值`)),
      distance:input('拍摄距离数值'),hint:document.querySelector('.viewport-bottom')?.innerText??'',
      caption:document.querySelector('.preview-caption')?.innerText??'',
      guidance:[...document.querySelectorAll('.manual-pose .control-caption,.mode-guidance')].map(el=>el.innerText),
      preview_frame:document.querySelector('[aria-label="当前预览帧"]')?.innerText??null,
      playback_buttons:[...document.querySelectorAll('.preview-playback button')].map(el=>el.textContent.trim()),
      canvas:{x:box.x,y:box.y,width:box.width,height:box.height}};
  });
}
async function dragCase(page,label) {
  const before=await state(page);await screenshot(page,`${label}-before.png`);
  const pixelBefore=digestBuffer(await page.locator('.canvas-host canvas').screenshot());
  const b=before.canvas,x=b.x+b.width/2,y=b.y+b.height/2;
  await page.mouse.move(x,y);await page.mouse.down();
  const pointerDown = label==='custom-takeover-paused' ? await state(page) : null;
  if(pointerDown){
    assert(Math.max(...before.quaternion_wxyz.map((q,i)=>Math.abs(q-pointerDown.quaternion_wxyz[i])))<0.000003,'Paused takeover jumped pose before any pointer movement');
    assert(!pointerDown.playback_buttons.includes('退出预览'),'Paused pointerdown did not exit sequence preview');
  }
  await page.mouse.move(x+65,y-35,{steps:8});await page.mouse.up();await pause(150);
  const after=await state(page),pixelAfter=digestBuffer(await page.locator('.canvas-host canvas').screenshot());
  await screenshot(page,`${label}-after.png`);
  const result={label,before,pointer_down_without_movement:pointerDown,after,quaternion_changed:JSON.stringify(before.quaternion_wxyz)!==JSON.stringify(after.quaternion_wxyz),
    xyz_changed:JSON.stringify(before.xyz)!==JSON.stringify(after.xyz),canvas_changed:pixelBefore!==pixelAfter,
    gesture:{from:[x,y],to:[x+65,y-35],steps:8},pixels_before:pixelBefore,pixels_after:pixelAfter};
  (report.cases??=[]).push(result);return result;
}
const digestBuffer=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const mode=async(page,value)=>page.getByRole('combobox',{name:'生成模式',exact:true}).selectOption(value);
const inspect=async page=>page.getByRole('button',{name:/^(拖动调姿|模型预览)$/}).click();
const pixels=async page=>{await pause(160);return digestBuffer(await page.locator('.canvas-host canvas').screenshot());};
const renderMetrics=page=>page.evaluate(()=>{const c=document.querySelector('.canvas-host canvas');return{dpr:devicePixelRatio,buffer:[c.width,c.height],client:[c.clientWidth,c.clientHeight]};});
const settleFrame=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function count(page,value){await page.getByRole('button',{name:'自定义',exact:true}).click();await page.getByRole('spinbutton',{name:'采集数量',exact:true}).fill(String(value));}
async function endpoints(page){return Promise.all(['起点','终点'].flatMap(label=>['X','Y','Z'].map(axis=>page.getByRole('spinbutton',{name:`${label}${axis}角度`,exact:true}).inputValue())));}
function comparablePose(pose){const p=structuredClone(pose);delete p.renderer.render_ms;delete p.sequence_id;delete p.scene.sequence_id;return p;}
function nearQuaternion(pose,expected,message){const p=pose.Location.SatQuat,actual=[p.W,p.X,p.Y,p.Z],sign=actual.reduce((v,q,i)=>v+q*expected[i],0)<0?-1:1;assert(Math.max(...actual.map((q,i)=>Math.abs(q-sign*expected[i])))<0.000003,message);}
async function capture(instance,label,value=3){
  const page=instance.page;if(value!==1)await count(page,value);
  await eventually(()=>page.locator('.generate').isEnabled(),'Generate not enabled');
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/jobs');
  await page.locator('.generate').click();const response=await pending;assert(response.ok(),await response.text());
  const sent=response.request().postDataJSON(),job=await waitJob(instance,await response.json()),directory=job.output_directory;
  assert(sent.count===value&&job.completed_frames===value,'Formal frame count mismatch');
  const frames=[];for(let i=1;i<=value;i++){const id=String(i).padStart(6,'0'),pose=readJson(path.join(directory,`poses/${id}.json`));frames.push({id,png:inspectPng(path.join(directory,`images_clean/${id}.png`)),pose,label_sha256:digest(path.join(directory,`labels/${id}.txt`))});}
  const item={label,id:job.id,directory,sent,snapshot:readJson(path.join(directory,'job.json')),frames};report.jobs.push(item);await closeNotice(page);return item;
}
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  try{
    await step('isolated_fixture',async()=>{
      for(const relative of ['apps/ui/dist','python/src'])fs.cpSync(path.join(root,relative),path.join(project,relative),{recursive:true,filter:file=>!file.includes('__pycache__')});
      fs.cpSync(path.join(root,'assets/models'),path.join(project,'assets/models'),{recursive:true,filter:file=>fs.statSync(file).isDirectory()||['.json','.glb'].includes(path.extname(file))});
      const desktopVersion=process.env.STUDIO_QA_DESKTOP_VERSION??'2.4.7';
      report.build={ui:inventory(path.join(project,'apps/ui/dist')),source_head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),desktop_version:desktopVersion,desktop_sha256:digest(path.join(root,`var/build/desktop-${desktopVersion}/SatelliteStudio.Desktop.exe`))};
      return{uses_user_workspace:false,real_glb_only:true};
    });
    const instance=await launch(),page=instance.page;report.native={pid:instance.child.pid,origin:instance.origin};
    report.native.document_title=await page.title();
    assert(report.native.document_title.includes('V2.4.7'),'Final UI title is not V2.4.7');
    report.pixel_density_setup={native:await renderMetrics(page)};
    await page.setViewportSize({width:1648,height:956});
    report.pixel_density_setup.after_viewport_override=await renderMetrics(page);
    // CDP's viewport override changes DPR from native Windows scaling to 1.
    // Recreate the fixture renderer once so every compared canvas uses that same DPR.
    const densityModels=page.getByRole('combobox',{name:'卫星模型',exact:true}),densityOriginal=await densityModels.inputValue(),densityOptions=await densityModels.locator('option').evaluateAll(items=>items.map(el=>el.value));
    await densityModels.selectOption(densityOptions.find(value=>value!==densityOriginal));await modelReady(page);await settleFrame(page);
    await densityModels.selectOption(densityOriginal);await modelReady(page);await settleFrame(page);
    report.pixel_density_setup.normalized=await renderMetrics(page);
    assert(Math.abs(report.pixel_density_setup.normalized.buffer[0]/report.pixel_density_setup.normalized.client[0]-1)<0.01,'Fixture renderer DPR was not normalized');
    await step('single_custom_drag',async()=>{
      const rows=[];for(const value of ['single','custom_sequence']){await mode(page,value);await inspect(page);const r=await dragCase(page,`${value}-editable`);assert(r.quaternion_changed&&r.xyz_changed&&r.canvas_changed,`${value} manual drag failed`);rows.push(r.label);}return rows;
    });
    await step('random_preview_only_and_formal',async()=>{
      const rows=[];for(const value of ['coverage','sequence']){
        await mode(page,value);await inspect(page);await count(page,3);
        const before=await capture(instance,`${value}-before-drag`),r=await dragCase(page,`${value}-inspection-only`);
        assert(r.canvas_changed&&!r.quaternion_changed&&!r.xyz_changed,`${value} inspection did not remain separate from capture pose`);
        const after=await capture(instance,`${value}-after-drag`);
        assert(JSON.stringify(before.sent)===JSON.stringify(after.sent),`${value} inspection polluted formal request`);
        for(let i=0;i<3;i++){
          assert(before.frames[i].png.sha256===after.frames[i].png.sha256,`${value} inspection affected PNG ${i}`);
          assert(before.frames[i].label_sha256===after.frames[i].label_sha256,`${value} inspection affected labels ${i}`);
          assert(JSON.stringify(comparablePose(before.frames[i].pose))===JSON.stringify(comparablePose(after.frames[i].pose)),`${value} inspection affected formal pose ${i}`);
        }
        rows.push({mode:value,before:before.id,after:after.id,request_exact_equal:true,png_label_equal:true,pose_equal_except:['renderer.render_ms','sequence_id','scene.sequence_id']});
      }return rows;
    });
    await step('preview_reset',async()=>{
      await mode(page,'coverage');await inspect(page);const baseline=await pixels(page);
      await dragCase(page,'reset-exit-inspect-drag');await page.getByRole('button',{name:'拍摄视角',exact:true}).click();await inspect(page);
      assert(await pixels(page)===baseline,'Leaving inspect did not reset observation pose');
      await dragCase(page,'reset-mode-drag');await mode(page,'sequence');await mode(page,'coverage');
      assert(await pixels(page)===baseline,'Mode switch did not reset observation pose');
      const models=page.getByRole('combobox',{name:'卫星模型',exact:true}),original=await models.inputValue(),options=await models.locator('option').evaluateAll(items=>items.map(el=>el.value));
      await dragCase(page,'reset-model-drag');await models.selectOption(options.find(v=>v!==original));await modelReady(page);await models.selectOption(original);await modelReady(page);
      assert(await pixels(page)===baseline,'Model switch did not reset observation pose');
      await dragCase(page,'reset-page-drag');await page.getByRole('button',{name:'任务与结果',exact:true}).click();await page.getByRole('button',{name:'数据采集',exact:true}).click();await modelReady(page);
      assert(await pixels(page)===baseline,'Page switch did not reset observation pose');
      return{leave_inspect:true,mode_switch:true,model_switch:true,page_switch:true};
    });
    await step('custom_play_pause_takeover',async()=>{
      const rows=[];
      for(const status of ['playing','paused']){
        await mode(page,'custom_sequence');await inspect(page);await count(page,120);
        const originalEndpoints=await endpoints(page);
        await page.getByRole('button',{name:'播放预览',exact:true}).click();await pause(250);
        if(status==='paused')await page.getByRole('button',{name:'暂停预览',exact:true}).click();
        const r=await dragCase(page,`custom-takeover-${status}`);
        assert(r.canvas_changed&&r.quaternion_changed,'Dragging active trajectory did not edit displayed pose');
        assert(await page.getByRole('button',{name:'退出预览',exact:true}).count()===0,'Dragging did not exit trajectory preview');
        assert(r.after.xyz.every(el=>el&&!el.disabled),'Dragging did not restore manual controls');
        assert(JSON.stringify(originalEndpoints)===JSON.stringify(await endpoints(page)),'Dragging silently modified trajectory endpoints');
        rows.push({status,manual_controls_enabled:true,exited_preview:true,endpoints_unchanged:true});
      }
      const start=(await state(page)).quaternion_wxyz;await page.getByRole('button',{name:'起点使用当前姿态',exact:true}).click();
      const z=page.getByRole('spinbutton',{name:'Z 轴旋转数值',exact:true});await z.fill('25');await z.press('Tab');
      const end=(await state(page)).quaternion_wxyz;await page.getByRole('button',{name:'终点使用当前姿态',exact:true}).click();
      const job=await capture(instance,'custom-copied-endpoints');nearQuaternion(job.frames[0].pose,start,'Copied start quaternion mismatch');nearQuaternion(job.frames[2].pose,end,'Copied end quaternion mismatch');
      return{takeover:rows,copied_endpoint_job:job.id,start_wxyz:start,end_wxyz:end};
    });
    await step('distance_rotation',async()=>{
      await mode(page,'coverage');await inspect(page);
      const before=await state(page);await dragCase(page,'before-distance-inspection');
      let box=await page.locator('.canvas-host canvas').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-120);await pause(180);
      const after=await state(page);assert(Number(after.distance.value)<Number(before.distance.value),'Fixed wheel distance failed');assert(JSON.stringify(before.quaternion_wxyz)===JSON.stringify(after.quaternion_wxyz),'Fixed wheel/observation altered capture quaternion');
      const policy=page.getByRole('combobox',{name:'拍摄距离方式',exact:true});await policy.selectOption('automatic');
      const staticBefore=await pixels(page);await page.mouse.wheel(0,120);await pause(180);assert(await pixels(page)===staticBefore,'Automatic wheel changed preview distance');
      await policy.selectOption('fixed');
      const rotation=page.getByRole('checkbox',{name:'旋转预览',exact:true});const saved=await state(page);await rotation.check();await pause(250);const a=await pixels(page);await pause(350);const b=await pixels(page);
      assert(a!==b,'Preview rotation did not animate');assert(JSON.stringify((await state(page)).quaternion_wxyz)===JSON.stringify(saved.quaternion_wxyz),'Preview rotation changed capture pose');
      const dragged=await dragCase(page,'rotation-then-drag');assert(!await rotation.isChecked(),'Dragging did not stop preview rotation');assert(!dragged.quaternion_changed,'Observation drag after rotation changed capture pose');
      await page.getByRole('button',{name:'重置距离',exact:true}).click();assert(Number((await state(page)).distance.value)===20,'Distance reset failed');
      return{fixed_wheel:true,automatic_wheel_ignored:true,rotation_visual_only:true,drag_stops_rotation:true,reset_20km:true};
    });
    await step('no_browser_errors',async()=>{assert(report.pageErrors.length===0&&(report.consoleErrors??[]).length===0,JSON.stringify({page:report.pageErrors,console:report.consoleErrors}));return{page_errors:0,console_errors:0};});
    await step('owned_process_cleanup',async()=>{await close(instance);return{host_closed:true,service_closed:true};});
    report.passed=expectedChecks.every(name=>report.checks[name].status==='passed');checkpoint(report.passed?'passed':'failed');
  }catch(error){report.error=String(error);report.stack=error.stack;checkpoint('failed',{error:String(error)});if(host?.page){await host.page.mouse.up().catch(()=>{});report.body=await host.page.locator('body').innerText().catch(()=>'');await screenshot(host.page,'failure.png').catch(()=>{});}process.exitCode=1;}
  finally{
    if(host)try{await close(host);}catch(error){report.cleanup_error=String(error);if(host?.child.exitCode===null)try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
    report.counts={total:expectedChecks.length,passed:Object.values(report.checks).filter(v=>v.status==='passed').length,failed:Object.values(report.checks).filter(v=>v.status==='failed').length,not_run:Object.values(report.checks).filter(v=>v.status==='not_run').length};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,output,counts:report.counts,error:report.error}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
