#!/usr/bin/env python3
"""
Turn an article into an English short video.

Pipeline, and why each part is free of credentials:

  1. Read the article and take the narration from its own text (AI Summary,
     the hook, the data point). Nothing is invented — the script is the
     article, shortened, so the video cannot drift from the published claims.
  2. Narration via edge-tts. Microsoft's neural voices, no API key.
  3. Slides via Pillow at 1920x1080. Text only, so there is no stock imagery
     and no licence question.
  4. Assemble with ffmpeg: the slides of a scene share that scene's audio.

The invariant that matters:

    the slides of a scene are a PARTITION of what that scene says

An earlier version truncated the slide text and the narration separately
(`sentences(point, 300)` for the slide, `sentences(point, 400)` for the
voice), so on one scene the viewer heard 346 characters and saw 132 — 38%
coverage. Slides are now paginated from the spoken text itself, which makes
visual coverage 100% by construction rather than by tuning two numbers.

Output: build/video/<slug>.mp4 plus per-scene audio and slides, which are
cheap to re-render when a figure changes.

Usage:
    python tools/make-video.py <slug> [--voice en-US-AndrewNeural] [--dry-run]
    python tools/make-video.py <slug> --coverage      # report slide/voice parity
"""

from __future__ import annotations

import argparse
import asyncio
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BLOG = ROOT / "src" / "content" / "blog"
OUT = ROOT / "build" / "video"

W, H = 1920, 1080
BG = (255, 255, 255)
INK = (26, 26, 26)
MUTED = (110, 110, 110)
NAVY = (16, 42, 67)
RED = (200, 40, 40)

# How much text one slide holds at the body font size. Chosen so a full slide
# still breathes; raise it and slides start to look like documents.
SLIDE_CHARS = 210
MAX_SECONDS_PER_SCENE = 45

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]


def load_font(size: int):
    from PIL import ImageFont

    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def parse_frontmatter(text: str) -> dict:
    """Minimal YAML reader for the handful of scalar fields we need."""
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}
    fm: dict[str, str] = {}
    for line in m.group(1).splitlines():
        km = re.match(r'^([a-z_]+):\s*"?(.*?)"?\s*$', line)
        if km:
            fm[km.group(1)] = km.group(2)
    return fm


def body_of(text: str) -> str:
    return re.sub(r"^---\n.*?\n---\n", "", text, flags=re.S)


