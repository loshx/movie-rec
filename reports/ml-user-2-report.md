# ML User 2 Recommendation Report

Generated: 2026-05-31T18:11:12.735Z
User ID: 2
Media type: movie
Model rows: 71

## Top 10 recommendations

| Rank | Title | TMDB ID | Score | Reason |
|---|---|---:|---:|---|
| 1 | The Super Mario Galaxy Movie | 1226863 | 0.5962 | profile+hybrid |
| 2 | Zootopia 2 | 1084242 | 0.5793 | profile+hybrid |
| 3 | 28 Years Later: The Bone Temple | 1272837 | 0.4434 | profile+hybrid |
| 4 | Elio | 1022787 | 0.3242 | profile+hybrid |
| 5 | The Boss Baby: Family Business | 459151 | 0.3242 | profile+hybrid |
| 6 | The SpongeBob Movie: Sponge Out of Water | 228165 | 0.3242 | profile+hybrid |
| 7 | Home | 228161 | 0.3242 | profile+hybrid |
| 8 | The Exorcist | 9552 | 0.3242 | profile+hybrid |
| 9 | Big Hero 6 | 177572 | 0.3242 | profile+hybrid |
| 10 | The Lego Movie | 137106 | 0.3242 | profile+hybrid |

## Explain for top recommendation

Title: The Super Mario Galaxy Movie

Final score: 0.5962

| Component | Contribution |
|---|---:|
| user_knn | 0.2518 |
| item_knn | 0.2069 |
| svd | 0.0936 |
| follow_taste | 0.0000 |
| popularity | 0.0438 |

## Note

Offline evaluation metrics remain unavailable because the local evaluation dataset has insufficient user history in server/data/cinema-events.json.
