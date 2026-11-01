/* V2.4 native acceptance. Playwright/pngjs are QA-only, never app dependencies. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const resumeFlag=process.argv.indexOf('--resume');
const resume=resumeFlag>=0;
const output=resume?path.resolve(process.argv[resumeFlag+1]):path.join(root,'var/verification/v2.4-workbench',String(Date.now()));
const project=path.join(output,'glb-only-application'),workspace=path.join(output,'workspace');
const rootA=path.join('C:/Users/mz/.codex/visualizations/2026/10/31/01a19283-a54f-7be2-8bfb-61c523bc789b','V2.4 数据集',path.basename(output));
const rootB=path.join(output,'数据集 B');
const controlPath=path.join(root,'var/development/v2.4/qa-control.json');
const runtime=JSON.parse(fs.readFileSync(path.join(root,'var/runtime.json'),'utf8').replace(/^\uFEFF/,''));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const check=(v,m)=>{if(!v)throw new Error(m);};
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
async function served(url){const response=await fetch(url);await response.arrayBuffer();return response.ok;}
const identity={W:1,X:0,Y:0,Z:0};
function inventory(directory){const result={};function walk(at){for(const item of fs.readdirSync(at,{withFileTypes:true})){const file=path.join(at,item.name);if(item.isDirectory())walk(file);else result[path.relative(directory,file)]=hash(file);}}walk(directory);return result;}
function control(phase,extra={}){fs.writeFileSync(controlPath,JSON.stringify({phase,output,project,workspace,rootA,rootB,...extra},null,2));console.log(phase);}
function body(model,extra={}){return {mode:'single',count:1,scene:{model_id:model,sat_quat:identity,distance_m:20000,resolution:1024,seed:20261101,noise:{enabled:false,gaussian_sigma:.012,poisson_peak:96},lighting:{azimuth_deg:35,elevation_deg:28,energy:4}},...extra};}

(async()=>{
  fs.mkdirSync(output,{recursive:true});fs.mkdirSync(rootA,{recursive:true});fs.mkdirSync(rootB,{recursive:true});
  const baseline=JSON.parse(fs.readFileSync(path.join(root,'var/verification/v2.2.1-benchmark/report.json'),'utf8'));
  check(baseline.passed,'Historical baseline has not passed');
  const sourceJobs=path.join(baseline.workspace,'jobs');
  const sourceBefore=inventory(sourceJobs);
  if(!resume)fs.cpSync(baseline.workspace,workspace,{recursive:true});
  const oldFiles=sourceBefore;
  for(const relative of ['apps/ui/dist','python/src'])fs.cpSync(path.join(root,relative),path.join(project,relative),{recursive:true,filter:p=>!p.includes('__pycache__')});
  fs.cpSync(path.join(root,'assets/models'),path.join(project,'assets/models'),{recursive:true,filter:p=>fs.statSync(p).isDirectory()||['.json','.glb'].includes(path.extname(p))});
  check(!fs.existsSync(path.join(project,'runtime/blender')),'Blender runtime in application fixture');
  const projectFiles=Object.keys(inventory(project));check(!projectFiles.some(p=>/\.blend\d?$|blender\.exe/i.test(p)),'Blend files in application fixture');
  const prior=resume?JSON.parse(fs.readFileSync(path.join(output,'report.json'),'utf8')):null;
  if(prior)fs.copyFileSync(path.join(output,'report.json'),path.join(output,'prior-run-report.json'));
  const report={passed:false,output,workspace,project,rootA,rootB,samples:prior?.samples??[],batches:[],mode_runs:[],noise_variants:[],pageErrors:[],resourceFailures:[],checks:{},historical:{jobs:fs.readdirSync(sourceJobs).length,files:Object.keys(oldFiles).length},...(prior?{resumed_from:path.join(output,'prior-run-report.json'),resume_reason:'Continue completed image samples after QA-client concurrent request timeout; final UI is rechecked.'}:{})};
  let host;
  async function launch(phase){
    const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    const child=spawn(path.join(root,'var/build/desktop-2.4.0/SatelliteStudio.Desktop.exe'),['--project-root',project,'--workspace',workspace,'--python',runtime.python],{windowsHide:true,stdio:'ignore',env:{...process.env,SATELLITE_BLENDER:path.join(output,'does-not-exist.exe'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`}});
    const instance={child,port};host=instance;
    for(let i=0;i<180;i++){check(child.exitCode===null,'Native application exited during startup');try{instance.browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:700});break;}catch{await pause(150);}}
    check(instance.browser,'Native WebView unavailable');
    for(let i=0;i<150;i++){instance.page=instance.browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));if(instance.page)break;await pause(100);}
    check(instance.page,'Native app page missing');
    instance.page.on('pageerror',e=>report.pageErrors.push(String(e)));
    instance.page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ABORTED'))report.resourceFailures.push({url:r.url(),error:r.failure()?.errorText});});
    await instance.page.getByRole('heading',{name:'卫星数据集生成工具',exact:true}).waitFor();
    instance.origin=new URL(instance.page.url()).origin;
    instance.raw=async(route,data)=>{const r=await fetch(instance.origin+route,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:r.status,value:await r.json()};};
    instance.api=async(route,data)=>{const r=await instance.raw(route,data);check(r.status<400,`${route}: ${r.status} ${JSON.stringify(r.value)}`);return r.value;};
    for(let i=0;i<300;i++){const h=await instance.api('/api/health');if(h.renderers?.threejs?.available){instance.health=h;break;}await pause(100);}
    check(instance.health&&!('blender' in instance.health.renderers),'Web-only readiness failed');
    report.checks.no_blender_launch=true;control(phase,{port,origin:instance.origin,pid:child.pid});return instance;
  }
  async function close(instance){
    execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${instance.child.pid}).CloseMainWindow() | Out-Null`],{windowsHide:true});
    for(let i=0;i<200&&instance.child.exitCode===null;i++)await pause(100);
    check(instance.child.exitCode!==null,'Native host did not close');
    let alive=true;for(let i=0;i<150;i++){try{await served(instance.origin+'/api/health');}catch{alive=false;break;}await pause(100);}
    check(!alive,'Owned local service remained alive');await instance.browser.close().catch(()=>{});host=null;
  }
  async function wait(instance,job){for(let i=0;i<2400;i++){const current=await instance.api('/api/jobs/'+job.id);if(current.status==='completed')return current;check(['queued','running'].includes(current.status),JSON.stringify(current));await pause(50);}throw new Error('Job timeout');}
  async function capture(instance,request,label){const start=performance.now();const job=await wait(instance,await instance.api('/api/jobs',request));const pose=JSON.parse(fs.readFileSync(path.join(job.output_directory,'poses/000001.json'),'utf8'));const record={model:request.scene.model_id,case:label,backend:'threejs',job_id:job.id,output_directory:job.output_directory,seconds:(performance.now()-start)/1000,request,renderer:pose.renderer};(request.mode==='custom_sequence'?report.batches:request.mode==='single'?report.samples:report.mode_runs).push({...record,...(request.count>1?{frames:request.count}:{})});return job;}
  async function noise(instance,source,seed){const job=await wait(instance,await instance.api(`/api/jobs/${source.id}/noise-variants`,{noise:{enabled:true,gaussian_sigma:.02,poisson_peak:80},seed}));check(same(path.dirname(job.output_directory),path.dirname(source.output_directory)),'Noise output lost source root');const file=path.join(job.output_directory,'noise_meta/000001.json');const meta=JSON.parse(fs.readFileSync(file,'utf8'));check(hash(path.join(job.output_directory,'images_noisy/000001.png'))===meta.output_sha256,'Noise digest invalid');check(!fs.existsSync(path.join(job.output_directory,'images_clean'))&&!fs.existsSync(path.join(job.output_directory,'poses')),'Noise duplicated source files');for(const item of Object.values(meta.source_files)){check(hash(path.resolve(job.output_directory,item.path))===item.sha256,'Source reference mismatch');}report.noise_variants.push({id:job.id,source_id:source.id,output_directory:job.output_directory,seed,sha256:meta.output_sha256});return job;}
  try{
    const first=await launch('native-ready');const page=first.page;
    const models=await first.api('/api/models');check(models.length===6,'Expected six actual GLBs');
    const oldJobs=await first.api('/api/jobs');const oldBlender=oldJobs.find(j=>j.renderer_backend==='blender'&&j.can_generate_noise);check(oldBlender,'Missing historical Blender fixture');
    for(const job of oldJobs){const detail=await first.api('/api/jobs/'+job.id);check(detail.model_id,'Historical model metadata missing');if(detail.latest_images?.clean)check(await served(first.origin+detail.latest_images.clean),'Historical clean inaccessible');}
    report.checks.historical_view=true;
    const rejected=await first.raw('/api/jobs',body(models[0].id,{renderer_backend:'blender'}));check(rejected.status===400,'New Blender submission accepted');report.checks.blender_rejected=true;
    await first.api('/api/settings/output-directory',{output_directory:rootA});
    control('ui-acceptance',{port:first.port,origin:first.origin,pid:first.child.pid});
    // UI-specific checks are attached here once the final accessible controls exist.
    if(process.argv.includes('--pause-ui')){for(let i=0;i<9000;i++){if(fs.existsSync(path.join(output,'ui-continue')))break;await pause(100);}check(fs.existsSync(path.join(output,'ui-continue')),'UI acceptance checkpoint not released');report.ui_acceptance=JSON.parse(fs.readFileSync(path.join(output,'ui-acceptance.json'),'utf8'));check(report.ui_acceptance.passed,'UI acceptance did not pass');}
    const q90=Math.SQRT1_2;
    const cases=[['identity',identity],['x+90',{W:q90,X:q90,Y:0,Z:0}],['x-90',{W:q90,X:-q90,Y:0,Z:0}],['y+90',{W:q90,X:0,Y:q90,Z:0}],['y-90',{W:q90,X:0,Y:-q90,Z:0}],['z+90',{W:q90,X:0,Y:0,Z:q90}],['z-90',{W:q90,X:0,Y:0,Z:-q90}],['asymmetric',{W:.8,X:.2,Y:-.4,Z:.4}]];
    let firstCapture=report.samples.length?await first.api('/api/jobs/'+report.samples[0].job_id):null;
    for(const model of models)for(const [label,q] of cases){if(report.samples.some(s=>s.model===model.id&&s.case===label))continue;const norm=Math.hypot(q.W,q.X,q.Y,q.Z);const request=body(model.id);request.scene.sat_quat=Object.fromEntries(Object.entries(q).map(([k,v])=>[k,v/norm]));const job=await capture(first,request,label);firstCapture??=job;}
    const custom=body(models[0].id,{mode:'custom_sequence',count:12,trajectory:{start_quat:identity,end_quat:{W:q90,X:q90,Y:0,Z:0}}});
    const batchStart=performance.now();const batchCreated=await first.api('/api/jobs',custom);
    const queued=await first.api('/api/jobs',body(models[0].id));
    await first.api('/api/settings/output-directory',{output_directory:rootB});
    const batch=await wait(first,batchCreated);await wait(first,queued);
    const batchPose=JSON.parse(fs.readFileSync(path.join(batch.output_directory,'poses/000001.json'),'utf8'));
    report.batches.push({model:custom.scene.model_id,case:'fixed-endpoints',backend:'threejs',job_id:batch.id,output_directory:batch.output_directory,seconds:(performance.now()-batchStart)/1000,request:custom,renderer:batchPose.renderer,frames:custom.count});
    check(same(path.dirname(batch.output_directory),rootA)&&same(path.dirname(queued.output_directory),rootA),'Queued roots changed');
    const current=await capture(first,body(models[0].id),'new-root');check(same(path.dirname(current.output_directory),rootB),'New root ignored');
    report.checks.frozen_output_roots=true;
    await capture(first,body(models[0].id,{mode:'coverage',count:3}),'coverage');
    await capture(first,body(models[0].id,{mode:'sequence',count:3}),'sequence');
    const noisy=body(models[0].id);noisy.scene.noise.enabled=true;await capture(first,noisy,'paired-noise');
    const nv1=await noise(first,oldBlender,42);await noise(first,firstCapture,84);const nv2=await noise(first,oldBlender,42);
    check(hash(path.join(nv1.output_directory,'images_noisy/000001.png'))===hash(path.join(nv2.output_directory,'images_noisy/000001.png')),'Same seed no longer deterministic');
    report.checks.legacy_noise_without_blender=true;
    const cancel=await first.api('/api/jobs',body(models[0].id,{mode:'custom_sequence',count:1000,trajectory:{start_quat:identity,end_quat:{W:q90,X:0,Y:q90,Z:0}}}));
    await first.api('/api/jobs/'+cancel.id+'/cancel',{});let terminal;
    for(let i=0;i<300;i++){terminal=await first.api('/api/jobs/'+cancel.id);if(terminal.status==='canceled')break;await pause(50);}check(terminal.status==='canceled'&&terminal.completed_frames<1000,'Cancel failed');report.checks.cancel=true;
    await close(first);
    const second=await launch('reopened');check(same((await second.api('/api/settings/output-directory')).output_directory,rootB),'Output preference not retained');
    for(const id of [firstCapture.id,oldBlender.id,current.id,nv1.id]){const j=await second.api('/api/jobs/'+id);check(await served(second.origin+j.latest_images.clean),'Result inaccessible after restart');}
    report.checks.reopen=true;await close(second);report.checks.closed_without_orphans=true;
    for(const [relative,digest] of Object.entries(oldFiles))check(hash(path.join(workspace,'jobs',relative))===digest,'Historical copy modified: '+relative);
    check(JSON.stringify(inventory(sourceJobs))===JSON.stringify(sourceBefore),'Original baseline modified');
    report.checks.historical_files_unchanged=true;report.checks.original_baseline_unchanged=true;
    check(!report.pageErrors.length&&!report.resourceFailures.length,'Browser errors present');report.passed=true;control('passed');
  }catch(error){report.error=String(error);control('failed',{error:String(error)});if(host?.page){report.body=await host.page.locator('body').innerText().catch(()=>'');await host.page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}throw error;
  }finally{if(host?.child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}await host?.browser?.close().catch(()=>{});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,output,checks:report.checks}));}
})().catch(error=>{console.error(error);process.exitCode=1;});
