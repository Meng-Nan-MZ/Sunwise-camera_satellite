/* V2.4.4 native acceptance: linked wheel/capture distance, isolated GLB-only fixture.
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
const output = path.join(root, 'var/verification/v2.4.4-distance-link', `${Date.now()}-${process.pid}`);
const workspace = path.join(output, 'workspace');
const project = path.join(output, 'application');
const rootA = output, rootB = output;
const controlPath = path.join(root, 'var/development/v2.4.4/qa-control.json');
const expectedChecks = ['isolated_fixture', 'native_defaults', 'wheel_both_views_direction_bounds',
  'manual_input_slider_scale', 'preview_short_edge_mapping', 'uncommitted_input_wheel',
  'precision_focus_blur_submission', 'formal_png_distance_scaling', 'submission_frozen_and_busy_disabled',
  'custom_preview_fixed_distance', 'automatic_modes_fixed_and_auto', 'reset_distance_preserves_pose',
  'mode_model_switch', 'compact_screenshots_no_errors', 'owned_process_cleanup'];
const report = { version: '2.4.4', passed: false, output, workspace, project,
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
async function launch() {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const runtime = readJson(path.join(root, 'var/runtime.json'));
  const child = spawn(path.join(root, 'var/build/desktop-2.4.4/SatelliteStudio.Desktop.exe'),
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

const distanceInput = page => page.getByRole('spinbutton', {name:'拍摄距离数值',exact:true});
const distanceSlider = page => page.getByRole('slider', {name:'拍摄距离',exact:true});
const readDistance = async page => Number(await distanceInput(page).inputValue());
async function setDistance(page, km, commit=true) {
  await distanceInput(page).fill(String(km));
  if (commit) await distanceInput(page).press('Tab');
}
async function wheel(page, delta) {
  const b=await canvasBox(page);
  await page.locator('.canvas-host canvas').evaluate(canvas=>{
    window.__v244ObservedWheel=null;
    canvas.addEventListener('wheel',event=>{window.__v244ObservedWheel={deltaY:event.deltaY,deltaMode:event.deltaMode,height:canvas.getBoundingClientRect().height,isTrusted:event.isTrusted};},{once:true,passive:true});
  });
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2);
  await page.mouse.wheel(0,delta); await pause(180);
  const observed=await page.evaluate(()=>window.__v244ObservedWheel);
  assert(observed && observed.isTrusted,'Real mouse wheel event not observed');
  (report.native_wheel_events??=[]).push({requested_delta:delta,...observed});
  return observed;
}
function wheelExpected(start,event) {const pixels=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?event.height:1);return Math.max(10000,Math.min(30000,start*Math.exp(Math.max(-1000,Math.min(1000,pixels))*.001)));}
function near(a,b,epsilon,message) {assert(Math.abs(a-b)<=epsilon, `${message}: ${a} vs ${b} (tolerance ${epsilon})`);}
function pixelBounds(bytes, background=[0,0,0], threshold=3, centerTargetOnly=false) {
  const png=PNG.sync.read(bytes);let x1=png.width,y1=png.height,x2=-1,y2=-1,count=0,maxTargetRadius=0;
  for(let y=0;y<png.height;y++) for(let x=0;x<png.width;x++) {
    // HTML HUD overlays appear in element screenshots; the guaranteed 80% safe sphere excludes them.
    if(centerTargetOnly && Math.hypot(x-png.width/2,y-png.height/2)>Math.min(png.width,png.height)*.43) continue;
    const i=(y*png.width+x)*4;
    if(Math.max(...background.map((v,c)=>Math.abs(png.data[i+c]-v)))>threshold) {
      x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x);y2=Math.max(y2,y);count++;maxTargetRadius=Math.max(maxTargetRadius,Math.hypot(x-png.width/2,y-png.height/2));
    }
  }
  assert(count>40, 'Insufficient target pixels');
  if(centerTargetOnly)assert(maxTargetRadius<Math.min(png.width,png.height)*.42,'Target touches central ROI boundary');const width=x2-x1+1,height=y2-y1+1,short=Math.min(png.width,png.height);
  return {image_width:png.width,image_height:png.height,x1,y1,x2,y2,width,height,pixels:count,
    normalized_width:width/short,normalized_height:height/short};
}
async function previewBounds(page, label) {
  await pause(120);const bytes=await page.locator('.canvas-host canvas').screenshot();
  const png=PNG.sync.read(bytes),colors=new Map();
  for(let i=0;i<png.data.length;i+=4){const rgb=(png.data[i]<<16)|(png.data[i+1]<<8)|png.data[i+2];colors.set(rgb,(colors.get(rgb)||0)+1);}
  let dominant=0,frequency=0;for(const [rgb,count] of colors)if(count>frequency){dominant=rgb;frequency=count;}
  const background=[(dominant>>>16)&255,(dominant>>>8)&255,dominant&255];
  assert(frequency>png.width*png.height/2,'Preview has no dominant empty background');
  const result=pixelBounds(bytes,background,3,true);
  if(label) {fs.writeFileSync(path.join(output,label+'.png'),bytes);report.screenshots.push(label+'.png');}
  return {...result,background};
}
async function setPose(page) {
  for(const [axis,value] of [['X','31.25'],['Y','-23.75'],['Z','18.5']]) {
    const input=page.getByRole('spinbutton',{name:`${axis} 轴旋转数值`,exact:true});await input.fill(value);await input.press('Tab');
  }
}
async function capture(instance,label,afterSubmitted) {
  const page=instance.page, responsePromise=page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname==='/api/jobs');
  await page.locator('.generate').click();const response=await responsePromise;
  assert(response.ok(),await response.text());const sent=response.request().postDataJSON(),created=await response.json();
  if(afterSubmitted) await afterSubmitted(sent);
  const completed=await waitJob(instance,created), directory=completed.output_directory;
  const snapshot=readJson(path.join(directory,'job.json'));
  const poses=fs.readdirSync(path.join(directory,'poses')).filter(f=>f.endsWith('.json')).sort().map(f=>readJson(path.join(directory,'poses',f)));
  const firstPng=path.join(directory,'images_clean/000001.png'),png=inspectPng(firstPng),pixels=pixelBounds(fs.readFileSync(firstPng));
  assert(snapshot.scene.distance_m===sent.scene.distance_m,'Frozen scene distance changed');
  assert(sameRotation(tuple(snapshot.scene.sat_quat),tuple(sent.scene.sat_quat),1e-12),'Frozen scene quaternion changed');
  if(sent.distance_policy!=='automatic') assert(poses.every(p=>p.distance_m===sent.scene.distance_m),'Exported fixed distance differs from submitted distance');
  const result={label,id:created.id,directory,sent,snapshot,poses,png,pixels};report.jobs.push(result);await closeNotice(page);return result;
}
async function inspectButton(page) {
  const button=page.getByRole('button',{name:/^(拖动调姿|模型预览)$/});await button.click();
}
async function fixedPolicy(page) {
  const select=page.getByRole('combobox',{name:'拍摄距离方式',exact:true});if(await select.count()) await select.selectOption('fixed');
}

async function visualEvidence(page) {
  const evidence=[];
  await page.setViewportSize({width:1108,height:645});await inspectButton(page);await setPose(page);await setDistance(page,17.5);
  for(const theme of ['dark','light']) {
    await page.getByRole('button',{name:'设置',exact:true}).click();const dialog=page.getByRole('dialog');
    await dialog.getByRole('combobox',{name:'外观主题',exact:true}).selectOption(theme);await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();
    await distanceInput(page).evaluate(el=>el.scrollIntoView({block:'center'}));await pause(120);
    const field=await distanceInput(page).boundingBox(),scroll=await page.locator('.settings-content').boundingBox();
    assert(field.y>=scroll.y && field.y+field.height<=scroll.y+scroll.height,'Distance input not fully visible');
    await screenshot(page,`linked-distance-${theme}-1108x645.png`);
    const bounds=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight}));
    assert(bounds.scrollWidth<=bounds.width+1&&bounds.scrollHeight<=bounds.height+1,'Page overflow');evidence.push({theme,distance_km:await readDistance(page),distance_input_bounds:field,...bounds});
  }
  assert(report.pageErrors.length===0,JSON.stringify(report.pageErrors));return {screens:evidence,page_errors:0};
}
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  try {
    await step('isolated_fixture',async()=>{
      assert(!fs.existsSync(workspace),'QA workspace must be new');
      for(const relative of ['apps/ui/dist','python/src']) fs.cpSync(path.join(root,relative),path.join(project,relative),{recursive:true,filter:file=>!file.includes('__pycache__')});
      fs.cpSync(path.join(root,'assets/models'),path.join(project,'assets/models'),{recursive:true,filter:file=>fs.statSync(file).isDirectory()||['.json','.glb'].includes(path.extname(file))});
      const files=inventory(project);assert(!Object.keys(files).some(file=>/\.blend\d?$|blender\.exe/i.test(file)),'GLB-only fixture violated');
      report.build={executable_sha256:digest(path.join(root,'var/build/desktop-2.4.4/SatelliteStudio.Desktop.exe')),ui_dist_sha256:inventory(path.join(project,'apps/ui/dist'))};
      return {new_workspace:true,uses_user_workspace:false,files:Object.keys(files).length};
    });
    const instance=await launch(),page=instance.page;
    if(process.argv.includes('--screenshots-only')) {
      report.scope='Visual supplement only; the other functional checks are deliberately not rerun';
      await screenshot(page,'native-default.png');
      await step('compact_screenshots_no_errors',()=>visualEvidence(page));
      await step('owned_process_cleanup',async()=>{await close(instance);return {host_closed:true,service_closed:true};});
      report.passed=true;checkpoint('visual-supplement-passed');return;
    }
    await step('native_defaults',async()=>{
      assert(await page.evaluate(()=>!!window.chrome?.webview),'Not native WebView');
      assert((await instance.api('/api/jobs')).length===0,'New workspace contains old tasks');
      assert(await readDistance(page)===20,'Default distance is not 20 km');
      assert(await distanceInput(page).getAttribute('min')==='10' && await distanceInput(page).getAttribute('max')==='30','Wrong distance input bounds');
      await setPose(page);await readQuaternion(page);return {native:true,default_km:20,min_km:10,max_km:30};
    });
    await step('wheel_both_views_direction_bounds',async()=>{
      const evidence=[];
      for(const view of ['capture','inspect']) {
        if(view==='capture') await page.getByRole('button',{name:'拍摄视角',exact:true}).click();else await inspectButton(page);
        await setDistance(page,20);const q=await readQuaternion(page),before=await previewBounds(page,`wheel-${view}-before`);
        await wheel(page,-120);const zoomed=await readDistance(page),zoomedPixels=await previewBounds(page,`wheel-${view}-zoomed`);
        near(zoomed,20*Math.exp(-.12),.0051,'Wheel inward distance');assert(zoomedPixels.width>before.width,`Wheel inward did not enlarge target: ${JSON.stringify({view,zoomed,before,zoomedPixels})}`);
        await wheel(page,240);const away=await readDistance(page);assert(away>zoomed,'Wheel outward did not increase distance');
        for(let i=0;i<2;i++) await wheel(page,-10000);assert(await readDistance(page)===10,'Wheel lower clamp failed');
        for(let i=0;i<2;i++) await wheel(page,10000);assert(await readDistance(page)===30,'Wheel upper clamp failed');
        assert(sameRotation(q,await readQuaternion(page),0),'Wheel changed quaternion');
        evidence.push({view,before_km:20,zoomed_km:zoomed,away_km:away,before,zoomedPixels,lower_km:10,upper_km:30});
      }return evidence;
    });
    await step('manual_input_slider_scale',async()=>{
      const q=await readQuaternion(page),results=[];
      for(const view of ['capture','inspect']) {
        if(view==='capture') await page.getByRole('button',{name:'拍摄视角',exact:true}).click();else await inspectButton(page);
        await setDistance(page,10);const nearPixels=await previewBounds(page);
        await setDistance(page,20);const farPixels=await previewBounds(page);
        near(nearPixels.width/farPixels.width,2,.08,'Input twofold distance width ratio');
        const slider=distanceSlider(page);await slider.focus();await slider.press('End');
        await eventually(async()=>await readDistance(page)===30,'Slider did not update numeric field');assert(Number(await slider.inputValue())===30,'Native slider did not reach 30');const sliderPixels=await previewBounds(page);
        assert(sliderPixels.width<farPixels.width,'Slider did not reduce target scale');
        await slider.press('Home');await eventually(async()=>await readDistance(page)===10,'Slider lower bound failed');
        assert(sameRotation(q,await readQuaternion(page),0),'Distance editor changed pose');results.push({view,nearPixels,farPixels,sliderPixels});
      }return results;
    });
    await step('preview_short_edge_mapping',async()=>{
      await setDistance(page,20);const results=[];
      for(const size of [{width:1108,height:645},{width:960,height:600}]) {
        await page.setViewportSize(size);await pause(150);
        await page.getByRole('button',{name:'拍摄视角',exact:true}).click();const capture=await previewBounds(page,`preview-capture-${size.width}`);
        await inspectButton(page);const inspect=await previewBounds(page,`preview-inspect-${size.width}`);
        near(capture.normalized_width,inspect.normalized_width,.025,'Capture/inspect width differs');
        near(capture.normalized_height,inspect.normalized_height,.025,'Capture/inspect height differs');
        results.push({size,capture,inspect});
      }
      near(results[0].capture.normalized_width,results[1].capture.normalized_width,.02,'Short-edge mapping changed on resize');
      return results;
    });
    await step('uncommitted_input_wheel',async()=>{
      await setDistance(page,20);await setDistance(page,24.56789,false);
      assert(await distanceInput(page).evaluate(el=>el===document.activeElement),'Draft not focused before wheel');
      const draftEvent=await wheel(page,-120);const draftThenWheel=await readDistance(page);
      near(draftThenWheel,wheelExpected(24567.89,draftEvent)/1000,.0051,'Wheel did not use uncommitted input');
      await setDistance(page,24.56789);await wheel(page,-120);const committedThenWheel=await readDistance(page);
      near(draftThenWheel,committedThenWheel,0,'Uncommitted and committed wheel paths disagree');
      await setDistance(page,20);
      await page.locator('.canvas-host canvas').evaluate(canvas=>{
        for(let i=0;i<30;i++)canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:-1,deltaMode:0,bubbles:true,cancelable:true}));
      });
      const accumulated=await capture(instance,'simulated-wheel-30-event-accumulation');
      near(accumulated.sent.scene.distance_m,20000*Math.exp(-.03),1e-7,'Rapid wheel events lost distance increments');
      return {entered_km:24.56789,uncommitted_then_wheel:draftThenWheel,committed_then_wheel:committedThenWheel,
        simulated_wheel_events:30,simulation_note:'DOM WheelEvent dispatch in one event loop; other wheel checks use real Playwright mouse input',accumulated_m:accumulated.sent.scene.distance_m,job:accumulated.id};
    });
    await step('precision_focus_blur_submission',async()=>{
      await setDistance(page,20);const precisionEvent=await wheel(page,-1);const displayed=await readDistance(page),expected=wheelExpected(20000,precisionEvent);
      const before=await capture(instance,'precision-before-focus');near(before.sent.scene.distance_m,expected,1e-8,'Wheel distance was rounded in submission');
      await distanceInput(page).focus();await distanceInput(page).press('Tab');
      const after=await capture(instance,'precision-after-focus');near(after.sent.scene.distance_m,before.sent.scene.distance_m,0,'Focus/blur rounded stored distance');
      assert(Math.abs(before.sent.scene.distance_m-displayed*1000)>1e-6,'Precision case did not exercise rounded readout');
      return {displayed_km:displayed,exact_m:before.sent.scene.distance_m,after_focus_m:after.sent.scene.distance_m,job_ids:[before.id,after.id]};
    });
    await step('formal_png_distance_scaling',async()=>{
      await setDistance(page,10);const nearJob=await capture(instance,'same-pose-10km');
      await setDistance(page,20);const farJob=await capture(instance,'same-pose-20km');
      assert(sameRotation(tuple(nearJob.poses[0].Location.SatQuat),tuple(farJob.poses[0].Location.SatQuat),1e-12),'Two scaling images have different poses');
      const ratioW=nearJob.pixels.width/farJob.pixels.width,ratioH=nearJob.pixels.height/farJob.pixels.height;
      near(ratioW,2,.04,'Actual PNG width does not halve at double distance');near(ratioH,2,.04,'Actual PNG height does not halve at double distance');
      const a=nearJob.poses[0].bbox_xyxy,b=farJob.poses[0].bbox_xyxy;
      near((a[2]-a[0])/(b[2]-b[0]),2,.04,'JSON bbox width ratio incorrect');
      assert(nearJob.poses[0].distance_m===10000 && farJob.poses[0].distance_m===20000,'Pose JSON distances incorrect');
      await page.getByRole('button',{name:'拍摄视角',exact:true}).click();const preview=await previewBounds(page);
      near(preview.normalized_width,farJob.poses[0].bbox_yolo[2],.025,'Preview target scale differs from formal geometric bounds');
      return {near_job:nearJob.id,far_job:farJob.id,width_ratio:ratioW,height_ratio:ratioH,near_pixels:nearJob.pixels,far_pixels:farJob.pixels,preview};
    });
    await step('submission_frozen_and_busy_disabled',async()=>{
      await inspectButton(page);await setDistance(page,17.23456);const q=await readQuaternion(page);
      const requestSeen=page.waitForRequest(r=>r.method()==='POST' && new URL(r.url()).pathname==='/api/jobs');
      // Delay only delivery of a real server response so the submitting state is observable.
      const routeHandler=async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();await pause(1500);await route.fulfill({response});};
      await page.route('**/api/jobs',routeHandler);
      const pending=capture(instance,'frozen-distance',async()=>{await wheel(page,150);assert(await readDistance(page)>17.24,'Post-submit wheel did not change live draft');});
      await requestSeen;
      await eventually(()=>distanceInput(page).isDisabled(),'Distance input not disabled while submitting');
      assert(await distanceSlider(page).isDisabled(),'Distance slider active while submitting');
      const held=await readDistance(page);await wheel(page,-400);assert(await readDistance(page)===held,'Wheel edited draft during submission');
      const job=await pending;await page.unroute('**/api/jobs',routeHandler);
      near(job.sent.scene.distance_m,17234.56,1e-8,'Submission distance incorrect');assert(job.poses[0].distance_m===job.sent.scene.distance_m,'Frozen pose distance changed');
      assert(sameRotation(tuple(job.poses[0].Location.SatQuat),q),'Output quaternion changed');
      return {id:job.id,submission_m:job.sent.scene.distance_m,later_draft_km:await readDistance(page),response_delivery_delay_ms:1500,busy_input_disabled:true,busy_wheel_ignored:true};
    });
    await step('custom_preview_fixed_distance',async()=>{
      await changeMode(page,'custom_sequence');await page.getByRole('spinbutton',{name:'采集数量',exact:true}).fill('3');
      await page.getByRole('button',{name:'起点使用当前姿态',exact:true}).click();await gesture(page,44,-27);
      await page.getByRole('button',{name:'终点使用当前姿态',exact:true}).click();
      const endpoints=async()=>Promise.all(['起点','终点'].flatMap(label=>['X','Y','Z'].map(axis=>page.getByRole('spinbutton',{name:`${label}${axis}角度`,exact:true}).inputValue())));
      const original=await endpoints();await setDistance(page,20);const scrub=page.getByRole('slider',{name:'预览帧',exact:true});await scrub.focus();await scrub.press('Home');await scrub.press('ArrowRight');
      const previewQ=await readQuaternion(page);await wheel(page,-120);const scrubDistance=await readDistance(page);assert(scrubDistance<20,'Scrub preview did not allow distance adjustment');
      assert(sameRotation(previewQ,await readQuaternion(page),0),'Wheel changed scrubbed pose');
      await page.getByRole('button',{name:'播放预览',exact:true}).click();await wheel(page,120);near(await readDistance(page),20,.0051,'Playing preview distance did not update');
      await page.getByRole('button',{name:'退出预览',exact:true}).click();
      assert(JSON.stringify(await endpoints())===JSON.stringify(original),'Distance wheel changed trajectory endpoints');
      await setDistance(page,16.75);const job=await capture(instance,'custom-fixed-16.75km');
      assert(job.poses.length===3 && job.poses.every(p=>p.distance_m===16750),'Custom sequence did not use shared fixed distance');
      return {id:job.id,endpoints_unchanged:true,scrub_km:scrubDistance,all_frame_distances:job.poses.map(p=>p.distance_m)};
    });
    await step('automatic_modes_fixed_and_auto',async()=>{
      const results=[];
      for(const mode of ['coverage','sequence']) {
        await changeMode(page,mode);await fixedPolicy(page);await page.getByRole('spinbutton',{name:'采集数量',exact:true}).fill('2');
        await setDistance(page,18);const fixedEvent=await wheel(page,-120);const fixedReadout=await readDistance(page),fixedJob=await capture(instance,`${mode}-fixed-wheel`);
        near(fixedJob.sent.scene.distance_m,wheelExpected(18000,fixedEvent),1e-8,'Fixed batch wheel distance incorrect');
        const selector=page.getByRole('combobox',{name:'拍摄距离方式',exact:true});await selector.selectOption('automatic');
        assert(await page.getByRole('button',{name:'重置距离',exact:true}).isDisabled(),'Automatic reset distance not disabled');
        const before=await screenshotCanvas(page),q=await readQuaternion(page);
        await wheel(page,-400);assert(await screenshotCanvas(page)===before,'Automatic wheel changed preview');assert(sameRotation(q,await readQuaternion(page),0),'Automatic wheel changed pose');
        const autoJob=await capture(instance,`${mode}-automatic-preserved`);
        assert(autoJob.sent.distance_policy==='automatic','Wheel changed automatic policy');
        near(autoJob.sent.scene.distance_m,fixedJob.sent.scene.distance_m,0,'Automatic wheel changed retained fixed draft');
        const distances=autoJob.poses.map(p=>p.distance_m);assert(distances.every(d=>d>=10000&&d<=30000)&&distances[0]!==distances[1],'Automatic distance schedule missing');
        if(mode==='sequence')assert(distances[0]===30000&&distances[1]===10000,'Original sequence 30–10 km schedule changed');
        await selector.selectOption('fixed');near(await readDistance(page),fixedReadout,0,'Fixed draft lost after automatic mode');
        results.push({mode,fixed_job:fixedJob.id,automatic_job:autoJob.id,fixed_m:fixedJob.sent.scene.distance_m,automatic_distances:distances});
      }return results;
    });
    await step('reset_distance_preserves_pose',async()=>{
      await changeMode(page,'single');await inspectButton(page);await gesture(page,35,-23);const q=await readQuaternion(page);
      await setDistance(page,27.12);await page.getByRole('button',{name:'重置距离',exact:true}).click();
      assert(await readDistance(page)===20,'Distance reset did not restore 20 km');assert(sameRotation(q,await readQuaternion(page),0),'Distance reset changed pose');
      return {before_km:27.12,after_km:20,quaternion_unchanged:true};
    });
    await step('mode_model_switch',async()=>{
      await setDistance(page,23.45);
      for(const mode of ['custom_sequence','coverage','sequence','single']) {await changeMode(page,mode);await fixedPolicy(page);near(await readDistance(page),23.45,0,'Mode switch lost fixed draft');}
      const models=page.getByRole('combobox',{name:'卫星模型',exact:true}),current=await models.inputValue();
      const options=await models.locator('option').evaluateAll(elements=>elements.map(el=>el.value));await models.selectOption(options.find(v=>v!==current));await page.getByText('实时预览',{exact:true}).waitFor();
      near(await readDistance(page),23.45,0,'Model switch reset fixed distance');await wheel(page,-120);assert(await readDistance(page)<23.45,'Wheel failed after model switch');
      await page.getByRole('button',{name:'重置参数',exact:true}).click();assert(await readDistance(page)===20,'Full reset did not restore distance20');
      return {mode_switch_preserved_km:23.45,model_switch_preserved:true,wheel_resumed:true,full_reset_km:20};
    });
    await step('compact_screenshots_no_errors',()=>visualEvidence(page));
    await step('owned_process_cleanup',async()=>{await close(instance);return {host_closed:true,service_closed:true};});
    report.passed=expectedChecks.every(name=>report.checks[name].status==='passed');checkpoint(report.passed?'passed':'failed');
  } catch(error) {
    report.error=String(error);report.stack=error.stack;checkpoint('failed',{error:String(error)});
    if(host?.page){await host.page.mouse.up().catch(()=>{});report.body=await host.page.locator('body').innerText().catch(()=>'');await screenshot(host.page,'failure.png').catch(()=>{});}process.exitCode=1;
  } finally {
    if(host) {try {await close(host);} catch(error){report.cleanup_error=String(error);if(host?.child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch(killError){report.forced_cleanup_error=String(killError);}}await host?.browser?.close().catch(()=>{});}}
    report.counts={total:expectedChecks.length,passed:Object.values(report.checks).filter(check=>check.status==='passed').length,failed:Object.values(report.checks).filter(check=>check.status==='failed').length,not_run:Object.values(report.checks).filter(check=>check.status==='not_run').length};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));if(!process.argv.includes('--screenshots-only'))fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,output,counts:report.counts}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
