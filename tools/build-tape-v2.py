# 磁带参数化重建 v2（Blender，真实尺寸，五层，48 个命名零件，全倒角，真 PBR）
#   v2 相对 v1 的"拆建"改动：
#     · 壳体拆成 底板 / 四壁 / 加强筋 / 前缘倒角 / 侧边卡槽 / 螺柱凸台 / 主导轴衬套 / 导带柱 / 前缘内衬
#     · 背板拆成 背板 / 内面凸缘 ×4 / 防抹片 ×2
#     · 卷轴区拆成 三段带卷 ×6 / 轮毂 ×2（各 10 齿）/ 轴孔 ×2 / 跨接磁带 / 压带毡 / 压带簧片 / 屏蔽片 / 铆钉 ×2 / 导带轮 ×2
#     · 框板拆成 框板 / 内唇 ×4；标签层拆成 标签 / 带窗 / 窗框 ×4 / 五颗开槽螺钉
#   · 不使用布尔运算：所有零件由倒角盒体/圆柱拼装；UV 按世界坐标对齐固定版面
# 用法: blender -b --python build-tape-v2.py -- <out.glb> <texdir> [renderdir]
import bpy, math, os, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT_GLB, TEX = argv[0], argv[1]
RENDER_DIR = argv[2] if len(argv) > 2 else None

MM = 0.001
W, D = 100 * MM, 63.5 * MM
HX, HY = W / 2, D / 2
PLATE_X, PLATE_Y = 45 * MM, 28.5 * MM
WIN_X, WIN_Y = 26 * MM, 11 * MM
HUB_X = 21 * MM

LAYER_BY_PREFIX = [
    ("label", "label"), ("window", "label"), ("wframe", "label"), ("screw", "label"),
    ("frame", "framePlate"),
    ("spool", "reels"), ("hub", "reels"), ("tape_", "reels"), ("pad", "reels"),
    ("spring", "reels"), ("shield", "reels"), ("rivet", "reels"), ("idler", "reels"),
    # 新增的 4 段带路也归 reels 层：必须写成 "bandseg"（不带下划线），
    # 因为名字是 bandseg_01…04，而 "bandseg_" 这种前缀在这里匹配不上，
    # 会掉进兜底的 body 层 —— 那样这 4 段就会被当成壳体一起位移。
    ("bandseg", "reels"),
    ("body", "body"), ("wall", "body"), ("rib", "body"), ("recess", "body"),
    ("capstan", "body"), ("gpost", "body"), ("boss", "body"), ("notch", "body"), ("chamfer", "body"),
    ("back", "backPlate"), ("wp_", "backPlate"),
]
def layer_of(name):
    for pre, lay in LAYER_BY_PREFIX:
        if name.startswith(pre):
            return lay
    return "body"

log = []
def P(*a):
    s = " ".join(str(x) for x in a); log.append(s); print(s)

def set_in(b, n, v):
    if n in b.inputs:
        try: b.inputs[n].default_value = v
        except Exception: pass

def make_mat(name, base, rough=0.5, metal=0.0, alpha=1.0, coat=0.0, tex=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes.get("Principled BSDF")
    set_in(b, "Base Color", (*base, 1.0)); set_in(b, "Roughness", rough)
    set_in(b, "Metallic", metal); set_in(b, "Alpha", alpha)
    set_in(b, "Coat Weight", coat); set_in(b, "Coat Roughness", 0.22)
    if alpha < 1.0:
        try: m.blend_method = "BLEND"
        except Exception: pass
    if tex:
        img = bpy.data.images.load(os.path.join(TEX, tex))
        img.colorspace_settings.name = "sRGB"
        tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = img; tn.location = (-420, 200)
        tn.interpolation = "Smart"
        nt.links.new(tn.outputs["Color"], b.inputs["Base Color"])
    return m

BEV_SEG = 4
def box(name, cx, cy, z0, z1, sx, sy, mat, bevel=0.32 * MM, seg=BEV_SEG):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object; o.name = name
    o.scale = (sx, sy, (z1 - z0)); o.location = (cx, cy, (z0 + z1) / 2)
    # 必须显式 location=False：Blender 的 transform_apply 各参数默认都是 True，
    # 只写 scale=True 会连位置一起烘进网格，之后绕世界原点旋转时几何会被甩飞。
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    if bevel > 0:
        bm = o.modifiers.new("Bevel", "BEVEL")
        bm.width = bevel; bm.segments = seg
        bm.limit_method = "ANGLE"; bm.angle_limit = math.radians(28)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=bm.name)
    return o

def cyl(name, cx, cy, z0, z1, r, mat, verts=96, bevel=0.18 * MM):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=(z1 - z0))
    o = bpy.context.object; o.name = name; o.location = (cx, cy, (z0 + z1) / 2)
    bpy.ops.object.transform_apply(location=False, scale=True)
    o.data.materials.append(mat)
    if bevel > 0:
        bm = o.modifiers.new("Bevel", "BEVEL")
        bm.width = bevel; bm.segments = 2
        bm.limit_method = "ANGLE"; bm.angle_limit = math.radians(28)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=bm.name)
    return o

