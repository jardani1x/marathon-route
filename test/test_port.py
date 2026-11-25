import importlib.util, json, sys, subprocess
spec=importlib.util.spec_from_file_location('sg','blender/sgim26_half_marathon_blender.py'); sg=importlib.util.module_from_spec(spec); spec.loader.exec_module(sg)
trace=[sg.to_xy(a,b) for a,b in sg.DATA['route']]
ways=sg.parse_overpass(json.load(open('test/synth_overpass.json')))
r=sg.snap_to_roads(trace,ways,course_m=21097.5); st=r['stats']
js=json.loads(subprocess.check_output(['node','-e',"const C=require('./src/core.js'),fs=require('fs');const d=JSON.parse(fs.readFileSync('data/data.json'));const p=C.makeProjection(d.origin);const r=C.snapToRoads(d.route.map(q=>p.toXY(q[0],q[1])),C.parseOverpass(JSON.parse(fs.readFileSync('test/synth_overpass.json')),p),{courseM:21097.5});console.log(JSON.stringify({s:r.stats,n:r.xy.length,T:r.T,first:r.xy[0],last:r.xy[r.xy.length-1]}))"]))
print('py',{k:(round(v,4) if isinstance(v,float) else v) for k,v in st.items() if k!='roadNames'},len(r['xy']))
print('js',{k:(round(v,4) if isinstance(v,float) else v) for k,v in js['s'].items() if k!='roadNames'},js['n'])
assert r['ok'] and len(ways)==js['s']['ways']
for k in ('matched','shiftM','scale','rotDeg','lengthM','traceLengthM'): assert abs(st[k]-js['s'][k])<1e-6*max(1,abs(st[k])), k
assert len(r['xy'])==js['n'] and abs(r['xy'][-1][0]-js['last'][0])<1e-6
assert not sg.snap_to_roads(trace,[])['ok'] and sg.parse_overpass(None)==[] and sg.parse_overpass({'elements':[{'type':'way'}]})==[]
q=sg.build_overpass_query([sg.to_ll(*p) for p in trace[:3]],90)
print('python port matches JS; query head:',q[:70])
# pacing parity with the viewer
js=json.loads(subprocess.check_output(['node','-e',"const C=require('./src/core.js'),d=JSON.parse(require('fs').readFileSync('data/data.json'));const o={};for(const m of ['even','effort']){const p=C.buildPacing(d.elev.km,d.elev.m,21.0975,6300,m);o[m]=[1,5,10,16,16.25,17,21.0975].map(k=>C.timeAtKm(p,k));}console.log(JSON.stringify(o))"]))
for m in ('even','effort'):
    km,t=sg.build_pacing(6300,m); py=[sg.interp(km,t,k) for k in (1,5,10,16,16.25,17,21.0975)]
    assert all(abs(a-b)<1e-6 for a,b in zip(py,js[m])), (m,py,js[m])
assert sg.parse_time('1:45:00')==6300
print('pacing matches JS')
