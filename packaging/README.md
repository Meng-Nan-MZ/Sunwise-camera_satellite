# V2.4.4 Windows distribution preparation

V2.4.4 uses the bundled Three.js engine in WebView2 for preview and capture. Application payloads include six registered `preview.glb` files and the original model catalog; they do not require or ship `.blend` scenes, Blender executables, Blender downloads or Blender source archives. Model catalog provenance and authoring hashes remain unchanged.

`dependencies.lock.json` is the application dependency lock. `fetch_dependencies.py --offline` verifies the cached application downloads against their locked SHA256 values. Python, NumPy and Pillow are prepared by `prepare_python.py`; the fixed WebView2 runtime and self-contained .NET publish remain release inputs. Preserve all original dependency licenses.

Development build: run `tools/build-desktop.ps1`, then `tools/start-desktop.cmd`. The build path follows the desktop project version (`var/build/desktop-2.4.4`). Development launch uses explicit project and Python paths and installed WebView2; packaged launch uses fixed WebView2. `var/runtime.json` needs only `python`; obsolete `blender` keys are ignored.

For a future authorized installer release, publish the desktop self-contained for win-x64 to `var/packaging/publish/desktop`, prepare the locked Python and WebView2 inputs, then use `tools/packaging/stage-release.ps1 -Python <python.exe>` to assemble an empty new staging directory. `build_payload.py` verifies model GLB hashes, locked downloads, runtime completeness and self-contained framework metadata, and writes a hashed inventory. `build-installer.ps1 -PayloadDirectory <staging> -Version 2.4.4` validates that inventory before invoking a locally installed Inno Setup 7 compiler. These commands are preparation documentation; V2.4.4's current deliverable is a runnable development build, with no new installer or archive.

Run `python -B -m unittest discover -s tests/packaging -v` for GLB-only fixture assembly, provenance preservation, corruption detection, staging isolation and V1/V2 installer identity checks. Native V2.4.4 interaction acceptance uses `tools/verify_v244_distance_link.cjs`. The v243, v242 and v241 tools and records retain their original V2.4.3, V2.4.2 and V2.4.1 scopes. The legacy installer functional verifier predates the current UI and is explicitly unavailable for V2.4.4; it must be adapted and validated before publishing a future installer.

## Separate offline authoring and historical evidence

`tools/prepare_assets.py`, `tools/build_four_models.py`, `tools/inspect_model_materials.py`, `tools/publish_model_update.py` and `tools/model_assets/` are authoring utilities, not app runtime dependencies and not copied to payloads. Some authoring utilities use a separately installed Blender. Keep original assets, installed authoring tools, purchased archives and earlier release/source archives unchanged. Original provenance stays in the model catalog. See `tools/OFFLINE-AUTHORING.md`.

Old Blender renderer QA entrypoints are archived reference code and stop with an explicit retirement message on this version. Their recorded historical results remain valid evidence for their original versions; rerunning them against V2.4.4 is unsupported. Installed user data is not removed by uninstall definitions; back up complete task directories before manual data cleanup.
