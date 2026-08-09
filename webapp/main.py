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

# --- WhitePages / Trestle (phone verification) ---
WHITEPAGES_API_KEY = os.environ.get("WHITEPAGES_API_KEY", "")
WHITEPAGES_BASE_URL = os.environ.get("WHITEPAGES_BASE_URL", "https://api.trestleiq.com").rstrip("/")

# --- Claude (AI lead QC) ---
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5")

BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8000").rstrip("/")
STATIC_DIR = Path(__file__).parent / "static"
SESSION_COOKIE = "lq_session"

# Single-replica in-memory session store.
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
    SESSIONS.pop(request.state.sid, None)
    response = RedirectResponse("/")
    response.delete_cookie(SESSION_COOKIE)
    return response


# ------------------------- Shared helpers -------------------------

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
    }
    if session.get("provider") == "google":
        token = await _google_token(session)
        if token:
            async with httpx.AsyncClient(timeout=15) as cx:
                r = await cx.get(GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {token}"})
            if r.status_code == 200:
                d = r.json()
                return {"signed_in": True, "provider": "google",
                        "name": d.get("name"), "email": d.get("email"),
                        "providers": providers, "features": features}
    token = _ms_token(session)
    if token:
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.get(f"{GRAPH}/me", headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 200:
            d = r.json()
            return {"signed_in": True, "provider": "microsoft",
                    "name": d.get("displayName"),
                    "email": d.get("mail") or d.get("userPrincipalName"),
                    "providers": providers, "features": features}
    return JSONResponse({"signed_in": False, "providers": providers, "features": features})


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


@app.post("/api/verify-phone")
async def verify_phone(req: VerifyPhoneRequest, request: Request):
    # Lookups cost money per call — signed-in users only.
    await _active_token(request)
    if not WHITEPAGES_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="WhitePages not configured — set WHITEPAGES_API_KEY "
                   "(see SETUP-whitepages.md).",
        )
    async with httpx.AsyncClient(timeout=30) as cx:
        r = await cx.get(
            f"{WHITEPAGES_BASE_URL}/3.1/phone",
            params={"phone": req.phone},
            headers={"x-api-key": WHITEPAGES_API_KEY},
        )
    if r.status_code in (401, 403):
        raise HTTPException(status_code=502, detail="WhitePages rejected the API key — check WHITEPAGES_API_KEY.")
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"WhitePages error {r.status_code}: {r.text[:300]}")
    d = r.json()

    owner = ""
    belongs_to = d.get("belongs_to")
    if isinstance(belongs_to, dict):
        owner = belongs_to.get("name") or ""
    elif isinstance(belongs_to, list) and belongs_to:
        owner = (belongs_to[0] or {}).get("name") or ""

    name_match = None
    if owner and req.last_name.strip():
        name_match = req.last_name.strip().lower() in owner.lower()

    return {
        "valid": d.get("is_valid"),
        "line_type": d.get("line_type"),
        "carrier": d.get("carrier"),
        "prepaid": d.get("is_prepaid"),
        "owner": owner,
        "name_match": name_match,
    }


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

@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")
