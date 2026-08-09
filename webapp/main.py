"""Lead Qualifier web app.

FastAPI backend serving the browser-based qualifier UI with two sign-in
providers. Email and calendar invites are sent from whichever account the
user signs in with:

  - Microsoft 365 (MSAL auth-code flow -> Microsoft Graph sendMail / events)
  - Google (OAuth 2.0 -> Gmail API send / Google Calendar API events)

Configure one provider or both; the UI only offers the ones configured.

Environment variables:
  MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID   (see SETUP-microsoft.md)
  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET          (see SETUP-google.md)
  WHITEPAGES_API_KEY [/ WHITEPAGES_BASE_URL]       (see SETUP-whitepages.md)
  ANTHROPIC_API_KEY [/ CLAUDE_MODEL]               enables the AI QC button
  USE_FIRESTORE=0                                  force memory mode (see SETUP-firestore.md)
  APP_BASE_URL   Public URL of this app, no trailing slash
"""

import base64
import json
import os
import secrets
import time
from email.message import EmailMessage
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

import anthropic
import httpx
import msal
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, EmailStr

# --- Microsoft ---
MS_CLIENT_ID = os.environ.get("MS_CLIENT_ID", "")
MS_CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET", "")
MS_TENANT_ID = os.environ.get("MS_TENANT_ID", "common")
MS_AUTHORITY = f"https://login.microsoftonline.com/{MS_TENANT_ID}"
MS_SCOPES = ["User.Read", "Mail.Send", "Calendars.ReadWrite"]
GRAPH = "https://graph.microsoft.com/v1.0"

# --- Google ---
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
GCAL_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
GOOGLE_SCOPES = (
    "openid email profile "
    "https://www.googleapis.com/auth/gmail.send "
    "https://www.googleapis.com/auth/calendar.events"
)

# --- WhitePages (phone verification) ---
# Two flavours of this API exist and they are not compatible:
#   Whitepages Pro   https://api.whitepages.com   /v2/phone   header X-Api-Key
#   Trestle          https://api.trestleiq.com    /3.1/phone  header x-api-key
# The path is inferred from the base URL; WHITEPAGES_PHONE_PATH overrides it.
WHITEPAGES_API_KEY = os.environ.get("WHITEPAGES_API_KEY", "")
WHITEPAGES_BASE_URL = os.environ.get("WHITEPAGES_BASE_URL", "https://api.whitepages.com").rstrip("/")
WHITEPAGES_PHONE_PATH = os.environ.get("WHITEPAGES_PHONE_PATH", "")
WHITEPAGES_PERSON_PATH = os.environ.get("WHITEPAGES_PERSON_PATH", "")
WHITEPAGES_PROPERTY_PATH = os.environ.get("WHITEPAGES_PROPERTY_PATH", "")

# --- Claude (AI lead QC) ---
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5")

BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8000").rstrip("/")
STATIC_DIR = Path(__file__).parent / "static"
SESSION_COOKIE = "lq_session"
SESSION_TTL = 8 * 3600

# ------------------------- Storage -------------------------
# Sessions and saved lead lists live in Firestore so they survive the container.
# Cloud Run load-balances across instances and recycles them freely, so an
# in-process dict means sign-in breaks the moment a second instance appears.
# Falls back to memory when Firestore is unreachable — fine for local runs,
# and /api/me reports which backend is live so a misconfigured deploy is
# visible rather than silently ephemeral.

USE_FIRESTORE = os.environ.get("USE_FIRESTORE", "1") != "0"
FS_SESSIONS = os.environ.get("FIRESTORE_SESSIONS_COLLECTION", "sessions")
FS_STATE = os.environ.get("FIRESTORE_STATE_COLLECTION", "lead_state")

_MEM_SESSIONS: dict[str, dict] = {}
_MEM_STATE: dict[str, dict] = {}
_fs_client = None
_fs_failed = False


def _firestore():
    """Async Firestore client, or None when unavailable."""
    global _fs_client, _fs_failed
    if not USE_FIRESTORE or _fs_failed:
        return None
    if _fs_client is None:
        try:
            from google.cloud import firestore
            _fs_client = firestore.AsyncClient()
        except Exception as e:            # no SDK, no credentials, no project
            print(f"[storage] Firestore unavailable, using memory: {e}")
            _fs_failed = True
            return None
    return _fs_client


def storage_backend() -> str:
    return "firestore" if _firestore() is not None else "memory"


