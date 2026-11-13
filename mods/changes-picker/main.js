import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: line };
  });
}

// A change's one-letter mark, colored the way the list and the picker show it.
const statusColor = (f, t) => f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked;
const splitPath = (path) => {
  const parts = path.split("/"), name = parts.pop();
  return [parts.length ? parts.join("/") + "/" : "", name];
};

// Diff tints follow the usual editor palette: saturated blocks on a dark
// theme, the pale counterparts on a light one. The theme's ansi red and green
// are too muted to read as added/removed once composited over the background.
// `herdr.theme()` is a flat color map, so the background's luminance decides.
const onDark = (t) => {
  const n = parseInt(t.background.slice(1, 7), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
};
const diffTone = (t) => onDark(t)
  ? { add: "#173a25", del: "#451b1f", plus: "#7bd88f", minus: "#ff8a8a" }
  : { add: "#e6ffec", del: "#ffebe9", plus: "#1a7f37", minus: "#cf222e" };

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.picker = false; this.query = "";
    this.search = InputState.new({ placeholder: "Filter files" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value();
      cx.notify();
    });
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null;
      this.watched = null; this.limited = false;
      this.picker = false; this.query = ""; this.search.set_value("");
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map(row => (row.text.length + 1) * 7 + 50));
  }

  togglePicker(cx) {
    this.picker = !this.picker;
    if (this.picker) {
      this.query = ""; this.search.set_value("");
      // The field mounts on this frame; focus it once the frame is laid out.
      cx.timer.after(50, () => this.search.focus());
    }
    cx.notify();
  }

  pick(path, cx) {
    this.picker = false; this.query = ""; this.search.set_value(""); this.note = null;
    if (this.open === path) { cx.notify(); return; }
    this.open = path; this.setLines([]);
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t, d) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const tone = kind === "+" ? d.plus : kind === "-" ? d.minus : t.dim;
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(d.add)).when(kind === "-", (e) => e.bg(d.del))
      .child(h_flex().flex_none().gap(4)
        .child(div().w(30).flex_none().text_right().text_color(tone).child(number === undefined ? "" : String(number)))
        .child(div().w(8).flex_none().text_color(tone).child(kind === "+" ? "+" : kind === "-" ? "-" : "")))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // The top row names the file whose diff fills the panel; pressing it opens
  // the list of changed files.
  pickerBar(t, current) {
    const [dir, name] = current ? splitPath(current.path) : ["", ""];
    return h_flex().flex_none().px(8).pt(8).pb(8)
      .child(h_flex().id("changes-picker").w_full().h(30).px(8).gap(8).items_center().rounded(7).border_1()
        .border_color(this.picker ? t.accent : t.border)
        .bg(this.picker ? t.hover : t.background)
        .when(this.files.length > 0, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.togglePicker(cx)))
        .child(div().w(14).flex_none().text_size(11).text_color(current ? statusColor(current, t) : t.dim).child(current ? current.status : "·"))
        .child(current
          ? h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(dir)).child(div().min_w(0).truncate().child(name))
          : div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.files.length ? "Select a file" : "No changed files"))
        .when(current?.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${current.add}`)))
        .when(current?.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${current.del}`)))
        .child(svg("mods/workspace-chrome/chevron-down.svg").size(11).flex_none().text_color(t.dim)));
  }

  fileRow(f, t) {
    const [dir, name] = splitPath(f.path);
    return h_flex().id(`pick-${f.path}`).h(26).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .when(this.open === f.path, (e) => e.bg(t.selected))
      .when(this.open !== f.path, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(14).flex_none().text_size(11).text_color(statusColor(f, t)).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(dir)).child(div().min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // A card over the diff area: filter field, then the changed files.
  pickerCard(t, matches) {
    const listHeight = Math.min(280, Math.max(30, matches.length * 26 + 8));
    return v_flex().absolute().top(0).left(8).right(8).rounded(8).overflow_hidden().bg(t.popover).border_1().border_color(t.border)
      .child(div().p(6)
        .child(div().h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
          .child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground))))
      .child(div().relative().h(listHeight)
        .child(v_flex().id("changes-picker-list").absolute().inset_0().overflow_y_scroll().p(4).pr(10)
          .children(matches.map((f) => this.fileRow(f, t)))
          .when(!matches.length, (e) => e.child(div().p(8).text_color(t.dim).child("No matching files"))))
        .child(Scrollbar.vertical("changes-picker-list").absolute().inset_0()));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), d = diffTone(t), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const current = this.files.find((f) => f.path === this.open);
    const query = this.query.trim().toLowerCase();
    const matches = query ? this.files.filter((f) => f.path.toLowerCase().includes(query)) : this.files;
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        if (this.picker) { this.picker = false; cx.stop_propagation(); cx.notify(); return; }
        if (this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      .child(this.pickerBar(t, current))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().overflow_hidden().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t, d))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.files.length, (e) => e.child(div().p(12).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"))))
        .when(this.picker, (e) => e
          .child(div().absolute().inset_0().on_mouse_down("left", (_e, cx) => { this.picker = false; cx.notify(); }))
          .child(this.pickerCard(t, matches))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
