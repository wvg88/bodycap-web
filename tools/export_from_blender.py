"""
Exporteert het skeletmodel uit human-skeleton.blend naar een schone .glb voor de web-app.

Gebruik (Blender 4.2 of nieuwer):
    blender --background human-skeleton.blend --python export_from_blender.py -- skelet_raw.glb

Daarna comprimeren met gltfpack (npm install gltfpack), zonder de mesh te vereenvoudigen:
    npx gltfpack -i skelet_raw.glb -o human-skeleton.glb -cc -kn -km -vp 16 -vn 10

Wat het doet:
  * De gegenereerde Rigify-rig heeft 411 botten; de 77 vervormende botten hangen
    niet aan elkaar, maar elk aan een eigen tussenbot met constraints. In glTF
    bestaan geen constraints, dus zo'n export is niet te animeren.
  * Dit script bouwt daarom een nieuw, schoon skelet van 59 botten met een
    logische hiërarchie (heupen > rug > borst > nek > hoofd, armen, vingers, benen)
    op de rustposities van de rig, en koppelt de mesh daaraan.
  * De Mirror-modifier wordt toegepast (de mesh is in het bestand maar half) en
    Subdivision Surface wordt weggelaten: alle gemodelleerde details blijven, de
    extra gladmaak-driehoeken niet.
"""

import sys

import bpy

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "skelet_raw.glb"
RIG_NAME, MESH_NAME = "rig", "Plane.017"

rig = bpy.data.objects[RIG_NAME]
src_mesh = bpy.data.objects[MESH_NAME]
scene = bpy.context.scene

# --- 1. Welke botten, met welke ouder -----------------------------------------
BONES = [("hips", None), ("spine", "hips"), ("chest", "spine"), ("neck", "chest"), ("head", "neck")]
for s in ("L", "R"):
    BONES += [
        (f"shoulder.{s}", "chest"), (f"upper_arm.{s}", f"shoulder.{s}"),
        (f"forearm.{s}", f"upper_arm.{s}"), (f"hand.{s}", f"forearm.{s}"),
        (f"thigh.{s}", "hips"), (f"shin.{s}", f"thigh.{s}"),
        (f"foot.{s}", f"shin.{s}"), (f"toe.{s}", f"foot.{s}"),
    ]
    for n, finger in enumerate(("f_index", "f_middle", "f_ring", "f_pinky"), start=1):
        palm = f"palm.0{n}.{s}"
        BONES.append((palm, f"hand.{s}"))
        BONES += [(f"{finger}.01.{s}", palm), (f"{finger}.02.{s}", f"{finger}.01.{s}"),
                  (f"{finger}.03.{s}", f"{finger}.02.{s}")]
    BONES += [(f"thumb.01.{s}", f"palm.01.{s}"), (f"thumb.02.{s}", f"thumb.01.{s}"),
              (f"thumb.03.{s}", f"thumb.02.{s}")]


def target_bone(def_name):
    """DEF-upper_arm.02.L -> upper_arm.L, DEF-f_index.01.L.02 -> f_index.01.L, DEF-hand.L -> hand.L."""
    n = def_name[4:] if def_name.startswith("DEF-") else def_name
    parts = n.split(".")
    side = parts[-1] if parts[-1] in ("L", "R") else None
    if side is None and len(parts) > 1 and parts[-2] in ("L", "R"):   # f_index.01.L.02
        return ".".join(parts[:-1])
    base = parts[0]
    if base in ("upper_arm", "forearm", "thigh", "shin") and side:   # segmenten .01/.02 samenvoegen
        return f"{base}.{side}"
    return n


# --- 2. Nieuw skelet op de rustposities van de rig ----------------------------
rest = {}
for name, _parent in BONES:
    b = rig.data.bones.get("ORG-" + name) or rig.data.bones.get("DEF-" + name)
    if b is None:
        raise SystemExit(f"Bot niet gevonden in de rig: {name}")
    rest[name] = (b.head_local.copy(), b.tail_local.copy(), b.matrix_local.copy(), b.length)

arm_data = bpy.data.armatures.new("Skelet")
arm = bpy.data.objects.new("Skelet", arm_data)
scene.collection.objects.link(arm)
arm.matrix_world = rig.matrix_world.copy()
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
for name, parent in BONES:
    head, tail, mat, _len = rest[name]
    eb = arm_data.edit_bones.new(name)
    eb.head, eb.tail = head, tail
    eb.matrix = mat          # neemt ook de roll over
    eb.length = _len
    if parent:
        eb.parent = arm_data.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')

# --- 3. Mesh: kopie, mirror toepassen, subdivision weg, gewichten omzetten -----
mesh = src_mesh.copy()
mesh.data = src_mesh.data.copy()
mesh.name = "SkeletMesh"
scene.collection.objects.link(mesh)
for o in bpy.context.view_layer.objects:
    o.select_set(False)
mesh.select_set(True)
bpy.context.view_layer.objects.active = mesh
for m in list(mesh.modifiers):
    if m.type == 'MIRROR':
        bpy.ops.object.modifier_apply(modifier=m.name)
    else:
        mesh.modifiers.remove(m)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

groups = {g.index: g.name for g in mesh.vertex_groups}
weights = {}   # doelbot -> {vertex: gewicht}
for v in mesh.data.vertices:
    for g in v.groups:
        if g.weight <= 0.0:
            continue
        tgt = target_bone(groups[g.group])
        if tgt in rest:
            d = weights.setdefault(tgt, {})
            d[v.index] = d.get(v.index, 0.0) + g.weight
mesh.vertex_groups.clear()
for tgt, d in weights.items():
    vg = mesh.vertex_groups.new(name=tgt)
    for vi, w in d.items():
        vg.add([vi], min(1.0, w), 'REPLACE')
unweighted = sum(1 for v in mesh.data.vertices if not v.groups)

while mesh.data.uv_layers:           # geen texturen in dit model: UV's weglaten
    mesh.data.uv_layers.remove(mesh.data.uv_layers[0])
mod = mesh.modifiers.new("Armature", 'ARMATURE')
mod.object = arm
mesh.parent = arm

# --- 4. Exporteren -------------------------------------------------------------
for o in bpy.context.view_layer.objects:
    o.select_set(False)
arm.select_set(True)
mesh.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=True, export_apply=False,
    export_skins=True, export_animations=False, export_yup=True, export_normals=True,
    export_tangents=False, export_texcoords=False, export_materials='EXPORT',
    export_extras=False, export_cameras=False, export_lights=False,
)
print(f"EXPORT KLAAR: {OUT} | botten {len(BONES)} | vertices {len(mesh.data.vertices)} | "
      f"vlakken {len(mesh.data.polygons)} | vertices zonder gewicht {unweighted} | "
      f"vertex groups {len(mesh.vertex_groups)}")