async def _fs_get(collection: str, key: str) -> Optional[dict]:
    global _fs_failed
    db = _firestore()
    if db is None:
        return None
    try:
        snap = await db.collection(collection).document(key).get()
        return snap.to_dict() if snap.exists else None
    except Exception as e:
        print(f"[storage] Firestore read failed, using memory: {e}")
        _fs_failed = True
        return None


async def _fs_set(collection: str, key: str, value: dict) -> bool:
    global _fs_failed
    db = _firestore()
    if db is None:
        return False
    try:
        await db.collection(collection).document(key).set(value)
        return True
    except Exception as e:
        print(f"[storage] Firestore write failed, using memory: {e}")
        _fs_failed = True
        return False


async def load_session(sid: str) -> Optional[dict]:
    doc = await _fs_get(FS_SESSIONS, sid)
    if doc is not None:
        if doc.get("expires_at", 0) < time.time():
            return None
        try:
            return json.loads(doc.get("data") or "{}")
        except ValueError:
            return None
    return _MEM_SESSIONS.get(sid)


async def save_session(sid: str, session: dict) -> None:
    payload = {"data": json.dumps(session), "expires_at": time.time() + SESSION_TTL}
    if not await _fs_set(FS_SESSIONS, sid, payload):
        _MEM_SESSIONS[sid] = session


async def drop_session(sid: str) -> None:
    _MEM_SESSIONS.pop(sid, None)
    db = _firestore()
    if db is not None:
        try:
            await db.collection(FS_SESSIONS).document(sid).delete()
        except Exception as e:
            print(f"[storage] Firestore delete failed: {e}")


app = FastAPI(title="Lead Qualifier")


@app.middleware("http")
async def https_middleware(request: Request, call_next):
    """Send plain-HTTP visitors to HTTPS, and keep them there.

    Cloud Run terminates TLS and passes the original scheme in
    X-Forwarded-Proto. The header is absent for local runs and for the
    platform's own container probes, so only an explicit "http" redirects.
    """
    if not BASE_URL.startswith("https"):
        return await call_next(request)

    if request.headers.get("x-forwarded-proto") == "http":
        return RedirectResponse(
            str(request.url.replace(scheme="https")), status_code=301
        )

    response = await call_next(request)
    # Without this, a browser that has once reached the site over HTTP will
    # keep guessing HTTP from its own autocomplete.
    response.headers["Strict-Transport-Security"] = "max-age=31536000"
    return response


@app.middleware("http")
async def session_middleware(request: Request, call_next):
    sid = request.cookies.get(SESSION_COOKIE)
    session = await load_session(sid) if sid else None
    is_new = session is None
    if is_new:
        sid = secrets.token_urlsafe(32)
        session = {}
    request.state.sid = sid
    request.state.session = session

    # Handlers mutate the session dict in place, so compare against a snapshot
    # rather than writing on every request — most requests change nothing.
    before = json.dumps(session, sort_keys=True)
    response = await call_next(request)
    if not getattr(request.state, "session_dropped", False):
        if is_new or json.dumps(session, sort_keys=True) != before:
            await save_session(sid, session)

    if is_new:
        response.set_cookie(
            SESSION_COOKIE, sid,
            httponly=True, samesite="lax",
            secure=BASE_URL.startswith("https"),
            max_age=SESSION_TTL,
        )
    return response


# ------------------------- Microsoft (MSAL) -------------------------

def _ms_load_cache(session: dict) -> msal.SerializableTokenCache:
    cache = msal.SerializableTokenCache()
    if session.get("ms_token_cache"):
        cache.deserialize(session["ms_token_cache"])
    return cache


def _ms_save_cache(session: dict, cache: msal.SerializableTokenCache) -> None:
    if cache.has_state_changed:
        session["ms_token_cache"] = cache.serialize()


def _ms_app(cache: Optional[msal.SerializableTokenCache] = None) -> msal.ConfidentialClientApplication:
    return msal.ConfidentialClientApplication(
        MS_CLIENT_ID, authority=MS_AUTHORITY,
        client_credential=MS_CLIENT_SECRET, token_cache=cache,
    )


def _ms_token(session: dict) -> Optional[str]:
    if not MS_CLIENT_ID:
        return None
    cache = _ms_load_cache(session)
    client = _ms_app(cache)
    accounts = client.get_accounts()
    if not accounts:
        return None
    result = client.acquire_token_silent(MS_SCOPES, account=accounts[0])
    _ms_save_cache(session, cache)
    if result and "access_token" in result:
        return result["access_token"]
    return None


