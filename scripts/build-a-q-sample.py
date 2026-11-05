#!/usr/bin/env python3
"""Rebuild the second built-in sample's text from the public-domain source.

Usage:

    curl -sS -A 'Drifting-sample-builder/1.0' -o a-q.json \
      'https://zh.wikisource.org/w/api.php?action=parse&page=%E9%98%BFQ%E6%AD%A3%E5%82%B3&prop=text&format=json&formatversion=2&variant=zh-hans'
    python3 -I scripts/build-a-q-sample.py a-q.json [--out DIR]

The source is Wikisource's transcription of Lu Xun's "The True Story of Ah Q"
(阿Q正傳) from volume one of the 1948 Complete Works (魯迅全集), rendered in
simplified characters by Wikisource's own converter (the `variant=zh-hans`
above). The response is read as untrusted data: only the chapter headings and
the paragraphs under them are kept, as plain text.

The sample is the novel half written: it keeps the first six of its nine
chapters; src/renderer/services/built-in-sample/a-q.ts plans the other three.
Changes from the source, nothing else:
  - the edition's 『』 and 「」 become the “” and ‘’ simplified Chinese uses now;
  - 偸, a variant form, becomes 偷;
  - Wikisource's zero-width page joins and its section edit links are dropped;
  - ERRATA below: transcription slips that make no sense in context (赵太爷 is
    never a 秀才; his son, the 秀才, is 赵大爷), each checked against later
    printings and applied only where it occurs exactly once. Readings that are
    merely the 1948 edition's (馀, 枝, 翦, 矇眬, 、 for ， and the like) stay.

Writes src/renderer/services/built-in-sample/a-q/text.json (or --out DIR, which
the content test uses to check the checked-in file against the source):
  {"chapters": [{"number", "roman", "title", "blocks"}]}, each block one paragraph.
The app never runs this script; it reads the checked-in file.
"""
import html
import json
import re
import sys
from pathlib import Path

DEST = Path(__file__).resolve().parents[1] / 'src/renderer/services/built-in-sample/a-q'
WRITTEN_CHAPTERS = 6
NUMERALS = '一二三四五六七八九'
QUOTES = str.maketrans({'『': '“', '』': '”', '「': '‘', '」': '’', '偸': '偷'})
# (chapter, as transcribed, corrected)
ERRATA = [
    (2, '在情神上', '在精神上'),
    (3, '响了之后。于他倒', '响了之后，于他倒'),
    (3, '“咳，开！”', '“咳，呸！”'),
    (4, '是赵太爷未进秀才的时候', '是赵大爷未进秀才的时候'),
    (4, '看见赵太爷向他奔来', '看见赵大爷向他奔来'),
    (4, '皮肤有些起栗', '皮肤有些起粟'),
    (6, '钱太爷和秀才太爷上城', '钱太爷和秀才大爷上城'),
]


def correct(chapter: dict) -> None:
    for number, wrong, right in ERRATA:
        if number != chapter['number']:
            continue
        hits = [index for index, block in enumerate(chapter['blocks']) if wrong in block]
        if len(hits) != 1 or chapter['blocks'][hits[0]].count(wrong) != 1:
            raise SystemExit(f'Erratum {wrong!r} must occur once in chapter {number}')
        chapter['blocks'][hits[0]] = chapter['blocks'][hits[0]].replace(wrong, right)


def plain(fragment: str) -> str:
    text = html.unescape(re.sub(r'<[^>]+>', '', fragment))
    return text.replace('\u200b', '').replace('\n', '').replace('[编辑]', '').strip()


def chapters(rendered: str) -> list:
    rendered = re.sub(r'<style.*?</style>', '', rendered, flags=re.S)
    parts = re.split(r'<h[23][^>]*>(.*?)</h[23]>', rendered, flags=re.S)
    found = []
    for index in range(1, len(parts), 2):
        heading = plain(parts[index])
        match = re.match(r'^第([一二三四五六七八九])章\s*(\S.*)$', heading)
        if not match:
            continue
        number = NUMERALS.index(match.group(1)) + 1
        blocks = [plain(paragraph).translate(QUOTES) for paragraph in re.findall(r'<p[^>]*>(.*?)</p>', parts[index + 1], re.S)]
        found.append({'number': number, 'roman': match.group(1), 'title': match.group(2).strip(), 'blocks': [b for b in blocks if b]})
    numbers = [chapter['number'] for chapter in found]
    if numbers != list(range(1, 10)):
        raise SystemExit(f'Expected chapters 1–9 in order, found {numbers}')
    return found[:WRITTEN_CHAPTERS]


def main() -> None:
    args = sys.argv[1:]
    out = DEST
    if '--out' in args:
        index = args.index('--out')
        out = Path(args[index + 1])
        del args[index:index + 2]
    if len(args) != 1:
        raise SystemExit(__doc__)
    response = json.loads(Path(args[0]).read_text(encoding='utf-8'))
    text = chapters(response['parse']['text'])
    for chapter in text:
        correct(chapter)
    for chapter in text:
        for block in chapter['blocks']:
            leftover = re.findall(r'[『』「」偸<>\u200b]', block)
            if leftover:
                raise SystemExit(f'Chapter {chapter["number"]} kept {leftover}: {block[:40]}')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'text.json').write_text(json.dumps({'chapters': text}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{out / "text.json"}: {len(text)} chapters, {sum(len(b) for c in text for b in c["blocks"])} characters')


if __name__ == '__main__':
    main()
