"""Assemble the standalone Blender script: blender/src/*.py + data/ -> blender/sgim26_half_marathon_blender.py.
Run from the repo root: python3 scripts/build_blender.py"""
import json, base64
d=json.dumps(json.load(open('data/data.json')),separators=(',',':'))
b=base64.b64encode(open('data/basemap_q.png','rb').read()).decode()
bl='\n'.join(b[i:i+120] for i in range(0,len(b),120))
s=open('blender/src/head.py').read()+"# ----------------------------------------------------------------------------- embedded data\nDATA = json.loads(r'''"+d+"''')\n\nBASEMAP_PNG_B64 = '''\n"+bl+"\n'''\n\n"+open('blender/src/core.py').read()+open('blender/src/scene.py').read()
open('blender/sgim26_half_marathon_blender.py','w').write(s)
print('built blender/sgim26_half_marathon_blender.py')
