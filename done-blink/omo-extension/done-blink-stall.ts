// done-blink stall marker channel: tells the Herdr done-blink mod that THIS
// terminal's omo session is stalled — unattended, its automatic turns held
// until a human acts — by writing one marker file per terminal under
// ~/.config/herdr-app/data/stall/<encoded address>.json while the stall
// lasts and removing it when the session resumes. The mod's data watcher
// lights the terminal's attention pulse from the marker's presence and
// clears it when the file disappears.
//
// The signal (omo 5.1.79, docs/extensions.md "session_hold_changed"):
// pi.on("session_hold_changed") fires with { change: "paused" | "resumed",
// pauseSeq, holds } where holds lists the live hold records { kind, key,
// data? }; kind "unattended" is exactly "this session holds its automatic
// turns (goal continuation, monitor and codemode wakes) until a person
// inputs or resumes" (docs/rpc.md, hold ledger, senpi#3811) — the session
// will run nothing on its own. A user Stop (session_hold), a parent's pause
// (inherited_hold) or a run fence never lights the marker: those are not
// the person's stall. ctx.getPauseState() returns the same { pauseSeq,
// holds } snapshot and is preferred on every event, so the decision always
// reflects the CURRENT holds rather than one event's payload. The engine's
// SessionLifecycle (waiting_human, lastStop.cause "no_wake") is published
// to RPC observers only and is not exposed to extensions at all (checked
// against docs/extensions.md), so the hold record is the only
// extension-visible stall signal.
//
// NAMING RULE: this file must NOT be renamed herdr-*.ts/.js/.mjs. The
// builtin herdr reporter defers to any loaded user extension matching that
// pattern (docs/extensions.md, builtin herdr reporter), which would disable
// the builtin OSC 7501 blocked reporting the done-blink attention light
// also relies on. Keep the done-blink-stall name.
//
// The pid→terminal-address resolution (hc ls + hc get foreground.pid, cwd
// first, capped, single-flight, misses retried and never cached) and the
// hardened store (run-time HOME resolution, honest-path and containment
// checks around every mutation, temp+rename atomic write, dir 0700 / file
// 0600) are the herdr-rename-history extension's patterns, copied on
// purpose — rename-history/omo-extension/index.ts in this repo is the
// reference implementation.
//
// The extension must never disturb the session: every handler is guarded
// and silent, and nothing is written to the screen.

import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { join } from "node:path";

// The store root is resolved at RUN time, never at import time: a host that
// repoints HOME after loading this module must not send writes to the old
// root. Every created/written/deleted path must resolve (following
// symlinks; not-yet-existing targets validate the nearest existing
// ancestor and are revalidated after creation) inside the store.
let storeRoot: string | null = null;
function stallDirOf(): string {
  if (storeRoot === null) storeRoot = join(process.env.HOME || homedir(), ".config/herdr-app/data/stall");
  return storeRoot;
}
function real(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return realpathSync(cur);
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      cur = up;
    }
  }
}
// The store path itself must not traverse a symlink between its nearest
// existing ancestor and the resolved expectation: mkdirSync would follow
// such a detour and create the store in another tree.
function storePathIsHonest(): boolean {
  const want = resolve(stallDirOf());
  const anc = real(want); // nearest EXISTING ancestor, fully resolved
  if (anc === want) return true;
  return want.startsWith(anc + sep) && resolve(anc + sep + want.slice(anc.length + sep.length)) === want;
}
function insideStore(p: string): boolean {
  const root = real(stallDirOf());
  const target = real(p);
  return target === root || target.startsWith(root + sep);
}

