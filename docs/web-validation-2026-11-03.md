# Browser Web 0.1 local acceptance — 2026-11-03

## Scope and isolation

- Independent local copy: `SatelliteDatasetStudio-Web`; branch: `web/browser-local`.
- Source at copy time: main `c01b92d66b8bac9f7213c9f0da175c8c6f38c272`, checked against GitHub. The web implementation did not write to the original desktop copy.
- Browser renders and processes frames, creates metadata and ZIP files. Local Vite serves static code/models on `127.0.0.1:5173`; no Python processing service or cloud deployment.
- 19 GLB models validated against manifest SHA256; derived public assets and original GLBs remain excluded from Git.

## Automated checks

- `node --test tests/*.test.ts` in `apps/ui`: **181 passed, 0 failed**.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node node_modules/vite/bin/vite.js build`: passed. Three.js chunk remains 572.26 kB (145.21 kB gzip); Vite's >500 kB advisory is expected and is not a build failure.
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/start-web.ps1 -Check`: passed; Node v24.22.1 and 19 models detected.
- Independent Python `zipfile` + Pillow download validation: 4 actual browser ZIP archives passed.

## Real browser acceptance

- Manually entered Euler XYZ 20°,30°,0° and captured one GOES-R frame at 20 km.
- Native WebMCP was detected in the in-app browser; eight tools were registered and real configuration, capture, status, cancellation and download preparation calls succeeded.
- All four capture modes ran: single, random coverage (20 completed frames), automatic sequence (3 frames), custom shortest-path sequence (3 frames).
- Custom sequence exported Z rotations 0°,45°,90° and timestamps 0,1,2.
- A 500-frame random job was canceled after 8 complete frames. The partial ZIP contains exactly 33 entries: job metadata and 8 sets of clean PNG, noisy PNG, pose JSON, and YOLO label. `partial=true`, `status=canceled`.
- ZIPs were downloaded through the actual page download links. PNGs are 1024×1024, 8-bit grayscale / Pillow `L`, nonblank, with valid CRCs. Independent checks confirmed quaternion normalization, matrices/camera transforms, image bounds and YOLO consistency.
- Noise variant retained byte-identical clean image, pose and label; source SHA256 matched; 465051 pixels differed in its noisy output.
- Desktop and 390×844 responsive layouts visually checked. Model is centered, controls remain accessible, and the narrow layout has no horizontal document overflow. Browser console returned no warning/error entries during final inspection.
- A ZIP prepared by AI for another task remained visible on the results page. Removing the selected 3-frame task returned to a 1-frame task displaying 1/1 with both paging controls disabled.

## Review fixes

- Endpoint changes now validate and replace a cloned draft instead of mutating its frozen trajectory.
- Renderer disposal failure cannot leave the runtime permanently busy.
- Cancellation during asynchronous noise SHA256 processing is checked before retaining a frame; controlled-delay regression was verified failing before the fix and passing after it.
- Download visibility and frame-index reset issues found in independent review were fixed and checked in the browser.
- Canceled tasks show a plain Chinese explanation rather than an internal AbortError alert.

## Local evidence and limitations

Ignored `var/web-validation/` contains `final-tests.txt`, `download-acceptance.json`, a rerunnable independent download validator, four exported ZIPs and extracted images, desktop/mobile screenshots and preview logs. These are local acceptance artifacts, not bundled product data.

Results exist only in the current page; refresh/close or development hot reload clears them. Keep the page running and download results before leaving. Limits are 500 requested frames per job and 256 MiB retained output; transient render/ZIP buffers need additional RAM. Native WebMCP support is browser-dependent; unsupported browsers retain manual controls. Browser RNG and image processing are versioned and do not claim NumPy/Pillow or cross-GPU pixel identity.
