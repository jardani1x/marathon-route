// Headless browser run: loads the page, optionally mocks Overpass, drives a few interactions, saves screenshots, reports console errors.
const { chromium } = require('playwright'); const SHOTS=require('path').join(__dirname,'../build/shots'); require('fs').mkdirSync(SHOTS,{recursive:true}); const fs=require('fs'), path=require('path');
(async()=>{
  const mode=process.argv[2]||'blocked', vw=+(process.argv[3]||390), vh=+(process.argv[4]||780), tag=process.argv[5]||mode;
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox']});
  const ctx=await browser.newContext({viewport:{width:vw,height:vh},deviceScaleFactor:2,hasTouch:vw<700});
  const page=await ctx.newPage(); const errs=[];
  page.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); }); page.on('pageerror',e=>errs.push('PAGEERROR '+e.message));
  let overpassCalls=0, lastBody='';
  await page.route('**/*',route=>{ const u=route.request().url();
    if(u.startsWith('file:')) return route.continue();
    if(/overpass/.test(u)){ overpassCalls++; lastBody=route.request().postData()||'';
      if(mode==='mock') return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:fs.readFileSync(path.join(__dirname,'synth_overpass.json'))});
      if(mode==='http500') return route.fulfill({status:504,body:'busy'}); }
    return route.abort(); });
  await page.goto('file://'+path.join(__dirname,'../build/test.html')); await page.waitForTimeout(2500);
  const info=await page.evaluate(()=>({src:window.__sgim.state.source,note:window.__sgim.state.srcNote,three:!!window.__sgim.three(),labels:window.__sgim.three()?window.__sgim.three().labels.filter(l=>l.vis).length:0,badge:document.getElementById('srcBadge').textContent,stats:window.__sgim.state.osmStats&&{m:window.__sgim.state.osmStats.matched,len:window.__sgim.state.osmStats.lengthM}}));
  console.log(tag,JSON.stringify(info),'overpassCalls',overpassCalls,'queryLen',decodeURIComponent(lastBody).length);
  await page.screenshot({path:path.join(SHOTS,`s_${tag}_1.png`)});
  const steps=(process.argv[6]||'').split(',').filter(Boolean); let n=2;
  for(const st of steps){
    if(st==='play'){ await page.click('#play'); await page.waitForTimeout(1500); await page.click('#play'); }
    else if(st.startsWith('km')) await page.evaluate(k=>window.__sgim.setKm(k,true),+st.slice(2));
    else if(st==='menu') await page.click('#openPanel');
    else if(st==='settings'){ await page.click('#tabSettings'); }
    else if(st==='map'){ await page.click('#view2d'); await page.waitForTimeout(800); }
    else if(st==='3d'){ await page.click('#view3d'); }
    else if(st==='street'){ await page.click('#viewStreet'); await page.waitForTimeout(600); }
    else if(st==='theme'){ await page.click('#themeBtn'); await page.waitForTimeout(400); }
    else if(st.startsWith('drag:')){ const [dx,dy]=st.slice(5).split('x').map(Number); const b=await page.$('#gl').then(e=>e.boundingBox()); const cx=b.x+b.width/2, cy=b.y+b.height/2; await page.mouse.move(cx,cy); await page.mouse.down(); await page.mouse.move(cx+dx,cy+dy,{steps:8}); await page.mouse.up(); }
    else if(st.startsWith('wait')){ await page.waitForTimeout(+st.slice(4)); }
    else if(st.startsWith('view:')) { await page.click(`[data-view="${st.slice(5)}"]`); await page.waitForTimeout(1200); }
    else if(st.startsWith('sel:')) { await page.evaluate(id=>window.__sgim.select(id,true),st.slice(4)); await page.waitForTimeout(1200); }
    else if(st.startsWith('search:')) { await page.fill('#q',st.slice(7)); }
    else if(st==='grade'){ await page.evaluate(()=>{document.getElementById('shGrade').click();}); }
    else if(st==='follow'){ await page.evaluate(()=>{document.getElementById('follow').click();}); await page.waitForTimeout(1200); }
    else if(st==='close'){ await page.evaluate(()=>{document.getElementById('panelClose').click();}); }
    else if(st.startsWith('tap:')){ const [x,y]=st.slice(4).split('x').map(Number); await page.mouse.click(x,y); await page.waitForTimeout(300); }
    else if(st.startsWith('exag')){ await page.evaluate(v=>{const e=document.getElementById('exag'); e.value=v; e.dispatchEvent(new Event('input'));},st.slice(4)); }
    await page.waitForTimeout(500);
    if(!st.startsWith('search:')||true) await page.screenshot({path:path.join(SHOTS,`s_${tag}_${n++}.png`)});
  }
  const end=await page.evaluate(()=>({km:window.__sgim.state.km,sel:window.__sgim.state.sel,overflowX:document.documentElement.scrollWidth>document.documentElement.clientWidth,list:document.querySelectorAll('#list li').length}));
  console.log(tag,'end',JSON.stringify(end),'errors',JSON.stringify(errs.filter(e=>!/ERR_FAILED|net::|Failed to load resource/.test(e))));
  await browser.close();
})();
