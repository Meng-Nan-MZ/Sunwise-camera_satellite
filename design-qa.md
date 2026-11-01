# V2.4.1 compact workbench visual QA

**Findings**

- No actionable P0/P1/P2 findings remain. This independent review opened both source drafts, the helper example, actual native reference captures, two combined full-view comparisons, four combined focused comparisons, compact captures and actual desktop evidence. No production files were edited by this reviewer.
- [P3] Secondary copy and native range controls are optically less close to the drafts than the major layout. Location: capture controls/context strip and results metadata. Evidence: the focused control/toolbar/operations comparisons below show smaller secondary text and heavier range tracks/thumbs. Impact: minor differences in apparent weight and rhythm; labels, values and primary actions remain readable and usable in the compact captures. Optional fix: refine secondary text size/weight and range-track styling in `apps/ui/src/styles.css`, preserving compact behavior and real rendering contracts.

**Comparison target and evidence**

Paths are relative to this project root. Behavioral authority: `docs/superpowers/specs/2026-11-01-v2.4.1-compact-workbench.md`.

- Source visual truth, opened directly: `var/development/v2.4.1/references/capture-draft.png` and `results-draft.png` in the same directory. Both are 1800 × 1080 pixels. Original font metadata/device density are unavailable in these raster drafts; they are treated as a 1×, 1800 × 1080 design canvas.
- Helper reference opened: `var/development/v2.4.1/references/preview-helpers.png`, 950 × 365 pixels. It establishes directly accessible axis/safety-frame/reset helpers, rather than the main screen's viewport/theme.
- Final native WebView content screenshots opened: `var/verification/v2.4.1-final-launch/1793529758668/capture-reference.png` and `results-reference.png`. Both are 1800 × 1080 pixels at 1800 × 1080 CSS pixels, DPR 1. WPF chrome is outside these captures. No density correction is needed against the full-size drafts.
- Combined full-view inputs opened before judgment: `capture-comparison.png` and `results-comparison.png` in that final directory. Each places the source beside the actual implementation at a common display scale. Original captures were also opened for legibility; the verdict is grounded in combined inputs rather than separate-view recollection.
- Focused combined inputs opened in that directory: `capture-controls-comparison.png`, `capture-toolbar-comparison.png`, `results-list-comparison.png`, `results-operations-comparison.png`. These cover forms/ranges, context controls, tasks/statuses and result operations/frozen information; full-view downscaling alone cannot establish small-label fidelity.
- Compact captures opened: `var/verification/v2.4.1-workbench/1793528752027/capture-1108x645.png`, `capture-960x600.png`, `results-960x600.png`. These are CSS-sized/DPR-1 layout captures, not proof of initial native window size by themselves.
- Actual desktop evidence opened: `var/verification/v2.4.1-workbench/1793528752027/explorer-job.png`, a 1696 × 907 desktop image showing the entire compact WPF window within the display over Explorer. Final `var/verification/v2.4.1-final-launch/1793529758668/remembered-theme-default.png` is 2493 × 1451 raster pixels for 1108 × 645 CSS content at DPR 2.25; divide pixel dimensions by 2.25 when judging logical layout. The native report records available logical height 912 and scroll width 1108. This unoverridden startup evidence is distinct from the deliberately enlarged reference capture.
- Light appearance evidence opened: `var/verification/v2.4.1-workbench/1793528752027/capture-light.png`. Its settings pane is scrolled, so the heading above its scroll position is not a clipping defect. Retaining the black scene and real model across themes is intentional.

**Matched state and expected differences**

Capture: dark theme, GPS 导航卫星, 单张采集, 拍摄视角, XYZ 45° / −25° / 0°, fixed distance 20 km, helper controls visible, advanced details closed. The implementation uses functional checked helpers and the real applied output path. The draft's cartoon satellite, stars and mild noise are illustrative rather than real render assets; matching them must not change GLB geometry/materials, formal camera size or saved PNGs.

Results: dark theme, completed GPS single-frame job, frame 1/1, result operations and collapsed technical information. The source selects a noisy image. The actual job has noise off, so 原图 is selected and 噪声图 is correctly disabled. This is an accepted state difference, not a contradictory selected control. Actual image framing/black background are preserved.

Real task dates/counts/statuses and populated thumbnails replace invented draft content. Long paths use ellipsis; search explicitly covers loaded tasks. Seeds/coordinate/format details are in advanced or technical surfaces, while preview helpers remain directly reachable. The existing logo is intentionally retained instead of replaced by the draft's different mark.

**Required fidelity surfaces**