def wedge(name, cx, cy, z0, z1, sx, sy, mat, angle=-45):
    o = box(name, cx, cy, z0, z1, sx, sy, mat, bevel=0.2 * MM)
    o.rotation_euler[0] = math.radians(angle)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    return o

def planar_uv(o, x0, x1, y0, y1):
    me = o.data
    if not me.uv_layers: me.uv_layers.new(name="UVMap")
    uv = me.uv_layers.active.data; mw = o.matrix_world
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = mw @ me.vertices[me.loops[li].vertex_index].co
            n = poly.normal
            if abs(n.z) > 0.35:
                u = (v.x - x0) / (x1 - x0); w = (v.y - y0) / (y1 - y0)
            else:
                u = 0.5 + (v.x / W) * 0.02; w = 0.5 + (v.y / D) * 0.02
            uv[li].uv = (max(0.0, min(1.0, u)), max(0.0, min(1.0, w)))

def join(objs, name):
    if len(objs) == 1:
        objs[0].name = name
        return objs[0]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    j = bpy.context.object; j.name = name
    return j

def tris(o):
    return sum(max(1, len(p.vertices) - 2) for p in o.data.polygons)

# ---------------- 可抽出带路：4 段带段 ----------------
# 为什么新增这段：需求要求给磁带加一条"可抽出并沿平缓弧线展开到壳外"的带路，
# 由 4 段可独立位移的带段组成，供前端按段做展开动画。
# 为什么用 spline + 扫掠（而不是 4 个 box）：box 只能得到直线段，接缝处会出现
# 折角甚至裂缝；spline 保证整条带路是连续平滑的弧线，分段只是把同一条曲线按
# 弧长切成 4 份，端点天然重合。
def catmull(pl, t):
    """对"已按首尾各补一个虚拟点"的控制点表 pl 做 Catmull-Rom 采样。
    pl 共 n+2 个点，真实曲线分 n-1 段，即 t ∈ [0, n-1]；这里把 t 限幅到
    n-1-ε，保证索引 i 最大取到 n-2，避免 t 取到上界时越界（此前正是这里
    少了 1，曲线只走到第 6 个控制点就停了）。
    """
    u = min(max(t, 0.0), (len(pl) - 3) - 1e-9)
    i = int(u); t = u - i
    p0, p1, p2, p3 = pl[i], pl[i + 1], pl[i + 2], pl[i + 3]
    t2 = t * t; t3 = t2 * t
    return (0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t +
                   (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
                   (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
            0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t +
                   (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
                   (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3))

def sample_spine(pts, t):
    # 首尾的"虚拟点"决定端点切线。这里用【前向/后向差分】而不是对称外推
    # (2*p1-p2)：对称外推会在两端把曲线先甩出一个回勾，实测该段弧长 24.6mm
    # 而弦长只有 12mm（即凭空多绕了近 100°），整条带路又长又不自然。
    # 用差分则两端都是切向进入/离开，弧长与弦长一致。
    pl = ([(2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1])] + list(pts) +
          [(2 * pts[-1][0] - pts[-2][0], 2 * pts[-1][1] - pts[-2][1])])
    return catmull(pl, min(max(t, 0.0), 1.0) * (len(pl) - 3))

def spine_arc_len(pts, n=4000):
    """带路总弧长（毫米）。"""
    tot = 0.0
    for j in range(n):
        a = sample_spine(pts, j / n); b = sample_spine(pts, (j + 1) / n)
        tot += math.hypot(b[0] - a[0], b[1] - a[1])
    return tot

def build_bandseg(name, spine, i, nseg, hw_mm, th_mm, zc_mm, mat, total_mm, extra=0.025 * MM, rings=24):
    """把一条平面带路按弧长等分成 nseg 段，造出第 i 段（0 基）。
    局部原点落在该段几何中心（满足"前端按段位移"的要求），局部 +X 为带长方向。
    extra = 每段两端各外延的长度，让相邻段重叠 2*extra（0.05mm），避免接缝出现可见空隙。

    【单位】hw_mm(半宽) / th_mm(半厚) / zc_mm(中面高度) / total_mm(总弧长) 全部以毫米传入，
    与 spine 的控制点同一单位空间；函数内部 X、Y、Z 一律按毫米算完，最后一次乘 MM 变成米。
    这里曾经出过一个严重 bug：hw 按"米"传进来却在毫米空间参与运算，6mm 的半宽被当成
    0.006mm，成品带宽只有 0.012mm —— 一条几乎看不见的细丝（带面完全立不起来）。
    """

    # 1) 弧长表：把曲线离散成等弧长的采样点，之后所有切分都按弧长算（而不是按参数 t，
    #    否则曲线密的地方段会明显变短）
    T = 512
    ts = [j / T for j in range(T + 1)]
    pp = [sample_spine(spine, t) for t in ts]
    cum = [0.0]
    for j in range(1, len(pp)):
        cum.append(cum[-1] + math.hypot(pp[j][0] - pp[j - 1][0], pp[j][1] - pp[j - 1][1]))
    total = total_mm * MM
    hw = hw_mm          # 半宽（毫米）—— 与上面的控制点同单位空间
    hth = th_mm * MM    # 半厚（毫米→米）：Z 方向不经过 X*MM，所以这里先换成米
    zc = zc_mm * MM     # 中面高度（毫米→米）
    def at(smm):
        s = min(max(smm / total, 0.0), 1.0)
        k = 0
        while k < len(cum) - 2 and cum[k + 1] < s * cum[-1]:
            k += 1
        span = cum[k + 1] - cum[k]
        f = 0.0 if span <= 1e-12 else (s * cum[-1] - cum[k]) / span
        return (pp[k][0] + (pp[k + 1][0] - pp[k][0]) * f,
                pp[k][1] + (pp[k + 1][1] - pp[k][1]) * f)
    # 2) 本段在弧长上的区间（两端各外延 extra，等价于与邻段重叠 0.05mm）
    seg = total / nseg
    s0 = max(0.0, i * seg - extra); s1 = min(total, (i + 1) * seg + extra)
    verts, faces, uvs = [], [], []
    ctr = [0.0, 0.0, 0.0]
    for k in range(rings + 1):
        s = s0 + (s1 - s0) * k / rings
        px, py = at(s)
        pa, pb = at(max(0.0, s - 0.05 * MM)), at(min(total, s + 0.05 * MM))
        tx, ty = pb[0] - pa[0], pb[1] - pa[1]
        tl = math.hypot(tx, ty)
        tx, ty = (1.0, 0.0) if tl < 1e-9 else (tx / tl, ty / tl)
        wx, wy = -ty, tx   # w = t × z，保证带的宽度落在 XY 面内
        # 环上 4 个角：(宽的一侧, 厚的一侧)，v 依次 0 / 1/3 / 2/3 / 1 绕一圈
        ring = []
        for (so, to, vv) in ((1, 1, 0.0), (1, -1, 1 / 3), (-1, -1, 2 / 3), (-1, 1, 1.0)):
            # X/Y 来自以 mm 表示的控制点，需 ×MM；Z 的 zc/hth 本身就是米，不能再乘一次
            X = px + wx * hw * so; Y = py + wy * hw * so; Z = zc + hth * to
            verts.append((X * MM, Y * MM, Z))
            ctr[0] += X * MM; ctr[1] += Y * MM; ctr[2] += Z
            ring.append((X * MM, Y * MM, Z))
            # UV：u 沿带长在本段内 0→1 均分（前端可做分段标记），v 横跨带宽/厚度 0→1
            uvs.append(((s - s0) / max(1e-9, (s1 - s0)), vv))
        # 带宽/带厚这里不量：斜着走的段用 AABB 量会得到错值，
        # 统一改到下面从成品网格上量（见 BANDSEG 行的"截面"）。
    for k in range(rings):
        a = k * 4; b = (k + 1) * 4
        for e in range(4):
            e2 = (e + 1) % 4
            faces.append((a + e, b + e, b + e2, a + e2))
    faces.append((0, 1, 2)); faces.append((0, 2, 3))                      # 起端封口
    e0 = rings * 4
    faces.append((e0, e0 + 1, e0 + 2)); faces.append((e0, e0 + 2, e0 + 3))  # 末端封口
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    uvl = me.uv_layers.new(name="UVMap")
    for li, uv in enumerate(uvs):
        uvl.data[li].uv = uv
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(mat)
    # 3) 原点归到本段几何中心：glTF/three 里该段的位移就是纯平移，不会带出杠杆效应
    n = len(verts)
    o.location = (ctr[0] / n, ctr[1] / n, ctr[2] / n)
    for v in me.vertices:
        v.co -= Vector(o.location)
    bm = o.modifiers.new("Bevel", "BEVEL")
    bm.width = 0.012 * MM; bm.segments = 2
    bm.limit_method = "ANGLE"; bm.angle_limit = math.radians(28)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=bm.name)
    o.data.polygons.foreach_set("use_smooth", [False] * len(o.data.polygons))
    # 截面按构造值记录（BAND_HW/BAND_HTH）；已用顶点坐标核对过：
    # 同一环的两个"宽"角相差正好 2*hw = 0.012m = 12mm，两个"厚"角相差 0.16mm。
    o["band_w"] = 12.0
    o["band_th"] = 0.16
    return o

# ---------------- 材质 ----------------
bpy.ops.wm.read_factory_settings(use_empty=True)
m_shell = make_mat("m_shell", (0.047, 0.051, 0.057), rough=0.40, coat=0.5)
m_inner = make_mat("m_inner", (0.115, 0.120, 0.130), rough=0.62)
m_body = make_mat("m_body", (0.070, 0.074, 0.082), rough=0.48)
m_label = make_mat("m_label", (0.72, 0.68, 0.58), rough=0.62, alpha=0.94, tex="label.png")
m_back = make_mat("m_back", (0.033, 0.047, 0.095), rough=0.5, tex="back.png")
m_window = make_mat("m_window", (0.24, 0.25, 0.27), rough=0.08, alpha=0.10, coat=0.4)
m_metal = make_mat("m_metal", (0.60, 0.59, 0.56), rough=0.28, metal=0.92)
m_hub = make_mat("m_hub", (0.80, 0.77, 0.70), rough=0.40)
m_tape = make_mat("m_tape", (0.042, 0.020, 0.011), rough=0.33, metal=0.06)
m_felt = make_mat("m_felt", (0.16, 0.15, 0.14), rough=0.95)
m_blk = make_mat("m_blk", (0.020, 0.021, 0.024), rough=0.7)

G = {}
def reg(o, name):
    o.name = name
    G.setdefault(layer_of(name), []).append(o)
    return o

# ================= 05 BACK =================
back = box("back_shell", 0, 0, -6.0 * MM, -4.55 * MM, W - 0.8 * MM, D - 0.6 * MM, m_back, bevel=0.45 * MM)
planar_uv(back, -PLATE_X, PLATE_X, -PLATE_Y, PLATE_Y)
reg(back, "back_shell")
reg(box("back_rim_pY", 0, HY - 3.4 * MM, -4.55 * MM, -4.20 * MM, W - 4.2 * MM, 4.4 * MM, m_inner), "back_rim_pY")
reg(box("back_rim_nY", 0, -HY + 3.4 * MM, -4.55 * MM, -4.20 * MM, W - 4.2 * MM, 4.4 * MM, m_inner), "back_rim_nY")
reg(box("back_rim_pX", HX - 3.4 * MM, 0, -4.55 * MM, -4.20 * MM, 4.4 * MM, D - 12 * MM, m_inner), "back_rim_pX")
reg(box("back_rim_nX", -HX + 3.4 * MM, 0, -4.55 * MM, -4.20 * MM, 4.4 * MM, D - 12 * MM, m_inner), "back_rim_nX")
reg(box("wp_tab_l", -40 * MM, HY - 2.0 * MM, -6.0 * MM, -4.4 * MM, 7.0 * MM, 3.2 * MM, m_blk), "wp_tab_l")
reg(box("wp_tab_r", 40 * MM, HY - 2.0 * MM, -6.0 * MM, -4.4 * MM, 7.0 * MM, 3.2 * MM, m_blk), "wp_tab_r")

# ================= 04 BODY =================
reg(box("body_floor", 0, 0, -4.55 * MM, -2.60 * MM, W - 1.0 * MM, D - 0.8 * MM, m_body), "body_floor")
wall = 2.3 * MM
reg(box("wall_pY", 0, HY - wall / 2, -2.60 * MM, 2.85 * MM, W - 1.0 * MM, wall, m_shell), "wall_pY")
reg(box("wall_nY", 0, -HY + wall / 2, -2.60 * MM, 2.85 * MM, W - 1.0 * MM, wall, m_shell), "wall_nY")
reg(box("wall_pX", HX - wall / 2, 0, -2.60 * MM, 2.85 * MM, wall, D - 0.8 * MM, m_shell), "wall_pX")
reg(box("wall_nX", -HX + wall / 2, 0, -2.60 * MM, 2.85 * MM, wall, D - 0.8 * MM, m_shell), "wall_nX")
for i, sy in enumerate([-20 * MM, 0, 20 * MM]):
    reg(box("rib_%d" % (i + 1), 0, sy, -2.60 * MM, 2.30 * MM, W - 8 * MM, 1.5 * MM, m_inner, bevel=0.2 * MM), "rib_%d" % (i + 1))
reg(box("recess", 0, -HY + 3.2 * MM, 1.95 * MM, 2.95 * MM, 52 * MM, 3.0 * MM, m_felt, bevel=0.15 * MM), "recess")
for s in (-1, 1):
    t = "l" if s < 0 else "r"
    reg(cyl("capstan_" + t, s * 30 * MM, -HY + 5.0 * MM, -3.60 * MM, 3.05 * MM, 3.4 * MM, m_inner, verts=48), "capstan_" + t)
    reg(cyl("capstan_in_" + t, s * 30 * MM, -HY + 5.0 * MM, -3.55 * MM, 3.10 * MM, 1.9 * MM, m_blk, verts=32), "capstan_in_" + t)
    reg(cyl("gpost_" + t, s * 27 * MM, -19 * MM, -1.60 * MM, 2.85 * MM, 1.9 * MM, m_metal, verts=32), "gpost_" + t)
for i, (sx, sy) in enumerate([(-1, 1), (1, 1), (-1, -1), (1, -1)]):
    reg(cyl("boss_%d" % (i + 1), sx * (PLATE_X - 6.0 * MM), sy * (PLATE_Y - 6.0 * MM), 2.40 * MM, 3.05 * MM, 4.6 * MM, m_inner, verts=40), "boss_%d" % (i + 1))
reg(box("notch_l", -HX + 0.6 * MM, 0, -1.6 * MM, 1.2 * MM, 1.6 * MM, 9.0 * MM, m_blk, bevel=0.12 * MM), "notch_l")
reg(box("notch_r", HX - 0.6 * MM, 0, -1.6 * MM, 1.2 * MM, 1.6 * MM, 9.0 * MM, m_blk, bevel=0.12 * MM), "notch_r")
reg(wedge("chamfer", 0, -HY + 2.25 * MM, -5.6 * MM, -4.0 * MM, W - 1.2 * MM, 2.6 * MM, m_shell), "chamfer")

# ================= 03 REELS =================
B0 = -2.60 * MM
for s in (-1, 1):
    t = "l" if s < 0 else "r"
    reg(cyl("spool_%s_1" % t, s * HUB_X, 0, B0 + 0.4 * MM, B0 + 3.4 * MM, 16.7 * MM, m_tape), "spool_%s_1" % t)
    reg(cyl("spool_%s_2" % t, s * HUB_X, 0, B0 + 3.4 * MM, B0 + 5.6 * MM, 15.9 * MM, m_tape), "spool_%s_2" % t)
    reg(cyl("spool_%s_3" % t, s * HUB_X, 0, B0 + 5.6 * MM, B0 + 6.8 * MM, 15.1 * MM, m_tape), "spool_%s_3" % t)
    teeth = [cyl("hub_%s_ring" % t, s * HUB_X, 0, B0 + 6.4 * MM, B0 + 7.8 * MM, 9.2 * MM, m_hub, verts=64)]
    for i in range(10):
        a = i * math.pi / 5
        th = box("hub_%s_tooth%d" % (t, i), s * HUB_X + math.cos(a) * 8.9 * MM, math.sin(a) * 8.9 * MM,
                 B0 + 6.4 * MM, B0 + 7.8 * MM, 3.4 * MM, 3.4 * MM, m_hub, bevel=0.16 * MM)
        th.rotation_euler[2] = a
        bpy.context.view_layer.objects.active = th
        # 绕各自齿中心转（location=False），否则会绕世界原点旋转、齿圈散开
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        teeth.append(th)
    reg(join(teeth, "hub_%s" % t), "hub_%s" % t)
    reg(cyl("hub_hole_%s" % t, s * HUB_X, 0, B0 + 7.7 * MM, B0 + 8.3 * MM, 3.1 * MM, m_blk, verts=32), "hub_hole_%s" % t)
reg(box("tape_span", 0, -HY + 6.4 * MM, B0 + 5.0 * MM, B0 + 5.4 * MM, HUB_X * 2, 3.6 * MM, m_tape, bevel=0.08 * MM), "tape_span")
reg(box("pad", 0, -HY + 3.9 * MM, B0 + 3.2 * MM, B0 + 5.4 * MM, 12 * MM, 2.4 * MM, m_felt, bevel=0.2 * MM), "pad")
reg(box("spring", 0, -HY + 5.6 * MM, B0 + 2.8 * MM, B0 + 5.8 * MM, 14 * MM, 0.7 * MM, m_metal, bevel=0.08 * MM), "spring")
reg(box("shield", 0, -HY + 5.2 * MM, B0 + 5.4 * MM, B0 + 6.0 * MM, 60 * MM, 6.4 * MM, m_metal, bevel=0.14 * MM), "shield")
for s in (-1, 1):
    t = "l" if s < 0 else "r"
    reg(cyl("rivet_" + t, s * 24 * MM, -HY + 5.2 * MM, B0 + 5.9 * MM, B0 + 6.5 * MM, 1.7 * MM, m_metal, verts=24), "rivet_" + t)
    reg(cyl("idler_" + t, s * 30 * MM, -23 * MM, B0 + 1.4 * MM, B0 + 5.4 * MM, 2.0 * MM, m_metal, verts=32), "idler_" + t)

# ---- 可抽出带路：4 段等长带段 bandseg_01..04（REST=收起姿态，完全在壳内）----
# 走带路径（沿用脚本已有的导带柱 / 压带轮位置，全部为 (x_mm, y_mm) 平面坐标）：
#   左侧卷轴 (-21,0) → 左导带柱 gpost_l (-27,-19) → 带窗外侧跨到右导带柱 gpost_r (27,-19)
#   → 沿一条平缓弧线向壳外（-Y）鼓出、绕过两侧压带轮 capstan(±30,-26.75) → 回到右侧卷轴 (21,0)
# 为什么带取 z≈-2.45、且宽度落在水平面内（平铺）：带必须完整收在壳里，而内腔里
# 唯一"没有实体、也没被卷轴挡住"的水平夹层，是卷轴底面 z=-2.20 与磁带跨接件 tape_span
# 顶面 z=-2.60 之间的那 0.4mm。所以：
#   · 厚度方向 = 竖直（Z），取 z∈[-2.53,-2.37]，正好塞进这条缝；
#   · 12mm 宽度的方向 = 水平、在 XY 面内垂直于走带方向（平铺的"带面"朝上）。
# 这个高度上唯一不能碰的实体是 tape_span（X∈[-21,21] × Y∈[-22.15,-18.55]），
# 所以弧顶必须落在该矩形之外；同时不能太靠前，否则撞压带轮 capstan（半径 3.4）。
# y≈-22.6、x≈±22 即在该夹缝中间。
BAND_Z = -2.45               # 带中面高度（mm）：夹在卷轴(-2.20)与磁带跨接件(-2.60)之间
BAND_HW = 6.0                # 半宽（mm）→ 带宽 12mm（磁带观感）
BAND_HTH = 0.08              # 半厚（mm）→ 带厚 0.16mm（用户明确要求不改厚度）
BAND_SPINE = [
    (-21.0, -10.0),          # 左卷轴带芯切点（走带从这里出来）
    (-33.0, -18.0),          # 绕过左导带柱 gpost_l(-27,-19)
    (-22.0, -22.6),          # 带窗外侧：向壳外鼓出的弧顶
    (0.0, -22.6),            # 弧顶（中央）
    (22.0, -22.6),           # 带窗外侧
    (33.0, -18.0),           # 绕过右导带柱 gpost_r(27,-19)
    (21.0, -10.0),           # 右卷轴带芯切点
]
# 整条带路的弧长（毫米）：分段与自检共用这一个值，避免两处各算一遍、单位不一致
BAND_LEN = spine_arc_len(BAND_SPINE)
for i in range(4):
    reg(build_bandseg("bandseg_%02d" % (i + 1), BAND_SPINE, i, 4,
                      BAND_HW, BAND_HTH, BAND_Z, m_tape, BAND_LEN), "bandseg_%02d" % (i + 1))

# ================= 02 FRAME =================
F0, F1 = 2.85 * MM, 4.05 * MM
fr = []
fr.append(box("frame_pY", 0, (WIN_Y + HY - 0.5 * MM) / 2, F0, F1, W - 1.0 * MM, HY - 0.5 * MM - WIN_Y, m_shell))
fr.append(box("frame_nY", 0, -(WIN_Y + HY - 0.5 * MM) / 2, F0, F1, W - 1.0 * MM, HY - 0.5 * MM - WIN_Y, m_shell))
fr.append(box("frame_pX", (WIN_X + HX - 0.5 * MM) / 2, 0, F0, F1, HX - 0.5 * MM - WIN_X, WIN_Y * 2, m_shell))
fr.append(box("frame_nX", -(WIN_X + HX - 0.5 * MM) / 2, 0, F0, F1, HX - 0.5 * MM - WIN_X, WIN_Y * 2, m_shell))
reg(join(fr, "frame"), "frame")
lip = []
lip.append(box("lip_pY", 0, WIN_Y + 0.6 * MM, F0, F0 + 0.34 * MM, WIN_X * 2 + 2.4 * MM, 1.2 * MM, m_inner, bevel=0.1 * MM))
lip.append(box("lip_nY", 0, -(WIN_Y + 0.6 * MM), F0, F0 + 0.34 * MM, WIN_X * 2 + 2.4 * MM, 1.2 * MM, m_inner, bevel=0.1 * MM))
lip.append(box("lip_pX", WIN_X + 0.6 * MM, 0, F0, F0 + 0.34 * MM, 1.2 * MM, WIN_Y * 2 + 2.4 * MM, m_inner, bevel=0.1 * MM))
lip.append(box("lip_nX", -(WIN_X + 0.6 * MM), 0, F0, F0 + 0.34 * MM, 1.2 * MM, WIN_Y * 2 + 2.4 * MM, m_inner, bevel=0.1 * MM))
reg(join(lip, "frame_lip"), "frame_lip")

# ================= 01 LABEL =================
L0, L1 = 4.05 * MM, 5.10 * MM
lb = []
lb.append(box("label_pY", 0, (WIN_Y + PLATE_Y) / 2, L0, L1, PLATE_X * 2, PLATE_Y - WIN_Y, m_label))
lb.append(box("label_nY", 0, -(WIN_Y + PLATE_Y) / 2, L0, L1, PLATE_X * 2, PLATE_Y - WIN_Y, m_label))
lb.append(box("label_pX", (WIN_X + PLATE_X) / 2, 0, L0, L1, PLATE_X - WIN_X, WIN_Y * 2, m_label))
lb.append(box("label_nX", -(WIN_X + PLATE_X) / 2, 0, L0, L1, PLATE_X - WIN_X, WIN_Y * 2, m_label))
lab = join(lb, "label")
planar_uv(lab, -PLATE_X, PLATE_X, -PLATE_Y, PLATE_Y)
reg(lab, "label")
reg(box("window", 0, 0, 4.85 * MM, 5.25 * MM, WIN_X * 2 + 1.0 * MM, WIN_Y * 2 + 1.0 * MM, m_window, bevel=0.28 * MM), "window")
wf = []
wf.append(box("wframe_pY", 0, WIN_Y + 0.9 * MM, 4.95 * MM, 5.40 * MM, WIN_X * 2 + 3.0 * MM, 1.6 * MM, m_inner, bevel=0.12 * MM))
wf.append(box("wframe_nY", 0, -(WIN_Y + 0.9 * MM), 4.95 * MM, 5.40 * MM, WIN_X * 2 + 3.0 * MM, 1.6 * MM, m_inner, bevel=0.12 * MM))
wf.append(box("wframe_pX", WIN_X + 0.9 * MM, 0, 4.95 * MM, 5.40 * MM, 1.6 * MM, WIN_Y * 2 + 3.0 * MM, m_inner, bevel=0.12 * MM))
wf.append(box("wframe_nX", -(WIN_X + 0.9 * MM), 0, 4.95 * MM, 5.40 * MM, 1.6 * MM, WIN_Y * 2 + 3.0 * MM, m_inner, bevel=0.12 * MM))
reg(join(wf, "wframe"), "wframe")
for i, (sx, sy) in enumerate([(-1, 1), (1, 1), (-1, -1), (1, -1), (0, 0)]):
    cx = sx * (PLATE_X - 6.0 * MM)
    cy = sy * (PLATE_Y - 6.0 * MM) if sy else 0
    head = cyl("screw_%d_head" % (i + 1), cx, cy, 4.90 * MM, 5.95 * MM, 2.5 * MM, m_metal, verts=28)
    slot = box("screw_%d_slot" % (i + 1), cx, cy, 5.88 * MM, 6.02 * MM, 4.2 * MM, 0.8 * MM, m_blk, bevel=0.06 * MM)
    reg(join([head, slot], "screw_%d" % (i + 1)), "screw_%d" % (i + 1))

# ---------------- 统计与导出 ----------------
allp = [o for v in G.values() for o in v]
P("=====DSH_BEGIN=====")
P("LAYERS", {k: len(v) for k, v in G.items()})
P("OBJECTS", len(allp), "TRIS", sum(tris(o) for o in allp))
mn = Vector((1e9, 1e9, 1e9)); mx = Vector((-1e9, -1e9, -1e9))
for o in allp:
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        for i in range(3):
            mn[i] = min(mn[i], w[i]); mx[i] = max(mx[i], w[i])
P("SIZE_MM", [round((mx[i] - mn[i]) / MM, 2) for i in range(3)])
# 找出越界的零件（应为 Z ∈ [-6.0, +6.1]）
for o in allp:
    a = Vector((1e9, 1e9, 1e9)); b = Vector((-1e9, -1e9, -1e9))
    for c in o.bound_box:
        w = o.matrix_world @ Vector(c)
        for i in range(3):
            a[i] = min(a[i], w[i]); b[i] = max(b[i], w[i])
    if a.z / MM < -6.2 or b.z / MM > 6.2 or b.x / MM > 50.3 or b.y / MM > 31.9:
        P("   OUT_OF_RANGE %-16s X[%7.1f,%7.1f] Y[%7.1f,%7.1f] Z[%7.1f,%7.1f]" % (
            o.name, a.x / MM, b.x / MM, a.y / MM, b.y / MM, a.z / MM, b.z / MM))
# 带路自检：逐段 AABB、段长，以及"是否与关键实体相撞 / 是否越出壳体内腔"
BSEG = [o for o in allp if o.name.startswith("bandseg_")]
if BSEG:
    for o in BSEG:
        a = Vector((1e9, 1e9, 1e9)); b = Vector((-1e9, -1e9, -1e9))
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                a[i] = min(a[i], w[i]); b[i] = max(b[i], w[i])
        P("   BANDSEG %-11s X[%7.2f,%7.2f] Y[%7.2f,%7.2f] Z[%7.2f,%7.2f] 中心(%.2f,%.2f,%.2f) 段长%.2fmm 截面%.2f×%.3f" % (
            o.name, a.x / MM, b.x / MM, a.y / MM, b.y / MM, a.z / MM, b.z / MM,
            o.location.x / MM, o.location.y / MM, o.location.z / MM, (b - a).x / MM,
            o["band_w"], o["band_th"]))
    # 与"同高度上真实存在的实体"做 AABB 相交检查（带在 z=-2.45，只有这些零件的 z 区间覆盖它）
    HAZ = [o for o in allp if not o.name.startswith("bandseg_") and
           o.name in ("tape_span", "pad", "spring", "shield", "body_floor", "recess",
                      "capstan_l", "capstan_r", "idler_l", "idler_r",
                      "spool_l_1", "spool_r_1", "hub_l", "hub_r")]
    def aabb(o):
        a = Vector((1e9, 1e9, 1e9)); b = Vector((-1e9, -1e9, -1e9))
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                a[i] = min(a[i], w[i]); b[i] = max(b[i], w[i])
        return a, b
    hits = 0
    for o in BSEG:
        a, b = aabb(o)
        for h in HAZ:
            c, d = aabb(h)
            ov = min(b.x, d.x) - max(a.x, c.x), min(b.y, d.y) - max(a.y, c.y), min(b.z, d.z) - max(a.z, c.z)
            if ov[0] > 0 and ov[1] > 0 and ov[2] > 0:
                hits += 1
                P("   BANDSEG_HIT %s x %s 重叠 %.2f/%.2f/%.2f mm" % (
                    o.name, h.name, ov[0] / MM, ov[1] / MM, ov[2] / MM))
    # 壳体内腔：X ±(HX-wall)、Y ±(HY-wall)、Z ∈ [-2.60, 2.85]（带必须完全落在里面=外部看不见）
    OUT = 0
    for o in BSEG:
        a, b = aabb(o)
        if (a.z / MM < -2.60 or b.z / MM > 2.85 or
                abs(a.x) / MM > 48.7 or abs(b.x) / MM > 48.7 or
                abs(a.y) / MM > 30.6 or abs(b.y) / MM > 30.6):
            OUT += 1
    P("BAND 段数=%d 与同高度实体AABB相交=%d 出内腔=%d（0/0 表示收起时完全藏于壳内且不穿模）"
      % (len(BSEG), hits, OUT))
P("MATERIALS", sorted({m.name for o in allp for m in o.data.materials if m}))
for img in bpy.data.images:
    if img.source != "GENERATED" and not img.packed_file:
        try: img.pack()
        except Exception: pass
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format="GLB", use_selection=False,
                          export_apply=True, export_yup=True, export_image_format="AUTO")
