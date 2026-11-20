// herdr rename-history: keeps the current bookmark list of each Herdr
// terminal in one state file per terminal, under
// ~/.config/herdr-app/data/rename-history/<address>.json, for the Herdr
// rename-history mod. The mod reads the file when its menu opens; other tools
// can read the same state files for their own queries. Neither polls anything.
//
// Why per-terminal files rather than one append log: a terminal has exactly
// one owning omo process, so each file has a single writer — no lock file is
// needed, and a write is read-modify-write into a temp file followed by an
// atomic rename. Size is bounded by construction: at most MAX_ITEMS
// bookmarks, each a title plus a few short anchor prefixes.
//
// What is recorded, and why from these events (omo 5.1.78, measured):
// - Built-in slash commands never fire the `input` event. /rename is recorded
//   from session_info_changed (payload {type, name}) only when the raw name
//   ends with a hidden marker character (MARKERS below): the sender — an
//   agent acting for the person — attaches one to opt the rename into
//   history, and the trailing marker run is stripped before storing.
//   Mid-string zero-width characters are emoji components (👩‍💻 =
//   U+1F469 U+200D U+1F4BB) and never trigger recording. Unmarked names — a
//   rename the person typed by hand and omo's auto-titles alike — are not
//   recorded.
// - /new is session_start with reason "new"; it resets the screen, so the
//   terminal's file is deleted outright.
// - message_end (role "user") and agent_end carry the message text; short line
//   prefixes of the prompt and of the report's tail serve as scrollback
//   anchors — the mod locates them with one `hc read` at jump time, because
//   neither the extension nor hc can read the view's scroll position. Lines
//   under 4 characters are not distinctive enough to anchor and are dropped.
//   The full prompt (1,000 chars) and report (4,000 chars) are kept alongside,
//   so a report stays readable after the scrollback is gone. A prompt fills
//   only the last item and only while it has no prompt yet; the report then
//   pairs with that item by identity {ts, title} — never by position, because
//   the 50-item slice, /new and foreign resets all shift indices. A pushed
//   marked rename clears any standing pairing, so a late agent_end after it
//   writes nothing; the new item pairs at its own prompt. A turn that fills
//   no prompt (the marked rename never happened, or a steering message
//   arrived after the prompt) records no report at all.
// - Bookmarks are numbered oldest-first from 1; an eviction under the
//   50-item cap never renumbers what remains.
// - The store is session-scoped: the file carries the writing session's id.
//   An --session resume of the same session keeps its history; any other
//   session started in that terminal (a fresh omo, /new included) archives
//   the file whole under data/rename-history/archive/<address>/ and starts
//   over at 1. Archives keep the newest 10 sessions per terminal for 30 days
//   within a 20 MB total cap. /exit writes nothing, so an exited session can
//   be resumed with its history intact.
// - On load, state files whose terminal no longer exists (not in hc ls) are
//   removed.
//
// The extension must never disturb the session: every handler is guarded and
// silent, and nothing is written to the screen.

import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { join } from "node:path";

const MAX_ITEMS = 50;
const ANCHOR_PREFIX = 60;
const ANCHOR_LINES = 3;
const ANCHOR_MIN_LEN = 4;
const PROMPT_MAX = 1_000;
const ARCHIVE_KEEP = 10;
const ARCHIVE_DAYS = 30;
const ARCHIVE_TOTAL = 20 * 1024 * 1024;
const REPORT_MAX = 4_000;
// Hidden rename markers, end-attachment convention: a raw session name whose
// last character is one of these is an opt-in rename that the store records,
// stripping the trailing marker run before storing. Mid-string occurrences
// are emoji components and are left untouched. U+FEFF is omo-removed
// (measured) and deliberately is not a marker.
const MARKERS = ["\u200b", "\u200c", "\u200d", "\u2060"];

