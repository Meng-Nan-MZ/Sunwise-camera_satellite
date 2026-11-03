# Browser-local Satellite Dataset Studio Web

User-approved direction (2026-11-03): independent local copy of latest main, new web branch, local browser first, no cloud deployment. All rendering, postprocessing, noise, labels, ZIP creation happen on the user's computer. Manual controls and WebMCP call the same application operations.

## Architecture and scope
- React/TypeScript/Three.js reuse from V3; static Vite dev/preview only, no Python HTTP service or per-frame uploads.
- Four capture modes: single, coverage, sequence, custom_sequence; fixed 10–30 km distance initially; default 20 km; output 1024x1024 8-bit grayscale PNG, YOLO and WXYZ pose JSON.
- Browser-owned jobs, snapshots and frame buffers, progress/cancel, clean-image noise variants, results preview, local ZIP download. Session-only image storage with explicit refresh warning, bounded memory 256 MiB and at most 500 frames/job; release jobs to reclaim memory. No promise of desktop seed pixel equivalence; record browser algorithm/version and preserve coordinate semantics.
- Existing GLBs copied locally, generated static catalog and assets via preparation script; never commit GLB binaries. Desktop source retained for history.
- Neo-Brutalist visual reference https://www.stylekit.top/zh/styles/neo-brutalist : black borders, square cards, hard shadows, bold headings, monospace technical values, cream/white, lime, cyan, pink. Responsive workbench with real 3D canvas, parameters, jobs/results and agent capability panel. No simulated AI chat.
- WebMCP feature detection, structured validated tool input, shared state/actions, native capability status. Download preparation returns a user-clickable download action rather than pretending browsers allow all unactivated downloads.
- No cloud accounts, upload endpoints, server-render workers, billing or hosting deployment in this iteration.

## Agreed approach
Browser rendering + browser processing + direct downloads chosen by user over cloud output or cloud storage. Tradeoffs: page must stay open, RAM/graphics capabilities limit batches, model binaries loaded into browser. Background work persistence is outside this version.

## Verification
Port tests for sampling/coordinates/metadata, independent PNG/ZIP decoding, cancellation/error and memory behavior, WebMCP valid/invalid shared actions, build, browser UI and actual rendered dataset inspection. Record which WebMCP checks are native versus adapter-only.
