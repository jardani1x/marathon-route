/* Route geometry core: projection, polyline maths, elevation lookup,
   OpenStreetMap fetch + road snapping, export. No DOM, no three.js.
   Runs in the browser and in Node (tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RouteCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- projection (local tangent plane, metres) ----------
  function makeProjection(o) {
    return {
      toXY: function (lat, lon) { return [(lon - o.lon) * o.mPerDegLon, (lat - o.lat) * o.mPerDegLat]; },
      toLL: function (x, y) { return [o.lat + y / o.mPerDegLat, o.lon + x / o.mPerDegLon]; }
    };
  }

  // ---------- polyline helpers ----------
  function cumLen(p) {
    var L = new Float64Array(p.length);
    for (var i = 1; i < p.length; i++) L[i] = L[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    return L;
  }
  // index of the last vertex with L[i] <= s
  function findSeg(L, s) {
    var lo = 0, hi = L.length - 1;
    if (s <= 0) return 0;
    if (s >= L[hi]) return Math.max(0, hi - 1);
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (L[m] <= s) lo = m; else hi = m; }
    return lo;
  }
  function pointAt(p, L, s) {
    if (p.length === 1) return [p[0][0], p[0][1], 0, 1];
    s = Math.max(0, Math.min(L[L.length - 1], s));
    var i = findSeg(L, s), d = L[i + 1] - L[i], t = d > 0 ? (s - L[i]) / d : 0;
    var dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1], n = Math.hypot(dx, dy) || 1;
    return [p[i][0] + dx * t, p[i][1] + dy * t, dx / n, dy / n];
  }
  function resample(p, step) {
    var L = cumLen(p), total = L[L.length - 1], out = [];
    var n = Math.max(1, Math.round(total / step));
    for (var k = 0; k <= n; k++) { var q = pointAt(p, L, total * k / n); out.push([q[0], q[1]]); }
    return out;
  }
  function simplify(p, eps) {
    if (p.length < 3) return p.slice();
    var keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
    var st = [[0, p.length - 1]];
    while (st.length) {
      var ab = st.pop(), a = ab[0], b = ab[1];
      if (b <= a + 1) continue;
      var ux = p[b][0] - p[a][0], uy = p[b][1] - p[a][1], n = Math.hypot(ux, uy), best = -1, bi = -1;
      for (var i = a + 1; i < b; i++) {
        var wx = p[i][0] - p[a][0], wy = p[i][1] - p[a][1];
        var d = n > 0 ? Math.abs(ux * wy - uy * wx) / n : Math.hypot(wx, wy);
        if (d > best) { best = d; bi = i; }
      }
      if (best > eps) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
    }
    var out = [];
    for (var j = 0; j < p.length; j++) if (keep[j]) out.push(p[j]);
    return out;
  }
  function interp(xs, ys, x) {
    var n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    var t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
    return ys[lo] + (ys[hi] - ys[lo]) * t;
  }
  function median(a) {
    if (!a.length) return 0;
    var b = Array.prototype.slice.call(a).sort(function (x, y) { return x - y; }), m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  // ---------- Overpass ----------
  var SKIP = /^(steps|proposed|construction|corridor|elevator|platform|bus_stop|rest_area|services|razed|abandoned)$/;
  var FOOT = /^(footway|path|pedestrian|cycleway|bridleway|track)$/;
  function buildOverpassQuery(routeLL, radius) {
    var c = [];
    for (var i = 0; i < routeLL.length; i++) c.push(routeLL[i][0].toFixed(5) + ',' + routeLL[i][1].toFixed(5));
    return '[out:json][timeout:60];way[highway](around:' + radius + ',' + c.join(',') + ');out geom qt;';
  }
  function buildOverpassBBoxQuery(routeLL, padDeg) {
    var s = 90, w = 180, n = -90, e = -180;
    routeLL.forEach(function (p) { s = Math.min(s, p[0]); n = Math.max(n, p[0]); w = Math.min(w, p[1]); e = Math.max(e, p[1]); });
    var b = [s - padDeg, w - padDeg, n + padDeg, e + padDeg].map(function (v) { return v.toFixed(5); }).join(',');
    return '[out:json][timeout:90];way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|raceway|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](' + b + ');out geom qt;';
  }
  // -> [{id, name, highway, foot, pts:[[x,y],...]}]
  function parseOverpass(json, proj) {
    var ways = [];
    if (!json || !Array.isArray(json.elements)) return ways;
    json.elements.forEach(function (el) {
      if (!el || el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) return;
      var hw = el.tags && el.tags.highway;
      if (!hw || SKIP.test(hw)) return;
      if (el.tags.area === 'yes') return;
      var pts = [];
      for (var i = 0; i < el.geometry.length; i++) {
        var g = el.geometry[i];
        if (!g || typeof g.lat !== 'number' || typeof g.lon !== 'number') continue;
        pts.push(proj.toXY(g.lat, g.lon));
      }
      if (pts.length < 2) return;
      ways.push({ id: el.id, name: (el.tags.name || el.tags['bridge:name'] || el.tags.ref || ''), highway: hw, foot: FOOT.test(hw), pts: pts });
    });
    return ways;
  }

  // ---------- spatial index of road segments ----------
  function buildIndex(ways, cell) {
    var segs = [], grid = new Map();
    function key(i, j) { return i + ':' + j; }
    ways.forEach(function (w, wi) {
      for (var i = 0; i + 1 < w.pts.length; i++) {
        var a = w.pts[i], b = w.pts[i + 1];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        var ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        var si = segs.length;
        segs.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], ang: ang, way: wi, foot: w.foot });
        var i0 = Math.floor(Math.min(a[0], b[0]) / cell), i1 = Math.floor(Math.max(a[0], b[0]) / cell);
        var j0 = Math.floor(Math.min(a[1], b[1]) / cell), j1 = Math.floor(Math.max(a[1], b[1]) / cell);
        for (var ci = i0; ci <= i1; ci++) for (var cj = j0; cj <= j1; cj++) {
          var k = key(ci, cj), arr = grid.get(k);
          if (!arr) grid.set(k, arr = []);
          arr.push(si);
        }
      }
    });
    return { segs: segs, grid: grid, cell: cell, stamp: new Int32Array(segs.length), tick: 0 };
  }
  // smallest angle between two undirected directions (0..pi/2)
  function angDiff(a, b) {
    var d = Math.abs(a - b) % Math.PI;
    return d > Math.PI / 2 ? Math.PI - d : d;
  }
  /* Best road segment for a point with a heading.
     o: {R, maxAng, allowFoot, footPenalty, prevWay, switchPenalty} */
  function nearest(ix, x, y, heading, o) {
    var c = ix.cell, R = o.R, tick = ++ix.tick, best = null, bestScore = Infinity;
    var i0 = Math.floor((x - R) / c), i1 = Math.floor((x + R) / c), j0 = Math.floor((y - R) / c), j1 = Math.floor((y + R) / c);
    for (var ci = i0; ci <= i1; ci++) for (var cj = j0; cj <= j1; cj++) {
      var arr = ix.grid.get(ci + ':' + cj);
      if (!arr) continue;
      for (var n = 0; n < arr.length; n++) {
        var si = arr[n];
        if (ix.stamp[si] === tick) continue;
        ix.stamp[si] = tick;
        var s = ix.segs[si];
        if (s.foot && !o.allowFoot) continue;
        if (angDiff(s.ang, heading) > o.maxAng) continue;
        var ux = s.bx - s.ax, uy = s.by - s.ay, l2 = ux * ux + uy * uy;
        var t = ((x - s.ax) * ux + (y - s.ay) * uy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var px = s.ax + ux * t, py = s.ay + uy * t, d = Math.hypot(x - px, y - py);
        if (d > R) continue;
        var score = d + (s.foot ? (o.footPenalty || 0) : 0) + (o.prevWay != null && o.prevWay !== s.way ? (o.switchPenalty || 0) : 0);
        if (score < bestScore) { bestScore = score; best = { x: px, y: py, d: d, way: s.way, foot: s.foot, ang: s.ang }; }
      }
    }
    return best;
  }
  // Gaussian elimination with partial pivoting; null if singular
  function solve4(A, B) {
    var n = 4, M = A.map(function (r, i) { return r.concat([B[i]]); });
    for (var c = 0; c < n; c++) {
      var p = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-9) return null;
      var tmp = M[c]; M[c] = M[p]; M[p] = tmp;
      for (r = c + 1; r < n; r++) { var f = M[r][c] / M[c][c]; for (var k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    var x = [0, 0, 0, 0];
    for (var i = n - 1; i >= 0; i--) { var s = M[i][n]; for (var j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / M[i][i]; }
    return x;
  }
  function headings(p, span) {
    var h = new Float64Array(p.length);
    for (var i = 0; i < p.length; i++) {
      var a = p[Math.max(0, i - span)], b = p[Math.min(p.length - 1, i + span)];
      h[i] = Math.atan2(b[1] - a[1], b[0] - a[0]);
    }
    return h;
  }
  function applyT(T, p) {
    var out = new Array(p.length);
    for (var i = 0; i < p.length; i++) out[i] = [T.a * p[i][0] - T.b * p[i][1] + T.tx, T.b * p[i][0] + T.a * p[i][1] + T.ty];
    return out;
  }

  /* Align a hand-traced route to OSM roads, then snap it.
     trace: [[x,y],...] metres. ways: parseOverpass() output.
     Returns {ok, reason, xy, stats, T}. Never throws on odd data. */
  function snapToRoads(trace, ways, opt) {
    opt = opt || {};
    var step = opt.step || 10;
    var stats = { ways: ways.length, matched: 0, shiftM: 0, scale: 1, rotDeg: 0, lengthM: 0, traceLengthM: 0 };
    if (!ways.length) return { ok: false, reason: 'OpenStreetMap returned no roads for this area.', stats: stats };
    var pts = resample(trace, step);
    var Lt = cumLen(pts); stats.traceLengthM = Lt[Lt.length - 1];
    var ix = buildIndex(ways, 60);
    if (!ix.segs.length) return { ok: false, reason: 'OpenStreetMap returned no usable road geometry.', stats: stats };
    var T = { a: 1, b: 0, tx: 0, ty: 0 }, deg = Math.PI / 180, it, i, cur, hd, m;

    // phase 1: robust translation (median residual), vehicular roads only
    for (it = 0; it < 8; it++) {
      cur = applyT(T, pts); hd = headings(cur, 2);
      var dxs = [], dys = [];
      for (i = 0; i < cur.length; i++) {
        m = nearest(ix, cur[i][0], cur[i][1], hd[i], { R: 90, maxAng: 20 * deg, allowFoot: false });
        if (m) { dxs.push(m.x - cur[i][0]); dys.push(m.y - cur[i][1]); }
      }
      if (dxs.length < cur.length * 0.3) break;
      var mx = median(dxs), my = median(dys);
      T.tx += mx; T.ty += my;
      if (Math.hypot(mx, my) < 0.4) break;
    }
    var T1 = { a: T.a, b: T.b, tx: T.tx, ty: T.ty };

    // phase 2: similarity fit (scale + small rotation + translation), point-to-line least squares on trimmed matches
    var cx0 = 0, cy0 = 0; pts.forEach(function (p) { cx0 += p[0]; cy0 += p[1]; }); cx0 /= pts.length; cy0 /= pts.length;
    for (it = 0; it < 12; it++) {
      cur = applyT(T, pts); hd = headings(cur, 2);
      var rows = [], res = [];
      for (i = 0; i < cur.length; i++) {
        m = nearest(ix, cur[i][0], cur[i][1], hd[i], { R: 45, maxAng: 20 * deg, allowFoot: false });
        if (m) { rows.push([pts[i][0] - cx0, pts[i][1] - cy0, -Math.sin(m.ang), Math.cos(m.ang), m.x, m.y]); res.push(m.d); }
      }
      if (rows.length < pts.length * 0.3) break;
      var thr = Math.max(8, 2.5 * median(res)), A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], B = [0, 0, 0, 0], n = 0;
      for (i = 0; i < rows.length; i++) if (res[i] <= thr) {
        var r = rows[i], c = [r[2] * r[0] + r[3] * r[1], -r[2] * r[1] + r[3] * r[0], r[2], r[3]], rhs = r[2] * r[4] + r[3] * r[5];
        for (var u = 0; u < 4; u++) { B[u] += c[u] * rhs; for (var v = 0; v < 4; v++) A[u][v] += c[u] * c[v]; }
        n++;
      }
      if (n < 20) break;
      var sol = solve4(A, B);
      if (!sol) break;
      var sc = Math.hypot(sol[0], sol[1]), rot = Math.atan2(sol[1], sol[0]) / deg;
      if (sc < 0.96 || sc > 1.04 || Math.abs(rot) > 2) break;      // implausible: keep what we have
      var nT = { a: sol[0], b: sol[1], tx: sol[2] - sol[0] * cx0 + sol[1] * cy0, ty: sol[3] - sol[1] * cx0 - sol[0] * cy0 };
      var moved = Math.abs(nT.tx - T.tx) + Math.abs(nT.ty - T.ty) + Math.abs(nT.a - T.a) * 5000 + Math.abs(nT.b - T.b) * 5000;
      T = nT;
      if (moved < 0.3) break;
    }
    stats.scale = Math.hypot(T.a, T.b); stats.rotDeg = Math.atan2(T.b, T.a) / deg;
    var cx = 0, cy = 0; pts.forEach(function (p) { cx += p[0]; cy += p[1]; }); cx /= pts.length; cy /= pts.length;
    stats.shiftM = Math.hypot(T.a * cx - T.b * cy + T.tx - cx, T.b * cx + T.a * cy + T.ty - cy);

    // phase 3: snap each point; footpaths allowed, with a small preference for staying on the same way
    cur = applyT(T, pts); hd = headings(cur, 2);
    var out = new Array(cur.length), hit = new Uint8Array(cur.length), prev = null, matched = 0, usedWays = {};
    for (i = 0; i < cur.length; i++) {
      m = nearest(ix, cur[i][0], cur[i][1], hd[i], { R: 25, maxAng: 30 * deg, allowFoot: true, footPenalty: 8, prevWay: prev, switchPenalty: 5 });
      if (m) { out[i] = [m.x, m.y]; hit[i] = 1; prev = m.way; matched++; usedWays[m.way] = 1; }
      else { out[i] = cur[i]; prev = null; }
    }
    stats.matched = matched / cur.length;
    // drop spikes, then smooth lightly
    for (var pass = 0; pass < 2; pass++) for (i = 2; i < out.length - 2; i++) {
      var p0 = out[i - 2], p1 = out[i + 2], ux = p1[0] - p0[0], uy = p1[1] - p0[1], l = Math.hypot(ux, uy);
      if (l < 1) continue;
      var dev = Math.abs(ux * (out[i][1] - p0[1]) - uy * (out[i][0] - p0[0])) / l;
      if (dev > 14 && l < 4.6 * step) out[i] = [(out[i - 1][0] + out[i + 1][0]) / 2, (out[i - 1][1] + out[i + 1][1]) / 2];
    }
    var sm = out.map(function (p, k) {
      if (k === 0 || k === out.length - 1) return p;
      return [0.25 * out[k - 1][0] + 0.5 * p[0] + 0.25 * out[k + 1][0], 0.25 * out[k - 1][1] + 0.5 * p[1] + 0.25 * out[k + 1][1]];
    });
    var xy = simplify(sm, 0.8), L = cumLen(xy);
    stats.lengthM = L[L.length - 1];
    stats.waysUsed = Object.keys(usedWays).length;
    var names = {}; Object.keys(usedWays).forEach(function (k) { var nm = ways[k].name; if (nm) names[nm] = 1; });
    stats.roadNames = Object.keys(names).sort();

    var res = { xy: xy, stats: stats, T: T, T1: T1, ok: true, reason: '' };
    var target = opt.courseM || stats.traceLengthM;
    if (stats.matched < 0.6) { res.ok = false; res.reason = 'Only ' + Math.round(stats.matched * 100) + '% of the route matched an OpenStreetMap road.'; }
    else if (stats.shiftM > 200) { res.ok = false; res.reason = 'The alignment moved the route ' + Math.round(stats.shiftM) + ' m, which is too far to trust.'; }
    else if (Math.abs(stats.lengthM / target - 1) > 0.06) { res.ok = false; res.reason = 'The snapped route is ' + (stats.lengthM / 1000).toFixed(2) + ' km, too far from the certified distance.'; }
    return res;
  }

  // ---------- export ----------
  function toGeoJSON(name, ll, elevM) {
    return JSON.stringify({
      type: 'FeatureCollection', features: [{
        type: 'Feature', properties: { name: name },
        geometry: { type: 'LineString', coordinates: ll.map(function (p, i) { return [+p[1].toFixed(6), +p[0].toFixed(6), +elevM[i].toFixed(1)]; }) }
      }]
    });
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toGPX(name, ll, elevM) {
    var s = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="SGIM26 route viewer" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>' + esc(name) + '</name><trkseg>\n';
    for (var i = 0; i < ll.length; i++) s += '<trkpt lat="' + ll[i][0].toFixed(6) + '" lon="' + ll[i][1].toFixed(6) + '"><ele>' + elevM[i].toFixed(1) + '</ele></trkpt>\n';
    return s + '</trkseg></trk>\n</gpx>\n';
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  // "1:55:00" | "115" (minutes) | "1:55" (h:mm) -> seconds, or NaN
  function parseTime(str) {
    var p = String(str).trim().split(':').map(function (v) { return v.trim(); });
    if (!p.length || p.some(function (v) { return v === '' || !/^\d+(\.\d+)?$/.test(v); })) return NaN;
    var n = p.map(Number);
    if (n.length === 1) return n[0] * 60;
    if (n.length === 2) return n[0] * 3600 + n[1] * 60;
    if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
    return NaN;
  }

  // ---------- pacing ----------
  /* Energy cost of running on a gradient, J/kg/m (polynomial from Minetti et al. 2002, J Appl Physiol 93:1039).
     i = rise/run. Fitted for -0.45..+0.45; clamped there. */
  function runCost(i) {
    i = Math.max(-0.45, Math.min(0.45, i));
    return ((((155.4 * i - 30.4) * i - 43.3) * i + 46.3) * i + 19.5) * i + 3.6;
  }
  /* Time table along the course for a target finish time.
     model 'even'  : constant speed.
     model 'effort': constant energy output, so time per metre scales with runCost(gradient);
                     downhill savings are halved (an assumption, see below).
     Returns {km:[], t:[], model, targetS}; t is seconds since the start and ends exactly at targetS. */
  function buildPacing(elevKm, elevM, courseKm, targetS, model, stepKm, smoothKm) {
    stepKm = stepKm || 0.01; smoothKm = smoothKm || 0.2;
    var n = Math.max(1, Math.round(courseKm / stepKm)), km = new Float64Array(n + 1), t = new Float64Array(n + 1), c0 = runCost(0);
    for (var j = 1; j <= n; j++) {
      km[j] = courseKm * j / n;
      var mid = (km[j] + km[j - 1]) / 2, a = Math.max(0, mid - smoothKm / 2), b = Math.min(courseKm, mid + smoothKm / 2);
      var g = b > a ? (interp(elevKm, elevM, b) - interp(elevKm, elevM, a)) / ((b - a) * 1000) : 0;
      var f = runCost(g) / c0;
      if (f < 1) f = 1 - 0.5 * (1 - f);        // assumption: runners bank only half of the downhill saving
      t[j] = t[j - 1] + (km[j] - km[j - 1]) * (model === 'effort' ? f : 1);
    }
    var k = targetS / t[n];
    for (j = 0; j <= n; j++) t[j] *= k;
    t[n] = targetS;
    return { km: km, t: t, model: model === 'effort' ? 'effort' : 'even', targetS: targetS };
  }
  function timeAtKm(p, km) { return interp(p.km, p.t, km); }
  function kmAtTime(p, sec) { return interp(p.t, p.km, sec); }
  // seconds per km around a point (over +-windowKm/2)
  function paceAtKm(p, km, windowKm) {
    var w = windowKm || 0.1, end = p.km[p.km.length - 1], a = Math.max(0, km - w / 2), b = Math.min(end, km + w / 2);
    if (b - a < 1e-6) { a = Math.max(0, end - w); b = end; }
    return (interp(p.km, p.t, b) - interp(p.km, p.t, a)) / (b - a);
  }
  function fmtPace(secPerKm) {
    var s = Math.round(secPerKm), m = Math.floor(s / 60); s -= m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---------- turn-by-turn ----------
  function wrapDeg(a) { a = ((a + 180) % 360 + 360) % 360 - 180; return a; }
  function classifyTurn(deg) {
    var a = Math.abs(deg);
    return a < 25 ? 'straight' : a < 55 ? 'slight' : a < 125 ? 'turn' : a < 160 ? 'sharp' : 'uturn';
  }
  function compass(mathDeg) {         // mathDeg: counter-clockwise from east
    var b = ((90 - mathDeg) % 360 + 360) % 360;
    return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(b / 45) % 8];
  }
  /* Turn-by-turn instructions from the route geometry and the named road sections.
     xy: route polyline in metres; sections: [{from, to, road}] in course km.
     Turn angle at s = net heading change along the path from s-45 m to s+45 m (summed in 5 m steps, so
     U-turns keep their direction). Peaks of |angle| >= 40 deg are turn candidates. A road change within
     80 m of a peak names that turn; a road change with no peak is a "continue". Unnamed bends under 55 deg
     are dropped. Positive angles are left turns. */
  function computeTurns(xy, courseKm, sections, opt) {
    opt = opt || {};
    var STEP = 5, HALF = opt.half || 45, L = cumLen(xy), total = L[L.length - 1];
    if (total < 4 * HALF || !sections || !sections.length) return [];
    var n = Math.floor(total / STEP), hd = new Float64Array(n), i, j;
    for (i = 0; i < n; i++) {
      var a = pointAt(xy, L, i * STEP), b = pointAt(xy, L, Math.min(total, (i + 1) * STEP));
      hd[i] = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    }
    var w = Math.round(HALF / STEP), ang = new Float64Array(n);
    for (i = w; i < n - w; i++) { var sum = 0; for (j = i - w + 1; j <= i + w - 1; j++) sum += wrapDeg(hd[j] - hd[j - 1]); ang[i] = sum; }
    var kmOf = function (s) { return s / total * courseKm; }, sOf = function (km) { return km / courseKm * total; };
    var roadAt = function (km) { for (var k = 0; k < sections.length; k++) if (km >= sections[k].from && km < sections[k].to) return sections[k].road; return sections[sections.length - 1].road; };
    // local maxima of |angle|
    var peaks = [], pw = Math.round(50 / STEP);
    for (i = w; i < n - w; i++) {
      var m = Math.abs(ang[i]); if (m < 40) continue;
      var isMax = true;
      for (j = Math.max(w, i - pw); j <= Math.min(n - w - 1, i + pw); j++) if (Math.abs(ang[j]) > m || (Math.abs(ang[j]) === m && j < i)) { isMax = false; break; }
      if (!isMax) continue;
      var lo = i, hi = i;                       // centre of the plateau where the angle stays near its peak
      while (lo - 1 >= w && Math.abs(ang[lo - 1]) >= 0.97 * m) lo--;
      while (hi + 1 < n - w && Math.abs(ang[hi + 1]) >= 0.97 * m) hi++;
      peaks.push({ s: (lo + hi) / 2 * STEP + STEP / 2, angle: ang[i], used: false });
    }
    // two peaks of the same sign closer than 45 m are one turn
    peaks = peaks.filter(function (p, k) {
      return !peaks.some(function (q, j) { return j !== k && Math.abs(q.s - p.s) < 45 && (q.angle > 0) === (p.angle > 0) && (Math.abs(q.angle) > Math.abs(p.angle) || (Math.abs(q.angle) === Math.abs(p.angle) && j < k)); });
    });
    var out = [];
    // road changes
    for (var k = 1; k < sections.length; k++) {
      var sb = sOf(sections[k].from), best = null, bd = 80;
      peaks.forEach(function (p) { var d = Math.abs(p.s - sb); if (!p.used && d <= bd) { bd = d; best = p; } });
      var road = sections[k].road, prevRoad = sections[k - 1].road;
      if (best) { best.used = true; out.push({ s: best.s, angle: best.angle, road: road, sameRoad: road === prevRoad, named: true }); }
      else {
        var ib = Math.max(w, Math.min(n - w - 1, Math.round(sb / STEP)));
        if (road !== prevRoad) out.push({ s: sb, angle: ang[ib], road: road, sameRoad: false, named: true });
      }
    }
    peaks.forEach(function (p) { if (!p.used && Math.abs(p.angle) >= 40) out.push({ s: p.s, angle: p.angle, road: roadAt(kmOf(p.s) + 0.001), sameRoad: true, named: false }); });
    out.sort(function (x, y) { return x.s - y.s; });
    // net heading change over [s0, s1], summed in 5 m steps
    function netAngle(s0, s1) {
      var i0 = Math.max(1, Math.round(s0 / STEP)), i1 = Math.min(n - 1, Math.round(s1 / STEP)), t = 0;
      for (var q = i0; q <= i1; q++) t += wrapDeg(hd[q] - hd[q - 1]);
      return t;
    }
    // A left and a right less than 150 m apart, one of them under 60 deg, that mostly cancel are a jog in the
    // trace (lane change, merge),
    // unless both name a new road (e.g. Java Road). Unnamed same-way bends under 100 m apart are one turn.
    for (var pass = 0; pass < 3; pass++) {
      for (i = 0; i + 1 < out.length; i++) {
        var A = out[i], B = out[i + 1], gap = B.s - A.s;
        if (gap < 150 && A.angle * B.angle < 0 && !(A.named && B.named) && Math.min(Math.abs(A.angle), Math.abs(B.angle)) < 60 && Math.abs(A.angle + B.angle) < 45) {
          var keep = A.named ? A : B.named ? B : null;
          if (keep) { keep.angle = netAngle(A.s - HALF, B.s + HALF); out.splice(i, 2, keep); }
          else out.splice(i, 2);
          i--; continue;
        }
        if (gap < 100 && A.angle * B.angle > 0 && !A.named && !B.named) {
          out.splice(i, 2, { s: (A.s + B.s) / 2, angle: netAngle(A.s - HALF, B.s + HALF), road: A.road, sameRoad: true, named: false });
          i--;
        }
      }
    }
    out = out.filter(function (t) { return t.named || Math.abs(t.angle) >= 55; });
    // instructions
    var res = [], p0 = pointAt(xy, L, 0), p1 = pointAt(xy, L, Math.min(total, 80));
    res.push({ km: 0, type: 'depart', dir: '', angle: 0, road: sections[0].road, sameRoad: true,
      text: 'Head ' + compass(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180 / Math.PI) + ' on ' + sections[0].road, short: 'Start' });
    out.forEach(function (t) {
      var type = classifyTurn(t.angle), dir = type === 'straight' ? '' : (t.angle > 0 ? 'left' : 'right'), txt;
      if (type === 'straight') { type = 'continue'; txt = t.sameRoad ? 'Continue on ' + t.road : 'Continue onto ' + t.road; }
      else if (type === 'uturn') txt = 'Make a U-turn ' + (t.sameRoad ? 'on ' : 'onto ') + t.road;
      else {
        var verb = type === 'slight' ? 'Bear ' + dir : type === 'sharp' ? 'Sharp ' + dir : 'Turn ' + dir;
        txt = t.sameRoad ? verb + (t.named ? ' to stay on ' + t.road : '') : verb + ' onto ' + t.road;
      }
      res.push({ km: kmOf(t.s), type: type, dir: dir, angle: Math.round(t.angle), road: t.road, sameRoad: t.sameRoad, text: txt,
        short: t.road.replace(/^the /, '') });
    });
    res.push({ km: courseKm, type: 'arrive', dir: '', angle: 0, road: sections[sections.length - 1].road, sameRoad: true, text: opt.finishText || 'Finish', short: 'Finish' });
    // drop a "continue" that lands within 40 m of another instruction
    return res.filter(function (r, idx) {
      if (r.type !== 'continue') return true;
      return !res.some(function (o, jdx) { return jdx !== idx && o.type !== 'continue' && Math.abs(o.km - r.km) < 0.04; });
    });
  }
  // index of the next instruction at or after km (skipping the depart once moving)
  function nextTurnIndex(turns, km) {
    for (var i = 0; i < turns.length; i++) if (turns[i].km >= km - 0.005 && (turns[i].type !== 'depart' || km < 0.02)) return i;
    return turns.length - 1;
  }
  /* "Ground" under the course for the street view: a low percentile of the elevation profile within
     +-windowKm, smoothed, so roads sit on the ground and bridges rise above it. Returns {km:[], m:[]}. */
  function streetGround(elevKm, elevM, courseKm, windowKm, pct, smoothKm) {
    windowKm = windowKm || 0.8; pct = pct == null ? 0.1 : pct; smoothKm = smoothKm || 0.3;
    var step = 0.05, n = Math.round(courseKm / step), km = [], raw = [], i, j;
    for (i = 0; i <= n; i++) {
      var c = Math.min(courseKm, i * step), vals = [];
      for (var k = Math.max(0, c - windowKm); k <= Math.min(courseKm, c + windowKm) + 1e-9; k += 0.02) vals.push(interp(elevKm, elevM, k));
      vals.sort(function (a, b) { return a - b; });
      km.push(c); raw.push(vals[Math.floor(pct * (vals.length - 1))]);
    }
    var r = Math.round(smoothKm / step), m = [];
    for (i = 0; i <= n; i++) { var s = 0, cnt = 0; for (j = Math.max(0, i - r); j <= Math.min(n, i + r); j++) { s += raw[j]; cnt++; } m.push(s / cnt); }
    return { km: km, m: m };
  }

  return {
    wrapDeg: wrapDeg, classifyTurn: classifyTurn, compass: compass, computeTurns: computeTurns, nextTurnIndex: nextTurnIndex, streetGround: streetGround,
    runCost: runCost, buildPacing: buildPacing, timeAtKm: timeAtKm, kmAtTime: kmAtTime, paceAtKm: paceAtKm, fmtPace: fmtPace,
    makeProjection: makeProjection, cumLen: cumLen, findSeg: findSeg, pointAt: pointAt, resample: resample, simplify: simplify,
    interp: interp, median: median, buildOverpassQuery: buildOverpassQuery, buildOverpassBBoxQuery: buildOverpassBBoxQuery,
    parseOverpass: parseOverpass, buildIndex: buildIndex, nearest: nearest, snapToRoads: snapToRoads, applyT: applyT,
    toGeoJSON: toGeoJSON, toGPX: toGPX, fmtTime: fmtTime, parseTime: parseTime
  };
});
