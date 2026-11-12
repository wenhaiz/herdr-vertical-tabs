// Machines, spaces and tabs as one tree: a machine expands to its spaces, a
// space to its tabs. The layout that shows this has no horizontal tab bar;
// this tree replaces it. Open spaces and machines are remembered per window
// in localStorage.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, machines, theme, run, openOverlay, hc, shared, setShared } from "herdr";

const OPEN = "vertical-tabs.open";
const CLOSED = "vertical-tabs.machines";
// Below this the sidebar is a rail: icons only, names in tooltips.
const NARROW = 170;
// Avatar colors shared with the shipped spaces mod, one strong color per hue.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
const PALETTE = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];

export default class SpaceTree extends View {
  init(_props, cx) {
    this.scroll = ScrollHandle.new();
    this.open = new Set(JSON.parse(localStorage.getItem(OPEN) ?? "[]"));
    this.closedMachines = new Set(JSON.parse(localStorage.getItem(CLOSED) ?? "[]"));
    this.width = Infinity;
    this.selected = null; // the tab the list last scrolled to
    this.lastActive = null;
    this.hoveredMachine = null;
    this.machines = []; // hc machine ls: name, state, ...
    this.refreshMachines(cx);
    cx.timer.every(15000, (cx) => this.refreshMachines(cx));
  }

  persist() {
    localStorage.setItem(OPEN, JSON.stringify([...this.open]));
  }

  persistMachines() {
    localStorage.setItem(CLOSED, JSON.stringify([...this.closedMachines]));
  }

  expand(id, open, cx) {
    if (open) this.open.add(id);
    else this.open.delete(id);
    this.persist();
    cx.notify();
  }

  foldMachine(key, cx) {
    if (this.closedMachines.has(key)) this.closedMachines.delete(key);
    else this.closedMachines.add(key);
    this.persistMachines();
    cx.notify();
  }

