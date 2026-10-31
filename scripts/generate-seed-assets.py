#!/usr/bin/env python3
"""Rebuild original synthetic fixtures; requires Pillow, ReportLab and pdftoppm.

Development seeding reads the checked-in files and needs none of these tools.
No external photos, fonts, documents or user data are used.
"""
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.pdfgen import canvas

DEST = Path(__file__).resolve().parents[1] / "src/renderer/services/sample-project/assets"
DEST.mkdir(parents=True, exist_ok=True)
INK, SEA, PAPER, GOLD = "#233f48", "#bdd8d6", "#f5f0e4", "#cf9458"
FONT = ImageFont.load_default(size=24)
SMALL = ImageFont.load_default(size=17)
fixtures = []


def register(name, title, kind, width=None, height=None):
    extension = "png" if kind == "image" else "pdf"
    source = DEST / f"{name}.{extension}"
    fixtures.append(dict(name=name, title=title, kind=kind, source=source.name,
                         sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                         sizeBytes=source.stat().st_size, width=width, height=height))


def image(name, title, subtitle, draw_content):
    im = Image.new("RGB", (960, 640), PAPER)
    d = ImageDraw.Draw(im)
    d.text((40, 28), title, font=FONT, fill=INK)
    d.text((40, 66), subtitle, font=SMALL, fill=INK)
    draw_content(d)
    d.text((40, 600), "DRIFTING / SYNTHETIC DEVELOPMENT FIXTURE / NOT NAVIGATIONAL DATA", font=SMALL, fill=INK)
    im.save(DEST / f"{name}.png")
    im.save(DEST / f"{name}.display.jpg", quality=85)
    im.thumbnail((480, 320))
    im.save(DEST / f"{name}.thumbnail.jpg", quality=80)
    register(name, title, "image", 960, 640)


def island(d):
    d.rounded_rectangle((40, 110, 920, 575), 18, fill=SEA)
    d.polygon([(270, 530), (210, 395), (300, 315), (280, 230), (425, 143),
               (600, 182), (672, 305), (755, 372), (654, 500), (450, 550)], fill=PAPER)
    points = [(425, 180, "NORTH CAPE"), (610, 360, "OLD PORT"), (330, 380, "SALT HOUSE"), (490, 460, "ARCHIVE")]
    for x, y, label in points:
        d.ellipse((x-6, y-6, x+6, y+6), fill=GOLD)
        d.text((x+14, y-10), label, fill=INK, font=SMALL)
    d.line([(425, 180), (330, 380), (490, 460), (610, 360)], fill=GOLD, width=3)
    d.text((800, 140), "N", fill=INK, font=FONT)
    d.line((808, 180, 808, 230), fill=INK, width=3)


def tower(d):
    d.rectangle((40, 110, 920, 575), fill=SEA)
    d.polygon([(40, 530), (285, 470), (450, 490), (610, 450), (920, 525), (920, 575), (40, 575)], fill=INK)
    d.polygon([(395, 490), (430, 235), (510, 235), (545, 490)], fill=PAPER, outline=INK, width=3)
    d.rectangle((422, 200, 518, 240), fill=GOLD, outline=INK, width=3)
    d.polygon([(410, 200), (470, 155), (530, 200)], fill=INK)
    d.rectangle((452, 417, 486, 490), fill=INK)
    d.line((518, 215, 840, 135), fill=PAPER, width=8)
    d.line((518, 224, 840, 308), fill=PAPER, width=8)
    d.text((625, 360), "ONE SWEEP / 9 SECONDS", font=SMALL, fill=INK)


