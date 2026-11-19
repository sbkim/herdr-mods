// herdr rename-history: keeps the current bookmark list of each Herdr
// terminal in one state file per terminal, under
// ~/.config/herdr-app/data/rename-history/<address>.json, for the Herdr
// rename-history mod. The mod reads the file when its menu opens and never
// polls anything.
//
// Why per-terminal files rather than one append log: a terminal has exactly
// one owning omo process, so each file has a single writer — no lock file is
// needed, and a write is read-modify-write into a temp file followed by an
// atomic rename. Size is bounded by construction: at most MAX_ITEMS
// bookmarks, each a title plus a few short anchor prefixes.
//
// What is recorded, and why from these events (omo 5.1.78, measured):
// - Built-in slash commands never fire the `input` event. /rename is recorded
//   from session_info_changed (payload {type, name}; it carries no cause, so a
//   title an agent or omo itself set is indistinguishable and is recorded
//   too — a known limit).
// - /new is session_start with reason "new"; it resets the screen, so the
//   terminal's file is deleted outright.
// - message_end (role "user") and turn_end carry the message text; short line
//   prefixes of the prompt and of the report's tail serve as scrollback
//   anchors — the mod locates them with one `hc read` at jump time, because
//   neither the extension nor hc can read the view's scroll position. Lines
//   under 4 characters are not distinctive enough to anchor and are dropped.
// - On load, state files whose terminal no longer exists (not in hc ls) are
//   removed.
//
// The extension must never disturb the session: every handler is guarded and
// silent, and nothing is written to the screen.

import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_ITEMS = 50;
const ANCHOR_PREFIX = 60;
const ANCHOR_LINES = 3;
const ANCHOR_MIN_LEN = 4;

const stateDir = join(process.env.HOME ?? "", ".config/herdr-app/data/rename-history");

interface Bookmark {
  title: string;
  ts: number;
  promptAnchor?: string[];
  reportAnchor?: string[];
}

export default function (pi: ExtensionAPI) {
  // Per-session state: the extension factory runs once per session, so this
  // closure never leaks across sessions of a shared daemon.
  let address: string | null = null;
  let addressResolved = false;

  function fileOf(addr: string): string {
    // Remote addresses contain "/" (vps/t7); percent-encoding keeps one file
    // per address.
    return join(stateDir, encodeURIComponent(addr) + ".json");
  }

  function readState(addr: string): Bookmark[] {
    try {
      const j = JSON.parse(readFileSync(fileOf(addr), "utf8")) as { items?: Bookmark[] };
      return Array.isArray(j.items) ? j.items : [];
    } catch {
      return [];
    }
  }

  // Single-writer atomic replace; a failure must never surface in the session.
  function writeState(addr: string, items: Bookmark[]) {
    try {
      mkdirSync(stateDir, { recursive: true });
      const file = fileOf(addr);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, address: addr, items }) + "\n");
      renameSync(tmp, file);
    } catch {}
  }

  function mutate(addr: string, fn: (items: Bookmark[]) => boolean) {
    const items = readState(addr);
    if (!fn(items)) return;
    writeState(addr, items.slice(-MAX_ITEMS));
  }

  // The herdr terminal this omo runs in: hc ls carries no pids, but hc get
  // lists the foreground program, which is this process. Agent terminals in
  // this cwd are tried first, then every live terminal. Resolved once per
  // session and cached.
  async function resolveAddress(): Promise<string | null> {
    if (addressResolved) return address;
    addressResolved = true;
    try {
      const ls = await pi.exec("hc", ["ls", "--json"], { timeout: 5000 });
      if (ls.code !== 0) return null;
      const parsed = JSON.parse(ls.stdout) as { terminals?: Array<{ address?: string; agent?: string; cwd?: string; state?: string }> };
      const all = (parsed.terminals ?? []).filter((t) => t.address && t.state !== "finished");
      const candidates = all.filter((t) => t.agent === "omo" && t.cwd === process.cwd());
      const pool = candidates.length ? candidates : all.slice(0, 12);
      const me = String(process.pid);
      for (const t of pool) {
        const g = await pi.exec("hc", ["get", t.address ?? "", "--json"], { timeout: 5000 });
        if (g.code !== 0) continue;
        const rec = JSON.parse(g.stdout) as { foreground?: { pid?: number } };
        if (rec.foreground && String(rec.foreground.pid) === me) {
          address = t.address ?? null;
          break;
        }
      }
    } catch {
      address = null;
    }
    return address;
  }

  function textOf(message: { content?: unknown } | undefined | null): string {
    const content = message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
      .join("\n");
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
        const live = new Set((parsed.terminals ?? []).map((t) => t.address));
        for (const f of readdirSync(stateDir).filter((x) => x.endsWith(".json"))) {
          const addr = decodeURIComponent(f.slice(0, -".json".length));
          if (!live.has(addr)) {
            try {
              unlinkSync(join(stateDir, f));
            } catch {}
          }
        }
      })
      .catch(() => {});
  }

  pi.on("session_info_changed", async (event: { name?: string }) => {
    try {
      const addr = await resolveAddress();
      if (!addr) return;
      const title = (event.name ?? "").slice(0, 80);
      if (!title) return;
      mutate(addr, (items) => {
        const last = items[items.length - 1];
        if (last && last.title === title) return false;
        items.push({ title, ts: Date.now() });
        return true;
      });
    } catch {}
  });

  pi.on("message_end", async (event: { message?: { role?: string; content?: unknown } }) => {
    try {
      if (event.message?.role !== "user") return;
      const text = textOf(event.message);
      if (!text.trim() || text.trim().startsWith("/")) return;
      const anchor = prefixes(text, false);
      if (!anchor.length) return;
      const addr = await resolveAddress();
      if (!addr) return;
      mutate(addr, (items) => {
        for (let i = items.length - 1; i >= 0; i--) {
          if (!items[i].promptAnchor) {
            items[i].promptAnchor = anchor;
            return true;
          }
        }
        return false;
      });
    } catch {}
  });

  pi.on("turn_end", async (event: { message?: { role?: string; content?: unknown } }) => {
    try {
      const anchor = prefixes(textOf(event.message), true);
      if (!anchor.length) return;
      const addr = await resolveAddress();
      if (!addr) return;
      mutate(addr, (items) => {
        for (let i = items.length - 1; i >= 0; i--) {
          if (!items[i].reportAnchor) {
            items[i].reportAnchor = anchor;
            return true;
          }
        }
        return false;
      });
    } catch {}
  });

  pi.on("session_start", async (event: { reason?: string }) => {
    try {
      if (event.reason !== "new") return;
      const addr = await resolveAddress();
      if (!addr) return;
      try {
        unlinkSync(fileOf(addr));
      } catch {}
    } catch {}
  });

  try {
    sweepDead();
  } catch {}
}
