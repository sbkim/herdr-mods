# herdr-mods

Mods for [Herdr](https://herdr.dev), the desktop app for terminals and coding
agents. Each folder here is one mod, shared in the [Herdr mod
gallery](https://herdr.dev/mods) format: the mod's files, a `RECIPE.md` (a
brief another agent can rebuild it from) and a `preview.png`.

## Mods

| Mod | What it does |
| --- | --- |
| [terminal-numbers](terminal-numbers/) | A big sticky number on every terminal's pane header; click a number to renumber or swap, and export the number-to-terminal map for outside tools (voice assistants, agents). |
| [rename-history](rename-history/) | The terminal right-click menu with a RENAME HISTORY section: every /rename title the terminal has seen, newest first; pick one to jump back to its report. Needs its omo extension. |

One folder ships an omo extension without its mod: [done-blink](done-blink/)
holds the stall marker channel for the done-blink badge-pulse mod (the mod
itself is a personal build on `terminal-numbers` and is not published here).

## Installing

Mods are small JavaScript programs that run inside Herdr **with your own
permissions and no sandbox**: they can run programs, read and write files, and
use the network. Only install mods whose code you have read — see Herdr's
[security and privacy notes](https://github.com/herdrdev/herdr-app/blob/master/docs/security.md).

```sh
git clone https://github.com/sbkim/herdr-mods
cp -r herdr-mods/terminal-numbers ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/terminal-numbers
```

A mod's own README says what else it needs (a layout edit, keys, a program).
Leave `RECIPE.md` and `preview.png` behind when copying; they are build
notes, not runtime files.

## License

MIT, except where a file says otherwise: `terminal-numbers` builds on
Herdr's shipped `pane` header and icons (Apache-2.0 — see its `NOTICE` and
the `LICENSE-APACHE` in its folder).