@app.get("/auth/login")
async def ms_login(request: Request):
    if not MS_CLIENT_ID or not MS_CLIENT_SECRET:
        raise HTTPException(
            status_code=500,
            detail="Microsoft app credentials not configured — set MS_CLIENT_ID / "
                   "MS_CLIENT_SECRET / MS_TENANT_ID (see SETUP-microsoft.md).",
        )
    cache = _ms_load_cache(request.state.session)
    flow = _ms_app(cache).initiate_auth_code_flow(
        MS_SCOPES, redirect_uri=BASE_URL + "/auth/callback"
    )
    request.state.session["ms_flow"] = flow
    return RedirectResponse(flow["auth_uri"])


@app.get("/auth/callback")
async def ms_callback(request: Request):
    session = request.state.session
    flow = session.pop("ms_flow", None)
    if not flow:
        return RedirectResponse("/")
    cache = _ms_load_cache(session)
    try:
        result = _ms_app(cache).acquire_token_by_auth_code_flow(
            flow, dict(request.query_params)
        )
    except ValueError:
        return RedirectResponse("/")
    _ms_save_cache(session, cache)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result.get("error_description", "Sign-in failed"))
    session["provider"] = "microsoft"
    return RedirectResponse("/")


# ------------------------- Google (OAuth 2.0) -------------------------

async def _google_token(session: dict) -> Optional[str]:
    g = session.get("google")
    if not g:
        return None
    if time.time() < g.get("expires_at", 0):
        return g["access_token"]
    if not g.get("refresh_token"):
        session.pop("google", None)
        return None
    async with httpx.AsyncClient(timeout=20) as cx:
        r = await cx.post(GOOGLE_TOKEN_URL, data={
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "refresh_token": g["refresh_token"],
            "grant_type": "refresh_token",
        })
    if r.status_code != 200:
        session.pop("google", None)
        return None
    tok = r.json()
    g["access_token"] = tok["access_token"]
    g["expires_at"] = time.time() + tok.get("expires_in", 3600) - 60
    return g["access_token"]


@app.get("/auth/google/login")
async def google_login(request: Request):
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=500,
            detail="Google app credentials not configured — set GOOGLE_CLIENT_ID / "
                   "GOOGLE_CLIENT_SECRET (see SETUP-google.md).",
        )
    state = secrets.token_urlsafe(24)
    request.state.session["g_state"] = state
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": BASE_URL + "/auth/google/callback",
        "response_type": "code",
        "scope": GOOGLE_SCOPES,
        "access_type": "offline",   # refresh token, so sign-in survives the hour
        "prompt": "consent",
        "state": state,
    }
    return RedirectResponse(f"{GOOGLE_AUTH_URL}?{urlencode(params)}")


@app.get("/auth/google/callback")
async def google_callback(request: Request):
    session = request.state.session
    if request.query_params.get("state") != session.pop("g_state", None):
        return RedirectResponse("/")
    code = request.query_params.get("code")
    if not code:
        return RedirectResponse("/")
    async with httpx.AsyncClient(timeout=20) as cx:
        r = await cx.post(GOOGLE_TOKEN_URL, data={
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": BASE_URL + "/auth/google/callback",
            "grant_type": "authorization_code",
        })
    if r.status_code != 200:
        raise HTTPException(status_code=400, detail=f"Google sign-in failed: {r.text[:200]}")
    tok = r.json()
    session["google"] = {
        "access_token": tok["access_token"],
        "refresh_token": tok.get("refresh_token"),
        "expires_at": time.time() + tok.get("expires_in", 3600) - 60,
    }
    session["provider"] = "google"
    return RedirectResponse("/")


@app.get("/auth/logout")
async def logout(request: Request):
    await drop_session(request.state.sid)
    request.state.session_dropped = True     # stop the middleware re-saving it
    response = RedirectResponse("/")
    response.delete_cookie(SESSION_COOKIE)
    return response


# ------------------------- Shared helpers -------------------------

