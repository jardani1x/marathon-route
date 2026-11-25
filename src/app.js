/* SGIM 2026 half marathon route viewer.
   Layers: data (SGIM_DATA) -> model (route, elevation) -> state -> views (3D scene, 2D map, chart, panel). */
(function () {
  'use strict';
  var C = window.RouteCore, DATA = window.SGIM_DATA, $ = function (id) { return document.getElementById(id); };
  var COURSE_KM = DATA.meta.courseKm, FLAG_OFF_S = 4.5 * 3600;
  var proj = C.makeProjection(DATA.origin);
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- storage (may be absent)
  var store = {
    get: function (k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  var K_SET = 'sgim26hm.settings.v4', K_OSM = 'sgim26hm.osm.v2';

  // ---------------------------------------------------------------- state
  var DEFAULTS = { exag: 20, target: '2:00:00', showKm: true, showLm: true, showBase: true, showCurtain: true, showSigns: true, showCity: true, showLamps: true, grade: false, sim: '60', pacing: 'effort', follow: false, theme: 'light' };
  var saved = store.get(K_SET) || {};
  var state = {
    km: 0, playing: false, view: '3d', sel: null, filter: 'all', query: '',
    source: 'trace', osmStats: null, fetching: false, srcNote: ''
  };
  Object.keys(DEFAULTS).forEach(function (k) { state[k] = (typeof saved[k] === typeof DEFAULTS[k]) ? saved[k] : DEFAULTS[k]; });
  state.exag = Math.max(1, Math.min(40, state.exag));
  if (isNaN(C.parseTime(state.target))) state.target = DEFAULTS.target;
  if (!/^(preview|1|10|30|60|120|300)$/.test(state.sim)) state.sim = DEFAULTS.sim;
  if (state.pacing !== 'even') state.pacing = 'effort';
  if (state.theme !== 'dark') state.theme = 'light';
  function saveSettings() { var o = {}; Object.keys(DEFAULTS).forEach(function (k) { o[k] = state[k]; }); store.set(K_SET, o); }

  // ---------------------------------------------------------------- model
  var traceXY = DATA.route.map(function (p) { return proj.toXY(p[0], p[1]); });
  var route = null;      // {xy, L, total, dense:[{x,y,km,el}], bbox}
  function elevAt(km) { return C.interp(DATA.elev.km, DATA.elev.m, km); }
  function gradeAt(km) {
    var a = Math.max(0, km - 0.06), b = Math.min(COURSE_KM, km + 0.06);
    return b > a ? (elevAt(b) - elevAt(a)) / ((b - a) * 1000) * 100 : 0;
  }
  // turn-by-turn instructions, recomputed whenever the route geometry changes
  var turns = [];
  var ground = C.streetGround(DATA.elev.km, DATA.elev.m, COURSE_KM);
  // street view height: true metres above the local ground, so roads sit on the map and bridges rise
  // (later legs float a little higher, up to 0.4 m, so overlapping out-and-back legs do not flicker)
  function streetY(km) { return 0.25 + Math.max(0, elevAt(km) - C.interp(ground.km, ground.m, km)) + 0.02 * km; }
  function setRoute(xy) {
    var L = C.cumLen(xy), total = L[L.length - 1];
    var n = Math.max(2, Math.round(total / 8)), dense = [], minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (var i = 0; i <= n; i++) {
      var p = C.pointAt(xy, L, total * i / n), km = COURSE_KM * i / n;
      dense.push({ x: p[0], y: p[1], km: km, el: elevAt(km) });
      minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]);
    }
    route = { xy: xy, L: L, total: total, dense: dense, bbox: [minx, miny, maxx, maxy] };
    turns = C.computeTurns(xy, COURSE_KM, DATA.sections, { finishText: 'Finish inside the National Stadium' });
    for (var j = items.length - 1; j >= 0; j--) if (items[j].type === 'turn') items.splice(j, 1);
    turns.forEach(function (t, k) {
      if (t.type === 'depart' || t.type === 'arrive') return;
      items.push({ id: 'turn' + k, type: 'turn', name: t.text, km: t.km, turn: t, text: '', hiddenInList: true, search: (t.text + ' ' + t.road + ' turn direction').toLowerCase() });
    });
  }
  function posAtKm(km) {       // -> {x, y, tx, ty, el}
    km = Math.max(0, Math.min(COURSE_KM, km));
    var p = C.pointAt(route.xy, route.L, route.total * km / COURSE_KM);
    return { x: p[0], y: p[1], tx: p[2], ty: p[3], el: elevAt(km) };
  }
  var pacing = null;
  function rebuildPacing() { pacing = C.buildPacing(DATA.elev.km, DATA.elev.m, COURSE_KM, C.parseTime(state.target), state.pacing); }
  function timeAt(km) { return C.timeAtKm(pacing, km); }
  function sectionAt(km) {
    var s = DATA.sections;
    for (var i = 0; i < s.length; i++) if (km >= s[i].from && km < s[i].to) return s[i];
    return s[s.length - 1];
  }
  function nearestKmTo(x, y) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < route.dense.length; i++) { var d = route.dense[i], q = (d.x - x) * (d.x - x) + (d.y - y) * (d.y - y); if (q < bd) { bd = q; best = i; } }
    return { km: route.dense[best].km, dist: Math.sqrt(bd) };
  }
  // searchable items: landmarks, road sections, profile points share one list
  var items = [];
  DATA.landmarks.forEach(function (l, i) {
    var xy = proj.toXY(l.lat, l.lon);
    items.push({ id: 'lm' + i, type: 'landmark', name: l.name, kind: l.kind, text: l.blurb, x: xy[0], y: xy[1], x0: xy[0], y0: xy[1], km: l.nearKm, nearM: l.nearM, search: (l.name + ' ' + l.blurb).toLowerCase() });
  });
  DATA.sections.forEach(function (s, i) {
    items.push({ id: 'sec' + i, type: 'section', name: s.name, text: s.note, from: s.from, to: s.to, km: s.from, inferred: s.inferred, search: (s.name + ' ' + s.note).toLowerCase() });
  });
  DATA.elevAnchors.forEach(function (a, i) {
    items.push({ id: 'pt' + i, type: 'point', name: a[2], km: a[0], el: a[1], text: 'Labelled on the organiser’s elevation profile.', search: a[2].toLowerCase() });
  });
  items.push({ id: 'kmfin', type: 'km', name: 'Finish', km: COURSE_KM, text: '', search: 'finish 21.0975', hiddenInList: true, prevKm: 21 });
  for (var kk = 1; kk <= 21; kk++) items.push({ id: 'km' + kk, type: 'km', name: 'Kilometre ' + kk, km: kk, text: '', search: 'km ' + kk + ' kilometre ' + kk, hiddenInList: true });
  function itemById(id) { for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; }

  var IDENT = { a: 1, b: 0, tx: 0, ty: 0 };
  function applyFrame(T) {
    T = T && typeof T.a === 'number' ? T : IDENT;
    items.forEach(function (it) { if (it.type === 'landmark') { it.x = T.a * it.x0 - T.b * it.y0 + T.tx; it.y = T.b * it.x0 + T.a * it.y0 + T.ty; } });
    if (three) {
      var b = DATA.basemap, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, sc = Math.hypot(T.a, T.b);
      three.base.position.set(T.a * cx - T.b * cy + T.tx, 0, -(T.b * cx + T.a * cy + T.ty));
      three.base.scale.set(sc, sc, 1); three.base.rotation.set(-Math.PI / 2, 0, Math.atan2(T.b, T.a));
    }
  }
  setRoute(traceXY);
  rebuildPacing();

  // ---------------------------------------------------------------- 3D scene
  var T3 = window.THREE, three = null;     // three = {renderer, scene, camera, controls, ...} or null if WebGL failed
  var dirty = true;
  function invalidate() { dirty = true; }
  function W(x, y, h) { return new T3.Vector3(x, h, -y); }      // metres east/north/up -> scene
  var THEMES = {
    light: {
      col: { course: 0xd4147f, runner: 0xe09400, climb: 0xe2590b, descent: 0x0a7fb5, flat: 0x9aa3c7, post: 0x8e98ba },
      sky: 0xdde5ef, ground: 0xe3e8f0, land: 0xe3e8f0, water: 0xb6cde9, road: 0xffffff,
      label: { bg: 'rgba(255,255,255,.95)', fg: '#121833', border: '#b9c2d8' }, km: { bg: '#ffffff', fg: '#d4147f', border: '#d4147f' }, endBg: '#121833', endFg: '#ffffff',
      asphalt: '#80889a', lane: 'rgba(255,255,255,.85)', deck: 0xa7afbf, cone: 0xf26b1d, post: 0x5b6378, guide: '#0b6b4f',
      chart: { grid: 'rgba(88,98,130,.22)', text: '#586282', strong: '#121833', fillTop: 'rgba(212,20,127,.42)', fillBot: 'rgba(212,20,127,.04)' },
      map: { route: '#d4147f', kmFill: '#ffffff', lmFill: '#4a5a9a', lmEdge: '#ffffff', ghost: '#121833' }
    },
    dark: {
      col: { course: 0xff3ecf, runner: 0xffd447, climb: 0xff8a3d, descent: 0x4cc9f0, flat: 0xcfcaff, post: 0x6f7bd0 },
      sky: 0x040716, ground: 0x070c2e, land: 0x070c2e, water: 0x0c225c, road: 0x2e4aaa,
      label: { bg: 'rgba(12,18,48,.92)', fg: '#eceeff', border: '#5a67c0' }, km: { bg: '#1a0f3a', fg: '#ffffff', border: '#ff3ecf' }, endBg: '#ffffff', endFg: '#12051a',
      asphalt: '#2b3042', lane: 'rgba(255,255,255,.7)', deck: 0x3a4157, cone: 0xff7a2e, post: 0x8a93b8, guide: '#0d7d5c',
      chart: { grid: 'rgba(154,164,216,.22)', text: '#9aa4d8', strong: '#eceeff', fillTop: 'rgba(255,62,207,.55)', fillBot: 'rgba(255,62,207,.06)' },
      map: { route: '#ff3ecf', kmFill: '#1a0f3a', lmFill: '#5a67c0', lmEdge: '#eceeff', ghost: '#ffffff' }
    }
  };
  function TH() { return THEMES[state.theme]; }
  var COL = TH().col;
  // turn arrows, 24x24 stroke paths; right-hand versions are mirrored for left turns (U-turns are drawn left-handed)
  var ARROW = {
    depart: 'M12 21V5M6.5 10.5L12 5l5.5 5.5M8 21h8',
    continue: 'M12 21V5M6.5 10.5L12 5l5.5 5.5',
    slight: 'M8 21v-6l8.5-8.5M10.5 6.5H17V13',
    turn: 'M7 21v-8a4 4 0 0 1 4-4h8.5M15 5l4.5 4-4.5 4',
    sharp: 'M8 21V9a3 3 0 0 1 5.1-2.1L19 13M19 7v6h-6',
    uturn: 'M16 21V10a4 4 0 0 0-8 0v6M4.5 12.5L8 16l3.5-3.5',
    arrive: 'M6 21V4M6 4h11l-3 4 3 4H6'
  };
  function arrowFor(t) {
    var d = ARROW[t.type] || ARROW.continue;
    var mirror = (t.type === 'uturn') ? t.dir === 'right' : t.dir === 'left';
    return { d: d, mirror: mirror };
  }
  function setArrow(pathEl, t) {
    var a = arrowFor(t); pathEl.setAttribute('d', a.d);
    pathEl.setAttribute('transform', a.mirror ? 'matrix(-1 0 0 1 24 0)' : '');
  }
  function fmtDist(m) { return m < 20 ? 'Now' : m < 1000 ? (Math.round(m / 10) * 10) + ' m' : (m / 1000).toFixed(1) + ' km'; }

  function initThree() {
    if (!T3 || !T3.OrbitControls) return null;
    var canvas = $('gl'), renderer;
    try { renderer = new T3.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false, powerPreference: 'high-performance' }); }
    catch (e) { return null; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(TH().sky, 1);
    var scene = new T3.Scene();
    scene.fog = new T3.Fog(TH().sky, 16000, 70000);
    // The ground, the map underlay and parks are drawn first in a separate pass with no depth test, then the
    // depth buffer is cleared. Flat layers centimetres apart can then never fight for depth (that fight is the
    // flicker seen at a distance, worst on phones).
    var bgScene = new T3.Scene(); bgScene.fog = scene.fog;
    renderer.autoClear = false;
    scene.add(new T3.HemisphereLight(0xffffff, 0xa0a6b4, 0.95));
    var sun = new T3.DirectionalLight(0xffffff, 0.45); sun.position.set(-0.4, 1, 0.6); scene.add(sun);
    var camera = new T3.PerspectiveCamera(38, 1, 20, 120000);
    var controls = new T3.OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.maxPolarAngle = Math.PI / 2 - 0.03; controls.minDistance = 250; controls.maxDistance = 45000;
    controls.screenSpacePanning = false;
    controls.addEventListener('change', invalidate);
    controls.addEventListener('start', function () { t.tween = null; });

    var t = { renderer: renderer, scene: scene, bgScene: bgScene, camera: camera, controls: controls, tween: null, labels: [], uR: { value: 14 }, size: { w: 1, h: 1 },
      bmU: { cLand: { value: new T3.Color(TH().land) }, cWater: { value: new T3.Color(TH().water) }, cRoad: { value: new T3.Color(TH().road) } } };

    // ground + basemap underlay
    var g = new T3.Mesh(new T3.PlaneGeometry(160000, 160000), new T3.MeshBasicMaterial({ color: TH().ground, depthTest: false, depthWrite: false }));
    g.rotation.x = -Math.PI / 2; g.position.y = -2; g.renderOrder = -10; bgScene.add(g); t.groundMesh = g;
    var b = DATA.basemap, tex = new T3.TextureLoader().load(window.SGIM_BASEMAP, invalidate);
    tex.minFilter = T3.LinearMipmapLinearFilter; tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    // the texture holds one class per channel (R road, G water, B land, A fade); colours come from the theme
    var bmMat = new T3.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    bmMat.onBeforeCompile = function (sh) {
      sh.uniforms.cLand = t.bmU.cLand; sh.uniforms.cWater = t.bmU.cWater; sh.uniforms.cRoad = t.bmU.cRoad;
      sh.fragmentShader = 'uniform vec3 cLand;\nuniform vec3 cWater;\nuniform vec3 cRoad;\n' + sh.fragmentShader.replace('#include <map_fragment>',
        'vec4 tc = texture2D( map, vUv ); float sw = max( tc.r + tc.g + tc.b, 1e-3 );\n' +
        'diffuseColor.rgb = ( tc.r * cRoad + tc.g * cWater + tc.b * cLand ) / sw; diffuseColor.a *= tc.a;');
    };
    var base = new T3.Mesh(new T3.PlaneGeometry(b.x1 - b.x0, b.y1 - b.y0), bmMat);
    base.rotation.x = -Math.PI / 2; base.position.set((b.x0 + b.x1) / 2, 0, -(b.y0 + b.y1) / 2); base.renderOrder = 1; bgScene.add(base);
    t.base = base;

    t.routeGroup = new T3.Group(); scene.add(t.routeGroup);
    t.markGroup = new T3.Group(); scene.add(t.markGroup);
    t.osmGroup = new T3.Group(); scene.add(t.osmGroup);
    t.selGroup = new T3.Group(); scene.add(t.selGroup);
    t.streetGroup = new T3.Group(); t.streetGroup.visible = false; scene.add(t.streetGroup);
    t.cityGroup = new T3.Group(); scene.add(t.cityGroup);
    t.greenGroup = new T3.Group(); bgScene.add(t.greenGroup);

    // runner: screen-constant dot + stem
    t.figure = makeRunner(); scene.add(t.figure.group); poseRunner(t.figure, 0, false);
    t.runner = makeSprite(dotCanvas('#ffd447', '#1b1400'), 10);
    t.runner.sprite.renderOrder = 30; scene.add(t.runner.sprite);
    t.runnerStem = new T3.Line(new T3.BufferGeometry().setFromPoints([new T3.Vector3(), new T3.Vector3(0, 1, 0)]), new T3.LineBasicMaterial({ color: COL.runner }));
    scene.add(t.runnerStem);
    return t;
  }

  // ---- runner figure: jointed low-poly body, 1 unit tall, feet at the origin, facing +Z
  function makeRunner() {
    var g = new T3.Group(), body = new T3.Group(); g.add(body);
    function mat(c) { return new T3.MeshLambertMaterial({ color: c }); }
    var skin = mat(0xf2c9a0), shirt = mat(0xffd447), shade = mat(0xd9a916), shorts = mat(0x1a0f3a), shoe = mat(0xffffff);
    function box(w, h, d, m, x, y, z) { var b = new T3.Mesh(new T3.BoxGeometry(w, h, d), m); b.position.set(x, y, z); return b; }
    function limb(len, w, m1, m2, x, y) {          // pivot at the top; lower segment hangs from a second pivot
      var up = new T3.Group(); up.position.set(x, y, 0);
      up.add(box(w, len, w, m1, 0, -len / 2, 0));
      var lo = new T3.Group(); lo.position.set(0, -len, 0); lo.add(box(w * 0.85, len, w * 0.85, m2, 0, -len / 2, 0)); up.add(lo);
      return { up: up, lo: lo };
    }
    body.add(box(0.26, 0.3, 0.15, shirt, 0, 0.67, 0)); body.add(box(0.27, 0.06, 0.16, shade, 0, 0.55, 0));
    body.add(box(0.26, 0.1, 0.15, shorts, 0, 0.49, 0));
    var head = new T3.Mesh(new T3.SphereGeometry(0.085, 12, 10), skin); head.position.set(0, 0.92, 0.01); body.add(head);
    var legL = limb(0.24, 0.1, shorts, skin, -0.075, 0.48), legR = limb(0.24, 0.1, shorts, skin, 0.075, 0.48);
    var armL = limb(0.15, 0.065, shirt, skin, -0.17, 0.8), armR = limb(0.15, 0.065, shirt, skin, 0.17, 0.8);
    [legL, legR].forEach(function (l) { l.lo.add(box(0.09, 0.05, 0.17, shoe, 0, -0.24, 0.04)); });
    [legL, legR, armL, armR].forEach(function (l) { body.add(l.up); });
    body.rotation.x = 0.12;                           // slight forward lean
    return { group: g, body: body, legL: legL, legR: legR, armL: armL, armR: armR };
  }
  function poseRunner(r, phase, moving) {
    var s = Math.sin(phase), c = Math.cos(phase), a = moving ? 1 : 0;
    r.legL.up.rotation.x = -0.75 * s * a; r.legR.up.rotation.x = 0.75 * s * a;
    r.legL.lo.rotation.x = (0.25 + 0.95 * Math.max(0, c)) * a; r.legR.lo.rotation.x = (0.25 + 0.95 * Math.max(0, -c)) * a;
    r.armL.up.rotation.x = 0.8 * s * a; r.armR.up.rotation.x = -0.8 * s * a;
    r.armL.lo.rotation.x = -1.3 * a - 0.15; r.armR.lo.rotation.x = -1.3 * a - 0.15;
    r.body.position.y = 0.045 * Math.abs(c) * a;
  }

  // ---- sprites (constant size on screen)
  function dotCanvas(fill, stroke) {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var x = c.getContext('2d');
    x.beginPath(); x.arc(32, 32, 22, 0, 6.2832); x.fillStyle = fill; x.fill(); x.lineWidth = 6; x.strokeStyle = stroke; x.stroke();
    return c;
  }
  function labelCanvas(text, o) {
    var pad = o.pad == null ? 10 : o.pad, fs = 40, c = document.createElement('canvas'), x = c.getContext('2d');
    var font = (o.weight || 700) + ' ' + fs + 'px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    x.font = font;
    var w = Math.ceil(x.measureText(text).width) + pad * 2, h = fs + pad * 1.2;
    if (o.round) w = Math.max(w, h);
    c.width = w; c.height = h; x = c.getContext('2d'); x.font = font;
    var r = o.round ? h / 2 : 9;
    x.beginPath();
    x.moveTo(r, 0); x.lineTo(w - r, 0); x.quadraticCurveTo(w, 0, w, r); x.lineTo(w, h - r); x.quadraticCurveTo(w, h, w - r, h);
    x.lineTo(r, h); x.quadraticCurveTo(0, h, 0, h - r); x.lineTo(0, r); x.quadraticCurveTo(0, 0, r, 0); x.closePath();
    x.fillStyle = o.bg; x.fill();
    if (o.border) { x.lineWidth = 3; x.strokeStyle = o.border; x.stroke(); }
    x.fillStyle = o.fg; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, w / 2, h / 2 + 2);
    return c;
  }
  function makeSprite(canvas, px) {
    var tex = new T3.CanvasTexture(canvas); tex.minFilter = T3.LinearFilter; tex.generateMipmaps = false;
    var m = new T3.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, depthWrite: false, fog: false, transparent: true });
    var s = new T3.Sprite(m);
    return { sprite: s, px: px, aspect: canvas.width / canvas.height };
  }
  function sizeSprite(o) {       // px tall on screen, independent of distance
    var k = 2 * Math.tan(three.camera.fov * Math.PI / 360) / three.size.h;
    o.sprite.scale.set(o.px * o.aspect * k, o.px * k, 1);
  }
  function disposeGroup(g) {
    for (var i = g.children.length - 1; i >= 0; i--) {
      var c = g.children[i]; g.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    }
  }

  // ---- course tube whose radius follows the camera distance (kept readable at any zoom)
  function tubeMaterial() {
    var m = new T3.MeshBasicMaterial({ vertexColors: true, fog: false });
    m.onBeforeCompile = function (sh) {
      sh.uniforms.uR = three.uR;
      sh.vertexShader = 'uniform float uR;\n' + sh.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = position + normal * uR;');
    };
    return m;
  }
  function gradeColor(g, out) {
    var t = Math.max(-1, Math.min(1, g / 4)), a = new T3.Color(COL.flat), b = new T3.Color(t < 0 ? COL.descent : COL.climb);
    return out.copy(a).lerp(b, Math.abs(t));
  }
  function buildTube(pts, colorFn, radial, radiusMul) {
    var n = pts.length, pos = new Float32Array(n * radial * 3), nor = new Float32Array(n * radial * 3), col = new Float32Array(n * radial * 3);
    var up = new T3.Vector3(0, 1, 0), tan = new T3.Vector3(), side = new T3.Vector3(1, 0, 0), upv = new T3.Vector3(), c = new T3.Color(), dir = new T3.Vector3(), tmp = new T3.Vector3();
    for (var i = 0; i < n; i++) {
      tan.subVectors(pts[Math.min(n - 1, i + 1)].p, pts[Math.max(0, i - 1)].p);
      if (tan.lengthSq() < 1e-6) tan.set(1, 0, 0); tan.normalize();
      tmp.crossVectors(up, tan);
      if (tmp.lengthSq() > 1e-6) side.copy(tmp).normalize();
      upv.crossVectors(tan, side).normalize();
      colorFn(pts[i], c);
      for (var j = 0; j < radial; j++) {
        var a = j / radial * Math.PI * 2, o = (i * radial + j) * 3, sh = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(a));
        dir.copy(side).multiplyScalar(Math.cos(a) * radiusMul).addScaledVector(upv, Math.sin(a) * radiusMul);
        pos[o] = pts[i].p.x; pos[o + 1] = pts[i].p.y; pos[o + 2] = pts[i].p.z;
        nor[o] = dir.x; nor[o + 1] = dir.y; nor[o + 2] = dir.z;
        col[o] = c.r * sh; col[o + 1] = c.g * sh; col[o + 2] = c.b * sh;
      }
    }
    var idx = [];
    for (i = 0; i < n - 1; i++) for (j = 0; j < radial; j++) {
      var p0 = i * radial + j, p1 = i * radial + (j + 1) % radial, p2 = p0 + radial, p3 = p1 + radial;
      idx.push(p0, p2, p1, p1, p2, p3);
    }
    var g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.BufferAttribute(pos, 3));
    g.setAttribute('normal', new T3.BufferAttribute(nor, 3));
    g.setAttribute('color', new T3.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    var mesh = new T3.Mesh(g, tubeMaterial()); mesh.frustumCulled = false;
    return mesh;
  }
  function densePts(fromKm, toKm) {
    var out = [];
    for (var i = 0; i < route.dense.length; i++) {
      var d = route.dense[i];
      if (d.km < fromKm - 1e-6 || d.km > toKm + 1e-6) continue;
      out.push({ p: W(d.x, d.y, courseY(d.km)), km: d.km });
    }
    return out;
  }

  function courseY(km) { return state.view === 'street' ? streetY(km) : elevAt(km) * state.exag + 6; }
  function rebuildRoute() {
    if (!three) return;
    disposeGroup(three.routeGroup);
    var pts = densePts(0, COURSE_KM), plain = new T3.Color(COL.course);
    var tube = buildTube(pts, function (pt, c) { if (state.grade) gradeColor(gradeAt(pt.km), c); else c.copy(plain); }, 8, 1);
    tube.renderOrder = 10; three.routeGroup.add(tube);
    // elevation curtain
    var n = pts.length, pos = new Float32Array(n * 6), idx = [];
    for (var i = 0; i < n; i++) {
      pos[i * 6] = pts[i].p.x; pos[i * 6 + 1] = 1; pos[i * 6 + 2] = pts[i].p.z;
      pos[i * 6 + 3] = pts[i].p.x; pos[i * 6 + 4] = pts[i].p.y; pos[i * 6 + 5] = pts[i].p.z;
      if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    var cg = new T3.BufferGeometry(); cg.setAttribute('position', new T3.BufferAttribute(pos, 3)); cg.setIndex(idx);
    var curtain = new T3.Mesh(cg, new T3.MeshBasicMaterial({ color: COL.course, transparent: true, opacity: 0.2, side: T3.DoubleSide, depthWrite: false, fog: false }));
    curtain.renderOrder = 5; curtain.visible = state.showCurtain; three.routeGroup.add(curtain); three.curtain = curtain;
    three.routeGroup.visible = state.view !== 'street';
    rebuildMarkers(); rebuildSelection(); placeRunner(); invalidate();
  }

  function rebuildMarkers() {
    if (!three) return;
    disposeGroup(three.markGroup); three.labels = [];
    var stems = [];
    var th = TH(), street = state.view === 'street';
    function add(item, canvas, px, prio, h, lift, group) {
      var s = makeSprite(canvas, px); s.sprite.center.set(0.5, 0); s.sprite.renderOrder = 20 + prio;
      var anchor = W(item.x, item.y, h + lift); s.sprite.position.copy(anchor);
      three.markGroup.add(s.sprite);
      stems.push(W(item.x, item.y, street ? 0 : 1), anchor);
      three.labels.push({ o: s, anchor: anchor, prio: prio, item: item, group: group });
    }
    // kilometre markers (street view shows arches instead)
    if (!street) {
      for (var k = 0; k <= 21; k++) {
        var p = posAtKm(k), it = k === 0 ? { id: 'start', type: 'km', name: 'Start', km: 0 } : itemById('km' + k);
        it.x = p.x; it.y = p.y;
        if (k === 0) add(it, labelCanvas('START', { bg: th.endBg, fg: th.endFg, pad: 12 }), 20, 9, p.el * state.exag, 320, 'km');
        else add(it, labelCanvas(String(k), { bg: th.km.bg, fg: th.km.fg, border: th.km.border, round: true, pad: 8 }), k % 5 === 0 ? 20 : 17, k % 5 === 0 ? 7 : 5.5, p.el * state.exag, 150, 'km');
      }
      var f = posAtKm(COURSE_KM), fin = { id: 'finish', type: 'km', name: 'Finish', km: COURSE_KM, x: f.x, y: f.y };
      add(fin, labelCanvas('FINISH', { bg: th.endBg, fg: th.endFg, pad: 12 }), 20, 9, f.el * state.exag, 420, 'km');
    }
    // landmarks
    items.forEach(function (it) {
      if (it.type !== 'landmark' || it.kind === 'start' || it.kind === 'finish') return;
      add(it, labelCanvas(it.name, { bg: th.label.bg, fg: th.label.fg, border: th.label.border, weight: 600 }), three.size.w < 600 ? 13 : 15, it.kind === 'climb' ? 6 : 5, 0, street ? 32 : 260, 'lm');
    });
    var sg = new T3.BufferGeometry().setFromPoints(stems);
    three.stems = new T3.LineSegments(sg, new T3.LineBasicMaterial({ color: COL.post, transparent: true, opacity: 0.55, fog: street }));
    three.markGroup.add(three.stems);
    three.labels.forEach(function (l) { sizeSprite(l.o); });
    three.lastDeclutter = 0;
  }

  function rebuildSelection() {
    if (!three) return;
    disposeGroup(three.selGroup);
    var s = state.sel && itemById(state.sel);
    if (!s) return;
    if (s.type === 'section') {
      var pts = densePts(s.from, s.to);
      if (pts.length > 1) { var hl = buildTube(pts, function (pt, c) { c.set(COL.runner); }, 8, 1.7); hl.renderOrder = 11; three.selGroup.add(hl); }
    } else {
      var p = s.type === 'landmark' ? { x: s.x, y: s.y, el: 0 } : posAtKm(s.km);
      var st = state.view === 'street', r0 = st ? 7.5 : 70, r1 = st ? 9.5 : 100;
      var ring = new T3.Mesh(new T3.RingGeometry(r0, r1, 40), new T3.MeshBasicMaterial({ color: COL.runner, side: T3.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false, fog: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.copy(W(p.x, p.y, (s.type === 'landmark' ? 0 : courseY(s.km)) + (st ? 0.15 : 9))); ring.renderOrder = 12;
      three.selGroup.add(ring);
    }
    invalidate();
  }

  function placeRunner() {
    if (!three) return;
    var p = posAtKm(state.km), top = W(p.x, p.y, courseY(state.km));
    three.runner.sprite.position.copy(top);
    three.figure.group.position.copy(top);
    three.figure.group.rotation.y = Math.atan2(p.tx, -p.ty);
    var a = three.runnerStem.geometry.attributes.position;
    a.setXYZ(0, top.x, 1, top.z); a.setXYZ(1, top.x, top.y, top.z); a.needsUpdate = true;
    three.runnerStem.geometry.computeBoundingSphere();
    if (state.follow && !three.tween && state.view !== 'street') {
      var d = top.clone().sub(three.controls.target);
      three.controls.target.add(d); three.camera.position.add(d);
    }
  }

  function drawOsmWays(ways) {
    if (!three) return;
    disposeGroup(three.osmGroup);
    if (!ways || !ways.length) return;
    var v = [];
    ways.forEach(function (w) { if (w.foot) return; for (var i = 0; i + 1 < w.pts.length; i++) v.push(W(w.pts[i][0], w.pts[i][1], 3), W(w.pts[i + 1][0], w.pts[i + 1][1], 3)); });
    var ls = new T3.LineSegments(new T3.BufferGeometry().setFromPoints(v), new T3.LineBasicMaterial({ color: 0x8fa2ff, transparent: true, opacity: 0.55, fog: false }));
    ls.renderOrder = 3; three.osmGroup.add(ls); invalidate();
  }

  // ---- street view: road surface, deck edges, cones, kilometre arches and turn signs at true scale
  var ROAD_W = 12;
  function canvasTex(c, aniso) {
    var tx = new T3.CanvasTexture(c); tx.anisotropy = aniso || 1; return tx;
  }
  function roadTexture() {
    var th = TH(), c = document.createElement('canvas'); c.width = 128; c.height = 512;
    var x = c.getContext('2d');
    x.fillStyle = th.asphalt; x.fillRect(0, 0, 128, 512);
    x.fillStyle = th.lane; x.fillRect(4, 0, 3, 512); x.fillRect(121, 0, 3, 512);           // edge lines
    x.fillRect(42, 0, 2, 192); x.fillRect(84, 0, 2, 192);                                     // lane dashes: 3 m on, 5 m off
    x.fillStyle = '#' + new T3.Color(COL.course).getHexString(); x.fillRect(61, 0, 6, 512);  // race line
    var t = canvasTex(c, three.renderer.capabilities.getMaxAnisotropy());
    t.wrapS = T3.ClampToEdgeWrapping; t.wrapT = T3.RepeatWrapping; return t;
  }
  function boardCanvas(w, h, bg, draw) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, w, h); draw(x); return c;
  }
  function strokeArrow(x, t, cx, cy, size, color, width) {
    var a = arrowFor(t), k = size / 24;
    x.save(); x.translate(cx - size / 2, cy - size / 2); x.scale(k, k);
    if (a.mirror) { x.translate(24, 0); x.scale(-1, 1); }
    x.strokeStyle = color; x.lineWidth = width; x.lineCap = 'round'; x.lineJoin = 'round';
    x.stroke(new Path2D(a.d)); x.restore();
  }
  function fitText(x, text, maxW, size, weight) {
    var s = size;
    do { x.font = weight + ' ' + s + 'px "Barlow Condensed", "Arial Narrow", Arial, sans-serif'; s -= 2; } while (x.measureText(text).width > maxW && s > 18);
  }
  // a road-facing board: front face (+z) carries the texture and faces runners coming along heading (tx, ty)
  function placeFacing(obj, x, y, h, tx, ty) { obj.position.copy(W(x, y, h)); obj.rotation.y = Math.atan2(-tx, ty); }
  function rebuildStreet() {
    if (!three) return;
    var g = three.streetGroup, th = TH();
    for (var i = g.children.length - 1; i >= 0; i--) {
      var c = g.children[i]; g.remove(c);
      c.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
      });
    }
    var step = 4, total = route.total, n = Math.max(2, Math.round(total / step)), P = [], side = [1, 0], half = ROAD_W / 2;
    for (i = 0; i <= n; i++) { var km = COURSE_KM * i / n, q = C.pointAt(route.xy, route.L, total * i / n); P.push({ x: q[0], y: q[1], km: km, h: streetY(km) }); }
    // run the road 40 m back behind the start line and 20 m past the finish line
    var s0 = posAtKm(0), s1 = posAtKm(COURSE_KM), ext = [];
    for (i = 10; i >= 1; i--) ext.push({ x: s0.x - s0.tx * 4 * i, y: s0.y - s0.ty * 4 * i, km: -0.004 * i, h: streetY(0) });
    P = ext.concat(P);
    for (i = 1; i <= 5; i++) P.push({ x: s1.x + s1.tx * 4 * i, y: s1.y + s1.ty * 4 * i, km: COURSE_KM + 0.004 * i, h: streetY(COURSE_KM) });
    n = P.length - 1;
    var pos = [], uv = [], idx = [], skirt = [], sidx = [], edges = [];
    for (i = 0; i <= n; i++) {
      var a = P[Math.max(0, i - 3)], b = P[Math.min(n, i + 3)], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
      if (l > 2) side = [dy / l, -dx / l];                       // right-hand normal (east, north)
      var p = P[i], v = p.km * 1000 / 8;
      var lx = p.x - side[0] * half, ly = p.y - side[1] * half, rx = p.x + side[0] * half, ry = p.y + side[1] * half;
      pos.push(lx, p.h, -ly, rx, p.h, -ry); uv.push(0, v, 1, v);
      var dropTo = Math.max(-0.05, p.h - 1.3);
      skirt.push(lx, p.h, -ly, lx, dropTo, -ly, rx, p.h, -ry, rx, dropTo, -ry);
      edges.push({ lx: lx, ly: ly, rx: rx, ry: ry, h: p.h, km: p.km, tx: -side[1], ty: side[0] });
      if (i < n) {
        var k2 = i * 2; idx.push(k2, k2 + 1, k2 + 2, k2 + 1, k2 + 3, k2 + 2);
        var k4 = i * 4; sidx.push(k4, k4 + 4, k4 + 1, k4 + 1, k4 + 4, k4 + 5, k4 + 2, k4 + 3, k4 + 6, k4 + 3, k4 + 7, k4 + 6);
      }
    }
    var rg = new T3.BufferGeometry(); rg.setAttribute('position', new T3.Float32BufferAttribute(pos, 3)); rg.setAttribute('uv', new T3.Float32BufferAttribute(uv, 2)); rg.setIndex(idx);
    var road = new T3.Mesh(rg, new T3.MeshBasicMaterial({ map: roadTexture(), side: T3.DoubleSide })); road.frustumCulled = false; road.renderOrder = 6; g.add(road);
    var sg = new T3.BufferGeometry(); sg.setAttribute('position', new T3.Float32BufferAttribute(skirt, 3)); sg.setIndex(sidx);
    var deck = new T3.Mesh(sg, new T3.MeshBasicMaterial({ color: th.deck, side: T3.DoubleSide })); deck.frustumCulled = false; g.add(deck);
    // traffic cones along both edges every 12 m
    var cones = new T3.InstancedMesh(new T3.ConeGeometry(0.22, 0.75, 10), new T3.MeshLambertMaterial({ color: th.cone }), Math.ceil(edges.length / 3) * 2 + 2);
    var mtx = new T3.Matrix4(), cnt = 0;
    for (i = 0; i < edges.length; i += 3) {
      var e = edges[i];
      mtx.makeTranslation(e.lx, e.h + 0.375, -e.ly); cones.setMatrixAt(cnt++, mtx);
      mtx.makeTranslation(e.rx, e.h + 0.375, -e.ry); cones.setMatrixAt(cnt++, mtx);
    }
    cones.count = cnt; cones.instanceMatrix.needsUpdate = true; g.add(cones);
    // street lamps every 45 m on both sides (decorative: not from map data)
    var poles = new T3.InstancedMesh(new T3.CylinderGeometry(0.07, 0.1, 7.5, 6), new T3.MeshLambertMaterial({ color: th.post }), Math.ceil(edges.length / 11) * 2 + 2);
    var heads = new T3.InstancedMesh(new T3.BoxGeometry(0.35, 0.16, 1.5), new T3.MeshBasicMaterial({ color: state.theme === 'dark' ? 0xffe2a0 : 0xf4f1e6 }), Math.ceil(edges.length / 11) * 2 + 2);
    var q4 = new T3.Quaternion(), sc3 = new T3.Vector3(1, 1, 1), up3 = new T3.Vector3(0, 1, 0), lc = 0;
    for (i = 6; i < edges.length; i += 11) {
      var ed = edges[i], yaw = Math.atan2(-ed.tx, ed.ty);
      [[ed.lx, ed.ly, -1], [ed.rx, ed.ry, 1]].forEach(function (s3) {
        var ox = s3[0] + s3[2] * 1.2 * ed.ty, oy = s3[1] - s3[2] * 1.2 * ed.tx;      // 1.2 m outside the road edge
        mtx.compose(new T3.Vector3(ox, ed.h + 3.75, -oy), q4.identity(), sc3); poles.setMatrixAt(lc, mtx);
        q4.setFromAxisAngle(up3, yaw + Math.PI / 2);
        var hx = ox - s3[2] * 0.7 * ed.ty, hy = oy + s3[2] * 0.7 * ed.tx;
        mtx.compose(new T3.Vector3(hx, ed.h + 7.45, -hy), q4, sc3); heads.setMatrixAt(lc, mtx); lc++;
      });
    }
    poles.count = heads.count = lc; poles.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
    poles.userData.kind = heads.userData.kind = 'lamp'; poles.visible = heads.visible = state.showLamps; g.add(poles); g.add(heads);
    var postMat = new T3.MeshLambertMaterial({ color: th.post }), courseHex = '#' + new T3.Color(COL.course).getHexString();
    // kilometre arches (start, 1-21, finish)
    function arch(km, label, big) {
      var q = posAtKm(km), h = streetY(km), grp = new T3.Group(), span = ROAD_W + 1.6;
      var cv = boardCanvas(1024, 112, big ? th.endBg : courseHex, function (x) {
        fitText(x, label, 980, 80, 700); x.fillStyle = big ? th.endFg : '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(label, 512, 60);
      });
      var face = new T3.MeshBasicMaterial({ map: canvasTex(cv, 4) }), edge = new T3.MeshLambertMaterial({ color: big ? th.endBg : courseHex });
      var bar = new T3.Mesh(new T3.BoxGeometry(span, 1.5, 0.35), [edge, edge, edge, edge, face, face]); bar.position.set(0, 6.0, 0); grp.add(bar);
      [-1, 1].forEach(function (sgn) { var pst = new T3.Mesh(new T3.BoxGeometry(0.45, 6.75, 0.45), postMat); pst.position.set(sgn * span / 2, 3.37, 0); grp.add(pst); });
      placeFacing(grp, q.x, q.y, h, q.tx, q.ty); grp.userData.kind = 'arch'; grp.visible = state.showKm; g.add(grp);
    }
    arch(0.012, 'START', true);
    for (var kk = 1; kk <= 21; kk++) arch(kk, 'KM ' + kk, false);
    arch(COURSE_KM - 0.002, 'FINISH', true);
    // turn signs, 30 m before each turn, on the side the course turns to
    turns.forEach(function (t) {
      if (t.type === 'depart' || t.type === 'arrive') return;
      var sk = Math.max(0.005, t.km - 0.03), q = posAtKm(sk), h = streetY(sk), sgn = t.dir === 'left' ? -1 : 1;
      var sx = q.x + sgn * (half + 1.8) * q.ty, sy = q.y - sgn * (half + 1.8) * q.tx;   // right normal of (tx, ty) is (ty, -tx)
      var cv = boardCanvas(512, 256, th.guide, function (x) {
        strokeArrow(x, t, 112, 128, 168, '#ffffff', 2.6);
        var road = t.short, verb = t.type === 'uturn' ? 'U-TURN' : t.type === 'continue' ? 'CONTINUE' : t.type === 'slight' ? 'BEAR ' + t.dir.toUpperCase() : t.type === 'sharp' ? 'SHARP ' + t.dir.toUpperCase() : 'TURN ' + t.dir.toUpperCase();
        x.fillStyle = '#ffffff'; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
        x.font = '600 34px "Barlow Condensed", "Arial Narrow", Arial, sans-serif'; x.globalAlpha = 0.85; x.fillText(verb, 214, 86); x.globalAlpha = 1;
        var words = road.split(' '), l1 = '', l2 = '';
        fitText(x, road, 280, 58, 700);
        if (x.measureText(road).width > 280 && words.length > 1) { var mid = Math.ceil(words.length / 2); l1 = words.slice(0, mid).join(' '); l2 = words.slice(mid).join(' '); fitText(x, l1.length > l2.length ? l1 : l2, 280, 54, 700); x.fillText(l1, 214, 146); x.fillText(l2, 214, 200); }
        else x.fillText(road, 214, 160);
      });
      var grp = new T3.Group(), face = new T3.MeshBasicMaterial({ map: canvasTex(cv, 4) }), back = new T3.MeshLambertMaterial({ color: th.post });
      var board = new T3.Mesh(new T3.BoxGeometry(4.2, 2.1, 0.1), [back, back, back, back, face, back]); board.position.set(0, 3.3, 0); grp.add(board);
      var pst = new T3.Mesh(new T3.BoxGeometry(0.14, 2.4, 0.14), postMat); pst.position.set(0, 1.2, -0.1); grp.add(pst);
      placeFacing(grp, sx, sy, h, q.tx, q.ty); grp.userData.kind = 'sign'; grp.visible = state.showSigns; g.add(grp);
    });
    invalidate();
  }
  function syncStreetToggles() {
    if (!three) return;
    three.streetGroup.children.forEach(function (o) { if (o.userData.kind === 'arch') o.visible = state.showKm; if (o.userData.kind === 'sign') o.visible = state.showSigns; if (o.userData.kind === 'lamp') o.visible = state.showLamps; });
    invalidate();
  }

  // ---- city: buildings, trees and parks from OpenStreetMap, loaded in pieces along the course and kept in IndexedDB
  var K_CITY = 'city.v1', CITY_TTL = 30 * 86400000;
  var city = { status: 'idle', data: null, done: [], total: 0, saved: 0, err: '', stats: null };
  var db = null;
  function idb() {
    if (db) return db;
    db = new Promise(function (res, rej) {
      try { var r = indexedDB.open('sgim26hm', 1); r.onupgradeneeded = function () { r.result.createObjectStore('kv'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }
      catch (e) { rej(e); }
    });
    return db;
  }
  function idbGet(k) { return idb().then(function (d) { return new Promise(function (res) { try { var q = d.transaction('kv', 'readonly').objectStore('kv').get(k); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } }); }).catch(function () { return null; }); }
  function idbSet(k, v) { return idb().then(function (d) { return new Promise(function (res) { try { var tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = function () { res(true); }; tx.onerror = function () { res(false); }; } catch (e) { res(false); } }); }).catch(function () { return false; }); }
  function cityPieces() {
    return C.routePieces(traceXY, 3000, 40).map(function (seg) { return C.simplify(seg, 15).map(function (p) { return proj.toLL(p[0], p[1]); }); });
  }
  function overpassAny(query, ms) {
    var i = 0, last = null;
    function next() {
      if (i >= ENDPOINTS.length) return Promise.reject(last || new Error('no endpoint'));
      var u = ENDPOINTS[i++];
      return postOverpass(u, query, ms).catch(function (e) { last = e; return next(); });
    }
    return next();
  }
  function loadCity(force) {
    if (city.status === 'loading') return;
    city.status = 'loading'; city.err = ''; describeCity();
    var pieces = cityPieces();
    (force ? Promise.resolve(null) : idbGet(K_CITY)).then(function (rec) {
      var fresh = rec && rec.v === 1 && rec.data && Array.isArray(rec.done) && rec.done.length === pieces.length && Date.now() - rec.t < CITY_TTL;
      city.data = fresh ? rec.data : { buildings: [], trees: [], greens: [] };
      city.done = fresh ? rec.done.slice() : pieces.map(function () { return false; });
      city.saved = fresh ? rec.t : 0; city.total = pieces.length;
      if (city.data.buildings.length) buildCity();
      var k = 0;
      function step() {
        while (k < pieces.length && city.done[k]) k++;
        if (k >= pieces.length) { city.status = 'ready'; describeCity(); return; }
        describeCity();
        return overpassAny(C.buildOverpassFeaturesQuery(pieces[k], 230), 120000).then(function (json) {
          C.mergeFeatures(city.data, C.parseFeatures(json)); city.done[k] = true; city.saved = Date.now();
          idbSet(K_CITY, { v: 1, t: city.saved, done: city.done, data: city.data });
          buildCity(); k++; return step();
        }, function (e) {
          var blocked = !e || e.name === 'TypeError';
          city.status = 'error';
          city.err = blocked ? 'OpenStreetMap could not be reached from this page. Pages opened inside Claude cannot call other sites; the GitHub Pages copy, or the HTML file served from your computer, can.'
            : 'The OpenStreetMap server did not answer (' + (e.message || 'error') + '). It is often busy; try again in a minute.';
          describeCity(); if (city.data.buildings.length) buildCity();
          toast(blocked ? 'Buildings need OpenStreetMap, which this page cannot reach. See Settings.' : 'OpenStreetMap is busy. Some buildings are missing; try again from Settings.', 5000);
        });
      }
      return step();
    });
  }
  function describeCity() {
    var t = $('cityText'), b = $('cityLoad'), n = city.data ? city.data.buildings.length : 0, got = city.done.filter(Boolean).length;
    if (city.status === 'loading') t.textContent = 'Loading from OpenStreetMap: ' + got + ' of ' + (city.total || 7) + ' stretches of the course' + (n ? ', ' + n + ' buildings so far.' : '.');
    else if (city.status === 'error') t.textContent = city.err + (n ? ' Showing ' + n + ' buildings loaded earlier.' : '');
    else if (city.status === 'ready' && city.stats) {
      var st = city.stats;
      t.textContent = n + ' buildings, ' + city.data.trees.length + ' trees and ' + city.data.greens.length + ' parks from OpenStreetMap, saved ' + new Date(city.saved).toLocaleDateString() + '. Heights: ' +
        st.pctHeight + '% tagged, ' + st.pctLevels + '% from storey counts (3.2 m a storey), ' + st.pctDefault + '% estimated from the building type. ' + (st.culled ? st.culled + ' that the traced course runs through are left out.' : '');
    } else t.textContent = 'Real building outlines and heights from OpenStreetMap load the first time you open Street view, then are kept in this browser for 30 days.';
    b.disabled = city.status === 'loading';
    b.textContent = city.status === 'loading' ? 'Loading\u2026' : city.status === 'ready' ? 'Reload from OpenStreetMap' : city.status === 'error' ? 'Try again' : 'Load buildings';
    $('osmAttr').hidden = !(n && state.showCity && state.view !== '2d');
  }
  var WALL = {
    light: { residential: 0xeceae6, commercial: 0xdde4ec, civic: 0xe9e2d8, industrial: 0xd6d9dd, light: 0xc9ced6, other: 0xe4e6ea, glass: '#93a3ba', tree: 0x5f9a52, trunk: 0x7a6250, green: 0xcfe5c4 },
    dark: { residential: 0x3b4262, commercial: 0x34405e, civic: 0x3f3f5c, industrial: 0x353a4d, light: 0x2c3145, other: 0x383e5a, glass: '#4a5373', tree: 0x1f5a3c, trunk: 0x3b3230, green: 0x0f2c2a }
  };
  function windowTextures(dark, glass) {
    var c = document.createElement('canvas'), e = document.createElement('canvas'); c.width = c.height = e.width = e.height = 256;
    var x = c.getContext('2d'), y = e.getContext('2d'), seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 256, 256); y.fillStyle = '#000000'; y.fillRect(0, 0, 256, 256);
    for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
      x.fillStyle = glass; x.fillRect(i * 64 + 12, j * 64 + 18, 40, 28);
      if (dark && rnd() < 0.36) { y.fillStyle = rnd() < 0.8 ? '#ffd27a' : '#cfe2ff'; y.fillRect(i * 64 + 12, j * 64 + 18, 40, 28); }
    }
    function tex(cv) { var t = new T3.CanvasTexture(cv); t.wrapS = t.wrapT = T3.RepeatWrapping; t.anisotropy = Math.min(4, three.renderer.capabilities.getMaxAnisotropy()); return t; }
    return { map: tex(c), emissive: dark ? tex(e) : null };
  }
  function disposeAll(g) {
    for (var i = g.children.length - 1; i >= 0; i--) {
      var c = g.children[i]; g.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach(function (m) { if (m.userData.gone) return; m.userData.gone = true; if (m.map) m.map.dispose(); if (m.emissiveMap) m.emissiveMap.dispose(); m.dispose(); });
    }
  }
  function buildCity() {
    if (!three || !city.data) return;
    disposeAll(three.cityGroup); disposeAll(three.greenGroup);
    var dark = state.theme === 'dark', P = WALL[dark ? 'dark' : 'light'], d = city.data;
    var rings = d.buildings.map(function (b) { var r = []; for (var i = 0; i < b.ll.length; i += 2) { var p = proj.toXY(b.ll[i], b.ll[i + 1]); r.push(p[0], p[1]); } return r; });
    var hit = C.corridorHits(rings, route.xy, ROAD_W / 2 + 2), cells = {}, CELL = 400, nH = 0, nL = 0, nD = 0, culled = 0, col = new T3.Color(), tmp = new T3.Color();
    d.buildings.forEach(function (b, bi) {
      if (hit[bi]) { culled++; return; }
      var r = rings[bi], n = r.length / 2;
      if (C.ringArea(r) < 0) { var rv = []; for (var q = n - 1; q >= 0; q--) rv.push(r[q * 2], r[q * 2 + 1]); r = rv; }    // counter-clockwise
      if (b.src === 'height') nH++; else if (b.src === 'levels') nL++; else nD++;
      var cx = 0, cy = 0; for (var i = 0; i < n; i++) { cx += r[i * 2]; cy += r[i * 2 + 1]; }
      var key = Math.floor(cx / n / CELL) + ':' + Math.floor(cy / n / CELL), c = cells[key] || (cells[key] = { wp: [], wn: [], wu: [], wc: [], rp: [], rc: [] });
      var jit = ((b.id * 2654435761) % 1000) / 1000 - 0.5;
      col.set(P[b.kind] || P.other); col.offsetHSL(0, 0, jit * 0.06);
      var plain = b.kind === 'light', per = 0, h = b.h, mh = b.minH;
      for (i = 0; i < n; i++) {
        var j = (i + 1) % n, ax = r[i * 2], ay = r[i * 2 + 1], bx = r[j * 2], by = r[j * 2 + 1], len = Math.hypot(bx - ax, by - ay);
        if (len < 0.2) continue;
        var nx = (by - ay) / len, ny = -(bx - ax) / len, u0 = per / 14.4, u1 = (per + len) / 14.4, v0 = mh / 12.8, v1 = h / 12.8;
        if (plain) { u0 = u1 = 0.02; v0 = v1 = 0.02; }
        per += len;
        tmp.copy(col).multiplyScalar(0.9 + 0.1 * Math.abs(nx));      // faint per-facade variation
        c.wp.push(ax, mh, -ay, bx, mh, -by, bx, h, -by, ax, mh, -ay, bx, h, -by, ax, h, -ay);
        for (var k = 0; k < 6; k++) { c.wn.push(nx, 0, -ny); c.wc.push(tmp.r, tmp.g, tmp.b); }
        c.wu.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
      }
      try {
        var contour = []; for (i = 0; i < n; i++) contour.push(new T3.Vector2(r[i * 2], r[i * 2 + 1]));
        var tris = T3.ShapeUtils.triangulateShape(contour, []);
        tmp.copy(col).multiplyScalar(0.84);
        tris.forEach(function (tr) { tr.forEach(function (vi) { c.rp.push(r[vi * 2], h, -r[vi * 2 + 1]); c.rc.push(tmp.r, tmp.g, tmp.b); }); });
      } catch (e) { /* skip a roof that will not triangulate */ }
    });
    var tx = windowTextures(dark, P.glass);
    var wallMat = new T3.MeshLambertMaterial({ vertexColors: true, map: tx.map, side: T3.DoubleSide });
    if (tx.emissive) { wallMat.emissive = new T3.Color(0xffffff); wallMat.emissiveMap = tx.emissive; wallMat.emissiveIntensity = 0.85; }
    var roofMat = new T3.MeshLambertMaterial({ vertexColors: true, side: T3.DoubleSide });
    var first = true;
    Object.keys(cells).forEach(function (key) {
      var c = cells[key];
      if (c.wp.length) {
        var g = new T3.BufferGeometry();
        g.setAttribute('position', new T3.Float32BufferAttribute(c.wp, 3)); g.setAttribute('normal', new T3.Float32BufferAttribute(c.wn, 3));
        g.setAttribute('uv', new T3.Float32BufferAttribute(c.wu, 2)); g.setAttribute('color', new T3.Float32BufferAttribute(c.wc, 3)); g.computeBoundingSphere();
        var m = new T3.Mesh(g, wallMat); if (!first) m.userData.shared = true; three.cityGroup.add(m); first = false;
      }
      if (c.rp.length) {
        var g2 = new T3.BufferGeometry(); g2.setAttribute('position', new T3.Float32BufferAttribute(c.rp, 3)); g2.setAttribute('color', new T3.Float32BufferAttribute(c.rc, 3));
        g2.computeVertexNormals(); g2.computeBoundingSphere(); three.cityGroup.add(new T3.Mesh(g2, roofMat));
      }
    });
    // trees: trunk + crown, sized from the height tag when there is one (8 m otherwise)
    var trees = d.trees.map(function (t) { var p = proj.toXY(t.ll[0], t.ll[1]); return { x: p[0], y: p[1], h: t.h || 8 }; });
    var treeHit = C.corridorHits(trees.map(function (t) { return [t.x - 0.5, t.y - 0.5, t.x + 0.5, t.y - 0.5, t.x + 0.5, t.y + 0.5, t.x - 0.5, t.y + 0.5]; }), route.xy, ROAD_W / 2 + 0.5);
    trees = trees.filter(function (t, i) { return !treeHit[i]; });
    if (trees.length) {
      var trunk = new T3.InstancedMesh(new T3.CylinderGeometry(0.16, 0.24, 1, 6), new T3.MeshLambertMaterial({ color: P.trunk }), trees.length);
      var crown = new T3.InstancedMesh(new T3.IcosahedronGeometry(1, 0), new T3.MeshLambertMaterial({ color: P.tree, flatShading: true }), trees.length);
      var M4 = new T3.Matrix4(), Q = new T3.Quaternion(), S = new T3.Vector3();
      trees.forEach(function (t, i) {
        var th = t.h * 0.45, cr = t.h * 0.32;
        M4.compose(new T3.Vector3(t.x, th / 2, -t.y), Q, S.set(1, th, 1)); trunk.setMatrixAt(i, M4);
        Q.setFromAxisAngle(new T3.Vector3(0, 1, 0), (i * 1.7) % 6.28);
        M4.compose(new T3.Vector3(t.x, th + cr * 0.7, -t.y), Q, S.set(cr, cr * 1.1, cr)); crown.setMatrixAt(i, M4); Q.identity();
      });
      three.cityGroup.add(trunk); three.cityGroup.add(crown);
    }
    // parks and green areas, flat in the ground pass
    var gm = new T3.MeshBasicMaterial({ color: P.green, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: T3.DoubleSide });
    d.greens.forEach(function (gr) {
      try {
        var pts = []; for (var i = 0; i < gr.ll.length; i += 2) { var p = proj.toXY(gr.ll[i], gr.ll[i + 1]); pts.push(new T3.Vector2(p[0], p[1])); }
        var tris = T3.ShapeUtils.triangulateShape(pts, []), pos = [];
        tris.forEach(function (tr) { tr.forEach(function (vi) { pos.push(pts[vi].x, 0, -pts[vi].y); }); });
        var gg = new T3.BufferGeometry(); gg.setAttribute('position', new T3.Float32BufferAttribute(pos, 3));
        var mesh = new T3.Mesh(gg, gm); mesh.renderOrder = 2; three.greenGroup.add(mesh);
      } catch (e) { /* skip */ }
    });
    var tot = Math.max(1, nH + nL + nD);
    city.stats = { pctHeight: Math.round(nH / tot * 100), pctLevels: Math.round(nL / tot * 100), pctDefault: Math.round(nD / tot * 100), culled: culled, shown: nH + nL + nD };
    three.cityGroup.visible = three.greenGroup.visible = state.showCity;
    describeCity(); invalidate();
  }

  // chase camera for the street view: follows the runner from behind, with drag-to-look offsets
  var sc = { yaw: null, yawOff: 0, pitch: 0.2, dist: 9, snap: true };
  function streetHeading(km) {
    var a = posAtKm(Math.max(0, km - 0.006)), b = posAtKm(Math.min(COURSE_KM, km + 0.028));
    return Math.atan2(b.y - a.y, b.x - a.x);
  }
  function updateStreetCam(dt) {
    var p = posAtKm(state.km), h = streetY(state.km), want = streetHeading(state.km);
    if (sc.yaw == null || sc.snap || reduceMotion) { sc.yaw = want; sc.snap = false; }
    else { var d = Math.atan2(Math.sin(want - sc.yaw), Math.cos(want - sc.yaw)); sc.yaw += d * (1 - Math.exp(-dt * 5)); if (Math.abs(d) > 0.002) dirty = true; }
    var th = sc.yaw + sc.yawOff, fx = Math.cos(th), fy = Math.sin(th), hz = sc.dist * Math.cos(sc.pitch), up = sc.dist * Math.sin(sc.pitch);
    three.camera.position.copy(W(p.x - fx * hz, p.y - fy * hz, Math.max(h + 0.6, h + 1.4 + up)));
    three.camera.lookAt(W(p.x + fx * 7, p.y + fy * 7, h + 1.1));
  }

  // ---- camera
  function fitDistance(radius) {
    var cam = three.camera, v = cam.fov * Math.PI / 360, h = Math.atan(Math.tan(v) * cam.aspect);
    return radius / Math.sin(Math.min(v, h)) * (cam.aspect < 1 ? 0.8 : 0.92);
  }
  function viewPreset(name) {
    var b = route.bbox, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, r = Math.hypot(b[2] - b[0], b[3] - b[1]) / 2;
    var target = W(cx, cy, 0), d = fitDistance(r), az, el;
    if (name === 'top') { az = 0; el = 89.2; }
    else if (name === 'iso') { az = 205; el = 38; d *= 0.9; }
    else { az = { n: 0, e: 90, s: 180, w: 270 }[name]; el = 24; d *= 0.85; }
    // az = compass bearing of the camera as seen from the target
    var a = az * Math.PI / 180, e = el * Math.PI / 180;
    var pos = W(cx + Math.sin(a) * Math.cos(e) * d, cy + Math.cos(a) * Math.cos(e) * d, Math.sin(e) * d);
    if (name === 'top') pos = W(cx, cy - d * 0.014, d);        // a hair south keeps north up
    return { pos: pos, target: target };
  }
  function flyTo(pos, target, ms) {
    if (!three) return;
    if (reduceMotion || !ms) { three.camera.position.copy(pos); three.controls.target.copy(target); three.controls.update(); three.tween = null; invalidate(); return; }
    three.tween = { t0: performance.now(), ms: ms, p0: three.camera.position.clone(), p1: pos, q0: three.controls.target.clone(), q1: target };
    invalidate();
  }
  function focusItem(s) {
    if (!three) return;
    if (state.view === 'street') {
      var k0 = s.type === 'section' ? s.from : s.type === 'turn' ? s.km - 0.06 : s.km - (s.type === 'landmark' ? 0.08 : 0.02);
      setKm(Math.max(0, k0), true); return;
    }
    var x, y, h = 0, dist = 2600;
    if (s.type === 'section') { var m = posAtKm((s.from + s.to) / 2); x = m.x; y = m.y; h = m.el * state.exag; dist = Math.max(1800, (s.to - s.from) * 1000 * 1.9); }
    else if (s.type === 'landmark') { x = s.x; y = s.y; }
    else { var p = posAtKm(s.km); x = p.x; y = p.y; h = p.el * state.exag; }
    var target = W(x, y, h), off = three.camera.position.clone().sub(three.controls.target);
    off.y = Math.max(off.y, off.length() * 0.45); off.setLength(dist);
    flyTo(target.clone().add(off), target, 900);
  }

  // ---- label layout: constant-size labels, hide the ones that collide with a more important one
  var _v = null;
  function declutter() {
    three.camera.updateMatrixWorld();                      // the camera may have moved since the last render
    var L = three.labels, w = three.size.w, h = three.size.h, placed = [], sr = $('stage').getBoundingClientRect();
    if (!_v) _v = new T3.Vector3();
    ['readout', 'views', 'nav', 'streetHint'].forEach(function (id) {          // keep labels out from under the overlays
      var e = $(id); if (e.hidden) return; var r = e.getBoundingClientRect();
      placed.push({ sx: (r.left + r.right) / 2 - sr.left, sy: r.bottom - sr.top, w: r.width, h: r.height });
    });
    L.forEach(function (l) {
      _v.copy(l.anchor).project(three.camera);
      l.sx = (_v.x * 0.5 + 0.5) * w; l.sy = (-_v.y * 0.5 + 0.5) * h; l.on = _v.z < 1 && _v.z > -1;
      l.w = l.o.px * l.o.aspect; l.h = l.o.px;
      l.want = l.on && (l.group === 'km' ? state.showKm : state.showLm);
      if (l.want && state.view === 'street' && three.camera.position.distanceTo(l.anchor) > 3000) l.want = false;
      l.p = l.prio + (state.sel === l.item.id ? 100 : 0) + (l.vis ? 0.5 : 0);
    });
    L.slice().sort(function (a, b) { return b.p - a.p; }).forEach(function (l) {
      var vis = l.want;
      if (vis) for (var i = 0; i < placed.length; i++) {
        var q = placed[i];
        if (Math.abs(l.sx - q.sx) < (l.w + q.w) / 2 + 3 && l.sy - l.h < q.sy + 3 && q.sy - q.h < l.sy + 3) { vis = false; break; }
      }
      if (vis) placed.push(l);
      l.o.sprite.visible = vis; l.vis = vis;
    });
    if (three.stems) three.stems.visible = state.showKm || state.showLm;
  }
  // tap: nearest visible label, else nearest point of the course
  function pick(cx, cy) {
    var best = null, bd = 30;
    three.labels.forEach(function (l) {
      if (!l.vis) return;
      var dx = Math.max(0, Math.abs(cx - l.sx) - l.w / 2), dy = Math.max(0, Math.abs(cy - (l.sy - l.h / 2)) - l.h / 2), d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = l; }
    });
    if (best) return { item: best.item };
    var w = three.size.w, h = three.size.h, bk = -1, bdd = 26; if (!_v) _v = new T3.Vector3();
    for (var i = 0; i < route.dense.length; i += 2) {
      var p = route.dense[i]; _v.set(p.x, courseY(p.km), -p.y).project(three.camera);
      if (_v.z > 1 || _v.z < -1) continue;
      var d2 = Math.hypot((_v.x * 0.5 + 0.5) * w - cx, (-_v.y * 0.5 + 0.5) * h - cy);
      if (d2 < bdd) { bdd = d2; bk = p.km; }
    }
    return bk >= 0 ? { km: bk } : null;
  }

  function resize() {
    var st = $('stage'), w = Math.max(1, st.clientWidth), h = Math.max(1, st.clientHeight);
    if (three) {
      three.size.w = w; three.size.h = h;
      three.renderer.setSize(w, h, false); three.camera.aspect = w / h; three.camera.updateProjectionMatrix();
      three.labels.forEach(function (l) { sizeSprite(l.o); }); sizeSprite(three.runner);
      three.lastDeclutter = 0; invalidate();
    }
    drawChart();
    if (map2d) map2d.map.invalidateSize();
  }

  // ---------------------------------------------------------------- 2D map (Leaflet)
  var map2d = null;
  function initMap() {
    var Lf = window.L;
    if (!Lf) { $('mapnote').hidden = false; $('mapnote').textContent = 'The map library did not load, so the 2D view is unavailable here.'; return; }
    var map = Lf.map('map2d', { zoomControl: false, attributionControl: true, preferCanvas: true });
    Lf.control.zoom({ position: 'topright' }).addTo(map);
    map2d = { map: map, Lf: Lf, layer: Lf.layerGroup().addTo(map), runner: null, tiles: null };
    setTiles();
    drawMapRoute(true);
  }
  // Tile source. OpenStreetMap's server needs no key but refuses pages opened from a file; its tiles are
  // recoloured with a CSS filter to match the theme. CARTO's light and dark styles need a free key.
  var OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', K_TILES = 'sgim26hm.tiles.v2';
  function validTileUrl(u) { return /^https:\/\/[^\s<>"']+$/.test(u) && u.indexOf('{z}') > 0 && u.indexOf('{x}') > 0 && u.indexOf('{y}') > 0; }
  function tileConfig() {
    var c = store.get(K_TILES) || store.get('sgim26hm.tiles.v1');
    if (c && !c.provider && c.url) c = { provider: 'custom', url: c.url, attribution: c.attribution };   // earlier format
    if (!c || !/^(osm|carto|custom)$/.test(c.provider)) return { provider: 'osm' };
    if (c.provider === 'custom' && !(typeof c.url === 'string' && validTileUrl(c.url))) return { provider: 'osm' };
    if (c.provider === 'carto' && !(typeof c.key === 'string' && /^[\w.-]{8,200}$/.test(c.key))) return { provider: 'osm' };
    return { provider: c.provider, key: c.key || '', url: c.url || '', attribution: String(c.attribution || '').slice(0, 200) };
  }
  function tileSource(cfg) {
    var osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    if (cfg.provider === 'carto') return { url: 'https://basemaps.cartocdn.com/rastertiles/' + (state.theme === 'dark' ? 'dark_all' : 'light_all') + '/{z}/{x}/{y}.png?key=' + encodeURIComponent(cfg.key), attribution: osmAttr + ', &copy; <a href="https://carto.com/attributions">CARTO</a>', filter: false };
    if (cfg.provider === 'custom') { var div = document.createElement('div'); div.textContent = cfg.attribution; return { url: cfg.url, attribution: div.innerHTML, filter: false }; }
    return { url: OSM_TILES, attribution: osmAttr, filter: true };
  }
  function setTiles() {
    if (!map2d) return;
    var Lf = map2d.Lf, cfg = tileConfig(), src = tileSource(cfg), note = $('mapnote');
    if (map2d.tiles) { map2d.map.removeLayer(map2d.tiles); map2d.tiles = null; }
    note.hidden = true; $('map2d').classList.toggle('tiles-osm', src.filter);
    if (cfg.provider === 'osm' && location.protocol === 'file:') {
      // OpenStreetMap's servers refuse tile requests that carry no Referer, and a page opened from disk sends none.
      note.hidden = state.view !== '2d';
      note.textContent = 'Street tiles are off: OpenStreetMap blocks pages opened straight from a file. Serve this folder over http (for example python3 -m http.server, then open http://localhost:8000) or choose CARTO with a free key under Settings, Map tiles.';
      map2d.noTilesNote = note.textContent; return;
    }
    map2d.noTilesNote = '';
    var tiles = Lf.tileLayer(src.url, { maxZoom: 19, referrerPolicy: 'strict-origin-when-cross-origin', attribution: src.attribution });
    var loaded = 0, failed = 0;
    tiles.on('tileload', function () { loaded++; });
    tiles.on('tileerror', function () {
      failed++;
      if (!loaded && failed >= 2) { note.hidden = state.view !== '2d'; note.textContent = cfg.provider === 'osm' ? 'Map tiles are blocked here. Pages inside Claude cannot load images from other sites, so only the route is drawn. Open the downloaded HTML file from a web server to see the street map.' : 'The tile provider is not returning images. Check the key or URL under Settings, Map tiles.'; map2d.noTilesNote = note.textContent; }
    });
    tiles.addTo(map2d.map); map2d.tiles = tiles;
  }
  function syncTileForm() {
    var cfg = tileConfig(), sel = $('tileProv');
    if (!sel.dataset.touched) sel.value = cfg.provider;
    var p = sel.value;
    $('tileKeyRow').hidden = p !== 'carto'; $('tileCustomRow').hidden = p !== 'custom';
    if (cfg.provider === 'carto') $('tileKey').value = cfg.key;
    if (cfg.provider === 'custom') { $('tileUrl').value = cfg.url; $('tileAttr').value = cfg.attribution; }
    $('tileHelp').textContent = p === 'osm' ? 'No key needed, but OpenStreetMap only serves pages opened from a web address, not straight from a file. The tiles are recoloured to suit the theme.'
      : p === 'carto' ? 'CARTO serves matching light and dark maps. Since 25 September 2026 they need a key, free for personal use; request one at carto.com/basemaps/apikey.'
      : 'Paste the provider\u2019s tile URL with {z}, {x} and {y} and your key, plus the attribution it requires.';
  }
  function drawMapRoute(fit) {
    if (!map2d) return;
    var Lf = map2d.Lf, g = map2d.layer; g.clearLayers();
    var ll = route.xy.map(function (p) { return proj.toLL(p[0], p[1]); });
    var mc = TH().map;
    if (state.source === 'osm') Lf.polyline(traceXY.map(function (p) { return proj.toLL(p[0], p[1]); }), { color: mc.ghost, weight: 2, opacity: 0.6, dashArray: '4 6', interactive: false }).addTo(g);
    var line = Lf.polyline(ll, { color: mc.route, weight: 5, opacity: 0.95 }).addTo(g);
    line.on('click', function (e) { var xy = proj.toXY(e.latlng.lat, e.latlng.lng); setKm(nearestKmTo(xy[0], xy[1]).km, true); });
    for (var k = 0; k <= 21; k++) {
      var p = posAtKm(k), q = proj.toLL(p.x, p.y);
      Lf.circleMarker(q, { radius: 7, color: mc.route, weight: 2, fillColor: mc.kmFill, fillOpacity: 1 }).bindTooltip(k === 0 ? 'Start' : k + ' km', { direction: 'top' }).addTo(g);
    }
    items.forEach(function (it) {
      if (it.type !== 'landmark') return;
      var q = proj.toLL(it.x, it.y);
      Lf.circleMarker(q, { radius: 5, color: mc.lmEdge, weight: 1.5, fillColor: mc.lmFill, fillOpacity: 1 }).bindTooltip(it.name, { direction: 'top' }).on('click', function () { select(it.id, false); }).addTo(g);
    });
    var r0 = posAtKm(state.km);
    map2d.runner = Lf.circleMarker(proj.toLL(r0.x, r0.y), { radius: 8, color: '#1b1400', weight: 2, fillColor: '#ffd447', fillOpacity: 1, interactive: false }).addTo(g);
    if (fit) map2d.map.fitBounds(line.getBounds(), { padding: [20, 20] });
  }

  // ---------------------------------------------------------------- elevation chart (also the timeline)
  var chart = { c: $('chart'), x0: 34, x1: 0, y0: 0, y1: 0, ymin: 0, ymax: 32 };
  var T3c = window.THREE || { Color: function (h) { this.getHexString = function () { return ('000000' + h.toString(16)).slice(-6); }; } };
  function drawChart() {
    var c = chart.c, w = c.clientWidth, h = c.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w < 10 || h < 10) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    var x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    var L = chart.x0, R = w - 12, T = 22, B = h - 18; chart.x1 = R; chart.y0 = T; chart.y1 = B;
    var X = function (km) { return L + (R - L) * km / COURSE_KM; }, Y = function (m) { return B - (B - T) * (m - chart.ymin) / (chart.ymax - chart.ymin); };
    x.font = '11px Barlow, Arial, sans-serif'; x.textBaseline = 'middle';
    // grid
    var cc = TH().chart, courseCss = '#' + new T3c.Color(COL.course).getHexString(), runCss = '#' + new T3c.Color(COL.runner).getHexString();
    x.strokeStyle = cc.grid; x.fillStyle = cc.text; x.lineWidth = 1;
    [0, 10, 20, 30].forEach(function (m) { var y = Math.round(Y(m)) + 0.5; x.beginPath(); x.moveTo(L, y); x.lineTo(R, y); x.stroke(); x.textAlign = 'right'; x.fillText(m + ' m', L - 5, y); });
    x.textAlign = 'center'; x.textBaseline = 'top';
    var step = w < 520 ? 5 : (w < 900 ? 2 : 1);
    for (var k = 0; k <= 20; k += step) { var xx = Math.round(X(k)) + 0.5; x.beginPath(); x.moveTo(xx, B); x.lineTo(xx, B + 3); x.stroke(); x.fillText(String(k), xx, B + 4); }
    x.textAlign = 'right'; x.fillText('km', R + 10, B + 4);
    // selected section band
    var s = state.sel && itemById(state.sel);
    if (s && s.type === 'section') { x.fillStyle = state.theme === 'dark' ? 'rgba(255,212,71,.18)' : 'rgba(224,148,0,.16)'; x.fillRect(X(s.from), T, X(s.to) - X(s.from), B - T); }
    // profile
    var kms = DATA.elev.km, ms = DATA.elev.m, i;
    x.beginPath(); x.moveTo(X(0), B);
    for (i = 0; i < kms.length; i++) x.lineTo(X(kms[i]), Y(ms[i]));
    x.lineTo(X(COURSE_KM), B); x.closePath();
    var gr = x.createLinearGradient(0, T, 0, B); gr.addColorStop(0, cc.fillTop); gr.addColorStop(1, cc.fillBot);
    x.fillStyle = gr; x.fill();
    x.beginPath(); for (i = 0; i < kms.length; i++) { if (i) x.lineTo(X(kms[i]), Y(ms[i])); else x.moveTo(X(kms[i]), Y(ms[i])); }
    x.strokeStyle = courseCss; x.lineWidth = 2; x.lineJoin = 'round'; x.stroke();
    // turn ticks along the top of the profile
    x.fillStyle = TH().guide; turns.forEach(function (t) { if (t.type === 'depart' || t.type === 'arrive' || t.type === 'continue') return; x.fillRect(Math.round(X(t.km)) - 1, 4, 2, 6); });
    // labelled points: high and low
    x.font = '600 11px Barlow, Arial, sans-serif'; x.textBaseline = 'bottom';
    [[16.25, 27.9, 'Sheares Bridge 27.9 m', 'center'], [1.5, 4.7, 'Crawford 4.7 m', 'left']].forEach(function (a) {
      x.fillStyle = cc.strong; x.beginPath(); x.arc(X(a[0]), Y(a[1]), 3, 0, 6.2832); x.fill();
      x.textAlign = a[3];
      if (a[1] > 20) x.fillText(a[2], Math.min(X(a[0]), R - 60), Y(a[1]) - 5);
      else { x.textBaseline = 'top'; x.fillText(a[2], X(a[0]) + 6, Y(a[1]) + 1); x.textBaseline = 'bottom'; }
    });
    // cursor
    var cx = X(state.km), cy = Y(elevAt(state.km));
    x.strokeStyle = runCss; x.lineWidth = 1.5; x.beginPath(); x.moveTo(cx, T - 6); x.lineTo(cx, B); x.stroke();
    x.fillStyle = runCss; x.strokeStyle = '#1b1400'; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, 5, 0, 6.2832); x.fill(); x.stroke();
  }
  function chartKm(ev) {
    var r = chart.c.getBoundingClientRect(), px = ev.clientX - r.left;
    return Math.max(0, Math.min(COURSE_KM, (px - chart.x0) / (chart.x1 - chart.x0) * COURSE_KM));
  }

  // ---------------------------------------------------------------- UI updates
  function fmtClock(sec) {
    var t = Math.round(sec / 60), h = Math.floor(t / 60) % 24, m = t % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }
  function updateReadout() {
    var km = state.km, el = elevAt(km), g = gradeAt(km), el_s = timeAt(km);
    $('roKm').textContent = km.toFixed(2);
    $('roEl').textContent = el.toFixed(1) + ' m';
    $('roGr').textContent = (g > 0.05 ? '+' : '') + g.toFixed(1) + '%';
    $('roT').textContent = C.fmtTime(el_s);
    $('roC').textContent = fmtClock(FLAG_OFF_S + el_s);
    $('roP').textContent = C.fmtPace(C.paceAtKm(pacing, km)) + ' /km';
    $('roSec').textContent = sectionAt(km).name;
    updateNav();
    chart.c.setAttribute('aria-valuenow', km.toFixed(2));
    chart.c.setAttribute('aria-valuetext', km.toFixed(1) + ' kilometres, ' + el.toFixed(0) + ' metres, ' + sectionAt(km).name);
  }
  function updateNav() {
    if (!turns.length) return;
    var km = state.km, i = C.nextTurnIndex(turns, km), t = turns[i], d = Math.max(0, (t.km - km) * 1000);
    var start = t.type === 'depart';
    setArrow($('navIcon'), t);
    $('navDist').textContent = start ? 'Start' : t.type === 'arrive' ? (d < 20 ? 'Finish' : fmtDist(d)) : fmtDist(d);
    $('navIns').textContent = t.text;
    var nx = turns[i + 1], showThen = nx && !start && nx.type !== 'arrive' && (nx.km - t.km) < 0.3;
    $('navThen').hidden = !showThen;
    if (showThen) { setArrow($('navThenIcon'), nx); $('navThenText').textContent = 'Then ' + nx.text.charAt(0).toLowerCase() + nx.text.slice(1); }
    $('roNext').textContent = start ? t.text : t.type === 'arrive' ? 'Finish in ' + fmtDist(d) : 'Next: ' + t.text + (d >= 20 ? ' in ' + fmtDist(d) : ' now');
  }
  function setKm(km, user) {
    if (user && !state.playing) sc.snap = true;
    state.km = Math.max(0, Math.min(COURSE_KM, km));
    if (user && state.playing && state.km >= COURSE_KM) setPlaying(false);
    placeRunner(); updateReadout(); drawChart();
    if (map2d && map2d.runner) { var p = posAtKm(state.km); map2d.runner.setLatLng(proj.toLL(p.x, p.y)); }
    invalidate();
  }
  function setPlaying(on) {
    if (on && state.km >= COURSE_KM - 1e-6) state.km = 0;
    state.playing = on; $('play').textContent = on ? 'Pause' : 'Play'; lastT = 0; invalidate();
  }
  var toastTimer = 0;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3200);
  }

  function renderList() {
    var q = state.query.trim().toLowerCase(), ul = $('list'); ul.textContent = '';
    var rows = items.filter(function (it) {
      if (it.hiddenInList && !q && state.filter !== it.type) return false;
      if (state.filter !== 'all' && it.type !== state.filter) return false;
      return !q || it.search.indexOf(q) >= 0;
    }).sort(function (a, b) { return a.km - b.km || a.name.localeCompare(b.name); });
    if (!rows.length) { var e = document.createElement('li'); e.className = 'empty'; e.textContent = 'Nothing matches “' + state.query + '”. Try a road or landmark name.'; ul.appendChild(e); return; }
    rows.forEach(function (it) {
      var li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
      if (state.sel === it.id) b.setAttribute('aria-current', 'true');
      var km = document.createElement('span'); km.className = 'km num';
      km.textContent = it.type === 'section' ? it.from.toFixed(1) + '–' + it.to.toFixed(1) : it.id === 'kmfin' ? '21.1' : it.km.toFixed(it.type === 'km' ? 0 : 1);
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name;
      var tag = document.createElement('span'); tag.className = 'tag';
      var prevKm = it.type === 'km' ? (it.prevKm != null ? it.prevKm : it.km - 1) : 0;
      tag.textContent = it.type === 'turn' ? (it.turn.type === 'uturn' ? 'U-turn' : it.turn.type === 'continue' ? 'road name' : it.turn.dir) : it.type === 'landmark' ? 'landmark' : it.type === 'section' ? (it.inferred ? 'road, name inferred' : 'road') : it.type === 'point' ? it.el.toFixed(1) + ' m' : 'split ' + C.fmtPace(timeAt(it.km) - timeAt(prevKm)) + (it.id === 'kmfin' ? ' (98 m)' : '');
      nm.appendChild(tag);
      if (it.type === 'km') { var sp = document.createElement('span'); sp.className = 'sub num'; sp.textContent = 'Elapsed ' + C.fmtTime(timeAt(it.km)) + ' · clock ' + fmtClock(FLAG_OFF_S + timeAt(it.km)) + ' · ' + elevAt(it.km).toFixed(1) + ' m'; nm.appendChild(sp); }
      if (it.text) { var sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = it.text; nm.appendChild(sub); }
      b.appendChild(km); b.appendChild(nm);
      b.addEventListener('click', function () { select(it.id, true); });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  function renderInfo() {
    var box = $('info'), s = state.sel && itemById(state.sel); box.textContent = '';
    if (!s) { box.hidden = true; return; }
    box.hidden = false;
    var h = document.createElement('h2'); h.textContent = s.name; box.appendChild(h);
    if (s.text) { var p = document.createElement('p'); p.textContent = s.text; box.appendChild(p); }
    var dl = document.createElement('dl');
    function row(k, v) { var dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dd.className = 'num'; dl.appendChild(dt); dl.appendChild(dd); }
    var goKm = s.km;
    if (s.type === 'section') {
      var a = elevAt(s.from), b = elevAt(s.to), hi = -1e9, lo = 1e9;
      for (var k = s.from; k <= s.to + 1e-9; k += 0.01) { var e = elevAt(k); hi = Math.max(hi, e); lo = Math.min(lo, e); }
      row('Course', s.from.toFixed(2) + ' to ' + s.to.toFixed(2) + ' km (' + ((s.to - s.from) * 1000).toFixed(0) + ' m)');
      row('Elevation', a.toFixed(1) + ' m in, ' + b.toFixed(1) + ' m out; ' + lo.toFixed(1) + ' to ' + hi.toFixed(1) + ' m');
      row('You arrive', C.fmtTime(timeAt(s.from)) + ' (' + fmtClock(FLAG_OFF_S + timeAt(s.from)) + ')');
      row('Time on this section', C.fmtTime(timeAt(s.to) - timeAt(s.from)) + ', ' + C.fmtPace((timeAt(s.to) - timeAt(s.from)) / (s.to - s.from)) + ' /km');
      if (s.inferred) row('Road name', 'Inferred from the map, not labelled on it');
    } else if (s.type === 'turn') {
      var tt = s.turn;
      row('Course', s.km.toFixed(2) + ' km, ' + elevAt(s.km).toFixed(1) + ' m');
      row('You arrive', C.fmtTime(timeAt(s.km)) + ' (' + fmtClock(FLAG_OFF_S + timeAt(s.km)) + ')');
      row('Turn', tt.type === 'continue' ? 'Straight on (' + Math.abs(tt.angle) + '\u00b0)' : Math.abs(tt.angle) + '\u00b0 ' + (tt.dir || ''));
      row('Road after', tt.road.replace(/^the /, ''));
      row('Source', 'Worked out from the traced line; check complex junctions against the official map');
      goKm = Math.max(0, s.km - 0.06);
    } else if (s.type === 'landmark') {
      row('Closest point on course', s.km.toFixed(2) + ' km, about ' + (s.nearM < 50 ? 'on the route' : Math.round(s.nearM / 10) * 10 + ' m away'));
      row('You pass at', C.fmtTime(timeAt(s.km)) + ' (' + fmtClock(FLAG_OFF_S + timeAt(s.km)) + ')');
      row('Position', 'Read from the route map, approximate');
    } else {
      row('Course', s.km.toFixed(s.type === 'km' ? 0 : 2) + ' km');
      row('Elevation', elevAt(s.km).toFixed(1) + ' m, gradient ' + gradeAt(s.km).toFixed(1) + '%');
      row('You arrive', C.fmtTime(timeAt(s.km)) + ' (' + fmtClock(FLAG_OFF_S + timeAt(s.km)) + ')');
      row('Pace here', C.fmtPace(C.paceAtKm(pacing, s.km)) + ' /km');
      row('Road', sectionAt(Math.min(s.km, COURSE_KM - 0.001)).name);
    }
    box.appendChild(dl);
    var act = document.createElement('div'); act.className = 'actions';
    var go = document.createElement('button'); go.className = 'btn'; go.type = 'button'; go.textContent = 'Move runner here';
    go.addEventListener('click', function () { setKm(goKm, true); });
    var fc = document.createElement('button'); fc.className = 'btn'; fc.type = 'button'; fc.textContent = state.view === 'street' ? 'Show in street view' : 'Focus camera';
    fc.addEventListener('click', function () { if (state.view === '2d') setView('3d'); focusItem(s); closePanelOnPhone(); });
    var cl = document.createElement('button'); cl.className = 'btn'; cl.type = 'button'; cl.textContent = 'Clear';
    cl.addEventListener('click', function () { select(null, false); });
    act.appendChild(go); act.appendChild(fc); act.appendChild(cl); box.appendChild(act);
  }
  function select(id, fly) {
    state.sel = id;
    var s = id && itemById(id);
    renderInfo(); renderList(); rebuildSelection(); drawChart();
    if (three) three.lastDeclutter = 0;
    if (s) {
      setTab('places');
      if (fly && (state.view === '3d' || state.view === 'street')) focusItem(s);
      if (state.view === '2d' && map2d) {
        var p = s.type === 'landmark' ? s : posAtKm(s.type === 'section' ? (s.from + s.to) / 2 : s.km);
        map2d.map.panTo(proj.toLL(p.x, p.y));
      }
    }
    invalidate();
  }

  function isWide() { return window.matchMedia('(min-width: 960px)').matches; }
  function openPanel(on) { $('panel').hidden = !on && !isWide(); $('openPanel').setAttribute('aria-expanded', String(on)); }
  function closePanelOnPhone() { if (!isWide()) openPanel(false); }
  function setTab(name) {
    var places = name === 'places';
    $('tabPlaces').setAttribute('aria-pressed', String(places)); $('tabSettings').setAttribute('aria-pressed', String(!places));
    $('panePlaces').hidden = !places; $('paneSettings').hidden = places;
  }
  var overviewCam = null;
  function setView(v) {
    var was = state.view;
    if (v === 'street' && !three) { toast('Street view needs WebGL, which this browser could not start.', 4500); return; }
    state.view = v;
    $('view3d').setAttribute('aria-pressed', String(v === '3d')); $('view2d').setAttribute('aria-pressed', String(v === '2d')); $('viewStreet').setAttribute('aria-pressed', String(v === 'street'));
    $('map2d').hidden = v !== '2d'; $('views').hidden = v !== '3d' || !three;
    $('stage').classList.toggle('street', v === 'street');
    $('osmAttr').hidden = !(city.data && city.data.buildings.length && state.showCity && v !== '2d');
    $('nav').hidden = v !== 'street'; $('roNext').hidden = v === 'street'; $('streetHint').hidden = v !== 'street';
    $('exag').disabled = v === 'street'; $('follow').disabled = v === 'street';
    if (three && (v === 'street') !== (was === 'street')) {
      var cam = three.camera, fog = three.scene.fog, st = v === 'street';
      if (st) { overviewCam = { p: cam.position.clone(), t: three.controls.target.clone() }; three.tween = null; sc.snap = true; sc.yawOff = 0; if (state.showCity && (city.status === 'idle' || (city.status === 'ready' && city.done.some(function (x) { return !x; })))) loadCity(false); }
      three.controls.enabled = !st;
      cam.near = st ? 0.8 : 20; cam.far = st ? 4000 : 120000; cam.fov = st ? 55 : 38; cam.updateProjectionMatrix();
      fog.near = st ? 220 : 16000; fog.far = st ? 2600 : 70000;
      three.groundMesh.position.y = st ? -0.08 : -2;
      three.streetGroup.visible = st; three.routeGroup.visible = !st; three.osmGroup.visible = !st;
      three.runner.sprite.visible = !st; three.runnerStem.visible = !st;
      if (st) three.figure.group.scale.set(1.75, 1.75, 1.75);
      rebuildMarkers(); rebuildSelection(); placeRunner();
      three.labels.forEach(function (l) { sizeSprite(l.o); }); sizeSprite(three.runner);
      if (!st && overviewCam) { cam.position.copy(overviewCam.p); three.controls.target.copy(overviewCam.t); three.controls.update(); }
    }
    if (v !== '2d') $('mapnote').hidden = true;
    if (v === '2d') { if (!map2d) initMap(); else { map2d.map.invalidateSize(); drawMapRoute(false); if (map2d.noTilesNote) { $('mapnote').hidden = false; $('mapnote').textContent = map2d.noTilesNote; } } }
    invalidate();
  }

  var SUN = 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z';
  var MOON = 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z';
  function applyTheme() {
    var dark = state.theme === 'dark', th = TH(); COL = th.col;
    document.documentElement.classList.toggle('dark', dark);
    $('themeIcon').setAttribute('d', dark ? SUN : MOON);
    $('themeBtn').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    $('theme').value = state.theme;
    if (three) {
      three.renderer.setClearColor(th.sky, 1); three.scene.fog.color.set(th.sky); three.groundMesh.material.color.set(th.ground);
      three.bmU.cLand.value.set(th.land); three.bmU.cWater.value.set(th.water); three.bmU.cRoad.value.set(th.road);
      rebuildRoute(); rebuildStreet(); buildCity();
    }
    drawChart();
    if (map2d) { drawMapRoute(false); setTiles(); }
    invalidate();
  }

  // ---------------------------------------------------------------- data source: built-in trace or OpenStreetMap
  function describeSource() {
    var t = $('srcText'), badge = $('srcBadge'), st = state.osmStats;
    if (state.source === 'osm' && st) {
      t.innerHTML = '';
      t.appendChild(document.createTextNode('Snapped to OpenStreetMap roads' + (st.when ? ' on ' + st.when : '') + '. '));
      var b = document.createElement('b'); b.textContent = Math.round(st.matched * 100) + '% of the course matched a road';
      t.appendChild(b);
      t.appendChild(document.createTextNode('; the trace was moved ' + Math.round(st.shiftM) + ' m and scaled ' + ((st.scale - 1) * 100).toFixed(1) + '%. Centre-line length ' + (st.lengthM / 1000).toFixed(2) + ' km against the certified 21.0975 km; kilometre marks are spread in proportion.'));
      badge.textContent = 'Roads: OpenStreetMap';
    } else {
      t.textContent = 'Built-in trace of the organiser’s map, placed from landmarks. Expect positions to be tens of metres off in places. ' + (state.srcNote || 'Fetching OpenStreetMap roads lines the course up with the real streets.');
      badge.textContent = state.fetching ? 'Fetching roads…' : 'Roads: built-in trace';
    }
    $('fetchOsm').disabled = state.fetching;
    $('fetchOsm').textContent = state.fetching ? 'Fetching…' : (state.source === 'osm' ? 'Fetch again' : 'Fetch OpenStreetMap roads');
    $('useTrace').hidden = state.source !== 'osm';
  }
  function applyRoute(xy, source, stats) {
    state.source = source; state.osmStats = stats || null;
    applyFrame(source === 'osm' && stats ? stats.T : null);
    setRoute(xy); rebuildRoute(); rebuildStreet(); buildCity(); drawMapRoute(false); setKm(state.km); describeSource(); renderList();
  }
  var ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  function postOverpass(url, query, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query), signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return r.json(); })
      .then(function (j) { clearTimeout(timer); return j; }, function (e) { clearTimeout(timer); throw e; });
  }
  function fetchOsm(silent) {
    if (state.fetching) return Promise.resolve(false);
    state.fetching = true; state.srcNote = ''; describeSource();
    var ll = C.simplify(traceXY, 12).map(function (p) { return proj.toLL(p[0], p[1]); });
    var queries = [C.buildOverpassQuery(ll, 90), C.buildOverpassBBoxQuery(ll, 0.002)];
    var attempts = [];
    ENDPOINTS.forEach(function (u) { queries.forEach(function (q) { attempts.push([u, q]); }); });
    var lastErr = null, i = 0;
    function next() {
      if (i >= attempts.length) return Promise.reject(lastErr || new Error('no endpoint'));
      var a = attempts[i++];
      return postOverpass(a[0], a[1], 60000).then(function (json) {
        var ways = C.parseOverpass(json, proj);
        if (!ways.length) { lastErr = new Error('empty'); return next(); }
        return ways;
      }, function (e) { lastErr = e; return next(); });
    }
    return next().then(function (ways) {
      var res = C.snapToRoads(traceXY, ways, { courseM: COURSE_KM * 1000 });
      state.fetching = false;
      if (!res.ok) { state.srcNote = 'OpenStreetMap answered, but the result was rejected: ' + res.reason; describeSource(); if (!silent) toast('Kept the built-in trace. ' + res.reason, 6000); return false; }
      var st = res.stats; st.when = new Date().toISOString().slice(0, 10); st.T = res.T; delete st.roadNames;
      store.set(K_OSM, { v: 2, xy: res.xy.map(function (p) { return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]; }), stats: st });
      drawOsmWays(ways); applyRoute(res.xy, 'osm', st);
      toast('Course snapped to OpenStreetMap roads (' + Math.round(st.matched * 100) + '% matched).', 4500);
      return true;
    }, function (e) {
      state.fetching = false;
      var blocked = !e || e.name === 'TypeError';
      state.srcNote = blocked
        ? 'OpenStreetMap could not be reached from this page. Pages opened inside Claude cannot call other sites; open the downloaded HTML file in a browser and it will fetch the roads.'
        : 'The OpenStreetMap server did not answer (' + (e.message || 'error') + '). Try again in a minute.';
      describeSource(); if (!silent) toast(blocked ? 'OpenStreetMap is blocked from this page. See Settings.' : 'OpenStreetMap did not answer. Try again shortly.', 5000);
      return false;
    });
  }

  // ---------------------------------------------------------------- export
  function exportText(kind) {
    var pts = C.simplify(route.xy, 1.5), L = C.cumLen(pts), tot = L[L.length - 1] || 1;
    var ll = pts.map(function (p) { return proj.toLL(p[0], p[1]); }), el = pts.map(function (p, i) { return elevAt(COURSE_KM * L[i] / tot); });
    var name = 'adidas Half Marathon 2026 (unofficial trace)';
    return kind === 'gpx' ? C.toGPX(name, ll, el) : C.toGeoJSON(name, ll, el);
  }
  function copyOut(kind) {
    var text = exportText(kind), box = $('copybox');
    function fallback() { box.hidden = false; box.value = text; box.focus(); box.select(); toast('Copy blocked. The text is selected below; copy it from there.', 5000); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast((kind === 'gpx' ? 'GPX' : 'GeoJSON') + ' copied to the clipboard.'); }, fallback);
    else fallback();
  }

  // ---------------------------------------------------------------- wiring
  // playback label: how long the simulated race takes to watch
  function labelSim() {
    var tgt = C.parseTime(state.target), el = $('simNote');
    if (state.sim === 'preview') el.textContent = 'Clock set to Preview: constant speed, 90 s end to end, ignoring the target time.';
    else {
      var x = parseInt(state.sim, 10), w = tgt / x;
      el.textContent = 'Race clock at ' + (x === 1 ? 'real time' : x + '×') + ': a ' + state.target + ' finish plays in ' + (w >= 3600 ? C.fmtTime(w) : C.fmtPace(w) + ' min') + ', ' + (state.pacing === 'effort' ? 'slower uphill and faster downhill.' : 'at an even ' + C.fmtPace(tgt / COURSE_KM) + ' /km.');
    }
  }
  function syncControls() {
    $('exag').value = state.exag; $('exagV').textContent = state.exag + '×';
    $('target').value = state.target; $('speed').value = state.sim; $('pacing').value = state.pacing; labelSim(); $('follow').checked = state.follow;
    $('shSigns').checked = state.showSigns; $('shLamps').checked = state.showLamps; $('shCity').checked = state.showCity; syncStreetToggles();
    $('shKm').checked = state.showKm; $('shLm').checked = state.showLm; $('shBase').checked = state.showBase; $('shCurtain').checked = state.showCurtain; $('shGrade').checked = state.grade;
    $('gradeLegend').hidden = !state.grade;
    syncTileForm();
    if (three) { three.base.visible = state.showBase; if (three.curtain) three.curtain.visible = state.showCurtain; three.lastDeclutter = 0; }
    invalidate();
  }
  function bind() {
    $('view3d').addEventListener('click', function () { setView('3d'); });
    $('view2d').addEventListener('click', function () { setView('2d'); });
    $('viewStreet').addEventListener('click', function () { setView('street'); });
    $('themeBtn').addEventListener('click', function () { state.theme = state.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); });
    $('theme').addEventListener('change', function () { state.theme = this.value === 'dark' ? 'dark' : 'light'; saveSettings(); applyTheme(); });
    $('shSigns').addEventListener('change', function () { state.showSigns = this.checked; saveSettings(); syncStreetToggles(); });
    $('shLamps').addEventListener('change', function () { state.showLamps = this.checked; saveSettings(); syncStreetToggles(); });
    $('shCity').addEventListener('change', function () {
      state.showCity = this.checked; saveSettings();
      if (three) { three.cityGroup.visible = three.greenGroup.visible = state.showCity; invalidate(); }
      if (state.showCity && city.status === 'idle') loadCity(false);
      describeCity();
    });
    $('cityLoad').addEventListener('click', function () { loadCity(city.status === 'ready'); });
    $('tileProv').addEventListener('change', function () { this.dataset.touched = '1'; syncTileForm(); });
    $('openPanel').addEventListener('click', function () { openPanel($('panel').hidden); });
    $('panelClose').addEventListener('click', function () { openPanel(false); });
    $('tabPlaces').addEventListener('click', function () { setTab('places'); });
    $('tabSettings').addEventListener('click', function () { setTab('settings'); });
    $('play').addEventListener('click', function () { setPlaying(!state.playing); });
    $('restart').addEventListener('click', function () { setKm(0, true); });
    $('speed').addEventListener('change', function () { state.sim = this.value; lastT = 0; saveSettings(); labelSim(); });
    $('pacing').addEventListener('change', function () { state.pacing = this.value === 'even' ? 'even' : 'effort'; saveSettings(); rebuildPacing(); updateReadout(); renderInfo(); renderList(); labelSim(); });
    $('follow').addEventListener('change', function () { state.follow = this.checked; saveSettings(); if (state.follow && three) focusItem({ type: 'pt', km: state.km }); });
    $('exag').addEventListener('input', function () { state.exag = parseInt(this.value, 10) || DEFAULTS.exag; $('exagV').textContent = state.exag + '×'; rebuildRoute(); saveSettings(); });
    $('target').addEventListener('change', function () {
      var s = C.parseTime(this.value);
      if (isNaN(s) || s < 3600 || s > 3.75 * 3600) { toast('Enter a finish time between 1:00:00 and the 3:45:00 cut-off.', 4500); this.value = state.target; return; }
      state.target = C.fmtTime(s); this.value = state.target; saveSettings(); rebuildPacing(); updateReadout(); renderInfo(); renderList(); labelSim();
    });
    [['shKm', 'showKm'], ['shLm', 'showLm'], ['shBase', 'showBase'], ['shCurtain', 'showCurtain']].forEach(function (p) {   // street arches follow showKm
      $(p[0]).addEventListener('change', function () { state[p[1]] = this.checked; saveSettings(); syncControls(); });
    });
    $('shGrade').addEventListener('change', function () { state.grade = this.checked; saveSettings(); syncControls(); rebuildRoute(); });
    $('q').addEventListener('input', function () { state.query = this.value; renderList(); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) {
      b.addEventListener('click', function () {
        state.filter = b.getAttribute('data-filter');
        Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (o) { o.setAttribute('aria-pressed', String(o === b)); });
        renderList();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (b) {
      b.addEventListener('click', function () { if (!three) return; $('follow').checked = state.follow = false; var v = viewPreset(b.getAttribute('data-view')); flyTo(v.pos, v.target, 900); });
    });
    $('fetchOsm').addEventListener('click', function () { fetchOsm(false); });
    $('useTrace').addEventListener('click', function () { store.del(K_OSM); drawOsmWays(null); applyRoute(traceXY, 'trace', null); toast('Back to the built-in trace.'); });
    $('tileSave').addEventListener('click', function () {
      var p = $('tileProv').value, cfg = { provider: p };
      if (p === 'carto') { cfg.key = $('tileKey').value.trim(); if (!/^[\w.-]{8,200}$/.test(cfg.key)) { toast('Paste the CARTO key first. It is a string of letters and digits.', 5000); return; } }
      if (p === 'custom') { cfg.url = $('tileUrl').value.trim(); cfg.attribution = $('tileAttr').value.trim(); if (!validTileUrl(cfg.url)) { toast('The tile URL must start with https:// and contain {z}, {x} and {y}.', 5000); return; } }
      store.set(K_TILES, cfg); delete $('tileProv').dataset.touched; syncTileForm(); setTiles();
      toast(p === 'osm' ? 'Using OpenStreetMap tiles.' : 'Map tiles updated. Open the Map view to check them.');
    });
    $('copyGpx').addEventListener('click', function () { copyOut('gpx'); });
    $('copyGeo').addEventListener('click', function () { copyOut('geojson'); });
    $('resetAll').addEventListener('click', function () {
      Object.keys(DEFAULTS).forEach(function (k) { state[k] = DEFAULTS[k]; }); saveSettings(); rebuildPacing(); syncControls(); applyTheme(); updateReadout(); renderInfo(); renderList(); toast('Settings reset.');
    });

    // chart = timeline
    var dragging = false;
    chart.c.addEventListener('pointerdown', function (e) { dragging = true; try { chart.c.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } setKm(chartKm(e), true); });
    chart.c.addEventListener('pointermove', function (e) { if (dragging) setKm(chartKm(e), true); });
    ['pointerup', 'pointercancel'].forEach(function (n) { chart.c.addEventListener(n, function () { dragging = false; }); });
    chart.c.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { setKm(state.km + d * (e.shiftKey ? 1 : 0.1), true); e.preventDefault(); e.stopPropagation(); }
    });

    // tap on the 3D view (ignore drags)
    var down = null, gl = $('gl'), look = null, pts = {}, pinch = null;
    gl.addEventListener('pointerdown', function (e) {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (state.view !== 'street') return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pts);
      if (ids.length === 2) { var a = pts[ids[0]], b = pts[ids[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: sc.dist }; look = null; }
      else look = { x: e.clientX, y: e.clientY, yaw: sc.yawOff, pitch: sc.pitch };
      try { gl.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    });
    gl.addEventListener('pointermove', function (e) {
      if (state.view !== 'street' || !pts[e.pointerId]) return;
      pts[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pts);
      if (pinch && ids.length === 2) { var a = pts[ids[0]], b = pts[ids[1]]; sc.dist = Math.max(3, Math.min(120, pinch.dist * pinch.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)))); invalidate(); return; }
      if (look) { sc.yawOff = look.yaw - (e.clientX - look.x) * 0.006; sc.pitch = Math.max(0.02, Math.min(1.35, look.pitch + (e.clientY - look.y) * 0.005)); invalidate(); }
    });
    ['pointercancel', 'pointerleave'].forEach(function (n) { gl.addEventListener(n, function (e) { delete pts[e.pointerId]; pinch = null; look = null; }); });
    gl.addEventListener('wheel', function (e) { if (state.view !== 'street') return; e.preventDefault(); sc.dist = Math.max(3, Math.min(120, sc.dist * Math.exp(e.deltaY * 0.0012))); invalidate(); }, { passive: false });
    gl.addEventListener('dblclick', function () { if (state.view !== 'street') return; sc.yawOff = 0; sc.pitch = 0.2; sc.dist = 9; invalidate(); });
    gl.addEventListener('pointerup', function (e) {
      delete pts[e.pointerId]; if (Object.keys(pts).length < 2) pinch = null; look = null;
      if (!three || !down) return;
      var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t; down = null;
      if (moved > 6 || dt > 600) return;
      var r = gl.getBoundingClientRect(); declutter();
      var hit = pick(e.clientX - r.left, e.clientY - r.top);
      if (!hit) { if (state.sel) select(null, false); return; }
      if (hit.item) { if (hit.item.id === 'start' || hit.item.id === 'finish') { setKm(hit.item.km, true); toast(hit.item.name + ' line'); } else { select(hit.item.id, false); if (!isWide()) { openPanel(true); } } }
      else { setKm(hit.km, true); toast(hit.km.toFixed(2) + ' km · ' + elevAt(hit.km).toFixed(1) + ' m · ' + sectionAt(hit.km).name); }
    });

    window.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ' || e.code === 'Space') { if (tag === 'BUTTON') return; setPlaying(!state.playing); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { setKm(state.km + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 0.1), true); e.preventDefault(); }
      else if ((e.key === 'r' || e.key === 'R') && three) { if (state.view === 'street') { sc.yawOff = 0; sc.pitch = 0.2; sc.dist = 9; invalidate(); } else { var v = viewPreset('iso'); flyTo(v.pos, v.target, 700); } }
      else if (e.key === 'Escape') { closePanelOnPhone(); }
    });
    if (window.ResizeObserver) new ResizeObserver(resize).observe($('stage')); else window.addEventListener('resize', resize);
    window.addEventListener('resize', function () { openPanel(!$('panel').hidden); });
    document.addEventListener('visibilitychange', function () { lastT = 0; invalidate(); });
  }

  // ---------------------------------------------------------------- frame loop (renders only when something changed)
  var lastT = 0, PLAY_SECONDS = 90, animT = 0;        // preview mode: whole course in 90 s
  var lastFrame = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) { lastFrame = 0; return; }
    var fdt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0; lastFrame = now;
    if (state.playing) {
      var dt = lastT ? Math.min(0.5, (now - lastT) / 1000) : 0; lastT = now; animT += reduceMotion ? 0 : dt;
      var km = state.sim === 'preview' ? state.km + dt * COURSE_KM / PLAY_SECONDS
        : C.kmAtTime(pacing, timeAt(state.km) + dt * parseInt(state.sim, 10));
      if (km >= COURSE_KM - 1e-9) { km = COURSE_KM; setKm(km); setPlaying(false); toast('Finish at the National Stadium in ' + state.target + ', ' + fmtClock(FLAG_OFF_S + pacing.targetS) + ' on the clock.', 6000); }
      else setKm(km);
    }
    if (!three) return;
    if (three.tween) {
      var tw = three.tween, u = Math.min(1, (now - tw.t0) / tw.ms), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      three.camera.position.lerpVectors(tw.p0, tw.p1, e); three.controls.target.lerpVectors(tw.q0, tw.q1, e);
      if (u >= 1) three.tween = null;
      dirty = true;
    }
    var street = state.view === 'street';
    if (!street) three.controls.update();
    if (!dirty) return;
    dirty = false;
    if (street) {
      updateStreetCam(fdt);
      three.figure.group.position.y = streetY(state.km);
      poseRunner(three.figure, animT * 9.2, state.playing);                 // about 175 steps a minute
      if (state.playing) dirty = true;
    } else {
      var dist = three.camera.position.distanceTo(three.controls.target);
      three.uR.value = Math.max(3, Math.min(90, dist * 0.0023));
      var fy = three.runner.sprite.position.y + three.uR.value * 0.9; three.figure.group.position.y = fy;
      var fh = Math.max(6, Math.min(2600, three.camera.position.distanceTo(three.figure.group.position) * 0.055));     // figure stays about the same size on screen
      three.figure.group.scale.set(fh, fh, fh);
      poseRunner(three.figure, animT * 17.6, state.playing);
    }
    if (now - (three.lastDeclutter || 0) > 90) { declutter(); three.lastDeclutter = now; } else dirty = true;
    var rr = three.renderer; rr.clear(); rr.render(three.bgScene, three.camera); rr.clearDepth(); rr.render(three.scene, three.camera);
  }

  // ---------------------------------------------------------------- start
  three = initThree();
  if (!three) { $('glfail').hidden = false; $('gl').hidden = true; $('views').hidden = true; }
  bind(); syncControls(); setTab('places'); openPanel(false); applyTheme();
  resize();
  if (three) { sizeSprite(three.runner); var v0 = viewPreset('iso'); flyTo(v0.pos, v0.target, 0); }
  rebuildRoute(); rebuildStreet(); renderList(); renderInfo(); updateReadout(); drawChart(); describeSource();
  var cached = store.get(K_OSM);
  if (cached && cached.v === 2 && Array.isArray(cached.xy) && cached.xy.length > 50 && cached.stats) applyRoute(cached.xy, 'osm', cached.stats);
  else fetchOsm(true);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { rebuildMarkers(); rebuildStreet(); drawChart(); invalidate(); });
  describeCity();
  if (three) idbGet(K_CITY).then(function (rec) {
    if (!rec || rec.v !== 1 || !rec.data || city.status !== 'idle') return;
    city.data = rec.data; city.done = rec.done || []; city.saved = rec.t; city.total = city.done.length;
    city.status = Date.now() - rec.t < CITY_TTL ? 'ready' : 'idle';
    buildCity();
  });
  requestAnimationFrame(frame);

  window.__sgim = { city: city, loadCity: loadCity, turns: function () { return turns; }, sc: sc, streetY: streetY, state: state, timeAt: function (k) { return timeAt(k); }, setKm: setKm, select: select, setView: setView, fetchOsm: fetchOsm, three: function () { return three; }, route: function () { return route; } };
})();
