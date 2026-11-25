import json, base64, io, numpy as np
from PIL import Image
from scipy import ndimage as ndi
exec(open('scripts/georef.py').read().split("names=list(CP)")[0])   # LAT0.. CP, ll2m
import os
IMG=os.environ.get('ROUTE_MAP', 'reference/route-map.jpg')
os.makedirs('build', exist_ok=True)
COURSE_KM=21.0975
names=[n for n in CP if n!='barrage']
P=np.array([CP[n][:2] for n in names]); M=np.array([ll2m(*CP[n][2:]) for n in names])
# axis-aligned fit: X = s*px + tx ; Y = -s*py + ty
A=[];y=[]
for (px,py),(X,Y) in zip(P,M):
    A.append([px,1,0]); y.append(X); A.append([-py,0,1]); y.append(Y)
(s,tx,ty),*_=np.linalg.lstsq(np.array(A),np.array(y),rcond=None)
res=np.column_stack([s*P[:,0]+tx,-s*P[:,1]+ty])-M
print('axis-aligned scale',s,'rms',np.sqrt((res**2).sum(1).mean()),'max',np.hypot(*res.T).max())
def px2m(p): p=np.atleast_2d(p); return np.column_stack([s*p[:,0]+tx,-s*p[:,1]+ty])
def m2ll(xy): xy=np.atleast_2d(xy); return np.column_stack([LAT0+xy[:,1]/MLAT, LON0+xy[:,0]/MLON])
# ---- route
path=np.load('data/path_px.npy'); XY=px2m(path)
def resample(XY,step):
    L=np.concatenate([[0],np.cumsum(np.hypot(*np.diff(XY,axis=0).T))]); t=np.arange(0,L[-1],step); t=np.append(t,L[-1])
    return np.column_stack([np.interp(t,L,XY[:,0]),np.interp(t,L,XY[:,1])])