async def _signed_in_email(request: Request) -> str:
    """Email of the signed-in user — the key their saved list is stored under."""
    session = request.state.session
    if session.get("provider") == "google":
        token = await _google_token(session)
        if token:
            async with httpx.AsyncClient(timeout=15) as cx:
                r = await cx.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {token}"})
            if r.status_code == 200:
                return (r.json().get("email") or "").lower()
    token = _ms_token(session)
    if token:
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.get(f"{GRAPH}/me", headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 200:
            d = r.json()
            return ((d.get("mail") or d.get("userPrincipalName")) or "").lower()
    return ""


async def _active_token(request: Request) -> tuple[str, str]:
    """Return (provider, access_token) for the signed-in account, else 401."""
    session = request.state.session
    if session.get("provider") == "google":
        token = await _google_token(session)
        if token:
            return "google", token
    token = _ms_token(session)
    if token:
        return "microsoft", token
    raise HTTPException(status_code=401, detail="Not signed in")


def _gmail_raw(to: str, subject: str, body: str) -> str:
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


# ------------------------- API routes -------------------------

@app.get("/api/me")
async def me(request: Request):
    session = request.state.session
    providers = {
        "microsoft": bool(MS_CLIENT_ID and MS_CLIENT_SECRET),
        "google": bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET),
    }
    features = {
        "whitepages": bool(WHITEPAGES_API_KEY),
        "ai_qc": bool(ANTHROPIC_API_KEY),
        "server_state": storage_backend() == "firestore",
    }
    storage = storage_backend()
    if session.get("provider") == "google":
        token = await _google_token(session)
        if token:
            async with httpx.AsyncClient(timeout=15) as cx:
                r = await cx.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {token}"})
            if r.status_code == 200:
                d = r.json()
                return {"signed_in": True, "provider": "google",
                        "name": d.get("name"), "email": d.get("email"),
                        "providers": providers, "features": features,
                        "storage": storage}
    token = _ms_token(session)
    if token:
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.get(f"{GRAPH}/me", headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 200:
            d = r.json()
            return {"signed_in": True, "provider": "microsoft",
                    "name": d.get("displayName"),
                    "email": d.get("mail") or d.get("userPrincipalName"),
                    "providers": providers, "features": features,
                    "storage": storage}
    return JSONResponse({"signed_in": False, "providers": providers,
                         "features": features, "storage": storage})


class EmailRequest(BaseModel):
    to: EmailStr
    subject: str
    body: str


@app.post("/api/send-email")
async def send_email(req: EmailRequest, request: Request):
    provider, token = await _active_token(request)
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=30) as cx:
        if provider == "google":
            r = await cx.post(GMAIL_SEND_URL, json={"raw": _gmail_raw(str(req.to), req.subject, req.body)},
                              headers=headers)
            ok = r.status_code == 200
        else:
            payload = {
                "message": {
                    "subject": req.subject,
                    "body": {"contentType": "Text", "content": req.body},
                    "toRecipients": [{"emailAddress": {"address": str(req.to)}}],
                },
                "saveToSentItems": True,
            }
            r = await cx.post(f"{GRAPH}/me/sendMail", json=payload, headers=headers)
            ok = r.status_code in (200, 202)
    if not ok:
        raise HTTPException(status_code=502, detail=f"{provider} send error {r.status_code}: {r.text[:300]}")
    return {"ok": True, "provider": provider}


class EventRequest(BaseModel):
    attendee: EmailStr
    subject: str
    body: str = ""
    start: str          # "YYYY-MM-DDTHH:MM:SS" local wall time
    end: str
    timezone: str = "America/New_York"


@app.post("/api/create-event")
async def create_event(req: EventRequest, request: Request):
    provider, token = await _active_token(request)
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=30) as cx:
        if provider == "google":
            payload = {
                "summary": req.subject,
                "description": req.body,
                "start": {"dateTime": req.start, "timeZone": req.timezone},
                "end": {"dateTime": req.end, "timeZone": req.timezone},
                "attendees": [{"email": str(req.attendee)}],
            }
            r = await cx.post(f"{GCAL_EVENTS_URL}?sendUpdates=all", json=payload, headers=headers)
            ok = r.status_code == 200
        else:
            payload = {
                "subject": req.subject,
                "body": {"contentType": "Text", "content": req.body},
                "start": {"dateTime": req.start, "timeZone": req.timezone},
                "end": {"dateTime": req.end, "timeZone": req.timezone},
                "attendees": [
                    {"emailAddress": {"address": str(req.attendee)}, "type": "required"}
                ],
            }
            r = await cx.post(f"{GRAPH}/me/events", json=payload, headers=headers)
            ok = r.status_code == 201
    if not ok:
        raise HTTPException(status_code=502, detail=f"{provider} calendar error {r.status_code}: {r.text[:300]}")
    return {"ok": True, "provider": provider}


class VerifyPhoneRequest(BaseModel):
    phone: str
    first_name: str = ""
    last_name: str = ""


