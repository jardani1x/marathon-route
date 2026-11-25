const C=require('../src/core.js'), fs=require('fs'), assert=require('assert');
let pass=0; const ok=(c,m)=>{assert(c,m);pass++;};
const line=(pts,step=2)=>{const o=[];for(let i=0;i+1<pts.length;i++){const [a,b]=[pts[i],pts[i+1]];const n=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/step);for(let k=0;k<n;k++)o.push([a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n]);}o.push(pts[pts.length-1]);return o;};
// east 500 m, then north 500 m (left), then east 500 m (right)
let xy=line([[0,0],[500,0],[500,500],[1000,500]]), km=1.5;
let sec=[{from:0,to:0.5,road:'A St'},{from:0.5,to:1.0,road:'B St'},{from:1.0,to:1.5,road:'C St'}];
let t=C.computeTurns(xy,km,sec); console.log(t.map(x=>x.km.toFixed(3)+' '+x.type+' '+x.dir+' '+x.angle+' | '+x.text).join('\n'));
ok(t.length===4 && t[0].type==='depart' && /east/.test(t[0].text),'depart heading east');
ok(t[1].type==='turn'&&t[1].dir==='left'&&Math.abs(t[1].km-0.5)<0.02&&t[1].text==='Turn left onto B St','left turn at 0.5');
ok(t[2].type==='turn'&&t[2].dir==='right'&&t[2].text==='Turn right onto C St','right turn at 1.0');
ok(t[3].type==='arrive','arrive');
// U-turn on the same road (hairpin radius 6 m)
const hp=[];for(let x=0;x<=600;x+=2)hp.push([x,0]);for(let a=-90;a<=90;a+=10)hp.push([600+6*Math.cos(a*Math.PI/180),6+6*Math.sin(a*Math.PI/180)]);for(let x=600;x>=0;x-=2)hp.push([x,12]);
t=C.computeTurns(hp,1.2,[{from:0,to:0.6,road:'K Rd'},{from:0.6,to:1.2,road:'K Rd'}]); console.log(t.map(x=>x.km.toFixed(3)+' '+x.type+' '+x.dir+' '+x.angle+' | '+x.text).join('\n'));
ok(t.some(x=>x.type==='uturn'&&x.dir==='left'&&x.text==='Make a U-turn on K Rd'),'U-turn left on same road');
// straight road, name changes -> continue; gentle bend on one road -> no instruction
const bend=line([[0,0],[400,0],[800,120],[1200,120]]);
t=C.computeTurns(bend,1.2,[{from:0,to:0.6,road:'X Rd'},{from:0.6,to:1.2,road:'Y Rd'}]); console.log(t.map(x=>x.km.toFixed(3)+' '+x.type+' '+x.dir+' '+x.angle+' | '+x.text).join('\n'));
ok(t.length===3 && t[1].type==='continue' && t[1].text==='Continue onto Y Rd','continue at name change, bends ignored');
// next index
const tt=[{km:0,type:'depart'},{km:0.5},{km:1.0},{km:1.5,type:'arrive'}];
ok(C.nextTurnIndex(tt,0)===0 && C.nextTurnIndex(tt,0.1)===1 && C.nextTurnIndex(tt,0.5)===1 && C.nextTurnIndex(tt,0.51)===2 && C.nextTurnIndex(tt,1.5)===3,'nextTurnIndex');
ok(C.wrapDeg(190)===-170 && C.wrapDeg(-190)===170 && C.compass(90)==='north' && C.compass(0)==='east','helpers');
// ground under the street view
const d=JSON.parse(fs.readFileSync(__dirname+'/../data/data.json')); const g=C.streetGround(d.elev.km,d.elev.m,21.0975);
const gi=k=>C.interp(g.km,g.m,k), e=k=>C.interp(d.elev.km,d.elev.m,k);
console.log('ground: 1.5 km',gi(1.5).toFixed(1),'elev',e(1.5).toFixed(1),'| 16.25 km',gi(16.25).toFixed(1),'elev',e(16.25).toFixed(1),'-> deck',(e(16.25)-gi(16.25)).toFixed(1),'m above ground | 18.5',(e(18.5)-gi(18.5)).toFixed(1));
ok(e(16.25)-gi(16.25)>14 && e(16.25)-gi(16.25)<22,'Sheares deck well above ground');
let above=0; for(let k=0;k<=21.09;k+=0.01) above=Math.max(above,(k<15.5||k>17.2)?e(k)-gi(k):0); console.log('max height above ground away from Sheares',above.toFixed(1));
// real course
const proj=C.makeProjection(d.origin), rxy=d.route.map(p=>proj.toXY(p[0],p[1]));
const rt=C.computeTurns(rxy,21.0975,d.sections,{finishText:'Finish inside the National Stadium'});
console.log('\nREAL COURSE ('+rt.length+')\n'+rt.map(x=>x.km.toFixed(2).padStart(6)+' '+x.type.padEnd(8)+' '+String(x.angle).padStart(5)+'  '+x.text).join('\n'));
console.log(pass+' checks passed');
