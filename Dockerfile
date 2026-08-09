# Container image for the Streamlit lead-qualifier app.
# Works on any container host (Google Cloud Run, App Engine flex, Fly, etc.).
FROM python:3.13-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run injects $PORT at runtime (defaults to 8080). The webapp entrypoint
# reads it from the environment itself, so no shell expansion is needed.
ENV PORT=8080
EXPOSE 8080

CMD ["python", "-m", "webapp"]
