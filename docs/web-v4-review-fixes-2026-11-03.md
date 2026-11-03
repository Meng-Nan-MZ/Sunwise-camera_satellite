# Web V4 review follow-up — 2026-11-03

Scope: the four review findings reported after endpoint feedback was added to `web/V4`.

## Findings and disposition

1. **Node version parsing — confirmed.** A prerelease/build suffix makes the original `[version]` cast fail. The outer error handler exits the launcher before other Node candidates can be checked. Parse the numeric core without throwing, skip malformed/too-old candidates and retain the existing 22.18 minimum and candidate order.
2. **Wheel units — confirmed.** Viewport and WebViewport already forward `deltaY`, `deltaMode` and viewport height; BrowserApp was dropping the latter two. Use the existing `distanceAfterWheel` conversion, including pixel/line/page normalization, precision and 10–30 km clamps.
3. **ZIP allocation — confirmed.** Remove the extra full-archive `Uint8Array.slice()` before Blob construction. `createZip` explicitly returns `Uint8Array<ArrayBuffer>` because it allocates an owned ArrayBuffer, allowing direct Blob input under TypeScript 5.9 without a cast or replacement copy. This removes one archive-sized JavaScript allocation; it does not make Blob construction zero-copy or eliminate all export memory overhead. The [File API Blob-parts algorithm](https://www.w3.org/TR/FileAPI/#process-blob-parts) specifies snapshot/copy semantics for buffer sources.
4. **Sequence sign continuity — not reproduced in the current algorithm.** The Web sequence uses a fixed 1° quaternion step, positive-norm normalization and component reordering without per-frame W canonicalization. Adjacent quaternion dot products remain approximately `cos(0.5°) > 0`, including when W crosses zero. Python's explicit sign check protects its more general configurable angular step. Preserve current Web sampling and add long-sequence regression coverage. This is not a claim of identical random samples between the separate Web and Python generators.

## Validation

- Node/TypeScript suite: **198 passed, 0 failed**. Existing ZIP tests verify archive structure/CRCs; studio tests exercise real Blob URLs and revocation. Existing wheel tests cover equivalent pixel/line/page units, clamps, precision and invalid inputs.
- Windows PowerShell launcher regression: **10/10 passed**, covering stable, nightly, rc, build metadata, invalid/old/empty/overflow candidates and fallback. These cases invoke the production launcher with local command fixtures; they do not install prerelease Node builds.
- Real `tools/start-web.ps1 -Check`: passed with Node `v24.22.1`; verified and prepared all 19 local model assets.
- Long sequence regression: seeds `0`, `42`, `4294967295`, 500 frames each; all cross W=0 and remain sign-continuous. Minimum adjacent dot product: `0.9999619230641709`; exported pose signs are checked at the crossing.
- TypeScript, changed-file Prettier checks and Vite production build passed. The pre-existing Three.js chunk-size advisory remains.
- ZIP change independently reviewed; no byte-range, type or resource-lifetime issue found.

Firefox hardware/browser interaction and maximum-size browser memory profiling were not performed. The wheel result is supported by the verified callback chain and shared unit-conversion tests; the ZIP benefit is the removed explicit allocation, not a measured browser-wide memory guarantee.

Local logs: `var/review-fixes-tests.txt`, `var/review-fixes-build.txt` (ignored by Git).
