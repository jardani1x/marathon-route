# ----------------------------------------------------------------------------- geometry core (no bpy)
COURSE_KM = DATA["meta"]["courseKm"]
_O = DATA["origin"]

def to_xy(lat, lon):
    return ((lon - _O["lon"]) * _O["mPerDegLon"], (lat - _O["lat"]) * _O["mPerDegLat"])

def to_ll(x, y):
    return (_O["lat"] + y / _O["mPerDegLat"], _O["lon"] + x / _O["mPerDegLon"])

def cum_len(p):
    L = [0.0]
    for i in range(1, len(p)):
        L.append(L[-1] + math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]))
    return L

def point_at(p, L, s):
    s = max(0.0, min(L[-1], s))
    lo, hi = 0, len(L) - 1
    if s >= L[hi]:
        lo = max(0, hi - 1)
    else:
        while hi - lo > 1:
            m = (lo + hi) // 2
            if L[m] <= s: lo = m
            else: hi = m
    d = L[lo + 1] - L[lo]
    t = (s - L[lo]) / d if d > 0 else 0.0
    dx, dy = p[lo + 1][0] - p[lo][0], p[lo + 1][1] - p[lo][1]
    n = math.hypot(dx, dy) or 1.0
    return (p[lo][0] + dx * t, p[lo][1] + dy * t, dx / n, dy / n)

def resample(p, step):
    L = cum_len(p); total = L[-1]; n = max(1, round(total / step))
    return [point_at(p, L, total * k / n)[:2] for k in range(n + 1)]

def simplify(p, eps):
    if len(p) < 3: return list(p)
    keep = [False] * len(p); keep[0] = keep[-1] = True; st = [(0, len(p) - 1)]
    while st:
        a, b = st.pop()
        if b <= a + 1: continue
        ux, uy = p[b][0] - p[a][0], p[b][1] - p[a][1]; n = math.hypot(ux, uy); best = -1.0; bi = -1
        for i in range(a + 1, b):
            wx, wy = p[i][0] - p[a][0], p[i][1] - p[a][1]
            d = abs(ux * wy - uy * wx) / n if n > 0 else math.hypot(wx, wy)
            if d > best: best, bi = d, i
        if best > eps:
            keep[bi] = True; st.append((a, bi)); st.append((bi, b))
    return [q for q, k in zip(p, keep) if k]

def interp(xs, ys, x):
    if x <= xs[0]: return ys[0]
    if x >= xs[-1]: return ys[-1]
    lo, hi = 0, len(xs) - 1
    while hi - lo > 1:
        m = (lo + hi) // 2
        if xs[m] <= x: lo = m
        else: hi = m
    t = (x - xs[lo]) / ((xs[hi] - xs[lo]) or 1.0)
    return ys[lo] + (ys[hi] - ys[lo]) * t

def elev_at(km):
    return interp(DATA["elev"]["km"], DATA["elev"]["m"], km)

def median(a):
    if not a: return 0.0
    b = sorted(a); m = len(b) // 2
    return b[m] if len(b) % 2 else (b[m - 1] + b[m]) / 2.0

_SKIP = {"steps", "proposed", "construction", "corridor", "elevator", "platform", "bus_stop", "rest_area", "services", "razed", "abandoned"}
_FOOT = {"footway", "path", "pedestrian", "cycleway", "bridleway", "track"}

def build_overpass_query(route_ll, radius):
    c = ",".join("%.5f,%.5f" % (a, b) for a, b in route_ll)
    return "[out:json][timeout:60];way[highway](around:%d,%s);out geom qt;" % (radius, c)

def build_overpass_bbox_query(route_ll, pad):
    s = min(p[0] for p in route_ll) - pad; n = max(p[0] for p in route_ll) + pad
    w = min(p[1] for p in route_ll) - pad; e = max(p[1] for p in route_ll) + pad
    return ('[out:json][timeout:90];way[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|raceway|'
            'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](%.5f,%.5f,%.5f,%.5f);out geom qt;' % (s, w, n, e))

