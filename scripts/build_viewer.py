"""Assemble the single-file viewer: src/template.html + src/core.js + src/app.js + data/ -> index.html.
Run from the repo root after `npm install`: python3 scripts/build_viewer.py"""
import base64, json, re, sys
src=lambda p: open(p,encoding='utf-8').read()
t=src('src/template.html')
css=src('node_modules/leaflet/dist/leaflet.css')
css=re.sub(r'url\([^)]*\)','none',css)          # marker/layer sprites are not used
data=json.dumps(json.load(open('data/data.json')),separators=(',',':'))
bm='data:image/png;base64,'+base64.b64encode(open('data/basemap_cls.png','rb').read()).decode()
CDN=['https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js','https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js','https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js']
LOCAL=['../node_modules/three/build/three.min.js','../node_modules/three/examples/js/controls/OrbitControls.js','../node_modules/leaflet/dist/leaflet.js']
def make(libs):
    h=t.replace('/*__LEAFLET_CSS__*/',css).replace('<!--__LIBS__-->','\n'.join(f'<script src="{u}"></script>' for u in libs))
    h=h.replace('/*__DATA__*/null',data).replace('__BASEMAP__',bm).replace('/*__CORE__*/',src('src/core.js')).replace('/*__APP__*/',src('src/app.js'))
    assert '__' not in re.sub(r'__sgim|__proto__','',h.split('<script>')[0]), 'placeholder left'
    return h
import os; os.makedirs('build',exist_ok=True)
open('build/test.html','w',encoding='utf-8').write(make(LOCAL))      # local libraries, for the browser tests
open('index.html','w',encoding='utf-8').write(make(CDN))              # the published viewer
print('built index.html', os.path.getsize('index.html'),'bytes')