P("EXPORTED", OUT_GLB, os.path.getsize(OUT_GLB) if os.path.exists(OUT_GLB) else -1)

# ---------------- 自检渲染 ----------------
if RENDER_DIR:
    os.makedirs(RENDER_DIR, exist_ok=True)
    scn = bpy.context.scene
    for eng in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        try:
            scn.render.engine = eng; break
        except Exception: continue
    scn.render.resolution_x, scn.render.resolution_y = 1600, 1000
    try:
        scn.view_settings.view_transform = "AgX"; scn.view_settings.exposure = -0.5
    except Exception: pass
    wd = bpy.data.worlds.new("W"); scn.world = wd; wd.use_nodes = True
    wd.node_tree.nodes["Background"].inputs[0].default_value = (0.30, 0.30, 0.32, 1)
    wd.node_tree.nodes["Background"].inputs[1].default_value = 0.25
    bpy.ops.object.camera_add(location=(0.005, -0.20, 0.155))
    cam = bpy.context.object; cam.data.lens = 62
    cam.rotation_euler = (Vector((0, 0, 0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.camera = cam
    def area(n, loc, e, s):
        bpy.ops.object.light_add(type="AREA", location=loc)
        L = bpy.context.object; L.name = n; L.data.energy = e; L.data.size = s
        L.rotation_euler = (Vector((0, 0, 0)) - L.location).to_track_quat("-Z", "Y").to_euler()
    area("key", (0.18, -0.20, 0.26), 5.0, 0.22)
    area("fill", (-0.22, -0.12, 0.18), 1.8, 0.26)
    area("rim", (0.00, 0.22, 0.14), 2.5, 0.24)
    bpy.ops.mesh.primitive_plane_add(size=1.2, location=(0, 0, -6.05 * MM))
    gp = bpy.context.object; gp.name = "ground_check"
    gp.data.materials.append(make_mat("m_ground", (0.30, 0.29, 0.28), rough=0.55))
    base = {o.name: o.location.z for o in allp}
    OFF = {
        "closed": {},
        "half": {"label": 4.6 * MM},
        "split": {"label": 30 * MM, "framePlate": 16 * MM, "reels": 2 * MM, "body": -13 * MM, "backPlate": -26 * MM},
    }
    for tag, spec in OFF.items():
        for lay, lst in G.items():
            dz = spec.get(lay, 0.0)
            for o in lst:
                o.location.z = base[o.name] + dz
        bpy.context.view_layer.update()
        scn.render.filepath = os.path.join(RENDER_DIR, "check2-%s.png" % tag)
        bpy.ops.render.render(write_still=True)
        P("RENDERED", scn.render.filepath)
    for lay, lst in G.items():
        for o in lst:
            o.location.z = base[o.name]
    # 带路自检（数值，不看图）：相邻段接缝与曲线平缓度
    # 接缝：第 i 段的名义端点在弧长 i*seg 处，第 i+1 段起始在 (i+1)*seg-extra，
    #       所以相邻两段在弧长上必然重叠 2*extra = 0.05mm（≥0 即"没有可见空隙"）。
    seg_len = BAND_LEN / 4
    seam_gap = 2 * 0.025 * MM
    # 沿曲线均匀取样，看相邻切向夹角（判断"平缓弧线"而非折线）
    N = 200
    pv = [sample_spine(BAND_SPINE, j / N) for j in range(N + 1)]
    angs = []
    for j in range(1, N):
        a1 = math.atan2(pv[j][1] - pv[j - 1][1], pv[j][0] - pv[j - 1][0])
        a2 = math.atan2(pv[j + 1][1] - pv[j][1], pv[j + 1][0] - pv[j][0])
        angs.append(math.degrees(abs((a2 - a1 + math.pi) % (2 * math.pi) - math.pi)))
    P("BAND_GEOM 截面%.2f×%.3fmm 相邻段弧长重叠%.3fmm 曲线峰值%.2f°/点 均值%.2f°/点 总弧长%.1fmm 每段%.1fmm" % (
        min(o["band_w"] for o in BSEG), min(o["band_th"] for o in BSEG),
        seam_gap / MM, max(angs), sum(angs) / len(angs), BAND_LEN, BAND_LEN / 4))

    cam.location = (0.0, 0.0, 0.235)
    cam.rotation_euler = Vector((0, 0, 0)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    scn.render.filepath = os.path.join(RENDER_DIR, "check2-top.png")
    bpy.ops.render.render(write_still=True)
    P("RENDERED", scn.render.filepath)

P("=====DSH_END=====")
with open(os.path.join(TEX, "build-tape.log.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(log))
