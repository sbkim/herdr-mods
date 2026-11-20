# done-blink (omo extension only)

This folder currently ships only the **omo extension** of the done-blink
feature: the stall marker channel. The Herdr mod itself (the badge pulse)
is a personal mod built on `terminal-numbers` and is not published here.

## What the extension does

An omo session that becomes **stalled** — unattended, its automatic turns
(goal continuation, monitor and codemode wakes) held until a human inputs
or resumes — writes one marker file per terminal:

```
~/.config/herdr-app/data/stall/<encodeURIComponent(address)>.json
```

```json
{ "v": 1, "address": "…", "since": 1763640000000, "state": "waiting_human", "pid": 12345 }
```

`since` is epoch milliseconds, the format the mod's stall parser accepts.

written atomically (temp file + rename, dir 0700, file 0600), and removes
it when the session resumes. The done-blink mod watches `data/` and lights
the terminal's attention pulse while the marker exists. `pid` names the
writing omo process; whichever omo loads next sweeps markers whose writer
exited while stalled (that session's resume never comes).

The signal is omo's `session_hold_changed` event (and the matching
`ctx.getPauseState()` snapshot, preferred on every event): a pause whose
live holds contain `kind: "unattended"`. A user Stop (`session_hold`), a
parent's pause (`inherited_hold`) or a run fence never lights the marker.
Only the person's own interactive session records — worker sessions and
task children (`child`, `dag_child`, `member` roles) never do: a child
agent waiting on its parent is not the person's stall.

## Install

```sh
cp done-blink/omo-extension/done-blink-stall.ts ~/.omo/agent/extensions/
```

Restart omo; each omo then marks its own terminal. Nothing is polled —
the store is touched only on hold events and session starts.

**Do not rename the file `herdr-*.ts/.js/.mjs`.** omo's builtin herdr
reporter defers to any loaded user extension matching that pattern, which
would disable the builtin OSC 7501 blocked reporting the done-blink
attention light also relies on.

## Limits

- An **attended** session that simply ends its turn with no wake scheduled
  emits no hold and lights nothing: omo's SessionLifecycle
  (`waiting_human`, `lastStop` cause `no_wake`) is published to RPC
  observers only and is not exposed to extensions. The upstream answer
  would be the builtin herdr reporter reporting `stalled` as a `blocked`
  kind, so every terminal benefits without per-user extensions.
- The extension resolves its terminal via `hc ls` + `hc get`
  (foreground pid match, up to 24 `hc get` calls per attempt, cwd
  preferred); an unresolved address is retried on the next event and never
  cached.

## Testing

`tools/done-blink-stall.test.ts` is a standalone harness (fake pi, fake
hc, scratch `HOME` via `tools/harness-runner.ts`):

```sh
bun tools/done-blink-stall.test.ts
```