// The store root is resolved at RUN time, never at import time: a host that
// repoints HOME after loading this module must not send writes to the old
// root. Every created/written/moved/chmod'd/deleted path must resolve
// (following symlinks; not-yet-existing targets validate the nearest
// existing ancestor and are revalidated after creation) inside the store.
let storeRoot: string | null = null;
function stateDirOf(): string {
  if (storeRoot === null) storeRoot = join(process.env.HOME || homedir(), ".config/herdr-app/data/rename-history");
  return storeRoot;
}
function archDirOf(): string {
  return join(stateDirOf(), "archive");
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
  const want = resolve(stateDirOf());
  const anc = real(want); // nearest EXISTING ancestor, fully resolved
  // honest iff the ancestor IS the expectation, or the expectation extends
  // it by exactly the still-missing suffix (no symlink in between: a detour
  // would make the resolved ancestor differ from the built-up prefix).
  if (anc === want) return true;
  return want.startsWith(anc + sep) && resolve(anc + sep + want.slice(anc.length + sep.length)) === want;
}
function insideStore(p: string): boolean {
  const root = real(stateDirOf());
  const target = real(p);
  return target === root || target.startsWith(root + sep);
}

interface Bookmark {
  num: number;
  title: string;
  ts: number;
  promptAnchor?: string[];
  reportAnchor?: string[];
  prompt?: string;
  report?: string;
}

