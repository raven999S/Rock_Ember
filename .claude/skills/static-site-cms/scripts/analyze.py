#!/usr/bin/env python3
"""Survey a static site so cms.config.json can be written from facts, not guesses.

Usage: python3 analyze.py [site_root]   (default: current directory)

Prints a Markdown report: pages, redirects, build-tool hints, repeated sibling
patterns (candidates for "repeat"), selectors the page's own scripts touch
(candidates for "locked"), image folders (for "assetsDir") and the :root CSS
custom properties (for the admin's "site" theme preset). Standard library only.
"""
import os
import re
import sys
from collections import Counter, defaultdict
from html.parser import HTMLParser

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
SKIP_DIRS = {".git", "node_modules", ".claude", "admin", "vendor", "dist-admin", "__pycache__"}
GENERATOR_HINTS = {
    "package.json": "Node project — check whether the HTML is build output (edit the sources instead).",
    "_config.yml": "Jekyll site — HTML is generated from Markdown/Liquid; this editor fits only the built output.",
    "hugo.toml": "Hugo site — HTML is generated; edit content/ instead.",
    "config.toml": "Possibly Hugo — HTML may be generated.",
    "astro.config.mjs": "Astro project — HTML is generated.",
    "next.config.js": "Next.js project — not a static HTML site.",
    "vite.config.js": "Vite project — index.html may be a build entry.",
    "eleventy.config.js": "Eleventy site — HTML is generated.",
    ".eleventy.js": "Eleventy site — HTML is generated.",
}


def sig(tag, attrs):
    cls = (attrs.get("class") or "").split()
    return tag + "".join("." + c for c in sorted(cls)[:3])


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []  # [(sig, Counter of child sigs)]
        self.repeats = Counter()
        self.ids = []
        self.data_attrs = Counter()
        self.imgs = []
        self.title = ""
        self._in_title = False
        self.scripts = []
        self._script = None
        self.styles = []
        self._style = None
        self.refresh = None
        self.tags = Counter()

    def handle_starttag(self, tag, attrs_list):
        attrs = {k: (v or "") for k, v in attrs_list}
        self.tags[tag] += 1
        if self.stack:
            self.stack[-1][1][sig(tag, attrs)] += 1
        if "id" in attrs:
            self.ids.append((tag, attrs["id"]))
        for k in attrs:
            if k.startswith("data-"):
                self.data_attrs[k] += 1
        if tag == "img" and attrs.get("src"):
            self.imgs.append(attrs["src"])
        if tag == "meta" and attrs.get("http-equiv", "").lower() == "refresh":
            self.refresh = attrs.get("content", "")
        if tag == "title":
            self._in_title = True
        if tag == "script":
            self._script = [] if not attrs.get("src") else None
            if attrs.get("src"):
                self.scripts.append("external: " + attrs["src"])
        if tag == "style":
            self._style = []
        if tag not in VOID:
            self.stack.append((sig(tag, attrs), Counter()))

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag == "script" and self._script is not None:
            self.scripts.append("".join(self._script))
            self._script = None
        if tag == "style" and self._style is not None:
            self.styles.append("".join(self._style))
            self._style = None
        # pop to the matching tag (tolerates implied end tags)
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0].split(".")[0] == tag:
                while len(self.stack) > i:
                    parent_sig, kids = self.stack.pop()
                    for child, n in kids.items():
                        if n >= 2:
                            self.repeats[(parent_sig, child)] += n
                break

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._script is not None:
            self._script.append(data)
        if self._style is not None:
            self._style.append(data)


SCRIPT_SELECTOR = re.compile(r"""(?:getElementById|querySelector(?:All)?|closest|matches)\(\s*['"]([^'"]+)['"]""")
SCRIPT_MUTATION = re.compile(r"\.(hidden|textContent|innerHTML|innerText|className|src)\s*=|\.(appendChild|insertBefore|append|prepend|remove|replaceChildren|setAttribute|classList\.(?:add|remove|toggle))\(")
ROOT_VARS = re.compile(r":root\s*\{([^}]*)\}", re.S)


