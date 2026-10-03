from PIL import Image
import os
os.makedirs('out/annex', exist_ok=True)
for src, tag in [('out/annex_p17843.png','p43'), ('out/annex_p17844.png','p44')]:
    im = Image.open(src).convert('L')
    w, h = im.size
    n = 4
    step = h // n
    for i in range(n):
        top = max(0, i*step - 40)
        bot = min(h, (i+1)*step + 40)
        crop = im.crop((0, top, w, bot))
        cw, ch = crop.size
        scale = 1500.0 / cw
        crop = crop.resize((1500, int(ch*scale)), Image.LANCZOS)
        out = f'out/annex/{tag}_{i+1}.png'
        crop.save(out)
        print(out, crop.size)