/* V3.0.0 native release acceptance: client coordinates, GOES-R single-panel model,
 * endpoint sequence, renderer-free noise variants, output directory and themes.
 * Run after UI and var/build/desktop-3.0.0 builds are ready:
 * $env:NODE_PATH='C:/Users/mz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'
 * node tools/verify_v3_release.cjs
 * NODE_PATH provides development-only playwright/pngjs; no browser download is used.
 * A new isolated application/workspace is created; no production data is read.
 * The output path is set through the public API, then displayed and used by the UI.
 * This script does not exercise the native folder-picker dialog or an installer.
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
const THREE = require(path.join(root, 'apps/ui/node_modules/three/build/three.cjs'));
const output = path.join(root, 'var/verification/v3.0.0-release', `${Date.now()}-${process.pid}`);
const workspace = path.join(output, 'workspace');
const project = path.join(output, 'application');
const controlPath = path.join(output, 'acceptance-control.json');
const expectedChecks = ['isolated_fixture','first_light_and_switch','zero_pose_and_no_noise','endpoint_sequence','reuse_two_noise_versions','custom_output_and_restart','no_browser_errors','owned_process_cleanup'];
const report = { version: '3.0.0', passed: false, output, workspace, project,
  scope: { feedback_items: [1,2,3,4,5,6], folder_picker: false, output_path: 'public API setting, UI display and real capture', installer: false, historical_task_migration: false },
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
  fs.writeFileSync(controlPath, JSON.stringify({ phase, output, workspace, project,
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
async function launch() {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  const runtime = readJson(path.join(root, 'var/runtime.json'));
  const temporary = path.join(output, 'tmp');
  fs.mkdirSync(temporary, { recursive:true });
  const child = spawn(path.join(root, 'var/build/desktop-3.0.0/SatelliteStudio.Desktop.exe'),
    ['--project-root', project, '--workspace', workspace, '--python', runtime.python],
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
  page.on('console', message => {
    if(message.type()!=='error')return;
    const entry={text:message.text(),location:message.location()};
    (report.consoleErrors??=[]).push(entry);
  });
  page.on('response', response => {
    if(response.status()>=400)(report.httpErrors??=[]).push({status:response.status(),url:response.url()});
    if(new URL(response.url()).pathname==='/api/render-worker/result'){
      const body=response.request().postDataJSON();
      if(body?.png_base64){
        const bytes=Buffer.from(body.png_base64,'base64'),png=PNG.sync.read(bytes);let nonGray=0,minAlpha=255,maxDifference=0;const samples=[];
        for(let i=0;i<png.data.length;i+=4){const diff=Math.max(png.data[i],png.data[i+1],png.data[i+2])-Math.min(png.data[i],png.data[i+1],png.data[i+2]);minAlpha=Math.min(minAlpha,png.data[i+3]);maxDifference=Math.max(maxDifference,diff);if(diff){nonGray++;if(samples.length<8)samples.push({x:(i/4)%png.width,y:Math.floor(i/4/png.width),rgba:[...png.data.subarray(i,i+4)]});}}
        const collection=response.status()>=400?(report.rejectedRenders??=[]):(report.rawRenders??=[]),filename=`${response.status()>=400?'rejected':'accepted'}-render-${Date.now()}.png`;
        fs.writeFileSync(path.join(output,filename),bytes);collection.push({filename,metadata:body.metadata,status:response.status(),width:png.width,height:png.height,non_gray_pixels:nonGray,minimum_alpha:minAlpha,max_channel_difference:maxDifference,samples});
      }
    }
  });
  page.on('request', request => {
    if(request.method()==='DELETE')(report.deleteRequests??=[]).push({url:request.url(),fingerprint:request.headers()['if-match']});
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
  const deadline=Date.now()+180000;
  while(Date.now()<deadline){
    const latest = await instance.api('/api/jobs/' + job.id);
    assert(['queued', 'running', 'completed'].includes(latest.status), JSON.stringify(latest));
    if(latest.status==='completed')return latest;
    await pause(100);
  }
  throw new Error(`Capture ${job.id} timed out`);
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
function inspectPng(file, checkBounds=true) {
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
  let x1=png.width,y1=png.height,x2=-1,y2=-1;
  for(let y=0;y<png.height;y++)for(let x=0;x<png.width;x++)if(png.data[(y*png.width+x)*4]>3){x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x);y2=Math.max(y2,y);}
  if(checkBounds)assert(x1>0&&y1>0&&x2<png.width-1&&y2<png.height-1,'Visible object touches an image edge');
  return { file, sha256: digest(file), width: png.width, height: png.height, minimum, maximum, nonzero, pixel_bounds:[x1,y1,x2,y2] };
}
async function closeNotice(page) {
  const button = page.getByRole('button', { name: '关闭通知', exact: true });
  if (await button.count()) await button.click();
}

const settleFrame=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const qTuple=q=>[q.X,q.Y,q.Z,q.W];
function near(a,b,epsilon,message){assert(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=epsilon,`${message}: ${a} vs ${b}`);}
function sameQuaternion(actual,expected,message){const a=qTuple(actual),b=Array.isArray(expected)?expected:qTuple(expected),sign=a.reduce((v,q,i)=>v+q*b[i],0)<0?-1:1;assert(Math.max(...a.map((q,i)=>Math.abs(q-sign*b[i])))<1e-8,message);}
function assertFixturePath(directory){const relative=path.relative(output,path.resolve(directory));assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),`Task path escapes isolated workspace: ${directory}`);}
async function setCount(page,value){await page.getByRole('button',{name:'自定义',exact:true}).click();await page.getByRole('spinbutton',{name:'采集数量',exact:true}).fill(String(value));}
async function selectModel(page,id){await page.getByRole('combobox',{name:'卫星模型',exact:true}).selectOption(id);await pause(180);await modelReady(page);await settleFrame(page);}
async function capture(instance,label){
  const rawStart=(report.rawRenders??[]).length;
  const page=instance.page;
  await eventually(()=>page.locator('.generate').isEnabled(),'Generate not enabled');
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/jobs');
  await page.locator('.generate').click();const response=await pending;assert(response.ok(),await response.text());
  const sent=response.request().postDataJSON(),job=await waitJob(instance,await response.json());assertFixturePath(job.output_directory);
  // The service can publish completion before CDP delivers its final response
  // event. Wait for the diagnostic event stream before taking the raw PNG slice.
  await eventually(()=>(report.rawRenders??[]).length-rawStart===job.completed_frames,'Missing raw render response evidence');
  const result={label,...job,sent,raw_renders:(report.rawRenders??[]).slice(rawStart),snapshot:readJson(path.join(job.output_directory,'job.json'))};
  report.jobs.push(result);await closeNotice(page);return result;
}
async function previewEvidence(page,id){
  await pause(150);const file=`preview-${id}.png`,bytes=await page.locator('.canvas-host canvas').screenshot(),png=PNG.sync.read(bytes),colors=new Map();
  for(let i=0;i<png.data.length;i+=4){const rgb=(png.data[i]<<16)|(png.data[i+1]<<8)|png.data[i+2];colors.set(rgb,(colors.get(rgb)||0)+1);}
  let dominant=0,frequency=0;for(const [rgb,n]of colors)if(n>frequency){dominant=rgb;frequency=n;}
  assert(frequency>png.width*png.height/2,`${id}: preview has no empty background`);
  const background=[(dominant>>>16)&255,(dominant>>>8)&255,dominant&255];let targetPixels=0;
  // The central sphere excludes the viewport HTML HUD without mutating it.
  for(let y=0;y<png.height;y++)for(let x=0;x<png.width;x++)if(Math.hypot(x-png.width/2,y-png.height/2)<Math.min(png.width,png.height)*.43){
    const i=(y*png.width+x)*4;if(Math.max(...background.map((v,c)=>Math.abs(png.data[i+c]-v)))>3)targetPixels++;
  }
  assert(targetPixels>40,`${id}: preview target is empty`);
  fs.writeFileSync(path.join(output,file),bytes);report.screenshots.push(file);
  return{id,screenshot:file,width:png.width,height:png.height,target_pixels:targetPixels,status:await page.locator('.render-status').innerText()};
}
function validateFormal(job,model){
  assert(job.completed_frames===job.sent.count,'Incomplete formal frames');
  assert(job.sent.scene.model_id===model.id,'Wrong formal model');
  assert([10000,20000,30000].includes(job.sent.scene.distance_m),'Unexpected distance');
  const frames=[];for(let index=0;index<job.sent.count;index++){
    const id=String(index+1).padStart(6,'0'),directory=job.output_directory;
    const pose=readJson(path.join(directory,`poses/${id}.json`)),png=inspectPng(path.join(directory,`images_clean/${id}.png`));
    const label=fs.readFileSync(path.join(directory,`labels/${id}.txt`),'ascii').trim().split(/\s+/).map(Number);
    assert(pose.model_id===model.id&&pose.model_sha256===model.preview_sha256,'Formal model identity/hash mismatch');
    if(model.physical_scale_calibrated===false)assert(pose.model_provenance?.physical_scale_calibrated===false,'Missing scale disclosure');
    for(const key of ['collection_id','source_model_id','source_sha256','source_provider','source_page','license','license_url','source_scale','source_scale_basis','physical_scale_calibrated','scale_note','source_coordinate_system','body_axes_source','installation_source'])
      if(Object.hasOwn(model,key))assert(JSON.stringify(pose.model_provenance[key])===JSON.stringify(model[key]),`Frame source provenance mismatch: ${key}`);
    const bbox=pose.bbox_xyxy;assert(bbox.length===4&&bbox.every(Number.isFinite)&&bbox[0]>0&&bbox[1]>0&&bbox[2]<1024&&bbox[3]<1024&&bbox[2]>bbox[0]&&bbox[3]>bbox[1],'Formal geometry is empty or clipped');
    assert(label.length===5&&label[0]===0,'YOLO class/column mismatch');
    const yolo=[(bbox[0]+bbox[2])/2048,(bbox[1]+bbox[3])/2048,(bbox[2]-bbox[0])/1024,(bbox[3]-bbox[1])/1024];
    yolo.forEach((v,i)=>{near(label[i+1],v,1e-10,'YOLO differs from bbox');near(pose.bbox_yolo[i],v,1e-10,'JSON YOLO differs from bbox');});
    if(job.sent.mode==='custom_sequence'){const expected=new THREE.Quaternion(...qTuple(job.sent.trajectory.start_quat)).slerp(new THREE.Quaternion(...qTuple(job.sent.trajectory.end_quat)),index/(job.sent.count-1)).toArray();sameQuaternion(pose.Location.SatQuat,expected,'Formal quaternion differs from requested trajectory');}
    if(job.sent.mode==='single')sameQuaternion(pose.Location.SatQuat,job.sent.scene.sat_quat,'Single pose differs from UI');
    sameQuaternion(pose.Location.SatQuat,pose.scene.sat_quat,'Scene and output quaternion differ');
    near(pose.distance_m,job.sent.scene.distance_m,1e-10,'Frame/request camera distance mismatch');
    near(pose.observer_camera.actual_distance_m,pose.distance_m,1e-8,'Actual camera distance mismatch');
    near(pose.observer_camera.K[0][0],1024/(2*Math.tan(pose.fov_y_rad/2)),1e-8,'Camera focal length mismatch');
    frames.push({id,png,bbox,yolo,pose});
  }
  if(job.sent.count>1){assert(new Set(frames.map(f=>f.png.sha256)).size===job.sent.count,'Different poses produced identical images');assert(new Set(frames.map(f=>JSON.stringify(f.pose.Location.SatQuat))).size===job.sent.count,'Expected distinct orientations');}
  // Decode and validate the actual saved PNG/JSON/YOLO with the full camera, rigid
  // transforms, quaternion, trajectory and protocol validator used by the product.
  // JS assertions above independently bind those files to the UI submission.
  const runtime=readJson(path.join(root,'var/runtime.json'));
  const validation=execFileSync(runtime.python,['-c',[
    'import json, sys', 'from pathlib import Path',
    'from satellite_studio.datasets.export import validate_frame_paths',
    'd=Path(sys.argv[1])', 'validated=[]',
    'for i in range(1,int(sys.argv[2])+1):',
    ' f=f"{i:06d}"',
    ' paths={"clean":d/"images_clean"/(f+".png"),"pose":d/"poses"/(f+".json"),"label":d/"labels"/(f+".txt")}',
    ' validate_frame_paths(paths,f,source_only=True)', ' validated.append(f)',
    'print(json.dumps({"validated_frames":validated,"camera_pose_consistent":True}))',
  ].join('\n'),job.output_directory,String(job.sent.count)],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONPATH:path.join(project,'python/src'),PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
  const raw=job.raw_renders;
  assert(raw.length===job.sent.count&&raw.every(r=>r.non_gray_pixels===0&&r.minimum_alpha===255),'Raw GPU frames must be opaque grayscale');
  job.frames=frames;job.full_validation=JSON.parse(validation.trim());return{id:model.id,job_id:job.id,mode:job.sent.mode,frame_count:job.sent.count,distance_m:job.sent.scene.distance_m,frames:frames.map(f=>({id:f.id,bbox:f.bbox,png:f.png})),validation:job.full_validation};
}
async function setDistance(page, km) {
  const policy=page.getByRole('combobox',{name:'拍摄距离方式',exact:true});
  if(await policy.count())await policy.selectOption('fixed');
  const distance=page.getByRole('spinbutton',{name:'拍摄距离数值',exact:true});
  await distance.fill(String(km));await distance.press('Tab');
}
async function setEndpoints(page) {
  for(const [endpoint,angles]of [['起点',[-40,20,10]],['终点',[50,-35,70]]])
    for(let i=0;i<3;i++){
      const input=page.getByRole('spinbutton',{name:`${endpoint}${'XYZ'[i]}角度`,exact:true});
      await input.fill(String(angles[i]));await input.press('Tab');
    }
}
async function showResults(page){await closeNotice(page);await page.getByRole('button',{name:'任务与结果',exact:true}).click();}
const row=(page,id)=>page.locator(`.job-row[data-job-id="${id}"]`);
async function readySavedImage(page) {
  await eventually(()=>page.getByRole('img',{name:'任务已保存的正式灰度 PNG',exact:true}).evaluate(img=>img.complete&&img.naturalWidth===1024),'Saved image not viewable');
}


async function setTheme(instance, theme) {
  const page=instance.page;
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const select=page.getByRole('combobox',{name:'外观主题',exact:true});
  await eventually(()=>select.isEnabled(),'Theme controls disabled');
  const pending=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/settings/appearance');
  await select.selectOption(theme);assert((await pending).ok(),'Theme write failed');
  await eventually(async()=>await select.isEnabled()&&(await page.locator('html').getAttribute('data-theme'))===theme,'Theme not applied');
  await page.getByRole('button',{name:'关闭对话框',exact:true}).click();
}
function verifyClientPose(job, zero=false) {
  const values=[];
  for(const frame of job.frames){
    const pose=frame.pose;
    assert(Object.keys(pose.Location.SatQuat).join(',')==='W,X,Y,Z','SatQuat field order');
    assert(Object.keys(pose.Location.CamQuat).join(',')==='W,X,Y,Z','CamQuat field order');
    sameQuaternion(pose.Location.CamQuat,{W:.5,X:.5,Y:-.5,Z:.5},'Default observer quaternion');
    if(zero)assert(JSON.stringify(pose.Location.SatQuat)===JSON.stringify({W:1,X:0,Y:0,Z:0}),'Zero pose mismatch');
    assert(pose.CoordinateInfo==='left‑handed coordinates; Origin: target center; X:right,Z:up','World description differs');
    assert(pose.CameraCoordInfo==='left‑handed coordinates; Z:optical axis, X:UP, Y:left','Camera description differs');
    assert(!('noisy' in pose.files),'Unexpected noisy reference');
    assert(!fs.existsSync(path.join(job.output_directory,'images_noisy')),'Noise-off made noisy directory');
    values.push({id:frame.id,Location:pose.Location,CoordinateInfo:pose.CoordinateInfo,CameraCoordInfo:pose.CameraCoordInfo});
  }
  return values;
}
(async()=>{
  fs.mkdirSync(output,{recursive:true});let instance,catalog,zeroJob,sequenceJob,customRoot;
  try{
    await step('isolated_fixture',async()=>{
      assert(!fs.existsSync(workspace),'Workspace must be new');
      for(const relative of ['apps/ui/dist','python/src'])fs.cpSync(path.join(root,relative),path.join(project,relative),{recursive:true,filter:file=>!file.includes('__pycache__')});
      fs.mkdirSync(path.join(project,'assets/models'),{recursive:true});
      fs.copyFileSync(path.join(root,'assets/models/index.json'),path.join(project,'assets/models/index.json'));
      catalog=readJson(path.join(root,'assets/models/index.json'));
      for(const model of catalog){
        const target=path.resolve(project,model.preview_file),relative=path.relative(path.join(project,'assets/models'),target);
        assert(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&target.endsWith('.glb'),'Unsafe model path');
        fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,model.preview_file),target);
        assert(digest(target)===model.preview_sha256,'Model hash mismatch: '+model.id);
      }
      report.build={ui:inventory(path.join(project,'apps/ui/dist')),python:inventory(path.join(project,'python/src')),catalog_sha256:digest(path.join(project,'assets/models/index.json')),desktop_version:'3.0.0',desktop_sha256:digest(path.join(root,'var/build/desktop-3.0.0/SatelliteStudio.Desktop.exe'))};
      assert(catalog.length===20&&catalog.filter(m=>m.selectable!==false).length===19,'Expected 20 retained / 19 selectable models');
      assert(catalog.find(m=>m.id==='goes_r')?.configuration==='single_panel','GOES-R single-panel catalog entry missing');
      const executable=path.join(root,'var/build/desktop-3.0.0/SatelliteStudio.Desktop.exe');
      const productVersion=execFileSync('powershell.exe',['-NoProfile','-Command',`[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${executable.replace(/'/g,"''")}').ProductVersion`],{encoding:'utf8',windowsHide:true}).trim();
      assert(/^3\.0\.0(?:\+|$)/.test(productVersion),'Expected V3.0.0 desktop build');
      report.build.desktop_product_version=productVersion;
      report.build.verifier_sha256=digest(__filename);
      return{active_models:catalog.filter(m=>m.selectable!==false).length,assets_checked:catalog.length,user_data_used:false};
    });
    instance=await launch();report.hosts=[{pid:instance.child.pid,origin:instance.origin}];
    let page=instance.page;
    await page.setViewportSize({width:1648,height:956});
    await step('first_light_and_switch',async()=>{
      assert((await page.title()).includes('V3.0.0'),'Expected V3.0.0 UI build');
      assert((await page.locator('html').getAttribute('data-theme'))==='light','First launch not light');
      assert((await instance.api('/api/settings/appearance')).theme==='light','Backend default not light');
      await setTheme(instance,'dark');await screenshot(page,'theme-dark.png');
      await setTheme(instance,'light');return{first:'light',dark_switch:true,light_switch:true};
    });
    await step('zero_pose_and_no_noise',async()=>{
      await selectModel(page,'goes_r');await setDistance(page,20);
      zeroJob=await capture(instance,'goes-r-zero-no-noise');
      const result=validateFormal(zeroJob,catalog.find(m=>m.id==='goes_r'));
      const poses=verifyClientPose(zeroJob,true);
      await page.getByRole('button',{name:'拖动调姿',exact:true}).click();
      await previewEvidence(page,'goes_r');
      return{...result,poses};
    });
    await step('endpoint_sequence',async()=>{
      await page.getByRole('combobox',{name:'生成模式',exact:true}).selectOption('custom_sequence');
      await setCount(page,5);await setEndpoints(page);await setDistance(page,20);
      sequenceJob=await capture(instance,'goes-r-five-endpoint-frames');
      const result=validateFormal(sequenceJob,catalog.find(m=>m.id==='goes_r'));
      const poses=verifyClientPose(sequenceJob);
      sameQuaternion(sequenceJob.frames[0].pose.Location.SatQuat,sequenceJob.sent.trajectory.start_quat,'Missing start frame');
      sameQuaternion(sequenceJob.frames.at(-1).pose.Location.SatQuat,sequenceJob.sent.trajectory.end_quat,'Missing end frame');
      return{...result,poses};
    });
    await step('reuse_two_noise_versions',async()=>{
      const before=inventory(sequenceJob.output_directory),renders=(report.rawRenders??[]).length,variants=[];
      await showResults(page);
      for(const preset of ['light','medium']){
        await row(page,sequenceJob.id).click();await readySavedImage(page);
        await page.getByRole('button',{name:'基于原图追加噪声',exact:true}).click();
        await page.getByRole('combobox',{name:'追加噪声强度',exact:true}).selectOption(preset);
        const job=await submitFromUI(instance,page.getByRole('button',{name:'基于原图生成噪声版本',exact:true}),`/api/jobs/${sequenceJob.id}/noise-variants`,'noise-'+preset);
        assertFixturePath(job.output_directory);
        assert(job.source_job_id===sequenceJob.id&&job.completed_frames===5,'Noise source/count mismatch');
        assert(!fs.existsSync(path.join(job.output_directory,'images_clean'))&&!fs.existsSync(path.join(job.output_directory,'poses'))&&!fs.existsSync(path.join(job.output_directory,'labels')),'Variant duplicated source files');
        const frames=[];
        for(let i=1;i<=5;i++){const id=String(i).padStart(6,'0');frames.push(inspectPng(path.join(job.output_directory,`images_noisy/${id}.png`),false));assert(fs.existsSync(path.join(job.output_directory,`noise_meta/${id}.json`)),'Missing noise metadata');}
        variants.push({id:job.id,source_job_id:job.source_job_id,preset,frames});await closeNotice(page);
      }
      assert((report.rawRenders??[]).length===renders,'Adding noise invoked renderer');
      assert(JSON.stringify(before)===JSON.stringify(inventory(sequenceJob.output_directory)),'Source files changed');
      assert(variants[0].frames[0].sha256!==variants[1].frames[0].sha256,'Noise presets produced same result');
      await screenshot(page,'noise-results.png');return{variants,source_hashes_unchanged:true,extra_render_count:0,source_files_copied:false};
    });
    await step('custom_output_and_restart',async()=>{
      customRoot=path.join(output,'自定义 数据集');fs.mkdirSync(customRoot);
      const saved=await instance.api('/api/settings/output-directory',{output_directory:customRoot});
      assert(samePath(saved.output_directory,customRoot),'Output setting not saved');
      await page.reload();await page.getByRole('heading',{name:'卫星数据工作台',exact:true}).waitFor();await modelReady(page);
      assert(await page.getByText(/自定义 数据集/).count()>0,'Path not visible in UI');
      await selectModel(page,'goes_r');
      const job=await capture(instance,'custom-output-single');
      assert(samePath(path.dirname(job.output_directory),customRoot),'Capture ignored custom root');
      const result=validateFormal(job,catalog.find(m=>m.id===job.sent.scene.model_id));
      assert(fs.existsSync(path.join(zeroJob.output_directory,'images_clean/000001.png')),'Old task moved');
      await screenshot(page,'custom-output.png');
      await close(instance);instance=await launch();page=instance.page;report.hosts.push({pid:instance.child.pid,origin:instance.origin});
      assert(samePath((await instance.api('/api/settings/output-directory')).output_directory,customRoot),'Custom root lost on restart');
      const old=await instance.api(`/api/jobs/${zeroJob.id}`);assert(samePath(old.output_directory,zeroJob.output_directory),'Old task directory changed');
      assert((await instance.api('/api/settings/appearance')).theme==='light','Saved theme lost');
      return{...result,root:customRoot,persisted_after_restart:true,old_task_unchanged:true,selection_method:'API; GUI displayed and generated'};
    });
    await step('no_browser_errors',async()=>{assert(!report.pageErrors.length&&!(report.consoleErrors??[]).length,JSON.stringify({page:report.pageErrors,console:report.consoleErrors}));return{page_errors:0,console_errors:0};});
    await step('owned_process_cleanup',async()=>{await close(instance);return{hosts_closed:true,services_closed:true};});
    report.passed=expectedChecks.every(name=>report.checks[name].status==='passed');checkpoint('passed');
  }catch(error){report.error=String(error);report.stack=error.stack;checkpoint('failed',{error:String(error)});if(host?.page)await screenshot(host.page,'failure.png').catch(()=>{});process.exitCode=1;}
  finally{
    if(host)try{await close(host);}catch(error){report.cleanup_error=String(error);if(host?.child.exitCode===null)try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}await host?.browser?.close().catch(()=>{});}
    report.counts={total:expectedChecks.length,passed:Object.values(report.checks).filter(v=>v.status==='passed').length,failed:Object.values(report.checks).filter(v=>v.status==='failed').length,not_run:Object.values(report.checks).filter(v=>v.status==='not_run').length};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,output,counts:report.counts,error:report.error}));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
