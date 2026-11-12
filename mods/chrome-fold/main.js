import { View, div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, shared, setShared, updates, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the narrow rail, or back to the width it had. The rail stays as narrow as
// the rest of the interface allows; the traffic lights float over it.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action) {
    const t = theme();
    return div().id(id).relative().size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    const logo = image("frame/welcome/herdr.png").size(20).rounded(5);
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 4 : 14).pr(collapsed ? 0 : 10).gap(4).items_center().text_size(13.5)
      .when(window()?.platform === "macos" && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(collapsed, el => el.child(div().id("sidebar-unfold").flex_none().p(2).rounded(6)
        .hover(s => s.bg(t.hover)).tooltip("Show the sidebar")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(toggleSidebar)
        .child(logo)))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center().child(logo).child(div().font_semibold().text_color(t.foreground).child("Herdr"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/chrome-fold/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      .when(!collapsed, el => el.child(this.button("settings", svg("mods/chrome-fold/settings.svg").size(15), () => run("app.settings"))
        .tooltip("Settings")
        .when(Boolean(updates().app.ready), el => el.child(div().absolute().top(4).right(4).size(6).rounded_full().bg(t.accent)))))
      .when(!collapsed, el => el.child(this.button("sidebar-toggle", svg("mods/chrome-fold/sidebar.svg").size(15), toggleSidebar)));
  }
}
