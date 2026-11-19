// Terminal numbers: a pane header (the shipped `pane` header plus a big
// number badge) and a manager popup. Click a badge — or run
// `herdr-app do mod.open --name terminal-numbers` — to open the manager.
//
// Rules:
// - Numbers are sticky, kept in shared state ("terminal-numbers.map",
//   {address: number}); rearranging panes never renumbers.
// - A new pane terminal takes the smallest free number; a closed terminal
//   frees its number (a parked one keeps it while it lives).
// - "Renumber by position" reassigns 1..N in panes() order: the layout
//   tree's reading order (columns left to right, each top to bottom).
// - First run adopts seed.json in this folder if present (delete it to
//   fall back to herdr.num labels, else layout order).
//
// Outside the app: numbers.json in this folder maps numbers to terminal
// addresses, and every terminal carries its number as the `herdr.num`
// label, which `hc get <t>` shows.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  panes, terminals, props, run, theme, home, layout, shared, setShared,
  openOverlay, closeOverlay, checking, hc, readTextFile, writeTextFile, appHome,
} from "herdr";

const KEY = "terminal-numbers.map";
const FOLDER = appHome() + "/mods/terminal-numbers";
const JSON_PATH = FOLDER + "/numbers.json";
const SEED_PATH = FOLDER + "/seed.json";

// ---- numbers --------------------------------------------------------

function map() {
  const m = shared(KEY);
  return m && typeof m === "object" ? m : {};
}

// Pane terminals on this machine, in the layout tree's reading order
// (columns left to right, each column top to bottom).
function paneTerminals() {
  return panes().map((p) => p.terminal).filter((t) => t && !t.includes("/"));
}

function liveLocals() {
  return new Set(terminals().map((t) => t.address).filter((a) => !a.includes("/")));
}

let booted = false;    // boot() has run
let assigning = false; // auto-assignment may start

// Drop closed terminals' numbers, give new pane terminals the smallest free
// one. Idempotent; returns the current map.
function ensure() {
  const before = map();
  const live = liveLocals();
  const next = {};
  for (const addr of Object.keys(before)) if (live.has(addr)) next[addr] = before[addr];
  if (assigning) {
    const taken = new Set(Object.values(next));
    for (const addr of paneTerminals()) {
      if (next[addr] != null) continue;
      let n = 1;
      while (taken.has(n)) n++;
      next[addr] = n;
      taken.add(n);
    }
  }
  if (!same(before, next)) setShared(KEY, next);
  return next;
}

function same(a, b) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

// 1..N over the panes' layout order; paneless (parked) terminals lose their
// numbers until they have a pane again.
function renumber() {
  const next = {};
  paneTerminals().forEach((addr, i) => { next[addr] = i + 1; });
  setShared(KEY, next);
}

// Change one terminal's number; a taken number swaps with its owner.
function setNumber(addr, n) {
  n = Math.floor(n);
  if (!(n >= 1)) return;
  const m = map();
  const was = m[addr];
  m[addr] = n;
  const other = Object.keys(m).find((a) => a !== addr && m[a] === n);
  if (other != null) m[other] = was ?? smallestFree(m);
  setShared(KEY, m);
}

function smallestFree(m) {
  let n = 1;
  while (Object.values(m).includes(n)) n++;
  return n;
}

// First run: seed.json wins, then herdr.num labels, then layout order.
function boot(cx) {
  if (booted) return;
  booted = true;
  if (shared(KEY) != null || checking()) { assigning = true; return; }
  cx.spawn(async () => {
    try {
      let seed = null;
      const text = await readTextFile(SEED_PATH);
      if (text) {
        try { seed = JSON.parse(text); } catch { seed = null; }
      }
      if (!seed) {
        seed = {};
        for (const t of terminals()) {
          const n = Number(t.labels?.["herdr.num"]);
          if (!t.address.includes("/") && Number.isInteger(n) && n >= 1) seed[t.address] = n;
        }
        if (!Object.keys(seed).length) return; // ensure()'s layout order stands
      }
      const live = liveLocals();
      const next = {};
      for (const addr of Object.keys(seed)) {
        const n = Number(seed[addr]);
        if (live.has(addr) && Number.isInteger(n) && n >= 1) next[addr] = n;
      }
      if (Object.keys(next).length) setShared(KEY, next);
    } finally {
      assigning = true;
      ensure();
    }
  });
}

// ---- exports: numbers.json + herdr.num labels ------------------------

let persisted = null; // last map serialization handled
let labeled = {};     // address -> number whose label was last sent

