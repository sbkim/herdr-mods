// rename-history tracker: state-file reader for the Herdr rename-history mod.
//
// The omo extension (~/.omo/agent/extensions/herdr-rename-history) keeps one
// JSON file per terminal under data/rename-history/<address>.json: the
// terminal's current bookmarks, each a title with short line-prefix anchors of
// the prompt and of the report's tail. The file is written by that terminal's
// omo alone, through a temp file and an atomic rename, and is bounded to the
// last 50 bookmarks. This module reads it — when the menu opens, while it is
// open through watchFolder, and once via hc read at jump time to locate an
// anchor. No timers, no terminal polling.
//
// Jump: rows are located by anchor text, not by stored row numbers — the
// scrollback reflows and neither side can read the view's scroll position at
// event time. The report anchor is the report's last lines; the prompt anchor
// its first lines. Exact run first, then single prefixes, then a snippet.

import { panes, hc, run, openOverlay, appHome, watchFolder, readTextFile } from "herdr";

/**
 * @typedef {Object} Bookmark
 * @property {string} title
 * @property {number} ts
 * @property {string[]|null} promptAnchor
 * @property {string[]|null} reportAnchor
 */

/** @type {Record<string, Bookmark[]>} */
let byAddr = {};

const STATE_DIR = appHome() + "/data/rename-history";
const DATA_DIR = appHome() + "/data";
const HC_NOTE = /^\[hc\] incomplete:/;

/** @param {string} addr @returns {string} */
function fileOf(addr) {
  return STATE_DIR + "/" + encodeURIComponent(addr) + ".json";
}

/** @param {string} addr @returns {Promise<Bookmark[]>} */
async function load(addr) {
  const text = await readTextFile(fileOf(addr));
  let items = [];
  try {
    const j = text ? JSON.parse(text) : null;
    if (j && Array.isArray(j.items)) items = j.items;
  } catch {}
  byAddr[addr] = items;
  return items;
}

/** @param {string} addr @returns {Promise<Bookmark[]>} */
export async function ensure(addr) {
  if (!addr) return [];
  return await load(addr).catch(() => /** @type {Bookmark[]} */ ([]));
}

/** @param {string} addr @returns {Bookmark[]} */
export function history(addr) {
  return (byAddr[addr] ?? []).slice().reverse();
}

// Keep the menu fresh while it is open: the directory's files change whenever
// the extension replaces a state file. The watch dies with the copy.
/** @param {any} cx @param {string|null} addr */
export function watch(cx, addr) {
  cx.spawn(async (/** @type {any} */ cx) => {
    for (;;) {
      const w = watchFolder(DATA_DIR);
      await w;
      if (addr) await load(addr).catch(() => {});
      cx.notify();
    }
  });
}

/** @param {string[]} args @returns {Promise<import("herdr").ExecResult|null>} */
async function hcOrNull(args) {
  try {
    return await hc(args);
  } catch {
    return null;
  }
}

/** @param {string[]} out @param {string[]} anchor @returns {number|null} row of the anchor's last line */
function findRun(out, anchor) {
  const last = anchor[anchor.length - 1];
  for (let i = out.length - 1; i >= 0; i--) {
    if (!out[i].trim().startsWith(last)) continue;
    let at = i;
    let ok = true;
    for (let a = anchor.length - 2; a >= 0; a--) {
      let found = -1;
      for (let j = at - 1; j >= Math.max(0, at - 6); j--) {
        if (out[j].trim().startsWith(anchor[a])) {
          found = j;
          break;
        }
      }
      if (found < 0) {
        ok = false;
        break;
      }
      at = found;
    }
    if (ok) return i;
  }
  return null;
}

/** @param {string[]} out @param {string[]} anchor @returns {number|null} row of the anchor's last matching line */
function findPrefix(out, anchor) {
  for (let a = anchor.length - 1; a >= 0; a--) {
    for (let i = out.length - 1; i >= 0; i--)
      if (out[i].trim().startsWith(anchor[a])) return i;
  }
  return null;
}

/** @param {string} address @param {Bookmark} it */
export async function jump(address, it) {
  run("pane.focus", { terminal: address });
  const r = await hcOrNull(["read", address, "--lines", "400"]);
  const p = panes().find((x) => x.terminal === address);
  const sc = p && p.scroll;
  if (!r) return snippet(it, null, "Could not read the terminal.");
  const out = (r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout).split("\n").filter((l) => !HC_NOTE.test(l));
  const base = sc ? sc.total - out.length : 0;
  let at = null;
  if (it.reportAnchor) at = findRun(out, it.reportAnchor) ?? findPrefix(out, it.reportAnchor);
  if (at == null && it.promptAnchor) at = findRun(out, it.promptAnchor) ?? findPrefix(out, it.promptAnchor);
  if (at == null || !sc) {
    const text = out.slice(-40);
    return snippet(it, text, "The position is no longer in the scrollback; showing the terminal's tail instead.");
  }
  run("terminal.scroll", { lines: base + at - sc.offset - 2, terminal: address });
}

/** @param {Bookmark} it @param {string[]|null} text @param {string} note */
function snippet(it, text, note) {
  openOverlay({
    mod: "rename-history",
    kind: "dialog",
    width: 640,
    height: 420,
    props: { mode: "snippet", title: it.title, note, text: text ?? [] },
  });
}
