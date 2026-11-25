# ----------------------------------------------------------------------------- Blender scene
def _emission(bpy, name, rgb, strength=1.0, alpha=1.0, image=None):
    mat = bpy.data.materials.new(name)
    try: mat.use_nodes = True
    except Exception: pass
    nt = mat.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial"); em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = (rgb[0], rgb[1], rgb[2], 1.0); em.inputs["Strength"].default_value = strength
    a_src = None
    if image is not None:
        tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = image; tex.extension = "CLIP"
        nt.links.new(tex.outputs["Color"], em.inputs["Color"]); a_src = tex.outputs["Alpha"]
    if alpha < 1.0 or a_src is not None:
        tr = nt.nodes.new("ShaderNodeBsdfTransparent"); mix = nt.nodes.new("ShaderNodeMixShader")
        if a_src is not None: nt.links.new(a_src, mix.inputs[0])
        else: mix.inputs[0].default_value = alpha
        nt.links.new(tr.outputs[0], mix.inputs[1]); nt.links.new(em.outputs[0], mix.inputs[2]); nt.links.new(mix.outputs[0], out.inputs["Surface"])
        for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
            try: setattr(mat, attr, val)
            except Exception: pass
    else:
        nt.links.new(em.outputs[0], out.inputs["Surface"])
    mat.diffuse_color = (rgb[0], rgb[1], rgb[2], alpha)
    return mat

