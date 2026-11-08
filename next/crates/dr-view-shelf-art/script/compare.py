"""Side by side: the 0.1 client's covers (ref/) and the port's (ours/).
usage: compare.py <dir> <style> [<style> …]  ->  <dir>/cmp-<style>.png, and a
mean absolute difference per book (0–255) printed."""
import sys, os
from PIL import Image, ImageChops, ImageStat
d = sys.argv[1]
books = ['saga', 'short', 'bare', 'latin']
for style in sys.argv[2:]:
    w, h = 252, 452
    sheet = Image.new('RGB', (len(books) * (2 * w + 30) + 10, h + 20), (190, 190, 190))
    diffs = []
    for i, b in enumerate(books):
        x = 10 + i * (2 * w + 30)
        for j, side in enumerate(['ref', 'ours']):
            p = os.path.join(d, side, f'{b}-{style}.png')
            if os.path.exists(p):
                sheet.paste(Image.open(p).convert('RGB'), (x + j * (w + 4), 10))
        a, o = (os.path.join(d, s, f'{b}-{style}.png') for s in ('ref', 'ours'))
        if os.path.exists(a) and os.path.exists(o):
            diff = ImageChops.difference(Image.open(a).convert('RGB'), Image.open(o).convert('RGB'))
            diffs.append(f'{b}={sum(ImageStat.Stat(diff).mean) / 3:.1f}')
    sheet.save(os.path.join(d, f'cmp-{style}.png'))
    print(style, ' '.join(diffs))
