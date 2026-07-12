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

  /**
   * Deep-search for a plain watch command (watchEndpoint). Used for the sidebar
   * mix/queue panel, whose items are ALREADY in the active queue and therefore
   * carry no addToPlaylistCommand -- middle-clicking them should jump to / play
   * that video within the current queue instead of adding it.
   *
   * We prefer a watchEndpoint that references the current playlist (has a
   * `playlistId` / `index`) so the video plays *in place* in the queue rather
   * than starting a fresh single-video watch.
   */
  function findWatchCommand(root) {
    const stack = [root], seen = new Set();
    let fallback = null;
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);

      const we = node.watchEndpoint;
      if (we && we.videoId) {
        const cmd = {
          clickTrackingParams: node.clickTrackingParams,
          commandMetadata: {
            webCommandMetadata: {
              webPageType: "WEB_PAGE_TYPE_WATCH",
            },
          },
          watchEndpoint: we,
        };
        // Prefer one that stays within the current playlist/queue.
        if (we.playlistId || we.index != null) return cmd;
        if (!fallback) fallback = cmd;
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return fallback;
  }

  /**
   * Extract a videoId from an element by looking at its watch links.
   * Used for surfaces (e.g. sidebar recommendations) whose `.data` carries no
   * command at all -- we build the queue command ourselves from the id.
   */
  function findVideoId(el) {
    const SEL = "a[href*='/watch?'], a[href*='/shorts/']";
    const a = el.matches?.(SEL)
      ? el
      : el.querySelector?.(SEL) || el.closest?.(SEL);
    if (!a) return null;
    try {
      const url = new URL(a.href, location.origin);
      // /watch?v=ID -- id in the query; /shorts/ID -- id in the path.
      return url.searchParams.get("v") ||
             (url.pathname.match(/^\/shorts\/([\w-]+)/) || [])[1] ||
             null;
    } catch {
      return null;
    }
  }

  /**
   * Build an Add-to-queue command from scratch given only a videoId. This is the
   * fallback for elements that render as pure view-models with no command in
   * their data (notably watch-page sidebar recommendations). The shape mirrors
   * the real command YouTube attaches elsewhere; only the videoId varies.
   */
  function synthesizeQueueCommand(videoId) {
    return {
      commandMetadata: { webCommandMetadata: { sendPost: true } },
      signalServiceEndpoint: {
        signal: "CLIENT_SIGNAL",
        actions: [{
          addToPlaylistCommand: {
            openMiniplayer: true,
            videoId,
            listType: "PLAYLIST_EDIT_LIST_TYPE_QUEUE",
            onCreateListCommand: {
              commandMetadata: {
                webCommandMetadata: { sendPost: true, apiUrl: "/youtubei/v1/playlist/create" },
              },
              createPlaylistServiceEndpoint: { videoIds: [videoId], params: "CAQ%3D" },
            },
            videoIds: [videoId],
          },
        }],
      },
    };
  }

  /**
   * Climb ancestor renderers from `el` looking for a real queue command.
   * closest() alone is not enough: the innermost renderer (e.g.
   * yt-lockup-view-model) often has empty data while the command lives on an
   * outer one (e.g. ytd-rich-item-renderer).
   */
  function findQueueCommandNear(el) {
    let r = el && el.closest ? el.closest(VIDEO_RENDERERS) : null;
    let hops = 0;
    while (r && hops < 6) {
      const data = getData(r);
      const cmd = data && findQueueCommand(data);
      if (cmd) return { cmd, el: r };
      r = r.parentElement ? r.parentElement.closest(VIDEO_RENDERERS) : null;
      hops++;
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

  /**
   * Given the stamped target element, climb renderers looking for an action to
   * perform. Preference order:
   *   1. Add to queue  (normal videos: home, search, recommendations)
   *   2. Jump to video (sidebar mix/queue panel: already-queued items)
   *
   * Returns { action } describing what happened, or { action: "none" }.
   */
  function performAction(targetEl) {
    let el = targetEl && targetEl.closest ? targetEl.closest(VIDEO_RENDERERS) : null;
    let hops = 0;
    while (el && hops < 6) {
      const data = getData(el);
      if (data) {
        // 1) Prefer add-to-queue when the item's data offers it (home/search).
        const queueCmd = findQueueCommand(data);
        if (queueCmd) {
          dispatch(queueCmd, el);
          return { action: "queued" };
        }
        // 2) Otherwise (e.g. playlist/mix panel), jump to the video in-queue.
        const watchCmd = findWatchCommand(data);
        if (watchCmd) {
          dispatch(watchCmd, el);
          return { action: "playing" };
        }
      }
      el = el.parentElement ? el.parentElement.closest(VIDEO_RENDERERS) : null;
      hops++;
    }

    // 3) Fallback: element carried no usable command (hover-preview overlay,
    //    bare links, surfaces whose view-model data is empty). Resolve the
    //    videoId from the nearest link, then:
    //    3a) prefer the REAL command from another renderer of the same video
    //        elsewhere in the DOM (the hover preview always overlays a card
    //        that exists on the page) -- the genuine command carries the full
    //        context that makes YouTube's queue UI update immediately;
    //    3b) only synthesize from scratch when no such renderer exists.
    const videoId = findVideoId(targetEl);
    if (videoId) {
      for (const a of document.querySelectorAll(`a[href*="${videoId}"]`)) {
        const hit = findQueueCommandNear(a);   // climbs ancestor renderers
        if (hit) {
          dispatch(hit.cmd, hit.el);
          log("queued via matched renderer command:", videoId);
          return { action: "queued" };
        }
      }
      dispatch(synthesizeQueueCommand(videoId), getApp());
      log("queued via synthesized command:", videoId);
      return { action: "queued" };
    }

    log("no actionable command found");
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
