import os
import bpy  # type: ignore[reportMissingImports]

# Get current directory where batch_convert.py is located
root_dir = os.path.dirname(os.path.realpath(__file__))

print(f"Starting GLTF export process in: {root_dir}")

for subdir, dirs, files in os.walk(root_dir):
    for file in files:
        if file.endswith(".blend"):
            blend_path = os.path.join(subdir, file)
            glb_path = os.path.join(subdir, os.path.splitext(file)[0] + ".glb")

            # Skip if .glb already exists
            if os.path.exists(glb_path):
                print(f"Skipping (already converted): {glb_path}")
                continue

            # Reset Blender scene state
            bpy.ops.wm.read_factory_settings(use_empty=True)

            # Open .blend file
            bpy.ops.wm.open_mainfile(filepath=blend_path)

            # Select all objects in the scene
            bpy.ops.object.select_all(action='SELECT')

            # Export as binary GLTF (.glb)
            bpy.ops.export_scene.gltf(
                filepath=glb_path,
                export_format='GLB',
                use_selection=False
            )
            print(f"Successfully converted: {file} -> {os.path.basename(glb_path)}")

print("Batch conversion completed!")