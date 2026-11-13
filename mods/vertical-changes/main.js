import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
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

// Numbers every diff line once, old and new, the way a side-by-side gutter
// shows them: a deletion has only the old number, an addition only the new.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, oldNumber: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, newNumber: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") return { kind, oldNumber: old++, newNumber: next++, text: untab(line.slice(1)) || " " };
    return { kind: "", text: line };
  });
}
// A file's horizontal extent: two number columns, the +/− mark and the code.
const diffWidth = (rows) => Math.max(360, ...rows.map((row) => (row.text.length + 1) * 7 + 130));

// A change's one-letter mark, colored the way the file list shows it.
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
    this.files = []; this.diffs = new Map(); this.expanded = new Set();
    this.loading = false; this.loadId = 0; this.message = ""; this.handle = cx.focus_handle();
    this.query = "";
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
      this.context = context; this.root = null; this.files = []; this.diffs = new Map(); this.expanded.clear();
      this.signature = null; this.message = ""; this.input.set_value(""); this.error = null; this.note = null;
      this.watched = null; this.limited = false; this.query = ""; this.search.set_value("");
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.diffs = new Map(); this.error = "Not a git repository"; return; }
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
        // Reload the diffs only when the file list itself changed; the timer
        // and the folder watch must not re-run git diff for every file.
        const signature = files.map((f) => `${f.path}\0${f.status}\0${f.add}\0${f.del}`).join("\n");
        const reload = signature !== this.signature;
        this.signature = signature;
        if (reload) {
          const generation = ++this.loadId;
          cx.spawn(async (cx) => this.loadDiffs(files, context, generation, cx));
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // Every file's diff is loaded up front, so one scroll shows them all.
  async loadDiffs(files, context, generation, cx) {
    this.diffs = new Map();
    cx.notify();
    for (const file of files) {
      if (this.loadId !== generation || key() !== context) return;
      try {
        const rows = diffRows(await this.fetchLines(file));
        if (this.loadId !== generation || key() !== context) return;
        this.diffs.set(file.path, { rows, width: diffWidth(rows) });
      } catch {
        this.diffs.set(file.path, { rows: [], width: 360, error: "Cannot preview this diff (too large or unreadable)" });
      }
      cx.notify();
    }
  }

  async fetchLines(file) {
    const root = this.root, on = this.on;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", file.path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    return lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);
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

  diffRow({ kind, oldNumber, newNumber, text }, t, d) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const tone = kind === "+" ? d.plus : kind === "-" ? d.minus : t.dim;
    return h_flex().w_full().h(20).flex_none().pl(6).gap(6).when(kind === "+", (e) => e.bg(d.add)).when(kind === "-", (e) => e.bg(d.del))
      .child(div().w(34).flex_none().text_right().text_color(kind === "+" ? t.dim : tone).child(oldNumber === undefined ? "" : String(oldNumber)))
      .child(div().w(34).flex_none().text_right().text_color(kind === "-" ? t.dim : tone).child(newNumber === undefined ? "" : String(newNumber)))
      .child(div().w(8).flex_none().text_color(tone).child(kind === "+" ? "+" : kind === "-" ? "-" : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // One file's card: a header that folds it, then its diff.
  fileSection(file, t, d, cx) {
    const open = this.expanded.has(file.path);
    const [dir, name] = splitPath(file.path);
    return v_flex().flex_none().rounded(8).overflow_hidden().relative()
      .child(h_flex().id(`file-head-${file.path}`).h(30).flex_none().px(8).gap(6).items_center().bg(t.raised).rounded_t(8).cursor_pointer()
        .when(!open, (el) => el.rounded_b(8))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (open) this.expanded.delete(file.path);
          else this.expanded.add(file.path);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim))
        .child(div().flex_none().text_size(11).text_color(statusColor(file, t)).child(file.status))
        .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(dir)).child(div().min_w(0).truncate().text_color(t.foreground).child(name)))
        .when(file.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(d.plus).child(`+${file.add}`)))
        .when(file.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(d.minus).child(`−${file.del}`))))
      .when(open, (el) => el.child(this.fileDiff(file, t, d)))
      .child(div().absolute().inset_0().rounded(8).border_1().border_color(t.border));
  }

  fileDiff(file, t, d) {
    const state = this.diffs.get(file.path);
    // Every piece draws the card's border on its own edges, so the 1px line
    // follows each rounded corner instead of being clipped square.
    const note = (text, color) => div().px(12).py(8).text_size(11).text_color(color).rounded_b(8).child(text);
    if (!state) return note("Loading diff…", t.dim);
    if (state.error) return note(state.error, t.ansi1);
    if (!state.rows.length) return note("No text diff", t.dim);
    // The card's overflow is clipped square, so the last row's tint is carried
    // into a rounded bottom strip; without it the color shows past the corner.
    const last = state.rows[state.rows.length - 1];
    const tone = last.kind === "+" ? d.add : last.kind === "-" ? d.del : last.kind === "@" ? t.raised : t.background;
    return v_flex().w_full()
      .child(div().relative().w_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(state.width).font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
          .children(state.rows.map((row) => this.diffRow(row, t, d)))))
      // 16px tall so the 8px bottom radius is not clamped to half the box.
      .child(div().w_full().h(16).flex_none().rounded_b(8).bg(tone));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), d = diffTone(t), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const query = this.query.trim().toLowerCase();
    const shown = query ? this.files.filter((f) => f.path.toLowerCase().includes(query)) : this.files;
    const allOpen = this.files.length > 0 && this.files.every((f) => this.expanded.has(f.path));
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
          .child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
        // The summary cluster is one control: hover or click anywhere on it.
        .child(h_flex().h(28).px(6).rounded(6).gap(8).items_center()
          .when(this.files.length > 0, (el) => el.cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .tooltip(allOpen ? "Collapse all" : "Expand all")
            .on_click((_e, cx) => {
              if (allOpen) this.expanded.clear();
              else for (const f of this.files) this.expanded.add(f.path);
              cx.notify();
            }))
          .child(div().px(5).py(1).rounded(4).text_size(11).text_color(t.muted).child(`${this.files.length} files`))
          .child(div().text_size(11).text_color(d.plus).child(`+${add}`)).child(div().text_size(11).text_color(d.minus).child(`−${del}`))
          .when(this.files.length > 0, (el) => el.child(svg(`mods/vertical-changes/${allOpen ? "collapse" : "expand"}.svg`).size(14).flex_none().text_color(t.dim)))))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative()
        .when(shown.length > 0, (el) => el
          .child(v_flex().id("changes-files").absolute().inset_0().overflow_y_scroll().p(6).pr(12).gap(10)
            .children(shown.map((file) => this.fileSection(file, t, d, cx))))
          .child(Scrollbar.vertical("changes-files").absolute().inset_0()))
        .when(!shown.length, (el) => el.child(h_flex().absolute().inset_0().items_center().justify_center().p(16).text_color(t.dim).child(
          this.files.length ? "No matching files" : this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
