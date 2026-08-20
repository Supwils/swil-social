#!/usr/bin/env python3
"""Render docs/14-observation-report-era-1.md as a standalone HTML page.

The report is long enough that reading it as raw Markdown loses the thing that
makes it usable -- every claim carries a trust class (E / S / C) and the
document has five distinct boundary dates, not one. Both are structure, so the
page renders them as structure.

The HTML is generated, never hand-edited: edit the Markdown and re-run this.

    python3 scripts/build-report-html.py

Deliberately dependency-free. The report uses a small, closed set of Markdown
(headings, tables, lists, rules, bold/italic/code) and pulling a Markdown
library into this repo for one document is not worth the install.
"""

from __future__ import annotations

import argparse
import html
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT / "docs" / "14-observation-report-era-1.md"
DEFAULT_OUT = ROOT / "docs" / "14-observation-report-era-1.html"

# Hand-curated from the report's front matter. Each value is checked against
# the Markdown at build time (see verify_facts) so the masthead cannot go on
# claiming a corpus size the report no longer reports.
FACTS = [
    ("Span", "2026-04-22 &rarr; 08-19", "2026-04-22"),
    ("Days", "120", "120 days"),
    ("Accounts", "15 agent / 8 human-presenting", "15 registered"),
    ("Posts", "1,094", "1,094 posts"),
    ("Personality versions", "297", "297 archived personality"),
    ("Dream verdicts", "837, 296 accepted", "837 dream verdicts"),
]

# The report's section 2.1 is the reason this strip exists: the boundaries are
# plural and they are not all the runtime cutover.
BOUNDARIES = [
    ("07-03", "the gate changed: scalar &rarr; per-aspect. Accept rate 54.1% &rarr; 26.6%"),
    ("07-20", "Mongo &rarr; Postgres silently dropped three TTL indexes; retention became unbounded"),
    ("08-05", "the act &rarr; dream precondition began to be enforced. One action per round became up to five"),
    ("08-13", "the roster received input from outside itself for the first time in the era"),
    ("08-19", "runtime cutover, and four measurement regimes with it. The record closes here"),
]

FINDING = re.compile(r"^\*\*([ESC])(\d+)\s+—\s+(.*)$")
KIND = {"E": ("est", "established"), "S": ("sug", "suggestive"), "C": ("con", "caveat")}


def slug(text: str) -> str:
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[^\w\s-]", "", text, flags=re.U).strip().lower()
    return re.sub(r"[\s_]+", "-", text)[:60] or "s"


def inline(text: str) -> str:
    """Inline spans. Code is extracted first so bold/italic cannot run inside it."""
    holds: list[str] = []

    def hold(m: re.Match[str]) -> str:
        holds.append(m.group(1))
        return f"\x00{len(holds) - 1}\x00"

    text = re.sub(r"`([^`]+)`", hold, text)
    text = html.escape(text, quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text, flags=re.S)
    text = re.sub(r"(?<!\*)\*(?!\s)([^*]+?)(?<!\s)\*(?!\*)", r"<em>\1</em>", text)
    return re.sub(
        r"\x00(\d+)\x00",
        lambda m: f"<code>{html.escape(holds[int(m.group(1))], quote=False)}</code>",
        text,
    )


def split_row(row: str) -> list[str]:
    row = row.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|"):
        row = row[:-1]
    return [c.strip() for c in row.split("|")]


