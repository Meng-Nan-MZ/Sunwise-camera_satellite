# V2.4.6 Corporate Clean design QA

**Findings**

No actionable P0/P1/P2 visual findings remain after the second comparison and correction. This is a constrained implementation of the two approved light mockups: real GLB geometry, physical camera distance, saved image framing, task data, and persisted appearance take precedence over illustrative mock content.

**Source and implementation evidence**

- Capture source visual truth: `C:/Users/mz/.codex/generated_images/01a19283-a54f-7be2-8bfb-61c523bc789b/exec-bde225b9-fc72-40c3-b89c-687fab69d8c7.png`, 1647 x 955 pixels.
- Results source visual truth: `C:/Users/mz/.codex/generated_images/01a19283-a54f-7be2-8bfb-61c523bc789b/exec-06f292f0-1500-435c-a729-cd8f4e91b672.png`, 1646 x 956 pixels.
- Reviewed final rendered implementation: `var/verification/v2.4.6-corporate-clean/1793560602372-76140/`, all twelve `capture-{light,dark}-{1648x956,1108x620,960x600}.png` and `results-{light,dark}-{1648x956,1108x620,960x600}.png` files. These are actual native WebView2 page captures, not source-code reconstructions.
- Viewports: 1648 x 956, 1108 x 620 and 960 x 600 CSS pixels. Native startup records devicePixelRatio 2.25 at 1108 x 645 CSS pixels (Windows 225% display). Saved implementation PNG dimensions equal each requested CSS viewport after viewport setup; no additional implementation image resampling was applied in QA. This distinguishes host display density from saved capture density. Full-view comparison normalizes the near-identical desktop source to 1648 x 956 (capture +1 x +1 pixels; results +2 x +0). Compact captures remain at their native pixel size on the comparison canvas; they are resilience comparisons, not a claim that a desktop source specifies compact geometry. Focused crops preserve original pixels.
- State: capture uses random-pose batch, custom 300, actual model preview at 20 km; results uses a completed real three-frame start/end sequence, frame 2 of 3, original selected and unavailable noise tab visibly disabled. The task list contains seven isolated-fixture tasks. These data differ intentionally from the mock's four illustrative tasks and 300-frame example. Dark is an existing supported theme, not a separately approved dark visual source.
- Combined full-view inputs actually opened: `var/verification/v2.4.6-design-qa/{capture,results}-{light,dark}-{1648x956,1108x620,960x600}-comparison.png`. Each puts approved source on the left and rendered implementation on the right. Both source and render were present in the same comparison input before judgment.
- Focused comparison inputs actually opened: `capture-focus-1.png` (count, distance, disclosures and generation footer), `results-focus-0.png` (queue), `results-focus-1.png` (operations/details), `results-focus-2.png` (selected heading/actions/tabs). A capture header/context crop is also saved as `capture-focus-0.png`. All are in `var/verification/v2.4.6-design-qa/` and contain both original source and implementation pixels. These diagnostic composites only copy/scale/crop PNGs; they do not redraw production content.

**Required fidelity surfaces**

| Surface | Observed assessment |
|---|---|
| Fonts and typography | Desktop headings, tabs and actions now have an appropriate hierarchy; results title is 26 px, section headings 23 px, queue titles 18 px, body metadata 16-17 px. Capture uses 24-26 px headings and 16 px principal controls. Compact controls remain legible with deliberate title ellipsis and internal scrolling. Source is a raster mock: exact source family and optical weight cannot be identified reliably. Implementation declares Segoe UI / Microsoft YaHei UI / Microsoft YaHei / sans-serif and inherits it into form controls. Source body labels appear optically heavier; the remaining difference is P3, not an exact-font match claim. No material wrapping collision remains. |
| Spacing and layout rhythm | Header/context/large scene/right settings composition and queue/gallery/details composition follow the source. White rounded panels, restrained elevation, pale dividers and persistent footers are preserved. Desktop results rows now use 84 x 88 thumbnails and spacious text grouping. At 1108/960 the scene remains wider than settings, generate and frame navigation stay visible, and scroll regions retain access to secondary controls/details. Native layout checks report no horizontal overflow. |
| Colors and tokens | Light mode uses white and pale slate surfaces, navy text, muted blue-grey secondary copy and saturated blue primary/active controls (`--primary: #1463f3`, light text `#142747`, muted `#5b7294`). Completed state uses a green badge. This matches the source palette and foreground/background hierarchy. Dark mode intentionally retains charcoal surfaces, pale text and blue controls; no claim of pixel matching a nonexistent dark mock. Disabled noise is visibly subdued. |
| Image quality and asset fidelity | The existing satellite logo is retained. Preview and gallery show actual GLB render/saved PNGs with intact rectangular/square framing, clean edges and black image background. No CSS/SVG illustration or fake thumbnail replaces the model/results. Source satellite pose, illustrative model extent and much larger apparent image size are intentionally not copied: physical 20 km distance, actual render scale and 1024-square PNG semantics are preserved. Thumbnail subject size follows those real images. The test changes preview orientation only for visible surfaces; it does not change physical camera distance or production rendering. |
| Copy and app content | Navigation, headings, count presets/custom input, count-bearing generate action, image/noise tabs, frame counter, operations and task information are coherent Chinese product copy. Results original tab order, `.png` filename and `详细信息` label now align with the mock. Actual paths/dates/counts/model list are live fixture values; they are not replaced by invented mock data. Technical/YOLO wording describes actual saved outputs rather than leaking implementation instructions into the interface. |