  refreshMachines(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary);
      } catch {}
      cx.notify();
    });
  }

  // The program a tab runs: an agent's own program wins, else its first pane's.
  program(tab) {
    const ps = panes();
    return ps.find((p) => p.tab === tab.id && p.program?.agent)?.program
      ?? ps.find((p) => p.tab === tab.id)?.program;
  }

  tabName(tab) {
    const program = this.program(tab);
    return /^tb\d+$/.test(tab.name) ? program?.name ?? "Terminal" : tab.name;
  }

  spaceMenu(space) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 300, props: { tab: "space", target: { id: space.id } } });
  }

  tabMenu(space, tab) {
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "tab", target: { id: tab.id, space: space.id } } });
  }

  indicator(status, t) {
    return status === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)
      : div().size(6).rounded(3).flex_none().bg(t[status]);
  }

  // The space's stable colored initial, the same one the shipped spaces mod draws.
  avatar(space, t) {
    const color = (shared("space.colors") ?? {})[space.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center()
      .text_size(10.5).font_bold().text_color("#ffffff")
      .child([...space.name][0]?.toUpperCase() ?? "?");
  }

  programIcon(program, t) {
    if (!program?.icon) return svg("mods/workspace-chrome/terminal.svg").size(13).flex_none().text_color(t.dim);
    return program.tint
      ? svg(program.icon).size(13).flex_none().text_color(t.muted)
      : image(program.icon).size(13).flex_none();
  }

  // A fixed-width cell in the rail, so machine icons, space avatars and tab
  // icons share one column and their status marks share another.
  railSlot(el, width = 18) {
    return div().w(width).flex_none().flex().items_center().justify_center()
      .when(Boolean(el), (d) => d.child(el));
  }

  machineRow(m, t, narrow, current) {
    const key = m ?? "";
    const folded = this.closedMachines.has(key);
    const info = this.machines.find((k) => k.name === m);
    const connected = !m || info?.state === "connected";
    const state = m && info?.state && info.state !== "connected" ? info.state.replace(/_/g, " ") : null;
    const login = m && info?.state === "needs_login" ? `hc machine login ${m}` : null;
    const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(12).flex_none();
    const dot = div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim);
    if (narrow) {
      return h_flex().id(`machine-${key}`).h(26).flex_none().px(6).gap(3).items_center()
        .hover((s) => s.bg(t.hover))
        .when(Boolean(login), (el) => el.tooltip(login))
        .child(this.railSlot(icon))
        .child(this.railSlot(dot, 11));
    }
    // The new-space button stays out of the way except on the machine holding
    // the shown space, or while the pointer is on its row.
    const showNew = current || this.hoveredMachine === key;
    return h_flex().id(`machine-${key}`)
      .h(26).flex_none().px(6).gap(5).rounded(6).items_center().text_size(12.5).text_color(t.dim)
      .hover((s) => s.bg(t.hover))
      .when(Boolean(login), (el) => el.tooltip(login))
      .on_hover((hovered, cx) => {
        if (hovered && this.hoveredMachine !== key) {
          this.hoveredMachine = key;
          cx.notify();
        } else if (!hovered && this.hoveredMachine === key) {
          this.hoveredMachine = null;
          cx.notify();
        }
      })
      .on_click((_e, cx) => this.foldMachine(key, cx))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(10).flex_none())
      .child(icon)
      .child(div().flex_1().min_w(0).truncate().font_bold().child(m ?? "This computer"))
      .when(Boolean(state), (el) => el.child(div().flex_none().max_w(90).truncate().child(state)))
      .child(div().id(`machine-new-${key}`).size(20).flex_none().flex().items_center().justify_center().rounded(4)
        .opacity(showNew ? 1 : 0)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); if (showNew) run("space.new", { machine: m ?? "" }); })
        .child(svg("mods/workspace-chrome/plus.svg").size(11)))
      .child(dot);
  }

  spaceRow(space, t, narrow) {
    const open = this.open.has(space.id);
    // An expanded space leaves the working spinner to its tab rows; collapsed,
    // it is the only place that can show it. Blocked/done marks always stay.
    const status = space.status && (!open || space.status !== "working") ? this.indicator(space.status, t) : null;
    const click = (_e, cx) => {
      if (!space.active) {
        run("space.select", { id: space.id });
        this.expand(space.id, true, cx);
      } else {
        this.expand(space.id, !open, cx);
      }
    };
    if (narrow) {
      return h_flex().id(`space-${space.id}`).h(30).flex_none().px(6).gap(3).rounded(7).items_center()
        .tooltip(`${space.name}${open ? " · open" : ""}`)
        .when(space.active, (el) => el.bg(t.raised))
        .when(!space.active, (el) => el.hover((s) => s.bg(t.hover)))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.spaceMenu(space); })
        .on_click(click)
        .child(this.railSlot(this.avatar(space, t)))
        .child(this.railSlot(status, 11));
    }
    return h_flex().id(`space-${space.id}`)
      .h(30).flex_none().px(7).gap(6).rounded(7).items_center()
      .when(space.active, (el) => el.bg(t.raised))
      .when(!space.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.spaceMenu(space); })
      .on_click(click)
      .child(
        div().id(`chevron-${space.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4)
          .hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.expand(space.id, !open, cx); })
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).text_color(t.dim)))
      .child(this.avatar(space, t))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(space.active ? t.foreground : t.muted).child(space.name))
      .when(Boolean(status), (el) => el.child(status));
  }

  tabRow(space, tab, t, narrow) {
    const program = this.program(tab);
    const name = this.tabName(tab);
    const status = tab.status ? this.indicator(tab.status, t) : null;
    // Only the tab of the space on screen is current: every space keeps its
    // own shown tab, but the other spaces' are just entries in the list.
    const current = space.active && tab.active;
    const focus = () => {
      if (!space.active) run("space.select", { id: space.id });
      run("tab.select", { id: tab.id });
    };
    if (narrow) {
      return h_flex().id(`tab-${tab.id}`).h(34).flex_none().px(6).gap(3).rounded(6).items_center()
        .tooltip(`${space.name} › ${name}`)
        .when(current, (el) => el.bg(t.selected))
        .when(!current, (el) => el.hover((s) => s.bg(t.hover)))
        .when(tab.settled, (el) => el.opacity(0.55))
        .on_mouse_down("left", (e) => { if (e.click_count === 2) run("tab.rename", { id: tab.id }); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.tabMenu(space, tab); })
        .on_click(focus)
        .child(this.railSlot(this.programIcon(program, t)))
        .child(this.railSlot(status, 11));
    }
    return h_flex().id(`tab-${tab.id}`)
      .h(34).flex_none().pl(26).pr(6).gap(6).rounded(6).items_center()
      .when(current, (el) => el.bg(t.selected))
      .when(!current, (el) => el.hover((s) => s.bg(t.hover)))
      .when(tab.settled, (el) => el.opacity(0.55))
      .on_mouse_down("left", (e) => { if (e.click_count === 2) run("tab.rename", { id: tab.id }); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.tabMenu(space, tab); })
      .on_click(focus)
      .child(this.programIcon(program, t))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5)
        .text_color(current ? t.foreground : t.muted).child(tab.zoomed ? `${name} Z` : name))
      .when(Boolean(status), (el) => el.child(status))
      .when(current, (el) => el.child(
        div().id(`close-${tab.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); })
          .child(svg("mods/pane/close.svg").size(11))));
  }

  newTabRow(space, t) {
    return h_flex().id(`new-tab-${space.id}`)
      .h(26).flex_none().pl(26).pr(6).gap(6).rounded(6).items_center()
      .text_size(12).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("tab.new", { space: space.id }))
      .child(svg("mods/workspace-chrome/plus.svg").size(12).flex_none())
      .child(div().child("New tab"));
  }

  emptyRow(m, t) {
    return h_flex().id(`machine-empty-${m ?? "local"}`)
      .h(28).flex_none().pl(8).pr(6).gap(7).rounded(7).items_center()
      .text_size(12).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => run("space.new", { machine: m ?? "" }))
      .child(svg("mods/workspace-chrome/plus.svg").size(12).flex_none())
      .child(div().child(m ? "New space there" : "New space"));
  }

  loadingRow(m, t) {
    return h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().pl(12)
      .items_center().text_size(12).text_color(t.dim).child("Loading…");
  }

  render() {
    const t = theme();
    const narrow = this.width < NARROW;
    const all = spaces();
    const activeSpace = all.find((s) => s.active);

    // Keep every space's avatar color stable and distinct, in the shared map
    // the shipped spaces mod uses so both layouts agree. A transient empty
    // list (the first render) leaves the map alone.
    if (all.length) {
      const ids = new Set(all.map((s) => s.id));
      const stored = shared("space.colors") ?? {};
      const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
      let changed = Object.keys(kept).length !== Object.keys(stored).length;
      for (const space of all) {
        if (kept[space.id] || space.name === "~") continue;
        const uses = (color) => Object.values(kept).filter((v) => v === color).length;
        kept[space.id] = PALETTE.reduce((best, color) => (uses(color) < uses(best) ? color : best));
        changed = true;
      }
      if (changed) setShared("space.colors", kept);
    }

    // The shown space (and its machine) opens when it becomes active
    // elsewhere (a key, a new space), so its tabs are always in the list.
    if (activeSpace && this.lastActive !== activeSpace.id) {
      this.lastActive = activeSpace.id;
      if (!this.open.has(activeSpace.id)) {
        this.open.add(activeSpace.id);
        this.persist();
      }
      if (this.closedMachines.delete(activeSpace.machine ?? "")) this.persistMachines();
    }

    // Spaces of this computer first, then machines by name. A machine header
    // appears only when there is another machine to tell this one from.
    const remote = [...new Set([...all.map((s) => s.machine).filter(Boolean), ...this.machines.map((m) => m.name)])].sort();
    const groups = remote.length ? [null, ...remote] : [null];

    const rows = [];
    for (const m of groups) {
      const key = m ?? "";
      const mine = all.filter((s) => (s.machine ?? null) === m);
      if (remote.length) rows.push({ key: `machine-${key}`, el: this.machineRow(m, t, narrow, mine.some((s) => s.active)) });
      if (remote.length && this.closedMachines.has(key)) continue;
      if (!mine.length) {
        if (narrow) continue;
        const loading = machines().find((k) => k.name === m)?.layout === "loading";
        rows.push({ key: `empty-${key}`, el: loading ? this.loadingRow(m, t) : this.emptyRow(m, t) });
        continue;
      }
      for (const space of mine) {
        rows.push({ key: space.id, el: this.spaceRow(space, t, narrow) });
        if (!this.open.has(space.id)) continue;
        for (const tab of space.tabs) rows.push({ key: tab.id, el: this.tabRow(space, tab, t, narrow) });
        // The rail is icons only: no "New tab" rows, and so no + buttons.
        if (!narrow) rows.push({ key: `new-${space.id}`, el: this.newTabRow(space, t) });
      }
    }

    const activeTab = activeSpace?.tabs.find((tab) => tab.active);
    const activeIndex = activeTab ? rows.findIndex((r) => r.key === activeTab.id) : -1;
    if (activeTab && activeIndex >= 0) {
      if (this.selected !== activeTab.id) {
        this.selected = activeTab.id;
        this.scroll.scroll_to_item(activeIndex);
      }
    } else {
      // Collapsed or gone: reveal it again when it comes back.
      this.selected = null;
    }

    const measure = (size, cx) => {
      if (Math.abs(size.width - this.width) > 1) {
        this.width = size.width;
        cx.notify();
      }
    };

    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_size_change(measure)
      .child(v_flex().id("vertical-tabs").flex_1().min_h(0).px(narrow ? 0 : 8).pt(6).pb(10)
        .overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        .children(rows.length ? rows.map((r) => r.el) : [
          h_flex().id("vertical-tabs-empty").h(30).px(8).items_center().text_size(12).text_color(t.dim).child("No spaces yet"),
        ]));
  }
}