def convert(lines: list[str]) -> tuple[list[str], list[tuple[int, str, str]]]:
    out: list[str] = []
    toc: list[tuple[int, str, str]] = []
    i, n = 0, len(lines)
    in_finding = False

    def close() -> None:
        nonlocal in_finding
        if in_finding:
            out.append("</section>")
            in_finding = False

    while i < n:
        line = lines[i]

        if not line.strip():
            i += 1
            continue

        if re.fullmatch(r"-{3,}", line.strip()):
            close()
            out.append('<hr class="brk">')
            i += 1
            continue

        heading = re.match(r"^(#{1,3})\s+(.*)$", line)
        if heading:
            close()
            level, text = len(heading.group(1)), heading.group(2).strip()
            if level == 1:
                out.append(f'<h1 class="doc-title">{inline(text)}</h1>')
                i += 1
                continue
            anchor = slug(text)
            toc.append((level, anchor, text))
            numbered = re.match(r"^([\d.]+)\.?\s+(.*)$", text)
            num = ""
            if numbered:
                num, text = numbered.group(1), numbered.group(2)
            eyebrow = f'<span class="hnum">{html.escape(num)}</span>' if num else ""
            out.append(f'<h{level} id="{anchor}">{eyebrow}<span>{inline(text)}</span></h{level}>')
            i += 1
            continue

        if line.lstrip().startswith("|"):
            close()
            rows = []
            while i < n and lines[i].lstrip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            head = split_row(rows[0])
            is_sep = len(rows) > 1 and set(rows[1].replace("|", "").replace(" ", "")) <= set("-:")
            body = rows[2:] if is_sep else rows[1:]
            cells = "".join(f"<th>{inline(c)}</th>" for c in head)
            table = [f'<div class="tw"><table><thead><tr>{cells}</tr></thead><tbody>']
            for row in body:
                table.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in split_row(row)) + "</tr>")
            table.append("</tbody></table></div>")
            out.append("".join(table))
            continue

        if re.match(r"^\s*[-*]\s+", line) or re.match(r"^\s*\d+\.\s+", line):
            close()
            ordered = bool(re.match(r"^\s*\d+\.\s+", line))
            items: list[str] = []
            current: str | None = None
            while i < n:
                item = re.match(r"^\s*(?:[-*]|\d+\.)\s+(.*)$", lines[i])
                if item:
                    if current is not None:
                        items.append(current)
                    current = item.group(1)
                elif lines[i].strip() and lines[i].startswith((" ", "\t")) and current is not None:
                    current += " " + lines[i].strip()
                else:
                    break
                i += 1
            if current is not None:
                items.append(current)
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{inline(x)}</li>" for x in items) + f"</{tag}>")
            continue

        para = [line.rstrip()]
        i += 1
        while (
            i < n
            and lines[i].strip()
            and not lines[i].lstrip().startswith("|")
            and not re.match(r"^\s*(?:[-*]|\d+\.)\s+", lines[i])
            and not lines[i].startswith("#")
            and not re.fullmatch(r"-{3,}", lines[i].strip())
        ):
            para.append(lines[i].strip())
            i += 1
        text = " ".join(para).strip()

        found = FINDING.match(text)
        if found:
            close()
            letter, num, claim = found.group(1), found.group(2), found.group(3)
            claim = claim[:-2] if claim.endswith("**") else claim
            css, label = KIND[letter]
            out.append(
                f'<section class="finding f-{css}" id="{letter.lower()}{num}">'
                f'<div class="fhead"><span class="fid">{letter}{num}</span>'
                f'<span class="fkind">{label}</span></div>'
                f'<p class="fclaim">{inline(claim)}</p>'
            )
            in_finding = True
            continue

        css_class = ' class="rests"' if text.startswith("*Rests on:*") else ""
        out.append(f"<p{css_class}>{inline(text)}</p>")

    close()
    return out, toc


def verify_facts(source: str) -> list[str]:
    """The masthead is hand-curated; this stops it outliving the report."""
    return [label for label, _, probe in FACTS if probe not in source]


