import bpy, sys
argv = sys.argv[sys.argv.index("--")+1:]
SRC = argv[0]
print("=====DSH_BEGIN=====")
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
meshes=[o for o in bpy.data.objects if o.type=="MESH"]
print("OBJECTS", len(bpy.data.objects), "MESHES", len(meshes))
for o in meshes:
    print("MESH", o.name, "verts", len(o.data.vertices), "polys", len(o.data.polygons),
          "materials", [ (m.name if m else None) for m in o.data.materials ],
          "uv_layers", [u.name for u in o.data.uv_layers])
before = len([x for x in bpy.data.objects if x.type=="MESH"])
bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    try:
        bpy.ops.mesh.separate(type="LOOSE")
    except Exception as e:
        print("SEPARATE_FAIL", e)
    o.select_set(False)
after = [x for x in bpy.data.objects if x.type=="MESH"]
print("LOOSE_PARTS_BEFORE", before, "AFTER", len(after))
sizes = sorted([(len(x.data.polygons), x.name) for x in after], reverse=True)[:12]
for n,name in sizes:
    print("  PART", name, "polys", n)
print("IMAGE_COUNT", len(bpy.data.images))
for im in bpy.data.images:
    print("  IMG", im.name, im.size[0], im.size[1])
print("=====DSH_END=====")
