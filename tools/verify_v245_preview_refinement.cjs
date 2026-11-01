/* V2.4.5 native acceptance: pure preview rotation and compact toolbar, isolated GLB-only fixture.
 * NODE_PATH must provide the development-only playwright/pngjs packages.
 * No simulated picker or production workspace; no product state injection.
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
const THREE = require(path.join(root, 'apps/ui/node_modules/three/build/three.cjs'));
const output = path.join(root, 'var/verification/v2.4.5-preview-refinement', `${Date.now()}-${process.pid}`);
const workspace = path.join(output, 'workspace');
const project = path.join(output, 'application');
const rootA = output, rootB = output;
const controlPath = path.join(root, 'var/development/v2.4.5/qa-control.json');
const expectedChecks = ['isolated_fixture','v244_native_layout_baseline','native_defaults_and_removed_safe_frame',
  'rotation_visual_only','rotation_direction_reference','rotation_off_restores','formal_png_pose_invariance',
  'capture_switch_stops_rotation','mode_model_page_switches_stop','manual_drag_wheel_regression',
  'localized_modes_and_real_results','compact_toolbar_both_themes','footer_help','no_browser_errors','owned_process_cleanup'];
const report = { version: '2.4.5', passed: false, output, workspace, project,
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
  const child = spawn(path.join(root, 'var/build/desktop-'+(options.version??'2.4.5')+'/SatelliteStudio.Desktop.exe'),
    ['--project-root', options.project??project, '--workspace', options.workspace??workspace, '--python', runtime.python],
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

const tuple = q => [q.X, q.Y, q.Z, q.W];
function sameRotation(a, b, tolerance = 0.000003) {
  const sign = a.reduce((sum, value, index) => sum + value * b[index], 0) < 0 ? -1 : 1;
  return Math.max(...a.map((value, index) => Math.abs(value - sign * b[index]))) <= tolerance;
}
function qFromAngles(angles) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles.map(value => value * Math.PI / 180), 'XYZ')).toArray();
}
async function angles(page) {
  return Promise.all(['X', 'Y', 'Z'].map(async axis => Number(await page.getByRole('spinbutton', { name: `${axis} 轴旋转数值`, exact: true }).inputValue())));
}
async function readQuaternion(page) {
  const settings = page.getByRole('complementary', { name: '本次采集参数', exact: true });
  const details = settings.locator('details.technical-details');
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
  const values = (await details.locator('code').innerText()).trim().split(/\s+/).map(Number);
  assert(values.length === 4 && values.every(Number.isFinite), 'Invalid technical quaternion readout');
  return [values[1], values[2], values[3], values[0]];
}
async function canvasBox(page) {
  const box = await page.locator('.canvas-host canvas').boundingBox();
  assert(box?.width > 0 && box?.height > 0, 'Viewport canvas missing');
  return box;
}
async function gesture(page, dx = 60, dy = -32, keepDown = false) {
  const box = await canvasBox(page), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  if (!keepDown) await page.mouse.up();
  return { box, x, y };
}
async function waitAnglesChange(page, before) {
  return eventually(async () => { const next = await angles(page); return JSON.stringify(next) !== JSON.stringify(before) && next.every(Number.isFinite) ? next : false; }, 'Angles did not update during pointer gesture');
}
async function changeMode(page, mode) {
  await page.getByRole('combobox', { name: '生成模式', exact: true }).selectOption(mode);
}
async function screenshotCanvas(page) {
  return crypto.createHash('sha256').update(await page.locator('.canvas-host canvas').screenshot()).digest('hex');
}


const spin=page=>page.getByRole('checkbox',{name:'旋转预览',exact:true});
const distanceInput=page=>page.getByRole('spinbutton',{name:'拍摄距离数值',exact:true});
const modeLabels={single:'单张采集',coverage:'随机姿态批量',sequence:'自动旋转序列',custom_sequence:'起止姿态序列'};
async function inspectView(page) {await page.getByRole('button',{name:/^(拖动调姿|模型预览)$/}).click();}
async function poseState(page) {return {angles:await angles(page),quaternion:await readQuaternion(page),distance_km:Number(await distanceInput(page).inputValue())};}
async function setAngles(page,values=[31.25,-23.75,18.5]) {
  for(let i=0;i<3;i++){const field=page.getByRole('spinbutton',{name:`${['X','Y','Z'][i]} 轴旋转数值`,exact:true});await field.fill(String(values[i]));await field.press('Tab');}
  await pause(100);
}
function samePoseState(a,b) {return JSON.stringify(a)===JSON.stringify(b);}
async function canvasPixels(page) {
  // The style hides only HTML HUD decorations during pixel measurement; it changes no model or renderer state.
  return page.locator('.canvas-host canvas').screenshot({style:'.viewport-top, .viewport-bottom, .safe-frame { visibility: hidden !important; }'});
}
function difference(bytesA,bytesB) {
  const a=PNG.sync.read(bytesA),b=PNG.sync.read(bytesB);assert(a.width===b.width&&a.height===b.height,'Pixel comparison dimensions differ');
  let sum=0,count=0;
  for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
    if(Math.hypot(x-a.width/2,y-a.height/2)>Math.min(a.width,a.height)*.43)continue;
    const i=(y*a.width+x)*4;for(let c=0;c<3;c++){sum+=(a.data[i+c]-b.data[i+c])**2;count++;}
  }return sum/count;
}
async function storeCanvas(page,name) {const bytes=await canvasPixels(page);fs.writeFileSync(path.join(output,name),bytes);report.screenshots.push(name);return bytes;}
async function staticCanvas(page) {await pause(140);const a=await canvasPixels(page);await pause(350);const b=await canvasPixels(page);assert(difference(a,b)===0,'Preview continued changing while rotation off');return a;}
async function setTheme(page,theme) {
  await page.getByRole('button',{name:'设置',exact:true}).click();const dialog=page.getByRole('dialog');
  await dialog.getByRole('combobox',{name:'外观主题',exact:true}).selectOption(theme);await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();
}
async function layout(page) {
  return page.evaluate(()=>{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
      scene:rect('.scene-panel'),viewport:rect('.viewport'),sidebar:rect('.right-column'),footer:rect('.app-footer'),generate:rect('.generate')};
  });
}
async function capture(instance,label) {
  const page=instance.page,request=page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname==='/api/jobs');
  const rotationBefore=await spin(page).isChecked();await page.locator('.generate').click();const response=await request;
  assert(response.ok(),await response.text());const sent=response.request().postDataJSON(),job=await waitJob(instance,await response.json());
  const directory=job.output_directory,snapshot=readJson(path.join(directory,'job.json'));
  const pose=readJson(path.join(directory,'poses/000001.json')),pngFile=path.join(directory,'images_clean/000001.png');
  const png=inspectPng(pngFile),pixels_sha256=crypto.createHash('sha256').update(PNG.sync.read(fs.readFileSync(pngFile)).data).digest('hex');
  const result={label,id:job.id,directory,sent,snapshot,pose,png,pixels_sha256,rotation_checked_before_submit:rotationBefore};
  report.jobs.push(result);await closeNotice(page);return result;
}
async function ensureUnchecked(page,message) {await eventually(async()=>!await spin(page).isChecked(),message);}

(async()=>{
  fs.mkdirSync(output,{recursive:true});let baseline;
  try{
    await step('isolated_fixture',async()=>{
      assert(!fs.existsSync(workspace),'QA workspace must be new');
      for(const relative of ['apps/ui/dist','python/src'])fs.cpSync(path.join(root,relative),path.join(project,relative),{recursive:true,filter:file=>!file.includes('__pycache__')});
      fs.cpSync(path.join(root,'assets/models'),path.join(project,'assets/models'),{recursive:true,filter:file=>fs.statSync(file).isDirectory()||['.json','.glb'].includes(path.extname(file))});
      const files=inventory(project);assert(!Object.keys(files).some(file=>/\.blend\d?$|blender\.exe/i.test(file)),'GLB-only fixture violated');
      report.build={executable_sha256:digest(path.join(root,'var/build/desktop-2.4.5/SatelliteStudio.Desktop.exe')),ui_dist_sha256:inventory(path.join(project,'apps/ui/dist'))};
      return{new_workspace:true,uses_user_workspace:false,files:Object.keys(files).length};
    });
    await step('v244_native_layout_baseline',async()=>{
      const oldReport=readJson(path.join(root,'var/verification/v2.4.4-distance-link/1793554937258-3788/report.json'));
      assert(oldReport.passed,'V244 baseline acceptance was not successful');
      const instance=await launch({version:'2.4.4',project:oldReport.project,workspace:path.join(output,'baseline-workspace')});
      const rows=[];for(const theme of ['dark','light']){await setTheme(instance.page,theme);for(const size of [{width:1108,height:645},{width:960,height:600}]){await instance.page.setViewportSize(size);await pause(120);rows.push({theme,...await layout(instance.page)});}}
      await close(instance);baseline=rows;return{baseline_project:oldReport.project,measurements:rows};
    });
    const instance=await launch(),page=instance.page;
    await step('native_defaults_and_removed_safe_frame',async()=>{
      assert(await page.evaluate(()=>!!window.chrome?.webview),'Not native WebView');assert((await instance.api('/api/jobs')).length===0,'New fixture contains tasks');
      assert(await spin(page).count()===1 && !await spin(page).isChecked(),'Rotation preview must default off');
      assert(await spin(page).isDisabled(),'Rotation should be unavailable in capture view');
      assert(await page.getByRole('checkbox',{name:'安全框',exact:true}).count()===0,'Old safe-frame control remains');
      assert(await page.locator('.safe-frame').count()===0,'Old safe-frame overlay remains');
      await screenshot(page,'native-default.png');await inspectView(page);assert(await spin(page).isEnabled(),'Inspect rotation checkbox disabled');
      await setAngles(page);await readQuaternion(page);return{native:true,default_off:true,capture_disabled:true,safe_frame_removed:true};
    });
    let rotationBaseline,baseState;
    await step('rotation_visual_only',async()=>{
      baseState=await poseState(page);rotationBaseline=await storeCanvas(page,'rotation-off-baseline.png');
      await spin(page).check();await pause(550);const a=await storeCanvas(page,'rotation-on-first.png');await pause(700);const b=await storeCanvas(page,'rotation-on-second.png');
      assert(difference(rotationBaseline,a)>0 && difference(a,b)>0,'Rotation did not animate preview');
      assert(samePoseState(baseState,await poseState(page)),'Preview rotation changed XYZ, quaternion or distance');
      return{before:baseState,after:await poseState(page),successive_pixel_mse:difference(a,b),preview_only:true};
    });
    await step('rotation_direction_reference',async()=>{
      await spin(page).uncheck();await pause(120);const values=baseState.angles,q=new THREE.Quaternion(...qFromAngles(values));
      await spin(page).check();const start=await page.evaluate(()=>performance.now());await pause(1000);
      const before=await page.evaluate(()=>performance.now()),animated=await storeCanvas(page,'rotation-direction-observed.png'),after=await page.evaluate(()=>performance.now());
      await spin(page).uncheck();const degrees=12*((before+after)/2-start)/1000;
      const references=[];
      // A positive right-handed render rotation around vertical +Y maps to negative client-world +Z.
      // Build both world-axis candidates independently, then enter their XYZ values through the visible controls.
      for(const sign of [-1,1]){
        const reference=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),sign*degrees*Math.PI/180).multiply(q);
        const euler=new THREE.Euler().setFromQuaternion(reference,'XYZ');const xyz=[euler.x,euler.y,euler.z].map(v=>v*180/Math.PI);
        await setAngles(page,xyz);const pixels=await storeCanvas(page,`rotation-direction-reference-${sign<0?'ccw':'cw'}.png`);references.push({sign,xyz,mse:difference(animated,pixels)});
      }
      await setAngles(page,values);assert(references[0].mse<references[1].mse,'Preview rotation did not match counter-clockwise world-vertical reference');
      return{rate_deg_s:12,measured_degrees:degrees,reference_comparison:references,method:'timed native animation compared against independent world-axis rotations entered through XYZ controls'};
    });
    await step('rotation_off_restores',async()=>{
      assert(!await spin(page).isChecked(),'Rotation checkbox still checked');assert(samePoseState(baseState,await poseState(page)),'Turning rotation off changed pose');
      const restored=await staticCanvas(page);assert(difference(rotationBaseline,restored)===0,'Turning rotation off did not restore committed pose image');return{parameters_preserved:true,pixels_restored:true};
    });
    await step('formal_png_pose_invariance',async()=>{
      const off=await capture(instance,'preview-rotation-off');await spin(page).check();await pause(700);const on=await capture(instance,'preview-rotation-on');
      assert(off.rotation_checked_before_submit===false&&on.rotation_checked_before_submit===true,'Both on/off submission cases were not exercised');
      assert(off.png.sha256===on.png.sha256 && off.pixels_sha256===on.pixels_sha256,'Preview rotation affected formal PNG');
      const comparablePose=pose=>{const copy=structuredClone(pose);delete copy.renderer.render_ms;return copy;};
      assert(JSON.stringify(comparablePose(off.pose))===JSON.stringify(comparablePose(on.pose)),'Preview rotation affected exported pose data');
      assert(JSON.stringify(off.sent.scene)===JSON.stringify(on.sent.scene),'Preview rotation entered submitted scene parameters');
      await spin(page).uncheck();return{off_id:off.id,on_id:on.id,png_sha256:off.png.sha256,pixel_sha256:off.pixels_sha256,pose_json_equal_except_render_time:true,excluded_metadata_fields:['renderer.render_ms'],scene_exact_match:true};
    });
    await step('capture_switch_stops_rotation',async()=>{
      const before=await poseState(page);await spin(page).check();await pause(200);await page.getByRole('button',{name:'拍摄视角',exact:true}).click();
      await ensureUnchecked(page,'Capture switch did not stop rotation');assert(await spin(page).isDisabled(),'Capture rotation checkbox not disabled');await staticCanvas(page);
      await inspectView(page);assert(!await spin(page).isChecked(),'Returning inspect restarted rotation');assert(samePoseState(before,await poseState(page)),'View switch changed capture parameters');return{stopped:true,return_stays_off:true,parameters_preserved:true};
    });
    await step('mode_model_page_switches_stop',async()=>{
      const results=[];
      for(const mode of ['coverage','sequence','custom_sequence','single']){
        await spin(page).check();await pause(150);await changeMode(page,mode);await ensureUnchecked(page,`${mode} switch did not stop rotation`);await staticCanvas(page);
        if(mode==='custom_sequence'){
          await spin(page).check();await page.getByRole('button',{name:'播放预览',exact:true}).click();
          await ensureUnchecked(page,'Sequence playback did not stop rotation');assert(await spin(page).isDisabled(),'Sequence preview allows independent rotation');
          await page.getByRole('button',{name:'退出预览',exact:true}).click();assert(await spin(page).isEnabled(),'Exiting sequence preview did not restore rotation control');
        }
        results.push({transition:mode,stopped:true});
      }
      const models=page.getByRole('combobox',{name:'卫星模型',exact:true}),original=await models.inputValue(),options=await models.locator('option').evaluateAll(elements=>elements.map(el=>el.value));
      await spin(page).check();await models.selectOption(options.find(v=>v!==original));await modelReady(page);await ensureUnchecked(page,'Model switch did not stop rotation');await staticCanvas(page);
      await models.selectOption(original);await modelReady(page);assert(!await spin(page).isChecked(),'Returning model restarted rotation');results.push({transition:'model',stopped:true});
      await spin(page).check();await page.getByRole('button',{name:'任务与结果',exact:true}).click();await page.getByRole('button',{name:'数据采集',exact:true}).click();
      await modelReady(page);await ensureUnchecked(page,'Page switch did not stop rotation');await staticCanvas(page);results.push({transition:'results-and-back',stopped:true});return results;
    });
    await step('manual_drag_wheel_regression',async()=>{
      const old=await poseState(page);await spin(page).check();await pause(300);await gesture(page,45,-25,true);const mid=await waitAnglesChange(page,old.angles);await page.mouse.up();const dragged=await readQuaternion(page);assert(!sameRotation(dragged,old.quaternion),'Manual drag no longer edits capture pose');await ensureUnchecked(page,'Manual drag did not stop preview rotation');await spin(page).check();
      const box=await canvasBox(page);await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-120);await pause(180);
      const distance=Number(await distanceInput(page).inputValue());assert(distance<old.distance_km,'Wheel no longer adjusts capture distance');assert(sameRotation(dragged,await readQuaternion(page),0),'Wheel changed pose');assert(await spin(page).isChecked(),'Wheel unexpectedly stopped pure preview rotation');await spin(page).uncheck();
      await page.getByRole('button',{name:'重置距离',exact:true}).click();await eventually(async()=>Number(await distanceInput(page).inputValue())===20,'Reset distance failed');
      return{before:old,while_dragging:mid,after_wheel_distance_km:distance,pose_preserved_during_wheel:true};
    });
    await step('localized_modes_and_real_results',async()=>{
      const options=await page.getByRole('combobox',{name:'生成模式',exact:true}).locator('option').evaluateAll(elements=>elements.map(el=>({value:el.value,label:el.textContent.trim()})));
      for(const option of options)assert(option.label===modeLabels[option.value],`Old mode label: ${JSON.stringify(option)}`);
      const jobs=[];for(const mode of ['coverage','sequence','custom_sequence']){
        await changeMode(page,mode);await page.getByRole('spinbutton',{name:'采集数量',exact:true}).fill('2');const job=await capture(instance,`label-${mode}`);jobs.push({mode,label:modeLabels[mode],id:job.id});
      }
      await page.getByRole('button',{name:'任务与结果',exact:true}).click();await pause(200);const body=await page.locator('body').innerText();
      for(const job of jobs)assert(body.includes(job.label),`Real result list missing ${job.label}`);
      assert(!body.includes('全姿态采样')&&!body.includes('连续序列'),'Old mode label remains in result UI');await screenshot(page,'results-localized.png');
      await page.getByRole('button',{name:'数据采集',exact:true}).click();await changeMode(page,'single');await modelReady(page);return{options,jobs};
    });
    await step('compact_toolbar_both_themes',async()=>{
      const rows=[];await inspectView(page);await setAngles(page);await distanceInput(page).fill('17.5');await distanceInput(page).press('Tab');
      for(const theme of ['dark','light']){await setTheme(page,theme);for(const size of [{width:1108,height:645},{width:960,height:600}]){
        await page.setViewportSize(size);await pause(150);const current=await layout(page),old=baseline.find(row=>row.theme===theme&&row.width===size.width&&row.height===size.height);
        assert(current.scrollWidth<=current.width+1&&current.scrollHeight<=current.height+1,'Page overflow');
        assert(current.viewport.height>old.viewport.height+20,`Viewport did not gain enough height: ${current.viewport.height} vs ${old.viewport.height}`);
        assert(current.footer.height<=20 && current.footer.height<old.footer.height,'Footer was not compacted');
        const compact=await page.getByRole('button',{name:'预览辅助',exact:true}).isVisible();
        const rowNames=compact?['拍摄视角','拖动调姿','预览辅助']:['拍摄视角','拖动调姿','重置距离'];
        const buttons=await Promise.all(rowNames.map(name=>page.getByRole('button',{name,exact:true}).boundingBox()));
        const rowControls=[...buttons];
        if(compact){
          const toggle=page.getByRole('button',{name:'预览辅助',exact:true});
          if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click();
          assert(await spin(page).count()===0,'Compact helpers did not collapse');await toggle.click();
          assert(await spin(page).isVisible(),'Compact helpers do not expose rotation');
          const helpers=await page.locator('#preview-helpers').boundingBox();assert(helpers.x>=current.scene.x-1&&helpers.x+helpers.width<=current.scene.right+1,'Compact helper popup overflows panel');
        }else{
          rowControls.push(await spin(page).locator('..').boundingBox(),await page.getByRole('checkbox',{name:'坐标轴',exact:true}).locator('..').boundingBox());
        }
        const centers=rowControls.map(rect=>rect.y+rect.height/2);assert(Math.max(...centers)-Math.min(...centers)<5,'Merged preview toolbar wraps into multiple rows');
        for(const rect of rowControls)assert(rect.x>=current.scene.x-1&&rect.x+rect.width<=current.scene.right+1,'Toolbar control overflows preview panel');
        const selected=await page.getByRole('combobox',{name:'卫星模型',exact:true}).locator('option:checked').innerText();
        const titles=await page.locator('.scene-panel [title]').evaluateAll(elements=>elements.map(el=>({title:el.title,text:el.textContent.trim(),overflow:getComputedStyle(el).textOverflow,rect:(()=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()})));
        const title=titles.find(item=>item.title===selected);assert(title,'Model name lacks full-name tooltip');assert(title.overflow==='ellipsis','Model name has no ellipsis truncation');
        assert(Math.abs(title.rect.y+title.rect.height/2-centers[0])<8,'Model name is not on merged toolbar row');
        await distanceInput(page).evaluate(el=>el.scrollIntoView({block:'center'}));await screenshot(page,`capture-${theme}-${size.width}x${size.height}.png`);
        rows.push({theme,...current,baseline_viewport_height:old.viewport.height,gained_height:current.viewport.height-old.viewport.height,tooltip:title.title});
      }}return rows;
    });
    await step('footer_help',async()=>{
      const footer=page.locator('.app-footer');assert((await footer.innerText()).trim()==='','Old footer prose remains visible');
      assert(await footer.locator('svg[aria-hidden="true"]').count()>0,'Decorative satellite is not hidden from accessibility tree');
      await page.getByRole('button',{name:'设置',exact:true}).click();const dialog=page.getByRole('dialog'),text=await dialog.textContent();
      assert(text.includes('本机')&&text.includes('冻结')&&text.includes('任务'),'Former footer explanations missing from settings help');
      await screenshot(page,'settings-help.png');await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();return{footer_prose_removed:true,decorative_svg_accessibility_hidden:true,help_present:true};
    });
    await step('no_browser_errors',async()=>{assert(report.pageErrors.length===0,JSON.stringify(report.pageErrors));return{page_errors:0};});
    await step('owned_process_cleanup',async()=>{await close(instance);return{host_closed:true,service_closed:true};});
    report.passed=expectedChecks.every(name=>report.checks[name].status==='passed');checkpoint(report.passed?'passed':'failed');
  }catch(error){report.error=String(error);report.stack=error.stack;checkpoint('failed',{error:String(error)});if(host?.page){await host.page.mouse.up().catch(()=>{});report.body=await host.page.locator('body').innerText().catch(()=>'');await screenshot(host.page,'failure.png').catch(()=>{});}process.exitCode=1;
  }finally{
    if(host){try{await close(host);}catch(error){report.cleanup_error=String(error);if(host?.child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch(killError){report.forced_cleanup_error=String(killError);}}await host?.browser?.close().catch(()=>{});}}
    report.counts={total:expectedChecks.length,passed:Object.values(report.checks).filter(v=>v.status==='passed').length,failed:Object.values(report.checks).filter(v=>v.status==='failed').length,not_run:Object.values(report.checks).filter(v=>v.status==='not_run').length};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,output,counts:report.counts}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
