/*
 * content.js  -- runs in the isolated content-script world.
 *
 * Responsibilities:
 *   1. Inject injected.js into the PAGE's main world (only there can we read a
 *      renderer's Polymer `.data` and call ytd-app.resolveCommand).
 *   2. Intercept the middle-mouse button on video items and suppress the
 *      default open-in-new-tab.
 *   3. Stamp the clicked renderer with data-mcq-target and ask the injected
 *      script to run YouTube's native "Add to queue" command for it.
 *
 * Why split worlds: content scripts cannot access page-object JS properties
 * (element.data) or the app's methods (resolveCommand). postMessage bridges the
 * two worlds; the shared DOM (the stamped attribute) identifies the target.
 */

(() => {
  "use strict";

  const DEBUG = (() => {
    try { return localStorage.getItem("mcq_debug") === "1"; } catch { return false; }
  })();
  const log = (...a) => { if (DEBUG) console.log("[MCQ]", ...a); };

  // ---- Enabled toggle -------------------------------------------------------

  let enabled = true;
  try {
    chrome.storage.sync.get({ enabled: true }, ({ enabled: e }) => { enabled = e; });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "sync" && c.enabled) enabled = c.enabled.newValue;
    });
  } catch { /* storage unavailable; stay enabled */ }

  // ---- Inject the main-world script ----------------------------------------

  function injectPageScript() {
    try {
      const s = document.createElement("script");
      s.src = chrome.runtime.getURL("injected.js");
      s.onload = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
      log("injected.js added");
    } catch (e) {
      log("failed to inject:", e);
    }
  }
  injectPageScript();

  // ---- Bridge: request add-to-queue, await result ---------------------------

  let tokenCounterSeed = 0;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "mcq-page" || msg.type !== "result") return;
    const resolve = pending.get(msg.token);
    if (resolve) {
      pending.delete(msg.token);
      resolve(msg.ok);
    }
  });

  function requestAddToQueue(rendererEl) {
    return new Promise((resolve) => {
      // Deterministic token (avoids Math.random / Date.now); unique per page load.
      const token = "mcq-" + (++tokenCounterSeed);
      pending.set(token, resolve);
      rendererEl.setAttribute("data-mcq-target", token);
      window.postMessage({ source: "mcq", type: "add-to-queue", token }, "*");
      // Safety timeout so a lost message doesn't leak the pending entry.
      setTimeout(() => {
        if (pending.has(token)) { pending.delete(token); resolve(false); }
      }, 1500);
    });
  }

  // ---- Target detection -----------------------------------------------------

  const VIDEO_RENDERERS = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-reel-item-renderer",
    "yt-lockup-view-model",
    "ytd-rich-grid-media",
  ].join(",");

  function findRenderer(el) {
    return el && el.closest ? el.closest(VIDEO_RENDERERS) : null;
  }

  function looksLikeVideo(el) {
    if (!el || !el.closest) return false;
    return !!(
      el.closest("a[href*='/watch?'], a[href*='/shorts/'], a#thumbnail") ||
      findRenderer(el)
    );
  }

  // ---- Middle-click interception -------------------------------------------

  let busy = false;

  async function handle(target) {
    if (busy) return;
    const renderer = findRenderer(target);
    if (!renderer) { log("no renderer for target"); return; }
    busy = true;
    try {
      const ok = await requestAddToQueue(renderer);
      if (ok) showToast("Added to queue");
      else log("add-to-queue reported failure");
    } finally {
      busy = false;
    }
  }

  function onPointer(e) {
    if (!enabled) return;
    if (e.button !== 1) return;                // middle button only
    if (!looksLikeVideo(e.target)) return;

    // Suppress the new-tab open as early as possible, in capture phase.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Perform the action once, on the up/aux phase.
    if (e.type === "auxclick" || e.type === "mouseup") {
      handle(e.target);
    }
  }

  document.addEventListener("mousedown", onPointer, true);
  document.addEventListener("mouseup", onPointer, true);
  document.addEventListener("auxclick", onPointer, true);

  // ---- Toast ----------------------------------------------------------------

  let toastEl = null, toastTimer = null;
  function showToast(text) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      Object.assign(toastEl.style, {
        position: "fixed", bottom: "24px", left: "50%",
        transform: "translateX(-50%) translateY(20px)",
        background: "rgba(33,33,33,0.95)", color: "#fff",
        padding: "10px 18px", borderRadius: "8px",
        fontFamily: "Roboto, Arial, sans-serif", fontSize: "14px",
        zIndex: "2147483647", opacity: "0",
        transition: "opacity .18s ease, transform .18s ease",
        pointerEvents: "none", boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
      });
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    requestAnimationFrame(() => {
      toastEl.style.opacity = "1";
      toastEl.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.style.opacity = "0";
      toastEl.style.transform = "translateX(-50%) translateY(20px)";
    }, 1400);
  }

  log("Middle-Click Add to Queue (content bridge) loaded");
})();