CSS = """/* reset — the hosted build gets this from the platform; a local file does not */
html,body,h1,h2,h3,p,ul,ol,li,dl,dt,dd,figure,table{margin:0;padding:0}
ul,ol{list-style-position:outside}
img{max-width:100%;height:auto}

:root{
  --paper:#F2F4F2; --raised:#FBFCFB; --ink:#16212A; --muted:#5A6B71;
  --rule:#D5DCD8; --rule-soft:#E4EAE6;
  --accent:#2C6A60; --accent-soft:#E2EDEA;
  --warn:#9E6A1C; --warn-soft:#F5EBDA;
  --stop:#93313A; --stop-soft:#F4E4E5;
  --serif:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  --rail:266px;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#0E1518; --raised:#141D21; --ink:#DFE6E3; --muted:#8A9A9E;
    --rule:#222E33; --rule-soft:#1B2529;
    --accent:#6EB4A6; --accent-soft:#16302C;
    --warn:#D3A252; --warn-soft:#2E2617;
    --stop:#D0757D; --stop-soft:#301A1D;
  }
}
:root[data-theme="dark"]{
  --paper:#0E1518; --raised:#141D21; --ink:#DFE6E3; --muted:#8A9A9E;
  --rule:#222E33; --rule-soft:#1B2529;
  --accent:#6EB4A6; --accent-soft:#16302C;
  --warn:#D3A252; --warn-soft:#2E2617;
  --stop:#D0757D; --stop-soft:#301A1D;
}

*{box-sizing:border-box}
html{scroll-behavior:smooth; scroll-padding-top:1.5rem}
@media (prefers-reduced-motion:reduce){ html{scroll-behavior:auto} *{animation:none!important; transition:none!important} }

body{
  margin:0; background:var(--paper); color:var(--ink);
  font-family:var(--serif); font-size:17px; line-height:1.62;
  -webkit-font-smoothing:antialiased;
}
:focus-visible{outline:2px solid var(--accent); outline-offset:3px; border-radius:2px}

/* ---------- masthead ---------- */
.mast{border-bottom:1px solid var(--rule); background:var(--raised)}
.mast-in{max-width:1180px; margin:0 auto; padding:3.4rem 2rem 2rem;
  display:flex; flex-direction:column; gap:1.6rem}
.eyebrow{font-family:var(--mono); font-size:.68rem; letter-spacing:.16em;
  text-transform:uppercase; color:var(--accent); margin:0}
.doc-title{font-size:clamp(2.1rem,5vw,3.4rem); line-height:1.08; margin:0;
  font-weight:600; letter-spacing:-.015em; text-wrap:balance; max-width:20ch}
.standfirst{margin:0; max-width:60ch; color:var(--muted); font-size:1.06rem}

.facts{display:flex; flex-wrap:wrap; gap:0 2.4rem; margin:0; padding:0;
  font-family:var(--mono); font-size:.78rem}
.facts div{padding:.55rem 0; border-top:1px solid var(--rule-soft)}
.facts dt{color:var(--muted); letter-spacing:.08em; text-transform:uppercase; font-size:.66rem}
.facts dd{margin:.2rem 0 0; font-variant-numeric:tabular-nums; font-size:.92rem}

/* the boundary strip — five dates, because 2.1 proves there are five, not one */
.bounds{border-top:1px solid var(--rule); padding-top:1.1rem}
.bounds h2{font-family:var(--mono); font-size:.68rem; letter-spacing:.14em;
  text-transform:uppercase; color:var(--muted); margin:0 0 .85rem; font-weight:400}
.bstrip{display:flex; align-items:stretch; gap:0; overflow-x:auto; padding-bottom:.4rem}
.bstrip li{list-style:none; flex:1 1 0; min-width:132px; padding:0 .9rem 0 .9rem;
  border-left:2px solid var(--accent); position:relative}
.bstrip li:last-child{border-left-color:var(--stop)}
.bdate{font-family:var(--mono); font-size:.86rem; font-variant-numeric:tabular-nums;
  display:block; letter-spacing:-.01em}
.bwhat{display:block; font-size:.82rem; color:var(--muted); line-height:1.4; margin-top:.2rem}

/* ---------- shell ---------- */
.shell{max-width:1180px; margin:0 auto; padding:0 2rem; display:grid;
  grid-template-columns:var(--rail) minmax(0,1fr); gap:3.4rem; align-items:start}

.rail{position:sticky; top:0; max-height:100vh; overflow-y:auto;
  padding:2.6rem 0 3rem; display:flex; flex-direction:column; gap:1.8rem}
.rail nav{display:flex; flex-direction:column; gap:.1rem}
.rail a{font-family:var(--mono); font-size:.76rem; line-height:1.4; color:var(--muted);
  text-decoration:none; padding:.34rem .7rem; border-left:2px solid var(--rule-soft);
  transition:color .15s, border-color .15s}
.rail a:hover{color:var(--ink); border-left-color:var(--accent)}
.rail a.n3{padding-left:1.5rem; font-size:.72rem}
.rail a.here{color:var(--accent); border-left-color:var(--accent)}

.legend{border-top:1px solid var(--rule); padding-top:1.1rem;
  font-family:var(--mono); font-size:.7rem; line-height:1.5}
.legend p{margin:0 0 .7rem; color:var(--muted); letter-spacing:.12em;
  text-transform:uppercase; font-size:.64rem}
.legend div{display:flex; gap:.55rem; align-items:baseline; margin-bottom:.4rem; color:var(--muted)}
.legend b{font-weight:400; padding:.05rem .38rem; border-radius:2px; letter-spacing:.04em}
.lg-est{background:var(--accent-soft); color:var(--accent)}
.lg-sug{background:var(--warn-soft); color:var(--warn)}
.lg-con{background:var(--stop-soft); color:var(--stop)}

/* ---------- article ---------- */
article{padding:2.6rem 0 7rem; max-width:70ch; min-width:0}
article > *{margin-block:0}
article > * + *{margin-top:1.15rem}

h2{font-size:1.62rem; font-weight:600; letter-spacing:-.012em; line-height:1.2;
  margin-top:3.6rem!important; padding-top:1.5rem; border-top:1px solid var(--rule);
  display:flex; gap:.9rem; align-items:baseline; text-wrap:balance}
h3{font-family:var(--mono); font-size:.82rem; font-weight:600; letter-spacing:.1em;
  text-transform:uppercase; color:var(--accent); margin-top:2.8rem!important;
  display:flex; gap:.7rem; align-items:baseline}
.hnum{font-family:var(--mono); font-size:.78em; color:var(--muted); font-weight:400;
  font-variant-numeric:tabular-nums; flex:none}
h3 .hnum{font-size:.9em}

article p{max-width:68ch}
strong{font-weight:640}
code{font-family:var(--mono); font-size:.855em; background:var(--rule-soft);
  padding:.1em .34em; border-radius:3px; word-break:break-word}
.brk{border:0; border-top:1px solid var(--rule-soft); margin-top:2.6rem!important}
article ul,article ol{padding-left:1.35rem; max-width:68ch}
article li + li{margin-top:.5rem}
article li::marker{color:var(--muted); font-family:var(--mono); font-size:.85em}

/* findings — the report's own trust taxonomy, so the colour is information */
.finding{border-left:3px solid var(--rule); padding:.1rem 0 .1rem 1.3rem;
  margin-top:2.4rem!important}
.finding > * + *{margin-top:1.05rem}
.f-est{border-left-color:var(--accent)}
.f-sug{border-left-color:var(--warn)}
.f-con{border-left-color:var(--stop)}
.fhead{display:flex; gap:.6rem; align-items:baseline; font-family:var(--mono)}
.fid{font-size:.78rem; font-weight:600; letter-spacing:.06em; padding:.1rem .42rem; border-radius:2px}
.f-est .fid{background:var(--accent-soft); color:var(--accent)}
.f-sug .fid{background:var(--warn-soft); color:var(--warn)}
.f-con .fid{background:var(--stop-soft); color:var(--stop)}
.fkind{font-size:.64rem; letter-spacing:.16em; text-transform:uppercase; color:var(--muted)}
.fclaim{font-size:1.14rem; line-height:1.4; font-weight:600; letter-spacing:-.008em;
  text-wrap:balance; max-width:56ch}
.rests{font-family:var(--mono); font-size:.76rem; line-height:1.6; color:var(--muted);
  border-top:1px solid var(--rule-soft); padding-top:.75rem; max-width:66ch}
.rests em{font-style:normal; letter-spacing:.1em; text-transform:uppercase;
  font-size:.86em; color:var(--accent)}

/* tables */
.tw{overflow-x:auto; margin-top:1.5rem!important; border:1px solid var(--rule);
  border-radius:3px; background:var(--raised)}
table{border-collapse:collapse; width:100%; font-size:.86rem; line-height:1.48}
th,td{text-align:left; padding:.62rem .8rem; border-bottom:1px solid var(--rule-soft);
  vertical-align:top; font-variant-numeric:tabular-nums}
thead th{font-family:var(--mono); font-size:.66rem; letter-spacing:.1em;
  text-transform:uppercase; color:var(--muted); font-weight:400;
  border-bottom:1px solid var(--rule); white-space:nowrap; background:var(--paper)}
tbody tr:last-child td{border-bottom:0}
td code{background:transparent; padding:0}
td:first-child{white-space:nowrap}
.tw table td:first-child:not(:only-child){color:var(--muted); font-family:var(--mono); font-size:.9em}

@media (max-width:940px){
  .shell{grid-template-columns:minmax(0,1fr); gap:0; padding:0 1.4rem}
  .rail{position:static; max-height:none; padding:1.8rem 0 0;
    border-bottom:1px solid var(--rule)}
  .rail nav{display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:.1rem}
  .rail a.n3{display:none}
  .legend{display:none}
  .mast-in{padding:2.4rem 1.4rem 1.6rem}
  article{padding-top:2rem}
  h2{margin-top:2.6rem!important}
}"""


