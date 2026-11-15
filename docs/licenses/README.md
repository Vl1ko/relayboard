# Third-party software supplied with Relayboard

Dependency versions and npm integrity hashes are fixed in package-lock.json. `runtime-dependencies.json` is generated for the actual installation by `scripts/prepare-runtime-dependencies.mjs`; original package notices and licenses remain under node_modules. React, ReactDOM and Scheduler notices are copied here for the browser bundle.

## node-buffers 0.1.1 (installed as buffers)

Author: James Halliday. License declared by the replacement npm package: MIT/X11. Source/package: https://www.npmjs.com/package/node-buffers . The old buffers tarball lacked license metadata; the alias is pinned explicitly. Full package source remains available in node_modules/buffers. The replacement includes fixes for modern Buffer APIs; archive/XLSX regression is required.

## node-webpmux 3.2.1

Copyright (C) 2023 ApeironTsuka. Licensed under LGPL-3.0-or-later. See LGPL-3.0.txt and GPL-3.0.txt. Upstream release commit: f9c554d359d52c0787599fdb999b20e34fcdf332, https://github.com/ApeironTsuka/node-webpmux . Library functions are dynamically loaded from the separate node_modules/node-webpmux directory; its complete distributed JavaScript source and original notices are included. Users may replace that directory with a compatible modified library, including for debugging such modifications; Relayboard imposes no technical signature/relinking restriction.

Modification by Relayboard, 2026-11-15: the optional pixel encoder/decoder loader is disabled and its unused compiled WASM directory is excluded. The upstream archive did not include a reproducible build for that codec. Relayboard prepares outgoing images in Chromium and exposes no Node pixel-codec operation. JavaScript parsing, WebP muxing and metadata are preserved and tested. The modified library remains LGPL-3.0-or-later. The preparation recipe is scripts/prepare-runtime-dependencies.mjs, applied after npm ci; its original source is restored by npm ci before the recipe runs. No native binary from this library is distributed by the prepared installation.

Keep this directory, the preparation recipe and the installed library source/notices when distributing the image or project. The release manifest must verify that the optional compiled codec is absent. These records describe the actual components and modifications; they do not certify unrelated third-party distribution arrangements.
