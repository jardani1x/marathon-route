const { chromium } = require('playwright'); const path=require('path'), http=require('http'), fs=require('fs');
(async()=>{
  const root=path.join(__dirname,'..'); const srv=http.createServer((q,r)=>{ const f=path.join(root,decodeURIComponent(q.url.split('?')[0])); fs.readFile(f,(e,d)=>{ if(e){r.writeHead(404);r.end();} else {r.writeHead(200,{'content-type':f.endsWith('.html')?'text/html':'application/javascript'});r.end(d);} }); }).listen(8765);
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--no-sandbox']});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
  for(const [name,url] of [['file','file://'+path.join(root,'build/test.html')],['http','http://localhost:8765/build/test.html']]){
    const page=await (await browser.newContext({viewport:{width:900,height:700}})).newPage(); const errs=[], osm=[], custom=[]; page.on('pageerror',e=>errs.push(e.message));
    await page.route('**/*',r=>{ const u=r.request().url(); if(u.startsWith('file:')||u.startsWith('http://localhost')) return r.continue();
      if(u.includes('tile.openstreetmap.org')){ osm.push(r.request().headers()['referer']||'(none)'); return r.fulfill({status:200,contentType:'image/png',body:png}); }
      if(u.includes('basemaps.cartocdn.com')){ custom.push(u); return r.fulfill({status:200,contentType:'image/png',body:png}); }
      if(u.includes('tiles.example.com')){ custom.push(u); return r.fulfill({status:200,contentType:'image/png',body:png}); } return r.abort(); });
    await page.goto(url); await page.waitForTimeout(1200); await page.click('#view2d'); await page.waitForTimeout(1200);
    const a=await page.evaluate(()=>({noteHidden:document.getElementById('mapnote').hidden,note:document.getElementById('mapnote').textContent.slice(0,60)}));
    console.log(name,'default: OSM tile requests',osm.length,'referer',osm[0]||'-',JSON.stringify(a));
    await page.evaluate(()=>{const p=document.getElementById('tileProv'); p.value='custom'; p.dispatchEvent(new Event('change')); document.getElementById('tileUrl').value='not a url'; document.getElementById('tileSave').click();});
    const bad=await page.evaluate(()=>document.getElementById('toast').textContent);
    await page.evaluate(()=>{document.getElementById('tileUrl').value='https://tiles.example.com/{z}/{x}/{y}.png?key=K123'; document.getElementById('tileAttr').value='(c) Example <b>x</b>'; document.getElementById('tileSave').click();});
    await page.waitForTimeout(1000);
    const b=await page.evaluate(()=>({noteHidden:document.getElementById('mapnote').hidden,attr:document.querySelector('.leaflet-control-attribution').textContent}));
    console.log(name,'custom: requests',custom.length,(custom[0]||'').slice(0,60),JSON.stringify(b),'| bad url ->',bad.slice(0,40),'| errors',JSON.stringify(errs));
    // CARTO preset: key validation, light/dark style follows the theme
    const carto=await page.evaluate(async()=>{const p=document.getElementById('tileProv'); p.value='carto'; p.dispatchEvent(new Event('change'));
      const keyRowShown=!document.getElementById('tileKeyRow').hidden; document.getElementById('tileKey').value='x'; document.getElementById('tileSave').click(); const bad=document.getElementById('toast').textContent;
      document.getElementById('tileKey').value='abcd1234efgh'; document.getElementById('tileSave').click(); await new Promise(r=>setTimeout(r,600));
      document.getElementById('themeBtn').click(); await new Promise(r=>setTimeout(r,600));
      return {keyRowShown,bad:bad.slice(0,30),osmClass:document.getElementById('map2d').classList.contains('tiles-osm'),attr:document.querySelector('.leaflet-control-attribution').textContent};});
    console.log(name,'carto',JSON.stringify(carto),'requests',[...new Set(custom.filter(u=>u.includes('carto')).map(u=>u.replace(/\/\d+\/\d+\/\d+\.png/,'/{z}/{x}/{y}.png')))].join(' | '));
    if(name==='http') await page.screenshot({path:path.join(__dirname,'../build/shots/tiles.png')});
  }
  await browser.close(); srv.close();
})();
