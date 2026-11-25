const { chromium } = require('playwright'); const path=require('path');
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox']});
  const page=await (await browser.newContext({viewport:{width:390,height:780}})).newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith('file:')?r.continue():r.abort());
  await page.goto('file://'+path.join(__dirname,'../build/test.html')); await page.waitForTimeout(1500);
  const run=async(sim,pacing,startKm,ms)=>page.evaluate(async([sim,pacing,startKm,ms])=>{
    const g=window.__sgim, sel=document.getElementById('speed'), pc=document.getElementById('pacing');
    sel.value=sim; sel.dispatchEvent(new Event('change')); pc.value=pacing; pc.dispatchEvent(new Event('change'));
    g.setKm(startKm,true); const t0=g.timeAt(g.state.km); document.getElementById('play').click(); const w0=performance.now();
    await new Promise(r=>setTimeout(r,ms)); document.getElementById('play').click(); const wall=(performance.now()-w0)/1000;
    return {sim,pacing,startKm,wall:+wall.toFixed(2),raceSec:+(g.timeAt(g.state.km)-t0).toFixed(1),km:+g.state.km.toFixed(3),ratio:+((g.timeAt(g.state.km)-t0)/wall).toFixed(1),playing:g.state.playing};
  },[sim,pacing,startKm,ms]);
  for(const a of [['60','even',0,3000],['60','effort',15.8,3000],['300','effort',5,2000],['1','even',2,2000],['preview','even',0,3000]]) console.log(JSON.stringify(await run(...a)));
  // finish handling: start 30 race-seconds before the end
  const fin=await page.evaluate(async()=>{const g=window.__sgim; const s=document.getElementById('speed'); s.value='60'; s.dispatchEvent(new Event('change')); g.setKm(21.0,true); document.getElementById('play').click(); await new Promise(r=>setTimeout(r,2500)); return {km:g.state.km,playing:g.state.playing,toast:document.getElementById('toast').textContent,elapsed:document.getElementById('roT').textContent,clock:document.getElementById('roC').textContent,pace:document.getElementById('roP').textContent};});
  console.log('finish',JSON.stringify(fin));
  // target change + splits list
  const sp=await page.evaluate(()=>{const t=document.getElementById('target'); t.value='1:45:00'; t.dispatchEvent(new Event('change')); document.querySelector('[data-filter="km"]').click(); const rows=[...document.querySelectorAll('#list li')].map(li=>li.textContent); return {n:rows.length,first:rows[0],r16:rows[15],r17:rows[16],last:rows[rows.length-1],note:document.getElementById('simNote').textContent,bad:(()=>{t.value='0:30:00'; t.dispatchEvent(new Event('change')); return t.value;})()};});
  console.log('splits',JSON.stringify(sp)); console.log('errors',JSON.stringify(errs));
  await browser.close();
})();