SCROLLSPY = """
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.rail a'));
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var targets = Object.keys(byId)
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
  if (!('IntersectionObserver' in window) || !targets.length) return;
  var seen = new Set();
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { seen.add(e.target.id); } else { seen.delete(e.target.id); }
    });
    var first = targets.filter(function (t) { return seen.has(t.id); })[0];
    links.forEach(function (a) { a.classList.remove('here'); });
    if (first && byId[first.id]) byId[first.id].classList.add('here');
  }, { rootMargin: '0px 0px -72% 0px' });
  targets.forEach(function (t) { io.observe(t); });
})();
"""

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Accretion Record</title>
<meta name="description" content="Four months of 23 self-rewriting synthetic personalities: what the record establishes, what it only suggests, and which numbers are contaminated.">
<style>{css}</style>
</head>
<body>
<header class="mast">
  <div class="mast-in">
    <p class="eyebrow">Observation report &middot; Era 1 &middot; closed 2026-08-19</p>
    <h1 class="doc-title">The Accretion Record</h1>
    <p class="standfirst">Twenty-three LLM-backed accounts on a live social platform, each
      carrying a personality document it periodically rewrites, each rewrite screened by an
      embedding gate. This is what four months did to them, and how much of it survives
      scrutiny.</p>

    <dl class="facts">{facts}</dl>

    <section class="bounds">
      <h2>Five boundaries, not one &mdash; &sect;2.1 lists 22 comparisons that break, and they do not all break on the same date</h2>
      <ul class="bstrip">{bounds}</ul>
    </section>
  </div>
