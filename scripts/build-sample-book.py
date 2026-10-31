#!/usr/bin/env python3
"""Rebuild the built-in sample's book files from the public-domain source EPUB.

Usage (macOS, uses `sips` for the illustrations):

    python3 -I scripts/build-sample-book.py <path/to/pride-and-prejudice.epub> [--out DIR]

The source is the EPUB of Jane Austen's *Pride and Prejudice* in the 1894
George Allen edition illustrated by Hugh Thomson (eBook #1342 of the volunteer
digital library named in ASSET_PROVENANCE.md). Only the 61 chapters and five
illustrations are kept: the library's header, footer, license and every
mention of its name, the preface, front matter, page numbers, chapter heading
art, drop caps and the printer's imprint are left out. The EPUB is read as
untrusted data: members are opened by exact name from the ZIP, never extracted.

Writes src/renderer/services/built-in-sample/pride-and-prejudice/ (or --out DIR,
which the content test uses to check the checked-in files against the EPUB):
  text.json      the chapters (see ../book.ts for the block encoding)
  *.jpg          illustrations: source (also the display variant) and thumbnail
  manifest.json  hashes, sizes and dimensions, checked by the app before import
The app never runs this script; it reads the checked-in files.
"""
import hashlib
import html.parser
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

DEST = Path(__file__).resolve().parents[1] / 'src/renderer/services/built-in-sample/pride-and-prejudice'
PARTS = [f'OEBPS/2523611006506216498_1342-h-{index}.htm.xhtml' for index in range(6)]
SIPS = '/usr/bin/sips'

# Illustrations: (name, EPUB member, title, chapter, crop (x, y, w, h) or None, use)
# Crops remove the publisher’s 1894 copyright line printed under two plates.
# (sips centres a crop whose offset is 0,0, so crops start at 1,1.)
ILLUSTRATIONS = [
    ('mr-and-mrs-bennet', 'OEBPS/7280391830649714776_i_034.jpg', 'Mr. & Mrs. Bennet', 1, None, 'material'),
    ('she-is-tolerable', 'OEBPS/7280391830649714776_i_044.jpg', '“She is tolerable”', 3, (1, 1, 993, 1157), 'material'),
    ('never-read-novels', 'OEBPS/7280391830649714776_i_116.jpg', '“Protested that he never read novels”', 14, None, 'material'),
    ('hearing-herself-called', 'OEBPS/7280391830649714776_i_272_a.jpg', '“Hearing herself called”', 35, None, 'material'),
    ('after-a-short-survey', 'OEBPS/7280391830649714776_i_463.jpg', '“After a short survey”', 56, (1, 1, 723, 1134), 'material'),
    ('portrait-elizabeth', 'OEBPS/7280391830649714776_i_044.jpg', 'Elizabeth Bennet', 3, (40, 330, 300, 380), 'portrait'),
    ('portrait-darcy', 'OEBPS/7280391830649714776_i_272_a.jpg', 'Fitzwilliam Darcy', 35, (780, 60, 340, 430), 'portrait'),
]
MATERIAL_EDGE, MATERIAL_QUALITY = 760, 50
THUMBNAIL_EDGE, THUMBNAIL_QUALITY = 360, 55
PORTRAIT_QUALITY, PORTRAIT_THUMBNAIL_EDGE = 60, 200

# Words the 1894 edition sets in capitals after a chapter's drop cap that are
# names or titles (kept capitalised when restoring normal case).
NAME_WORDS = {
    'MR.', 'MRS.', 'MISS', 'SIR', 'COLONEL', 'BENNET', 'BENNET’S', 'GARDINER’S', 'COLLINS', 'COLLINS’S',
    'BINGLEY’S', 'WILLIAM', 'FITZWILLIAM’S', 'WICKHAM', 'ELIZABETH', 'ELIZABETH’S', 'I',
}