def parse_overpass(js):
    ways = []
    if not isinstance(js, dict) or not isinstance(js.get("elements"), list): return ways
    for el in js["elements"]:
        if not isinstance(el, dict) or el.get("type") != "way": continue
        geom = el.get("geometry"); tags = el.get("tags") or {}
        hw = tags.get("highway")
        if not isinstance(geom, list) or len(geom) < 2 or not hw or hw in _SKIP or tags.get("area") == "yes": continue
        pts = [to_xy(g["lat"], g["lon"]) for g in geom if isinstance(g, dict) and isinstance(g.get("lat"), (int, float)) and isinstance(g.get("lon"), (int, float))]
        if len(pts) < 2: continue
        ways.append({"id": el.get("id"), "name": tags.get("name") or tags.get("bridge:name") or tags.get("ref") or "", "highway": hw, "foot": hw in _FOOT, "pts": pts})
    return ways

def build_index(ways, cell):
    segs = []; grid = {}
    for wi, w in enumerate(ways):
        pts = w["pts"]
        for i in range(len(pts) - 1):
            a, b = pts[i], pts[i + 1]
            if a[0] == b[0] and a[1] == b[1]: continue
            si = len(segs)
            segs.append((a[0], a[1], b[0], b[1], math.atan2(b[1] - a[1], b[0] - a[0]), wi, w["foot"]))
            for ci in range(math.floor(min(a[0], b[0]) / cell), math.floor(max(a[0], b[0]) / cell) + 1):
                for cj in range(math.floor(min(a[1], b[1]) / cell), math.floor(max(a[1], b[1]) / cell) + 1):
                    grid.setdefault((ci, cj), []).append(si)
    return {"segs": segs, "grid": grid, "cell": cell}

def ang_diff(a, b):
    d = abs(a - b) % math.pi
    return math.pi - d if d > math.pi / 2 else d

def nearest(ix, x, y, heading, R, max_ang, allow_foot, foot_penalty=0.0, prev_way=None, switch_penalty=0.0):
    c = ix["cell"]; best = None; best_score = float("inf"); seen = set(); segs = ix["segs"]; grid = ix["grid"]
    for ci in range(math.floor((x - R) / c), math.floor((x + R) / c) + 1):
        for cj in range(math.floor((y - R) / c), math.floor((y + R) / c) + 1):
            for si in grid.get((ci, cj), ()):
                if si in seen: continue
                seen.add(si)
                ax, ay, bx, by, ang, way, foot = segs[si]
                if foot and not allow_foot: continue
                if ang_diff(ang, heading) > max_ang: continue
                ux, uy = bx - ax, by - ay
                t = ((x - ax) * ux + (y - ay) * uy) / (ux * ux + uy * uy)
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                px, py = ax + ux * t, ay + uy * t
                d = math.hypot(x - px, y - py)
                if d > R: continue
                score = d + (foot_penalty if foot else 0.0) + (switch_penalty if (prev_way is not None and prev_way != way) else 0.0)
                if score < best_score:
                    best_score = score; best = (px, py, d, way, foot, ang)
    return best

def headings(p, span):
    out = []
    for i in range(len(p)):
        a = p[max(0, i - span)]; b = p[min(len(p) - 1, i + span)]
        out.append(math.atan2(b[1] - a[1], b[0] - a[0]))
    return out

def apply_t(T, p):
    a, b, tx, ty = T
    return [(a * x - b * y + tx, b * x + a * y + ty) for x, y in p]

