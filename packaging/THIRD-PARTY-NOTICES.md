# Third-party notices — Satellite Dataset Studio

This document identifies the third-party software included in the Windows x64 offline distribution and the locations of its original license texts. It does not replace or modify those texts. Paths below are relative to the installed application directory unless identified as a release-side source archive.

The exact downloaded artifacts, versions, upstream URLs, and SHA-256 values are recorded in `licenses/dependencies.lock.json`. The installed file inventory is recorded in `release-manifest.json`.

## Components and retained license files

| Component | Version | License identification | Included license or notice location |
|---|---|---|---|
| React | 19.3.0 | MIT | `licenses/react-LICENSE.txt` |
| React DOM | 19.3.0 | MIT | `licenses/react-dom-LICENSE.txt` |
| React Scheduler | 0.28.0 | MIT | `licenses/scheduler-LICENSE.txt` |
| Three.js, including the imported example modules | 0.180.0 | MIT | `licenses/three-LICENSE.txt` |
| Microsoft.Web.WebView2 SDK and loader | 1.0.4191.47 | BSD 3-Clause text supplied by Microsoft, plus third-party notices | `licenses/microsoft.web.webview2/LICENSE.txt` and `licenses/microsoft.web.webview2/NOTICE.txt` |
| Microsoft Edge WebView2 Runtime, Fixed Version, x64 | 153.0.4234.48 | Microsoft Software License Terms for the Fixed Version Runtime; separate third-party component notices | `licenses/WebView2-Runtime-LICENSE.txt`; `runtime/webview2/show_third_party_software_licenses.bat` displays the runtime's bundled third-party licenses |
| .NET Core runtime, win-x64 | 8.0.31 | MIT; bundled components have additional notices | `licenses/microsoft.netcore.app.runtime.win-x64/LICENSE.TXT` and `licenses/microsoft.netcore.app.runtime.win-x64/THIRD-PARTY-NOTICES.TXT` |
| .NET Windows Desktop runtime, win-x64 | 8.0.31 | MIT | `licenses/microsoft.windowsdesktop.app.runtime.win-x64/LICENSE` |
| CPython embeddable, x64 | 3.13.15 | Python Software Foundation License and incorporated license texts | `runtime/python/LICENSE.txt` |
| NumPy, cp313 win_amd64 | 2.3.5 | BSD 3-Clause; the binary distribution includes additional component licenses | `runtime/python/Lib/site-packages/numpy-2.3.5.dist-info/LICENSE.txt`; additional license files remain in the `numpy` package |
| Pillow, cp313 win_amd64 | 12.3.0 | MIT-CMU; the binary distribution includes additional component licenses | `runtime/python/Lib/site-packages/pillow-12.3.0.dist-info/licenses/LICENSE` |
| Inno Setup installer engine | 7.1.0 | Inno Setup License | `licenses/Inno-Setup-LICENSE.txt` |

React, React DOM, and Scheduler retain the copyright notices of Meta Platforms, Inc. and affiliates. Three.js retains the copyright notice of the three.js authors. The original copyright, permission, conditions, and disclaimer text is included in each file listed above.

## Complete bundled notices

The Python runtime retains the complete CPython `LICENSE.txt`, all installed NumPy and Pillow distribution metadata and licenses, and the DLLs supplied in those wheels. The NumPy combined license includes OpenBLAS, LAPACK, and the GCC runtime license with the GCC Runtime Library Exception; it is not reduced to NumPy's leading BSD text.

The complete Pillow license also contains the notices for Brotli 1.2.0, FreeType 2.14.3, HarfBuzz 14.2.1, Little CMS 2.19.1, libavif 1.4.2 and its incorporated components, libjpeg-turbo 3.1.4.1, libpng 1.6.58, libwebp 1.6.0, OpenJPEG 2.5.4, libtiff 4.7.1, XZ 5.8.3, and zlib-ng 2.3.3. Those complete texts, including their copyright statements, remain in Pillow's license file.

This software uses FreeType 2.14.3, developed by the FreeType Project (<https://freetype.org>). The complete FreeType license and copyright notices are included in the Pillow license file identified above.

This software is based in part on the work of the Independent JPEG Group.


The WebView2 SDK `NOTICE.txt` is retained in its original language and form, including its “Do Not Translate or Localize” instruction. The entire Fixed Version Runtime is retained, including its third-party credits resources and `show_third_party_software_licenses.bat` entry point.

## Microsoft Edge WebView2 Runtime

This application includes Microsoft Edge WebView2 Runtime software provided by Microsoft. The runtime may collect information about the end user's use of that software and send that information to Microsoft, as described in the Microsoft Privacy Statement: <https://aka.ms/privacy>.

The included runtime contains Microsoft Defender SmartScreen. SmartScreen collects and sends end-user information to Microsoft as disclosed in the Microsoft Privacy Statement and the Microsoft Edge Privacy Whitepaper: <https://learn.microsoft.com/en-us/microsoft-edge/privacy-whitepaper#smartscreen>.

The complete original English Fixed Version Runtime terms, including the French clauses included by Microsoft, are provided in `licenses/WebView2-Runtime-LICENSE.txt`. Only HTML markup and layout whitespace were converted to plain text; no terms were translated or summarized in that file.

Official source checked on 2026-09-20:

- Download page: <https://developer.microsoft.com/en-us/microsoft-edge/webview2/>
- Fixed Version terms endpoint used by that download page: <https://developer.microsoft.com/microsoft-edge/api/eula/webview2?fixed=true>
- Distribution documentation: <https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution>

## Separate offline model authoring

The application uses registered GLB assets and Three.js in WebView2. Blender, .blend files and Blender source archives are not application dependencies and are not included in its payload. Existing offline authoring installations, original source assets and earlier release source archives remain separate and unchanged. Any separate redistribution of those tools retains its own upstream licensing obligations.

## Model assets and provenance

The six model assets are supplied for this user's local installation. They are not covered by the software licenses above. `assets/models/index.json` retains each source filename, source hash, processed-asset hashes, and material/provenance notes. The four replacement models identify the user-supplied `02-四个卫星模型.zip` archive. The original purchased archives are not included in the application payload or uploaded by this delivery.

Sputnik-1 uses the supplied texture atlas with reconstructed PBR response. GPS, Galileo, and GLONASS use reconstructed simulation materials; those colors are not represented as recovered manufacturer or source-author materials. See `docs/model-materials.md` for the asset preparation notes.

V2.5 adds twelve separately identified public visualization assets from the user's collected library. Each new `assets/models/<id>/` retains `ATTRIBUTION.txt`, `provenance.json` and `asset-audit.json` with the original provider, usage-policy URL, original and prepared hashes, and preparation notes. NASA assets retain their source media-usage notices; the Chandra item retains its Smithsonian source notice. These model assets do not acquire the application's software license, and no provider endorsement or independently calibrated engineering scale is asserted. The original six model definitions are unchanged. This update prepares a local development application, not a new installer distribution.

## V2.5.1 user-authored additions

`original_remote_sensing` and `sar_radar` are supplied by the user as self-authored GLBs. Their source hashes and offline preparation records are retained locally. No public redistribution license is inferred. Model binaries remain excluded from Git. The catalog offers 19 selectable models; a retired Hubble entry and its original asset remain solely for existing-task compatibility.
