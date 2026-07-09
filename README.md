# Middle-Click Add to Queue

A Chrome/Edge extension: **middle-click a YouTube video to add it to the queue** instead of opening it in a new tab.

It triggers YouTube's own native **"Add to queue"** action (the first item in a video's ⋮ menu), so the video plays through YouTube's built-in queue.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this folder: `PlayList`.
5. Go to YouTube and **middle-click** any video thumbnail or title.

You'll see a small "Added to queue" toast at the bottom of the page.

## Usage

- **Middle-click** (press the mouse wheel) on any video's thumbnail or title on a
  YouTube listing page — home, search, channel, and the watch-page sidebar.
- The video is added to your queue instead of opening a new tab.
- **Watch-page sidebar behavior:**
  - Normal recommendations → **added to queue**.
  - Items in an active **mix / radio panel** (already queued) → **jump to & play**
    that video in the current queue.
- Click the extension icon to toggle it on/off.

## How it works

It calls YouTube's own **"Add to queue"** command directly — no menu is opened.

- `content.js` (isolated world) captures the middle-mouse button before the
  browser opens a new tab, stamps the clicked video element, and asks the page
  script to run the command.
- `injected.js` (page main world) picks an action for the clicked item, in order:
  1. **Add to queue** — read the item's Polymer `.data` for an
     `addToPlaylistCommand` with `listType: PLAYLIST_EDIT_LIST_TYPE_QUEUE`
     (home/search).
  2. **Jump to video** — a `watchEndpoint`, for mix/radio panel items that are
     already queued.
  3. **Synthesized add-to-queue** — sidebar recommendations render as pure
     view-models with *no* command in their data, so we build the queue command
     ourselves from the videoId in the item's link.
  It then hands the command to `ytd-app.resolveCommand(...)` — the same dispatcher
  YouTube's own UI uses.

The two worlds talk over `window.postMessage`; the target element is identified
by a temporary `data-mcq-target` attribute on the shared DOM. It doesn't depend
on menu text or UI, so it's language-independent. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the full "command data, not handlers"
technique and [ROADMAP.md](ROADMAP.md) for planned features.

## Troubleshooting

If a middle-click doesn't add to the queue, enable debug logging in the YouTube
tab's DevTools console:

```js
localStorage.setItem("mcq_debug", "1");
```

Reload the page and middle-click again — `[MCQ]` (content side) and `[MCQ/page]`
(page side) logs will show which step failed (no renderer, no queue command
found, dispatch path). Turn it off with:

```js
localStorage.removeItem("mcq_debug");
```

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension manifest (MV3) |
| `content.js` | Isolated-world: intercept middle-click, bridge to the page |
| `injected.js` | Page main-world: pick and dispatch the YouTube command |
| `popup.html` / `popup.js` | On/off toggle UI |
| `icons/` | Extension icons |