export default function (pi: ExtensionAPI) {
  // Only the person's own interactive session: forked and worker sessions of
  // a shared daemon resolve to the same terminal, and a child agent waiting
  // on its parent is not the person's stall. (Same guard as
  // herdr-rename-history: worker sessionKind, or sessionContext.role child /
  // dag_child / member.)
  const role = (pi.sessionContext ?? {}).role;
  if (pi.sessionKind === "worker" || role === "child" || role === "dag_child" || role === "member") return;

  // The herdr terminal this omo runs in: hc ls carries no pids, but hc get
  // lists the foreground program, which is this process. omo terminals the
  // core still places in this cwd are tried first, then every other live omo
  // terminal. hc get calls are capped per attempt, and only a hit is cached —
  // a miss is retried on the next event (addressResolved stays false).
  // (Pattern credited to herdr-rename-history.)
  const GET_CAP = 24;
  let address: string | null = null;
  let addressResolved = false;
  // One sweep at a time: concurrent callers share the in-flight promise
  // instead of each queuing a full sweep of hc calls behind the other.
  let addressSweep: Promise<string | null> | null = null;
  function resolveAddress(): Promise<string | null> {
    if (addressResolved) return Promise.resolve(address);
    if (!addressSweep) addressSweep = sweepAddress().finally(() => { addressSweep = null; });
    return addressSweep;
  }
  async function sweepAddress(): Promise<string | null> {
    const me = String(process.pid);
    let gets = 0;
    const isMe = async (addr: string): Promise<boolean> => {
      if (gets >= GET_CAP) return false;
      gets++;
      try {
        const g = await pi.exec("hc", ["get", addr, "--json"], { timeout: 5000 });
        if (g.code !== 0) return false;
        const rec = JSON.parse(g.stdout) as { foreground?: { pid?: number } };
        return rec.foreground != null && String(rec.foreground.pid) === me;
      } catch {
        return false;
      }
    };
    try {
      const ls = await pi.exec("hc", ["ls", "--json"], { timeout: 5000 });
      if (ls.code !== 0) return null;
      const parsed = JSON.parse(ls.stdout) as { terminals?: Array<{ address?: string; agent?: string; cwd?: string; state?: string }> };
      const all = (parsed.terminals ?? []).filter((t) => t.address && t.state !== "finished");
      const omos = all.filter((t) => t.agent === "omo");
      const preferred = omos.filter((t) => t.cwd === process.cwd());
      for (const t of preferred) {
        if (await isMe(t.address!)) {
          address = t.address!;
          addressResolved = true;
          return address;
        }
      }
      for (const t of omos) {
        if (preferred.includes(t)) continue;
        if (await isMe(t.address!)) {
          address = t.address!;
          addressResolved = true;
          return address;
        }
      }
    } catch {
      // unresolved: fall through uncached
    }
    return null;
  }

  function fileOf(addr: string): string {
    // Remote addresses contain "/" (vps/t7); percent-encoding keeps one file
    // per address — the same encoding the done-blink mod decodes with.
    return join(stallDirOf(), encodeURIComponent(addr) + ".json");
  }

  // Handlers run concurrently (each awaits address resolution first); writes
  // and removes queue here so they never interleave.
  let queue: Promise<void> = Promise.resolve();
  function serialized(fn: () => void) {
    queue = queue.then(fn).catch(() => {});
    return queue;
  }

  // Single-writer atomic replace; a failure must never surface in the
  // session. `pid` names the writing omo so a later load can sweep markers
  // whose writer exited while stalled (that session's resumed event never
  // comes); the mod reads only v/address/since/state and ignores the rest.
  function writeMarker(addr: string): boolean {
    try {
      const file = fileOf(addr);
      if (!storePathIsHonest() || !insideStore(file) || !insideStore(stallDirOf())) return false; // before any creation
      if (!existsSync(stallDirOf())) mkdirSync(stallDirOf(), { recursive: true, mode: 0o700 });
      if (!storePathIsHonest() || !insideStore(stallDirOf())) return false; // revalidate after creation
      const tmp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
      if (existsSync(tmp) || !insideStore(tmp)) return false; // fresh exclusive path only
      writeFileSync(tmp, JSON.stringify({ v: 1, address: addr, since: new Date().toISOString(), state: "waiting_human", pid: process.pid }) + "\n", { mode: 0o600, flag: "wx" });
      if (insideStore(tmp) && insideStore(file)) {
        renameSync(tmp, file);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ENOENT (nothing was marked) is fine. The marker is keyed by terminal
  // address, so removal works even when no closure state remembers the
  // write (a fresh instance after /reload).
  function removeMarker(addr: string): void {
    try {
      const file = fileOf(addr);
      if (insideStore(file)) unlinkSync(file);
    } catch {}
  }

  function holdsUnattended(holds: unknown): boolean {
    return Array.isArray(holds) && holds.some((h) => h != null && typeof h === "object" && (h as { kind?: unknown }).kind === "unattended");
  }

  // The ctx snapshot is the CURRENT hold set; the event payload is the
  // fallback for hosts without getPauseState.
  async function currentHolds(event: { holds?: unknown }, ctx: unknown): Promise<unknown> {
    try {
      const snap = await (ctx as { getPauseState?: () => unknown } | null | undefined)?.getPauseState?.();
      const holds = (snap as { holds?: unknown } | null | undefined)?.holds;
      if (Array.isArray(holds)) return holds;
    } catch {}
    return event.holds;
  }

  pi.on("session_hold_changed", async (event: { change?: string; pauseSeq?: number; holds?: unknown }, ctx: unknown) => {
    try {
      // A resume ends every hold; anything still unattended-held keeps the
      // marker. Decided from the snapshot, so a hold added under an existing
      // pause is picked up by the next event too.
      const stalled = event.change !== "resumed" && holdsUnattended(await currentHolds(event, ctx));
      const addr = await resolveAddress();
      if (!addr) return; // unresolved: retried on the next event, never cached
      if (stalled) await serialized(() => { writeMarker(addr); });
      else await serialized(() => { removeMarker(addr); });
    } catch {}
  });

  // A hold that predates this instance — omo restarted while stalled, or an
  // unattended open — fires no session_hold_changed, so read the snapshot
  // once at start (not a poll) and then sweep markers of dead writers.
  pi.on("session_start", async (_event: { reason?: string }, ctx: unknown) => {
    try {
      if (holdsUnattended(await currentHolds({}, ctx))) {
        const addr = await resolveAddress();
        if (addr) await serialized(() => { writeMarker(addr); });
      }
      sweepDeadMarkers();
    } catch {}
  });

  // Reconcile on user activity: an unattended hold can be released by a
  // prompt while another hold (a user Stop) keeps the session paused, and
  // that partial release emits no session_hold_changed. The remove direction
  // only — the enter path owns writes.
  pi.on("message_end", async (_event: { message?: { role?: string } }, ctx: unknown) => {
    try {
      if (holdsUnattended(await currentHolds({}, ctx))) return;
      const addr = await resolveAddress();
      if (addr) await serialized(() => { removeMarker(addr); });
    } catch {}
  });
}

// Markers whose writing omo process is gone: that session exited while
// stalled, so its resume never comes and the marker would pulse the badge
// forever. Swept on every session start by whichever omo loads next. A
// marker with a live writer (EPERM counts as alive), an unknown shape or an
// unreadable file is never touched.
function sweepDeadMarkers(): void {
  try {
    const dir = stallDirOf();
    if (!existsSync(dir) || !storePathIsHonest() || !insideStore(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = join(dir, f);
      try {
        if (!insideStore(p)) continue;
        const j = JSON.parse(readFileSync(p, "utf8")) as { pid?: unknown };
        if (typeof j.pid !== "number" || j.pid === process.pid) continue;
        process.kill(j.pid, 0); // ESRCH = the writer is gone
      } catch (err) {
        if ((err as { code?: string }).code === "ESRCH") {
          try {
            if (insideStore(p)) unlinkSync(p);
          } catch {}
        }
        // alive, malformed or unreadable: keep the marker
      }
    }
  } catch {}
}