export default function (pi: ExtensionAPI) {
  // Sessions of a shared daemon share the process, so forked and worker
  // sessions resolve to the same terminal and would race this file with
  // their own queues. Only the pristine interactive session records history.
  // omo's own task-RPC classifier marks those with sessionContext.role of
  // child, dag_child or member; a control endpoint (gateway) session is an
  // ordinary interactive session whose context only names its host
  // (host_instance/host_socket), so it records like any other.
  const role = (pi.sessionContext ?? {}).role;
  if (pi.sessionKind === "worker" || role === "child" || role === "dag_child" || role === "member") return;

  // Per-session state: the extension factory runs once per session, so this
  // closure never leaks across sessions of a shared daemon.
  let address: string | null = null;
  let addressResolved = false;
  let sessionAdopted = false;
  let ownWrites = 0; // writes THIS instance made: the stale-writer drop applies only after them
  let lastOwnAddr = ""; // the terminal this instance records
  let resetPending = false; // a /new whose archive failed: the next event retries it before anything else
  // The item the current turn's report pairs with: the identity {ts, title}
  // the item carried when the turn's prompt filled it — never an array index,
  // which the 50-item slice, /new and foreign resets all shift. Null when the
  // turn has no filled item; a report then writes nothing instead of landing
  // on an older bookmark. Survives agent_end, so a retry turn (an agent_end
  // with no message_end since) refreshes the same item with its newest report.
  let bound: { ts: number; title: string } | null = null;

  // The session id lives on the handler context (docs/extensions.md:
  // ctx.sessionManager), never on pi; the first handler to see it caches it.
  // "" until then — and only if the host never provides one, in which case
  // the store keeps whatever it holds (never a wrong reset).
  let sessionId = "";
  function sessionOf(ctx: unknown): string {
    try {
      const id = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | null | undefined)?.sessionManager?.getSessionId?.();
      if (typeof id === "string" && id.length > 0) sessionId = id;
    } catch {}
    return sessionId;
  }
  const mySession = (): string => sessionId;

  function fileOf(addr: string): string {
    // Remote addresses contain "/" (vps/t7); percent-encoding keeps one file
    // per address.
    return join(stateDirOf(), encodeURIComponent(addr) + ".json");
  }

  // Handlers run concurrently (each awaits address resolution first); their
  // read-modify-write steps must not interleave or later events overwrite
  // earlier ones. Every state change runs through this queue.
  let queue: Promise<void> = Promise.resolve();
  function serialized(fn: () => void) {
    queue = queue.then(fn).catch(() => {});
    return queue;
  }

  // Reports can carry secrets; only this user may read the store.
  type State = { items: Bookmark[]; session: string; absent: boolean; unreadable: boolean; corrupt: boolean };
  function readState(addr: string): State {
    const file = fileOf(addr);
    if (!existsSync(file)) return { items: [], session: "", absent: true, unreadable: false, corrupt: false };
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return { items: [], session: "", absent: false, unreadable: true, corrupt: false };
    }
    try {
      const j = JSON.parse(text) as { items?: Bookmark[]; session?: unknown };
      return {
        items: Array.isArray(j.items) ? j.items : [],
        session: typeof j.session === "string" ? j.session : "",
        absent: false, unreadable: false, corrupt: false,
      };
    } catch {
      return { items: [], session: "", absent: false, unreadable: false, corrupt: true };
    }
  }

  // Single-writer atomic replace; a failure must never surface in the session.
  // Items are renumbered densely oldest-first on every write: transient title
  // events (auto retitles, turn forks) come and go, and dense numbering keeps
  // small numbers meaningful for anything reading the store. /new and any
  // new session archive the file, which starts over at 1.
  function writeState(addr: string, items: Bookmark[]): boolean {
    try {
      const kept = items.slice(-MAX_ITEMS);
      kept.forEach((it, i) => (it.num = i + 1));
      const file = fileOf(addr);
      if (!insideStore(file)) return false;
      if (!storePathIsHonest() || !insideStore(file) || !insideStore(stateDirOf())) return false; // before any creation
      if (!existsSync(stateDirOf())) mkdirSync(stateDirOf(), { recursive: true, mode: 0o700 });
      if (!storePathIsHonest() || !insideStore(stateDirOf())) return false; // revalidate after creation
      const tmp = `${file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
      if (existsSync(tmp) || !insideStore(tmp)) return false; // fresh exclusive path only
      writeFileSync(tmp, JSON.stringify({ v: 3, address: addr, session: mySession(), items: kept }) + "\n", { mode: 0o600, flag: "wx" });
      if (insideStore(tmp) && insideStore(file)) {
        renameSync(tmp, file);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // Ownership is validated at write time, not only at adoption: a file that
  // belongs to another session (a late id, an old handler outliving its
  // session, a /new under another instance) is archived whole before this
  // session's first write to it — never merged or relabeled. An already-
  // adopted writer facing a MISSING file is stale (another instance reset
  // this terminal after us): drop the event, never recreate the file.
  function mutate(addr: string, fn: (items: Bookmark[]) => boolean) {
    return serialized(() => {
      const st = readState(addr);
      if (st.unreadable) return; // skip; a later event retries
      if (resetPending) {
        if (!fn([])) return; // does not qualify: the pending reset waits for one that does
        if (!archiveState(addr)) return; // still blocked: keep waiting
        resetPending = false;
        bound = null; // our pending /new reset completed: the old items are archived away
        const fresh: Bookmark[] = [];
        if (!fn(fresh)) return;
        if (writeState(addr, fresh)) ownWrites++;
        return;
      }
      // A legacy no-session file counts as foreign once we know our id:
      // prompt/report events then adopt (archive) it instead of restamping.
      const foreign = st.corrupt || (sessionId !== "" ? st.session !== sessionId : st.session !== "" && st.session !== sessionId);
      if (foreign && !fn([])) return; // the event does not qualify: never archive for it
      if (st.absent) {
        if (ownWrites > 0) return; // we wrote it and it vanished without us archiving: another instance reset this terminal
      }
      if (foreign) {
        if (!archiveState(addr)) return; // archive failed: retry on a later event
        bound = null; // the store was reset out from under this turn: nothing pairs anymore
      }
      const items = foreign ? [] : st.items;
      if (!fn(items)) return;
      lastOwnAddr = addr;
      if (writeState(addr, items)) ownWrites++;
    });
  }

  // Archives are "<encoded session>-<archived-at ms>.json": re-archiving a
  // session never overwrites an earlier snapshot, and the encoded name
  // cannot leave the archive directory. The mtime is stamped fresh at
  // archive time (the rename would keep a stale one and the 30-day trim
  // would delete the file on arrival). True when the terminal file is gone
  // afterwards — archived, or never there.
  function archiveState(addr: string): boolean {
    const file = fileOf(addr);
    if (!existsSync(file)) {
      trimArchives();
      return true;
    }
    try {
      let session = "";
      try {
        session = String((JSON.parse(readFileSync(file, "utf8")) as { session?: string }).session ?? "");
      } catch {}
      let safe = "";
      if (session) {
        try {
          safe = encodeURIComponent(session).slice(0, 80);
        } catch {
          safe = session.replace(/[^\w.-]/g, "_").slice(0, 80); // lone surrogates throw encode
        }
      }
      const name = (safe || "unlabeled") + "-" + Date.now();
      const dir = join(archDirOf(), encodeURIComponent(addr));
      if (!insideStore(dir) || !insideStore(file)) return false; // before any creation
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!insideStore(dir)) return false; // revalidate after creation
      let dest = join(dir, name + ".json");
      for (let n = 1; existsSync(dest); n++) dest = join(dir, name + "-" + n + ".json");
      if (!insideStore(dest)) return false;
      renameSync(file, dest);
      if (file === fileOf(lastOwnAddr)) ownWrites = 0; // we archived OUR terminal's file: a later absence is a foreign reset
      const now = new Date();
      try {
        utimesSync(dest, now, now);
      } catch {}
      trimArchives(dest);
      return true;
    } catch {
      return false;
    }
  }

  // Per terminal keep the newest ARCHIVE_KEEP *.json archives no older than
  // ARCHIVE_DAYS from archive time; across all terminals stay under
  // ARCHIVE_TOTAL bytes. The just-archived file (keepPath) always survives
  // and occupies one of the KEEP slots. Only *.json entries are managed;
  // everything else is ignored. A failed unlink does not stop the sweep:
  // the bytes stay counted and the next eligible file is still tried.
  function trimArchives(keepPath?: string): void {
    try {
      const cutoff = Date.now() - ARCHIVE_DAYS * 86_400_000;
      const live: { p: string; m: number; s: number }[] = [];
      for (const d of readdirSync(archDirOf())) {
        const sub = join(archDirOf(), d);
        let names: string[];
        try {
          names = readdirSync(sub);
        } catch {
          continue;
        }
        const files = names
          .filter((n) => n.endsWith(".json"))
          .map((n) => {
            const q = join(sub, n);
            try {
              const m = Math.min(statSync(q).mtimeMs, Date.now()); // future stamps clamp
              return { p: q, m, s: statSync(q).size };
            } catch {
              return null;
            }
          })
          .filter((x): x is { p: string; m: number; s: number } => x !== null)
          .sort((a, b) => b.m - a.m);
        let slots = 0;
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (f.p === keepPath) {
            live.push(f);
            slots++; // the fresh archive occupies one of the KEEP slots
            continue;
          }
          if (slots >= ARCHIVE_KEEP || f.m < cutoff) {
            try {
              if (insideStore(f.p)) unlinkSync(f.p);
            } catch {
              live.push(f); // undeletable: still on disk, still counted
            }
            continue;
          }
          live.push(f);
          slots++;
        }
      }
      // Per-terminal count cap after the fact: the fresh archive always
      // survives; the oldest non-keep archives go until ARCHIVE_KEEP remain
      // per terminal directory.
      const byDir = new Map<string, { p: string; m: number; s: number }[]>();
      for (const f of live) {
        const key = dirname(f.p);
        const arr = byDir.get(key) ?? [];
        arr.push(f);
        byDir.set(key, arr);
      }
      const evict: string[] = [];
      for (const arr of byDir.values()) {
        arr.sort((x, y) => x.m - y.m); // oldest first
        let keepCount = arr.length;
        for (const x of arr) {
          if (keepCount <= ARCHIVE_KEEP) break;
          if (x.p === keepPath) continue;
          evict.push(x.p);
          keepCount--;
        }
      }
      for (const p of evict) {
        try {
          if (insideStore(p)) unlinkSync(p);
        } catch {}
      }
      for (const p of evict) {
        const i2 = live.findIndex((x) => x.p === p);
        if (i2 >= 0 && !existsSync(p)) live.splice(i2, 1);
      }
      let total = live.reduce((a, f) => a + f.s, 0);
      if (total > ARCHIVE_TOTAL) {
        live.sort((a, b) => a.m - b.m);
        for (const f of live) {
          if (total <= ARCHIVE_TOTAL) break;
          if (f.p === keepPath) continue;
          try {
            if (insideStore(f.p)) unlinkSync(f.p);
            total -= f.s; // subtract only after a successful removal
          } catch {
            continue; // try the next eligible archive
          }
        }
      }
    } catch {}
  }

  // Once per process, before this session's first state change: make the
  // store this session's. False when adoption did not complete (unreadable
  // file, or the archive failed): the caller drops the event and the next
  // one retries, so an old history is never silently merged. No id yet:
  // record terminal-keyed and do NOT latch — a late id must still adopt.
  async function adopt(addr: string): Promise<boolean> {
    if (sessionAdopted) return true;
    const mine = mySession();
    if (!mine) return true;
    let ok = true;
    await serialized(() => {
      const st = readState(addr);
      if (st.unreadable) {
        ok = false;
        return;
      }
      if (!st.absent && (st.corrupt || st.session !== mine)) ok = archiveState(addr);
    });
    sessionAdopted = ok;
    return ok;
  }

  // The herdr terminal this omo runs in: hc ls carries no pids, but hc get
  // lists the foreground program, which is this process. omo terminals the
  // core still places in this cwd are tried first, then every other live omo
  // terminal: the core's cwd stays stale after a plain cd (no OSC 7), so the
  // preferred set can hold only other terminals while this one hides in the
  // sweep. hc get calls are capped per attempt, and only a hit is cached —
  // a miss is retried on the next event (addressResolved stays false).
  const GET_CAP = 24;
  // One sweep at a time: concurrent callers — a first prompt racing the
  // session_start warm-up — share the in-flight promise instead of each
  // queuing a full sweep of hc calls behind the other.
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

  function textOf(message: { content?: unknown } | undefined | null): string {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
      .join("\n");
  }

  // hc-relayed messages arrive wrapped in an envelope; keep only the text.
  function unwrapEnvelope(text: string): string {
    const m = /^\s*<hc from="[^"]*">([\s\S]*)<\/hc>\s*$/.exec(text);
    return m ? m[1] : text;
  }

  function prefixes(text: string, fromEnd: boolean): string[] {
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length >= ANCHOR_MIN_LEN);
    const picked = fromEnd ? lines.slice(-ANCHOR_LINES) : lines.slice(0, ANCHOR_LINES);
    return picked.map((l) => (l.length > ANCHOR_PREFIX ? l.slice(0, ANCHOR_PREFIX) : l));
  }

  // State files of terminals that no longer exist: their bookmarks can never
  // be shown again.
  function sweepDead() {
    pi.exec("hc", ["ls", "--json"], { timeout: 5000 })
      .then((r: { code: number; stdout: string }) => {
        if (r.code !== 0) return;
        const parsed = JSON.parse(r.stdout) as { terminals?: Array<{ address?: string }> };
        if (!parsed.terminals?.length) return; // an empty listing is a lie: never sweep on it
        const live = new Set(parsed.terminals.map((t) => t.address));
        for (const f of readdirSync(stateDirOf()).filter((x: string) => x.endsWith(".json"))) {
          try {
            const sweepPath = join(stateDirOf(), f);
          if (!insideStore(sweepPath)) continue; // outside the store: never touch
          chmodSync(sweepPath, 0o600);
          } catch {}
          let addr: string;
          try {
            addr = decodeURIComponent(f.slice(0, -".json".length));
          } catch {
            continue;
          }
          if (!live.has(addr)) archiveState(addr); // a dead terminal's last session is archived, not discarded
        }
      })
      .catch(() => {});
  }

  // Marker gate instead of reading the screen: the signal travels in the
  // event payload itself, so there is no event-commit race to drop a rename
  // and no hc read on this path. Only a raw name whose LAST character is a
  // marker counts (end-attachment convention); a mid-string zero-width
  // character is an emoji component (👩‍💻 = U+1F469 U+200D U+1F4BB) and never
  // triggers. Unmarked names — a rename the person typed by hand, and omo's
  // auto-titles alike — are not recorded.
  pi.on("session_info_changed", async (event: { name?: string }, ctx: unknown) => {
    try {
      sessionOf(ctx);
      const addr = await resolveAddress();
      if (!addr) return;
      const raw = event.name ?? "";
      const lastCh = raw.charAt(raw.length - 1);
      if (!lastCh || !MARKERS.includes(lastCh)) return;
      // Strip the trailing RUN of markers only — never mid-string — then trim;
      // a marker-only name empties out and records nothing.
      let end = raw.length;
      while (end > 0 && MARKERS.includes(raw.charAt(end - 1))) end--;
      // Slice by code points — a UTF-16 unit slice can split a surrogate
      // pair — and trim again after the cut: the 80th code point can be a
      // space.
      const title = Array.from(raw.slice(0, end).trim()).slice(0, 80).join("").trim();
      if (!title) return;
      if (!(await adopt(addr))) return;
      // Through mutate(): unreadable files are never replaced, a file owned
      // by another session is archived before this session's first write,
      // and a stale writer never recreates a reset terminal's file.
      await mutate(addr, (items) => {
        const last = items[items.length - 1];
        if (last && last.title === title) return false;
        items.push({ num: 0, title, ts: Date.now() });
        bound = null; // the pushed item ends any standing pairing: a stray late agent_end must not land its report on the older item; the new item rebinds at its own prompt
        return true;
      });
    } catch {}
  });

  pi.on("message_end", async (event: { message?: { role?: string; content?: unknown } }, ctx: unknown) => {
    try {
      sessionOf(ctx);
      if (event.message?.role !== "user") return;
      const text = textOf(event.message);
      if (!text.trim()) return;
      if (text.trim().startsWith("/")) return;
      const anchor = prefixes(text, false);
      const prompt = unwrapEnvelope(text).trim().slice(0, PROMPT_MAX);
      const addr = await resolveAddress();
      if (!addr) return;
      await mutate(addr, (items) => {
        // The prompt fills only the LAST item, and only while it has none: the
        // prompt belongs to this turn's own bookmark. A steering message after
        // the prompt already filled — or a turn whose marked rename never
        // happened, leaving nothing fresh to fill — writes nothing and breaks
        // any previous binding, so a later report cannot land on an older
        // item.
        const last = items[items.length - 1];
        if (!last || last.promptAnchor) {
          bound = null;
          return false;
        }
        last.promptAnchor = anchor;
        last.prompt = prompt;
        bound = { ts: last.ts, title: last.title };
        return true;
      });
    } catch {}
  });

  pi.on("agent_end", async (event: { messages?: Array<{ role?: string; content?: unknown }> }, ctx: unknown) => {
    try {
      sessionOf(ctx);
      // event.messages holds the whole run; the last assistant text in it is
      // the final report, whatever tool-call sub-turns ran before it. Writing
      // on every agent_end (retries included) leaves the last run's answer on
      // the item. The /rename confirmation is a run too; skip its one-liner.
      let text = "";
      for (const m of Array.isArray(event.messages) ? event.messages : []) {
        if (m?.role !== "assistant") continue;
        const t = textOf(m).trim();
        if (t) text = t;
      }
      if (!text) return;
      if (text.length < 240 && /session name set|세션 이름|thread_rename|rename/i.test(text)) return;
      const anchor = prefixes(text, true);
      // Conclusions and next steps live at the end; overflow keeps the tail.
      const report = text.length > REPORT_MAX ? text.slice(-REPORT_MAX) : text;
      const addr = await resolveAddress();
      if (!addr) return;
      await mutate(addr, (items) => {
        // Only the item this turn's prompt bound — found by identity, since
        // the slice and resets can have moved it since. No binding (missed
        // rename, steering turn, /new, foreign reset) or no match writes
        // nothing. The binding survives, so a retry refreshes the same item.
        const id = bound;
        if (!id) return false;
        const it = items.find((x) => x.ts === id.ts && x.title === id.title);
        if (!it) return false;
        if (anchor.length) it.reportAnchor = anchor;
        it.report = report;
        return true;
      });
    } catch {}
  });

  pi.on("session_start", async (event: { reason?: string }, ctx: unknown) => {
    try {
      sessionOf(ctx);
      // Warm the sweep for EVERY start reason: a first prompt in a fresh or
      // resumed session then shares the in-flight resolution instead of
      // queueing its own hc sweep behind it.
      resolveAddress().catch(() => {});
      if (event.reason !== "new") return;
      bound = null; // the reset ends the previous turn sequence: no report pairs across it
      const addr = await resolveAddress();
      if (!addr) return;
      await serialized(() => {
        // Only when this session has not adopted the store yet: once it has,
        // the file on disk is this session's own, and the /new race must not
        // archive it (a mid-session /new resets through the id change).
        if (sessionAdopted) return;
        sessionAdopted = archiveState(addr);
        if (sessionAdopted) ownWrites = 0; // a reset by us: later absences are not stale
        resetPending = !sessionAdopted; // blocked: retry the reset on the next event
      });
    } catch {}
  });

  try {
    sweepDead();
  } catch {}
}
