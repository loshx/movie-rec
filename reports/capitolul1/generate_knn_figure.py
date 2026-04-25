from pathlib import Path
from math import sqrt

users = ["U1", "U2", "U3", "U4", "U5", "U6"]
movies = ["M1", "M2", "M3", "M4", "M5", "M6", "M7"]

# 1=interaction/like, 0=none
X = [
    [1, 1, 0, 0, 1, 0, 0],  # U1 target
    [1, 1, 1, 0, 1, 0, 0],
    [0, 1, 0, 1, 0, 1, 0],
    [1, 0, 0, 1, 0, 1, 0],
    [1, 1, 0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 0, 1],
]

def dot(a, b):
    return sum(x*y for x,y in zip(a,b))

def norm(a):
    return sqrt(sum(x*x for x in a))

def cosine(a, b):
    na, nb = norm(a), norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return dot(a,b)/(na*nb)

target_idx = 0
target = X[target_idx]

sims = [cosine(target, row) for row in X]
sims[target_idx] = 0.0

# top-k neighbors
k = 2
neighbor_idx = sorted(range(len(users)), key=lambda i: sims[i], reverse=True)[:k]

# predict unseen movies
unseen = [j for j,v in enumerate(target) if v == 0]
preds = []
for j in unseen:
    num = 0.0
    den = 0.0
    for n in neighbor_idx:
        num += sims[n] * X[n][j]
        den += abs(sims[n])
    score = num/den if den > 0 else 0.0
    preds.append((j, score))

preds.sort(key=lambda x: x[1], reverse=True)

# ---------- SVG ----------
W, H = 1600, 760
svg = []
svg.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
svg.append('<rect x="0" y="0" width="1600" height="760" fill="#0b1220"/>')
svg.append('<text x="40" y="48" fill="#f8fafc" font-size="28" font-family="Arial" font-weight="bold">Filtrare colaborativă bazată pe vecini (User-KNN) - exemplu simplificat</text>')

# panels
panels = [
    (40, 80, 700, 620, "Pas 1: Matrice user-item"),
    (770, 80, 360, 620, "Pas 2: Similaritate cosine (față de U1)"),
    (1150, 80, 410, 620, "Pas 3: Scor predictat pentru itemi nevăzuți"),
]
for x,y,w,h,title in panels:
    svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="#111a2b" stroke="#32435f" stroke-width="2"/>')
    svg.append(f'<text x="{x+20}" y="{y+36}" fill="#dbeafe" font-size="21" font-family="Arial" font-weight="bold">{title}</text>')

# Panel 1 matrix
p1x, p1y = 70, 150
cell = 70
# movie headers
for j,m in enumerate(movies):
    x = p1x + 120 + j*cell + cell/2
    svg.append(f'<text x="{x}" y="{p1y-18}" text-anchor="middle" fill="#93c5fd" font-size="18" font-family="Arial">{m}</text>')
# user rows
for i,u in enumerate(users):
    y = p1y + i*cell + cell/2 + 6
    svg.append(f'<text x="{p1x+55}" y="{y}" text-anchor="middle" fill="#93c5fd" font-size="18" font-family="Arial">{u}</text>')

# cells
for i,row in enumerate(X):
    for j,val in enumerate(row):
        x = p1x + 120 + j*cell
        y = p1y + i*cell
        fill = "#1d4ed8" if val == 1 else "#1f2937"
        svg.append(f'<rect x="{x}" y="{y}" width="{cell-4}" height="{cell-4}" rx="8" fill="{fill}" stroke="#334155" stroke-width="1"/>')
        txt = "1" if val == 1 else "0"
        clr = "#eff6ff" if val == 1 else "#94a3b8"
        svg.append(f'<text x="{x + (cell-4)/2}" y="{y + (cell-4)/2 + 6}" text-anchor="middle" fill="{clr}" font-size="20" font-family="Arial" font-weight="bold">{txt}</text>')

