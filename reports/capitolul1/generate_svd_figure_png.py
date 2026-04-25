from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

users = ["U1", "U2", "U3", "U4"]
items = ["I1", "I2", "I3", "I4", "I5"]

R = [
    [5, 4, None, 1, None],
    [4, None, 2, 1, None],
    [1, 2, 4, None, 5],
    [None, 1, 5, 4, 4],
]

P = [
    [1.25, 0.10],
    [1.05, 0.15],
    [0.20, 1.10],
    [0.15, 1.00],
]
Q = [
    [1.10, 0.10],
    [0.95, 0.20],
    [0.25, 1.00],
    [0.20, 0.85],
    [0.10, 1.15],
]

u_idx = 0
i_idx = 2

R_hat = []
for u in range(len(users)):
    row = []
    for i in range(len(items)):
        v = sum(P[u][k] * Q[i][k] for k in range(2))
        v = max(1.0, min(5.0, v * 3.0))
        row.append(v)
    R_hat.append(row)

W, H = 1750, 860
img = Image.new("RGB", (W, H), "#0b1220")
d = ImageDraw.Draw(img)

try:
    ft_h = ImageFont.truetype("arial.ttf", 24)
    ft = ImageFont.truetype("arial.ttf", 20)
    ft_s = ImageFont.truetype("arial.ttf", 16)
except Exception:
    ft_h = ft = ft_s = ImageFont.load_default()

d.text((36, 26), "Metode de factorizare latenta (SVD) - exemplu ilustrativ", fill="#f8fafc", font=ft_h)

def panel(x,y,w,h,title):
    d.rounded_rectangle((x,y,x+w,y+h), radius=18, fill="#111a2b", outline="#334155", width=2)
    d.text((x+16,y+12), title, fill="#dbeafe", font=ft)

panel(35, 80, 560, 710, "Pas 1: Matricea observata R (cu valori lipsa)")
panel(615, 80, 520, 710, "Pas 2: Factori latenti (P si Q)")
panel(1155, 80, 560, 710, "Pas 3: Reconstructie R-hat si scor estimat")

def draw_matrix(x, y, rows, cols, values, row_labels, col_labels, highlight=None):
    cw, ch = 80, 70
    for j, c in enumerate(col_labels):
        d.text((x + 110 + j*cw + 28, y - 28), c, fill="#93c5fd", font=ft_s)
    for i, r in enumerate(row_labels):
        d.text((x + 40, y + i*ch + 24), r, fill="#93c5fd", font=ft_s)

    for i in range(rows):
        for j in range(cols):
            xx = x + 100 + j*cw
            yy = y + i*ch
            v = values[i][j]
            if v is None:
                fill = "#1f2937"
                txt = "?"
                tcol = "#94a3b8"
            else:
                fill = '#1d4ed8' if (not isinstance(v,float) or v >= 3.0) else '#2563eb'
                txt = f"{v:.1f}" if isinstance(v,float) else str(v)
                tcol = "#eff6ff"
            d.rounded_rectangle((xx,yy,xx+cw-6,yy+ch-6), radius=8, fill=fill, outline="#334155", width=1)
            d.text((xx+22,yy+20), txt, fill=tcol, font=ft_s)

    if highlight:
        hi, hj, col = highlight
        hx = x + 100 + hj*cw
        hy = y + hi*ch
        d.rounded_rectangle((hx-2,hy-2,hx+cw-4,hy+ch-4), radius=10, outline=col, width=3)

x1, y1 = 58, 165
draw_matrix(x1, y1, len(users), len(items), R, users, items, highlight=(0,2,"#ef4444"))
d.text((x1+95, y1+320), "Exemplu: R[U1,I3] este necunoscut.", fill="#ef4444", font=ft_s)
text1 = (
    "Obiectiv: aproximam R ~ P·Q^T,\n"
    "unde P descrie utilizatori,\n"
    "iar Q descrie itemi in spatiul latent."
)
d.text((x1+18, y1+370), text1, fill="#cbd5e1", font=ft_s)

x2, y2 = 640, 170
d.text((x2+8, y2-28), "P (user x factori)", fill="#93c5fd", font=ft_s)
draw_matrix(x2, y2, len(users), 2, [[round(v,2) for v in r] for r in P], users, ["F1","F2"])

d.text((x2+255, y2-28), "Q (item x factori)", fill="#93c5fd", font=ft_s)
draw_matrix(x2+245, y2, len(items), 2, [[round(v,2) for v in r] for r in Q], items, ["F1","F2"])

text2 = (
    "Interpretare simpla:\n"
    "F1 ~ preferinta zona A\n"
    "F2 ~ preferinta zona B\n"
    "Scor(u,i) = produs scalar\n"
    "intre vectorii latenti."
)
d.text((x2+10, y2+420), text2, fill="#cbd5e1", font=ft_s)

x3, y3 = 1178, 165
draw_matrix(x3, y3, len(users), len(items), [[round(v,1) for v in r] for r in R_hat], users, items, highlight=(0,2,"#22c55e"))

pred_scaled = R_hat[u_idx][i_idx]
d.text((x3+95, y3+320), f"Predictie pentru U1-I3: {pred_scaled:.2f}", fill="#22c55e", font=ft)
text3 = (
    "Dupa antrenare, valorile lipsa sunt estimate\n"
    "si itemii nevazuti se ordoneaza\n"
    "dupa scorul final."
)
d.text((x3+10, y3+370), text3, fill="#cbd5e1", font=ft_s)

d.text((36, 815), "Figura A2. Exemplu ilustrativ pentru factorizare latenta/SVD in sisteme de recomandare.", fill="#93c5fd", font=ft_s)

out_dir = Path(__file__).parent
out_png = out_dir / "figura_svd_latent.png"
img.save(out_png)

summary = out_dir / "svd_demo_rezumat.txt"
summary.write_text(
    "Figura A2 - Rezumat\n"
    f"Exemplu predictie: U1-I3 = {pred_scaled:.2f}\n"
    "Model: R ~ P·Q^T (2 factori latenti)\n",
    encoding="utf-8"
)

print(f"Saved: {out_png}")
print(f"Saved: {summary}")
