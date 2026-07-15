/*
 * injected.js  -- runs in the PAGE's main world (not the isolated content-script
 * world), so it can read each renderer's Polymer `.data` and dispatch YouTube's
 * own actions.
 *
 * Protocol (via window.postMessage):
 *   content.js  --> { source: "mcq", type: "add-to-queue", token }
 *   injected.js --> { source: "mcq-page", type: "result", token, ok, action }
 *
 * The clicked element is located by a temporary attribute the content script
 * stamps on it (data-mcq-target).
 *
 * -------------------------------------------------------------------------
 * KEY MECHANISM: the `yt-add-to-playlist-command` action (see ARCHITECTURE.md)
 * -------------------------------------------------------------------------
 * YouTube's real "Add to queue" does NOT go through ytd-app.resolveCommand.
 * resolveCommand(addToPlaylistCommand) only works when a queue already exists;
 * it silently no-ops from an EMPTY queue. What YouTube's own menu/hover button
 * fires is a DOM `yt-action` event named "yt-add-to-playlist-command", called
 * with THREE args:
 *     arg0 = { clickTrackingParams, addToPlaylistCommand }
 *     arg1 = the source Element
 *     arg2 = { sourceData: { signalServiceEndpoint: { actions: [arg0] } } }
 * Replaying that exact 3-arg event works from any queue state (empty or not),
 * for any surface, because it invokes YouTube's genuine handler. We build these
 * args from just a videoId. This replaced a long line of dead ends
 * (resolveCommand-from-empty, synthesized commands, play-to-seed, SHOW_MINIPLAYER).
 */

