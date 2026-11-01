/* Native V2.3 acceptance. Playwright is QA-only; folder dialogs are operated via Computer Use. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'var/verification/v2.3-output-directory', String(Date.now()));
const workspace = path.join(output, 'workspace');
const rootA = path.join('C:/Users/mz/.codex/visualizations/2026/10/31/01a19283-a54f-7be2-8bfb-61c523bc789b', 'V2.3 甲方 数据集', path.basename(output));
const rootB = path.join(output, '另一个盘 数据集 B');
const controlPath = path.join(root, 'var/development/v2.3/qa-control.json');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'var/runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
const desktopVersion=fs.readFileSync(path.join(root,'apps/desktop/SatelliteStudio.Desktop.csproj'),'utf8').match(/<Version>(\d+\.\d+\.\d+)<\/Version>/)?.[1];
if(!desktopVersion)throw new Error('Desktop source version missing');
const evidenceFlag=process.argv.indexOf('--picker-evidence');
const pickerEvidencePath=evidenceFlag>=0?path.resolve(process.argv[evidenceFlag+1]??''):null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const samePath = (a,b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const identity = { W:1, X:0, Y:0, Z:0 };
function control(phase, extra={}) { fs.writeFileSync(controlPath,JSON.stringify({phase,output,workspace,rootA,rootB,...extra},null,2)); console.log(phase); }

(async()=>{
  fs.mkdirSync(output,{recursive:true});fs.mkdirSync(rootA,{recursive:true});fs.mkdirSync(rootB,{recursive:true});
  const baseline=JSON.parse(fs.readFileSync(path.join(root,'var/verification/v2.2.1-benchmark/report.json'),'utf8'));
  assert(baseline.passed,'Need closed passing V2.2.1 baseline workspace');
  fs.cpSync(baseline.workspace,workspace,{recursive:true});
  const report={passed:false,output,workspace,rootA,rootB,jobs:[],pageErrors:[],resourceFailures:[]};
  let host;
  async function launch(phase) {
    const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    const child=spawn(path.join(root,`var/build/desktop-${desktopVersion}/SatelliteStudio.Desktop.exe`),
      ['--project-root',root,'--workspace',workspace,'--python',runtime.python,'--blender',path.join(output,'missing-blender.exe')],
      {windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`}});
    const instance={child,port};host=instance;
    for(let i=0;i<150;i++){assert(child.exitCode===null,'Desktop exited during startup');try{instance.browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:800});break;}catch{await pause(200);}}
    assert(instance.browser,'Native WebView unavailable');
    for(let i=0;i<150;i++){instance.page=instance.browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));if(instance.page)break;await pause(100);}
    assert(instance.page,'Native workbench page missing');
    instance.page.on('pageerror',e=>report.pageErrors.push(String(e)));
    instance.page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ABORTED'))report.resourceFailures.push({url:r.url(),error:r.failure()?.errorText});});
    await instance.page.getByRole('heading',{name:'Satellite Dataset Studio V2.3',exact:true}).waitFor();
    instance.origin=new URL(instance.page.url()).origin;
    instance.raw=async(route,body)=>{const r=await fetch(instance.origin+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
    instance.api=async(route,body)=>{const r=await instance.raw(route,body);assert(r.status<400,`${route}: ${r.status} ${JSON.stringify(r.value)}`);return r.value;};
    for(let i=0;i<300;i++){const h=await instance.api('/api/health');if(h.renderers.threejs.available){instance.health=h;break;}await pause(100);}
    assert(instance.health&&!instance.health.renderers.blender.available,'Web must work without Blender');
    const layout=await instance.page.evaluate(()=>{
      const canvas=document.querySelector('canvas[aria-hidden="true"]');
      if(!canvas)return null;const bounds=canvas.getBoundingClientRect();
      return {display:getComputedStyle(canvas).display,width:bounds.width,height:bounds.height,scroll_width:document.documentElement.scrollWidth,viewport_width:innerWidth};
    });
    report.layout_checks??=[];report.layout_checks.push({phase,...layout});
    assert(layout?.display==='none'&&layout.width===0&&layout.height===0,'Formal capture canvas is visible in page layout: '+JSON.stringify(layout));
    await instance.page.getByRole('textbox',{name:'数据集保存位置',exact:true}).waitFor();
    for(let i=0;i<100;i++){if(await instance.page.getByRole('textbox',{name:'数据集保存位置',exact:true}).inputValue())break;await pause(100);}
    control(phase,{port,origin:instance.origin,pid:child.pid});return instance;
  }
  async function close(instance) {
    execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${instance.child.pid}).CloseMainWindow() | Out-Null`],{windowsHide:true});
    for(let i=0;i<150&&instance.child.exitCode===null;i++)await pause(100);
    assert(instance.child.exitCode!==null,'Native host did not close');
    let alive=false;try{await fetch(instance.origin+'/api/health');alive=true;}catch{}
    assert(!alive,'Owned service remained alive');await instance.browser.close().catch(()=>{});host=null;
  }
  async function wait(instance,job) {
    for(let i=0;i<1800;i++){const j=await instance.api('/api/jobs/'+job.id);if(j.status==='completed')return j;assert(['queued','running'].includes(j.status),JSON.stringify(j));await pause(50);}throw new Error('Job timeout');
  }
  async function save(instance,value) {
    const field=instance.page.getByRole('textbox',{name:'数据集保存位置',exact:true});await field.fill(value);
    await instance.page.getByRole('button',{name:'应用',exact:true}).click();
    for(let i=0;i<200;i++){if(samePath((await instance.api('/api/settings/output-directory')).output_directory,value))return;await pause(50);}throw new Error('Setting not applied: '+value);
  }
  function capture(model,extra={}) { return {mode:'single',count:1,renderer_backend:'threejs',scene:{model_id:model,sat_quat:identity,distance_m:20000,resolution:1024,seed:20261101,noise:{enabled:false,gaussian_sigma:.012,poisson_peak:96},lighting:{azimuth_deg:35,elevation_deg:28,energy:4}},...extra}; }
  function inspect(job,expectedRoot) {
    assert(samePath(path.dirname(job.output_directory),expectedRoot),'Wrong frozen root '+job.output_directory);
    const artifacts=[];
    for(let i=1;i<=job.total_frames;i++){
      const id=String(i).padStart(6,'0');
      for(const relative of [`images_clean/${id}.png`,`labels/${id}.txt`,`poses/${id}.json`]){
        const file=path.join(job.output_directory,relative);assert(fs.existsSync(file),'Missing '+file);artifacts.push({relative,sha256:hash(file)});
      }
      const png=fs.readFileSync(path.join(job.output_directory,`images_clean/${id}.png`));
      assert(png.readUInt32BE(16)===1024&&png.readUInt32BE(20)===1024&&png[24]===8&&png[25]===0,'Unexpected PNG format');
      const decoded=PNG.sync.read(png);assert(decoded.width===1024&&decoded.height===1024&&decoded.data.some((v,index)=>index%4!==3&&v>0),'PNG decode failed or empty model');
      const pose=JSON.parse(fs.readFileSync(path.join(job.output_directory,`poses/${id}.json`),'utf8'));
      assert(pose.schema_version==='satellite-pose-4.0'&&pose.renderer.name==='Three.js','Pose/backend changed');
    }
    assert(!fs.existsSync(path.join(job.output_directory,'images_noisy')),'Noise-off duplicate');
    report.jobs.push({id:job.id,output_directory:job.output_directory,frames:job.total_frames,artifacts});
  }
  async function variant(instance,source) {
    const files=['images_clean/000001.png','labels/000001.txt','poses/000001.json'];
    const before=Object.fromEntries(files.map(f=>[f,hash(path.join(source.output_directory,f))]));
    const job=await wait(instance,await instance.api(`/api/jobs/${source.id}/noise-variants`,{noise:{enabled:true,gaussian_sigma:.02,poisson_peak:80},seed:42}));
    assert(samePath(path.dirname(job.output_directory),path.dirname(source.output_directory)),'Noise left source root');
    const meta=JSON.parse(fs.readFileSync(path.join(job.output_directory,'noise_meta/000001.json'),'utf8'));
    const noisy=path.join(job.output_directory,'images_noisy/000001.png');
    assert(hash(noisy)===meta.output_sha256,'Noise output digest mismatch');
    assert(PNG.sync.read(fs.readFileSync(noisy)).width===1024,'Noise PNG decode failed');
    for(const [kind,f] of Object.entries({clean:files[0],label:files[1],pose:files[2]})){
      assert(hash(path.join(source.output_directory,f))===before[f],'Source modified');
      assert(samePath(path.resolve(job.output_directory,meta.source_files[kind].path),path.join(source.output_directory,f)),'Source reference broken');
    }
    assert((await fetch(instance.origin+job.latest_images.clean)).ok,'Old root clean image inaccessible');
    report.noise_variants??=[];report.noise_variants.push({id:job.id,source_id:source.id,output_directory:job.output_directory,source_hashes:before});
  }
  try {
    const first=await launch('ready');const page=first.page;
    const initial=await first.api('/api/settings/output-directory');assert(samePath(initial.output_directory,path.join(workspace,'jobs')),'Default changed during migration');
    const old=await first.api('/api/jobs/'+baseline.no_blender_capture.job_id);
    const legacySnapshot=hash(path.join(old.output_directory,'job.json'));
    const input=page.getByRole('textbox',{name:'数据集保存位置',exact:true});
    const original=await input.inputValue();
    if(pickerEvidencePath){
      // Reuse a separately completed real OS picker check, never a mocked selection.
      const evidence=JSON.parse(fs.readFileSync(pickerEvidencePath,'utf8'));
      assert(evidence.picker_cancel===true&&evidence.picker_selection===true,'Picker evidence has not passed both real interactions');
      assert(fs.existsSync(evidence.rootA),'Picker evidence directory missing');
      report.picker_evidence={path:pickerEvidencePath,sha256:hash(pickerEvidencePath),output:evidence.output};
      report.picker_cancel=true;report.picker_selection=true;
      await save(first,rootA);
    }else{
    const picker=page.getByRole('button',{name:/^(选择文件夹|正在选择…)$/});
    await picker.click();
    for(let i=0;i<100;i++){if(await picker.isDisabled())break;await pause(50);}
    assert(await picker.isDisabled(),'Native picker did not enter pending state');
    control('cancel-picker',{port:first.port,origin:first.origin,pid:first.child.pid});
    for(let i=0;i<2400;i++){if(await picker.isEnabled())break;await pause(100);}
    assert(await picker.isEnabled(),'Picker cancel not completed');
    assert(await input.inputValue()===original,'Picker cancellation changed draft');report.picker_cancel=true;
    await picker.click();control('select-picker',{port:first.port,origin:first.origin,pid:first.child.pid});
    for(let i=0;i<2400;i++){if(samePath(await input.inputValue(),rootA))break;await pause(100);}
    assert(samePath(await input.inputValue(),rootA),'Native picker did not return selected Chinese/spaced folder');
    assert(samePath((await first.api('/api/settings/output-directory')).output_directory,original),'Picker saved before Apply');
    report.picker_selection=true;control('automated-acceptance',{port:first.port,origin:first.origin,pid:first.child.pid});
    await page.getByRole('button',{name:'应用',exact:true}).click();
    for(let i=0;i<200;i++){if(samePath((await first.api('/api/settings/output-directory')).output_directory,rootA))break;await pause(50);}
    }
    const models=await first.api('/api/models'),model=models[0].id;
    const noise=page.getByRole('checkbox',{name:'启用像素噪声',exact:true});if(await noise.isChecked()){await noise.focus();await noise.press('Space');}
    const [response]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/jobs'&&r.request().method()==='POST'),page.getByRole('button',{name:'生成当前单帧',exact:true}).click()]);
    const a=await wait(first,await response.json());inspect(a,rootA);
    const batch=await first.api('/api/jobs',capture(model,{mode:'custom_sequence',count:60,trajectory:{start_quat:identity,end_quat:{W:Math.SQRT1_2,X:Math.SQRT1_2,Y:0,Z:0}}}));
    const queued=await first.api('/api/jobs',capture(model));assert(queued.status==='queued','Freeze fixture did not queue');
    await save(first,rootB);const b=await first.api('/api/jobs',capture(model));
    inspect(await wait(first,batch),rootA);inspect(await wait(first,queued),rootA);inspect(await wait(first,b),rootB);
    await variant(first,old);await variant(first,a);
    assert(hash(path.join(old.output_directory,'job.json'))===legacySnapshot,'Legacy snapshot changed');
    assert(fs.existsSync(path.join(workspace,'jobs.sqlite3'))&&fs.existsSync(path.join(workspace,'logs')),'App state moved');
    for(const target of [rootA,rootB])for(const name of ['jobs.sqlite3','logs','service.lock'])assert(!fs.existsSync(path.join(target,name)),'App state leaked into dataset root');
    await page.screenshot({path:path.join(output,'custom-location.png'),fullPage:true});await close(first);
    const second=await launch('reopened');assert(samePath((await second.api('/api/settings/output-directory')).output_directory,rootB),'Location not remembered');
    assert(samePath(await second.page.getByRole('textbox',{name:'数据集保存位置',exact:true}).inputValue(),rootB),'Remembered path not in UI');
    for(const job of [old,a,queued,b]){const j=await second.api('/api/jobs/'+job.id);assert((await fetch(second.origin+j.latest_images.clean)).ok,'Historical root image unavailable after reopen');}
    const bad='relative/not-absolute';await second.page.getByRole('textbox',{name:'数据集保存位置',exact:true}).fill(bad);
    const [rejected]=await Promise.all([second.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings/output-directory'&&r.request().method()==='POST'),second.page.getByRole('button',{name:'应用',exact:true}).click()]);
    assert(rejected.status()===400,'Bad path accepted');assert(samePath((await second.api('/api/settings/output-directory')).output_directory,rootB),'Bad save replaced saved path');
    const offline=path.join(output,'临时离线 空目录');fs.mkdirSync(offline);await save(second,offline);assert(samePath(path.dirname(offline),output),'Unsafe test removal');fs.rmdirSync(offline);
    const failed=await second.raw('/api/jobs',capture(model));assert(failed.status===400,'Missing selected root silently accepted');
    assert(samePath((await second.api('/api/settings/output-directory')).output_directory,offline),'Missing root silently reset');report.offline_error=failed.value;
    await save(second,rootB);inspect(await wait(second,await second.api('/api/jobs',capture(model))),rootB);
    await second.page.getByRole('button',{name:'恢复默认',exact:true}).click();
    const field=second.page.getByRole('textbox',{name:'数据集保存位置',exact:true});
    for(let i=0;i<200;i++){if(samePath(await field.inputValue(),initial.default_output_directory))break;await pause(50);}
    if(!samePath((await second.api('/api/settings/output-directory')).output_directory,initial.default_output_directory))await second.page.getByRole('button',{name:'应用',exact:true}).click();
    for(let i=0;i<200;i++){if(samePath((await second.api('/api/settings/output-directory')).output_directory,initial.default_output_directory))break;await pause(50);}
    inspect(await wait(second,await second.api('/api/jobs',capture(model))),initial.default_output_directory);report.restore_default=true;
    await save(second,rootB);await second.page.screenshot({path:path.join(output,'remembered-location.png'),fullPage:true});
    await second.page.getByRole('region',{name:'数据集保存设置',exact:true}).screenshot({path:path.join(output,'output-directory-panel.png')});await close(second);
    assert(!report.pageErrors.length&&!report.resourceFailures.length,'Browser errors');report.closedWithoutOrphans=true;report.passed=true;control('passed');console.log(JSON.stringify({passed:true,output,jobs:report.jobs.length,frames:report.jobs.reduce((n,j)=>n+j.frames,0)}));
  } catch(error) {report.error=String(error);control('failed',{error:String(error)});if(host?.page){report.body=await host.page.locator('body').innerText().catch(()=>'');await host.page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}throw error;
  } finally {
    if(host?.child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
    await host?.browser?.close().catch(()=>{});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
