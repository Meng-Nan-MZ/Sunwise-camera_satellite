/* Native capture acceptance and full-output timing; Playwright is QA-only. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'var/verification/v2.2.1-benchmark', String(Date.now()));
const workspace = path.join(output, 'workspace');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'var/runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const samePose = (q, expected) => Math.abs(['W','X','Y','Z'].reduce((s,k) => s + q[k]*expected[k], 0)) > 1-1e-9;
const identity = {W:1,X:0,Y:0,Z:0};
const x90 = {W:Math.SQRT1_2,X:Math.SQRT1_2,Y:0,Z:0};
function euler(x,y,z) {
  const [a,b,c]=[x,y,z].map(v=>v*Math.PI/360);
  const [cx,cy,cz,sx,sy,sz]=[Math.cos(a),Math.cos(b),Math.cos(c),Math.sin(a),Math.sin(b),Math.sin(c)];
  return {W:cx*cy*cz-sx*sy*sz,X:sx*cy*cz+cx*sy*sz,Y:cx*sy*cz-sx*cy*sz,Z:cx*cy*sz+sx*sy*cz};
}
const cases=[{name:'identity',q:identity,distance:20000},{name:'X90',q:x90,distance:10000},
  {name:'XYZ25_40_15',q:euler(25,40,15),distance:30000}];

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const legacy=path.join(root,'var/verification/v2.2-api-final/workspace');
  if(fs.existsSync(legacy))fs.cpSync(legacy,workspace,{recursive:true});
  const report={passed:false,output,workspace,samples:[],batches:[],pageErrors:[],resourceFailures:[]};
  let host;
  async function launch(blender,phase) {
    const started=performance.now();
    const port=await new Promise((resolve,reject)=>{
      const server=net.createServer();server.on('error',reject);
      server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});
    });
    const child=spawn(path.join(root,'var/build/desktop/SatelliteStudio.Desktop.exe'),
      ['--project-root',root,'--workspace',workspace,'--python',runtime.python,'--blender',blender],
      {windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`}});
    fs.writeFileSync(path.join(output,phase+'.pid'),String(child.pid));
    const instance={child};host=instance;
    for(let i=0;i<120;i++){
      assert(child.exitCode===null,'Desktop exited during startup');
      try{instance.browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000});break;}
      catch{await pause(250);}
    }
    assert(instance.browser,'Native browser unavailable');
    for(let i=0;i<150;i++){
      instance.page=instance.browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));
      if(instance.page)break;await pause(100);
    }
    assert(instance.page,'Workbench page missing');
    instance.page.on('pageerror',e=>report.pageErrors.push(String(e)));
    instance.page.on('requestfailed',r=>{if(!r.failure()?.errorText.includes('ABORTED'))report.resourceFailures.push({url:r.url(),error:r.failure()?.errorText});});
    await instance.page.getByRole('heading',{name:'Satellite Dataset Studio V2.2.1',exact:true}).waitFor();
    instance.origin=new URL(instance.page.url()).origin;
    instance.api=async(route,body)=>{
      const response=await fetch(instance.origin+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const value=await response.json();assert(response.ok,`${route}: ${response.status} ${JSON.stringify(value)}`);return value;
    };
    for(let i=0;i<300;i++){
      const health=await instance.api('/api/health');
      if(health.renderers?.threejs?.available){instance.health=health;break;}
      await pause(100);
    }
    assert(instance.health,'Web renderer did not register');
    instance.startup_s=(performance.now()-started)/1000;
    try{const session=await instance.browser.newBrowserCDPSession();instance.gpu=(await session.send('SystemInfo.getInfo')).gpu;await session.detach();}catch{}
    return instance;
  }
  async function closeHost(instance) {
    if(instance.child.exitCode===null){
      execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${instance.child.pid}).CloseMainWindow() | Out-Null`],{windowsHide:true});
      for(let i=0;i<120&&instance.child.exitCode===null;i++)await pause(100);
    }
    assert(instance.child.exitCode!==null,'Native window failed to close');
    let alive=false;try{await fetch(instance.origin+'/api/health');alive=true;}catch{}
    assert(!alive,'Owned service remained alive');
    await instance.browser?.close().catch(()=>{});host=null;
  }
  async function wait(instance,job) {
    for(let i=0;i<1800;i++){
      const state=await instance.api('/api/jobs/'+job.id);
      if(state.status==='completed')return state;
      assert(['queued','running'].includes(state.status),JSON.stringify(state));await pause(50);
    }
    throw new Error('Job timed out: '+job.id);
  }
  function scene(model,q,distance=20000,enabled=false) {
    return {model_id:model,sat_quat:q,distance_m:distance,resolution:1024,seed:20261101,
      noise:{enabled,gaussian_sigma:.012,poisson_peak:96},lighting:{azimuth_deg:35,elevation_deg:28,energy:4}};
  }
  async function capture(instance,model,test,backend) {
    const request={mode:'single',count:1,renderer_backend:backend,scene:scene(model.id,test.q,test.distance)};
    const started=performance.now();const created=await instance.api('/api/jobs',request);const job=await wait(instance,created);
    const seconds=(performance.now()-started)/1000;
    const pose=await instance.api(`/data/${job.id}/poses/000001.json`);
    assert(samePose(pose.Location.SatQuat,test.q),'Saved attitude differs from frozen request');
    assert(samePose(pose.Location.CamQuat,{W:.5,X:.5,Y:-.5,Z:.5}),'Saved observation camera differs');
    assert(pose.distance_m===test.distance,'Saved distance differs');
    assert(!fs.existsSync(path.join(job.output_directory,'images_noisy')),'Noise-off output duplicated image');
    const sample={model:model.id,case:test.name,backend,job_id:job.id,output_directory:job.output_directory,seconds,request,renderer:pose.renderer};
    report.samples.push(sample);console.log(JSON.stringify({model:model.id,case:test.name,backend,seconds}));
    return sample;
  }
  try{
    const first=await launch(runtime.blender,'comparison');
    report.app_startup_s=first.startup_s;report.gpu=first.gpu;report.browser_version=first.browser.version();
    assert(first.health.renderers.blender.available,'Blender reference unavailable');
    const page=first.page;
    const selector=page.getByRole('combobox',{name:'出图方式',exact:true});
    assert(await selector.inputValue()==='threejs','New UI default is not web capture');
    const noise=page.getByRole('checkbox',{name:'启用像素噪声',exact:true});
    if(await noise.isChecked()){await noise.focus();await noise.press('Space');}
    const uiStarted=performance.now();
    const [response]=await Promise.all([
      page.waitForResponse(r=>new URL(r.url()).pathname==='/api/jobs'&&r.request().method()==='POST'),
      page.getByRole('button',{name:'生成当前单帧',exact:true}).click(),
    ]);
    assert(response.status()===202,'UI single submission failed');
    const uiRequest=response.request().postDataJSON();assert(uiRequest.renderer_backend==='threejs','UI single backend not frozen');
    const uiJob=await wait(first,await response.json());
    report.ui_single={job_id:uiJob.id,request:uiRequest,seconds:(performance.now()-uiStarted)/1000};
    const models=await first.api('/api/models');assert(models.length===6,'Six models expected');
    for(const model of models)for(const test of cases)for(const backend of ['threejs','blender'])await capture(first,model,test,backend);
    // Warm each engine on the batch model before measuring a full continuous request.
    for(const backend of ['threejs','blender']){
      await capture(first,models[0],cases[0],backend);
      const request={mode:'custom_sequence',count:12,renderer_backend:backend,scene:scene(models[0].id,identity),
        trajectory:{start_quat:identity,end_quat:x90,time_step_s:1}};
      const started=performance.now();const job=await wait(first,await first.api('/api/jobs',request));
      report.batches.push({backend,frames:12,seconds:(performance.now()-started)/1000,job_id:job.id,output_directory:job.output_directory,request});
    }
    // Other modes, noise publication, cancellation and work after a canceled attempt.
    report.other_modes=[];
    for(const mode of ['coverage','sequence']){
      const job=await wait(first,await first.api('/api/jobs',{mode,count:2,renderer_backend:'threejs',scene:scene(models[0].id,identity)}));
      report.other_modes.push({mode,job_id:job.id,frames:job.completed_frames});
    }
    const noisy=await wait(first,await first.api('/api/jobs',{mode:'single',renderer_backend:'threejs',scene:scene(models[0].id,identity,20000,true)}));
    assert(noisy.latest_images.noisy,'Enabled noise output unavailable');report.noisy_job=noisy.id;
    const longRequest={mode:'custom_sequence',count:100000,renderer_backend:'threejs',scene:scene(models[0].id,identity),trajectory:{start_quat:identity,end_quat:x90}};
    let canceled=await first.api('/api/jobs',longRequest);await pause(180);await first.api(`/api/jobs/${canceled.id}/cancel`,{});
    for(let i=0;i<100;i++){canceled=await first.api('/api/jobs/'+canceled.id);if(canceled.status==='canceled')break;await pause(100);}
    assert(canceled.status==='canceled','Cancel did not release web capture');report.canceled=canceled;
    await capture(first,models[0],cases[0],'threejs');
    // Real GPU context loss: fail the affected request, then use the visible reconnect action.
    const lostJob=await first.api('/api/jobs',longRequest);await pause(180);
    assert(await page.evaluate(()=>{
      const canvas=document.querySelector('canvas[aria-hidden="true"]');
      const extension=canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      if(!extension)return false;extension.loseContext();return true;
    }),'GPU context loss extension unavailable');
    let lostState;
    for(let i=0;i<300;i++){
      lostState=await first.api('/api/jobs/'+lostJob.id);
      if(!['queued','running'].includes(lostState.status))break;await pause(100);
    }
    assert(lostState.status==='failed','Context loss did not fail the affected task');
    await page.getByRole('button',{name:'重新连接网页采集',exact:true}).click();
    let restored=false;
    for(let i=0;i<300;i++){
      if((await first.api('/api/health')).renderers.threejs.available){restored=true;break;}
      await pause(100);
    }
    assert(restored,'Web renderer reconnect did not register');
    const recovered=await capture(first,models[0],cases[0],'threejs');
    report.context_loss={failed_job:lostJob.id,failed_status:lostState.status,recovered_job:recovered.job_id};
    await page.screenshot({path:path.join(output,'web-capture-workbench.png'),fullPage:true});
    const closingJob=await first.api('/api/jobs',longRequest);await pause(120);
    await closeHost(first);
    const second=await launch(path.join(output,'missing-blender.exe'),'no-blender');
    assert(!second.health.renderers.blender.available,'Missing Blender was marked available');
    assert((await second.api('/api/jobs/'+closingJob.id)).status==='interrupted','Closed running task not recovered as interrupted');
    report.no_blender_capture=await capture(second,models[0],cases[2],'threejs');
    const variant=await wait(second,await second.api(`/api/jobs/${report.no_blender_capture.job_id}/noise-variants`,{noise:{enabled:true,gaussian_sigma:.018,poisson_peak:80},seed:42}));
    assert(variant.source_job_id===report.no_blender_capture.job_id,'Noise source changed');
    report.no_blender_noise_variant=variant.id;
    await second.page.screenshot({path:path.join(output,'no-blender-capture.png'),fullPage:true});
    await closeHost(second);
    assert(report.pageErrors.length===0,'Page errors: '+JSON.stringify(report.pageErrors));
    assert(report.resourceFailures.length===0,'Resource failures: '+JSON.stringify(report.resourceFailures));
    report.closedWithoutOrphans=true;report.passed=true;
    console.log(JSON.stringify({passed:true,output,samples:report.samples.length,batches:report.batches}));
  }catch(error){
    report.error=String(error);
    if(host?.page){report.body=await host.page.locator('body').innerText().catch(()=> 'unavailable');await host.page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
    throw error;
  }finally{
    if(host?.child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(host.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
    await host?.browser?.close().catch(()=>{});
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
