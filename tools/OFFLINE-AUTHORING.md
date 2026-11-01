# Separate offline model authoring

The V2.4 application captures with Three.js and requires only the registered GLBs. It does not execute Blender, ship Blender scenes, or include authoring utilities in its payload.

`prepare_assets.py`, `build_four_models.py`, `inspect_model_materials.py`, `publish_model_update.py` and `model_assets/` prepare or inspect source assets offline. Utilities importing `bpy` run only in a separately installed Blender process. Follow the utility's own arguments; these are deliberate source-asset operations rather than application startup steps. They may emit both GLBs and authoring `.blend` files. Keep original source archives, licenses and provenance. Do not replace catalog provenance merely because the application consumes GLB only.

The `verify_v2_*`, `verify_v21_*`, `verify_v22_*`, `verify_v221_benchmark.cjs`, `verify_v23_output_directory.cjs`, `verify_rendering.py`, and `verify_desktop.cjs` entrypoints document historical application behavior and are retired on V2.4. They rely on the removed Blender execution service or older UI. Use the original version checkout to reproduce old checks. Do not rewrite or delete prior reports and task snapshots. `verify_v221_images.py` remains a standalone historical report/image audit helper.

Current native application QA: `verify_v24_workbench.cjs`; current image/label audit: `verify_v24_images.py`. Blender runtime/source files retained by older distributions remain separate and are not inputs to the V2.4 dependency lock.
