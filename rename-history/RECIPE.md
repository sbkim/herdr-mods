# rename-history

The terminal right-click menu, with a RENAME HISTORY section: every /rename
title this omo terminal has seen, newest first, each row jumping the terminal
back to that rename's report (or its prompt line when the turn's end was not
caught). Two parts build it: a Herdr mod (the menu itself) and an omo
extension that records the titles.

![rename-history](preview.png)

**What you see:** the context menu Herdr ships — a popover (`t.popover`
background, 12.8px text, 31px rows, 7px rounding, an icon at 14px in muted, a
label, the key hint at 11px dim on the right, separators before Close /
Keybinds and around theme groups) — with, above the pane items, a 10.5px dim
"RENAME HISTORY" header (+"· +N older" when more exist) and one 31px row per
bookmark: a 13px bookmark icon (the mod's own `bookmark.svg`), "N. title"
(the store's dense number) truncated in the middle, and on the right a 11px
"HH:MM · report" (done color)
or "HH:MM · prompt" (dim). Arrow keys move the highlight, Enter runs, Esc
closes. When a jump's position is gone, a 640x420 dialog shows the title, a
note, and the terminal's last 40 lines in a scrolling list.

**How it behaves:** right-click on a terminal opens it at the pointer with
props {tab: "pane", target: {pane, terminal}} (Shift+right-click when the
program owns the mouse); tab, space and global right-clicks render the same
sections as the shipped menu. The history section appears once the extension
has recorded a title: picking a row focuses the terminal, runs one `hc read
<address> --lines 400`, locates the bookmark's report anchor (its last lines,
exact run first, then prefixes) and scrolls there via `terminal.scroll`;
falling back to the prompt anchor, and to the snippet dialog when neither is
in the scrollback. While the menu is open it refreshes itself through a
`watchFolder` on Herdr's data folder. Agent status does not appear here;
the menu is the same for every status.

**Built from:** (a) the mod `mods/rename-history/`: `main.js` — a clone of
the shipped `menu` mod (its `items(p, git)` switch over props.tab with the
pane/tab/space/global sections, `menuIcon` naming icons in the shipped
`workspace-chrome` folder, `shortcut` reading `keys()`, the git checkout
probing for worktree items) plus: a `RENAME HISTORY` header, up to 12
`{rh: bookmark}` rows above the items, a "+N older" count, and a jump that
closes the overlay only after `jump()` resolves; `tracker.js` —
`ensure(address)` reads `~/.config/herdr-app/data/rename-history/<encoded
address>.json` ({v, address, items}), `watch(cx, addr)` re-reads on folder
changes, `jump()` does the anchor search and `terminal.scroll`;
`mod.json` { "place": "none", "overlay": { "width": 300, "height": 0.8 } }.
(b) the omo extension `omo-extension/index.ts`: on
`session_info_changed` — only for a rename the person typed, checked by one
`hc read` of the tail for the "Session name set" line — push {title (max 80
chars), ts}; on user `message_end` attach up to 3 prompt anchor lines
(prefix 60 chars) plus the full prompt text (1,000 chars); on `agent_end`
attach report anchors and the final report — the last assistant text of the
run, 4,000 chars keeping the tail (conclusion side) — skipping rename
confirmation one-liners; on `session_start` reason "new" delete the file
(numbers start over at 1). One JSON file per terminal, {v: 2, address,
items: [{num, title, ts, promptAnchor, reportAnchor, prompt, report}]},
numbers reassigned densely 1..N oldest-first on every write (a 50-item
eviction never renumbers the rest), single writer through a serialized queue,
temp file + atomic rename with the folder at 700 and files at 600; forked and
worker sessions return at once (they share a terminal); address resolved once
by matching `hc get` foreground pid against the process pid; dead
terminals' files swept (and chmod'd 600) on load. herdr functions:
`props`, `run` (pane.focus, terminal.scroll, the menu's own commands),
`openOverlay`/`closeOverlay`, `theme`, `keys`, `terminals`, `spaces`,
`panes`, `exec` (git), `hc` (read), `readTextFile`, `watchFolder`,
`appHome`. Programs run: git (menu items), hc read (jump). Art: the mod's
own `bookmark.svg`; all other icons come from the installed
`workspace-chrome` mod at run time.

**Watch out:** the menu mod must actually be loaded — a mod folder created
while Herdr is running is not hot-reloaded (restart Herdr, or the menu stays
an older copy); `mod.json`'s overlay height 0.8 (a share of the window)
keeps the 12-row history plus the base items on screen; the popup is
content-sized, so cap the shown rows (MAX_SHOWN 12) or the base items fall
off; anchors are line prefixes, not row numbers, because the scrollback
reflows; a title event costs one `hc read` (8 lines) to prove it was typed,
so agent-set titles are dropped; the report is the last assistant text only;
remote addresses contain "/" and are percent-encoded into file names; the
extension must never write to the session screen — every handler is guarded
and silent. Assumes Herdr 0.1.x with terminal_menu layouts support and omo
5.1.x extension events.

**Done when:** `herdr-app check` on the mod folder passes; with
`"terminal_menu": "rename-history"` in a personal layout and Herdr
restarted, a right-click shows the usual items plus RENAME HISTORY once the
extension has recorded a title, each row labelled "N. title"; a title omo or
the agent set on its own never appears; picking an old title scrolls the
terminal to its report (or shows the tail dialog when the position is gone);
"+N older" appears beyond 12 bookmarks, 50 are kept and dense numbering
survives eviction; the state file holds prompt and report text at 600; a plain right-click on a shell
terminal shows the menu without the section; Esc closes.