def tide(d):
    d.line((90, 150, 90, 520, 880, 520), fill=INK, width=3)
    for y in range(180, 520, 80):
        d.line((90, y, 880, y), fill=SEA, width=1)
    points = [(x, int(335 - 125 * math.sin((x - 90) / 790 * 4 * math.pi))) for x in range(90, 881)]
    d.line(points, fill=GOLD, width=5)
    for i, label in enumerate(["00:00", "06:00", "12:00", "18:00", "24:00"]):
        d.text((90 + i * 195 - 25, 540), label, font=SMALL, fill=INK)
    d.text((110, 125), "RELATIVE WATER LEVEL / FICTIONAL VALUES", font=SMALL, fill=INK)


def log(d):
    for i, label in enumerate(["DAY 01  /  NORTH CAPE  /  LAMP OFF", "DAY 02  /  OLD PORT    /  CLOCK +4 MIN",
                               "DAY 03  /  SALT HOUSE  /  KEY FOUND", "DAY 04  /  ARCHIVE     /  PAGE MISSING",
                               "DAY 05  /  BREAKWATER  /  RETURN SIGNAL"]):
        y = 155 + i * 75
        d.line((65, y + 42, 895, y + 42), fill=SEA, width=2)
        d.text((75, y), label, font=FONT, fill=INK)


image("island-map", "NORTH CAPE / ISLAND ATLAS", "A fictional map for material previews and image zoom.", island)
image("lighthouse", "LIGHTHOUSE / LIGHT STUDY", "Original geometric illustration, development use.", tower)
image("tide-chart", "TIDE / OBSERVATION STUDY", "Synthetic data only. No real tidal measurements.", tide)
image("ship-log", "SHIP LOG / FIVE DAYS", "Fictional archival card for the island mystery.", log)

for name, title, image_name, rows in [
    ("field-guide", "North Cape Field Guide", "island-map", ["01 / Arrival at the old port", "02 / Low tide route to the lighthouse", "03 / Archive visit and log comparison"]),
    ("tide-notebook", "Tide Observation Notebook", "tide-chart", ["01 / Compare the clock and the signal", "02 / Record the missing nine seconds", "03 / Recheck the return passage"]),
]:
    c = canvas.Canvas(str(DEST / f"{name}.pdf"), pagesize=(600, 780), invariant=1)
    c.setTitle(title)
    c.setAuthor("Drifting synthetic fixture generator")
    for page in range(3):
        c.setFillColor(HexColor(PAPER))
        c.rect(0, 0, 600, 780, fill=1, stroke=0)
        c.setFillColor(HexColor(INK))
        c.setFont("Helvetica-Bold", 24)
        c.drawString(40, 720, title)
        c.setFont("Helvetica", 12)
        c.drawString(40, 689, rows[page])
        c.drawImage(str(DEST / f"{image_name}.png"), 40, 302, width=520, height=347)
        for line, text in enumerate([
            "This document belongs to a fictional island mystery.",
            "All names, observations and routes are synthetic test material.",
            "Use it to exercise PDF previews, page navigation and annotations.",
            f"Observation {page + 1}: the signal and the written record do not agree.",
            "The investigator keeps the uncertainty visible in her notes.",
        ]):
            c.drawString(40, 260 - line * 24, text)
        c.setFont("Helvetica", 10)
        c.drawString(40, 42, "DRIFTING / ORIGINAL SYNTHETIC FIXTURE")
        c.drawRightString(560, 42, f"{page + 1} / 3")
        c.showPage()
    c.save()
    with tempfile.TemporaryDirectory() as temp:
        prefix = str(Path(temp) / "page")
        subprocess.run(["pdftoppm", "-f", "1", "-singlefile", "-scale-to", "512", "-jpeg", str(DEST / f"{name}.pdf"), prefix], check=True)
        (DEST / f"{name}.thumbnail.jpg").write_bytes(Path(f"{prefix}.jpg").read_bytes())
    register(name, title, "pdf")

for fixture in fixtures:
    fixture["variants"] = {
        variant: {"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for variant in ["display", "thumbnail"]
        if (path := DEST / f"{fixture['name']}.{variant}.jpg").exists()
    }
(DEST / "manifest.json").write_text(json.dumps(fixtures, indent=2) + "\n")
