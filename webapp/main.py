"""Lead Qualifier web app — Phase 1.

FastAPI backend serving the browser-based qualifier UI, with "Sign in with
Microsoft" (MSAL auth-code flow) and Microsoft Graph actions: send an email
and create a calendar event (which emails the attendee an invite) from the
signed-in user's own O365 account.

Required environment variables (see SETUP-microsoft.md):
  MS_CLIENT_ID      Entra app registration → Application (client) ID
  MS_CLIENT_SECRET  Entra app registration → client secret value
  MS_TENANT_ID      Entra Directory (tenant) ID
  APP_BASE_URL      Public URL of this app, no trailing slash
                    (e.g. https://leads.financialplannersofamerica.com)
"""

import os
import secrets
from pathlib import Path
from typing import Optional

import httpx
import msal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, EmailStr

CLIENT_ID = os.environ.get("MS_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET", "")
TENANT_ID = os.environ.get("MS_TENANT_ID", "common")
BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8000").rstrip("/")

AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
REDIRECT_PATH = "/auth/callback"
# Delegated scopes: read profile, send mail as the user, manage their calendar.
SCOPES = ["User.Read", "Mail.Send", "Calendars.ReadWrite"]
GRAPH = "https://graph.microsoft.com/v1.0"

STATIC_DIR = Path(__file__).parent / "static"
SESSION_COOKIE = "lq_session"

# Single-replica in-memory session store: sid -> {"token_cache": str, "flow": dict}
SESSIONS: dict[str, dict] = {}

app = FastAPI(title="Lead Qualifier")


@app.middleware("http")
async def session_middleware(request: Request, call_next):
    sid = request.cookies.get(SESSION_COOKIE)
    is_new = sid is None or sid not in SESSIONS
    if is_new:
        sid = secrets.token_urlsafe(32)
        SESSIONS[sid] = {}
    request.state.sid = sid
    request.state.session = SESSIONS[sid]
    response = await call_next(request)
    if is_new:
        response.set_cookie(
            SESSION_COOKIE, sid,
            httponly=True, samesite="lax",
            secure=BASE_URL.startswith("https"),
            max_age=8 * 3600,
        )
    return response


# ------------------------- MSAL helpers -------------------------

def _load_cache(session: dict) -> msal.SerializableTokenCache:
    cache = msal.SerializableTokenCache()
    if session.get("token_cache"):
        cache.deserialize(session["token_cache"])
    return cache


def _save_cache(session: dict, cache: msal.SerializableTokenCache) -> None:
    if cache.has_state_changed:
        session["token_cache"] = cache.serialize()


def _msal_app(cache: Optional[msal.SerializableTokenCache] = None) -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        CLIENT_ID, authority=AUTHORITY,
        client_credential=CLIENT_SECRET, token_cache=cache,
    )


def _access_token(session: dict) -> Optional[str]:
    cache = _load_cache(session)
    client = _msal_app(cache)
    accounts = client.get_accounts()
    if not accounts:
        return None
    result = client.acquire_token_silent(SCOPES, account=accounts[0])
    _save_cache(session, cache)
    if result and "access_token" in result:
        return result["access_token"]
    return None


def _require_token(request: Request) -> str:
    token = _access_token(request.state.session)
    if not token:
        raise HTTPException(status_code=401, detail="Not signed in to Microsoft")
    return token


# ------------------------- Auth routes -------------------------

@app.get("/auth/login")
async def login(request: Request):
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(
            status_code=500,
            detail="Microsoft app credentials not configured — set MS_CLIENT_ID / "
                   "MS_CLIENT_SECRET / MS_TENANT_ID (see SETUP-microsoft.md).",
        )
    cache = _load_cache(request.state.session)
    flow = _msal_app(cache).initiate_auth_code_flow(
        SCOPES, redirect_uri=BASE_URL + REDIRECT_PATH
    )
    request.state.session["flow"] = flow
    return RedirectResponse(flow["auth_uri"])


@app.get(REDIRECT_PATH)
async def auth_callback(request: Request):
    session = request.state.session
    flow = session.pop("flow", None)
    if not flow:
        return RedirectResponse("/")
    cache = _load_cache(session)
    try:
        result = _msal_app(cache).acquire_token_by_auth_code_flow(
            flow, dict(request.query_params)
        )
    except ValueError:
        return RedirectResponse("/")
    _save_cache(session, cache)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result.get("error_description", "Sign-in failed"))
    return RedirectResponse("/")


@app.get("/auth/logout")
async def logout(request: Request):
    SESSIONS.pop(request.state.sid, None)
    response = RedirectResponse("/")
    response.delete_cookie(SESSION_COOKIE)
    return response


# ------------------------- API routes -------------------------

@app.get("/api/me")
async def me(request: Request):
    token = _access_token(request.state.session)
    if not token:
        return JSONResponse({"signed_in": False})
    async with httpx.AsyncClient(timeout=15) as cx:
        r = await cx.get(f"{GRAPH}/me", headers={"Authorization": f"Bearer {token}"})
    if r.status_code != 200:
        return JSONResponse({"signed_in": False})
    d = r.json()
    return {
        "signed_in": True,
        "name": d.get("displayName"),
        "email": d.get("mail") or d.get("userPrincipalName"),
    }


class EmailRequest(BaseModel):
    to: EmailStr
    subject: str
    body: str


@app.post("/api/send-email")
async def send_email(req: EmailRequest, request: Request):
    token = _require_token(request)
    payload = {
        "message": {
            "subject": req.subject,
            "body": {"contentType": "Text", "content": req.body},
            "toRecipients": [{"emailAddress": {"address": str(req.to)}}],
        },
        "saveToSentItems": True,
    }
    async with httpx.AsyncClient(timeout=30) as cx:
        r = await cx.post(
            f"{GRAPH}/me/sendMail", json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
    if r.status_code not in (200, 202):
        raise HTTPException(status_code=502, detail=f"Microsoft Graph error {r.status_code}: {r.text[:300]}")
    return {"ok": True}


class EventRequest(BaseModel):
    attendee: EmailStr
    subject: str
    body: str = ""
    start: str          # "YYYY-MM-DDTHH:MM:SS" local wall time
    end: str
    timezone: str = "America/New_York"


@app.post("/api/create-event")
async def create_event(req: EventRequest, request: Request):
    token = _require_token(request)
    payload = {
        "subject": req.subject,
        "body": {"contentType": "Text", "content": req.body},
        "start": {"dateTime": req.start, "timeZone": req.timezone},
        "end": {"dateTime": req.end, "timeZone": req.timezone},
        "attendees": [
            {"emailAddress": {"address": str(req.attendee)}, "type": "required"}
        ],
    }
    async with httpx.AsyncClient(timeout=30) as cx:
        r = await cx.post(
            f"{GRAPH}/me/events", json=payload,
            headers={"Authorization": f"Bearer {token}"},
        )
    if r.status_code != 201:
        raise HTTPException(status_code=502, detail=f"Microsoft Graph error {r.status_code}: {r.text[:300]}")
    return {"ok": True, "event_id": r.json().get("id")}


# ------------------------- Pages -------------------------

@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")
