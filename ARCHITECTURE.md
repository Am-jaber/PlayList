# Architecture & Reverse-Engineering Notes

This documents *how* the extension triggers YouTube's native "Add to queue", and
— more usefully — the general technique for driving any Polymer / innertube-based
site. If you ever need to add another action (Watch Later, Save to playlist,
etc.), start here.

---

## The key insight: it's data, not handlers

The instinct when reverse-engineering a button is to find **the event handler** —
the JS function that runs on click. On YouTube this is a dead end, and chasing it
is how you end up lost in Polymer's `on-tap` → `__dataHost` → `_evaluateBinding`
plumbing.

YouTube does **not** wire buttons to named functions like `onAddToQueue()`.
Instead:

1. Every clickable element carries a **data object** — an "innertube command" —
   describing *what* to do (not *how*).
2. There is **one generic dispatcher** that interprets any command.

So a click effectively does just:

```js
resolveCommand(thisElementsCommandData)
```

There is no per-button handler to find. The handler is generic and boring.
**The interesting part is the data.** Reframe the question from
"what function runs?" to **"what data does the element carry?"**

---

## Where the data lives

YouTube attaches the entire command tree to the custom element as a plain JS
property. Read it directly:

```js
const el = document.querySelector("yt-lockup-view-model, ytd-rich-item-renderer");
el.data            // <- the whole view model
// fallbacks seen across builds:
el.__data?.data
el.polymerController?.data
el.inst?.data
```

Buried in that view model, the queue action looks like:

```json
"addToPlaylistCommand": {
  "videoId": "iVaHEpnT1aQ",
  "listType": "PLAYLIST_EDIT_LIST_TYPE_QUEUE",
  "openMiniplayer": true
}
```

The `listType: "..._QUEUE"` is the smoking gun. **That object *is* the action.**
Clicking the menu item does nothing more than pass this to the dispatcher.

> Note: the command appears in more than one place in the data (the hover
> overlay's "Add to queue" toggle button *and* the ⋮ menu sheet's list item both
> carry it). We deep-search for the first `addToPlaylistCommand` with the QUEUE
> `listType`, so either works.

---

## The dispatcher

`ytd-app` exposes `resolveCommand(command, env)` — a generic executor that runs
any innertube command. Confirm and use it:

```js
const app = document.querySelector("ytd-app");
typeof app.resolveCommand;            // "function"
app.resolveCommand(command, { sourceElement: app });   // executes it
```

Fallback (older/other builds): fire the event the app binds to —

```js
app.dispatchEvent(new CustomEvent("yt-action", {
  detail: { actionName: "yt-service-request", args: [app, command],
            returnValue: [], optionalAction: false },
  bubbles: true, composed: true,
}));
```

Because the dispatcher is generic, this same path runs **any** command you pull
out of the data — not just queue.

---

## Why we skip the menu entirely

The ⋮ menu item (and its DOM) may not exist until you open the menu. But the
**command data is present on the element from the moment it renders**. Reading
`.data` lets us execute the action without opening any menu, hovering, or
depending on menu text — so it's also language-independent.

---

## Surfaces: three different cases

Not every video surface stores the command the same way. `injected.js`
(`performAction`) tries them in order:

| Surface | Element | Data has command? | What we do |
|---------|---------|-------------------|------------|
| Home / search / channel | `yt-lockup-view-model`, `ytd-rich-item-renderer`, … | ✅ `addToPlaylistCommand` (queue) | dispatch it → **add to queue** |
| Watch-page mix/radio panel | `ytd-playlist-panel-video-renderer` | ✅ `watchEndpoint` (already queued) | dispatch it → **jump to & play** |
| Watch-page recommendations | `yt-lockup-view-model` (sidebar variant) | ❌ **empty** — pure view-model | **synthesize** the queue command from the videoId in the link |

### The synthesize trick (important)

Sidebar recommendation lockups carry **no command or endpoint at all** in their
`.data` (verified by dumping every `*Command`/`*Endpoint` key — the list was
empty). The command isn't there to extract.

But the command shape is fully known (from dumping a home-page item), and the
only per-video part is the `videoId` — which we can read from the item's
`watch?v=...` link. So we **build the command ourselves** and dispatch it. See
`synthesizeQueueCommand()` in [injected.js](injected.js). This is the general
escape hatch when a surface won't hand you a command: reconstruct it from the id.

---

## The two-world problem (important gotcha)

Chrome content scripts run in an **isolated world**. In that world:

- `element.data` is **not** visible (it's a JS property set by the page).
- `app.resolveCommand` is **not** callable.

So the extraction + dispatch *must* run in the **page's main world**. The
extension is split accordingly:

```
content.js  (isolated world)          injected.js  (page main world)
------------------------------        ------------------------------------
intercepts middle-click       ─┐
blocks new-tab (preventDefault)│
stamps clicked el:             │      window.message listener:
  data-mcq-target=<token>      │        finds [data-mcq-target]
postMessage({add-to-queue}) ───┼───▶    reads el.data / synthesizes
                               │        picks queue | watch | synth
awaits result  ◀───────────────┼─────  app.resolveCommand(command)
show toast (per action)        ┘        postMessage({result, ok, action})
```

- **Bridge:** `window.postMessage` (the only channel between the two worlds).
- **Target identity:** a temporary `data-mcq-target` attribute on the shared DOM
  — the one thing both worlds can see. `injected.js` finds the element by it,
  then removes it.
- **Result carries `action`** (`"queued"` | `"playing"` | `"none"`) so the
  content side shows the right toast.
- `injected.js` is declared in `web_accessible_resources` so the page is allowed
  to load it.

Only the content script can reliably `preventDefault()` the browser's new-tab
default, which is why interception stays on the content side and dispatch on the
page side.

---

## Recipe: rediscover / extend this for any innertube action

1. **Grab the element**, print `el.data` (or `el.__data`, `el.polymerController?.data`).
   The action is in the data, not in a listener.
2. **Search the data for verb-y keys** — anything ending in `Command`,
   `Endpoint`, or `ServiceEndpoint`. Those are the executable payloads. For queue
   it's `addToPlaylistCommand` + `listType: "..._QUEUE"`; Watch Later is a
   `playlistEditEndpoint` with `playlistId: "WL"`; etc.
3. **If the data is empty** (some surfaces render pure view-models), synthesize
   the command from the videoId — see the sidebar case above.
4. **Confirm the dispatcher**: `typeof ytd-app.resolveCommand === "function"`.
5. **Replay the command** through it and watch the UI react.

To add a new action to this extension, add a finder in [injected.js](injected.js)
(or extend `performAction`) to produce the command you want, and dispatch it the
same way.
