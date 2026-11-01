# V2.4 visual QA

**Findings**

- No unresolved P0/P1/P2 visual findings in the final comparison. Two P2 findings were corrected and visually rechecked; their evidence and fixes are retained below.

**Comparison target and evidence**

- Source visual truth: `C:/Users/mz/.codex/generated_images/01a19283-a54f-7be2-8bfb-61c523bc789b/exec-3e78e37a-b554-4c79-b1ab-741cf2b4a087.png`, the selected third mock, opened directly.
- Approved behavior: `docs/superpowers/specs/2026-11-01-v2.4-web-only-workbench.md`.
- Native implementation: `var/verification/v2.4-final-launch/1793526596583/generation-reference-state.png` and `results-reference-state.png`.
- Source: 1487×1058 pixels. Native content viewport/screenshot: 1488×1056 CSS/pixels, device scale factor 1. The combined comparisons normalize this negligible size difference; it is not a layout finding. The mock draws window buttons; native WPF chrome is outside the content screenshot.
- Matched generation state: INSAT-3B; 起止姿态序列; start XYZ 0/0/0°, end 90/0/0°; 120 frames, selected frame 120; model inspection; advanced settings closed; noise off; distance 20 km; lighting azimuth 35°. Inspection orientation/zoom was aligned manually through the UI, independently of capture parameters.
- Full-view comparison opened: `var/verification/v2.4-final-launch/1793526596583/design-comparison.png`. Focused comparisons opened: `design-parameters-comparison.png` and `design-footer-comparison.png` in the same directory. Findings are based on these combined inputs, not separate-view recollection.
- Final responsive screenshots opened: `var/verification/v2.4-final-launch/1793526596583/generation-active-1440x960.png` and `generation-active-1080x720.png`. Earlier reviewed captures: `var/verification/v2.4-workbench/1793525475736/generation-1440x960.png`, `generation-1080x720.png`, `results-1080x720.png` and `generation-before-review.png`. Smaller viewports intentionally scroll the right panel and results area while retaining the bottom action.

**Required fidelity surfaces**

- Typography: title, active tab and section hierarchy follow the mock. Common controls are now 16 px and readable; the original undersized controls were corrected. The declared font stack is Segoe UI / Microsoft YaHei UI / Microsoft YaHei / sans-serif. The generated mock does not provide an exact font identity. Actual secondary/helper text is lighter and smaller than the mock, a P3 optical refinement. The distance label now remains intact at 1080×720.
- Spacing/layout: the large left preview, compact right panel, toolbar and fixed folder/summary/action footer preserve the reference hierarchy and proportions. Borders, restrained radii and pale surfaces are consistent. The advanced entry now fits entirely at 1488×1056, and preview exit sits beside playback. At smaller heights the parameter pane scrolls, while playback, exit and generation remain visible. No horizontal page overflow or obscured bottom action was observed in the reviewed 1488, 1440 and 1080 captures.
- Colors/tokens: light gray shell, white panels, blue selected tabs/actions, muted secondary text and dark preview match the selected direction. Green completed and blue active task states remain distinguishable. The actual preview background is slightly blue-black; acceptable for the retained renderer.
- Images/assets/icons: the preview uses the real INSAT GLB with intact panels and body detail, not a raster mock or handmade substitute. Its geometry, materials and apparent size differ from the AI mock, as explicitly required by the approved real-asset constraint. Do not alter capture geometry/materials to imitate invented mock details. Native controls and the satellite application mark retain clear visual roles. Formal saved images use their real capture framing and are not enlarged to imitate the inspection view.
- Copy/content: Chinese page names, field groups, units, output folder and dynamic `生成120帧图像` action are coherent. Descriptive model names, current-service/version text, quaternion disclosure and `使用当前姿态` are functional additions. Removing `静态结构草图` is intentional. Long real output paths are shortened in the fixed footer and wrapped in results. Results have no supplied visual target; they are reviewed for consistency and usability, not invented pixel equivalence.

**Comparison history**

1. Earlier screenshot `var/verification/v2.4-workbench/1793525475736/generation-before-review.png` exposed undersized common controls and a clipped advanced entry. Common controls were raised to 16 px and parameter-group padding reduced to 18 px. The subsequent `1793526144095` comparison confirms improved readability, but active preview still adds the extra row documented above.
2. [P2, resolved] The active-preview `退出预览` row pushed the bottom of `高级参数` beyond the reference viewport, unlike the fully visible source entry. Evidence: `var/verification/v2.4-final-launch/1793526144095/design-parameters-comparison.png`. Fix: move exit beside playback in the left preview footer. Post-fix full and parameter-region comparisons in `var/verification/v2.4-final-launch/1793526596583/` show the entire advanced entry; measured bottom 907.17 px is inside panel bottom 936 px. Exit remains visible in both final responsive screenshots.
3. [P2, resolved] `相机距离（固定）` wrapped within `固定`, leaving `定）` on another line at 1080×720. Evidence: `var/verification/v2.4-workbench/1793525475736/generation-1080x720.png`. Fix: preserve a single-line distance label and adapt its row at compact width. Post-fix `var/verification/v2.4-final-launch/1793526596583/generation-active-1080x720.png` shows a complete label, input and km unit without collision; measured label height equals its 24 px line height.
4. The earlier results screenshot caught the task list before its polling update, while the detail was already completed. The final native run awaited the selected task row's completed status before capture. `var/verification/v2.4-final-launch/1793526596583/results-reference-state.png` now shows completed 1/1 in both detail and list, with an idle queue. No product change was needed for that transient capture mismatch.

**Interaction evidence and limits**

`var/verification/v2.4-workbench/1793525475736/ui-acceptance.json` reports responsive layout, mode parameters, native picker cancel/selection, directory validation, noise workflow, frozen jobs across navigation and independent variant drafts passed. Final `var/verification/v2.4-final-launch/1793526596583/report.json` reports `passed: true`, `pageErrors: []`, independent inspection and a completed real single-frame capture. It measures scroll widths equal to 1488, 1440 and 1080 px viewports, visible exit controls and bottom actions inside each viewport. These are existing native test evidence, not interactions independently repeated by this reviewer. Full keyboard/screen-reader and high-zoom accessibility testing was not performed in this visual pass. No new installer was reviewed.

**Implementation checklist**

- [x] Move preview exit out of the parameter stack while retaining its visible action.
- [x] Correct the minimum-width distance label.
- [x] Open and inspect the post-fix matched active reference state, combined full/region comparisons and minimum viewport; close both P2 findings from this evidence.

**Follow-up polish**

- [P3] Secondary text could be optically closer to the mock through small weight/size adjustments after confirming the live font fallback. This does not justify changing the model renderer or capture profile.

final result: passed