def build_scene(route_xy, frame_T, source_note):
    import bpy
    from mathutils import Vector
    S = SCALE; ZX = VERTICAL_EXAGGERATION * SCALE
    scene = bpy.context.scene
    if CLEAR_PREVIOUS and COLLECTION_NAME in bpy.data.collections:
        old = bpy.data.collections[COLLECTION_NAME]
        for ob in list(old.all_objects): bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.collections.remove(old)
    col = bpy.data.collections.new(COLLECTION_NAME); scene.collection.children.link(col)
    def link(ob): col.objects.link(ob); return ob
    a, b, tx, ty = frame_T
    def fr(x, y): return (a * x - b * y + tx, b * x + a * y + ty)      # map-derived layers follow the OSM alignment

    L = cum_len(route_xy); total = L[-1]
    def pos_km(km):
        x, y, dx, dy = point_at(route_xy, L, total * km / COURSE_KM)
        return x, y, elev_at(km), dx, dy

    m_course = _emission(bpy, "SGIM course", (1.0, 0.06, 0.62), 2.5)
    m_curtain = _emission(bpy, "SGIM curtain", (1.0, 0.06, 0.62), 1.0, alpha=0.22)
    m_label = _emission(bpy, "SGIM label", (0.92, 0.93, 1.0), 1.5)
    m_km = _emission(bpy, "SGIM km", (1.0, 0.65, 0.9), 1.8)
    m_post = _emission(bpy, "SGIM post", (0.25, 0.3, 0.75), 1.0)
    m_runner = _emission(bpy, "SGIM runner", (1.0, 0.66, 0.05), 4.0)
    m_land = _emission(bpy, "SGIM ground", (0.004, 0.006, 0.03), 1.0)

    # ground + street underlay (roads/water/land mask derived from the route map)
    bm = DATA["basemap"]
    png = os.path.join(tempfile.gettempdir(), "sgim26_basemap.png")
    with open(png, "wb") as f: f.write(base64.b64decode(BASEMAP_PNG_B64))
    img = bpy.data.images.load(png, check_existing=False); img.name = "SGIM26 basemap"
    try: img.pack()
    except Exception: pass
    corners = [fr(bm["x0"], bm["y0"]), fr(bm["x1"], bm["y0"]), fr(bm["x1"], bm["y1"]), fr(bm["x0"], bm["y1"])]
    me = bpy.data.meshes.new("SGIM underlay"); me.from_pydata([(x * S, y * S, 0.0) for x, y in corners], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name="UVMap")
    for i, c in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))): uv.data[i].uv = c
    me.materials.append(_emission(bpy, "SGIM underlay", (0.03, 0.05, 0.2), 1.0, image=img)); link(bpy.data.objects.new("Street underlay", me))
    cx = (corners[0][0] + corners[2][0]) / 2 * S; cy = (corners[0][1] + corners[2][1]) / 2 * S
    g = bpy.data.meshes.new("SGIM ground"); r = 400.0
    g.from_pydata([(cx - r, cy - r, -0.02), (cx + r, cy - r, -0.02), (cx + r, cy + r, -0.02), (cx - r, cy + r, -0.02)], [], [(0, 1, 2, 3)])
    g.materials.append(m_land); link(bpy.data.objects.new("Ground", g))

    # course curve (10 m spacing) + curtain
    n = max(2, round(total / 10.0)); pts = []
    for i in range(n + 1):
        km = COURSE_KM * i / n; x, y, el, _, _ = pos_km(km); pts.append((x * S, y * S, el * ZX + 0.02))
    cu = bpy.data.curves.new("SGIM course", "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = 0.09; cu.bevel_resolution = 2; cu.use_fill_caps = True
    sp = cu.splines.new("POLY"); sp.points.add(len(pts) - 1)
    for p, c in zip(sp.points, pts): p.co = (c[0], c[1], c[2], 1.0)
    cu.materials.append(m_course); cu.use_path = True
    course = link(bpy.data.objects.new("Course 21.0975 km", cu))
    cm = bpy.data.meshes.new("SGIM curtain"); verts = []; faces = []
    for i, c in enumerate(pts):
        verts += [(c[0], c[1], 0.005), c]
        if i: faces.append((2 * i - 2, 2 * i, 2 * i + 1, 2 * i - 1))
    cm.from_pydata(verts, [], faces); cm.materials.append(m_curtain); link(bpy.data.objects.new("Elevation curtain", cm))

    def post(name, x, y, z0, z1):
        pc = bpy.data.curves.new(name, "CURVE"); pc.dimensions = "3D"; pc.bevel_depth = 0.012
        s2 = pc.splines.new("POLY"); s2.points.add(1); s2.points[0].co = (x, y, z0, 1); s2.points[1].co = (x, y, z1, 1)
        pc.materials.append(m_post); return link(bpy.data.objects.new(name, pc))
    def text(name, body, x, y, z, size, mat):
        tc = bpy.data.curves.new(name, "FONT"); tc.body = body; tc.size = size; tc.align_x = "CENTER"; tc.extrude = 0.004
        tc.materials.append(mat); ob = link(bpy.data.objects.new(name, tc)); ob.location = (x, y, z); ob.rotation_euler = (math.radians(72), 0, 0)
        return ob
    for k in range(0, 22):                               # kilometre markers
        x, y, el, _, _ = pos_km(float(k)); z = el * ZX
        label = "START" if k == 0 else str(k)
        post("km %02d post" % k, x * S, y * S, z, z + 1.1); text("km %02d" % k, label, x * S, y * S, z + 1.15, 0.75 if k % 5 == 0 or k == 0 else 0.55, m_km)
    x, y, el, _, _ = pos_km(COURSE_KM)
    post("finish post", x * S, y * S, el * ZX, el * ZX + 2.6); text("finish", "FINISH 21.0975", x * S, y * S, el * ZX + 2.65, 0.75, m_km)
    for lm in DATA["landmarks"]:                         # landmarks
        if lm["kind"] in ("start", "finish"): continue
        x, y = fr(*to_xy(lm["lat"], lm["lon"]))
        post(lm["name"] + " post", x * S, y * S, 0.0, 2.0); text(lm["name"], lm["name"], x * S, y * S, 2.05, 0.6, m_label)

    # world, overview camera
    try:
        w = scene.world or bpy.data.worlds.new("SGIM world"); scene.world = w
        try: w.use_nodes = True
        except Exception: pass
        bgn = w.node_tree.nodes.get("Background")
        if bgn: bgn.inputs[0].default_value = (0.003, 0.005, 0.02, 1.0)
    except Exception: pass
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]; mx = (min(xs) + max(xs)) / 2; my = (min(ys) + max(ys)) / 2
    cam = bpy.data.cameras.new("SGIM overview"); cam.lens = 40; cam.clip_start = 0.1; cam.clip_end = 5000
    cam_ob = link(bpy.data.objects.new("Overview camera", cam))
    cam_ob.location = (mx - 22, my - 58, 44)
    cam_ob.rotation_euler = (Vector((mx, my, 0)) - cam_ob.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam_ob

    if ADD_FLYTHROUGH:
        target_s = parse_time(TARGET_TIME)
        pk, pt = build_pacing(target_s, PACING)
        frames = max(2, round(target_s / TIME_COMPRESSION * FPS))
        cu.path_duration = frames
        # Follow Path measures along the 3D curve, and exaggerated climbs lengthen it, so map km -> 3D fraction
        L3 = [0.0]
        for i in range(1, len(pts)):
            L3.append(L3[-1] + math.dist(pts[i - 1], pts[i]))
        def frac3d(km):
            f = km / COURSE_KM * n; i = min(n - 1, int(f)); return (L3[i] + (L3[i + 1] - L3[i]) * (f - i)) / L3[-1]
        runner = link(bpy.data.objects.new("Runner", None)); runner.empty_display_type = "PLAIN_AXES"; runner.empty_display_size = 0.2
        con = runner.constraints.new("FOLLOW_PATH"); con.target = course; con.use_fixed_location = True; con.use_curve_follow = True
        con.forward_axis = "FORWARD_Y"; con.up_axis = "UP_Z"
        try: bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
        except Exception: pass
        k = 0.0
        while True:                                      # a key every 100 m, timed by the pacing table
            con.offset_factor = min(1.0, frac3d(k)); con.keyframe_insert("offset_factor", frame=1 + interp(pk, pt, k) / target_s * (frames - 1))
            if k >= COURSE_KM: break
            k = min(COURSE_KM, k + 0.1)
        # runner figure: boxes in mid-stride, feet on the course, facing +Y
        H = RUNNER_HEIGHT; verts = []; faces = []
        def box(cx, cy, cz, w, d, h, pitch=0.0):
            c, s_ = math.cos(pitch), math.sin(pitch); o = len(verts)
            for dx, dy, dz in ((-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1), (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)):
                x, y, z = dx * w / 2, dy * d / 2, dz * h / 2
                verts.append(((cx + x) * H, (cy + y * c - z * s_) * H, (cz + y * s_ + z * c) * H))
            faces.extend([(o, o + 3, o + 2, o + 1), (o + 4, o + 5, o + 6, o + 7), (o, o + 1, o + 5, o + 4), (o + 1, o + 2, o + 6, o + 5), (o + 2, o + 3, o + 7, o + 6), (o + 3, o, o + 4, o + 7)])
        box(0, 0.02, 0.67, 0.26, 0.15, 0.34, -0.12)            # torso
        box(0, 0.05, 0.92, 0.15, 0.15, 0.16)                   # head
        box(-0.075, 0.12, 0.36, 0.1, 0.1, 0.3, -0.7); box(-0.075, 0.2, 0.14, 0.09, 0.09, 0.26, 0.25)     # leading leg
        box(0.075, -0.1, 0.36, 0.1, 0.1, 0.3, 0.6); box(0.075, -0.3, 0.26, 0.09, 0.09, 0.26, 1.35)       # trailing leg
        box(-0.17, -0.08, 0.7, 0.065, 0.065, 0.22, 0.7); box(0.17, 0.1, 0.7, 0.065, 0.065, 0.22, -0.7)   # arms
        fm = bpy.data.meshes.new("SGIM runner"); fm.from_pydata(verts, [], faces); fm.materials.append(m_runner)
        fig = link(bpy.data.objects.new("Runner figure", fm)); fig.parent = runner; fig.location = (0, 0, cu.bevel_depth)
        c2 = bpy.data.cameras.new("SGIM chase"); c2.lens = 28; c2.clip_start = 0.05; c2.clip_end = 5000
        chase = link(bpy.data.objects.new("Chase camera", c2)); chase.location = (-5.0, -9.0, 5.5)   # fixed offset from the runner, seen from the south-west
        cl = chase.constraints.new("COPY_LOCATION"); cl.target = runner; cl.use_offset = True
        tr = chase.constraints.new("TRACK_TO"); tr.target = runner; tr.track_axis = "TRACK_NEGATIVE_Z"; tr.up_axis = "UP_Y"
        scene.frame_start = 1; scene.frame_end = frames
        try: scene.render.fps = FPS
        except Exception: pass
        col["race"] = "%s finish, %s pacing, %d frames at %d fps (1 s of animation = %g s of race)" % (TARGET_TIME, PACING, frames, FPS, TIME_COMPRESSION)
    try:
        scene.unit_settings.system = "METRIC"; scene.unit_settings.scale_length = 1.0 / S
    except Exception: pass
    col["source"] = source_note
    return col

def main():
    trace = [to_xy(lat, lon) for lat, lon in DATA["route"]]
    route, T, note = trace, (1.0, 0.0, 0.0, 0.0), "Built-in trace of the organiser's map (positions approximate)."
    if USE_LIVE_OSM:
        ways, msg = fetch_osm_ways(trace)
        if not ways:
            print("[SGIM26] OpenStreetMap fetch failed, using the built-in trace. Reason:", msg)
        else:
            res = snap_to_roads(trace, ways, course_m=COURSE_KM * 1000)
            st = res["stats"]
            if res["ok"]:
                route, T = res["xy"], res["T"]
                note = "Snapped to OpenStreetMap roads: %d%% matched, moved %.0f m, scale %+.1f%%, centre-line %.2f km." % (round(st["matched"] * 100), st["shiftM"], (st["scale"] - 1) * 100, st["lengthM"] / 1000)
            else:
                print("[SGIM26] OpenStreetMap result rejected, using the built-in trace. Reason:", res["reason"])
    print("[SGIM26]", note)
    build_scene(route, T, note)
    print("[SGIM26] Built collection '%s'. Vertical exaggeration %gx, 1 Blender unit = %g m." % (COLLECTION_NAME, VERTICAL_EXAGGERATION, 1.0 / SCALE))

if __name__ == "__main__":
    main()
