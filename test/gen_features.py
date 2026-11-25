"""Run from the repo root: python3 test/gen_features.py
Synthetic Overpass response for buildings/trees/parks along the real course (the live server is not
reachable from the test machine). Rows of non-overlapping blocks on both sides, a few deliberately on the
course (must be culled), one tower made of building:part ways, trees and park polygons."""
import json, math, random
random.seed(11)
d=json.load(open('data/data.json')); o=d['origin']
ll=d['route']; xy=[((b-o['lon'])*o['mPerDegLon'],(a-o['lat'])*o['mPerDegLat']) for a,b in ll]
def toll(x,y): return {'lat':round(o['lat']+y/o['mPerDegLat'],7),'lon':round(o['lon']+x/o['mPerDegLon'],7)}
L=[0]
for i in range(1,len(xy)): L.append(L[-1]+math.dist(xy[i-1],xy[i]))
def at(s):
    i=max(0,min(len(L)-2,next((k for k in range(len(L)-1) if L[k+1]>=s),len(L)-2))); t=(s-L[i])/max(1e-9,L[i+1]-L[i])
    x=xy[i][0]+(xy[i+1][0]-xy[i][0])*t; y=xy[i][1]+(xy[i+1][1]-xy[i][1])*t; dx=xy[i+1][0]-xy[i][0]; dy=xy[i+1][1]-xy[i][1]; n=math.hypot(dx,dy) or 1
    return x,y,dx/n,dy/n
els=[]; wid=[500000]; occ={}
def free(x,y):
    k=(int(x//40),int(y//40))
    for i in (-1,0,1):
        for j in (-1,0,1):
            for (px,py) in occ.get((k[0]+i,k[1]+j),[]):
                if math.hypot(px-x,py-y)<38: return False
    return True
def take(x,y): occ.setdefault((int(x//40),int(y//40)),[]).append((x,y))
def rect(cx,cy,tx,ty,w,dpt,tags,kind='building'):
    nx,ny=ty,-tx; c=[]
    for a,b in ((-1,-1),(1,-1),(1,1),(-1,1)): c.append((cx+tx*w/2*a+nx*dpt/2*b, cy+ty*w/2*a+ny*dpt/2*b))
    if random.random()<0.5: c=c[::-1]                 # mixed winding, as in OSM
    wid[0]+=1; g=[toll(*p) for p in c]; g.append(g[0])
    els.append({'type':'way','id':wid[0],'tags':tags,'geometry':g})
# rows of blocks; course points sampled every 30 m; skip spots within 22 m of any other leg
def near_course(x,y,lim):
    return any(math.hypot(x-px,y-py)<lim for px,py in xy[::2])
kinds=[('apartments',{'building':'apartments'}),('office',{'building':'office'}),('commercial',{'building':'commercial'}),('yes',{'building':'yes'}),('school',{'building':'school'})]
s=0; nb=0
while s<L[-1]:
    x,y,tx,ty=at(s)
    for side in (-1,1):
        for off in (30,66,104):
            if random.random()<0.35: continue
            cx=x+side*off*ty; cy=y-side*off*tx
            if not free(cx,cy) or near_course(cx,cy,24): continue
            k,tg=random.choice(kinds); tg=dict(tg); r=random.random()
            if r<0.45: tg['building:levels']=str(random.choice([4,6,10,12,13,16,25,32,40]))
            elif r<0.6: tg['height']=f"{random.randint(8,120)} m"
            take(cx,cy); rect(cx,cy,tx,ty,random.uniform(12,24),random.uniform(12,24),tg); nb+=1
    s+=30
# blocks sitting on the course (the viewer must leave these out)
on=[]
for s in (2300,8000,15000):
    x,y,tx,ty=at(s); rect(x,y,tx,ty,20,20,{'building':'office','building:levels':'8'}); on.append(wid[0])
# a tower outline with two parts (outline must be replaced by its parts)
x,y,tx,ty=at(4000); cx=x+80*ty; cy=y-80*tx
rect(cx,cy,tx,ty,30,30,{'building':'office','height':'150'}); outline=wid[0]
rect(cx,cy,tx,ty,30,30,{'building:part':'yes','height':'40'}); rect(cx,cy,tx,ty,14,14,{'building:part':'yes','height':'150','min_height':'40'})
# trees and parks
for s in range(0,int(L[-1]),25):
    if 9000<s<12000 or 12500<s<14500:
        x,y,tx,ty=at(s); px,py=x+9*ty,y-9*tx; els.append({'type':'node','id':900000+s,'lat':toll(px,py)['lat'],'lon':toll(px,py)['lon'],'tags':{'natural':'tree'}})
for s in (12600,13300):
    x,y,tx,ty=at(s); rect(x+120*ty,y-120*tx,tx,ty,160,110,{'leisure':'park'})
json.dump({'version':0.6,'elements':els},open('test/synth_features.json','w'))
json.dump({'onCourse':on,'outline':outline,'blocks':nb},open('test/synth_features_meta.json','w'))
print('elements',len(els),'blocks',nb,'on-course',on,'outline',outline)