def _wp_path(kind: str) -> str:
    """Endpoint path for a lookup, per API flavour."""
    override = {"phone": WHITEPAGES_PHONE_PATH, "person": WHITEPAGES_PERSON_PATH,
                "property": WHITEPAGES_PROPERTY_PATH}[kind]
    if override:
        return "/" + override.lstrip("/")
    if "trestle" in WHITEPAGES_BASE_URL:
        return {"phone": "/3.1/phone", "person": "/3.1/person", "property": "/3.1/property"}[kind]
    # The Pro property endpoint is documented with a trailing slash.
    return "/v2/property/" if kind == "property" else f"/v2/{kind}"


async def _wp_get(kind: str, params: dict):
    """One WhitePages call. Returns parsed JSON, or None when nothing matched."""
    if not WHITEPAGES_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="WhitePages not configured — set WHITEPAGES_API_KEY "
                   "(see SETUP-whitepages.md).",
        )
    url = WHITEPAGES_BASE_URL + _wp_path(kind)
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as cx:
        r = await cx.get(url, params=params, headers={"X-Api-Key": WHITEPAGES_API_KEY})
    if r.status_code in (401, 403):
        raise HTTPException(status_code=502, detail="WhitePages rejected the API key — check WHITEPAGES_API_KEY.")
    if r.status_code == 404:
        return None          # documented as "no matching record"
    if r.status_code == 429:
        raise HTTPException(status_code=502, detail="WhitePages rate limit hit — try again shortly.")
    if r.status_code == 400:
        try:
            msg = (r.json().get("error") or {}).get("long_message") or r.text
        except ValueError:
            msg = r.text
        raise HTTPException(status_code=502, detail=f"WhitePages rejected the query: {msg[:300]}")
    if r.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"WhitePages error {r.status_code} from {url}: {r.text[:300]}",
        )
    try:
        return r.json()
    except ValueError:
        raise HTTPException(status_code=502, detail=f"WhitePages returned non-JSON from {url}.")


def _best_person(payload, require_last: str = "") -> dict:
    """Highest-confidence person record out of a search response.

    Live responses wrap candidates in {"results": [...], "metadata": {...}};
    the docs show a bare array. Candidates carry an explicit match_score and
    partial records come back with it null, so pick on score rather than
    trusting position.

    require_last guards against the API's fuzzy fallback: a search for a name
    that isn't in the data happily returns near-spellings — "Tracy" for
    "Treacy" — and attributing a stranger's home address and phone numbers to
    a lead is worse than returning nothing.
    """
    if isinstance(payload, dict):
        for key in ("results", "result"):
            v = payload.get(key)
            if isinstance(v, list):
                payload = v
                break
            if isinstance(v, dict):
                return v
        else:
            return payload if "name" in payload else {}
    if not isinstance(payload, list):
        return {}
    people = [p for p in payload if isinstance(p, dict)]
    last = require_last.strip().lower()
    if last:
        people = [
            p for p in people
            if last in (p.get("name") or "").lower()
            or any(last in (a or "").lower() for a in (p.get("aliases") or []))
        ]
    return max(people, key=lambda p: p.get("match_score") or 0) if people else {}


def _first_str(d: dict, *keys) -> str:
    """First non-empty string among keys, ignoring nested containers."""
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return str(v)
    return ""


def _digits(s: str) -> str:
    return "".join(c for c in str(s) if c.isdigit())[-10:]


US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI",
    "south carolina": "SC", "south dakota": "SD", "tennessee": "TN", "texas": "TX",
    "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}


def _state_code(s: str) -> str:
    """Two-letter code, or "" when it can't be resolved.

    state_code is validated server-side and a full name like "New York" is a
    400, so an unrecognisable value is dropped from the query rather than sent.
    """
    s = (s or "").strip()
    if len(s) == 2 and s.isalpha():
        return s.upper()
    return US_STATES.get(s.lower(), "")


def _phone_list(person: dict) -> list:
    out = []
    for p in person.get("phones") or []:
        if not isinstance(p, dict):
            continue
        num = _first_str(p, "number", "phone_number", "phone")
        if num:
            out.append({"number": num,
                        "type": _first_str(p, "type", "line_type", "phone_type"),
                        "score": p.get("score")})
    return out


def _mobiles(person: dict) -> list:
    return [p["number"] for p in _phone_list(person) if "mobile" in p["type"].lower()]


EMPTY_ADDR = {"street": "", "city": "", "state": "", "zip": ""}


