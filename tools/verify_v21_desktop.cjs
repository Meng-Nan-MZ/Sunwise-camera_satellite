/* Archived QA for an earlier application version. */
if (require.main === module) throw new Error('Retired historical QA: use its original checkout. V2.4: tools/verify_v24_workbench.cjs; see tools/OFFLINE-AUTHORING.md.');
/* Native V2.1 acceptance: endpoints, preview, visible-pose single and frozen batch. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'var/verification/v2.1-desktop', String(Date.now()));
const workspace = path.join(output, 'workspace');
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'var/runtime.json'), 'utf8').replace(/^\uFEFF/, ''));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, why) => { if (!ok) throw new Error(why); };
const equivalent = (q, expected) => Math.abs(['W','X','Y','Z'].reduce((n,k) => n + q[k] * expected[k], 0)) > 1 - 1e-10;
const xRotation = degrees => ({ W: Math.cos(degrees*Math.PI/360), X: Math.sin(degrees*Math.PI/360), Y: 0, Z: 0 });

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const child = spawn(path.join(root, 'var/build/desktop/SatelliteStudio.Desktop.exe'),
    ['--project-root', root, '--workspace', workspace, '--python', runtime.python, '--blender', runtime.blender],
    { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9239' } });
  let browser;
  let page;
  const report = { passed: false, output, pageErrors: [], resourceFailures: [] };
  fs.writeFileSync(path.join(output,'desktop.pid'),String(child.pid));
  try {
    for (let i=0;i<100;i++) {
      assert(child.exitCode === null, 'Native desktop exited before ready');
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9239', { timeout: 1000 }); break; }
      catch { await pause(300); }
    }
    assert(browser, 'Desktop browser unavailable');
    for (let i=0;i<100;i++) {
      page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));
      if (page) break;
      await pause(100);
    }
    assert(page, 'Workbench page missing');
    page.on('pageerror', e=>report.pageErrors.push(String(e)));
    page.on('requestfailed', r=>{ if (!r.failure()?.errorText.includes('ABORTED')) report.resourceFailures.push(r.url()); });
    assert((await page.title()).includes('V2.1'), 'Wrong UI version');
    const origin=new URL(page.url()).origin;
    const single=page.getByRole('button',{name:'生成当前单帧',exact:true});
    await single.waitFor({ state: 'visible' });
    for(let i=0;i<200&&!(await single.isEnabled());i++) await pause(100);
    assert(await single.isEnabled(), 'Model not ready');
    const manual=page.getByRole('spinbutton',{name:'X 轴旋转数值',exact:true});
    await manual.fill('20');
    await page.getByRole('button',{name:/自定义姿态序列/}).click();
    const start=page.getByRole('spinbutton',{name:'起点X角度',exact:true});
    const end=page.getByRole('spinbutton',{name:'终点X角度',exact:true});
    await page.getByRole('button',{name:'起点使用当前姿态',exact:true}).click();
    assert(await start.inputValue()==='20','Use-current endpoint did not copy manual pose');
    await start.fill('0'); await end.fill('90');
    const count=page.getByRole('spinbutton',{name:'采集数量',exact:true});
    await count.fill('120');
    await page.getByRole('button',{name:'播放预览',exact:true}).click();
    await pause(350);
    await page.getByRole('button',{name:'暂停预览',exact:true}).click();
    const readout=page.getByLabel('当前预览帧',{exact:true});
    const paused=await readout.innerText(); await pause(250);
    assert(await readout.innerText()===paused,'Pause allowed queued timer to advance');
    assert(await start.inputValue()==='0'&&await end.inputValue()==='90','Preview mutated endpoint settings');
    await page.getByRole('button',{name:'退出预览',exact:true}).click();
    assert(await manual.inputValue()==='20'&&await manual.isEnabled(),'Manual pose did not return');
    // Empty and extreme finite endpoint input must remain a usable form.
    await end.fill('');
    assert(!(await page.getByRole('button',{name:'播放预览',exact:true}).isEnabled()),'Invalid endpoint preview enabled');
    await end.fill('1e308');
    await page.getByRole('button',{name:'播放预览',exact:true}).click(); await pause(150);
    await page.getByRole('button',{name:'退出预览',exact:true}).click();
    await end.fill('90');
    await count.fill('3');
    const timeline=page.getByRole('slider',{name:'预览帧',exact:true});
    await timeline.focus(); await timeline.press('Home'); await timeline.press('ArrowRight');
    assert((await readout.innerText()).includes('2 / 3'),'Wrong visible midpoint frame');
    assert(!(await manual.isEnabled()),'Manual pose editable while different pose is displayed');
    await page.screenshot({path:path.join(output,'midpoint-preview.png'),fullPage:true});
    async function submit(button) {
      console.log('Submitting',await button.innerText(),await button.isEnabled());
      const [response]=await Promise.all([
        page.waitForResponse(r=>new URL(r.url()).pathname==='/api/jobs'&&r.request().method()==='POST'),
        button.click({timeout:10000})
      ]);
      assert(response.status()===202,'Submission rejected: '+await response.text());
      return { job:await response.json(), request:response.request().postDataJSON() };
    }
    async function wait(job) {
      for(let i=0;i<240;i++) {
        const state=await(await fetch(origin+'/api/jobs/'+job.id)).json();
        if(state.status==='completed')return state;
        assert(['queued','running'].includes(state.status),JSON.stringify(state)); await pause(250);
      }
      throw new Error('Job timed out');
    }
    const captured=await submit(single);
    assert(captured.request.mode==='single'&&!('trajectory'in captured.request),'Trajectory leaked into single request');
    assert(equivalent(captured.request.scene.sat_quat,xRotation(45)),'Single did not capture visible midpoint');
    await wait(captured.job);
    const singlePose=await(await fetch(origin+'/data/'+captured.job.id+'/poses/000001.json')).json();
    assert(equivalent(singlePose.Location.SatQuat,xRotation(45)),'Saved single differs from preview');
    const batch=await submit(page.getByRole('button',{name:/^开始生成/}));
    assert(batch.request.mode==='custom_sequence'&&batch.request.count===3,'Wrong batch mode/count');
    assert(equivalent(batch.request.trajectory.start_quat,xRotation(0))&&equivalent(batch.request.trajectory.end_quat,xRotation(90)),'Batch used preview as endpoint');
    await end.fill('45');
    await page.getByRole('spinbutton',{name:'目标距离数值',exact:true}).fill('25');
    const finished=await wait(batch.job);
    const locations=[];
    for(let i=0;i<3;i++) {
      const pose=await(await fetch(origin+'/data/'+batch.job.id+'/poses/'+String(i+1).padStart(6,'0')+'.json')).json();
      assert(equivalent(pose.Location.SatQuat,xRotation(i*45)),'Frozen batch pose mismatch');
      assert(pose.distance_m===20000,'Live distance changed frozen job');
      locations.push(pose.Location);
    }
    await page.locator('.result-details .status-badge.completed').waitFor({state:'visible'});
    assert((await page.locator('.result-details .job-title').innerText()).includes('3 / 3'),'UI did not show completed frame count');
    await page.screenshot({path:path.join(output,'completed-sequence.png'),fullPage:true});
    assert(report.pageErrors.length===0,'Page errors: '+report.pageErrors.join(';'));
    assert(report.resourceFailures.length===0,'Resource failures: '+report.resourceFailures.join(';'));
    report.single={id:captured.job.id,Location:singlePose.Location};
    report.batch={id:finished.id,frames:finished.completed_frames,Location:locations};
    report.preview={paused,midpoint:'2 / 3',manualRestored:true,extremeInputSafe:true};
    execFileSync('powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${child.pid}).CloseMainWindow() | Out-Null`],{windowsHide:true});
    for(let i=0;i<80&&child.exitCode===null;i++)await pause(100);
    assert(child.exitCode!==null,'Native close failed');
    let alive=false;try{await fetch(origin+'/api/health');alive=true;}catch{}
    assert(!alive,'Owned backend remained after close');
    report.closedWithoutOrphan=true; report.passed=true;
    console.log(JSON.stringify({passed:true,output,preview:true,single:true,batch:3,snapshotFrozen:true}));
  } catch(error) {
    report.error=String(error);
    if(page){
      report.body=await page.locator('body').innerText().catch(()=> 'unavailable');
      await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});
    }
    throw error;
  } finally {
    if(child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    fs.writeFileSync(path.join(output,'..','report.json'),JSON.stringify(report,null,2));
    if(browser)await browser.close().catch(()=>{});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
