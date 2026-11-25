import json, numpy as np
from PIL import Image, ImageDraw
from skimage.graph import route_through_array
from scipy import ndimage as ndi
import os
IMG=os.environ.get('ROUTE_MAP', 'reference/route-map.jpg')
os.makedirs('build/trace', exist_ok=True)
im=np.asarray(Image.open(IMG)).astype(int)
R,G,B=im[...,0],im[...,1],im[...,2]
# ---------- elevation ----------
Y0,Y40=1753.0,1577.0            # gridline rows for 0 m and 40 m
ppm=(Y0-Y40)/40.0
# vertical gridlines at 5,10,15,20 km: detect in a band free of the profile
band=im[1585:1640,1400:2330]
g=((np.abs(band[...,0]-band[...,1])<30)&(band[...,2]>130)&(band[...,0]>50)).sum(0)
cols=[i+1400 for i,v in enumerate(g) if v>45]
groups=[]
for c in cols:
    if groups and c-groups[-1][-1]<=2: groups[-1].append(c)
    else: groups.append([c])
vx=[float(np.mean(gp)) for gp in groups]
print('vertical gridlines',vx)
KX0=1501.0-5*(2271.0-1501.0)/15.0; PPK=(2271.0-1501.0)/15.0
prof=[]
for x in range(int(KX0)-1,int(KX0+21.2*PPK)+2):
    col=im[1585:1765,x]
    m=(col[:,0]>165)&(col[:,1]<60)&(col[:,2]<90)
    idx=np.nonzero(m)[0]
    if len(idx)==0: continue
    # topmost run
    run=[idx[0]]
    for i in idx[1:]:
        if i-run[-1]<=1: run.append(i)
        else: break
    y=1585+np.mean(run)
    prof.append(((x-KX0)/PPK,(Y0-y)/ppm))
prof=np.array(prof)
prof=prof[(prof[:,0]>=-0.02)&(prof[:,0]<=21.12)]
print('profile pts',len(prof),'km range',prof[0,0],prof[-1,0])
ANCH=[(0,12.0),(1.5,4.7),(3.5,10.3),(7.5,9.2),(11.75,10.9),(13.25,6.2),(16.25,27.9),(18.5,13.0),(21.0975,13.6)]
keep=np.ones(len(prof),bool)
for k,_ in ANCH: keep&=np.abs(prof[:,0]-k)>0.07
prof=np.vstack([prof[keep],np.array(ANCH,float)]); prof=prof[np.argsort(prof[:,0])]
def elev(km): return float(np.interp(km,prof[:,0],prof[:,1]))
for km,ref in [(0,12.0),(1.5,4.7),(3.5,10.3),(7.5,9.2),(11.75,10.9),(13.25,6.2),(16.25,27.9),(18.5,13.0),(21.0975,13.6)]:
    print(f'{km:7.3f} label {ref:5.1f} digitised {elev(km):5.1f}')
