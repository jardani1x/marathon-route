const C=require('../src/core.js'), fs=require('fs'), assert=require('assert');
let pass=0; const ok=(c,m)=>{assert(c,m);pass++;};
// heights
let h=C.buildingHeight({building:'apartments','building:levels':'13'}); ok(Math.abs(h.h-42.6)<1e-9&&h.minH===0&&h.kind==='residential'&&h.source==='levels','levels -> height');
h=C.buildingHeight({building:'yes',height:'24.5 m',min_height:'6'}); ok(h.h===24.5&&h.minH===6&&h.source==='height','height + min_height');
h=C.buildingHeight({building:'office'}); ok(h.h===24&&h.source==='default'&&h.kind==='commercial','default by kind');
h=C.buildingHeight({building:'roof',height:'5'}); ok(h.minH===4&&h.kind==='light','roof canopy is raised');
h=C.buildingHeight({building:'yes',height:"100'"}); ok(Math.abs(h.h-30.48)<1e-9,'feet');
h=C.buildingHeight({building:'yes',height:'9999'}); ok(h.h===350,'clamped');
ok(isNaN(C.parseMetres('abc'))&&C.parseMetres('3,5')===3.5,'parseMetres');
// geometry helpers
const sq=[0,0,10,0,10,10,0,10]; ok(C.ringArea(sq)===100&&C.ringArea(sq.slice().reverse())===-100||C.ringArea([0,10,10,10,10,0,0,0])===-100,'signed area');
ok(C.pointInRing(5,5,sq)&&!C.pointInRing(15,5,sq),'point in ring');
// parse + parts + dedupe
const osm=JSON.parse(fs.readFileSync(__dirname+'/synth_features.json')), meta=JSON.parse(fs.readFileSync(__dirname+'/synth_features_meta.json'));
const f=C.parseFeatures(osm);
console.log('parsed buildings',f.buildings.length,'trees',f.trees.length,'greens',f.greens.length);
ok(f.buildings.length===meta.blocks+3+2,'blocks + on-course + 2 parts, outline dropped');
ok(!f.buildings.some(b=>b.id===meta.outline),'outline with parts replaced');
ok(f.buildings.filter(b=>b.minH===40).length===1,'upper part keeps its base');
ok(f.trees.length>100 && f.greens.length===2,'trees and parks');
ok(C.parseFeatures(null).buildings.length===0&&C.parseFeatures({elements:[{type:'way',tags:{building:'yes'},geometry:[{lat:1,lon:2}]}]}).buildings.length===0,'bad input');
const m=C.mergeFeatures(C.parseFeatures(osm),C.parseFeatures(osm)); ok(m.buildings.length===f.buildings.length&&m.trees.length===f.trees.length,'merge dedupes');
// corridor culling against the real course
const d=JSON.parse(fs.readFileSync(__dirname+'/../data/data.json')), proj=C.makeProjection(d.origin), route=d.route.map(p=>proj.toXY(p[0],p[1]));
const rings=f.buildings.map(b=>{const r=[];for(let i=0;i<b.ll.length;i+=2){const p=proj.toXY(b.ll[i],b.ll[i+1]);r.push(p[0],p[1]);}return r;});
const t0=Date.now(), hits=C.corridorHits(rings,route,8); const ms=Date.now()-t0;
const hitIds=f.buildings.filter((b,i)=>hits[i]).map(b=>b.id);
console.log('corridor hits',hitIds.length,'expected on-course',meta.onCourse,'in',ms,'ms');
ok(meta.onCourse.every(id=>hitIds.includes(id)),'blocks on the course are removed');
// exact check, brute force: distance from footprint corners/edge points to every course segment
const segd=(px,py,a,b)=>{const ux=b[0]-a[0],uy=b[1]-a[1],l2=ux*ux+uy*uy;let t=l2?((px-a[0])*ux+(py-a[1])*uy)/l2:0;t=Math.max(0,Math.min(1,t));return Math.hypot(px-a[0]-ux*t,py-a[1]-uy*t);};
const minDist=r=>{let m=1e9;const n=r.length/2;for(let i=0;i<n;i++){const j=(i+1)%n;for(let k=0;k<=4;k++){const x=r[i*2]+(r[j*2]-r[i*2])*k/4,y=r[i*2+1]+(r[j*2+1]-r[i*2+1])*k/4;for(let q=0;q+1<route.length;q++)m=Math.min(m,segd(x,y,route[q],route[q+1]));}}return m;};
let wrongKeep=0,wrongDrop=0;
rings.forEach((r,i)=>{const md=minDist(r), inside=route.some(p=>C.pointInRing(p[0],p[1],r)); if(hits[i]&&md>8.5&&!inside)wrongDrop++; if(!hits[i]&&(md<7.5||inside))wrongKeep++;});
console.log('removed but clear of the course',wrongDrop,'| kept but touching the course',wrongKeep);
ok(wrongDrop===0,'every removed block really touches the course');
ok(wrongKeep===0,'no kept block comes within 7.5 m of the course');
// a big footprint the course crosses without any corner near it
const p0=C.pointAt(route,C.cumLen(route),6000), big=[p0[0]-60,p0[1]-60,p0[0]+60,p0[1]-60,p0[0]+60,p0[1]+60,p0[0]-60,p0[1]+60];
ok(C.corridorHits([big],route,8)[0],'course through the middle of a big footprint');
// pieces + query
const pcs=C.routePieces(route,3000,40); ok(pcs.length===7&&pcs.every(p=>p.length>50),'7 route pieces');
const q=C.buildOverpassFeaturesQuery([[1.29,103.86],[1.291,103.861]],230); ok(/way\[building\]\(around:230,1\.29000,103\.86000,1\.29100,103\.86100\)/.test(q)&&/building:part/.test(q)&&/natural=tree/.test(q)&&q.endsWith('out geom qt;'),'query');
console.log(pass+' checks passed');