# target highlight U1
target_y = p1y + target_idx*cell
svg.append(f'<rect x="{p1x+114}" y="{target_y-3}" width="{len(movies)*cell+8}" height="{cell+2}" rx="12" fill="none" stroke="#ef4444" stroke-width="3"/>')
svg.append(f'<text x="{p1x+640}" y="{target_y+24}" fill="#ef4444" font-size="16" font-family="Arial" font-weight="bold">user țintă</text>')

# Panel 2 bars similarities (except U1)
p2x, p2y = 795, 160
bar_w = 42
gap = 18
base_y = 650
max_h = 420
s_items = [(users[i], sims[i], i) for i in range(len(users)) if i != target_idx]

svg.append(f'<line x1="{p2x}" y1="{base_y}" x2="{p2x+320}" y2="{base_y}" stroke="#64748b" stroke-width="2"/>')
for idx,(label,val,orig_idx) in enumerate(s_items):
    x = p2x + 22 + idx*(bar_w+gap)
    h = max_h * val
    y = base_y - h
    fill = "#22c55e" if orig_idx in neighbor_idx else "#64748b"
    svg.append(f'<rect x="{x}" y="{y}" width="{bar_w}" height="{h}" rx="6" fill="{fill}"/>')
    svg.append(f'<text x="{x+bar_w/2}" y="{base_y+24}" text-anchor="middle" fill="#cbd5e1" font-size="15" font-family="Arial">{label}</text>')
    svg.append(f'<text x="{x+bar_w/2}" y="{y-10}" text-anchor="middle" fill="#e2e8f0" font-size="14" font-family="Arial">{val:.2f}</text>')

for n_i, ni in enumerate(neighbor_idx):
    svg.append(f'<text x="{p2x+15}" y="{210 + n_i*30}" fill="#22c55e" font-size="15" font-family="Arial" font-weight="bold">Top-{n_i+1}: {users[ni]}</text>')

# Panel 3 predictions
p3x, p3y = 1175, 160
base3 = 650
max3 = 420
svg.append(f'<line x1="{p3x}" y1="{base3}" x2="{p3x+350}" y2="{base3}" stroke="#64748b" stroke-width="2"/>')
for idx,(j,score) in enumerate(preds):
    x = p3x + 18 + idx*78
    h = max3 * score
    y = base3 - h
    color = "#f59e0b" if idx > 0 else "#f97316"
    svg.append(f'<rect x="{x}" y="{y}" width="56" height="{h}" rx="6" fill="{color}"/>')
    svg.append(f'<text x="{x+28}" y="{base3+24}" text-anchor="middle" fill="#cbd5e1" font-size="14" font-family="Arial">{movies[j]}</text>')
    svg.append(f'<text x="{x+28}" y="{y-10}" text-anchor="middle" fill="#e2e8f0" font-size="14" font-family="Arial">{score:.2f}</text>')

if preds:
    top_movie = movies[preds[0][0]]
    svg.append(f'<text x="{p3x+16}" y="210" fill="#fb923c" font-size="15" font-family="Arial" font-weight="bold">Recomandare #1: {top_movie}</text>')

svg.append('<text x="40" y="735" fill="#93c5fd" font-size="14" font-family="Arial">Figura A1. Demonstrație KNN (matrice interacțiuni, selecție vecini, scor recomandare).</text>')
svg.append('</svg>')

out_dir = Path(__file__).parent
svg_path = out_dir / "figura_knn_colaborativ.svg"
svg_path.write_text("\n".join(svg), encoding="utf-8")

summary = out_dir / "knn_demo_rezumat.txt"
with summary.open("w", encoding="utf-8") as f:
    f.write("Target user: U1\n")
    f.write("Top-k neighbors: " + ", ".join(users[i] for i in neighbor_idx) + "\n")
    if preds:
        f.write(f"Top recommendation: {movies[preds[0][0]]} (score={preds[0][1]:.3f})\n")

print(f"Saved: {svg_path}")
print(f"Saved: {summary}")
