# Endpoint feedback implementation plan

**Goal:** Add the minimal feedback approved by the user: persistent saved button labels/colors, a short highlight on every successful save, and one sentence explaining replacement.

**Architecture:** Store explicit endpoint confirmation separately from the capture draft in BrowserStudio so manual and WebMCP configuration share truthful state. Render the existing two buttons from this state; animate the same button node to preserve keyboard focus. Keep capture parameters and dataset formats unchanged.

**Tech stack:** Existing React, TypeScript and CSS; browser Web Animations API. No dependencies.

**Approved spec:** Buttons become “✓ 起点已设置 · 点击更新” and “✓ 终点已设置 · 点击更新”. Help reads “可继续转动模型，已保存的起终点保持不变；再次点击对应按钮即可更新。” No thumbnails, cards or additional actions.

## Steps

- [x] Extend the existing studio endpoint test and cover independent overwrite, preservation during pose changes, invalid configuration, explicit API configuration and leaving/re-entering sequence mode.
- [x] Add `endpoint_saved` state, updated only after validated saves/configuration. Defaults remain unconfirmed; leaving custom sequence clears flags. Model changes retain existing endpoints and matching flags, following existing behavior.
- [x] Update BrowserApp buttons/help and CSS; successful saves highlight for 600 ms. Respect reduced motion and retain button focus. Remove the previous W-only summary.
- [x] Run tests, TypeScript and build; inspect actual browser behavior, repeat-click highlighting and narrow-screen layout. Request independent review.
- [x] Prepare the verified change for commit on the existing `web/V4` branch.

## Review focus

Initial defaults must not appear explicitly saved; saving one endpoint cannot confirm the other. Current pose changes cannot overwrite saved endpoints. Failed configuration cannot change confirmation flags. WebMCP updates must be reflected without relying on click-local state. Repeated saving must preserve keyboard focus and honor reduced-motion preferences.

## Validation

Both endpoint tests failed before implementation and passed afterward. Full suite: **197/197**; TypeScript and production build passed. Independent reviewer ran the 12 studio tests and found no P1/P2 issues.

Actual browser checks: saving the identity pose as start leaves end unconfirmed; changing X to 45° preserves start, then saving end confirms it. Updating X to 90° and saving start preserves the 45° end. Repeated keyboard activation retains focus and restarts the pink-to-lime highlight; final background is lime. Leaving/re-entering custom sequence resets both labels. A 390 px viewport keeps both labels within their 44 px-high buttons without horizontal document overflow. No browser console errors. Reduced-motion handling was checked in source; no physical-device coverage claimed.

Local evidence: `var/endpoint-validation/saved-endpoints.png`, `var/endpoint-tests.txt`, `var/endpoint-build.txt` (ignored by Git).