def analyze(root):
    root = os.path.abspath(root)
    out = [f"# Static site survey: `{root}`\n"]

    hints = [f"- `{f}` — {msg}" for f, msg in GENERATOR_HINTS.items() if os.path.exists(os.path.join(root, f))]
    out.append("## Build tooling\n")
    out.append("\n".join(hints) if hints else "- None found: looks like hand-written HTML (good fit).")

    pages = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS and not d.startswith(".")]
        for fn in fns:
            if fn.lower().endswith((".html", ".htm")):
                pages.append(os.path.relpath(os.path.join(dp, fn), root).replace(os.sep, "/"))
    pages.sort()

    out.append("\n## Pages\n")
    parsed = {}
    for p in pages:
        with open(os.path.join(root, p), encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        pg = Page()
        pg.feed(text)
        parsed[p] = pg
        flag = f" — **redirect** (`{pg.refresh}`), leave out of `pages`" if pg.refresh else ""
        out.append(f"- `{p}` — {len(text):,} chars, title “{pg.title.strip()}”, {sum(pg.tags.values())} elements, {len(pg.scripts)} script(s){flag}")

    img_dirs = Counter()
    for p, pg in parsed.items():
        if pg.refresh:
            continue
        out.append(f"\n## `{p}`\n")
        out.append("### Repeated siblings (candidates for `repeat`)\n")
        rows = sorted(pg.repeats.items(), key=lambda kv: -kv[1])[:25]
        out.extend(f"- `{parent}` > `{child}` ×{n}" for (parent, child), n in rows)
        if pg.ids:
            out.append("\n### Elements with ids\n")
            out.append(", ".join(f"`{t}#{i}`" for t, i in pg.ids[:60]))
        if pg.data_attrs:
            out.append("\n### data-* attributes (often script hooks or labels → `fields` / `outline`)\n")
            out.append(", ".join(f"`{k}`×{n}" for k, n in pg.data_attrs.most_common(20)))
        js = "\n".join(s for s in pg.scripts if not s.startswith("external: "))
        ext = [s for s in pg.scripts if s.startswith("external: ")]
        if js or ext:
            out.append("\n### Scripts (anything they rewrite at runtime belongs in `locked`)\n")
            if ext:
                out.append("External: " + ", ".join(f"`{s[10:]}`" for s in ext))
            sels = Counter(SCRIPT_SELECTOR.findall(js))
            if sels:
                out.append("Selectors referenced: " + ", ".join(f"`{s}`" for s, _ in sels.most_common(40)))
            muts = Counter(m[0] or m[1] for m in SCRIPT_MUTATION.findall(js))
            if muts:
                out.append("DOM writes: " + ", ".join(f"`{k}`×{n}" for k, n in muts.most_common()))
            if "createElement" in js:
                out.append("Creates elements at runtime (`createElement`) — those have no source and are never editable; lock their containers.")
        for src in pg.imgs:
            if not re.match(r"^(https?:|data:|//)", src):
                img_dirs[os.path.dirname(os.path.normpath(os.path.join(os.path.dirname(p), src))).replace(os.sep, "/") or "."] += 1
        css = "\n".join(pg.styles)
        roots = ROOT_VARS.findall(css)
        if roots:
            out.append("\n### :root custom properties (seed for the admin's `site` theme)\n")
            props = re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", "\n".join(roots))
            out.append("\n".join(f"- `{k}: {v.strip()}`" for k, v in props[:40]))

    out.append("\n## Images\n")
    out.append("\n".join(f"- `{d}/` — {n} image(s)" for d, n in img_dirs.most_common()) or "- none")
    return "\n".join(out)


if __name__ == "__main__":
    print(analyze(sys.argv[1] if len(sys.argv) > 1 else "."))
