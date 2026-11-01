/* V2.4.3 native acceptance: isolated GLB-only fixture and real pointer gestures.
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
const output = path.join(root, 'var/verification/v2.4.3-drag-pose', `${Date.now()}-${process.pid}`);
const workspace = path.join(output, 'workspace');
const project = path.join(output, 'application');
const rootA = output, rootB = output;
const controlPath = path.join(root, 'var/development/v2.4.3/qa-control.json');
const expectedChecks = ['isolated_fixture', 'native_compact_default', 'drag_updates_before_release',
  'quaternion_matches_angle_readout', 'wheel_and_reset_preserve_pose_and_distance',
  'numeric_edit_updates_pose', 'uncommitted_input_then_drag', 'diameter_drag_continuity', 'single_output_matches_drag_and_freezes',
  'pointer_outside_and_second_gesture', 'capture_view_and_mode_change_cancel_drag',
  'custom_endpoints_and_readonly_preview', 'automatic_modes_do_not_edit_pose',
  'model_change_and_reset', 'dark_light_compact_layout', 'no_browser_errors', 'owned_process_cleanup'];
const report = { version: '2.4.3', passed: false, output, workspace, project,
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
  const child = spawn(path.join(root, 'var/build/desktop-2.4.3/SatelliteStudio.Desktop.exe'),
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
async function bounds(page) {
  return page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, right:r.right, bottom:r.bottom }; };
    return { width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
      scene:box('.scene-panel'),viewport:box('.viewport'),sidebar:box('.right-column'),settings:box('.settings-content'),footer:box('.generation-bar'),generate:box('.generate') };
  });
}
function verifyLayout(result) {
  assert(result.scrollWidth <= result.width + 1 && result.scrollHeight <= result.height + 1, `Page overflow ${JSON.stringify(result)}`);
  for (const key of ['scene','viewport','sidebar','footer','generate']) {
    const r=result[key]; assert(r.width>0 && r.height>0 && r.x>=-1 && r.y>=-1 && r.right<=result.width+1 && r.bottom<=result.height+1, `Clipped ${key}: ${JSON.stringify(result)}`);
  }
  assert(Math.abs(result.scene.bottom-result.sidebar.bottom)<2, 'Left preview did not extend to sidebar bottom');
  assert(result.footer.x>=result.sidebar.x && result.footer.right<=result.sidebar.right+1 && result.footer.bottom<=result.sidebar.bottom+1, 'Generation area is not inside sidebar');
  assert(result.generate.height>=34 && result.settings.bottom<=result.footer.y+1, 'Generation area overlaps scrolling parameters');
}

async function inputHandoff(page) {
  await page.getByRole('button',{name:'拖动调姿',exact:true}).click();
  await readQuaternion(page); // Open readout before typing, so subsequent reads do not blur input.
  for(const [axis,value] of [['Y','-12.375'],['Z','6.25']]) {
    const field=page.getByRole('spinbutton',{name:`${axis} 轴旋转数值`,exact:true});await field.fill(value);await field.press('Tab');
  }
  const before=await angles(page), entered=47.125;
  const input=page.getByRole('spinbutton',{name:'X 轴旋转数值',exact:true});
  await input.fill(String(entered));
  assert(await input.evaluate(el=>el===document.activeElement),'Input lost focus before gesture');
  const {box}=await gesture(page,40,-20);
  const actual=await readQuaternion(page), start=qFromAngles([entered,-12.375,6.25]);
  const r=Math.min(box.width,box.height)/2,u=40/r,v=20/r;
  const delta=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1),new THREE.Vector3(u,v,Math.sqrt(1-u*u-v*v)));
  const engine=delta.multiply(new THREE.Quaternion(-start[0],-start[2],-start[1],start[3]));
  const expected=[-engine.x,-engine.z,-engine.y,engine.w];
  report.input_handoff_attempt={before,entered,expected,actual,angles:await angles(page)};
  assert(sameRotation(actual,expected,0.00003),`Uncommitted angle was not used for initial drag: ${JSON.stringify(report.input_handoff_attempt)}`);
  return report.input_handoff_attempt;
}

async function diameterContinuity(page) {
  const box=await canvasBox(page),r=Math.min(box.width,box.height)/2;
  const cx=box.x+box.width/2,cy=box.y+box.height/2;
  await readQuaternion(page);
  await page.mouse.move(cx-r,cy);await page.mouse.down();
  let previous=new THREE.Quaternion(...await readQuaternion(page)).normalize(),largest=0;
  const samples=[];
  for(let i=1;i<=100;i++) {
    await page.mouse.move(cx-r+2*r*i/100,cy);
    const current=new THREE.Quaternion(...await readQuaternion(page)).normalize();
    const angle=previous.angleTo(current)*180/Math.PI;largest=Math.max(largest,angle);
    samples.push(angle);previous=current;
    assert(angle<20,`Arcball diameter step ${i} jumped ${angle} degrees`);
  }
  await page.mouse.up();return {steps:100,largest_step_degrees:largest,last_step_degrees:samples.at(-1),samples};
}

(async () => {
  fs.mkdirSync(output, {recursive:true});
  try {
    await step('isolated_fixture', async () => {
      assert(!fs.existsSync(workspace), 'QA workspace must be new');
      for (const relative of ['apps/ui/dist','python/src']) fs.cpSync(path.join(root,relative),path.join(project,relative),{recursive:true,filter:file=>!file.includes('__pycache__')});
      fs.cpSync(path.join(root,'assets/models'),path.join(project,'assets/models'),{recursive:true,filter:file=>fs.statSync(file).isDirectory() || ['.json','.glb'].includes(path.extname(file))});
      const files=inventory(project); assert(!Object.keys(files).some(file=>/\.blend\d?$|blender\.exe/i.test(file)), 'GLB-only fixture violated');
      report.build={executable_sha256:digest(path.join(root,'var/build/desktop-2.4.3/SatelliteStudio.Desktop.exe')),ui_dist_sha256:inventory(path.join(project,'apps/ui/dist'))};
      return {new_workspace:true,uses_user_workspace:false,files:Object.keys(files).length};
    });
    const instance=await launch(), page=instance.page;
    if(process.argv.includes('--input-handoff-only')) {
      report.scope='Targeted input handoff regression; other checks deliberately not run';
      await step('uncommitted_input_then_drag',()=>inputHandoff(page));
      report.passed=true;await close(instance);return;
    }
    await step('native_compact_default', async () => {
      const result=await bounds(page); verifyLayout(result);
      assert(result.width<=1120 && result.height<=680,'Native default window not compact');
      assert(await page.evaluate(()=>!!window.chrome?.webview),'Not running native WebView');
      assert((await instance.api('/api/jobs')).length===0,'Fixture contains old jobs');
      await screenshot(page,'native-default.png'); return result;
    });
    await page.getByRole('button',{name:'拖动调姿',exact:true}).click();
    await step('drag_updates_before_release', async () => {
      const before=await angles(page), {x,y}=await gesture(page,44,-24,true);
      const halfway=await waitAnglesChange(page,before);
      await page.mouse.move(x+84,y-45,{steps:5});
      const end=await waitAnglesChange(page,halfway);
      assert(await page.locator('.canvas-host canvas').evaluate(el=>el.classList.contains('is-dragging')),'Gesture already ended before realtime check');
      const cursorWhileHeld=await page.locator('.canvas-host canvas').evaluate(el=>getComputedStyle(el).cursor);
      assert(cursorWhileHeld==='grabbing',`Unexpected active drag cursor: ${cursorWhileHeld}`);
      await page.mouse.up();
      await page.mouse.move(x+100,y-60);
      await pause(180);
      assert(JSON.stringify(await angles(page))===JSON.stringify(end),'Pose continued changing after release');
      const cursorAfter=await page.locator('.canvas-host canvas').evaluate(el=>getComputedStyle(el).cursor);
      assert(cursorAfter==='grab',`Unexpected released drag cursor: ${cursorAfter}`);
      await screenshot(page,'drag-live-angles.png'); return {before,while_held:halfway,continued_while_held:end,after_release:await angles(page),cursor_while_held:cursorWhileHeld,cursor_after:cursorAfter};
    });
    await step('quaternion_matches_angle_readout', async () => {
      const displayed=await angles(page), q=await readQuaternion(page);
      assert(sameRotation(q,qFromAngles(displayed),0.00015),'Displayed angles and quaternion disagree');
      const input=page.getByRole('spinbutton',{name:'X 轴旋转数值',exact:true});
      await input.focus(); await input.press('Tab');
      assert(sameRotation(await readQuaternion(page),q,0),'Focusing rounded input quantized the actual pose');
      return {angles:displayed,quaternion_xyzw:q,unchanged_after_focus_blur:true};
    });
    await step('wheel_and_reset_preserve_pose_and_distance', async () => {
      const q=await readQuaternion(page), distance=await page.getByRole('spinbutton',{name:'拍摄距离数值',exact:true}).inputValue();
      const imageBefore=await screenshotCanvas(page), box=await canvasBox(page);
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.wheel(0,-230); await pause(150);
      const imageZoomed=await screenshotCanvas(page);
      assert(imageBefore!==imageZoomed,'Wheel did not change visual scale');
      assert(sameRotation(await readQuaternion(page),q,0),'Wheel changed pose');
      assert(await page.getByRole('spinbutton',{name:'拍摄距离数值',exact:true}).inputValue()===distance,'Wheel changed shooting distance');
      await page.getByRole('button',{name:'复位观察',exact:true}).click(); await pause(100);
      assert(sameRotation(await readQuaternion(page),q,0),'Reset observation changed pose');
      assert(await screenshotCanvas(page)===imageBefore,'Reset observation did not restore original visual scale');
      return {distance_km:distance,pose_preserved:true,visual_scale_changed:true,reset_restored:true};
    });
    await step('numeric_edit_updates_pose', async () => {
      const beforeImage=await screenshotCanvas(page);
      for (const [axis,value] of [['X','31.25'],['Y','-23.75'],['Z','18.5']]) {const input=page.getByRole('spinbutton',{name:`${axis} 轴旋转数值`,exact:true});await input.fill(value);await input.press('Tab');}
      const q=await readQuaternion(page), expected=qFromAngles([31.25,-23.75,18.5]);
      assert(sameRotation(q,expected),'Numeric inputs did not drive actual quaternion');
      assert(await screenshotCanvas(page)!==beforeImage,'Numeric inputs did not redraw viewport');
      await gesture(page,-52,31); const changed=await readQuaternion(page);
      assert(!sameRotation(changed,q),'Drag did not start from numeric pose');
      return {entered:[31.25,-23.75,18.5],before_drag:q,after_drag:changed};
    });
    await step('uncommitted_input_then_drag',()=>inputHandoff(page));
    await step('diameter_drag_continuity',()=>diameterContinuity(page));
    await step('single_output_matches_drag_and_freezes', async () => {
      const expected=await readQuaternion(page);
      const responsePromise=page.waitForResponse(r=>r.request().method()==='POST' && new URL(r.url()).pathname==='/api/jobs');
      await page.getByRole('button',{name:'生成 1 张图片 →',exact:true}).click();
      const response=await responsePromise; assert(response.ok(),'Single submission rejected');
      const created=await response.json(), sent=response.request().postDataJSON();
      assert(sameRotation(tuple(sent.scene.sat_quat),expected),'Submitted pose did not match dragged pose');
      await eventually(()=>page.getByRole('button',{name:'生成 1 张图片 →',exact:true}).isEnabled(),'Submit did not finish');
      await gesture(page,38,-37); const after=await readQuaternion(page);
      assert(!sameRotation(after,expected),'Post-submit drag did not change live draft');
      const job=await waitJob(instance,created), snapshot=readJson(path.join(job.output_directory,'job.json'));
      const pose=readJson(path.join(job.output_directory,'poses/000001.json'));
      assert(sameRotation(tuple(snapshot.scene.sat_quat),tuple(sent.scene.sat_quat),1e-12),'Frozen job pose changed after dragging');
      assert(sameRotation(tuple(pose.Location.SatQuat),tuple(sent.scene.sat_quat),1e-10),'Exported pose JSON mismatch');
      assert(pose.distance_m===20000 && fs.existsSync(path.join(job.output_directory,'labels/000001.txt')),'Distance or label missing');
      const png=inspectPng(path.join(job.output_directory,'images_clean/000001.png'));
      report.jobs.push({id:job.id,sent,snapshot,pose,png});
      await closeNotice(page);
      return {id:job.id,submitted:sent.scene.sat_quat,later_draft:after,png,snapshot_immutable:true,pose_json_matches:true};
    });
    await step('pointer_outside_and_second_gesture', async () => {
      const before=await angles(page), {x,y,box}=await gesture(page,30,-10,true);
      await page.mouse.move(box.x+box.width+30,y+40,{steps:8}); await page.mouse.up();
      const outside=await waitAnglesChange(page,before);
      assert(!await page.locator('.canvas-host canvas').evaluate(el=>el.classList.contains('is-dragging')),'Drag state leaked after outside release');
      await gesture(page,-25,17); const second=await waitAnglesChange(page,outside);
      return {outside_release:outside,next_gesture:second};
    });
    await step('capture_view_and_mode_change_cancel_drag', async () => {
      const {x,y}=await gesture(page,26,-15,true);
      // Keyboard activation changes the view while the pointer remains captured.
      const button=page.getByRole('button',{name:'拍摄视角',exact:true});await button.focus();await button.press('Enter');
      const stable=await readQuaternion(page); await page.mouse.move(x+80,y+55,{steps:3});await page.mouse.up();
      assert(sameRotation(await readQuaternion(page),stable,0),'Changing view left a live gesture');
      await gesture(page,55,-45); assert(sameRotation(await readQuaternion(page),stable,0),'Capture view unexpectedly edited pose');
      await page.getByRole('button',{name:'拖动调姿',exact:true}).click();
      await gesture(page,-31,23);assert(!sameRotation(await readQuaternion(page),stable),'Drag did not recover after view change');
      return {capture_readonly:true,mode_change_canceled:true,recovered:true};
    });
    await step('custom_endpoints_and_readonly_preview', async () => {
      await changeMode(page,'custom_sequence'); await page.getByRole('spinbutton',{name:'采集数量',exact:true}).fill('4');
      await gesture(page,42,-28);const start=await readQuaternion(page);
      await page.getByRole('button',{name:'起点使用当前姿态',exact:true}).click();
      await gesture(page,-68,38);const end=await readQuaternion(page);
      await page.getByRole('button',{name:'终点使用当前姿态',exact:true}).click();
      const readEndpoint=label=>Promise.all(['X','Y','Z'].map(async axis=>Number(await page.getByRole('spinbutton',{name:`${label}${axis}角度`,exact:true}).inputValue())));
      const endpointStart=await readEndpoint('起点'),endpointEnd=await readEndpoint('终点');
      assert(sameRotation(qFromAngles(endpointStart),start),'Copied start pose disagrees with dragged quaternion');
      assert(sameRotation(qFromAngles(endpointEnd),end),'Copied end pose disagrees with dragged quaternion');
      const scrub=page.getByRole('slider',{name:'预览帧',exact:true});await scrub.focus();await scrub.press('Home');await scrub.press('ArrowRight');
      await eventually(()=>page.getByRole('spinbutton',{name:'X 轴旋转数值',exact:true}).isDisabled(),'Preview did not disable editor');
      const preview=await readQuaternion(page),display=await angles(page);
      assert(sameRotation(preview,qFromAngles(display),0.00015),'Preview angles and readout differ');
      await gesture(page,50,-20);assert(sameRotation(await readQuaternion(page),preview,0),'Scrub preview allowed drag modification');
      await page.getByRole('button',{name:'播放预览',exact:true}).click();
      assert(await page.getByRole('spinbutton',{name:'X 轴旋转数值',exact:true}).isDisabled(),'Playing preview allowed pose editing');
      await page.getByRole('button',{name:'退出预览',exact:true}).click();
      await eventually(()=>page.getByRole('spinbutton',{name:'X 轴旋转数值',exact:true}).isEnabled(),'Exit preview did not restore editing');
      await gesture(page,20,-22);assert(!sameRotation(await readQuaternion(page),end),'Editor did not resume after preview');
      const job=await submitFromUI(instance,page.getByRole('button',{name:'生成 4 张图片 →',exact:true}),'/api/jobs','custom-drag-endpoints');
      const first=readJson(path.join(job.output_directory,'poses/000001.json')),last=readJson(path.join(job.output_directory,'poses/000004.json'));
      assert(sameRotation(tuple(first.Location.SatQuat),start),'Sequence first frame mismatch');
      assert(sameRotation(tuple(last.Location.SatQuat),end),'Sequence final frame mismatch');
      await closeNotice(page);return {start,end,endpointStart,endpointEnd,preview,exported_id:job.id};
    });
    await step('automatic_modes_do_not_edit_pose', async () => {
      const results=[];
      for (const mode of ['coverage','sequence']) {await changeMode(page,mode);const before=await readQuaternion(page);await gesture(page,70,-40);const after=await readQuaternion(page);assert(sameRotation(before,after,0),`${mode} accepted manual drag`);assert(await page.getByRole('spinbutton',{name:'X 轴旋转数值',exact:true}).count()===0,'Automatic mode exposed manual inputs');results.push({mode,pose_unchanged:true});}
      return results;
    });
    await step('model_change_and_reset', async () => {
      await changeMode(page,'single'); await page.getByRole('button',{name:'归零',exact:true}).click();
      assert(sameRotation(await readQuaternion(page),[0,0,0,1],0),'Pose reset failed');
      const models=await page.getByRole('combobox',{name:'卫星模型',exact:true}).locator('option').evaluateAll(elements=>elements.map(el=>el.value));
      const current=await page.getByRole('combobox',{name:'卫星模型',exact:true}).inputValue();
      await page.getByRole('combobox',{name:'卫星模型',exact:true}).selectOption(models.find(value=>value!==current));await page.getByText('实时预览',{exact:true}).waitFor();
      await gesture(page,35,-25);assert(!sameRotation(await readQuaternion(page),[0,0,0,1]),'New model did not accept gesture');
      await page.getByRole('button',{name:'重置参数',exact:true}).click();
      assert(sameRotation(await readQuaternion(page),[0,0,0,1],0),'Draft reset failed');
      await closeNotice(page);return {model_changed:true,drag_available:true,reset_identity:true};
    });
    await step('dark_light_compact_layout', async () => {
      const results=[]; const baselineFile=path.join(root,'var/verification/v2.4.2-simplification/1793551262185-95948/report.json');
      const baseline=fs.existsSync(baselineFile)?readJson(baselineFile).checks.compact_dark_light_screenshots.evidence:null;
      for(const theme of ['dark','light']) {
        await page.getByRole('button',{name:'设置',exact:true}).click();const dialog=page.getByRole('dialog');
        await dialog.getByRole('combobox',{name:'外观主题',exact:true}).selectOption(theme);await dialog.getByRole('button',{name:'关闭对话框',exact:true}).click();
        for(const [width,height] of [[1108,645],[960,600]]) {
          await page.setViewportSize({width,height});await pause(120);
          const before=await bounds(page);verifyLayout(before);
          await page.locator('.settings-content').evaluate(el=>{el.scrollTop=el.scrollHeight;});const after=await bounds(page);
          assert(Math.abs(before.generate.y-after.generate.y)<1,'Generate button moved with parameter scroll');
          const old=baseline?.find(value=>value.theme===theme && value.kind==='capture' && value.width===width && value.height===height);
          if(old) assert(before.viewport.height>old.viewer.height+30,'Preview did not gain usable vertical space');
          await page.locator('.settings-content').evaluate(el=>{el.scrollTop=0;});
          await screenshot(page,`capture-${theme}-${width}x${height}.png`);
          results.push({theme,...before,baseline_viewport_height:old?.viewer.height??null,footer_fixed:true});
        }
      }
      return results;
    });
    await step('no_browser_errors',async()=>{assert(report.pageErrors.length===0,JSON.stringify(report.pageErrors));return {page_errors:0};});
    await step('owned_process_cleanup',async()=>{await close(instance);return {host_closed:true,service_closed:true};});
    report.passed=expectedChecks.every(name=>report.checks[name].status==='passed');checkpoint(report.passed?'passed':'failed');
  } catch(error) {
    report.error=String(error);report.stack=error.stack;checkpoint('failed',{error:String(error)});
    if(host?.page){await host.page.mouse.up().catch(()=>{});report.body=await host.page.locator('body').innerText().catch(()=>'');await screenshot(host.page,'failure.png').catch(()=>{});}process.exitCode=1;
  } finally {
    if(host) {try {await close(host);} catch(error){report.cleanup_error=String(error);if(host?.child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch(killError){report.forced_cleanup_error=String(killError);}}await host?.browser?.close().catch(()=>{});}}
    report.counts={total:expectedChecks.length,passed:Object.values(report.checks).filter(check=>check.status==='passed').length,failed:Object.values(report.checks).filter(check=>check.status==='failed').length,not_run:Object.values(report.checks).filter(check=>check.status==='not_run').length};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,output,counts:report.counts}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
