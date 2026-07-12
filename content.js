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
      // Resolve with the full result so the caller can pick the toast text.
      resolve({ ok: msg.ok, action: msg.action || (msg.ok ? "queued" : "none") });
    }
  });

  function requestAction(rendererEl) {
    return new Promise((resolve) => {
      // Deterministic token (avoids Math.random / Date.now); unique per page load.
      const token = "mcq-" + (++tokenCounterSeed);
      pending.set(token, resolve);
      rendererEl.setAttribute("data-mcq-target", token);
      window.postMessage({ source: "mcq", type: "add-to-queue", token }, "*");
      // Safety timeout so a lost message doesn't leak the pending entry.
      setTimeout(() => {
        if (pending.has(token)) { pending.delete(token); resolve({ ok: false, action: "none" }); }
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
    "ytd-playlist-panel-video-renderer",   // sidebar mix/queue panel items
    "ytd-reel-item-renderer",
    "yt-lockup-view-model",
    "ytd-rich-grid-media",
  ].join(",");

  function findRenderer(el) {
    return el && el.closest ? el.closest(VIDEO_RENDERERS) : null;
  }

  /**
   * Resolve the element to act on for a middle-click, most-specific first:
   *   1. a known video renderer (its .data usually carries the queue command)
   *   2. the hover-preview player overlay -- it mounts at the app level, OUTSIDE
   *      the card renderer, so thumbnail clicks land here, not on the card
   *   3. ANY watch/shorts link -- works on arbitrary surfaces (channel pages,
   *      endscreens, description links, ...); the injected side synthesizes the
   *      queue command from the link's videoId when no data command exists
   */
  function findActionTarget(el) {
    if (!el || !el.closest) return null;
    return (
      findRenderer(el) ||
      el.closest("ytd-video-preview, #video-preview") ||
      el.closest("a[href*='/watch?'], a[href*='/shorts/'], a#thumbnail")
    );
  }

  // ---- Middle-click interception -------------------------------------------

  let busy = false;

  async function handle(targetEl) {
    if (busy) return;
    if (!targetEl) { log("handle called with no target"); return; }
    log("acting on:", targetEl.tagName, targetEl.id || "");
    busy = true;
    try {
      const { ok, action } = await requestAction(targetEl);
      if (ok) showToast(action === "playing" ? "Playing" : "Added to queue");
      else log("action reported failure");
    } finally {
      busy = false;
    }
  }

  // The action target captured at mousedown. YouTube can swap the DOM under the
  // cursor between mousedown and auxclick, so we resolve early and reuse it.
  let armedTarget = null;

  function onPointer(e) {
    if (!enabled) return;
    if (e.button !== 1) return;                // middle button only

    const actionTarget = findActionTarget(e.target);
    if (!actionTarget && !armedTarget) return; // not a video -- let it through

    // Suppress the new-tab open as early as possible, in capture phase, for
    // every phase of the middle click.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (e.type === "mousedown") {
      armedTarget = actionTarget;
      return;
    }

    // On the up/aux phase, act using the element captured at mousedown
    // (falling back to a fresh lookup if we somehow didn't arm one).
    if (e.type === "auxclick" || e.type === "mouseup") {
      const target = armedTarget || actionTarget;
      armedTarget = null;
      if (target) handle(target);
      else log("no action target at action time");
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
