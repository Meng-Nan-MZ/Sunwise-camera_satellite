# V2.5 model library and task deletion implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Model import, deletion backend and UI have separate ownership; native acceptance follows the combined build.

**Goal:** Add the 12 collected models alongside the existing six and let users delete a saved task and its local files from the recent-task context menu.

**Architecture:** Prepare self-contained GLBs offline and append catalog entries without changing existing model IDs or geometry. Preview deletion from database relationships, confirm the exact affected set, and delete only validated owned task folders. Use a deletion fingerprint and UI tombstones to prevent unnoticed cascade changes and stale polling resurrection.

**Tech Stack:** Python/SQLite, React/TypeScript, Three.js, WPF/WebView2.

**Spec:** User request dated 2026-11-02 and confirmation to include dependent noise variants when deleting an original task. V2.5 is represented as package version 2.5.0.

## Global constraints

- Preserve V1, existing six model definitions, original collection files, existing datasets and ignored KIMI workspace.
- No Blender dependency for end-user viewing or capture; offline asset conversion is allowed.
- Do not claim real-world physical calibration for author-scale visualization assets.
- No installer/archive; build and publish validated source through existing V2 branch.
- Delete only terminal tasks; queued/running tasks and active dependent variants must first be canceled.
- Use isolated fixtures for all destructive validation.

## Review focus

- GLB compression, textures, source scale and off-center geometry must not cause invisible/clipped output.
- New dependent noise tasks created after confirmation must invalidate the deletion fingerprint.
- Renamed/replaced folders, junctions and paths outside a recorded job root must never be recursively removed.
- File deletion failure must retain records and allow retry after restart, with an explicit partial-deletion message.
- In-flight list, detail and paging responses must not restore a deleted task in the UI.

### Task 1: Collected models

Files: `tools/import_collected_models.py`, supporting offline conversion helper, `assets/models/index.json`, per-model provenance, `python/src/satellite_studio/server/models.py`, asset tests.

- [x] Audit all 12 hashes, embedded resources, extensions and bounds.
- [x] Normalize source assets offline, preserve source hashes/attribution and mark physical scale uncalibrated.
- [x] Append unique IDs, expose scale/provenance metadata, verify original six unchanged.
- [x] Validate all previews and three formal poses per new model in native acceptance.

### Task 2: Deletion backend

Files: `python/src/satellite_studio/jobs/store.py`, dedicated deletion module, `python/src/satellite_studio/server/app.py`, Python tests.

Interfaces: GET `/api/jobs/{id}/deletion-preview` returns `{job_id,jobs,can_delete,blocked_reason,fingerprint}`. DELETE `/api/jobs/{id}` requires `If-Match` fingerprint and returns `{deleted_job_ids,deleted_count}`. Errors return `{error,code}`; active or changed plans return 409.

- [x] Write and run failing tests for cascade, variant-only, active dependencies, stale plans, unsafe paths and failed/restarted deletion.
- [x] Serialize source validation/create/delete with a lifecycle lock and persist deletion intent for retry.
- [x] Validate complete folder ownership before removal; retain records until all files are removed.
- [x] Run targeted and full backend tests with current source PYTHONPATH.

### Task 3: Deletion UI and model information

Files: `apps/ui/src/api.ts`, `types.ts`, `App.tsx`, `workbench.ts`, `components/ResultsWorkspace.tsx`, context menu and deletion dialog, styles, relevant tests.

- [x] Add failing merge test for deleted IDs in both fresh and previously loaded responses.
- [x] Add right-click and keyboard context menu targeting the chosen row, not the currently selected row.
- [x] Show model/mode/date/count/path for all affected tasks, blocked state, explicit permanent-delete confirmation and retry errors.
- [x] Suppress stale list/detail/paging responses after success; clear the deleted selection and image.
- [x] Place model attribution and scale caveat in technical details.
- [x] Run frontend tests/build and native cancel/cascade/variant-only/polling checks.

### Task 4: Release

- [x] Update current version surfaces, user guide and verification record to 2.5.0 without rewriting historical evidence.
- [x] Build native host, run model/deletion acceptance and inspect rendered output.
- [x] Review changes and resolve material findings.
- [ ] Commit, tag and push normal history; confirm remote commit/tag and leave source assets/datasets out of Git.
