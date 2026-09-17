# True Automatic Open Feature

The extension now supports **True Automatic Opening** of the interface when you visit `https://www.meta.ai/media`.

## How it works:
1. When you navigate to the Meta AI Media page, a background script detects it.
2. It automatically opens the extension interface in a **Popup Window** positioned on the right side of your screen (simulating a side panel).
3. This happens **without any click required**.

## Important Configuration:
- **Pop-up Blocker**: The first time this happens, Chrome might block the popup. Look for an icon in the address bar saying "Pop-up blocked", click it, and select **"Always allow pop-ups and redirects from this site"**.
- This is a one-time setup. After that, it will open automatically every time.

## Why a Popup Window?
Chrome's security policy strictly blocks the "Side Panel" from opening automatically without a user click. Using a popup window is the only reliable workaround to achieve true zero-click automation.

## Auto-Open Logic
- The popup will only try to open once per session to avoid spamming you if you refresh the page.
- If you close it and want it back, you can either reload the page or click the extension icon.