def _parse_one_line(s: str) -> dict:
    """'123 Main St, Seattle, WA 98101' -> parts."""
    bits = [b.strip() for b in s.split(",") if b.strip()]
    if not bits:
        return dict(EMPTY_ADDR)
    tail = bits[-1].split() if len(bits) >= 3 else []
    return {
        "street": bits[0],
        "city": bits[1] if len(bits) >= 3 else "",
        "state": tail[0] if tail else "",
        "zip": tail[1] if len(tail) > 1 else "",
    }


def _addr(raw) -> dict:
    """Address parts from a structured record or a one-line string."""
    if isinstance(raw, str):
        return _parse_one_line(raw)
    if not isinstance(raw, dict):
        return dict(EMPTY_ADDR)
    parts = {
        "street": _first_str(raw, "line1", "street_line_1", "street_line", "street"),
        "city": _first_str(raw, "city", "city_name", "locality"),
        "state": _first_str(raw, "state", "state_code", "region"),
        "zip": _first_str(raw, "zip", "postal_code", "zip_code"),
    }
    if not parts["city"]:
        one = _first_str(raw, "full_address", "address", "formatted_address")
        if one:
            return _parse_one_line(one)
    return parts


def _home_address(person: dict) -> dict:
    for key in ("current_addresses", "addresses", "current_address", "address"):
        v = person.get(key)
        if isinstance(v, list) and v:
            return _addr(v[0])
        if isinstance(v, (dict, str)) and v:
            return _addr(v)
    return dict(EMPTY_ADDR)


def _list_total(person: dict, name: str) -> int:
    """Full count of a capped list: what came back plus what was withheld."""
    shown = person.get(name)
    shown = len(shown) if isinstance(shown, list) else 0
    meta = ((person.get("result_metadata") or {}).get(name)) or {}
    return shown + (meta.get("additional") or 0)


@app.post("/api/verify-phone")
async def verify_phone(req: VerifyPhoneRequest, request: Request):
    """Who a number belongs to, and whether it is a mobile.

    The Pro API answers a reverse-phone query with person records, so there is
    no carrier or prepaid flag to report — the useful signals are the line type
    on the matching phone entry and whether the owner is the lead.
    """
    await _active_token(request)
    person = _best_person(await _wp_get("phone", {"phone": _digits(req.phone)}))
    if not person:
        return {"valid": None, "line_type": "", "carrier": "", "prepaid": None,
                "owner": "", "name_match": None, "note": "no record found"}

    # Match the queried number inside the record rather than taking the first.
    want = _digits(req.phone)
    phones = _phone_list(person)
    hit = next((p for p in phones if _digits(p["number"]) == want), None)

    owner = _first_str(person, "name", "full_name")
    name_match = None
    if owner and req.last_name.strip():
        name_match = req.last_name.strip().lower() in owner.lower()

    return {
        "valid": True if hit else None,
        "line_type": (hit or {}).get("type", ""),
        "carrier": "",          # not offered by this API
        "prepaid": None,
        "owner": owner,
        "name_match": name_match,
    }


class EnrichRequest(BaseModel):
    first_name: str = ""
    last_name: str = ""
    city: str = ""
    state: str = ""
    street: str = ""