r=resample(XY,3.0)
k=9; ker=np.ones(k)/k
sm=np.column_stack([np.convolve(np.pad(r[:,i],(k//2,k//2),mode='edge'),ker,mode='valid') for i in (0,1)])
sm[0]=r[0]; sm[-1]=r[-1]
def dp(pts,eps):
    keep=np.zeros(len(pts),bool); keep[0]=keep[-1]=True; st=[(0,len(pts)-1)]
    while st:
        a,b=st.pop()
        if b<=a+1: continue
        ab=pts[b]-pts[a]; n=np.hypot(*ab)
        w=pts[a+1:b]-pts[a]
        d=np.abs(ab[0]*w[:,1]-ab[1]*w[:,0])/n if n>0 else np.hypot(*(pts[a+1:b]-pts[a]).T)
        i=d.argmax()
        if d[i]>eps: keep[a+1+i]=True; st+= [(a,a+1+i),(a+1+i,b)]
    return pts[keep]
simp=dp(sm,1.5)
# Remove trace defects: out-and-back spurs and carriageway hooks. A vertex that turns back by more than
# 120 deg starts a candidate; if the path's heading returns to within 70 deg of the incoming heading within
# the next 90 m, the excursion is cut out. Genuine U-turns never return, so they are kept.
def despur(p):
    def turn(i):
        a=p[i]-p[i-1]; b=p[i+1]-p[i]
        return (math.degrees(math.atan2(b[1],b[0])-math.atan2(a[1],a[0]))+180)%360-180
    import math
    keep=np.ones(len(p),bool); removed=[]; i=1
    Lp=np.concatenate([[0],np.cumsum(np.hypot(*np.diff(p,axis=0).T))])
    while i<len(p)-1:
        t=turn(i)
        if abs(t)>120:
            cum=t; m=None
            for j in range(i+1,len(p)-1):
                if Lp[j]-Lp[i]>90: break
                cum+=turn(j)
                if abs(cum)<70: m=j; break
            if m is not None:
                keep[i:m+1]=False
                removed.append((Lp[i-1], Lp[m+1]-Lp[i-1]-math.hypot(*(p[m+1]-p[i-1]))))
                print(f'despur: cut {m-i+1} vertices after {Lp[i-1]:.0f} m, saved {removed[-1][1]:.1f} m')
                i=m+1; continue
        i+=1
    return p[keep], removed
def unzig(p):
    # opposite-sign kinks closer than 20 m that mostly cancel are lane jumps in the trace: replace the pair by its midpoint
    import math
    out=[p[0]]; i=1; n=0
    def turn(a,b,c):
        u=b-a; v=c-b; return (math.degrees(math.atan2(v[1],v[0])-math.atan2(u[1],u[0]))+180)%360-180
    while i<len(p)-1:
        if i+1<len(p)-1:
            t1=turn(out[-1],p[i],p[i+1]); t2=turn(p[i],p[i+1],p[i+2])
            if np.hypot(*(p[i+1]-p[i]))<20 and t1*t2<0 and min(abs(t1),abs(t2))>25 and abs(t1+t2)<max(abs(t1),abs(t2)):
                out.append((p[i]+p[i+1])/2); i+=2; n+=1; continue
        out.append(p[i]); i+=1
    out.append(p[-1]); return np.array(out),n
OLD_SIMP=simp.copy()
for _ in range(4):
    simp,REMOVED=despur(simp)
    simp,nz=unzig(simp)
    if not REMOVED and not nz: break
    print('clean-up pass: cuts',len(REMOVED),'zigzags',nz)
L=np.concatenate([[0],np.cumsum(np.hypot(*np.diff(simp,axis=0).T))])
print('route pts',len(simp),'trace length m',L[-1],'ratio to certified',L[-1]/(COURSE_KM*1000))
L_OLDV=np.concatenate([[0],np.cumsum(np.hypot(*np.diff(OLD_SIMP,axis=0).T))])
def KM(k_old):
    # course km on the uncleaned trace -> course km on the cleaned one: find the same spot on the new line,
    # searching near the proportional position so out-and-back legs are not confused
    if k_old<=0: return 0.0
    if k_old>=COURSE_KM: return COURSE_KM
    d=k_old/COURSE_KM*L_OLDV[-1]
    q=np.array([np.interp(d,L_OLDV,OLD_SIMP[:,0]),np.interp(d,L_OLDV,OLD_SIMP[:,1])])
    exp=d*L[-1]/L_OLDV[-1]; best=(1e9,exp)
    for i in range(len(simp)-1):
        if abs(L[i]-exp)>300 and abs(L[i+1]-exp)>300: continue
        a_,b_=simp[i],simp[i+1]; u=b_-a_; l2=u@u
        t=0 if l2==0 else max(0,min(1,(q-a_)@u/l2)); pt=a_+u*t; dd=np.hypot(*(q-pt))+0.02*abs(L[i]+t*np.sqrt(l2)-exp)
        if dd<best[0]: best=(dd,L[i]+t*np.sqrt(l2))
    return round(best[1]/L[-1]*COURSE_KM,3)
ll=m2ll(simp)
# km of some pixel points (for sections / checks)
def km_of_px(px,py,after=0.0):
    q=px2m([(px,py)])[0]; d=np.hypot(*(simp-q).T); kmv=L/L[-1]*COURSE_KM
    d=np.where(kmv>=after,d,1e9); i=d.argmin(); return round(float(kmv[i]),2), round(float(d[i]),1)
import sys
if 'probe' in sys.argv:
    def A_(x,y): return (1150+x/2,150+y/2)
    def B_(x,y): return (1500+x/2,150+y/2)
    def C_(x,y): return (900+x/2,560+y/2)
    def D_(x,y): return (780+x/2,1050+y/2)
    def E_(x,y): return (150+x/2,1350+y/2)
    def F_(x,y): return (1150+x/2,1050+y/2)
    probes=[('join Republic Blvd',A_(392,1140),0),('Republic Ave jn',A_(480,775),0),('Nicoll/Crawford',A_(712,545),0),('Crawford/Beach',A_(645,455),0),('Beach/Java',A_(405,640),0),('Java/Nicoll',A_(440,705),0),
     ('Esplanade Dr start (Raffles Ave)',C_(330,610),0),('Fullerton Rd',C_(268,925),0),('Collyer/Marina Blvd',D_(372,238),0),('Robinson start',D_(328,215),0),('Anson/Keppel',E_(1060,310),0),('U-turn',E_(168,390),0),
     ('Anson/Keppel back',E_(1050,318),7.6),('Robinson end back',D_(326,217),7.6),('Marina Blvd start',D_(372,238),7.6),('MBlvd/Sheares Ave out',D_(838,535),7.6),('MBlvd/MGD',F_(330,685),7.6),('MGD split E',F_(790,350),7.6),('Barrage',F_(995,400),7.6),
     ('loop north tip',F_(862,240),7.6),('MGD rejoin',F_(805,340),13.3),('leave MGD west',F_(410,568),13.3),('rejoin MBlvd',F_(228,612),13.3),('Sheares Ave turn',F_(100,525),14.4),('bridge crest?',C_(818,910),14.4),('ECP exit loop tip',C_(755,235),14.4),
     ('merge Republic Blvd',A_(405,965),16.5),('Republic Ave jn 2',A_(480,775),16.5),('join Nicoll',A_(540,650),16.5),('Merdeka',A_(880,405),16.5),('Mountbatten start',B_(700,245),16.5),('Mountbatten/Stadium Blvd',B_(1015,300),16.5),('Stadium Blvd/Dr',B_(770,465),16.5),('Stadium Dr top',B_(688,303),16.5),('finish',B_(598,395),16.5)]
    for n,p,a in probes: print(f'{n:34s}',km_of_px(*p,after=a))
json.dump({'s':float(s),'tx':float(tx),'ty':float(ty),'L':float(L[-1])},open('build/fit.json','w'))
np.save('build/route_m.npy',simp); np.save('build/route_ll.npy',ll)
# ---------------- basemap from the reference image (roads / water / land only) ----------------
im=np.asarray(Image.open(IMG)).astype(int); R,G,B=im[...,0],im[...,1],im[...,2]
dark=(R<50)&(G<60)
road=dark&(B>222); water=dark&(B>135)&(B<=222); land=dark&(B<=135)
pinkm=(R>170)&(B>170)&(G<140)
water=ndi.binary_opening(water,structure=np.ones((5,5)))
cls=np.full(B.shape,255,np.uint8); cls[land]=0; cls[water]=1; cls[road|pinkm]=2
# halo pixels between land and road that are no longer water -> unknown -> nearest fill
unk=cls==255
idx=ndi.distance_transform_edt(unk,return_distances=False,return_indices=True)
cls=cls[idx[0],idx[1]]
cls=ndi.median_filter(cls,size=3)
# label boxes (big pink blobs) -> refill from surroundings
bigp=ndi.binary_dilation(ndi.binary_opening(ndi.binary_closing(pinkm,structure=np.ones((9,9))),structure=np.ones((13,13))),iterations=16)
white=(R>150)&(G>150)&(B>150); bigw=ndi.binary_dilation(ndi.binary_opening(white,structure=np.ones((9,9))),iterations=10)
def nearest_fill(c,unk):
    i=ndi.distance_transform_edt(unk,return_distances=False,return_indices=True); return c[i[0],i[1]]
cls=nearest_fill(cls,bigp|bigw)
H_,W_=B.shape; yy,xx=np.mgrid[0:H_,0:W_]
edge=np.clip(np.minimum.reduce([xx,yy,W_-1-xx,H_-1-yy])/(0.07*W_),0,1)
keep=np.ones(B.shape,float)
for (x0,y0,x1,y1) in [(0,80,990,490),(40,500,700,1010),(1170,1450,2424,2023),(40,1900,1100,2023),(440,1560,810,1690)]:
    keep[max(0,y0-10):y1+10,max(0,x0-10):x1+10]=0
keep=ndi.gaussian_filter(keep,18)
alpha=(np.clip(edge*keep,0,1)*255).astype(np.uint8)
PAL={0:(7,12,46),1:(12,34,92),2:(46,74,170)}
rgb=np.zeros(B.shape+(4,),np.uint8)
for k,c in PAL.items(): rgb[cls==k,:3]=c
rgb[...,3]=alpha
oh=np.zeros(B.shape+(4,),np.uint8); oh[cls==2,0]=255; oh[cls==1,1]=255; oh[cls==0,2]=255; oh[...,3]=alpha
for W_ in (1616,):
    o=Image.fromarray(oh,'RGBA').resize((W_,round(W_*B.shape[0]/B.shape[1])),Image.LANCZOS)
    a=np.asarray(o).astype(np.int32); a[...,:3]=(a[...,:3]//32)*32+np.where(a[...,:3]>=224,31,0); a[...,3]=(a[...,3]//8)*8
    o=Image.fromarray(np.clip(a,0,255).astype(np.uint8),'RGBA'); buf=io.BytesIO(); o.save(buf,'PNG',optimize=True)
    open('data/basemap_cls.png','wb').write(buf.getvalue()); print('class texture',o.size,'bytes',len(buf.getvalue()))
bm=Image.fromarray(rgb,'RGBA').resize((1212,1012),Image.LANCZOS)
bm.save('build/basemap.png',optimize=True)
q=bm.quantize(colors=24,method=Image.Quantize.FASTOCTREE); buf=io.BytesIO(); q.save(buf,'PNG',optimize=True)
open('data/basemap_q.png','wb').write(buf.getvalue()); print('basemap bytes',len(buf.getvalue()))
W,H=im.shape[1],im.shape[0]
c0=px2m([(0,0)])[0]; c1=px2m([(W,H)])[0]   # top-left, bottom-right in metres
# ---------------- landmarks (pointer tips on the reference map) ----------------
LM=[('F1 Pit Building','start',(1381,834),'Flag-off at 4:30 am from the pit straight.'),
 ('Singapore Flyer','landmark',(1392.5,917.5),'Observation wheel beside the start area.'),
 ('Suntec City','landmark',(1214,730),'Passed on Nicoll Highway around 3.5 km.'),
 ('War Memorial Park','landmark',(1062.5,791),'Civilian War Memorial, west of the course near 3.5 km.'),
 ('Esplanade','landmark',(1087.5,896),'Theatres on the bay, beside Esplanade Drive near 4 km.'),
 ('Merlion','landmark',(1059,1012.5),'Merlion Park, just after the Esplanade Bridge.'),
 ('Marina Bay Sands','landmark',(1236,1097.5),'Across the bay from the course; seen from Marina Boulevard and Sheares Avenue.'),
 ('Lau Pa Sat','landmark',(916,1232.5),'Hawker centre beside Robinson Road; passed at about 5 km and again at 10 km.'),
 ('Former Tanjong Pagar Railway Station','landmark',(495,1499),'On Keppel Road near 7 km outbound and 8 km on the way back.'),
 ('Singapore Art Museum','landmark',(417.5,1544),'At Tanjong Pagar Distripark, close to the Keppel Road U-turn.'),
 ('Gardens by the Bay','landmark',(1393.5,1176),'The course loops round the gardens on Marina Gardens Drive, 12 to 14.5 km.'),
 ('Marina Barrage','landmark',(1652.5,1239),'Easternmost point of the course at 13.25 km; lowest point after Crawford Junction.'),
 ('Benjamin Sheares Bridge','climb',(1320,954),'Highest point of the course: 27.9 m at 16.25 km.'),
 ('Merdeka Bridge','landmark',(1567.5,365),'Nicoll Highway crossing of the Kallang Basin at 18.5 km.'),
 ('Old Kallang Airport','landmark',(1731,241),'Conserved terminal north of Nicoll Highway near 19.5 km.'),
 ('National Stadium','finish',(1766,373.5),'Finish line inside the stadium at The Kallang.')]
kmv=L/L[-1]*COURSE_KM
lms=[]
for n,kind,px,blurb in LM:
    xy=px2m([px])[0]; d=np.hypot(*(simp-xy).T); i=int(d.argmin()); lat,lon=m2ll([xy])[0]
    lms.append({'name':n,'kind':kind,'lat':round(float(lat),6),'lon':round(float(lon),6),'blurb':blurb,'nearKm':round(float(kmv[i]),2),'nearM':int(round(float(d[i])))})
SECTIONS=[(0,0.30,'F1 pit straight','Start line beside the F1 Pit Building.',0),
 (0.30,0.83,'Republic Boulevard','North from the pit area.',0),
 (0.83,1.47,'Republic Avenue','Along the Kallang Basin waterfront.',0),
 (1.47,1.64,'Crawford Street','Crawford Junction is the low point of the first half: 4.7 m at 1.5 km.',0),
 (1.64,2.10,'Beach Road','South-west along Beach Road.',0),
 (2.10,2.22,'Java Road','Short link down to Nicoll Highway.',0),
 (2.22,3.73,'Nicoll Highway','Past Suntec City and War Memorial Park.',0),
 (3.73,4.20,'Esplanade Drive','Over the Esplanade Bridge.',0),
 (4.20,4.77,'Fullerton Road and Collyer Quay','Past the Merlion.',0),
 (4.77,5.70,'Robinson Road','Through the financial district, past Lau Pa Sat.',0),
 (5.70,6.15,'Anson Road','Down to Keppel Road.',1),
 (6.15,7.54,'Keppel Road (westbound)','Out to the U-turn at 7.5 km.',0),
 (7.54,8.93,'Keppel Road (eastbound)','Back past the former railway station.',0),
 (8.93,9.40,'Anson Road','Return leg.',1),
 (9.40,10.45,'Robinson Road','Return leg, Lau Pa Sat at about 10 km.',0),
 (10.45,11.81,'Marina Boulevard','South-east through Marina Bay to the gardens.',0),
 (11.81,12.78,'Marina Gardens Drive','Round the south side of Gardens by the Bay.',0),
 (12.78,13.68,'Marina Barrage loop','Out to the barrage at 13.25 km and back along the waterfront.',1),
 (13.68,14.45,'Marina Gardens Drive','Return leg on the opposite carriageway.',0),
 (14.45,14.83,'Gardens by the Bay service road','Cut-through west to Marina Boulevard.',1),
 (14.83,15.06,'Marina Boulevard','Short stretch north-west.',0),
 (15.06,17.00,'Sheares Avenue and Benjamin Sheares Bridge','The climb: 27.9 m at 16.25 km.',0),
 (17.00,17.47,'ECP exit ramp','Off the bridge and round to Republic Boulevard.',1),
 (17.47,17.95,'Republic Boulevard','North to Nicoll Highway.',0),
 (17.95,19.50,'Nicoll Highway','Over Merdeka Bridge at 18.5 km.',0),
 (19.50,20.06,'Mountbatten Road','East past the stadium precinct.',0),
 (20.06,20.55,'Stadium Boulevard','Back west towards the stadium.',0),
 (20.55,21.0975,'Stadium Drive to the finish','Into the National Stadium.',0)]
# road name used in turn instructions and signs ('the ...' for names that are not street names)
ROAD={'F1 pit straight':'the F1 pit straight','Fullerton Road and Collyer Quay':'Fullerton Road','Keppel Road (westbound)':'Keppel Road',
 'Keppel Road (eastbound)':'Keppel Road','Marina Barrage loop':'the Marina Barrage loop','Gardens by the Bay service road':'the Gardens by the Bay service road',
 'Sheares Avenue and Benjamin Sheares Bridge':'Sheares Avenue','ECP exit ramp':'the ECP exit ramp','Stadium Drive to the finish':'Stadium Drive'}
el=json.load(open('data/elev_raw.json'))
data={'meta':{'name':'adidas Half Marathon','event':'BYD Singapore International Marathon 2026','date':'2026-12-05','flagOff':'04:30','cutOff':'3:45:00','courseKm':COURSE_KM,
  'elevGain':68.3,'elevLoss':66.7,'source':'Traced from the organiser\'s route map dated 17 August 2026','traceLengthM':round(float(L[-1]),1)},
 'origin':{'lat':LAT0,'lon':LON0,'mPerDegLat':MLAT,'mPerDegLon':round(float(MLON),3)},
 'route':[[round(float(a),6),round(float(b),6)] for a,b in ll],
 'elev':{'km':el['km'],'m':el['m']},
 'elevAnchors':[[0,12.0,'F1 Pit'],[1.5,4.7,'Crawford Junction'],[3.5,10.3,'Suntec City / War Memorial'],[7.5,9.2,'Keppel Road U-turn'],[11.75,10.9,'Gardens by the Bay (outbound)'],[13.25,6.2,'Marina Barrage'],[16.25,27.9,'Sheares Bridge'],[18.5,13.0,'Merdeka Bridge'],[21.0975,13.6,'National Stadium']],
 'landmarks':lms,
 'sections':[{'from':KM(a),'to':KM(b),'name':n,'road':ROAD.get(n,n),'note':t,'inferred':bool(i)} for a,b,n,t,i in SECTIONS],
 'basemap':{'x0':round(float(c0[0]),1),'y0':round(float(c1[1]),1),'x1':round(float(c1[0]),1),'y1':round(float(c0[1]),1)}}
json.dump(data,open('data/data.json','w'),separators=(',',':'))
print('data.json bytes',len(open('data/data.json').read()),'landmarks',[(l['name'],l['nearKm'],l['nearM']) for l in lms])
print('basemap extents m',data['basemap'])
