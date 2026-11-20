# rename-history

Herdr's terminal right-click menu with one addition: a **RENAME HISTORY**
section listing the `/rename` titles the terminal has seen, newest first.
Pick one and the terminal scrolls back to that rename's report — or, when the
end of the turn was not caught, to the prompt line that started it. Works
with the omo agent's terminals (see Limits).

![rename-history](preview.png)

## What it does

- The usual right-click menu (Rename, Split, Zoom, Close, worktrees, themes —
  everything the shipped `menu` has), plus a RENAME HISTORY section when the
  terminal has history: each row shows a bookmark icon, "<number>. <title>"
  and the time, with `report` or `prompt` saying where a jump lands. Titles
  are numbered densely 1..N oldest-first (a full history survives under the
  50-item cap). More than 12 bookmarks are summarized as "+N older"; 50 are
  kept per terminal, and `/new` starts the numbers over at 1.
- Jumping locates the title by text anchors in the scrollback (one `hc read`
  at jump time), so it survives reflow. When the position is gone, a dialog
  shows the terminal's tail instead.
- Only a `/rename` the person actually typed is recorded (the extension
  checks the terminal's tail for the "Session name set" line; titles omo or
  an agent set on their own are filtered out).
- **Session-scoped**: the file carries the writing session's id (read from
  the handler context the host provides). Resuming the same session
  (`omo --session …` after `/exit`) keeps its history; any other session
  started in that terminal (a fresh omo, `/new`) archives the file whole
  and starts over at 1 — at that session's first recorded event, so until
  then the menu can still show the previous session's rows. `/exit` keeps
  the file; when the terminal itself disappears, the next load archives it
  instead of discarding it. A host that never provides a session id records
  terminal-keyed, exactly as before.
- The full prompt (up to 1,000 characters) and the final report (the last
  assistant text of the run, up to 4,000 characters keeping the conclusion
  side) are stored beside the anchors, so a report stays readable even after
  the scrollback is gone. Separate tools can read the same state files for
  voice or agent queries.
- Works on Shift+right-click too (when a program takes the mouse and plain
  right-click goes to it).

## Install — two parts

**1. The mod**

```sh
cp -r rename-history ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/rename-history
```

Then use it as your terminal menu. Herdr's shipped layouts are read-only, so
clone yours first and edit the clone:

```sh
herdr-app do layout.clone '{"name":"main","as":"my-main"}'
```

In `~/.config/herdr-app/layouts/my-main.json`, add at the root (next to
`"type"` / `"children"`):

```json
"terminal_menu": "rename-history"
```

If the menu was already open in a session started before the folder existed,
restart Herdr so the new mod is loaded.

**2. The omo extension** (records the history; skip it and the menu simply
has no history section)

```sh
cp -r rename-history/omo-extension ~/.omo/agent/extensions/herdr-rename-history
```

Restart omo (each omo records the titles of its own terminal into
`~/.config/herdr-app/data/rename-history/<address>.json`; nothing is polled).

## Usage

Right-click a terminal (Shift+right-click when the program takes the mouse):
the RENAME HISTORY section sits above the usual items. Click or ↑/↓ + Enter a
title to jump; Esc closes. Everything else in the menu works as before.

## State files

One JSON file per terminal under
`~/.config/herdr-app/data/rename-history/<address>.json` — the **current
session's** history:

```json
{ "v": 3, "address": "…", "session": "…", "items": [
  { "num": 1, "title": "…", "ts": 0,
    "promptAnchor": ["…"], "reportAnchor": ["…"],
    "prompt": "up to 1,000 chars", "report": "up to 4,000 chars, tail kept" } ] }
```

Numbers are reassigned densely 1..N (oldest first) on every write. A
different session starting in the terminal moves the file whole into
`data/rename-history/archive/<address>/<encoded session>-<time>.json` (a
file with no session id archives as `unlabeled-<time>.json`); a same-
millisecond re-archive gets a numeric suffix, so no snapshot is ever
overwritten. Archives keep the **newest 10 sessions per terminal for 30
days from archive time**, within a **20 MB** total cap; only `*.json`
entries are managed. The store holds report text, so it is created with
the folder at mode 700 and the files at 600.

Tools built on the state files (voice assistants, agents) read the terminal
file for the current session and can list `archive/<address>/` and read a
file by session id for past sessions.

## Limits

- The history is recorded by an **omo extension** — terminals running other
  agents or plain shells get the plain menu without the section. Forked or
  worker omo sessions share a terminal and do not record.
- Only **typed** `/rename`s are recorded; detecting one costs a short
  `hc read` of the terminal's tail per title event.
- The final report is the **last assistant text of the latest run** —
  intermediate tool-call turns are not kept, and very short rename
  confirmations are skipped.
- A rename whose turn was too short to capture lands on the **prompt** line
  rather than a report.
- The menu shows the **12** most recent titles; **50** are kept per terminal.
- Remote terminals (another machine) are not supported.
- Terminal discovery tries up to **24** live omo terminals per lookup.
- Trimming runs in every omo process; two processes archiving at the same
  instant can in principle race a trim (accepted, single-user rare).
- **Known limitation (accepted)**: if a terminal's `hc ls` listing is
  briefly stale while another omo loads, that terminal's file can be
  archived mid-session and its popup restarts empty from the next `/rename`
  (data is preserved, never lost). **Recovery**: the archived rows live in
  `~/.config/herdr-app/data/rename-history/archive/<terminal address>/` —
  if a popup suddenly empties, look there. `/new` always changes the
  session id (measured on omo 5.1.79), so mid-session same-id resets do
  not occur.
- The reset promise applies when the popup is **reopened**; an already-open
  popup keeps the rows it loaded.

## Privacy & reach

The extension writes one JSON file per omo terminal under Herdr's `data/`
folder (folder 700, files 600 — reports can carry secrets) and runs `hc ls` /
`hc get` to find which terminal it is in, plus one short `hc read` per title
event.
The mod reads those files (`readTextFile`), runs `git` for the menu's
worktree items (as the shipped menu does) and one `hc read` on jump. Nothing
leaves the machine.

## Credits

Built on Herdr's shipped `menu` mod (Apache-2.0) — see `NOTICE`.
`RECIPE.md` is the build brief.