def solve4(A, B):
    M = [list(A[i]) + [B[i]] for i in range(4)]
    for c in range(4):
        p = max(range(c, 4), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-9: return None
        M[c], M[p] = M[p], M[c]
        for r in range(c + 1, 4):
            f = M[r][c] / M[c][c]
            for k in range(c, 5): M[r][k] -= f * M[c][k]
    x = [0.0] * 4
    for i in range(3, -1, -1):
        x[i] = (M[i][4] - sum(M[i][j] * x[j] for j in range(i + 1, 4))) / M[i][i]
    return x

def snap_to_roads(trace, ways, course_m=None, step=10.0):
    """Align the traced course to OSM roads (translation, then scale/rotation), then snap it.
    Returns dict(ok, reason, xy, T, stats). Mirrors the viewer's JavaScript implementation."""
    stats = {"ways": len(ways), "matched": 0.0, "shiftM": 0.0, "scale": 1.0, "rotDeg": 0.0, "lengthM": 0.0, "traceLengthM": 0.0}
    if not ways: return {"ok": False, "reason": "OpenStreetMap returned no roads for this area.", "stats": stats}
    pts = resample(trace, step); stats["traceLengthM"] = cum_len(pts)[-1]
    ix = build_index(ways, 60.0)
    if not ix["segs"]: return {"ok": False, "reason": "OpenStreetMap returned no usable road geometry.", "stats": stats}
    T = (1.0, 0.0, 0.0, 0.0); deg = math.pi / 180
    for _ in range(8):                                   # phase 1: median translation
        cur = apply_t(T, pts); hd = headings(cur, 2); dxs = []; dys = []
        for q, h in zip(cur, hd):
            m = nearest(ix, q[0], q[1], h, 90.0, 20 * deg, False)
            if m: dxs.append(m[0] - q[0]); dys.append(m[1] - q[1])
        if len(dxs) < len(cur) * 0.3: break
        mx, my = median(dxs), median(dys)
        T = (T[0], T[1], T[2] + mx, T[3] + my)
        if math.hypot(mx, my) < 0.4: break
    cx0 = sum(p[0] for p in pts) / len(pts); cy0 = sum(p[1] for p in pts) / len(pts)
    for _ in range(12):                                  # phase 2: point-to-line similarity fit
        cur = apply_t(T, pts); hd = headings(cur, 2); rows = []; res = []
        for p0, q, h in zip(pts, cur, hd):
            m = nearest(ix, q[0], q[1], h, 45.0, 20 * deg, False)
            if m: rows.append((p0[0] - cx0, p0[1] - cy0, -math.sin(m[5]), math.cos(m[5]), m[0], m[1])); res.append(m[2])
        if len(rows) < len(pts) * 0.3: break
        thr = max(8.0, 2.5 * median(res)); A = [[0.0] * 4 for _ in range(4)]; B = [0.0] * 4; n = 0
        for r, e in zip(rows, res):
            if e > thr: continue
            c = (r[2] * r[0] + r[3] * r[1], -r[2] * r[1] + r[3] * r[0], r[2], r[3]); rhs = r[2] * r[4] + r[3] * r[5]
            for u in range(4):
                B[u] += c[u] * rhs
                for v in range(4): A[u][v] += c[u] * c[v]
            n += 1
        if n < 20: break
        sol = solve4(A, B)
        if not sol: break
        sc = math.hypot(sol[0], sol[1]); rot = math.atan2(sol[1], sol[0]) / deg
        if sc < 0.96 or sc > 1.04 or abs(rot) > 2: break
        nT = (sol[0], sol[1], sol[2] - sol[0] * cx0 + sol[1] * cy0, sol[3] - sol[1] * cx0 - sol[0] * cy0)
        moved = abs(nT[2] - T[2]) + abs(nT[3] - T[3]) + abs(nT[0] - T[0]) * 5000 + abs(nT[1] - T[1]) * 5000
        T = nT
        if moved < 0.3: break
    stats["scale"] = math.hypot(T[0], T[1]); stats["rotDeg"] = math.atan2(T[1], T[0]) / deg
    stats["shiftM"] = math.hypot(T[0] * cx0 - T[1] * cy0 + T[2] - cx0, T[1] * cx0 + T[0] * cy0 + T[3] - cy0)
    cur = apply_t(T, pts); hd = headings(cur, 2); out = []; prev = None; matched = 0; used = set()
    for q, h in zip(cur, hd):                            # phase 3: snap
        m = nearest(ix, q[0], q[1], h, 25.0, 30 * deg, True, 8.0, prev, 5.0)
        if m: out.append((m[0], m[1])); prev = m[3]; matched += 1; used.add(m[3])
        else: out.append(q); prev = None
    stats["matched"] = matched / len(cur)
    for _ in range(2):                                   # drop spikes
        for i in range(2, len(out) - 2):
            p0, p1 = out[i - 2], out[i + 2]; ux, uy = p1[0] - p0[0], p1[1] - p0[1]; l = math.hypot(ux, uy)
            if l < 1: continue
            dev = abs(ux * (out[i][1] - p0[1]) - uy * (out[i][0] - p0[0])) / l
            if dev > 14 and l < 4.6 * step:
                out[i] = ((out[i - 1][0] + out[i + 1][0]) / 2, (out[i - 1][1] + out[i + 1][1]) / 2)
    sm = [out[0]] + [(0.25 * out[k - 1][0] + 0.5 * out[k][0] + 0.25 * out[k + 1][0], 0.25 * out[k - 1][1] + 0.5 * out[k][1] + 0.25 * out[k + 1][1]) for k in range(1, len(out) - 1)] + [out[-1]]
    xy = simplify(sm, 0.8); stats["lengthM"] = cum_len(xy)[-1]; stats["waysUsed"] = len(used)
    stats["roadNames"] = sorted({ways[k]["name"] for k in used if ways[k]["name"]})
    res = {"ok": True, "reason": "", "xy": xy, "T": T, "stats": stats}
    target = course_m or stats["traceLengthM"]
    if stats["matched"] < 0.6: res["ok"] = False; res["reason"] = "Only %d%% of the route matched an OpenStreetMap road." % round(stats["matched"] * 100)
    elif stats["shiftM"] > 200: res["ok"] = False; res["reason"] = "The alignment moved the route %d m, which is too far to trust." % round(stats["shiftM"])
    elif abs(stats["lengthM"] / target - 1) > 0.06: res["ok"] = False; res["reason"] = "The snapped route is %.2f km, too far from the certified distance." % (stats["lengthM"] / 1000)
    return res

def parse_time(s):
    """'1:55:00' -> seconds. Raises ValueError on anything else."""
    p = [float(v) for v in str(s).strip().split(":")]
    if len(p) != 3 or min(p) < 0: raise ValueError("TARGET_TIME must look like h:mm:ss")
    return p[0] * 3600 + p[1] * 60 + p[2]

def run_cost(i):
    """Energy cost of running on a gradient, J/kg/m (polynomial from Minetti et al. 2002). i = rise/run."""
    i = max(-0.45, min(0.45, i))
    return ((((155.4 * i - 30.4) * i - 43.3) * i + 46.3) * i + 19.5) * i + 3.6

def build_pacing(target_s, model, step_km=0.01, smooth_km=0.2):
    """(km list, seconds list) for a target finish time. Mirrors the viewer.
    'effort': time per metre scales with run_cost(gradient); only half of the downhill saving is counted (assumption)."""
    n = max(1, round(COURSE_KM / step_km)); km = [0.0]; t = [0.0]; c0 = run_cost(0.0)
    for j in range(1, n + 1):
        k = COURSE_KM * j / n; mid = (k + km[-1]) / 2
        a = max(0.0, mid - smooth_km / 2); b = min(COURSE_KM, mid + smooth_km / 2)
        g = (elev_at(b) - elev_at(a)) / ((b - a) * 1000) if b > a else 0.0
        f = run_cost(g) / c0
        if f < 1: f = 1 - 0.5 * (1 - f)
        t.append(t[-1] + (k - km[-1]) * (f if model == "effort" else 1.0)); km.append(k)
    s = target_s / t[-1]
    t = [v * s for v in t]; t[-1] = target_s
    return km, t

def fetch_osm_ways(trace_xy):
    """Returns (ways, message). ways is [] when nothing usable came back."""
    ll = [to_ll(x, y) for x, y in simplify(trace_xy, 12.0)]
    last = "no endpoint tried"
    for url in OVERPASS_ENDPOINTS:
        for q in (build_overpass_query(ll, 90), build_overpass_bbox_query(ll, 0.002)):
            try:
                req = urllib.request.Request(url, data=("data=" + urllib.parse.quote(q)).encode("ascii"),
                                             headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "sgim26-blender-route/1.0"})
                with urllib.request.urlopen(req, timeout=OVERPASS_TIMEOUT_S) as r:
                    ways = parse_overpass(json.loads(r.read().decode("utf-8")))
                if ways: return ways, "ok"
                last = "empty answer from " + url
            except Exception as e:                       # network, HTTP, JSON: all mean "fall back"
                last = "%s: %s" % (url, e)
    return [], last

