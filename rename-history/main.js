// Context menus (Herdr's items), cloned from the shipped `menu` mod, with a
// Rename history section: the /rename titles this terminal has seen, newest
// first. Picking one scrolls the terminal back to that rename's report (or,
// when the end of the turn was not caught, to the prompt line). Opened as a
// popup with props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. A regular item is [label, command, args];
// a command "worktree" opens the worktree dialog instead. A history item is
// { rh: bookmark } and jumps via the tracker. With props.mode "snippet" the
// same mod shows a saved terminal section that could not be located again.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec } from "herdr";
import { ensure, history, jump, watch } from "./tracker.js";

/** @typedef {import("./tracker.js").Bookmark} Bookmark */
/** @typedef {any[]} MenuItem */
/** @typedef {{ rh: Bookmark }} HistRow */

// Where a space is now: its first terminal's live folder, else where it was made.
/** @param {any} s */
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((/** @type {any} */ c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
/** @param {any} folder @param {any} on */
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

/** @param {any} p @param {any} git @returns {MenuItem[]} */
function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["Rename", "pane.rename", { pane: tg.pane }],
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

/** @param {string} command @param {any} args */
function menuIcon(command, args) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? (args?.direction === "down" ? "panel-bottom" : "panel-right") : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
/** @param {string} name @param {any} args */
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

/** @param {number} ts */
function clock(ts) {
  const d = new Date(ts);
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// The popup sizes to its content up to the overlay's height cap; the shown
// bookmarks are capped so the base menu items below always fit.
const MAX_SHOWN = 12;

export default class Menu extends View {
  /** @param {any} _props @param {any} cx */
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.hist = /** @type {Bookmark[]} */ ([]);
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (/** @type {any} */ cx) => {
        try {
          this.git = await checkout(folder, space.machine);
        } catch {
          this.git = null;
        }
        cx.notify();
      });
    const addr = p?.tab === "pane" && p.target?.terminal;
    if (addr)
      cx.spawn(async (/** @type {any} */ cx) => {
        try {
          this.hist = await ensure(addr);
        } catch {}
        cx.notify();
      });
    watch(cx, addr || null);
  }

  /** @returns {(HistRow | MenuItem)[]} */
  list() {
    return [...this.hist.slice(0, MAX_SHOWN).map((it) => ({ rh: it })), ...items(props(), this.git)];
  }

  more() {
    return Math.max(0, this.hist.length - MAX_SHOWN);
  }

  /** @param {number} i @param {any} cx */
  choose(i, cx) {
    const list = this.list();
    const it = list[i];
    if (!it) return;
    if (!Array.isArray(it)) {
      const addr = props()?.target?.terminal;
      if (!addr) {
        closeOverlay(props()?.overlay);
        return;
      }
      // The jump's reads run while this copy still exists; host calls park
      // once every copy has closed, so the overlay closes only afterwards.
      cx.spawn(async () => {
        try {
          await jump(addr, it.rh);
        } catch {}
        closeOverlay(props()?.overlay);
      });
      return;
    }
    closeOverlay(props()?.overlay);
    if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  /** @param {any} t */
  snippet(t) {
    const p = props();
    return v_flex()
      .id("rh-snippet")
      .w_full()
      .h_full()
      .p(14)
      .gap(8)
      .bg(t.popover)
      .text_size(12.5)
      .child(div().font_semibold().child(p.title ?? ""))
      .child(div().text_color(t.dim).child(p.note ?? ""))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .gap(1)
          .children((p.text ?? []).map((/** @type {string} */ l, /** @type {number} */ i) => div().id(`sl-${i}`).text_color(t.foreground).child(l === "" ? " " : l))),
      );
  }

  /** @param {any} cx */
  render(cx) {
    const t = theme();
    if (props()?.mode === "snippet") return this.snippet(t);
    if (props()?.mode === "watch") return div().id("rh-watch").size_full();
    const list = this.list();
    const more = this.more();
    const header = this.hist.length
      ? [div().px(8).pt(4).pb(2).text_size(10.5).text_color(t.dim).child(more ? `RENAME HISTORY · +${more} older` : "RENAME HISTORY")]
      : [];
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        header.concat(
          list.map((/** @type {HistRow|MenuItem} */ it, /** @type {number} */ i) => {
            const prev = list[i - 1];
            const sep =
              i > 0 &&
              Array.isArray(it) &&
              (prev ? (!Array.isArray(prev) ? true : it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && prev[1] !== "app.theme")) : false);
            if (!Array.isArray(it))
              return h_flex()
                .id(`rh-${it.rh.ts}`)
                .h(31)
                .px(8)
                .gap(9)
                .rounded(7)
                .items_center()
                .justify_between()
                .text_color(t.foreground)
                .when(i === this.at, (el) => el.bg(t.selected))
                .hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => this.choose(i, cx))
                .child(svg("mods/rename-history/bookmark.svg").size(13).flex_none().text_color(t.muted))
                .child(div().flex_1().min_w(0).truncate().child(it.rh.title))
                .child(
                  div()
                    .flex_none()
                    .text_size(11)
                    .text_color(it.rh.reportAnchor != null ? t.done : t.dim)
                    .child(`${clock(it.rh.ts)} · ${it.rh.reportAnchor != null ? "report" : "prompt"}`),
                );
            return v_flex()
              .when(sep, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
              .child(h_flex()
              .id(`mi-${i}`)
              .h(31)
              .px(8)
              .gap(9)
              .rounded(7)
              .items_center()
              .justify_between()
              .text_color(t.foreground)
              .when(i === this.at, (el) => el.bg(t.selected))
              .hover((s) => s.bg(t.hover))
              .on_click((_e, cx) => this.choose(i, cx))
              .child(svg(menuIcon(it[1], it[2])).size(14).flex_none().text_color(t.muted))
              .child(div().flex_1().child(it[0]))
              .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2]))));
          }),
        ),
      );
  }
}
