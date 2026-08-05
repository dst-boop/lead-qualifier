# Container image for the Streamlit lead-qualifier app.
# Works on any container host (Google Cloud Run, App Engine flex, Fly, etc.).
FROM python:3.13-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run injects $PORT at runtime (defaults to 8080). Streamlit MUST bind to
# it and to 0.0.0.0 or the platform's proxy can't reach the container.
ENV PORT=8080
EXPOSE 8080

# Shell form so $PORT expands at container start.
CMD streamlit run app.py \
    --server.port=$PORT \
    --server.address=0.0.0.0 \
    --server.headless=true \
    --server.enableCORS=false \
    --server.enableXsrfProtection=true