@app.post("/api/enrich")
async def enrich(req: EnrichRequest, request: Request):
    """Household facts for one lead: where they live, what they own, how to reach them.

    Costs one person lookup, plus one property lookup when an address comes
    back — so it stays a per-lead button rather than a bulk sweep.
    """
    await _active_token(request)
    name = f"{req.first_name} {req.last_name}".strip()
    if not name:
        raise HTTPException(status_code=400, detail="A name is required to enrich a lead.")

    # strict_match suppresses the server-side fuzzy fallback; the surname check
    # in _best_person catches anything that slips through anyway.
    params = {"name": name, "strict_match": "true"}
    if req.city:
        params["city"] = req.city
    if _state_code(req.state):
        params["state_code"] = _state_code(req.state)
    if req.street:
        params["street"] = req.street
    person = _best_person(await _wp_get("person", params), require_last=req.last_name)
    if not person:
        return {"found": False}

    addr = _home_address(person)
    mobiles = _mobiles(person)

    # Ownership stands in for net worth here: this API carries no home value,
    # but who holds the deed is itself a strong signal — a house in a trust or
    # an LLC means someone has already done estate or entity planning.
    owns_home = None
    owner_type = ""
    co_owners: list = []
    if addr["street"] and (addr["city"] or addr["zip"]):
        prop_params = {"street": addr["street"]}
        if addr["city"]:
            prop_params["city"] = addr["city"]
        if _state_code(addr["state"]):
            prop_params["state_code"] = _state_code(addr["state"])
        if addr["zip"]:
            prop_params["zipcode"] = addr["zip"]
        prop = await _wp_get("property", prop_params)
        result = (prop or {}).get("result") if isinstance(prop, dict) else None
        if isinstance(result, dict):
            info = result.get("ownership_info") or {}
            owner_type = _first_str(info, "owner_type")
            names = [_first_str(o, "name") for o in (info.get("person_owners") or [])
                     if isinstance(o, dict)]
            biz = [_first_str(o, "name") for o in (info.get("business_owners") or [])
                   if isinstance(o, dict)]
            last = req.last_name.strip().lower()
            owns_home = bool(last) and any(last in n.lower() for n in names if n)
            if biz:
                owner_type = owner_type or "entity"
            co_owners = [n for n in names + biz if n]

    return {
        "found": True,
        "owner": _first_str(person, "name", "full_name"),
        "age": person.get("age"),
        "home_street": addr["street"],
        "home_city": addr["city"],
        "home_state": addr["state"],
        "home_zip": addr["zip"],
        "mobiles": mobiles,
        "mobile_count": len(mobiles),
        "phones_total": _list_total(person, "phones"),
        "properties_owned": _list_total(person, "owned_properties"),
        "owns_home": owns_home,
        "owner_type": owner_type,
        "co_owners": co_owners,
        "linkedin_url": _first_str(person, "linkedin_url"),
        "emails": [_first_str(e, "email") for e in (person.get("emails") or [])
                   if isinstance(e, dict) and _first_str(e, "email")],
    }


class LeadState(BaseModel):
    settings: dict = {}
    leads: list = []


@app.get("/api/state")
async def get_state(request: Request):
    """The signed-in user's saved list. 401 keeps the browser on localStorage."""
    email = await _signed_in_email(request)
    if not email:
        raise HTTPException(status_code=401, detail="Not signed in")
    doc = await _fs_get(FS_STATE, email) or _MEM_STATE.get(email)
    if not doc:
        return {"found": False, "settings": {}, "leads": [], "backend": storage_backend()}
    try:
        payload = json.loads(doc.get("data") or "{}")
    except ValueError:
        raise HTTPException(status_code=500, detail="Saved list is corrupt.")
    return {"found": True, "settings": payload.get("settings") or {},
            "leads": payload.get("leads") or [], "saved_at": doc.get("saved_at"),
            "backend": storage_backend()}


@app.put("/api/state")
async def put_state(body: LeadState, request: Request):
    email = await _signed_in_email(request)
    if not email:
        raise HTTPException(status_code=401, detail="Not signed in")
    payload = {"data": json.dumps({"settings": body.settings, "leads": body.leads}),
               "saved_at": time.time(), "lead_count": len(body.leads)}
    if not await _fs_set(FS_STATE, email, payload):
        _MEM_STATE[email] = payload
    return {"ok": True, "leads": len(body.leads), "backend": storage_backend()}


# ------------------------- AI lead QC (Claude) -------------------------

QC_RULES = {
    "base_age_min": 25,
    "base_age_max": 75,
    "net_worth_min": 2_000_000,
    "young_age_max": 45,
    "young_income_min": 250_000,
    "old_401k_min": 250_000,
    "wl_age_max": 70,
    "intent_assets_min": 250_000,
}

