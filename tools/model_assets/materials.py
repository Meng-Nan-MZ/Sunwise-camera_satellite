"""Blender Principled materials using only glTF-compatible inputs."""
from pathlib import Path

import bpy


def linear_color(rgb):
    return tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb) + (1.,)


def make_material(name, color, metallic, roughness, *, color_map=None, normal_map=None, roughness_map=None, normal_strength=1.):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = linear_color(color)
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = linear_color(color)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness

    def texture(path, color_space):
        image = bpy.data.images.load(str(path), check_existing=True)
        image.colorspace_settings.name = color_space
        image.pack()
        node = nodes.new("ShaderNodeTexImage")
        node.image = image
        return node.outputs["Color"]

    if color_map:
        links.new(texture(color_map, "sRGB"), shader.inputs["Base Color"])
    if roughness_map:
        links.new(texture(roughness_map, "Non-Color"), shader.inputs["Roughness"])
    if normal_map:
        normal = nodes.new("ShaderNodeNormalMap")
        normal.inputs["Strength"].default_value = normal_strength
        links.new(texture(normal_map, "Non-Color"), normal.inputs["Color"])
        links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    return material


def navigation_materials(texture_root: Path):
    return [
        make_material("MLI_GoldFoil", (.77, .55, .20), .72, .45,
                      color_map=texture_root / "mli_gold_color.png",
                      normal_map=texture_root / "mli_normal.png",
                      roughness_map=texture_root / "mli_roughness.png", normal_strength=.65),
        make_material("SolarCells_CobaltBlue", (.06, .16, .33), .32, .32,
                      color_map=texture_root / "solar_cells_color.png",
                      normal_map=texture_root / "solar_cells_normal.png", normal_strength=.4),
        make_material("Aluminium_Structure", (.73, .77, .83), .78, .3),
        make_material("Radiator_Ceramic", (.78, .81, .83), .04, .57),
    ]


def sputnik_material(texture_root: Path):
    return make_material("Sputnik_OriginalMetalAtlas", (.7, .7, .7), .82, .36,
                         color_map=texture_root / "sputnik_difuse.png",
                         normal_map=texture_root / "sputnik_normalmap.png", normal_strength=.35)


def planar_uv(mesh) -> None:
    """Cube projection in physical coordinates; imported Max UVs are unbounded."""
    layer = mesh.uv_layers.new(name="PBR_UV")
    mesh.uv_layers.active = layer
    for polygon in mesh.polygons:
        normal = polygon.normal
        dominant = max(range(3), key=lambda axis: abs(normal[axis]))
        axes = [(1, 2), (0, 2), (0, 1)][dominant]
        scale = 1.0 if polygon.material_index == 1 else 1.7
        for loop_index in polygon.loop_indices:
            position = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            layer.data[loop_index].uv = (position[axes[0]] * scale, position[axes[1]] * scale)
    # glTF must export this layer as TEXCOORD_0 for every PBR texture.
    while len(mesh.uv_layers) > 1:
        obsolete = next(uv for uv in mesh.uv_layers if uv.name != layer.name)
        mesh.uv_layers.remove(obsolete)