// Runs on real changes only; the spawned task reads the newest map, so a
// burst of changes converges to one final write.
function maybePersist(m, cx) {
  const now = JSON.stringify(Object.entries(m).sort((a, b) => a[1] - b[1]));
  if (persisted === now) return;
  persisted = now;
  if (checking()) return;
  cx.spawn(async () => {
    const current = map();
    const panesNow = panes();
    const detail = {};
    for (const addr of Object.keys(current)) {
      const p = panesNow.find((x) => x.terminal === addr);
      detail[addr] = { number: current[addr], title: p?.title ?? null, cwd: p?.cwd ?? null };
    }
    const body = JSON.stringify({
      updated: new Date().toISOString(),
      numbers: Object.fromEntries(Object.entries(current).map(([a, n]) => [String(n), a])),
      terminals: detail,
    }, null, 2) + "\n";
    for (let attempt = 0; attempt < 2; attempt++) {
      const expected = await readTextFile(JSON_PATH);
      try { await writeTextFile(JSON_PATH, body, expected); break; } catch (e) {
        if (attempt === 1) throw e; // stale twice: let the app log it
      }
    }
    for (const addr of Object.keys(current)) {
      if (labeled[addr] === current[addr]) continue;
      labeled[addr] = current[addr];
      try { await hc(["label", addr, "herdr.num=" + current[addr]]); } catch { /* best effort */ }
    }
  });
}

// ---- the header (the shipped pane header plus the badge) -------------

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter((child) => !child.hidden);
    children = [visible.find((child) => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class TerminalNumbers extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, ic, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/terminal-numbers/${ic}.svg`).size(14));
  }

  badge(t, num, id, clickable, terminal) {
    return div()
      .id(id)
      .w(26).h(20).flex_none().flex().items_center().justify_center()
      .rounded(6).bg(t.solid).text_color(t.solid_foreground)
      .text_size(15).font_bold()
      .when(clickable, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85))
        .tooltip("Terminal number — click to manage numbers")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "terminal-numbers", kind: "popup", width: 400, height: 620, props: { pick: terminal } });
        }))
      .child(String(num));
  }

  render(cx) {
    return (props()?.pane == null) ? this.manager(cx) : this.header(cx);
  }

  header(cx) {
    boot(cx);
    const m = ensure();
    maybePersist(m, cx);
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const num = p.terminal ? m[p.terminal] : null;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, (el) => el.border_t(1))
      .when(!bottom, (el) => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx2) => { this.hovered = hovered; cx2.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(num != null, (el) => el.child(this.badge(t, num, `tn-b-${pane}`, true, p.terminal)))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", (el) => el.child(svg("mods/terminal-numbers/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, (el) => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }

  manager(cx) {
    boot(cx);
    const m = ensure();
    maybePersist(m, cx);
    const t = theme();
    const p = props() ?? {};
    const panesNow = panes();
    const rows = Object.keys(m).sort((a, b) => m[a] - m[b]).map((addr) => {
      const pane = panesNow.find((x) => x.terminal === addr);
      // div().flex() (like the badge): the glyph renders; a fixed-width h_flex child did not.
      const step = (id, d, label, tip) => div().id(id).w(26).h(24).flex_none().flex().items_center().justify_center()
        .rounded(6).border_1().border_color(t.border).bg(t.raised)
        .text_color(t.foreground).text_size(15).font_bold().cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .tooltip(tip)
        .on_click(() => setNumber(addr, m[addr] + d))
        .child(label);
      return h_flex()
        .id(`tn-row-${addr}`)
        .h(30).gap(8).items_center().px(8).rounded(8)
        .when(p.pick === addr, (el) => el.bg(t.selected))
        .child(step(`tn-minus-${addr}`, -1, "-", "Lower the number by one; a taken number swaps"))
        .child(this.badge(t, m[addr], `tn-m-${addr}`, false, addr).tooltip(`Terminal address ${addr}`))
        .child(step(`tn-plus-${addr}`, 1, "+", "Raise the number by one; a taken number swaps"))
        .child(div().flex_1().truncate().text_size(12).text_color(t.foreground).child(pane?.title || addr))
        .child(div().flex_none().truncate().max_w(110).text_size(11).text_color(t.dim).child(folder(pane?.cwd)));
    });
    const button = (id, text, primary, action, tip) => h_flex().id(id).h(28).px(12).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).when(Boolean(tip), (el) => el.tooltip(tip)).on_click(action).child(text);
    return v_flex().id("tn-manager").w(400).p(14).gap(8).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(14).font_semibold().child("Terminal numbers"))
        .when(p.overlay != null, (el) => el.child(button("tn-close", "Close", false, () => closeOverlay(p.overlay), "Close the popup (Esc)"))))
      .child(div().text_size(12).text_color(t.muted)
        .child("Use - / + to change a number; duplicates swap"))
      .child(div().text_size(12).text_color(t.muted)
        .child("New terminals take the smallest free number"))
      .child(button("tn-renumber", "Renumber by position", false, () => renumber(),
        "Renumbers 1..N in screen order: columns left to right, each top to bottom. Numbers set by hand are lost."))
      .child(v_flex().id("tn-rows").flex_none().h(Math.min(rows.length, 12) * 32 + 6).overflow_y_scrollbar().gap(2).children(rows))
      .child(div().text_size(10.5).text_color(t.muted)
        .child("numbers.json in this mod's folder maps numbers to addresses; hc get <address> shows the herdr.num label"));
  }
}
