# Browser Web execution ledger
Base: c01b92d66b8bac9f7213c9f0da175c8c6f38c272, verified GitHub main 2026-11-03.
Isolation: independent local clone SatelliteDatasetStudio-Web, branch web/browser-local. Original untouched.
User authorized implementation of browser-local processing/downloads and chose visual reference. Proceeding within approved direction; no further product approval needed.
Ruling: cap 500 frames/job and 256 MiB retained output to make small-batch browser use bounded; record web algorithm versions, not false desktop bitwise equivalence.
Tasks 1–5 implemented and verified. 181 front-end tests pass, TypeScript and Vite production build pass, and local launcher Check passes with 19 verified models.
Independent review findings (frozen endpoints, disposal cleanup, asynchronous noise cancellation, hidden cross-task downloads, stale frame index) were fixed. The cancellation regression was verified red then green; UI findings were reproduced and checked after fixes.
Real manual and native WebMCP capture worked. All four modes, noise reuse, desktop/mobile layout, and partial cancellation/download were exercised. Four actual downloaded ZIPs passed independent zipfile/Pillow/matrix/label checks.
Detailed evidence: ../../web-validation-2026-11-03.md and ignored var/web-validation/download-acceptance.json. Keep the independent copy and local branch for the user's requested local-first trial; no cloud deployment or main-branch merge.
