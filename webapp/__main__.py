"""Entrypoint: `python -m webapp` — reads PORT from the environment itself,
so the start command needs no shell variable expansion."""

import os

import uvicorn

from webapp.main import app

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
