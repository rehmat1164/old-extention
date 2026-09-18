# Mete Run — local three-mode extension

A Manifest V3 Chrome extension with a native side panel and three workflows: Meta AI images, uploaded-image → Vibes AI video, and prompt → Meta AI image → Vibes AI video. No runtime dependency on external configuration, a remote API key, or a web store update service.

See [INSTALL.md](INSTALL.md) for installation, operation, privacy, and test-build limitations. Meta/Vibes themselves remain online services and require the user's account.

## Local development

```sh
npm ci
npx playwright install chromium
npm test
npm run check
npm run build
npm run test:browser
```

The build is an allowlist-based archive at `dist/mete-run-local-test.zip`, with an unpacked directory at `dist/mete-run-local`. It excludes dev dependencies, old UI modules, fixtures, attachments, browser profiles, and credentials. The package uses only bundled JavaScript/CSS and preserves `LICENSE.md` and the original logo.

`npm run preview` serves an explicitly labeled interface preview and ZIP download page. The web preview does not perform generation and is not a substitute for loading the extension in Chrome. Run the build before downloading its ZIP.

## Implementation

- `sidepanel.html`, `js/panel.js`, `js/downloads-view.js`, `css/panel.css`: Generate, Download Manager and Settings sections, a fixed generation footer, local previews, output selection, progress and diagnostic events.
- `background.js`: native panel gestures and authenticated extension message routing. It does not run a fragile long-lived generation loop in the MV3 service worker.
- `offscreen.html`, `js/offscreen.js`, `js/lib/runner.js`: local Blob/ZIP worker and persisted, cancellable workflow state. Browser restarts never blindly resubmit a generation.
- `js/automation/`, `js/content.js`: bundled provider adapters, explicit upload verification, baseline-scoped media discovery, and observer-based waits.
- `js/lib/model.js`, `downloads.js`, `store.js`, `media.js`, `zip.js`: strict prompt pairing, stable download/ZIP mappings, IndexedDB, validated media, and dependency-free streaming ZIPs with confirmed export history.

Automated tests establish local behavior against controlled inputs/pages. The unpacked-extension browser checks exercise all three modes, real PNG/MP4 decoding, upload fingerprints, selected-variant exports and local ZIP mapping. These fixtures do not contact live provider services. Live authenticated provider behavior must be tested locally; changed/ambiguous provider DOM states fail safely.

Copyright and redistribution terms remain those of the original author in [LICENSE.md](LICENSE.md).
