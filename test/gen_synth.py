"""Synthetic Overpass response: the traced route, deliberately mis-registered, turned into fake OSM ways
with dual carriageways, parallel distractor roads, cross streets, footways and a gap."""
import json, math, random, numpy as np
random.seed(7); rng=np.random.default_rng(7)
d=json.load(open('data/data.json')); o=d['origin']
ll=np.array(d['route']); xy=np.column_stack([(ll[:,1]-o['lon'])*o['mPerDegLon'],(ll[:,0]-o['lat'])*o['mPerDegLat']])
SC,ROT,SH=0.985,math.radians(0.4),np.array([38.0,-27.0])
c,s=math.cos(ROT)*SC,math.sin(ROT)*SC
true=np.column_stack([c*xy[:,0]-s*xy[:,1],s*xy[:,0]+c*xy[:,1]])+SH
def resample(p,step):
    L=np.concatenate([[0],np.cumsum(np.hypot(*np.diff(p,axis=0).T))]); t=np.arange(0,L[-1],step); t=np.append(t,L[-1])
    return np.column_stack([np.interp(t,L,p[:,0]),np.interp(t,L,p[:,1])]),t
tr,t=resample(true,12.0)
def normals(p):
    g=np.gradient(p,axis=0); n=np.hypot(*g.T); n[n==0]=1; return np.column_stack([-g[:,1]/n,g[:,0]/n])
N=normals(tr)
els=[]; wid=[1000]
def way(pts,hw,name=''):
    wid[0]+=1
    els.append({'type':'way','id':wid[0],'tags':{'highway':hw,**({'name':name} if name else {})},
      'geometry':[{'lat':o['lat']+y/o['mPerDegLat'],'lon':o['lon']+x/o['mPerDegLon']} for x,y in pts]})
GAP=(13000,13350)   # metres along the true route with no roads at all
i=0; k=0
while i<len(tr)-1:
    n=random.randint(12,32); j=min(len(tr)-1,i+n); seg=slice(i,j+1); mid=t[(i+j)//2]
    if not (GAP[0]<mid<GAP[1]):
        if random.random()<0.6:
            way(tr[seg]+8*N[seg],'primary',f'Road {k} A'); way((tr[seg]-8*N[seg])[::-1],'primary',f'Road {k} B')
        else: way(tr[seg],'secondary',f'Road {k}')
        if random.random()<0.5: way(tr[seg]+random.choice([-1,1])*75*N[seg],'tertiary',f'Parallel {k}')
        if random.random()<0.4: way(tr[seg]+random.choice([-1,1])*14*N[seg],'footway')
        for m in range(i,j,17):
            way(np.array([tr[m]-150*N[m],tr[m]+150*N[m]]),'residential',f'Cross {k}-{m}')
    i=j; k+=1
els.append({'type':'way','id':5,'tags':{'highway':'steps'},'geometry':[{'lat':1.29,'lon':103.86},{'lat':1.2901,'lon':103.8601}]})
els.append({'type':'node','id':6,'lat':1.29,'lon':103.86})
els.append({'type':'way','id':7,'tags':{'highway':'service'},'geometry':[{'lat':1.29,'lon':103.86}]})
json.dump({'version':0.6,'elements':els},open('test/synth_overpass.json','w'))
json.dump({'true':tr.tolist(),'t':t.tolist(),'gap':GAP,'scale':SC,'rotDeg':0.4,'shift':SH.tolist()},open('test/synth_truth.json','w'))
print('ways',len(els))
