# Mete Run — local test build

## Install in Chrome

1. Extract **mete-run-local-test.zip**. Do not select the ZIP in Chrome.
2. Open `chrome://extensions`, enable **Developer mode**, and disable any older Mete Run extension to avoid two automations running together.
3. Click **Load unpacked** and select the extracted **mete-run-local** folder containing `manifest.json`.
4. Pin Mete Run in Chrome's Extensions menu. Sign in to Meta AI and Vibes AI normally in Chrome.
5. Click the Mete Run toolbar icon, or **Open Mete Run** on either provider page. This opens Chrome's real side panel, not a webpage or injected iframe.

Use Chrome 120 or newer on desktop. Keep the extracted folder in place. After replacing files, click Reload on this extension's card and refresh provider tabs. An unpacked installation does not receive Chrome Web Store updates.

## Three modes

- **Image:** enter image prompts separated by a blank line and choose the image ratio. Mete Run sends a single English request asking for one separate, numbered Meta AI image per prompt.
- **Image → Video:** upload PNG, JPG, or WebP images (10 MB maximum each), check their numbered order, and enter exactly one video prompt per image. Filenames sort naturally: `image_2` comes before `image_10`.
- **Prompt → Image → Video:** enter matching image and video prompts in the two tabs. Images are generated and saved locally first, then uploaded individually to Vibes AI.

For videos, select the resolution and the video variants you want to save (1–4). Video aspect ratio follows the verified source image. Four provider candidates are observed per source image; only selected variants are saved locally and exported. Choose **Videos only** or **Images + videos** before starting.

The sidebar has **Generate**, **Downloads**, and **Settings** sections. The Generate button stays at the bottom while the middle content scrolls. Download Manager shows numbered image/video mappings, local previews, selected/ready file counts, filename search, filters, and an activity log. Preview playback uses saved local media, never unrelated provider thumbnails.

**Generate** opens a ZIP save dialog before any provider request. Cancelling it does not start generation. Grant file-write permission and leave the provider tabs open; the side panel itself may be closed. Generation uses your account and may consume the provider's credits. **Settings → Save ZIP automatically** is on by default; turn it off to review the completed local files in Download Manager before saving.

## Saved files and controls

ZIPs use `images/image_001.png` (or `.jpg`/`.webp`) and `videos/video_001.mp4`. Selecting multiple variants adds `_variant_1`, `_variant_2`, etc. `manifest.json` inside the generated ZIP records the prompt-to-image-to-video mapping and file hashes, without signed media URLs. Images and selected videos stay in this extension's local IndexedDB until you clear the run. Uploaded draft files can be removed separately.

- **Pause:** finish collecting the current item, then stop before the next item.
- **Resume:** continue saved progress or observe the same pending operation; never blindly resubmit generation.
- **Stop:** stop local automation. Requests already sent may continue on the provider.
- **Save ZIP:** write to the destination selected before generation, or retry a failed export. You can change variants or include/exclude images after generation without submitting another request. This overwrites the chosen ZIP with the current selection.
- **Save ZIP as…:** choose a different destination or renew expired write permission. The last successful ZIP record changes only after the new file is fully written and closed.
- **Clear run:** remove the saved run and its generated media after saving your ZIP.
- **Settings:** show/hide the provider-page open button, enable/disable automatic ZIP saving, reset output defaults without erasing prompts, or clear uploaded draft images separately. The toolbar opener always remains available.
- **Copy log:** copy local run events for debugging. Review filenames and messages before sharing; signed media URLs are not included.

## First local test

Start with one image prompt, then one uploaded image + one video prompt. Finally try two numbered prompt pairs. Confirm that the selected start frame, four new video candidates, ZIP folders, and `manifest.json` all refer to the correct source image. Test cancelling the save dialog and mismatched prompt counts too: neither should submit a request.

## Important limits

- This is a **local test build**, not a claim of verified live Meta/Vibes compatibility. Automated tests use controlled pages; your logged-in provider flow still needs testing. The supplied recordings do not establish every result-card selector.
- Local-only means bundled extension code, selectors, styling, and storage: **no remote configuration, fonts, NVIDIA client, telemetry, or updater**. Meta AI/Vibes AI generation and downloading their media still require internet access and your existing logins.
- Chrome requires a user click to open a native side panel. It cannot be forced open on a first visit with no gesture. Once opened, the global panel can remain available across tabs.
- Provider interfaces can change. Ambiguous image labels, an unverified start frame, missing video candidates, login/credit errors, or a page reload stop the workflow rather than guessing a mapping or generating duplicates. Read the status and inspect the provider tab; do not manually submit more generations in the run's dedicated tabs or navigate its Vibes tab to a different project.
- Closing a provider tab can lose access to its short-lived media. Chrome restart pauses saved progress. A request lost during page reload cannot safely be resubmitted automatically.
- The local test ZIP writer supports archives below 4 GiB; an individual downloaded video is limited to 256 MiB. No partially written ZIP is reported as complete.

Original branding and copyright are preserved. See `LICENSE.md` for redistribution restrictions.