class Chapters(html.parser.HTMLParser):
    """Paragraph runs per chapter. Figures, captions and page numbers are skipped;
    a letter set as an indented block becomes a nested list of paragraphs."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.chapters = []
        self.in_h2 = False
        self.h2_roman = None
        self.skip = 0
        self.divs = []
        self.quote = None
        self.para = None
        self.para_class = ''
        self.italic = 0
        self.letra = None
        self.spans = []
        self.after_figure = False
        self.ended = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get('class') or ''
        if tag == 'div':
            if re.search(r'\bfig(center|left|right)\b', cls):
                self.divs.append('figure')
                self.skip += 1
            elif self.skip:
                self.divs.append('inner')
            elif 'blockquot' in cls and self.chapters and not self.ended:
                self.divs.append('quote')
                self.quote = []
            else:
                self.divs.append('other')
            return
        if tag == 'span' and self.skip:
            self.spans.append('inner')
            return
        if self.skip:
            return
        if tag == 'h2':
            self.in_h2, self.h2_roman = True, None
        elif tag == 'a' and self.in_h2:
            match = re.fullmatch(r'chapter_([ivxlc]+)', a.get('id') or '', re.I)
            if match:
                self.h2_roman = match.group(1).upper()
        elif tag == 'span':
            if 'x-ebookmaker-pageno' in cls:
                self.spans.append('skip')
                self.skip += 1
            elif 'letra' in cls:
                self.spans.append('letra')
                self.letra = ''
            else:
                self.spans.append('plain')
        elif tag == 'img' and self.letra is not None:
            self.letra += a.get('alt') or ''
        elif tag == 'p' and self.chapters and not self.in_h2 and not self.ended:
            self.para, self.para_class = [], cls
        elif tag == 'i':
            self.italic += 1
        elif tag == 'br' and self.para is not None:
            self.para.append(['\n', False])

    def handle_endtag(self, tag):
        if tag == 'div':
            kind = self.divs.pop()
            if kind == 'figure':
                self.skip -= 1
                self.after_figure = True
            elif kind == 'quote':
                if self.quote:
                    self.chapters[-1]['blocks'].append(self.quote)
                self.quote = None
            return
        if tag == 'span':
            kind = self.spans.pop() if self.spans else 'plain'
            if kind == 'skip':
                self.skip -= 1
            elif kind == 'letra':
                if self.para is not None:
                    self.para.append([self.letra, False])
                self.letra = None
            return
        if self.skip:
            return
        if tag == 'h2':
            self.in_h2 = False
            if self.h2_roman:
                self.chapters.append({'roman': self.h2_roman, 'blocks': []})
                self.after_figure = False
            elif self.chapters:
                self.ended = True
        elif tag == 'i':
            self.italic -= 1
        elif tag == 'p' and self.para is not None:
            runs, self.para = self.para, None
            if not ''.join(text for text, _ in runs).strip():
                return
            target = self.quote if self.quote is not None else self.chapters[-1]['blocks']
            # A plate can interrupt a paragraph; the edition resumes it unindented.
            continues = self.after_figure and 'nind' in self.para_class and target
            self.after_figure = False
            if continues:
                previous = target[-1]
                if not (previous and isinstance(previous[0], list)):
                    raise SystemExit(f'cannot continue a paragraph in chapter {self.chapters[-1]["roman"]}')
                previous.append([' ', False])
                previous.extend(runs)
            else:
                target.append(runs)

    def handle_data(self, data):
        if self.ended or self.skip:
            return
        if self.letra is not None:
            self.letra += data.strip()
        elif self.para is not None and not self.in_h2:
            self.para.append([data, self.italic > 0])


def normalize_runs(runs):
    """Collapse whitespace; one line break per <br/> group; merge equal runs."""
    out = []
    for text, italic in runs:
        if text == '\n':
            while out and out[-1][0] != '\n' and not out[-1][0].strip():
                out.pop()
            if out and out[-1][0] != '\n':
                out.append(['\n', False])
            continue
        text = re.sub(r'\s+', ' ', text)
        if out and out[-1][0] != '\n' and out[-1][1] == italic:
            out[-1][0] += text
        else:
            out.append([text, italic])
    while out and (out[-1][0] == '\n' or not out[-1][0].strip()):
        out.pop()
    while out and (out[0][0] == '\n' or not out[0][0].strip()):
        out.pop(0)
    if not out:
        return out
    out[0][0] = out[0][0].lstrip()
    out[-1][0] = out[-1][0].rstrip()
    for index, (text, _) in enumerate(out):
        if text == '\n':
            out[index - 1][0] = out[index - 1][0].rstrip()
            out[index + 1][0] = out[index + 1][0].lstrip()
    for run in out:
        if run[0] != '\n':
            run[0] = re.sub(r' {2,}', ' ', run[0])
    return [run for run in out if run[0]]


def restore_opening_case(runs):
    """“IT is a truth…” → “It is a truth…”; “MR. BENNET was…” → “Mr. Bennet was…”."""
    text = runs[0][0]
    match = re.match(r'^(“?)((?:[A-Z][A-Z.’]*[,;:]?\s+)+)', text)
    if not match:
        raise SystemExit(f'no capitals at a chapter opening: {text[:40]!r}')
    words = []
    for index, word in enumerate(match.group(2).split()):
        bare = word.rstrip(',;:')
        if bare == 'I':
            words.append(word)
        elif bare in NAME_WORDS or index == 0:
            words.append(word[0] + word[1:].lower())
        else:
            words.append(word.lower())
    runs[0][0] = match.group(1) + ' '.join(words) + ' ' + text[match.end():]
    return runs


def encode_runs(runs):
    """One string per paragraph: *italic* spans and \\n line breaks."""
    parts = []
    for text, italic in runs:
        if '*' in text:
            raise SystemExit('the text contains the reserved * character')
        if text == '\n' or not italic:
            parts.append(text)
        else:
            core = text.strip()
            parts.append(text[:len(text) - len(text.lstrip())] + f'*{core}*' + text[len(text.rstrip()):])
    return ''.join(parts)


def roman(value):
    numerals = {'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100}
    return sum(-numerals[c] if i + 1 < len(value) and numerals[value[i + 1]] > numerals[c] else numerals[c]
               for i, c in enumerate(value))


def extract_chapters(epub):
    parser = Chapters()
    for part in PARTS:
        parser.feed(epub.read(part).decode('utf-8'))
    if len(parser.chapters) != 61:
        raise SystemExit(f'expected 61 chapters, found {len(parser.chapters)}')
    chapters = []
    for number, chapter in enumerate(parser.chapters, start=1):
        if roman(chapter['roman']) != number:
            raise SystemExit(f'chapter {chapter["roman"]} is out of order')
        blocks = []
        for block in chapter['blocks']:
            if isinstance(block[0][0], str):
                runs = normalize_runs(block)
                blocks.append(encode_runs(restore_opening_case(runs) if not blocks else runs))
            else:
                blocks.append([encode_runs(normalize_runs(paragraph)) for paragraph in block])
        # The printer's imprint after the last chapter is not part of the novel.
        while isinstance(blocks[-1], str) and blocks[-1].startswith('CHISWICK PRESS'):
            blocks.pop()
        chapters.append({'number': number, 'roman': chapter['roman'], 'blocks': blocks})
    return chapters


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sips(*args):
    subprocess.run([SIPS, *map(str, args)], check=True, capture_output=True)


def strip_metadata(path):
    """Drop every APPn segment except JFIF (embedded colour profile, Photoshop
    resources) without re-encoding; the files carry only image data."""
    data = path.read_bytes()
    if data[:2] != b'\xff\xd8':
        raise SystemExit(f'{path.name} is not a JPEG')
    out, index = bytearray(data[:2]), 2
    while index < len(data):
        if data[index] != 0xFF:
            raise SystemExit(f'{path.name} has an unexpected JPEG structure')
        marker = data[index + 1]
        if marker == 0xDA:  # start of scan: copy the rest verbatim
            out += data[index:]
            break
        length = int.from_bytes(data[index + 2:index + 4], 'big')
        segment = data[index:index + 2 + length]
        if not (0xE1 <= marker <= 0xEF):
            out += segment
        index += 2 + length
    path.write_bytes(bytes(out))


def dimensions(path):
    out = subprocess.run([SIPS, '-g', 'pixelWidth', '-g', 'pixelHeight', str(path)],
                         check=True, capture_output=True, text=True).stdout
    return int(re.search(r'pixelWidth: (\d+)', out).group(1)), int(re.search(r'pixelHeight: (\d+)', out).group(1))


def build_illustrations(epub, work, dest):
    entries = []
    for name, member, title, chapter, crop, use in ILLUSTRATIONS:
        original = work / f'{name}.original.jpg'
        original.write_bytes(epub.read(member))
        cropped = work / f'{name}.crop.jpg'
        if crop:
            x, y, w, h = crop
            sips('-s', 'format', 'jpeg', '-s', 'formatOptions', 100, '-c', h, w, '--cropOffset', y, x,
                 original, '--out', cropped)
        else:
            cropped.write_bytes(original.read_bytes())
        source = dest / f'{name}.jpg'
        thumbnail = dest / f'{name}.thumbnail.jpg'
        if use == 'material':
            sips('-s', 'format', 'jpeg', '-s', 'formatOptions', MATERIAL_QUALITY, '-Z', MATERIAL_EDGE,
                 cropped, '--out', source)
            sips('-s', 'format', 'jpeg', '-s', 'formatOptions', THUMBNAIL_QUALITY, '-Z', THUMBNAIL_EDGE,
                 cropped, '--out', thumbnail)
        else:
            sips('-s', 'format', 'jpeg', '-s', 'formatOptions', PORTRAIT_QUALITY, cropped, '--out', source)
            sips('-s', 'format', 'jpeg', '-s', 'formatOptions', THUMBNAIL_QUALITY, '-Z', PORTRAIT_THUMBNAIL_EDGE,
                 cropped, '--out', thumbnail)
        strip_metadata(source)
        strip_metadata(thumbnail)
        width, height = dimensions(source)
        # Sources are JPEGs within the app's 1600px display bound, so the
        # source bytes double as the display variant.
        entries.append({
            'name': name, 'title': title, 'chapter': chapter, 'use': use, 'kind': 'image',
            'mime': 'image/jpeg', 'source': source.name, 'sha256': sha256(source),
            'sizeBytes': source.stat().st_size, 'width': width, 'height': height,
            'variants': {
                'display': {'file': source.name, 'sha256': sha256(source)},
                'thumbnail': {'file': thumbnail.name, 'sha256': sha256(thumbnail)},
            },
        })
    return entries


def main():
    args = sys.argv[1:]
    dest = DEST
    if len(args) == 3 and args[1] == '--out':
        dest = Path(args[2]).resolve()
        args = args[:1]
    if len(args) != 1:
        raise SystemExit('Usage: python3 -I scripts/build-sample-book.py <pride-and-prejudice.epub> [--out DIR]')
    with zipfile.ZipFile(args[0]) as epub:
        opf = epub.read('OEBPS/content.opf').decode('utf-8')
        if 'Pride and Prejudice' not in opf or 'Austen' not in opf:
            raise SystemExit('this EPUB is not the expected edition of Pride and Prejudice')
        chapters = extract_chapters(epub)
        dest.mkdir(parents=True, exist_ok=True)
        text = json.dumps({'chapters': chapters}, ensure_ascii=False, separators=(',', ':')) + '\n'
        if re.search(r'gutenberg', text, re.I):
            raise SystemExit('a reference to the source library leaked into the chapters')
        (dest / 'text.json').write_text(text, encoding='utf-8')
        with tempfile.TemporaryDirectory() as directory:
            illustrations = build_illustrations(epub, Path(directory), dest)
    words = sum(len(re.findall(r"[A-Za-z0-9’'-]+", json.dumps(c['blocks'], ensure_ascii=False))) for c in chapters)
    manifest = {
        'text': {'file': 'text.json', 'sha256': sha256(dest / 'text.json'), 'chapters': len(chapters)},
        'illustrations': illustrations,
    }
    (dest / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    files = {i['source'] for i in illustrations} | {i['variants']['thumbnail']['file'] for i in illustrations}
    total = sum((dest / name).stat().st_size for name in files)
    print(f'{len(chapters)} chapters (~{words} words), {len(illustrations)} illustrations, {total} image bytes')


if __name__ == '__main__':
    main()