| Surface | Review and disposition |
| --- | --- |
| Fonts and typography | Title, active tabs, headings, labels and values retain the draft's hierarchy. Declared stack: Segoe UI / Microsoft YaHei UI / Microsoft YaHei / sans-serif. The raster draft cannot establish exact font identity. Actual headings are somewhat heavier and secondary text finer/smaller: P3 optical drift, without a broken hierarchy. No unintelligible wrapping or split units was observed. Path/title truncation at compact width is intentional. Raster antialiasing differences are not treated as font defects. |
| Spacing and layout | Capture preserves the context strip, dominant preview, narrow settings pane, single generation footer action and workspace line. Results preserve a searchable left list, selected-task header, central viewer and right operations/info card. Major-region proportions are close. Functional capture rows are slightly taller and the pane scrolls, including at reference size; distance/noise controls remain accessible. At compact sizes, settings/info/list panes scroll independently while helpers, generation and frame navigation remain outside them. Notice rows reserve space without covering viewer controls. No horizontal overflow/collision was visible in the reviewed captures. |
| Colors and tokens | Dark navy background, blue-gray cards/borders, pale cyan active controls, muted secondary text and green completed states follow the drafts. Confirmed tokens: background #0a1016, panel #0e1720, surface #121d28, line #2b4051, text #e1e8f0, accent #94ccef. Selected tasks/tabs remain clear. The results folder action is quieter than the draft's cyan filled button, an acceptable secondary-action treatment. Light appearance changes shell/forms while preserving scene/output appearance. |
| Image quality and asset fidelity | Preview shows actual GLB body/panel detail; results and populated thumbnails show real saved images. No artificial star field, cartoon satellite or enlargement replaces real assets. Actual GPS geometry/scale differs from the illustration by design. The logo difference is intentional. Preview axes/safe frame are clearly identified as excluded from output. The actual clean PNG's black square boundary/aspect ratio and saved framing are preserved rather than stretched to imitate the draft. |
| Copy and content | Page/group names, axis labels, typed km distance, output summary and generation action are coherent and task-specific. The result operation explicitly uses the original; technical details remain folded. Frozen fixed-distance information is a useful addition. 无噪声, real paths/history and original-only image availability are intentional content/state differences. |

The icon/control pass found clear tab/disclosure affordances, genuine checkbox/range states and disabled single-frame arrows/noisy choice. Native slider appearance differs from the draft's thin illustrated tracks (P3 above). No handcrafted illustrative replacement of a required asset was identified.

**Interaction evidence and limits**

This reviewer opened visual evidence and read reports; the following interactions were exercised by the native acceptance run, not repeated in the user's running app during this review.

- `var/verification/v2.4.1-workbench/1793528752027/ui-acceptance.json` reports `passed: true` for 11 groups: compact layout/helpers, typed distance/inspection, root folder, frame navigation/zoom, job folder, noise dialog, filters, retry, frozen/independent drafts, reset and theme save. The saved request confirms decimal 22.5 km became 22500 m. Recorded viewport widths equal scroll widths at 1800, 1108 and 960.
- The earlier `ui-functional-report.json` retains a partial run: nine successful groups, then a reset assertion before the field redraw. Completed `ui-acceptance.json` explicitly records its resumed source and successful reset/theme results. The partial report is not used as aggregate success or hidden as a production failure.
- The main `report.json` in that directory reports `passed: true`, no page errors, compact startup, four-mode distance policies, automatic-mode/RNG preservation, frozen roots, noise, cancellation, cleanup and historical files unchanged (65 jobs / 359 files). `image-audit.json` reports 34 frames without failures; `image-regression.json` records identical clean PNG comparisons. These support real rendering preservation, not cosmetic changes to formal assets.
- Final native restart reports `var/verification/v2.4.1-final-launch/1793529600262/report.json` and `1793529758668/report.json` report `passed: true`, no page errors and theme surviving changed service ports. The latter records the reference PNG unchanged. Default-window evidence uses native DPR 2.25 with no viewport override before reference-size captures.
- Full keyboard-only/screen-reader testing, measured contrast, high text zoom and work areas below 960 × 600 were not independently performed in this visual pass. Mobile parity is outside this Windows desktop specification.

**Comparison history**

1. This V2.4.1 review uses two new user drafts and replaces the old V2.4 target. Previous release findings are not silently reused as evidence for this release.
2. Before this review, implementation QA corrected typed-number editing/clamping, cross-port appearance persistence and notification placement. Supplied final compact captures show the in-flow notice without covering frame navigation; completed native acceptance/restart reports cover number/theme behavior. These are preceding implementation/functional checks, not invented source-to-render visual iterations by this reviewer.
3. The first independent comparison of source and final combined inputs found no actionable P0/P1/P2 difference. Five required surfaces and focused controls were checked. No visual fix was requested or applied after comparison; only P3 refinement remains. No additional post-fix design-QA capture is therefore required.

**Open questions**

- No acceptance-blocking visual ambiguity. Exact raster-mock font identity remains unavailable; real-asset and state differences are documented above.

**Implementation checklist**

- [x] Open both drafts and helper example.
- [x] Open actual native screenshots and combined full/focused comparisons before judgment.
- [x] Explicitly check typography, spacing/layout, colors, images and copy.
- [x] Check compact views, in-flow notices, helpers and persistent generation/frame actions.
- [x] Distinguish reference capture from native startup and normalize DPR.
- [x] Read completed interaction/restart evidence and state verification limits.
- [x] Classify intentional differences; leave no actionable P0/P1/P2 findings.

**Follow-up polish**

- Optionally refine secondary copy and slider optical weight as described in the P3 finding, preserving verified compact behavior and formal PNG output.

final result: passed