**Comparison history**

1. Initial capture/layout iteration: native run `1793559984785-33644` was blocked by a 4-pixel horizontal overflow in range-control sections. Combined `capture-iteration0-full.png` also shows undersized desktop controls and vertically stacked distance policy relative to the source. Fixes: zero range margin, larger desktop 15/16 px control text and 42 px context controls, inline desktop distance policy, and count focus ring. Subsequent `1793560191747-82180` captures show the correction; native `1793560271570-70916/report.json` passed layout at all twelve viewport/theme/screen combinations.
2. Independent results comparison: `1793560191747-82180/results-light-1648x956.png` still had 12-14 px metadata/buttons and 54 px thumbnails against the source's larger, more spacious hierarchy (P2). Preserved evidence: `results-iteration1-full.png`, `results-iteration1-queue.png`, `results-iteration1-details.png`. Requested concrete desktop-only sizes without changing compact geometry. Fixes: 16-17 px metadata, 18 px queue titles, 23/26 px section/selected headings, 84 x 88 thumbnails and increased row padding; original/noise ordering, filename extension and details label aligned. Post-fix `1793560602372-76140` full and focused combined inputs show the issue resolved. Compact screenshots retain the previous usable layout.
3. Nonvisual verification runs: `1793560191747-82180` had a favicon console 404, resolved with an empty native-page data favicon; `1793560458105-95624` stopped before final screenshots with a transient fixture fixed-distance assertion. These are recorded as test/troubleshooting history, not counted as visual-QA iterations. The final visual screenshots used here come from the original-condition nine-check passing native run with passive input-event recording, without forcing a replacement distance. The earlier 30 km occurrence was not reproduced and its cause remains unknown; this visual report does not claim that business/test anomaly was fixed. See the acceptance report for that limit.

**Interaction and console evidence**

The independent reviewer inspected the screenshots/composites and native report; it did not personally drive the application UI. Primary interaction evidence comes from the isolated native acceptance run `var/verification/v2.4.6-corporate-clean/1793560602372-76140/report.json`: nine checks passed, including presets/custom and invalid-count submission blocking, mode defaults, real jobs/frozen counts, distance policy, saved results/derived noise with original hashes unchanged, persisted themes/layout, and owned-process cleanup. Its browser-error check reports zero page errors and zero console errors. This evidence is native WebView2 automation, not a user browser session or purely synthetic browser-only preview.

**Open questions and limits**

- No exact typeface identification is possible from the generated mock alone. Optical weight remains slightly lighter in implementation; acceptable P3 refinement.
- No mobile source is provided. Acceptance covers desktop and the two required compact widths; arbitrary zoom/accessibility combinations and screen-reader behavior were not comprehensively audited here.
- Dark theme was tested for legibility and retained function, not against an unavailable dark source.

**Follow-up polish**

- P3: source labels and tertiary details heading are somewhat heavier; adjust optical weight only if desired after real use.
- P3: mock search/folder icons and source's softer/shinier button surface are not replicated exactly. Existing native labels remain clear; avoid adding substitute artwork merely to force pixel identity.

**Implementation checklist**

- [x] Open source and actual native renders together in full-view comparison inputs.
- [x] Inspect focused typography, queue, settings, tabs and details comparisons.
- [x] Verify fonts, spacing/layout, palette, imagery and app-specific copy explicitly.
- [x] Recompare after the P2 typography and range overflow fixes.
- [x] Inspect capture/results at 1648, 1108 and 960 in light/dark, preserving real rendering and data.
- [x] Retain evidence and disclose residual limits; no blocking visual fixes remain.

final result: passed
