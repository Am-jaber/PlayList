/*
 * injected.js  -- runs in the PAGE's main world (not the isolated content-script
 * world), so it can read each renderer's Polymer `.data` and call YouTube's own
 * `ytd-app.resolveCommand(...)`.
 *
 * Protocol (via window.postMessage):
 *   content.js  --> { source: "mcq", type: "add-to-queue", token }
 *   injected.js --> { source: "mcq-page", type: "result", token, ok }
 *
 * The clicked renderer is located by a temporary attribute the content script
 * stamps on it (data-mcq-target) right before sending the message. Reading
 * `.data` and dispatching must happen here because those live in the main world.
 */

(() => {
  "use strict";

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

  const DEBUG = (() => {
    try { return localStorage.getItem("mcq_debug") === "1"; } catch { return false; }
  })();
  const log = (...a) => { if (DEBUG) console.log("[MCQ/page]", ...a); };

  function getData(el) {
    return el && (el.data || el.__data?.data || el.polymerController?.data || el.inst?.data);
  }

  /*
   * KEY IDEA: command data, not event handlers. See ARCHITECTURE.md.
   *
   * YouTube does NOT attach a per-button handler like onAddToQueue(). Every
   * clickable element carries a "command" object (an innertube command) in its
   * `.data`, and one generic dispatcher (ytd-app.resolveCommand) executes any
   * such command. So instead of tracing Polymer event plumbing for "the
   * handler" (a dead end), we read the element's data and pull the command out.
   *
   * The queue action is an `addToPlaylistCommand` whose
   * `listType === "PLAYLIST_EDIT_LIST_TYPE_QUEUE"`. That object IS the action;
   * clicking the menu item just passes it to the dispatcher. We wrap it back
   * into a signalServiceEndpoint command (the shape the menu item dispatches)
   * and hand it to resolveCommand below.
   */

  /** Deep-search a data model for the Add-to-queue innertube command. */
  function findQueueCommand(root) {
    const stack = [root], seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);

      const apc = node.addToPlaylistCommand;
      if (apc && apc.listType === "PLAYLIST_EDIT_LIST_TYPE_QUEUE") {
        // `node` is the action item { clickTrackingParams, addToPlaylistCommand }.
        return {
          clickTrackingParams: node.clickTrackingParams,
          commandMetadata: { webCommandMetadata: { sendPost: true } },
          signalServiceEndpoint: { signal: "CLIENT_SIGNAL", actions: [node] },
        };
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return null;
  }

  let appEl = null;
  function getApp() {
    if (appEl && appEl.isConnected) return appEl;
    appEl = document.querySelector("ytd-app");
    return appEl;
  }

  function dispatch(command, sourceEl) {
    const app = getApp();
    if (app && typeof app.resolveCommand === "function") {
      app.resolveCommand(command, { sourceElement: sourceEl || app });
      log("dispatched via resolveCommand");
      return true;
    }
    // Fallback: fire the event the app binds to.
    (sourceEl || app || document.body).dispatchEvent(
      new CustomEvent("yt-action", {
        detail: {
          actionName: "yt-service-request",
          args: [sourceEl || app, command],
          returnValue: [],
          optionalAction: false,
        },
        bubbles: true, composed: true,
      })
    );
    log("dispatched via yt-action event");
    return true;
  }

  /** Given the stamped target element, climb renderers until one yields a
   *  queue command, then dispatch it. */
  function addToQueue(targetEl) {
    let el = targetEl && targetEl.closest ? targetEl.closest(VIDEO_RENDERERS) : null;
    let hops = 0;
    while (el && hops < 5) {
      const data = getData(el);
      const command = data && findQueueCommand(data);
      if (command) return dispatch(command, el);
      el = el.parentElement ? el.parentElement.closest(VIDEO_RENDERERS) : null;
      hops++;
    }
    log("no queue command found");
    return false;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "mcq" || msg.type !== "add-to-queue") return;

    const targetEl = document.querySelector("[data-mcq-target]");
    let ok = false;
    try {
      ok = addToQueue(targetEl);
    } catch (e) {
      log("error:", e);
    } finally {
      if (targetEl) targetEl.removeAttribute("data-mcq-target");
    }

    window.postMessage({ source: "mcq-page", type: "result", token: msg.token, ok }, "*");
  });

  log("injected main-world dispatcher ready");
})();
