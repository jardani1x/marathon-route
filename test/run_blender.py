import bpy, runpy, math, os
bpy.ops.wm.read_factory_settings(use_empty=True)
ns=runpy.run_path('blender/sgim26_half_marathon_blender.py', run_name='__main__'); ns['main']()
col=bpy.data.collections['SGIM26 Half Marathon']; sc=bpy.context.scene
print('collections',len(bpy.data.collections),'objects',len(col.all_objects),'|',col['race'],'| frame_end',sc.frame_end)
km,t=ns['build_pacing'](7200,'effort'); r=bpy.data.objects['Runner']; trace=[ns['to_xy'](a,b) for a,b in ns['DATA']['route']]; L=ns['cum_len'](trace)
worst=0
for k in (0,1,5,10,16,16.25,16.6,21.0975):
    f=1+ns['interp'](km,t,k)/7200*(sc.frame_end-1); sc.frame_set(int(f),subframe=f-int(f)); bpy.context.view_layer.update()
    p=r.matrix_world.translation; x,y,_,_=ns['point_at'](trace,L,L[-1]*k/21.0975); z=ns['elev_at'](k)*20*0.01+0.02
    d=math.hypot(p.x-x*0.01,p.y-y*0.01)*100; worst=max(worst,d); print('km %7.4f frame %7.1f horizontal error %5.1f m  z %.2f (expect %.2f)'%(k,f,d,p.z,z))
print('worst horizontal error m',round(worst,1))
sc.render.engine='CYCLES'; sc.cycles.samples=24; sc.cycles.device='CPU'; sc.render.resolution_x=1280; sc.render.resolution_y=720
try: sc.view_settings.view_transform='Standard'
except Exception: pass
f=1+ns['interp'](km,t,16.2)/7200*(sc.frame_end-1); sc.frame_set(int(f)); sc.camera=bpy.data.objects['Chase camera']
sc.render.filepath='build/sgim26_blender_preview.png'; bpy.ops.render.render(write_still=True)
sc.camera=bpy.data.objects['Overview camera']; sc.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath('blender/sgim26_half_marathon.blend'))
