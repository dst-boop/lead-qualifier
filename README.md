# lead-qualifier

A Streamlit app that qualifies leads from a ZoomInfo CSV export. Upload a CSV and
the tool auto-detects common ZoomInfo column names, scores each lead, and sorts
them into four tiers: **Ideal Client**, **Good**, **Maybe**, and **Not Good**.

## Run locally

```bash
pip install -r requirements.txt
streamlit run app.py
```

Then open http://localhost:8501.

## Hosting (Railway)

The app is deployed on [Railway](https://railway.app) from this repo's `main`
branch. Deployment settings live in [`railway.json`](./railway.json):

- **Builder:** Railpack (auto-detects Python from `requirements.txt`).
- **Start command:** `streamlit run app.py --server.port $PORT --server.address 0.0.0.0 --server.headless true`
  — Streamlit must bind to `$PORT` and `0.0.0.0` for Railway's proxy to reach it.
- **Healthcheck:** `/_stcore/health` (Streamlit's built-in endpoint).

Dependency versions in `requirements.txt` are pinned to the versions that are
known to build and run, so a rebuild can't silently pull a breaking major
release.

### Custom domain

The app is reachable at its Railway URL and at the custom domain
`leads.financialplannersofamerica.com`. To point a domain at the service, add it
in Railway (Service → Settings → Networking → Custom Domain) and create the DNS
record Railway returns at your DNS provider — a `CNAME` from the subdomain to the
`*.up.railway.app` target Railway gives you. Railway provisions the TLS
certificate automatically once the record resolves.
