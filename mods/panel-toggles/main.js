// Files and Changes toggles for the right-hand panel, drawn at the window's
// bottom right. The panel is remembered per space, as the shipped tab bar did:
// switching spaces shows that space's choice, and opening or closing records it.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, run, spaces } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const PANELS = [
  { id: "files", label: "Files", icon: "mods/files/file.svg" },
  { id: "changes", label: "Changes", icon: "mods/changes/changes.svg" },
];

export default class PanelToggles extends View {
  init() {
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.space = undefined;
    this.pending = null;
  }

  toggle(id) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body?.children?.some((c) => c.id === id)) return;
    if (!panel.hidden && body.active === id) {
      run("layout.hide", { id: "panel" });
    } else {
      run("layout.select", { stack: "panel-body", child: id });
      run("layout.show", { id: "panel" });
    }
  }

  // Until a restore lands (or something else won), the old state isn't a choice.
  sync(space, panel, body) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null;
        const want = PANELS.some((p) => p.id === stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            run("layout.select", { stack: "panel-body", child: want });
            run("layout.show", { id: "panel" });
          } else {
            run("layout.hide", { id: "panel" });
          }
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    this.sync(space, panel, body);
    const on = (id) => panel && !panel.hidden && body?.active === id;
    return h_flex().size_full().items_center().justify_end().pr(8).gap(3)
      .bg(t.chrome).border_t(1).border_color(t.border)
      .children(PANELS.map((p) => h_flex().id(`panel-${p.id}`)
        .h(22).px(7).gap(5).flex_none().items_center().rounded(5).text_size(11.5)
        .bg(on(p.id) ? t.selected : t.chrome)
        .text_color(on(p.id) ? t.foreground : t.dim)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => this.toggle(p.id))
        .child(svg(p.icon).size(13))
        .child(div().child(p.label))));
  }
}
