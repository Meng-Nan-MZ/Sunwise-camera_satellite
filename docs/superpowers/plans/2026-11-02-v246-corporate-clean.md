# V2.4.6 Corporate Clean Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent tasks and review the integrated result before release.

**Goal:** Apply the two approved light Corporate Clean mockups to the existing capture/results workbench and add convenient user-selected image counts.

**Architecture:** Retain React state, native WebView2 host, Three.js capture and existing APIs. Change presentation and the count-selection component only; retain real models, saved images, metadata and existing theme preferences. Work in the existing clean V2 feature branch, without touching V1 or KIMI.

**Tech Stack:** React 19, TypeScript, CSS, Three.js, native Windows WebView2, Python service.

**Spec:** User-approved capture mock `exec-bde225b9-fc72-40c3-b89c-687fab69d8c7.png` and results mock `exec-06f292f0-1500-435c-a729-cd8f4e91b672.png` in `C:/Users/mz/.codex/generated_images/01a19283-a54f-7be2-8bfb-61c523bc789b/` plus the approved count request in this conversation.

## Constraints and rulings

- Use white/slate surfaces, navy text, blue primary actions and restrained borders/shadows in light mode; preserve dark mode and persisted user preference. No unsolicited reset of appearance preference.
- Keep compact native startup and controls usable at 1108 and 960 CSS-pixel widths; capture stays larger than settings, results retain task list/gallery/details.
- Counts: single remains 1. Batch modes offer 100 / 500 / 1000 / 自定义, with editable integer count, maximum 100000; minimum 2 for start/end sequences, otherwise 1. Existing defaults remain 1000/120/120. Main button uses the selected count. Invalid input must prevent submission rather than silently changing it.
- Preset values are conveniences, never claimed as computed sample requirements. Preserve backend modes and image/pose protocols.
- Preserve actual GLB rendering and saved square PNG framing, not illustrative mock satellite geometry or made-up task data. Existing logo is a retained source asset.
- No installers/archives. KIMI, binary assets and user data remain ignored. Publish reviewed source branch and a new v2.4.6 tag using ordinary forward Git history under existing authorization.
- Native WebView acceptance uses the repository's existing isolated-fixture automation, not a user browser session. Do not mutate the user's live workspace for QA.

## Review focus

- Empty/fractional/negative/excessive counts must not submit; custom preset must remain editable even at a preset value.
- Switching modes, reset and trajectory playback must remain coherent with current counts and frozen submissions.
- Compact/high-DPI layouts must retain generate/frame-navigation actions, without horizontal overflow or unreadable smaller labels.
- Theme changes must not change rendered pixels, pose labels, noise parameters or model preview rotation semantics.
- Results must show real saved images, enabled/disabled noise availability, matching frame navigation and safe additional noise tasks.

## Tasks

- [x] Count controls: create `ImageCountControls.tsx` and a small count validation helper/tests; integrate in `SceneControls.tsx`, preserve scene request validation and mode behavior.
- [x] Visual implementation: update `styles.css` and focused presentational markup in `ResultsWorkspace.tsx` to match both approved mocks, with responsive dark/light coverage.
- [x] Integration: update current runtime/release versions and current user docs to 2.4.6; retain historical verification documents unchanged.
- [x] Validation: frontend tests/build, Python regression suite, native isolated QA for count selection/invalid input/submissions, results/noise, themes and layout. Capture reference-sized and compact screens and inspect against approved sources.
- [x] Review/release readiness: independent code and visual review, findings corrected, `design-qa.md` and `docs/verification-v2.4.6.md` updated. Publish this validated source as the next ordinary branch commit and `v2.4.6` tag, then verify remote refs; do not rewrite existing history.

## Execution evidence

- Frontend: 140/140 tests, TypeScript and production build pass. Python service121/121, rendering4/4, packaging10/10 pass. Tests use repository-local TEMP; service tests require owned loopback access on this Windows environment.
- Initial native run exposed range control UA margin overflow (4px), fixed with margin:0. Reference comparison found wide capture then wide results typography too small; desktop-only sizes increased while retaining compact geometry.
- Final native report1793560602372-76140 passed9/9 on the final build, including12viewport/theme/screen combinations,16originals and3derivednoise images. Independent source/render comparison in design-qa.md passed after both typography corrections.
- Build includes explicit empty favicon to avoid an irrelevant default favicon.ico404 in the desktop embedded browser.
- Independent code review against4fe8ab4 found no actionable correctness issue; visual review recorded and corrected P2 sizing drift.
- One intermediate native run1793560458105-95624 submitted30km rather than the expected20km. Final original-condition rerun (no forced-distance setup) passed with passive input diagnostics and20km checkpoints; the earlier cause remains unknown, retained as an observation in docs/verification-v2.4.6.md rather than claimed fixed.
