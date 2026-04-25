from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
from math import sqrt

users = ["U1", "U2", "U3", "U4", "U5", "U6"]
movies = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"]
X = [
    [1, 1, 0, 0, 1, 0, 0],
    [1, 1, 1, 0, 1, 0, 0],
    [0, 1, 0, 1, 0, 1, 0],
    [1, 0, 0, 1, 0, 1, 0],
    [1, 1, 0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 0, 1],
]

def dot(a,b): return sum(x*y for x,y in zip(a,b))
def norm(a): return sqrt(sum(x*x for x in a))
def cosine(a,b):
    na, nb = norm(a), norm(b)
    return 0.0 if na == 0 or nb == 0 else dot(a,b)/(na*nb)

target_idx = 0
target = X[target_idx]
sims = [cosine(target,row) for row in X]
sims[target_idx] = 0.0
neighbor_idx = sorted(range(len(users)), key=lambda i: sims[i], reverse=True)[:2]
unseen = [j for j,v in enumerate(target) if v == 0]
preds=[]
for j in unseen:
    num=den=0.0
    for n in neighbor_idx:
        num += sims[n] * X[n][j]
        den += abs(sims[n])
    preds.append((j, num/den if den>0 else 0.0))
preds.sort(key=lambda x:x[1], reverse=True)

W,H = 1600,760
img = Image.new('RGB', (W,H), '#0b1220')
draw = ImageDraw.Draw(img)

# fonts
try:
    font_title = ImageFont.truetype('arial.ttf', 34)
    font_h = ImageFont.truetype('arial.ttf', 24)
    font = ImageFont.truetype('arial.ttf', 20)
    font_s = ImageFont.truetype('arial.ttf', 17)
except Exception:
    font_title = ImageFont.load_default()
    font_h = ImageFont.load_default()
    font = ImageFont.load_default()
    font_s = ImageFont.load_default()

draw.text((40,25), 'Filtrare colaborativa bazata pe vecini (User-KNN) - exemplu simplificat', fill='#f8fafc', font=font_h)

# panel helper
def panel(x,y,w,h,title):
    draw.rounded_rectangle((x,y,x+w,y+h), radius=16, fill='#111a2b', outline='#32435f', width=2)
    draw.text((x+16,y+14), title, fill='#dbeafe', font=font)

panel(40,80,700,620,'Pas 1: Matrice user-item')
panel(770,80,360,620,'Pas 2: Similaritate cosine (fata de U1)')
panel(1150,80,410,620,'Pas 3: Scor predictat pentru itemi nevazuti')

# matrix
p1x,p1y=70,150
cell=70
for j,m in enumerate(movies):
    draw.text((p1x+140+j*cell, p1y-32), m, fill='#93c5fd', font=font_s)
for i,u in enumerate(users):
    draw.text((p1x+36, p1y+20+i*cell), u, fill='#93c5fd', font=font_s)
for i,row in enumerate(X):
    for j,v in enumerate(row):
        x = p1x+120+j*cell
        y = p1y+i*cell
        fill = '#1d4ed8' if v==1 else '#1f2937'
        draw.rounded_rectangle((x,y,x+cell-6,y+cell-6), radius=8, fill=fill, outline='#334155', width=1)
        draw.text((x+24,y+18), str(v), fill='#eff6ff' if v==1 else '#94a3b8', font=font)

ty = p1y + target_idx*cell
draw.rounded_rectangle((p1x+116, ty-2, p1x+116+len(movies)*cell, ty+cell), radius=10, outline='#ef4444', width=3)
draw.text((p1x+610, ty+18), 'user tinta', fill='#ef4444', font=font_s)

# similarities bars
p2x=790
base=650
maxh=420
items=[(users[i], sims[i], i) for i in range(len(users)) if i!=target_idx]
for idx,(lab,val,orig) in enumerate(items):
    x = p2x+26+idx*58
    h = int(maxh*val)
    y = base-h
    color = '#22c55e' if orig in neighbor_idx else '#64748b'
    draw.rounded_rectangle((x,y,x+40,base), radius=6, fill=color)
    draw.text((x+4, base+8), lab, fill='#cbd5e1', font=font_s)
    draw.text((x+2, y-22), f'{val:.2f}', fill='#e2e8f0', font=font_s)
for i,n in enumerate(neighbor_idx):
    draw.text((p2x+16, 210+i*30), f'Top-{i+1}: {users[n]}', fill='#22c55e', font=font_s)

# predictions
p3x=1160
for idx,(j,score) in enumerate(preds):
    x = p3x+18+idx*78
    h = int(maxh*score)
    y = base-h
    color = '#f97316' if idx==0 else '#f59e0b'
    draw.rounded_rectangle((x,y,x+56,base), radius=6, fill=color)
    draw.text((x+10, base+8), movies[j], fill='#cbd5e1', font=font_s)
    draw.text((x+8, y-22), f'{score:.2f}', fill='#e2e8f0', font=font_s)
if preds:
    draw.text((p3x+16, 210), f'Recomandare #1: {movies[preds[0][0]]}', fill='#fb923c', font=font_s)

draw.text((40,730), 'Figura A1. Demonstratie KNN (matrice interactiuni, selectie vecini, scor recomandare).', fill='#93c5fd', font=font_s)

out=Path(__file__).parent/'figura_knn_colaborativ.png'
img.save(out)
print(f'Saved: {out}')
