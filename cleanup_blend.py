import os

# Get current directory where cleanup_blend.py is located
root_dir = os.path.dirname(os.path.realpath(__file__))

print(f"Scanning for converted .blend files in: {root_dir}")

deleted_count = 0

for subdir, dirs, files in os.walk(root_dir):
    for file in files:
        if file.endswith(".blend"):
            blend_path = os.path.join(subdir, file)
            glb_path = os.path.join(subdir, os.path.splitext(file)[0] + ".glb")

            # SAFETY CHECK: Only delete .blend if the .glb file actually exists
            if os.path.exists(glb_path):
                os.remove(blend_path)
                print(f"Deleted source file: {file}")
                deleted_count += 1
            else:
                print(f"WARNING: Keeping {file} because .glb was not found!")

print(f"Cleanup complete! Deleted {deleted_count} .blend files.")