// Automatic Side Panel Injection (Fake Side Panel)
(async function () {
    const TARGET_HOST = "meta.ai";
    if (!window.location.href.includes(TARGET_HOST)) return;

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.type === "TOGGLE_PANEL") {
            const iframe = document.getElementById("autoMetaCopySidePanelFrame");
            if (iframe) {
                if (iframe.style.display === "none") {
                    iframe.style.display = "block";
                    setTimeout(() => {
                        iframe.style.width = "500px";
                        document.body.style.marginRight = "500px";
                    }, 10);
                } else {
                    iframe.style.width = "0px";
                    document.body.style.marginRight = "0px";
                    setTimeout(() => { iframe.style.display = "none"; }, 300);
                }
            }
            sendResponse({ success: true });
            return false;
        }
        sendResponse({ success: false, error: `Unhandled message type: ${request.type || 'unknown'}` });
        return false;
    });

    function removeUnusedPreloadLinks() {
        document.querySelectorAll('link[rel="preload"]').forEach((link) => {
            const href = link.getAttribute("href") || "";
            const asValue = link.getAttribute("as") || "";
            if (!href.includes("fonts.googleapis.com") && !href.includes("fonts.gstatic.com") && asValue !== "font") {
                link.remove();
            }
        });
    }

    removeUnusedPreloadLinks();
    const preloadObserverRoot = document.documentElement || document;
    new MutationObserver(removeUnusedPreloadLinks).observe(preloadObserverRoot, { childList: true, subtree: true });

    if (!document.body) {
        await new Promise(resolve => {
            document.addEventListener("DOMContentLoaded", resolve, { once: true });
        });
    }

    // Avoid duplicate injection
    if (document.getElementById("autoMetaCopySidePanelFrame")) return;

    console.log("[Auto Meta] Injecting Side Panel Iframe...");

    // 1. Create Iframe
    const iframe = document.createElement("iframe");
    iframe.id = "autoMetaCopySidePanelFrame";
    iframe.src = chrome.runtime.getURL("sidepanel.html") + "?v=" + Date.now();
    iframe.allow = "clipboard-write; clipboard-read";

    // 2. Style Iframe (Fixed Right Side)
    Object.assign(iframe.style, {
        position: "fixed",
        top: "0",
        right: "0",
        width: "0px", // Start closed for animation
        height: "100vh",
        border: "none",
        borderLeft: "1px solid #333", // Subtle separator
        zIndex: "2147483647", // Max Z-Index
        backgroundColor: "#1a202c", // Match theme
        transition: "width 0.3s ease"
    });

    document.body.appendChild(iframe);

    // 3. Adjust Main Page Layout (Make space for panel)
    document.body.style.transition = "margin-right 0.3s ease";

    // Open Animation
    setTimeout(() => {
        iframe.style.width = "500px";
        document.body.style.marginRight = "500px"; // Push content
    }, 100);

    // Optional: Add a small toggle handle in case they want to hide it?
    // User requested "Image 2" style which is permanent side panel.
    // So we keep it fixed.

    console.log("[Auto Meta] Side Panel Injected.");

    const FLOATING_STATE_KEY = "autoMetaCopy_floatingWindowState";
    const FLOATING_IFRAME_ID = "autoMetaFloatingDownloadFrame";
    const MIN_WIDTH = 520;
    const MIN_HEIGHT = 420;

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    async function getFloatingState() {
        const data = await chrome.storage.local.get({
            [FLOATING_STATE_KEY]: {
                visible: false,
                activeTab: "queue",
                minimized: false,
                maximized: false,
                lockSizeAfterReopen: false,
                x: 80,
                y: 80,
                width: 920,
                height: 680
            }
        });
        return data[FLOATING_STATE_KEY] || {};
    }

    async function saveFloatingState(patch) {
        const current = await getFloatingState();
        await chrome.storage.local.set({ [FLOATING_STATE_KEY]: { ...current, ...patch } });
    }

    function applyFloatingGeometry(frame, state) {
        const viewportW = Math.max(320, window.innerWidth || 0);
        const viewportH = Math.max(360, window.innerHeight || 0);
        const minWidth = Math.min(MIN_WIDTH, Math.max(300, viewportW - 24));
        const minHeight = Math.min(MIN_HEIGHT, Math.max(260, viewportH - 24));
        const maxWidth = Math.max(minWidth, viewportW - 24);
        const maxHeight = Math.max(minHeight, viewportH - 24);
        const defaultWidth = clamp(Math.round(viewportW * 0.82), minWidth, Math.min(1120, maxWidth));
        const defaultHeight = clamp(Math.round(viewportH * 0.78), minHeight, Math.min(760, maxHeight));
        const width = clamp(Number(state.width) || defaultWidth, minWidth, maxWidth);
        const height = state.minimized ? 64 : clamp(Number(state.height) || defaultHeight, minHeight, maxHeight);
        const xMax = Math.max(12, viewportW - width - 12);
        const yMax = Math.max(12, viewportH - height - 12);
        const x = state.maximized ? 12 : clamp(Number(state.x) || Math.round((viewportW - width) / 2), 12, xMax);
        const y = state.maximized ? 12 : clamp(Number(state.y) || Math.round((viewportH - height) / 2), 12, yMax);
        Object.assign(frame.style, {
            display: state.visible === false ? "none" : "block",
            position: "fixed",
            left: `${x}px`,
            top: `${y}px`,
            width: `${state.maximized ? viewportW - 24 : width}px`,
            height: `${state.maximized ? viewportH - 24 : height}px`,
            border: "0",
            background: "transparent",
            zIndex: "2147483646",
            borderRadius: "22px",
            boxShadow: state.minimized ? "0 16px 38px rgba(15, 23, 42, .18)" : "0 30px 90px rgba(15, 23, 42, .28)"
        });
    }

    function getAutoFitState(base = {}) {
        const viewportW = Math.max(320, window.innerWidth || 0);
        const viewportH = Math.max(360, window.innerHeight || 0);
        const minWidth = Math.min(MIN_WIDTH, Math.max(300, viewportW - 24));
        const minHeight = Math.min(MIN_HEIGHT, Math.max(260, viewportH - 24));
        const width = clamp(Math.round(viewportW * 0.82), minWidth, Math.min(1120, viewportW - 24));
        const height = clamp(Math.round(viewportH * 0.78), minHeight, Math.min(760, viewportH - 24));
        return {
            ...base,
            x: Math.round((viewportW - width) / 2),
            y: Math.round((viewportH - height) / 2),
            width,
            height,
            minimized: false,
            maximized: false
        };
    }

    async function ensureFloatingManager(tab = "queue", forceVisible = true) {
        const requestedTab = ["queue", "downloads", "history"].includes(tab) ? tab : "queue";
        let frame = document.getElementById(FLOATING_IFRAME_ID);
        if (!frame) {
            frame = document.createElement("iframe");
            frame.id = FLOATING_IFRAME_ID;
            frame.src = chrome.runtime.getURL("floating-manager.html");
            frame.allow = "clipboard-write; clipboard-read";
            frame.style.transition = "box-shadow .18s ease";
            document.body.appendChild(frame);
        }
        const current = await getFloatingState();
        const lockSizeAfterReopen = current.lockSizeAfterReopen === true;
        const fitted = getAutoFitState(current);
        const baseGeometry = lockSizeAfterReopen && current.width && current.height ? current : fitted;
        const next = {
            ...baseGeometry,
            visible: forceVisible ? true : current.visible,
            activeTab: requestedTab || current.activeTab || "queue",
            lockSizeAfterReopen
        };
        await chrome.storage.local.set({ [FLOATING_STATE_KEY]: next });
        applyFloatingGeometry(frame, next);
        frame.onload = () => frame.contentWindow?.postMessage({ source: "autoMetaCopy", type: "FLOATING_STATE", state: next }, "*");
        frame.contentWindow?.postMessage({ source: "autoMetaCopy", type: "FLOATING_STATE", state: next }, "*");
        return frame;
    }

    let pointerSession = null;
    window.addEventListener("message", async (event) => {
        if (event.source !== iframe.contentWindow && event.source !== document.getElementById(FLOATING_IFRAME_ID)?.contentWindow) return;
        const msg = event.data || {};
        if (msg.source !== "autoMetaCopy") return;
        if (msg.type === "OPEN_FLOATING_MANAGER") {
            await ensureFloatingManager(msg.tab || "queue", true);
            return;
        }
        if (msg.type === "RETRY_UNDETECTED_PROMPT") {
            await chrome.storage.local.set({ autoMetaCopy_retryRequest: { at: Date.now(), source: "download-manager" } });
            return;
        }
        if (msg.type === "FLOATING_FIT_TO_SCREEN") {
            const frame = await ensureFloatingManager("queue", true);
            const state = await getFloatingState();
            const next = getAutoFitState({ ...state, visible: true, activeTab: state.activeTab || "queue", lockSizeAfterReopen: state.lockSizeAfterReopen === true });
            await chrome.storage.local.set({ [FLOATING_STATE_KEY]: next });
            applyFloatingGeometry(frame, next);
            frame.contentWindow?.postMessage({ source: "autoMetaCopy", type: "FLOATING_STATE", state: next }, "*");
            return;
        }
        const frame = document.getElementById(FLOATING_IFRAME_ID);
        if (!frame) return;
        const state = await getFloatingState();
        if (msg.type === "FLOATING_CLOSE") {
            await saveFloatingState({ visible: false });
            frame.style.display = "none";
            return;
        }
        if (msg.type === "FLOATING_MINIMIZE") {
            const minimized = !state.minimized;
            const next = { ...state, minimized, maximized: false, visible: true };
            await chrome.storage.local.set({ [FLOATING_STATE_KEY]: next });
            applyFloatingGeometry(frame, next);
            frame.contentWindow?.postMessage({ source: "autoMetaCopy", type: "FLOATING_STATE", state: next }, "*");
            return;
        }
        if (msg.type === "FLOATING_MAXIMIZE") {
            const maximized = !state.maximized;
            const next = { ...state, maximized, minimized: false, visible: true };
            await chrome.storage.local.set({ [FLOATING_STATE_KEY]: next });
            applyFloatingGeometry(frame, next);
            frame.contentWindow?.postMessage({ source: "autoMetaCopy", type: "FLOATING_STATE", state: next }, "*");
            return;
        }
        if (msg.type === "FLOATING_LOCK_SIZE") {
            const next = { ...state, lockSizeAfterReopen: !!msg.lockSizeAfterReopen, visible: true };
            await chrome.storage.local.set({ [FLOATING_STATE_KEY]: next });
            applyFloatingGeometry(frame, next);
            frame.contentWindow?.postMessage({ source: "autoMetaCopy", type: "FLOATING_STATE", state: next }, "*");
            return;
        }
        if (msg.type === "FLOATING_POINTER_START") {
            // iframe coords → page coords: add iframe's position on the page
            const iframeRect = frame.getBoundingClientRect();
            pointerSession = {
                action: msg.action,
                edge: msg.edge || "",
                startX: iframeRect.left + msg.clientX,
                startY: iframeRect.top + msg.clientY,
                startScreenX: Number(msg.screenX),
                startScreenY: Number(msg.screenY),
                startState: {
                    ...state,
                    x: Math.round(iframeRect.left),
                    y: Math.round(iframeRect.top),
                    width: Math.round(iframeRect.width),
                    height: Math.round(iframeRect.height)
                }
            };
            frame.style.pointerEvents = "none";
            return;
        }
        if (msg.type === "FLOATING_POINTER_MOVE") {
            updateFloatingPointer(Number(msg.screenX), Number(msg.screenY), null, null);
            return;
        }
        if (msg.type === "FLOATING_POINTER_END") {
            await finishPointerSession();
            return;
        }
    });


    let rafId = null;
    function updateFloatingPointer(screenX, screenY, clientX, clientY) {
        if (!pointerSession) return;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
            const frame = document.getElementById(FLOATING_IFRAME_ID);
            if (!frame) return;
            const useScreen = Number.isFinite(screenX) && Number.isFinite(screenY) && Number.isFinite(pointerSession.startScreenX) && Number.isFinite(pointerSession.startScreenY);
            const dx = useScreen ? screenX - pointerSession.startScreenX : Number(clientX) - pointerSession.startX;
            const dy = useScreen ? screenY - pointerSession.startScreenY : Number(clientY) - pointerSession.startY;
            const base = pointerSession.startState;
            // Preserve minimized state while dragging — only explicit toggle should change it
            let next = { ...base, visible: true, minimized: !!base.minimized, maximized: false };
            if (pointerSession.action === "drag") {
                const width = Math.min(Number(base.width) || 860, window.innerWidth - 16);
                const height = base.minimized ? 64 : Math.min(Number(base.height) || 640, window.innerHeight - 16);
                next.x = clamp((Number(base.x) || 80) + dx, 8, Math.max(8, window.innerWidth - width - 8));
                next.y = clamp((Number(base.y) || 80) + dy, 8, Math.max(8, window.innerHeight - height - 8));
            } else if (pointerSession.action === "resize") {
                const minWidth = Math.min(MIN_WIDTH, Math.max(300, window.innerWidth - 24));
                const minHeight = Math.min(MIN_HEIGHT, Math.max(260, window.innerHeight - 24));
                const baseX = Number(base.x) || 80;
                const baseY = Number(base.y) || 80;
                const baseW = Number(base.width) || 860;
                const baseH = Number(base.height) || 640;
                if (pointerSession.edge.includes("right")) {
                    next.width = clamp(baseW + dx, minWidth, Math.max(minWidth, window.innerWidth - baseX - 8));
                }
                if (pointerSession.edge.includes("bottom")) {
                    next.height = clamp(baseH + dy, minHeight, Math.max(minHeight, window.innerHeight - baseY - 8));
                }
                if (pointerSession.edge.includes("left")) {
                    const maxX = baseX + baseW - minWidth;
                    next.x = clamp(baseX + dx, 8, Math.max(8, maxX));
                    next.width = clamp(baseW + (baseX - next.x), minWidth, Math.max(minWidth, baseX + baseW - 8));
                }
                if (pointerSession.edge.includes("top")) {
                    const maxY = baseY + baseH - minHeight;
                    next.y = clamp(baseY + dy, 8, Math.max(8, maxY));
                    next.height = clamp(baseH + (baseY - next.y), minHeight, Math.max(minHeight, baseY + baseH - 8));
                }
            }
            applyFloatingGeometry(frame, next);
        });
    }

    window.addEventListener("pointermove", (event) => {
        updateFloatingPointer(event.screenX, event.screenY, event.clientX, event.clientY);
    });

    async function finishPointerSession() {
        if (!pointerSession) return;
        const frame = document.getElementById(FLOATING_IFRAME_ID);
        if (frame) {
            frame.style.pointerEvents = "auto";
            const rect = frame.getBoundingClientRect();
            await saveFloatingState({
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                minimized: rect.height <= 80 ? true : false,
                maximized: false,
                visible: frame.style.display !== "none"
            });
        }
        pointerSession = null;
    }

    window.addEventListener("pointerup", finishPointerSession);
    window.addEventListener("pointercancel", finishPointerSession);
    window.addEventListener("blur", finishPointerSession);

    window.addEventListener("resize", async () => {
        const frame = document.getElementById(FLOATING_IFRAME_ID);
        if (frame) applyFloatingGeometry(frame, await getFloatingState());
    });

    chrome.storage.local.get("autoMetaCopy_downloadSession", async (data) => {
        if (data.autoMetaCopy_downloadSession?.active) await ensureFloatingManager((await getFloatingState()).activeTab || "queue", false);
    });

})();