# resample 50 m
kms=np.arange(0,21.0975+1e-9,0.05); kms=np.append(kms,21.0975)
ev=np.array([elev(k) for k in kms])
d=np.diff(ev); print('gain',d[d>0].sum(),'loss',-d[d<0].sum(),'min',ev.min(),'max',ev.max(), 'argmax km',kms[ev.argmax()])
json.dump({'km':[round(float(k),4) for k in kms],'m':[round(float(e),2) for e in ev]},open('data/elev_raw.json','w'))
# ---------- route trace ----------
pink=(R>170)&(B>170)&(G<140)&(R-G>90)
core=(R>215)&(B>215)&(G>120)&(G<235)&(R-G>15)   # light core of the line
mask=pink|core
# remove big blobs (km label boxes, START/FINISH boxes)
big=ndi.binary_opening(mask,structure=np.ones((13,13)))
big=ndi.binary_dilation(big,iterations=9)
line=mask&~big
dt=ndi.distance_transform_edt(line)
cost=np.where(line,1.0/(0.5+dt),60.0)
def A(x,y): return (1150+x/2,150+y/2)
def Bc(x,y): return (1500+x/2,150+y/2)
def C(x,y): return (900+x/2,560+y/2)
def D(x,y): return (780+x/2,1050+y/2)
def E(x,y): return (150+x/2,1350+y/2)
def F(x,y): return (1150+x/2,1050+y/2)
WP=[A(485,1290),A(478,1200),A(392,1140),A(400,1000),A(425,860),A(480,775),A(570,760),A(680,670),A(722,590),A(712,545),
 A(645,455),A(550,535),A(405,640),A(440,705),A(260,850),A(35,1055),C(470,330),C(405,440),C(340,580),C(295,740),C(268,925),
 C(225,1040),D(405,190),D(372,238),D(328,215),D(245,300),D(150,480),D(70,600),E(1210,130),E(1060,310),
 E(900,318),E(500,330),E(300,338),E(215,350),E(168,390),E(230,357),E(300,347),E(900,325),E(1050,318),E(1205,140),
 D(72,602),D(152,482),D(247,302),D(326,217),D(372,238),D(605,392),D(740,470),D(838,535),F(330,685),
 F(400,590),F(460,490),F(540,400),F(650,350),F(790,350),F(850,385),F(940,410),F(995,400),F(990,370),F(930,290),F(862,240),
 F(805,340),F(650,342),F(540,395),F(470,480),F(410,568),F(305,548),F(240,548),F(215,560),F(205,580),F(225,598),F(228,612),
 F(100,525),F(150,440),F(215,330),F(300,150),C(818,910),C(825,700),C(870,520),C(860,400),C(800,300),C(755,235),
 A(345,1020),A(405,965),A(425,860),A(480,775),A(475,710),A(540,650),A(700,530),A(880,405),Bc(380,297),Bc(600,283),
 Bc(700,245),Bc(800,215),Bc(900,232),Bc(1015,300),Bc(1020,330),Bc(940,400),Bc(850,450),Bc(770,465),Bc(730,440),
 Bc(697,375),Bc(700,320),Bc(688,303),Bc(672,320),Bc(640,318),Bc(640,345),Bc(598,395)]
def snap(p,r=12):
    x,y=int(round(p[0])),int(round(p[1]))
    ys,xs=np.nonzero(line[y-r:y+r+1,x-r:x+r+1])
    if len(xs)==0: return (x,y),None
    d=(xs-r)**2+(ys-r)**2; i=d.argmin()
    return (x-r+int(xs[i]),y-r+int(ys[i])),float(d[i])**.5
pts=[]; 
for i,p in enumerate(WP):
    q,d=snap(p)
    if d is None or d>8: print('wp',i,p,'snap',q,d)
    pts.append(q)
path=[]
for a,b in zip(pts[:-1],pts[1:]):
    x0=min(a[0],b[0])-40; x1=max(a[0],b[0])+41; y0=min(a[1],b[1])-40; y1=max(a[1],b[1])+41
    sub=cost[y0:y1,x0:x1]
    idx,c=route_through_array(sub,(a[1]-y0,a[0]-x0),(b[1]-y0,b[0]-x0),fully_connected=True,geometric=True)
    seg=[(x+x0,y+y0) for y,x in idx]
    off=sum(1 for x,y in seg if not line[y,x])
    if off>12: print('seg',len(path),a,b,'off-mask px',off,'len',len(seg))
    path+=seg if not path else seg[1:]
path=np.array(path,float)
# smooth + thin
from scipy.ndimage import uniform_filter1d
sm=np.column_stack([uniform_filter1d(path[:,0],9,mode='nearest'),uniform_filter1d(path[:,1],9,mode='nearest')])
sm[0]=path[0]; sm[-1]=path[-1]
L=np.concatenate([[0],np.cumsum(np.hypot(*np.diff(sm,axis=0).T))])
print('path px',len(path),'length px',L[-1])
np.save('data/path_px.npy',sm)
big_im=Image.open(IMG).convert('RGB'); dr=ImageDraw.Draw(big_im)
dr.line([tuple(p) for p in sm],fill=(255,255,0),width=2)
for i,p in enumerate(pts): dr.ellipse([p[0]-3,p[1]-3,p[0]+3,p[1]+3],outline=(0,255,0))
# ticks every 1/21.0975 of length
for k in range(0,22):
    s=k/21.0975*L[-1]; j=np.searchsorted(L,s); x,y=sm[min(j,len(sm)-1)]
    dr.ellipse([x-6,y-6,x+6,y+6],outline=(255,255,255),width=2); dr.text((x+8,y-14),str(k),fill=(255,255,0))
big_im.save('build/trace/overlay.png')
for name,b in {'o1':(1150,150,2150,900),'o2':(850,560,1750,1460),'o3':(150,1100,1050,1700)}.items():
    c=big_im.crop(b); c=c.resize((int(c.width*1.5),int(c.height*1.5)),Image.LANCZOS); c.save(f'build/trace/{name}.png')
