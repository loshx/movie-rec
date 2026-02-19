# ML Recommendations Service (Python)

This service trains a hybrid recommender and exposes personalized recommendations:

- Collaborative filtering with `KNN` (cosine similarity between users)
- Item-based filtering with `KNN` (similar items from user history)
- Latent factors with `SVD` (`TruncatedSVD`)
- Popularity fallback

## 1) Data you need

Table: `user_interactions`

- `user_id` (int)
- `tmdb_id` (int)
- `media_type` (`movie` or `tv`)
- `event_type` (`watchlist`, `watched`, `favorite`, `rating`)
- `event_type` (`watchlist`, `watched`, `favorite`, `rating`, `favorite_actor`)
- `event_value` (float, only used for ratings)
- `occurred_at` (timestamp)

Use `ml/schema.sql` to create tables in PostgreSQL.

## 2) Install and run

```bash
cd ml
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Set DB connection:

```bash
set ML_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/movierec
```

Run API:

```bash
uvicorn api:app --host 0.0.0.0 --port 8008 --reload
```

## 3) Train model

```bash
curl -X POST "http://localhost:8008/train?media_type=movie"
```

## 4) Get recommendations

```bash
curl "http://localhost:8008/recommendations/1?media_type=movie&top_n=20"
```

## 5) Explain a recommendation

Shows why a title was recommended (score parts + similar users + similar seen items):

```bash
curl "http://localhost:8008/explain/1/550?media_type=movie"
```

## 6) App integration

In `app.json` set:

```json
"EXPO_PUBLIC_ML_API_URL": "http://localhost:8008"
```

If URL is empty or API is down, the app automatically falls back to the existing non-ML logic.