(() => {
  "use strict";

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

  const DEBUG = (() => {
    try { return localStorage.getItem("mcq_debug") === "1"; } catch { return false; }
  })();
  const log = (...a) => { if (DEBUG) console.log("[MCQ/page]", ...a); };

  function getData(el) {
    return el && (el.data || el.__data?.data || el.polymerController?.data || el.inst?.data);
  }

  let appEl = null;
  function getApp() {
    if (appEl && appEl.isConnected) return appEl;
    appEl = document.querySelector("ytd-app");
    return appEl;
  }

  // ---- videoId resolution ---------------------------------------------------

  /** Extract a videoId from an element via its watch/shorts link. */
  function findVideoId(el) {
    const SEL = "a[href*='/watch?'], a[href*='/shorts/']";
    const a = el.matches?.(SEL) ? el : (el.querySelector?.(SEL) || el.closest?.(SEL));
    if (!a) return null;
    try {
      const url = new URL(a.href, location.origin);
      return url.searchParams.get("v") ||
             (url.pathname.match(/^\/shorts\/([\w-]+)/) || [])[1] || null;
    } catch { return null; }
  }

  /**
   * Deep-search a data model for an existing addToPlaylistCommand (queue) and
   * return its videoId. Preferred over the link when available because it's the
   * exact video YouTube associates with this item.
   */
  function queueVideoIdFromData(root) {
    const stack = [root], seen = new Set();
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== "object" || seen.has(n)) continue;
      seen.add(n);
      const apc = n.addToPlaylistCommand;
      if (apc && apc.listType === "PLAYLIST_EDIT_LIST_TYPE_QUEUE" && apc.videoId) {
        return apc.videoId;
      }
      for (const k in n) if (n[k] && typeof n[k] === "object") stack.push(n[k]);
    }
    return null;
  }

  /** Resolve the videoId for the clicked target, climbing renderers. */
  function resolveVideoId(targetEl) {
    let el = targetEl && targetEl.closest ? targetEl.closest(VIDEO_RENDERERS) : null;
    let hops = 0;
    while (el && hops < 6) {
      const data = getData(el);
      const vid = data && queueVideoIdFromData(data);
      if (vid) return vid;
      el = el.parentElement ? el.parentElement.closest(VIDEO_RENDERERS) : null;
      hops++;
    }
    return findVideoId(targetEl);
  }

  // ---- The queue action -----------------------------------------------------

  /** Build the addToPlaylistCommand payload for a videoId. */
  function buildAddToPlaylistCommand(videoId) {
    return {
      openMiniplayer: true,
      videoId,
      listType: "PLAYLIST_EDIT_LIST_TYPE_QUEUE",
      onCreateListCommand: {
        commandMetadata: { webCommandMetadata: { sendPost: true, apiUrl: "/youtubei/v1/playlist/create" } },
        createPlaylistServiceEndpoint: { videoIds: [videoId], params: "CAQ%3D" },
      },
      videoIds: [videoId],
      videoCommand: {
        commandMetadata: { webCommandMetadata: { url: "/watch?v=" + videoId, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } },
        watchEndpoint: { videoId },
      },
    };
  }

  /**
   * Add a video to the queue by replaying YouTube's real 3-arg
   * `yt-add-to-playlist-command` action. Works from any queue state.
   */
  function addToQueue(videoId, sourceEl) {
    const addToPlaylistCommand = buildAddToPlaylistCommand(videoId);
    const arg0 = { addToPlaylistCommand };
    const arg1 = sourceEl || getApp();
    const arg2 = {
      sourceData: {
        commandMetadata: { webCommandMetadata: { sendPost: true } },
        signalServiceEndpoint: { signal: "CLIENT_SIGNAL", actions: [arg0] },
      },
    };
    (sourceEl || getApp() || document.body).dispatchEvent(
      new CustomEvent("yt-action", {
        detail: { actionName: "yt-add-to-playlist-command", args: [arg0, arg1, arg2], returnValue: [] },
        bubbles: true, composed: true,
      })
    );
    log("fired yt-add-to-playlist-command for", videoId);
    return true;
  }

  // ---- Jump-to-video (mix/queue panel items, already queued) ---------------

  /** Deep-search for a watchEndpoint; prefer one tied to the current playlist. */
  function findWatchCommand(root) {
    const stack = [root], seen = new Set();
    let fallback = null;
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== "object" || seen.has(n)) continue;
      seen.add(n);
      const we = n.watchEndpoint;
      if (we && we.videoId) {
        const cmd = {
          clickTrackingParams: n.clickTrackingParams,
          commandMetadata: { webCommandMetadata: { webPageType: "WEB_PAGE_TYPE_WATCH" } },
          watchEndpoint: we,
        };
        if (we.playlistId || we.index != null) return cmd;
        if (!fallback) fallback = cmd;
      }
      for (const k in n) if (n[k] && typeof n[k] === "object") stack.push(n[k]);
    }
    return fallback;
  }

  function dispatchWatch(command, sourceEl) {
    const app = getApp();
    if (app && typeof app.resolveCommand === "function") {
      app.resolveCommand(command, { sourceElement: sourceEl || app });
      return true;
    }
    return false;
  }

  /** Is the clicked item inside an active mix/queue panel (already queued)? */
  function isQueuePanelItem(targetEl) {
    return !!(targetEl && targetEl.closest &&
      targetEl.closest("ytd-playlist-panel-video-renderer"));
  }

  // ---- Decide + perform -----------------------------------------------------

  /**
   * 1. Item is in the active mix/queue panel -> jump to & play it in place.
   * 2. Otherwise -> add to queue (works from empty via the real action).
   */
  function performAction(targetEl) {
    // 1) Mix/queue panel item: play it in place rather than re-adding.
    if (isQueuePanelItem(targetEl)) {
      const renderer = targetEl.closest("ytd-playlist-panel-video-renderer");
      const data = getData(renderer);
      const watchCmd = data && findWatchCommand(data);
      if (watchCmd) {
        dispatchWatch(watchCmd, renderer);
        log("mix-panel item -> playing:", watchCmd.watchEndpoint?.videoId);
        return { action: "playing" };
      }
    }

    // 2) Everything else: add to queue.
    const videoId = resolveVideoId(targetEl);
    if (videoId) {
      const sourceEl = (targetEl.closest && targetEl.closest(VIDEO_RENDERERS)) || getApp();
      addToQueue(videoId, sourceEl);
      return { action: "queued" };
    }

    log("no videoId resolved for target");
    return { action: "none" };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "mcq" || msg.type !== "add-to-queue") return;

    const targetEl = document.querySelector("[data-mcq-target]");
    let result = { action: "none" };
    try {
      result = performAction(targetEl);
    } catch (e) {
      log("error:", e);
    } finally {
      if (targetEl) targetEl.removeAttribute("data-mcq-target");
    }

    window.postMessage({
      source: "mcq-page", type: "result", token: msg.token,
      ok: result.action !== "none", action: result.action,
    }, "*");
  });

  log("injected main-world dispatcher ready");
})();
