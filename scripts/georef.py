import numpy as np, json
LAT0,LON0=1.2900,103.8600
MLAT=110574.0; MLON=111320.0*np.cos(np.radians(LAT0))
def ll2m(lat,lon): return ((lon-LON0)*MLON,(lat-LAT0)*MLAT)
CP={ # name: (px,py, lat,lon)
 'flyer':(1382.5,912.5,1.289299,103.863137),
 'stadium':(1766,373.5,1.304405,103.874339),
 'merlion':(1059,1002.5,1.286789,103.854501),
 'laupasat':(911,1227.5,1.280671,103.850435),
 'tprs':(501.5,1494,1.272778,103.838056),
 'warmem':(1065,791,1.292911,103.854811),
 'fountain':(1211,721,1.29458,103.85894),
 'oldkallang':(1730,254,1.3075,103.8733),
 'concourse':(1342.5,502.5,1.3011,103.8622),
 'pit':(1381,837.5,1.2915,103.8640),
 'barrage':(1642,1242,1.28056,103.87139),
}
names=list(CP); P=np.array([CP[n][:2] for n in names]); M=np.array([ll2m(*CP[n][2:]) for n in names])
def fit_sim(P,M):
    # M = s*Rot*[px,-py] + t  -> linear in a,b: X=a*px+b*py+tx ; Y=b*px-a*py+ty  (north-up => b~0)
    A=[];y=[]
    for (px,py),(X,Y) in zip(P,M):
        A.append([px,py,1,0]); y.append(X)
        A.append([-py,px,0,1]); y.append(Y)
    sol,*_=np.linalg.lstsq(np.array(A),np.array(y),rcond=None); return sol
def apply(sol,P):
    a,b,tx,ty=sol; P=np.atleast_2d(P)
    return np.column_stack([a*P[:,0]+b*P[:,1]+tx, b*P[:,0]-a*P[:,1]+ty])
sol=fit_sim(P,M)
res=apply(sol,P)-M
print('scale m/px',np.hypot(sol[0],sol[1]),'rot deg',np.degrees(np.arctan2(sol[1],sol[0])))
for n,r in zip(names,res): print(f'{n:10s} dx {r[0]:7.1f} dy {r[1]:7.1f} |{np.hypot(*r):6.1f}')
# leave-one-out
for i,n in enumerate(names):
    k=[j for j in range(len(names)) if j!=i]; s2=fit_sim(P[k],M[k]); e=apply(s2,P[i])[0]-M[i]
    print('LOO',n,round(float(np.hypot(*e)),1),'scale',round(float(np.hypot(s2[0],s2[1])),4))
path=np.load('data/path_px.npy'); XY=apply(sol,path)
L=np.concatenate([[0],np.cumsum(np.hypot(*np.diff(XY,axis=0).T))]); print('route length m by landmark fit',L[-1])
np.save('build/sol.npy',sol)
