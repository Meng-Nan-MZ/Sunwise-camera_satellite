# Browser Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** A locally runnable browser-only satellite capture workbench with real dataset downloads and shared WebMCP actions.
**Architecture:** React/Three.js front end, browser TypeScript domain/image/ZIP modules, static model catalog. Retain desktop files but route web entry through new BrowserApp.
**Tech Stack:** Existing React 19, TypeScript, Three.js r180, Vite, browser Canvas/WebGL/CompressionStream; avoid new runtime dependencies.
**Spec:** ../specs/2026-11-03-browser-web-design.md

## Global Constraints
- Work only in SatelliteDatasetStudio-Web on web/browser-local; base c01b92d; don't modify original copies.
- No Python service, frame uploads, cloud deployment, model binary Git commits.
- WXYZ, coordinate descriptions and real image/pose/YOLO consistency retained. Clearly version browser RNG/postprocessing.
- 500 frames/job and 256 MiB retained output limit; honest errors, cancellation and explicit session-only storage.

## Review Focus
- Invalid inputs/NaN/quaternion and endpoints must be rejected before jobs start.
- Partial cancellation must preserve complete frames and exports must describe partial status.
- Noise variants must keep source poses and labels unchanged and remain portable in ZIP.
- Browser refresh, WebGL loss and memory limits must not masquerade as success.
- Agent and manual actions must update the same state; unsupported WebMCP must leave all manual functions usable.

### Task 1: Browser domain and pose output
- [x] Add apps/ui/src/web/domain.ts and focused domain tests, port reference math and coordinate camera semantics.
- [x] Export BrowserFrame, sampleFrames(request, jobId), buildPose(frame, model, result), validateSubmission(input, models), bboxToYolo.
- [x] Test endpoint inclusion, reproducible proper SO3 sampling, fixed distance, independent reference pose/matrix fixtures and invalid data.

### Task 2: Browser image and ZIP pipeline
- [x] Add apps/ui/src/web/imagePipeline.ts and zip.ts with tests.
- [x] Export processCapture(result, noise, seed), applyNoise(pixels, noise, seed), encodeGrayPng(pixels,width,height); pure deterministic versioned noise; 2048->1024 Lanczos.
- [x] Export createZip(entries: {name:string,data:Uint8Array}[]): Uint8Array; real PNG/ZIP CRC, byte paths and bounded files.
- [x] Verify PNG color type 0 and independent ZIP extraction, noise repeatability, bounds and corrupt input.

### Task 3: Browser job runtime and UI integration (root)
- [x] Add shared BrowserStudio controller with snapshot/draft, capture/cancel/results/noise/download operations; no HTTP job API.
- [x] Build Neo-Brutalist BrowserApp and CSS using existing Viewport and FormalRenderer; static assets script/local launcher.
- [x] Test controller lifecycle, quotas, partial jobs and UI workflows with actual GLB capture.

### Task 4: WebMCP adapter
- [x] Add web/webmcp.ts and tests. Export bindWebMcp(actions, onStatus): () => void and createWebMcpTools(actions).
- [x] Shared actions: listModels(), getState(), configure(input), startCapture(), getJob(id), cancelJob(id), addNoiseVariant(input), prepareDownload(id).
- [x] Tools: list_satellite_models, get_capture_state, configure_capture, start_capture, get_capture_job, cancel_capture_job, add_noise_variant, prepare_dataset_download.
- [x] Feature detect native registry, validate runtime args, cleanup and surface registration issues without breaking UI.

### Task 5: Integration, review, delivery
- [x] Existing and new tests + production build; independent review/fix findings.
- [x] Inspect browser at desktop/mobile, all four capture modes, noise reuse and actual downloaded PNG/JSON/YOLO ZIP; native WebMCP if available.
- [x] Update README/local launch docs and validation evidence. Commit web branch; any upload uses only web/browser-local, never main.
