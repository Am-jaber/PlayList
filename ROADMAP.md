# Roadmap / Future Features

Ideas for future versions, ordered by value-vs-effort. Each entry notes **what**,
**why it's cheap or not**, and **which files to touch** so you can pick it up cold
later. See [ARCHITECTURE.md](ARCHITECTURE.md) for how the command dispatch works —
most of these are "find a different command in `.data` and dispatch it."

---

## Done

- **Add to queue on home / search / channel** — reads the item's `.data` and
  dispatches its `addToPlaylistCommand`.
- **Watch-page sidebar recommendations** — those lockups carry *no* command in
  their data, so we **synthesize** the queue command from the videoId in the
  link (see `synthesizeQueueCommand` in `injected.js`).
- **Watch-page mix/radio panel** — items are already queued (no add-to-queue
  action), so middle-click **jumps to & plays** that video via its
  `watchEndpoint`.
- **CI** — `.github/workflows/build.yml` packages the zip on push, guards against
  un-bumped versions, and attaches the zip to a Release on `v*` tags.

---

## Tier 1 — High value, low effort (do these next)

### 1. "Play next" vs "Add to end of queue"
- **What:** middle-click adds to the *end* (current behavior). Add
  Shift+middle-click → insert at *front* / play next.
- **Why cheap:** same dispatch path, just a different command variant. It's still
  a `PLAYLIST_EDIT_LIST_TYPE_QUEUE` action — need to confirm the "insert next"
  flavor live (console-dump a video, look for a second queue command or an
  insert-position field).
- **Files:** `content.js` (read `e.shiftKey`, pass an action hint over the
  bridge), `injected.js` (select which command to dispatch).
- **TODO before building:** verify the exact "play next" command shape in the
  console — it wasn't captured in the original data dump.

### 2. Watch Later on a modifier key
- **What:** Ctrl+middle-click → Save to Watch Later.
- **Why cheap:** the command is **already in the data we dumped**:
  ```json
  "playlistEditEndpoint": {
    "playlistId": "WL",
    "actions": [{ "addedVideoId": "<id>", "action": "ACTION_ADD_VIDEO" }]
  }
  ```
  And for surfaces with empty data, synthesize it from the videoId (same trick as
  the sidebar queue command).
- **Files:** `injected.js` (add `findWatchLaterCommand` + a synth fallback),
  `content.js` (read `e.ctrlKey`, send action hint).

### 3. Resilience fallback (menu-click) — for longevity
- **What:** if no command can be found *or synthesized*, fall back to opening the
  ⋮ menu and clicking the first item.
- **Why it matters:** the extension rests on `ytd-app.resolveCommand` and current
  data shapes. When YouTube changes layout (they will), it breaks **silently**. A
  fallback degrades gracefully. (The synthesize path already covers the biggest
  gap — empty-data surfaces — so this is now lower priority than before.)
- **Files:** `injected.js` (fallback branch in `performAction` when nothing is
  found), possibly `content.js` for menu interaction.

---

## Tier 2 — Nice, moderate effort

### 4. Per-surface toggles
- **What:** enable/disable independently on home, search, and the watch-page
  sidebar.
- **Files:** `popup.html` / `popup.js` (checkboxes → `chrome.storage`),
  `content.js` (`looksLikeVideo` / `onPointer` read the flags, detect surface via
  `location.pathname`).

### 5. Undo
- **What:** toast shows "Added — Undo"; clicking it removes the video from queue.
- **Why feasible:** the remove command exists in the data
  (`ACTION_REMOVE_VIDEO_BY_VIDEO_ID`). We already have the videoId when queueing.
- **Files:** `content.js` (interactive toast), `injected.js` (remove-from-queue
  dispatch), bridge carries the videoId back.

### 6. Confirmation polish
- **What:** running counter in the toast ("3 added"), or a subtle click sound.
- **Files:** `content.js` (toast logic only). Pure cosmetics.

---

## Tier 3 — Only with a concrete reason

### 7. Firefox port
- ~90% portable. `chrome.*` → `browser.*` (or a polyfill), manifest tweaks for
  `web_accessible_resources`. Only worth it if you want FF users.

### 8. Playlist page / bulk add
- Middle-click a playlist row → queue every video. Niche; more DOM-shape work.

### 9. Configurable trigger gesture
- Let users pick middle-click vs Alt+click etc. Config surface for marginal gain.

---

## Explicitly NOT doing (decided during v1)

- **Own queue UI** — we deliberately use YouTube's *real* queue via its native
  command. Do not build a parallel queue; it was considered and rejected.
- **Accounts / cloud sync / server component** — out of scope for what this is.

---

## Suggested next version (v1.2)

Bundle **#1 + #2**: modifier keys turn one gesture into three actions
(add-to-end / play-next / watch-later), reusing the command + synthesize
patterns already proven. Then **#3** (menu fallback) if you want extra
resilience against YouTube redesigns.

**Before starting:** re-dump a video's `.data` in the console (YouTube shapes
drift) and confirm the play-next command variant (#1).