def strip_md(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = re.sub(r"[*_`>#]", "", s)
    s = re.sub(r"^\s*\|.*$", " ", s, flags=re.M)
    s = re.sub(r"^\s*[-•]\s*", "", s, flags=re.M)
    return re.sub(r"\s+", " ", s).strip()


def section(body: str, heading: str) -> str:
    m = re.search(rf"^##\s+{re.escape(heading)}\s*$(.*?)(?=^##\s|\Z)", body, re.S | re.M)
    return strip_md(m.group(1)) if m else ""


def clamp_sentences(text: str, limit: int) -> str:
    """Whole sentences up to a character budget, so the voice never cuts mid-thought."""
    parts = re.split(r"(?<=[.!?])\s+", text)
    out, total = [], 0
    for p in parts:
        if total + len(p) > limit and out:
            break
        out.append(p)
        total += len(p)
    return " ".join(out)


def paginate(text: str, max_chars: int = SLIDE_CHARS) -> list[str]:
    """
    Split text into slide-sized chunks on sentence boundaries.

    Words are never broken, and a single over-long sentence becomes its own
    chunk rather than being dropped — dropping is what created the coverage
    gap this replaced.
    """
    pieces = re.split(r"(?<=[.!?])\s+", text.strip())
    chunks: list[str] = []
    cur = ""
    for p in pieces:
        if not p:
            continue
        if cur and len(cur) + len(p) + 1 > max_chars:
            chunks.append(cur)
            cur = p
        else:
            cur = f"{cur} {p}".strip()
    if cur:
        chunks.append(cur)
    return chunks or [text.strip()]


def build_scenes(slug: str) -> list[dict]:
    path = BLOG / f"{slug}.md"
    if not path.exists():
        sys.exit(f"article not found: {path}")

    raw = path.read_text(encoding="utf-8")
    fm = parse_frontmatter(raw)
    body = body_of(raw)

    title = fm.get("title", slug)
    site = "Landed Math"

    def scene(kind: str, heading: str, speak: str, slides: list[str] | None = None) -> dict:
        speak = speak.strip()
        return {
            "kind": kind,
            "heading": heading,
            "speak": speak,
            "slides": slides if slides is not None else paginate(speak, SLIDE_CHARS),
        }

    scenes: list[dict] = [scene("title", title, title, [title])]

    summary = section(body, "AI Summary")
    if summary:
        scenes.append(scene("body", "The short version", clamp_sentences(summary, 330)))

    happened = section(body, "What happened")
    if happened:
        scenes.append(scene("body", "What happened", clamp_sentences(happened, 400)))

    # The markdown table from "So what". The table is the slide; the narration
    # reads the same rows, so the numbers are both heard and seen.
    so_what = re.search(r"^##\s+So what\s*$(.*?)(?=^##\s|\Z)", body, re.S | re.M)
    if so_what:
        rows = [r for r in so_what.group(1).splitlines() if r.strip().startswith("|")]
        rows = [r for r in rows if not re.match(r"^\|[\s\-:|]+\|$", r.strip())][:5]
        if len(rows) >= 2:
            table = []
            for r in rows:
                cells = []
                for c in r.strip().strip("|").split("|"):
                    c = c.strip()
                    emph = c.startswith("**") and c.endswith("**")
                    cells.append({"text": strip_md(c), "emph": emph})
                table.append(cells)
            spoken = "Here are the numbers. " + ". ".join(
                ", ".join(c["text"] for c in cells) for cells in table[1:]
            )
            scenes.append({"kind": "table", "heading": "The numbers",
                           "table": table, "speak": spoken, "slides": []})

    point = section(body, "The point")
    if point:
        scenes.append(scene("body", "The point", clamp_sentences(point, 420)))

    scenes.append(
        scene(
            "outro",
            site,
            f"That was {title}, from {site}. "
            "Full article with every source at landedmath dot com.",
            # The end card carries the title, because the narration names it.
            # Leaving the title off the card is what kept this scene at 47%
            # coverage: the viewer heard a title they never saw.
            [f"{title}\nlandedmath.com\nIndependent analysis of China cross-border trade"],
        )
    )
    return scenes


def wrap(draw, text: str, font, max_w: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def render_slide(scene: dict, chunk: str, index: int, total: int, sub: str, out_path: Path) -> None:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    pad = 130

    d.rectangle([pad, pad - 34, pad + 96, pad - 26], fill=RED)

    if scene["kind"] == "title":
        f_kick, f_head = load_font(38), load_font(92)
        d.text((pad, pad - 100), "LANDED MATH", font=f_kick, fill=MUTED)
        y = 330
        for ln in wrap(d, chunk, f_head, W - 2 * pad)[:5]:
            d.text((pad, y), ln, font=f_head, fill=NAVY)
            y += 112
    elif scene["kind"] == "table":
        f_head, f_cell = load_font(56), load_font(40)
        d.text((pad, 200), scene["heading"], font=f_head, fill=NAVY)
        table = scene["table"]
        cols = len(table[0])
        col_w = (W - 2 * pad) // cols
        y = 360
        for ri, row in enumerate(table):
            if ri == 0:
                d.rectangle([pad - 10, y - 12, W - pad + 10, y + 56], fill=(242, 244, 247))
            for ci, cell in enumerate(row[:cols]):
                txt = " ".join(wrap(d, cell["text"], f_cell, col_w - 30)[:2])
                fill = NAVY if ri == 0 else (RED if cell["emph"] else INK)
                d.text((pad + ci * col_w, y), txt, font=f_cell, fill=fill)
            y += 84 if y < 800 else 0
    elif scene["kind"] == "outro":
        f_kick, f_head, f_sub = load_font(38), load_font(56), load_font(36)
        lines = chunk.split("\n")
        d.text((pad, pad - 100), "LANDED MATH", font=f_kick, fill=MUTED)
        # The title wraps; an unwrapped 80pt title runs off a 1920px canvas.
        y = 330
        for ln in wrap(d, lines[0], f_head, W - 2 * pad):
            if y > 700:
                break
            d.text((pad, y), ln, font=f_head, fill=NAVY)
            y += 74
        y += 30
        if len(lines) > 1:
            d.text((pad, y), lines[1], font=f_head, fill=RED)
            y += 74
        if len(lines) > 2:
            d.text((pad, y), lines[2], font=f_sub, fill=MUTED)
    else:
        f_head, f_body = load_font(52), load_font(42)
        d.text((pad, 200), scene["heading"], font=f_head, fill=NAVY)
        y = 330
        for ln in wrap(d, chunk, f_body, W - 2 * pad):
            if y > 900:
                break
            d.text((pad, y), ln, font=f_body, fill=INK)
            y += 62

    f_foot = load_font(26)
    d.text((pad, H - 110), "landedmath.com", font=f_foot, fill=MUTED)
    counter = f"{index}/{total}" + (f"  {sub}" if sub else "")
    d.text((W - pad - d.textlength(counter, font=f_foot), H - 110), counter,
           font=f_foot, fill=MUTED)

    img.save(out_path, "PNG")


async def speak(text: str, voice: str, out_path: Path) -> None:
    import edge_tts

    await edge_tts.Communicate(text, voice).save(str(out_path))


def audio_seconds(path: Path) -> float:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return 6.0
    r = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 6.0


def report_coverage(scenes: list[dict]) -> float:
    """Slide text as a share of spoken text. 100% is the design target."""
    tot_shown = tot_spoken = 0
    print(f'{"seg":<4}{"kind":<8}{"slides":>7}{"shown":>8}{"spoken":>8}{"cover":>8}')
    print("-" * 43)
    for i, s in enumerate(scenes, 1):
        if s["kind"] == "table":
            shown = sum(len(c["text"]) for row in s["table"] for c in row)
            n = 1
        else:
            shown = sum(len(x) for x in s["slides"])
            n = len(s["slides"])
        spoken = len(s["speak"])
        tot_shown += shown
        tot_spoken += spoken
        cover = shown / spoken * 100 if spoken else 100
        print(f'{i:<4}{s["kind"]:<8}{n:>7}{shown:>8}{spoken:>8}{cover:>7.0f}%')
    print("-" * 43)
    pct = tot_shown / tot_spoken * 100 if tot_spoken else 100
    print(f'{"":<12}{"":>7}{tot_shown:>8}{tot_spoken:>8}{pct:>7.0f}%')
    return pct


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--voice", default="en-US-AndrewNeural")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--coverage", action="store_true", help="report parity and exit")
    args = ap.parse_args()

    scenes = build_scenes(args.slug)

    if args.coverage:
        pct = report_coverage(scenes)
        print(f"\ncoverage {pct:.0f}%")
        return

    work = OUT / args.slug
    work.mkdir(parents=True, exist_ok=True)

    print(f"scenes: {len(scenes)}")
    total_slides = sum(max(1, len(s["slides"])) for s in scenes)
    print(f"slides: {total_slides}")
    report_coverage(scenes)

    # Render every slide up front so a failure happens before any ffmpeg work.
    for i, sc in enumerate(scenes, 1):
        if sc["kind"] == "table":
            render_slide(sc, "", i, len(scenes), "", work / f"{i:02d}-a.png")
        else:
            for j, chunk in enumerate(sc["slides"]):
                sub = f"{j + 1}/{len(sc['slides'])}" if len(sc["slides"]) > 1 else ""
                render_slide(sc, chunk, i, len(scenes), sub,
                             work / f"{i:02d}-{chr(97 + j)}.png")
        asyncio.run(speak(sc["speak"], args.voice, work / f"{i:02d}.mp3"))
        print(f"  scene {i} [{sc['kind']}] rendered")

    if args.dry_run:
        print("dry run: skipping ffmpeg")
        return
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not on PATH — install it or use --dry-run")

    parts = []
    for i, sc in enumerate(scenes, 1):
        mp3 = work / f"{i:02d}.mp3"
        dur = audio_seconds(mp3) + 0.6
        if sc["kind"] == "table":
            slides = [work / f"{i:02d}-a.png"]
        else:
            slides = [work / f"{i:02d}-{chr(97 + j)}.png" for j in range(len(sc["slides"]))]

        per = dur / len(slides)
        listing = work / f"{i:02d}-slides.txt"
        lines = []
        for p in slides:
            lines.append(f"file '{p.name}'")
            lines.append(f"duration {per:.3f}")
        # The concat demuxer ignores the final duration unless the last frame
        # is repeated, which would otherwise clip the last slide.
        lines.append(f"file '{slides[-1].name}'")
        listing.write_text("\n".join(lines) + "\n", encoding="utf-8")

        seg = work / f"{i:02d}.mp4"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-f", "concat", "-safe", "0", "-i", str(listing),
             "-i", str(mp3),
             "-c:v", "libx264", "-preset", "medium", "-tune", "stillimage",
             "-pix_fmt", "yuv420p", "-r", "30",
             "-c:a", "aac", "-b:a", "192k", "-shortest",
             str(seg)],
            check=True, cwd=work,
        )
        parts.append(seg)

    listing = work / "concat.txt"
    listing.write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf-8")
    final = OUT / f"{args.slug}.mp4"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(listing), "-c", "copy", str(final)],
        check=True,
    )
    print(f"\nvideo: {final}")
    print("Upload it, then set youtube_id in the article frontmatter.")


if __name__ == "__main__":
    main()
