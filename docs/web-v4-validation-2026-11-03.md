# Web V4 validation — 2026-11-03

Release: `4.0.0-web`, branch `web/V4`, based on `ec708ec`. This release adds browser-side observation controls and preserves the existing independent capture renderer and dataset schema.

## Automated checks

- `node --test tests/*.test.ts` in `apps/ui`: **196 passed, 0 failed** (baseline: 181).
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node tools/prepare-web-assets.mjs` from the repository root: local model assets prepared successfully.
- `node node_modules/vite/bin/vite.js build` in `apps/ui`: passed. The existing Three.js chunk remains about 594 kB minified / 151 kB gzip and triggers Vite's advisory size warning.
- `git diff --check`: passed.

New regression coverage checks complete sphere fitting in narrow/wide views, camera zoom and clipping margins, camera presets, original material restoration and helper disposal, truthful model statistics, and interrupted mouse/touch gestures. Cancellation tests exercise the installed Three.js OrbitControls with pointer capture loss, cancellation, window blur, hidden documents, multi-touch, keyboard panning and disposal.

## Browser validation

Validated the local page at `http://127.0.0.1:5173/` in the in-app Chromium browser:

- Seven presets, fit, zoom buttons and keyboard panning work; observation leaves the full WebMCP capture-state response unchanged.
- Solid, wireframe, edges, axes and auto-rotation controls update the visible model. Capture preview restores normal display and the capture projection.
- Fullscreen includes modes, canvas, toolbar and information; both the button and Escape return to the page.
- The information card expands/collapses and refreshes after GOES-R → SAR model switching. SAR displays 873 meshes and 186,524 triangles, with dimensions explicitly marked as uncalibrated model units.
- At a 390 × 844 viewport, controls wrap and document width remains 390 px without horizontal overflow.
- A fresh final page load and model/fullscreen interaction produced no console errors.

Responsive checks use viewport emulation, not physical mobile hardware. Pointer-cancellation regressions use simulated DOM events against real OrbitControls; they are not a claim of testing every physical input device or browser.

## Actual dataset comparison

Two one-frame GOES-R jobs used the same identity quaternion, 20,000 m distance, seed 42, lighting and disabled noise. The first ran while the observation view had wireframe, axes and auto-rotation enabled; the second ran in capture preview. Both ZIP files were downloaded through the page and inspected.

| Output | Result |
| --- | --- |
| PNG | Both 1024 × 1024, 8-bit grayscale; byte-identical |
| YOLO label | Byte-identical |
| Pose JSON | Equal after excluding only `renderer.render_ms`, which records elapsed rendering time |
| Job metadata | Both completed 1/1 frames; application version `4.0.0-web` |

PNG SHA256: `83d26bbb12c4253437afbe14bf6b2b2e3886a3c37f558273e93731f3c327a0de`.

YOLO SHA256: `40b03b0201abc94e097767c4903ac96f0c55c92d0e4747d8d67a2711ffce5599`.

Local evidence is retained under ignored `var/v4-validation/`: the two ZIP files, `capture-isolation.json`, and screenshots of the final viewer, fullscreen, styles, preview, mobile layout and switched model. Test/build logs are `var/v4-tests.txt` and `var/v4-build.txt`.

Independent review was completed; the interrupted-gesture issue was fixed and re-reviewed with no remaining P1/P2 findings.
