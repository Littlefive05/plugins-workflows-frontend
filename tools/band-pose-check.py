# 一次性诊断：把交付的 tape.glb 载入 Blender，把 4 段带路分别沿世界 ±Y 推出去，
# 打印每段的 AABB（判断是否真的到了壳外），并各渲染一张图。
# 用法: blender -b --python tools/band-pose-check.py
import bpy
import os
import sys
from mathutils import Vector

MM = 0.001
ROOT = r'C:\LFModels\workspaces\series-0x2b'
GLB = os.path.join(ROOT, 'public', 'assets', '3d', 'tape.glb')
OUT = os.path.join(ROOT, 'tools', 'band-check')
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

bands = [o for o in bpy.data.objects if o.name.lower().startswith('bandseg')]
others = [o for o in bpy.data.objects if o.type == 'MESH' and o not in bands]
print('BANDS_FOUND', len(bands), [o.name for o in bands])

def wbox(objs, tag):
    xs, ys, zs = [], [], []
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            xs.append(w.x); ys.append(w.y); zs.append(w.z)
    if not xs:
        print(tag, 'EMPTY')
        return
    print(f'{tag} X[{min(xs)/MM:.1f},{max(xs)/MM:.1f}] Y[{min(ys)/MM:.1f},{max(ys)/MM:.1f}] Z[{min(zs)/MM:.1f},{max(zs)/MM:.1f}] (mm)')

wbox(others, 'SHELL_ALL')
wbox(bands, 'BAND_rest')

orig = {o.name: o.matrix_world.copy() for o in bands}

cam_data = bpy.data.cameras.new('cam')
cam = bpy.data.objects.new('cam', cam_data)
bpy.context.scene.collection.objects.link(cam)
cam.location = (0.0, -0.30, 0.19)
d = Vector((0, 0, 0)) - cam.location
cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam

sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'
sc.display.shading.color_type = 'MATERIAL'
sc.render.resolution_x, sc.render.resolution_y = 900, 520
sc.render.film_transparent = False

for tag, dy in (('rest', 0.0), ('minusY62', -0.062), ('plusY62', 0.062)):
    for o in bands:
        m = orig[o.name].copy()
        m.translation.y += dy          # 世界 Y 平移，避免受 glTF 根节点旋转影响
        o.matrix_world = m
    bpy.context.view_layer.update()
    wbox(bands, f'BAND_{tag}')
    sc.render.filepath = os.path.join(OUT, f'band-{tag}.png')
    bpy.ops.render.render(write_still=True)
    print('RENDERED', sc.render.filepath)
print('DONE')