QC_PROMPT = f"""You are the quality-control engine for a wealth-management lead generation company. Evaluate each lead against this qualification rule:

BASE REQUIREMENT: Age between {QC_RULES['base_age_min']} and {QC_RULES['base_age_max']} (estimate age from graduation year + 22, or total career length if grad year absent).

Then at least ONE gate must hold:
- NW: net worth > ${QC_RULES['net_worth_min']:,}
- YHE: age < {QC_RULES['young_age_max']} AND income > ${QC_RULES['young_income_min']:,}
- 401K: orphaned 401(k) balance > ${QC_RULES['old_401k_min']:,} (proxy: changed jobs in the last 1-5 years AFTER a long prior tenure at a company likely to offer a 401(k))
- WL: age < {QC_RULES['wl_age_max']} AND holds whole life insurance (NEVER inferable from prospect data — always UNKNOWN unless the record explicitly confirms it)
- INT: actively seeking financial help AND investable assets > ${QC_RULES['intent_assets_min']:,} (intent requires an explicit signal in the record)

If a lead record includes an explicit "age" value, use it verbatim with ageStatus "CONFIRMED" instead of estimating.
Status vocabulary per gate: "CONFIRMED" (record explicitly states it), "INFERRED" (strong proxy: seniority, tenure, company size, title), "UNKNOWN" (no signal), "FAIL" (evidence contradicts it).
Inference guides: senior titles (VP/SVP/C-suite/Partner/Principal/Owner/MD) at mid-size+ companies => income likely >$250K. Long tenure in high-income roles or equity titles => higher net-worth likelihood. Many stints under 3 years => job hopper (small 401k balances, penalize).
Property fields, when present, come from public records and are CONFIRMED rather than inferred: "ownsHome" true means the deed carries their name, "propertiesOwned" counts deeded properties (two or more is a strong net-worth signal), and "deedHeldBy" naming a trust or an entity means estate or entity planning has already happened — treat that as a strong NW signal and note the existing planning in the checklist.

Return ONLY a JSON array, one object per lead, same order, no prose:
[{{"i":0,"ageEst":57,"ageStatus":"INFERRED","gates":{{"NW":{{"s":"INFERRED","ev":"short evidence"}},"YHE":{{"s":"FAIL","ev":""}},"401K":{{"s":"INFERRED","ev":""}},"WL":{{"s":"UNKNOWN","ev":""}},"INT":{{"s":"UNKNOWN","ev":""}}}},"jobHopper":false,"grade":"A","checklist":["Confirm approximate net worth","Confirm old 401(k) balance"],"note":"one-line QC summary"}}]

Grading: A = base age passes + 2 or more gates at INFERRED-or-better, or 1 CONFIRMED gate, and not a job hopper. B = base age passes + exactly 1 INFERRED gate. C = base age passes but only UNKNOWNs, or job hopper with otherwise decent signals. If base age FAILS, grade "X".
"checklist" = the specific facts a junior advisor must verify on the first call before this lead counts as fully qualified.

LEADS:
"""


class QCLead(BaseModel):
    i: int
    name: str = ""
    title: str = ""
    jobLevel: str = ""
    company: str = ""
    state: str = ""
    gradYear: str = ""
    positionStart: str = ""
    employees: str = ""
    notes: str = ""
    yearsExperience: str = ""
    yearsAtEmployer: str = ""
    jobHopper: bool = False
    # Confirmed facts from a WhitePages enrichment, when one has been run.
    age: Optional[int] = None
    ownsHome: Optional[bool] = None
    propertiesOwned: Optional[int] = None
    deedHeldBy: str = ""


class QCRequest(BaseModel):
    leads: list[QCLead]


@app.post("/api/qc")
async def qc(req: QCRequest, request: Request):
    # Each batch is a paid Claude API call — signed-in users only.
    await _active_token(request)
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="AI QC not configured — set ANTHROPIC_API_KEY "
                   "(get one at console.anthropic.com).",
        )
    if not req.leads:
        return {"verdicts": []}
    if len(req.leads) > 12:
        raise HTTPException(status_code=400, detail="Max 12 leads per QC batch.")

    payload = json.dumps([lead.model_dump() for lead in req.leads], separators=(",", ":"))
    client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    try:
        msg = await client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=4000,
            messages=[{"role": "user", "content": QC_PROMPT + payload}],
        )
    except anthropic.APIStatusError as e:
        raise HTTPException(status_code=502, detail=f"Claude API error {e.status_code}: {str(e)[:300]}")
    except anthropic.APIError as e:
        raise HTTPException(status_code=502, detail=f"Claude API error: {str(e)[:300]}")

    if msg.stop_reason == "refusal":
        raise HTTPException(status_code=502, detail="Claude declined to process this batch.")

    text = "".join(b.text for b in msg.content if b.type == "text")
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end == -1:
        raise HTTPException(status_code=502, detail="Claude returned no JSON array.")
    try:
        verdicts = json.loads(text[start:end + 1])
    except ValueError:
        raise HTTPException(status_code=502, detail="Claude returned malformed JSON.")
    return {"verdicts": verdicts}


# ------------------------- Pages -------------------------

@app.api_route("/healthz", methods=["GET", "HEAD"])
async def healthz():
    return {"ok": True}


@app.api_route("/", methods=["GET", "HEAD"])
async def index():
    return FileResponse(STATIC_DIR / "index.html")
