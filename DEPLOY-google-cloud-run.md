# Deploy the lead-qualifier to Google Cloud Run (no Railway)

This hosts the app entirely in Google and serves it on your own domain
(`leads.financialplannersofamerica.com`) with an automatic, Google-managed TLS
certificate. Run these commands on your machine, logged in as a Google account
that owns the domain and a Google Cloud project with billing enabled.

## 0. One-time prerequisites

```bash
# Install the gcloud CLI: https://cloud.google.com/sdk/docs/install
gcloud auth login
gcloud auth application-default login

export PROJECT_ID=your-gcp-project-id      # <-- change me
export REGION=us-central1                  # any Cloud Run region

gcloud config set project "$PROJECT_ID"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

## 1. Build & deploy from source

Run from the repo root (where the `Dockerfile` is). Cloud Build packages the
container and Cloud Run runs it.

```bash
gcloud run deploy lead-qualifier \
  --source . \
  --region "$REGION" \
  --port 8080 \
  --allow-unauthenticated
```

This prints a URL like `https://lead-qualifier-xxxxxxxxxx-uc.a.run.app`. Open it
to confirm the app works before wiring up the domain.

> **Privacy note:** `--allow-unauthenticated` makes the app public — anyone with
> the URL can upload CSVs of personal contact data and see results. For a
> financial firm this is the thing to lock down. To require Google sign-in
> instead, drop that flag and put [Identity-Aware Proxy](https://cloud.google.com/iap/docs/enabling-cloud-run)
> in front, or add an app-level password. Ask me and I'll wire in a password gate.

## 2. Map your custom domain

Cloud Run can serve your subdomain directly.

```bash
# You may first need to verify domain ownership (one-time), which opens
# Google Search Console:
gcloud domains verify financialplannersofamerica.com

gcloud beta run domain-mappings create \
  --service lead-qualifier \
  --domain leads.financialplannersofamerica.com \
  --region "$REGION"
```

The command prints the **DNS record** to add. For a subdomain it is almost
always a single CNAME:

| Type  | Name / Host | Value / Target        |
|-------|-------------|-----------------------|
| CNAME | `leads`     | `ghs.googlehosted.com.` |

## 3. Update DNS (important — you already have a record here)

`leads.financialplannersofamerica.com` currently points at Railway
(`CNAME leads -> mkzaixnn.up.railway.app`). A hostname can only point one place,
so **edit that existing record** to the value Cloud Run gave you
(`ghs.googlehosted.com.`) rather than adding a second one.

- **Google Domains / Squarespace:** DNS panel → edit the `leads` CNAME.
- **Google Cloud DNS:** edit the record set for `leads.financialplannersofamerica.com.`.

Google auto-provisions the managed TLS certificate once the record resolves
(usually 15 min – a few hours). Until then a cert warning is normal.

## 4. (Optional) Decommission Railway

Once Cloud Run serves the domain and the cert is green, the Railway project can
be deleted so you're not paying two hosts. I can remove the Railway custom domain
and service for you on request, or you can delete the project from the Railway
dashboard.

---

### Alternative: Google App Engine

If you'd rather use App Engine, add an `app.yaml` with `runtime: custom` +
`env: flex` (reusing this same `Dockerfile`), then `gcloud app deploy` and
`gcloud app domain-mappings create leads.financialplannersofamerica.com`.
Cloud Run is simpler and cheaper (scales to zero), so it's the recommended path.
