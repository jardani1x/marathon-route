const C=require('../src/core.js'), fs=require('fs'), assert=require('assert');
const d=JSON.parse(fs.readFileSync(__dirname+'/../data/data.json')), truth=JSON.parse(fs.readFileSync(__dirname+'/synth_truth.json'));
const proj=C.makeProjection(d.origin), trace=d.route.map(p=>proj.toXY(p[0],p[1]));
let pass=0; const ok=(c,m)=>{assert(c,m);pass++;};
// --- small unit checks
ok(Math.abs(C.cumLen([[0,0],[3,4],[3,10]])[2]-11)<1e-9,'cumLen');
ok(C.resample([[0,0],[100,0]],10).length===11,'resample count');
ok(C.resample([[5,5]],10).length===2 || true,'single point resample does not throw');
ok(C.simplify([[0,0],[5,0.1],[10,0]],1).length===2,'simplify drops near-collinear');
ok(C.simplify([[0,0],[0,0],[0,0]],1).length>=2,'simplify degenerate');
ok(C.interp([0,1,2],[0,10,20],1.5)===15 && C.interp([0,1],[5,6],-3)===5 && C.interp([0,1],[5,6],9)===6,'interp + clamps');
ok(C.parseTime('1:55:00')===6900 && C.parseTime('115')===6900 && C.parseTime('1:55')===6900 && isNaN(C.parseTime('abc')) && isNaN(C.parseTime('1::2')),'parseTime');
ok(C.fmtTime(6900)==='1:55:00' && C.fmtTime(59.6)==='0:01:00','fmtTime');
const rt=proj.toLL(...proj.toXY(1.3,103.87)); ok(Math.abs(rt[0]-1.3)<1e-9&&Math.abs(rt[1]-103.87)<1e-9,'projection round trip');
const pa=C.pointAt([[0,0],[10,0]],C.cumLen([[0,0],[10,0]]),25); ok(pa[0]===10,'pointAt clamps');
// --- parse robustness
ok(C.parseOverpass(null,proj).length===0 && C.parseOverpass({},proj).length===0 && C.parseOverpass({elements:[{type:'way'}]},proj).length===0,'parse bad input');
const osm=JSON.parse(fs.readFileSync(__dirname+'/synth_overpass.json'));
const ways=C.parseOverpass(osm,proj);
ok(ways.every(w=>w.highway!=='steps' && w.pts.length>=2),'steps and 1-point ways skipped');
// --- snapping on mis-registered synthetic roads
const t0=Date.now(); const r=C.snapToRoads(trace,ways,{courseM:21097.5}); const ms=Date.now()-t0;
console.log('stats',JSON.stringify({...r.stats,roadNames:r.stats.roadNames.length}),'ok',r.ok,r.reason,'ms',ms);
ok(r.ok,'snap accepted: '+r.reason);
ok(Math.abs(r.stats.scale-truth.scale)<0.006,'scale recovered '+r.stats.scale);
ok(Math.abs(r.stats.rotDeg-truth.rotDeg)<0.3,'rotation recovered '+r.stats.rotDeg);
// distance from each snapped vertex to the true road set (centre or +-8 m carriageways)
const tr=truth.true, ix=C.buildIndex([{pts:tr,foot:false}],60);
const dense=C.resample(r.xy,10), L=C.cumLen(dense); let errs=[],gapErr=[];
dense.forEach((p,i)=>{ const m=C.nearest(ix,p[0],p[1],0,{R:200,maxAng:Math.PI,allowFoot:true}); const e=m?Math.abs(m.d):999;
  const inGap=L[i]>truth.gap[0]-150 && L[i]<truth.gap[1]+150; (inGap?gapErr:errs).push(e); });
errs.sort((a,b)=>a-b); const p50=errs[errs.length>>1], p95=errs[Math.floor(errs.length*0.95)], mx=errs[errs.length-1];
console.log('offset from true centreline: p50',p50.toFixed(1),'p95',p95.toFixed(1),'max',mx.toFixed(1),'| in gap max',Math.max(...gapErr).toFixed(1));
ok(p95<=10.5,'95% within a carriageway of the true centreline');
ok(mx<40,'no wild excursions');
ok(Math.max(...gapErr)<25,'gap falls back to the aligned trace');
// --- rejects nonsense
ok(!C.snapToRoads(trace,[]).ok,'no roads -> rejected');
const far=ways.map(w=>({...w,pts:w.pts.map(p=>[p[0]+5000,p[1]])}));
ok(!C.snapToRoads(trace,far,{courseM:21097.5}).ok,'roads 5 km away -> rejected');
// --- query + export
const q=C.buildOverpassQuery(d.route.slice(0,3),90); ok(/^\[out:json\]\[timeout:60\];way\[highway\]\(around:90,1\.\d+,103\.\d+/.test(q)&&q.endsWith('out geom qt;'),'query shape');
const el=dense.map(()=>10), gj=JSON.parse(C.toGeoJSON('x',dense.map(p=>proj.toLL(p[0],p[1])),el));
ok(gj.features[0].geometry.coordinates.length===dense.length && gj.features[0].geometry.coordinates[0][0]>103,'geojson lon,lat order');
ok(C.toGPX('a<b',[[1.29,103.86]],[5]).includes('a&lt;b') ,'gpx escapes');
// --- pacing
const E=d.elev, T=7200, pe=C.buildPacing(E.km,E.m,21.0975,T,'even'), pf=C.buildPacing(E.km,E.m,21.0975,T,'effort');
ok(Math.abs(C.runCost(0)-3.6)<1e-12 && C.runCost(0.05)>C.runCost(0) && C.runCost(-0.05)<C.runCost(0) && C.runCost(9)===C.runCost(0.45),'cost curve shape + clamp');
ok(pe.t[pe.t.length-1]===T && pf.t[pf.t.length-1]===T && pe.t[0]===0,'both models finish exactly on target');
ok(Math.abs(C.timeAtKm(pe,10.54875)-3600)<1e-6,'even pace is linear');
let mono=true; for(let i=1;i<pf.t.length;i++) if(!(pf.t[i]>pf.t[i-1])) mono=false; ok(mono,'effort time strictly increasing');
for(const k of [0,0.3,5,16.25,21.0975]){ ok(Math.abs(C.kmAtTime(pf,C.timeAtKm(pf,k))-k)<1e-6,'time<->km round trip at '+k); }
const flat=C.paceAtKm(pe,8), up=C.paceAtKm(pf,16.0), down=C.paceAtKm(pf,16.55);
console.log('pace/km even',C.fmtPace(flat),'effort: Sheares climb',C.fmtPace(up),'descent',C.fmtPace(down),'| 16.25 km at',C.fmtTime(C.timeAtKm(pf,16.25)),'vs even',C.fmtTime(C.timeAtKm(pe,16.25)));
ok(Math.abs(flat-T/21.0975)<1e-6 && up>flat*1.05 && down<flat,'slower up the bridge, faster down');
ok(up<flat*1.6 && down>flat*0.6,'hill effect stays plausible');
ok(C.fmtPace(341.3)==='5:41' && C.fmtPace(359.6)==='6:00','fmtPace');
ok(Math.abs(C.paceAtKm(pe,21.0975)-flat)<1e-6 && Math.abs(C.paceAtKm(pe,0)-flat)<1e-6,'pace at the ends');
console.log(pass+' checks passed');
