#!/usr/bin/env python3
"""
Turn an article into an English short video.

Pipeline, and why each part is free of credentials:

  1. Read the article and pull the narration from its own text (AI Summary,
     the hook, the data point). Nothing is invented — the script is the
     article, shortened, so the video cannot drift from the published claims.
  2. Narration via edge-tts. Microsoft's neural voices, no API key.
  3. Slides via Pillow at 1920x1080. Text only, so there is no stock imagery
     and no licence question.
  4. Assemble with ffmpeg: one still per scene, duration matched to that
     scene's audio, then concat.

Output: build/video/<slug>.mp4 plus the per-scene audio and slides, which are
cheap to re-render when a figure changes.

Usage:
    python tools/make-video.py <slug> [--voice en-US-AndrewNeural] [--dry-run]

`--dry-run` renders slides and audio but skips ffmpeg, which is useful before
ffmpeg is installed and for checking the script text.
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


def sentences(text: str, limit: int) -> str:
    parts = re.split(r"(?<=[.!?])\s+", text)
    out, total = [], 0
    for p in parts:
        if total + len(p) > limit and out:
            break
        out.append(p)
        total += len(p)
    return " ".join(out)


def build_scenes(slug: str) -> list[dict]:
    path = BLOG / f"{slug}.md"
    if not path.exists():
        sys.exit(f"article not found: {path}")

    raw = path.read_text(encoding="utf-8")
    fm = parse_frontmatter(raw)
    body = body_of(raw)

    title = fm.get("title", slug)
    site = "Landed Math"

    scenes: list[dict] = []
    scenes.append(
        {
            "kind": "title",
            "heading": title,
            "kicker": "LANDED MATH",
            "speak": f"{title}",
        }
    )

    summary = section(body, "AI Summary")
    if summary:
        scenes.append(
            {
                "kind": "body",
                "heading": "The short version",
                "lines": [sentences(summary, 200)],
                "speak": sentences(summary, 320),
            }
        )

    happened = section(body, "What happened")
    if happened:
        scenes.append(
            {
                "kind": "body",
                "heading": "What happened",
                "lines": [sentences(happened, 260)],
                "speak": sentences(happened, 380),
            }
        )

    # Pull the markdown table out of "So what" and show up to four rows.
    so_what = re.search(r"^##\s+So what\s*$(.*?)(?=^##\s|\Z)", body, re.S | re.M)
    if so_what:
        rows = [r for r in so_what.group(1).splitlines() if r.strip().startswith("|")]
        rows = [r for r in rows if not re.match(r"^\|[\s\-:|]+\|$", r.strip())][:5]
        if len(rows) >= 2:
            # A cell keeps its emphasis flag so the renderer can accent it.
            # The first pass drew "**EUR 15.00**" verbatim, asterisks included,
            # because the paragraph stripper never ran on table cells.
            table = []
            for r in rows:
                cells = []
                for c in r.strip().strip("|").split("|"):
                    c = c.strip()
                    emph = c.startswith("**") and c.endswith("**")
                    cells.append({"text": strip_md(c), "emph": emph})
                table.append(cells)
            scenes.append(
                {
                    "kind": "table",
                    "heading": "The numbers",
                    "table": table,
                    "speak": "Here are the numbers. "
                    + ". ".join(", ".join(c["text"] for c in cells) for cells in table[1:]),
                }
            )

    point = section(body, "The point")
    if point:
        scenes.append(
            {
                "kind": "body",
                "heading": "The point",
                "lines": [sentences(point, 300)],
                "speak": sentences(point, 400),
            }
        )

    scenes.append(
        {
            "kind": "outro",
            "heading": site,
            "lines": ["landedmath.com", "Independent analysis of China cross-border trade"],
            "speak": f"That was {title}, from {site}. Full article with every source at landedmath dot com.",
        }
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


def render_slide(scene: dict, index: int, total: int, out_path: Path) -> None:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    pad = 130

    # A red rule top-left and a scene counter bottom-right: enough furniture to
    # read as a series without needing a designed template.
    d.rectangle([pad, pad - 34, pad + 96, pad - 26], fill=RED)

    if scene["kind"] == "title":
        f_kick, f_head = load_font(38), load_font(92)
        d.text((pad, pad - 100), scene["kicker"], font=f_kick, fill=MUTED)
        lines = wrap(d, scene["heading"], f_head, W - 2 * pad)
        y = 330
        for ln in lines[:5]:
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
                # `cell` is {"text", "emph"} from build_scenes.
                txt = " ".join(wrap(d, cell["text"], f_cell, col_w - 30)[:2])
                if ri == 0:
                    fill = NAVY
                elif cell["emph"]:
                    fill = RED
                else:
                    fill = INK
                d.text((pad + ci * col_w, y), txt, font=f_cell, fill=fill)
            y += 84 if y < 800 else 0
    else:
        f_head, f_body = load_font(52), load_font(42)
        d.text((pad, 200), scene["heading"], font=f_head, fill=NAVY)
        y = 330
        for para in scene.get("lines", []):
            for ln in wrap(d, para, f_body, W - 2 * pad):
                d.text((pad, y), ln, font=f_body, fill=INK)
                y += 62
                if y > 900:
                    break

    f_foot = load_font(26)
    d.text((pad, H - 110), "landedmath.com", font=f_foot, fill=MUTED)
    counter = f"{index}/{total}"
    d.text((W - pad - d.textlength(counter, font=f_foot), H - 110),
           counter, font=f_foot, fill=MUTED)

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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("--voice", default="en-US-AndrewNeural")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    scenes = build_scenes(args.slug)
    work = OUT / args.slug
    work.mkdir(parents=True, exist_ok=True)

    print(f"scenes: {len(scenes)}")
    for i, sc in enumerate(scenes, 1):
        print(f"  {i}. [{sc['kind']}] {sc.get('heading') or ''} "
              f"— {len(sc.get('speak', ''))} chars")

    for i, sc in enumerate(scenes, 1):
        slide = work / f"{i:02d}.png"
        mp3 = work / f"{i:02d}.mp3"
        render_slide(sc, i, len(scenes), slide)
        asyncio.run(speak(sc["speak"], args.voice, mp3))
        print(f"  rendered {slide.name} + {mp3.name}")

    if args.dry_run:
        print("dry run: skipping ffmpeg")
        return
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not on PATH — install it or use --dry-run")

    # One video segment per scene, each as long as its narration.
    parts = []
    for i, sc in enumerate(scenes, 1):
        seg = work / f"{i:02d}.mp4"
        dur = audio_seconds(work / f"{i:02d}.mp3") + 0.6
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error",
             "-loop", "1", "-i", str(work / f"{i:02d}.png"),
             "-i", str(work / f"{i:02d}.mp3"),
             "-t", f"{dur:.2f}",
             "-c:v", "libx264", "-preset", "medium", "-tune", "stillimage",
             "-pix_fmt", "yuv420p", "-r", "30",
             "-c:a", "aac", "-b:a", "192k", "-shortest",
             str(seg)],
            check=True,
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
