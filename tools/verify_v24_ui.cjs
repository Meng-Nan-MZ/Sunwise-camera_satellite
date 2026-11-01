/* Attach to the isolated native run. Native folder dialogs require Computer Use. */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),controlFile=path.join(root,'var/development/v2.4/qa-control.json');
const q=JSON.parse(fs.readFileSync(controlFile,'utf8'));
const pickerEvidenceFlag=process.argv.indexOf('--picker-evidence');
const pickerEvidence=pickerEvidenceFlag>=0?path.resolve(process.argv[pickerEvidenceFlag+1]):null;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const check=(v,m)=>{if(!v)throw new Error(m);};
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function phase(value){fs.writeFileSync(controlFile,JSON.stringify({...q,phase:value},null,2));console.log(value);}
(async()=>{
  const report={passed:false,output:q.output,checks:{},layouts:[],ui_jobs:[]};let browser,page;
  const api=async(route,body)=>{const r=await fetch(q.origin+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await r.json();check(r.ok,JSON.stringify(value));return value;};
  const wait=async(job)=>{for(let i=0;i<1200;i++){const j=await api('/api/jobs/'+job.id);if(j.status==='completed')return j;check(['queued','running'].includes(j.status),JSON.stringify(j));await pause(50);}throw new Error('UI job timeout');};
  try{
    browser=await chromium.connectOverCDP('http://127.0.0.1:'+q.port);page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith(q.origin));check(page,'Native page missing');
    await page.getByRole('tab',{name:'生成数据',exact:true}).click();
    await page.evaluate(()=>window.getSelection()?.removeAllRanges());
    await page.getByRole('combobox',{name:'卫星模型',exact:true}).selectOption('insat_3b');
    check(await page.getByRole('combobox',{name:'卫星模型',exact:true}).locator('option').count()===6,'Six model options missing');
    check(await page.getByRole('combobox',{name:'生成模式',exact:true}).locator('option').count()===4,'Capture modes missing');
    check(await page.getByRole('checkbox',{name:'启用像素噪声',exact:true}).isChecked()===false,'Default noise not off');
    check(await page.locator('.advanced-settings').evaluate(e=>!e.open),'Advanced settings not collapsed');
    for(const size of [{width:1488,height:1056},{width:1440,height:960},{width:1080,height:720}]){
      await page.setViewportSize(size);await pause(150);
      const layout=await page.evaluate(()=>{const formal=document.querySelector('canvas[aria-hidden="true"]');const action=document.querySelector('.app-footer .generate');const footer=action?.getBoundingClientRect();const panel=document.querySelector('.right-column').getBoundingClientRect();const canvas=document.querySelector('.viewport canvas').getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,formal:formal?{display:getComputedStyle(formal).display,width:formal.getBoundingClientRect().width,height:formal.getBoundingClientRect().height}:null,footer:footer?{top:footer.top,bottom:footer.bottom,left:footer.left,right:footer.right}:null,panel:{width:panel.width,height:panel.height},canvas:{width:canvas.width,height:canvas.height}};});
      report.layouts.push(layout);check(layout.scrollWidth<=size.width,'Horizontal overflow '+JSON.stringify(layout));check(layout.footer&&layout.footer.bottom<=size.height&&layout.footer.top>=0,'Generate action offscreen');check(layout.formal?.display==='none'&&layout.formal.width===0,'Formal canvas affects layout');check(layout.canvas.width>350&&layout.canvas.height>250,'Preview too small');
      await page.screenshot({path:path.join(q.output,`generation-${size.width}x${size.height}.png`),fullPage:true});
    }
    report.checks.responsive=true;
    await page.setViewportSize({width:1488,height:1056});
    for(const mode of ['single','coverage','sequence','custom_sequence']){
      await page.getByRole('combobox',{name:'生成模式',exact:true}).selectOption(mode);
      check(await page.getByRole('spinbutton',{name:'目标距离数值',exact:true}).count()===(mode==='single'||mode==='custom_sequence'?1:0),'Wrong distance applicability '+mode);
    }
    await page.getByText('高级参数',{exact:true}).click();
    await page.getByRole('spinbutton',{name:'随机种子',exact:true}).fill('20261101');
    await page.getByText('高级参数',{exact:true}).click();report.checks.mode_parameters=true;
    await page.getByRole('button',{name:'更改',exact:true}).click();
    const input=page.getByRole('textbox',{name:'数据集保存位置',exact:true}),picker=page.getByRole('button',{name:/^(选择文件夹|正在选择…)$/});
    const original=await input.inputValue();
    if(pickerEvidence){
      const evidence=JSON.parse(fs.readFileSync(pickerEvidence,'utf8'));check(evidence.checks?.picker_cancel&&evidence.checks?.picker_selection,'Real picker evidence missing');report.picker_evidence=pickerEvidence;report.checks.picker_cancel=true;report.checks.picker_selection=true;await input.fill(q.rootA);
    }else{
    await picker.click();phase('cancel-picker');
    for(let i=0;i<6000;i++){if(await picker.isEnabled())break;await pause(100);}check(await picker.isEnabled(),'Native cancel timeout');check(await input.inputValue()===original,'Cancel altered draft');report.checks.picker_cancel=true;
    await picker.click();phase('select-picker');
    for(let i=0;i<6000;i++){if(same(await input.inputValue(),q.rootA))break;await pause(100);}check(same(await input.inputValue(),q.rootA),'Native selection not returned');report.checks.picker_selection=true;
    }
    if(await page.getByRole('button',{name:'应用',exact:true}).isEnabled())await page.getByRole('button',{name:'应用',exact:true}).click();for(let i=0;i<100;i++){if(same((await api('/api/settings/output-directory')).output_directory,q.rootA))break;await pause(50);}
    check(same((await api('/api/settings/output-directory')).output_directory,q.rootA),'UI folder save failed');
    await input.fill('relative/not-absolute');
    const [bad]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings/output-directory'&&r.request().method()==='POST'),page.getByRole('button',{name:'应用',exact:true}).click()]);
    check(bad.status()===400,'Invalid directory accepted');check(same((await api('/api/settings/output-directory')).output_directory,q.rootA),'Invalid save replaced preference');
    await input.fill(q.rootA);await page.getByRole('button',{name:'关闭',exact:true}).click();report.checks.directory_validation=true;phase('ui-automated-checks');
    await page.getByRole('spinbutton',{name:'采集数量',exact:true}).fill('3');
    await page.getByRole('spinbutton',{name:'起点X角度',exact:true}).fill('0');await page.getByRole('spinbutton',{name:'终点X角度',exact:true}).fill('90');
    await page.getByRole('slider',{name:'预览帧',exact:true}).focus();await page.getByRole('slider',{name:'预览帧',exact:true}).press('End');
    await page.getByRole('button',{name:'播放预览',exact:true}).click();await page.getByRole('button',{name:'暂停预览',exact:true}).click();
    check(await page.getByRole('spinbutton',{name:'终点X角度',exact:true}).inputValue()==='90','Preview overwrote endpoint');
    const [submitted]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/jobs'&&r.request().method()==='POST'),page.getByRole('button',{name:'生成3帧图像',exact:true}).click()]);
    check(submitted.status()===202,'UI submit rejected');const created=await submitted.json(),request=submitted.request().postDataJSON();
    check(request.renderer_backend==='threejs'&&request.count===3&&request.mode==='custom_sequence','Wrong UI request');
    await page.getByRole('spinbutton',{name:'终点X角度',exact:true}).fill('45');await page.getByRole('spinbutton',{name:'目标距离数值',exact:true}).fill('22');
    await page.getByRole('tab',{name:/^任务与结果/}).click();
    const complete=await wait(created);report.ui_jobs.push({job:complete,request});
    const saved=JSON.parse(fs.readFileSync(path.join(complete.output_directory,'job.json'),'utf8'));
    check(saved.trajectory.end_quat.X===request.trajectory.end_quat.X&&saved.scene.distance_m===20000,'Draft or navigation changed frozen job');
    check(await page.getByRole('button',{name:/^生成\d+帧图像$/}).count()===0,'Results can accidentally generate hidden draft');
    check(await page.getByRole('button',{name:'生成当前单帧',exact:true}).count()===0,'Results exposes a hidden-draft secondary capture');
    await page.getByRole('img',{name:'任务已保存的正式灰度 PNG',exact:true}).waitFor();
    for(let i=0;i<100;i++){if(await page.getByRole('img',{name:'任务已保存的正式灰度 PNG',exact:true}).evaluate(e=>e.complete&&e.naturalWidth===1024))break;await pause(50);}
    check(await page.getByRole('button',{name:'含噪声',exact:true}).isDisabled(),'Clean-only task exposes noisy image');
    await page.getByRole('checkbox',{name:'追加版本启用噪声',exact:true}).check();
    await page.getByRole('spinbutton',{name:'追加高斯标准差',exact:true}).fill('0.02');await page.getByRole('spinbutton',{name:'追加泊松峰值',exact:true}).fill('80');await page.getByRole('spinbutton',{name:'追加随机种子',exact:true}).fill('42');
    const [noise]=await Promise.all([page.waitForResponse(r=>/\/noise-variants$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST'),page.getByRole('button',{name:'基于原图生成噪声版本',exact:true}).click()]);
    check(noise.status()===202,'UI noise submit failed');const noiseJob=await wait(await noise.json());report.ui_jobs.push({job:noiseJob,request:noise.request().postDataJSON()});
    for(let i=0;i<100;i++){if(await page.getByRole('button',{name:'含噪声',exact:true}).isEnabled())break;await pause(50);}
    await page.getByRole('button',{name:'含噪声',exact:true}).click();check((await page.getByRole('img',{name:'任务已保存的正式灰度 PNG',exact:true}).getAttribute('src')).includes(noiseJob.id),'Noisy result wrong source');
    await page.getByRole('button',{name:'干净图像',exact:true}).click();check((await page.getByRole('img',{name:'任务已保存的正式灰度 PNG',exact:true}).getAttribute('src')).includes(complete.id),'Clean result not reused');
    await page.screenshot({path:path.join(q.output,'results-1488x1056.png'),fullPage:true});report.checks.noise_workflow=true;report.checks.frozen_job_navigation=true;
    await page.setViewportSize({width:1080,height:720});await page.screenshot({path:path.join(q.output,'results-1080x720.png'),fullPage:true});
    await page.getByRole('button',{name:'返回生成数据',exact:true}).click();
    check(await page.getByRole('spinbutton',{name:'终点X角度',exact:true}).inputValue()==='45','Draft lost on navigation');
    check(!await page.getByRole('checkbox',{name:'启用像素噪声',exact:true}).isChecked(),'Variant changed capture noise draft');
    await page.getByText('高级参数',{exact:true}).click();check(await page.getByRole('spinbutton',{name:'随机种子',exact:true}).inputValue()==='20261101','Variant changed capture seed');await page.getByText('高级参数',{exact:true}).click();report.checks.independent_variant_draft=true;
    await page.setViewportSize({width:1488,height:1056});await page.getByRole('checkbox',{name:'启用像素噪声',exact:true}).uncheck();await page.getByRole('spinbutton',{name:'目标距离数值',exact:true}).fill('20');await page.getByRole('spinbutton',{name:'采集数量',exact:true}).fill('120');await page.getByRole('spinbutton',{name:'终点X角度',exact:true}).fill('90');
    await page.getByRole('slider',{name:'预览帧',exact:true}).focus();await page.getByRole('slider',{name:'预览帧',exact:true}).press('Home');
    await page.evaluate(()=>{window.getSelection()?.removeAllRanges();document.activeElement?.blur();});await page.screenshot({path:path.join(q.output,'generation-final.png'),fullPage:true});
    report.passed=true;phase('ui-passed');
  }catch(error){report.error=String(error);if(page){report.body=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:path.join(q.output,'ui-failure.png'),fullPage:true}).catch(()=>{});}throw error;
  }finally{await browser?.close().catch(()=>{});fs.writeFileSync(path.join(q.output,'ui-acceptance.json'),JSON.stringify(report,null,2));if(report.passed)fs.writeFileSync(path.join(q.output,'ui-continue'),'passed');console.log(JSON.stringify({passed:report.passed,output:q.output,checks:report.checks,error:report.error}));}
})().catch(error=>{console.error(error);process.exitCode=1;});