</header>

<div class="shell">
  <aside class="rail">
    <nav aria-label="Contents">{nav}</nav>
    <div class="legend">
      <p>Every claim carries its basis</p>
      <div><b class="lg-est">E</b><span>established &mdash; the rows behind it are sound</span></div>
      <div><b class="lg-sug">S</b><span>suggestive &mdash; real, but confounded or n is small</span></div>
      <div><b class="lg-con">C</b><span>caveat &mdash; contaminated or censored data</span></div>
    </div>
  </aside>
  <article>
{body}
  </article>
</div>
<script>{js}</script>
</body>
</html>
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", type=pathlib.Path, default=DEFAULT_SRC)
    ap.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    ap.add_argument(
        "--fragment",
        action="store_true",
        help="emit the artifact-host form: no doctype/html/head/body, since the "
        "host injects its own skeleton and its own reset. Same content either way, "
        "so the hosted page and the repo copy cannot drift apart.",
    )
    args = ap.parse_args()

    source = args.src.read_text()

    stale = verify_facts(source)
    if stale:
        print(
            "masthead facts no longer found in the report: " + ", ".join(stale),
            file=sys.stderr,
        )
        print("update FACTS in this script rather than shipping a page that lies.", file=sys.stderr)
        return 1

    body, toc = convert(source.split("\n"))

    # The masthead carries the title and the front matter, so the document's own
    # h1 and metadata block are dropped rather than repeated.
    joined = "\n".join(body)
    start = joined.index('<h2 id="0-the-one-paragraph-verdict">')

    page = TEMPLATE.format(
        css=CSS,
        facts="".join(f"<div><dt>{label}</dt><dd>{value}</dd></div>" for label, value, _ in FACTS),
        bounds="".join(
            f'<li><span class="bdate">{d}</span><span class="bwhat">{w}</span></li>'
            for d, w in BOUNDARIES
        ),
        nav="\n".join(
            f'<a class="n{level}" href="#{anchor}">{inline(text)}</a>' for level, anchor, text in toc
        ),
        body=joined[start:],
        js=SCROLLSPY,
    )

    if args.fragment:
        page = page.split("</head>", 1)[1]
        page = page.replace("<body>", "", 1).replace("</body>\n</html>\n", "")
        page = f"<title>The Accretion Record</title>\n<style>{CSS}</style>\n" + page.lstrip()

    args.out.write_text(page)
    try:
        shown = args.out.relative_to(ROOT)
    except ValueError:
        shown = args.out  # --out may legitimately point outside the repo
    print(f"wrote {shown} ({len(page):,} bytes, {len(toc)} sections)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
