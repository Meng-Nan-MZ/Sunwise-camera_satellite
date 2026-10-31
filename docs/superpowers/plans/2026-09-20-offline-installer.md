# Offline Windows Installer Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for root orchestration; delegate independent desktop and package-audit work with existing collaboration agents.

**Goal:** Deliver a locally built Windows x64 offline installer with all application runtimes and six models.
**Architecture:** A self-contained WPF host launches embedded Python and bundled Blender, with a fixed WebView2 runtime. A per-user installer copies a validated payload and preserves data outside the application directory.
**Tech Stack:** .NET 8/WPF, Python embedded Windows runtime, NumPy/Pillow, Blender, WebView2 Fixed, Inno Setup.
**Spec:** ../specs/2026-09-20-offline-installer-design.md

## Global Constraints

- Windows x64, local offline usage; no network downloads during install/first start.
- Keep existing six registered model files and pose math unchanged.
- No developer paths, old tasks, SDKs, source archives or node_modules in payload.
- Default user workspace outside installation; uninstall preserves it.
- No public upload or publication of purchased assets.

## Review Focus

- Chinese/spaced installation path and unrelated process working directory must resolve the same package.
- Missing fixed WebView2 must fail visibly rather than pass because the developer machine has Evergreen.
- Embedded Python must find NumPy/Pillow and service code without PYTHONPATH or system Python.
- Rendering must work with installation files read-only, with no __pycache__ writes.
- Upgrade/uninstall must not delete datasets; archive paths and cleanup must stay within staging/test roots.

## Task 1: packaged desktop entry

- [x] Add executable-directory/default-workspace and missing-runtime tests in `tests/desktop/Program.cs`; run to see current no-argument parser fail.
- [x] Implement optional fixed runtime and no-argument launch in `apps/desktop/LaunchOptions.cs`; preserve explicit development arguments.
- [x] Use the fixed runtime in `Program.cs`; set Python no-bytecode in `ServiceProcess.cs` and Blender worker. Pass `-X utf8` explicitly for isolated embedded Python.
- [x] Run desktop tests and build; independently review path handling. 17 desktop tests passed; Python/rendering 31 tests passed.

## Task 2: locked runtime inputs and payload assembly

- [x] Resolve official runtime/compiler download links, versions and checksums into `packaging/dependencies.lock.json`; store downloads only under `var/packaging/downloads`.
- [x] Implement hash-checked download/extraction and curated payload assembly under `tools/packaging/`; test archive traversal rejection and required-file/hash failure. Added a reproduced Windows long-path regression; 8 payload tests passed.
- [x] Publish desktop with `dotnet publish -r win-x64 --self-contained true -p:PublishTrimmed=false` and build UI. UI 5 tests passed.
- [x] Assemble backend, six-model catalog, isolated Python/wheels, Blender, fixed WebView2, licenses and user docs; verify Python imports and model hashes. Frozen candidate: `var/packaging/staging/release-0.1.0-r2`, 9007 files, 2104014705 bytes; embedded interpreter loaded all six models using only paths inside the payload.

## Task 3: installer and integration

- [x] Define per-user x64 installer in `packaging/installer/SatelliteDatasetStudio.iss`, with shortcuts, safe uninstall and fixed-WebView2 Windows 10 permissions.
- [x] Build installer into `var/releases`; compute final SHA256 and file inventory. 788234030 bytes; SHA256 `29ae29eef06ad3ccdccc14554d6d49cf7bf74d92ca5d280249659748646f3e7e`.
- [x] Install silently to a dedicated Chinese/spaced directory under `var/packaging/verification`, start the installed app with a fresh test workspace and fixed runtime. Installed files were made read-only using a temporary inherited deny-write rule, then original permissions were restored.
- [x] Verify six preview resources, real grayscale rendering, small batch and child-process cleanup without developer runtimes; verify install/uninstall lifecycle and preserved dataset marker. All passed; 6 complete frames, 12 formal PNGs, 34 retained data files unchanged.
- [x] Record exact runtime versions, sizes, verification results and remaining clean-machine limitations in `docs/offline-verification.md`; deliver the installer and guide.
