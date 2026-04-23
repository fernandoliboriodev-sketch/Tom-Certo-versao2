"""
Backend test suite for Tom Certo.
Tests all auth, admin, and ML analyze-key endpoints.
"""
import io
import json
import time
import wave
import struct
import math
import requests

BASE_URL = "https://tom-certo.preview.emergentagent.com"
API = f"{BASE_URL}/api"

ADMIN_USER = "admin"
ADMIN_PASS = "admin123"
TEST_TOKEN = "TEST-DEV2026"
DEVICE_ID = "backend-test-001"

results = []  # list of (name, passed, details)


def log_result(name, passed, details=""):
    mark = "✅" if passed else "❌"
    print(f"{mark} {name}: {details[:200] if details else 'OK'}")
    results.append((name, passed, details))


def short_body(r):
    try:
        txt = r.text
    except Exception:
        txt = "<no body>"
    return txt[:200]


def test_health():
    t0 = time.time()
    try:
        r = requests.get(f"{API}/health", timeout=5)
        elapsed = time.time() - t0
        ok = r.status_code == 200 and r.json().get("status", "").lower() == "ok"
        log_result(
            "1. GET /api/health",
            ok,
            f"status={r.status_code}, elapsed={elapsed:.2f}s, body={short_body(r)}",
        )
    except Exception as e:
        log_result("1. GET /api/health", False, f"EXCEPTION: {e}")


def test_admin_ui():
    t0 = time.time()
    try:
        r = requests.get(f"{API}/admin-ui", timeout=5)
        elapsed = time.time() - t0
        html = r.text
        ok = (
            r.status_code == 200
            and "Tom Certo" in html
            and ("PAINEL ADMINISTRATIVO" in html or "Painel Administrativo" in html.upper() or "painel administrativo" in html.lower())
        )
        # Case-insensitive check
        has_panel = "painel administrativo" in html.lower()
        has_tom_certo = "tom certo" in html.lower()
        ok = r.status_code == 200 and has_panel and has_tom_certo
        log_result(
            "2. GET /api/admin-ui",
            ok,
            f"status={r.status_code}, elapsed={elapsed:.2f}s, has_tom_certo={has_tom_certo}, has_panel={has_panel}, len={len(html)}",
        )
    except Exception as e:
        log_result("2. GET /api/admin-ui", False, f"EXCEPTION: {e}")


def test_admin_login_ok():
    t0 = time.time()
    try:
        r = requests.post(
            f"{API}/admin/login",
            json={"username": ADMIN_USER, "password": ADMIN_PASS},
            timeout=5,
        )
        elapsed = time.time() - t0
        ok = r.status_code == 200 and "access_token" in r.json()
        tok = r.json().get("access_token") if ok else None
        log_result(
            "3a. Admin login (valid)",
            ok,
            f"status={r.status_code}, elapsed={elapsed:.2f}s, has_token={bool(tok)}, body={short_body(r)}",
        )
        return tok
    except Exception as e:
        log_result("3a. Admin login (valid)", False, f"EXCEPTION: {e}")
        return None


def test_admin_login_bad_password():
    try:
        r = requests.post(
            f"{API}/admin/login",
            json={"username": ADMIN_USER, "password": "wrong-pass-xyz"},
            timeout=5,
        )
        ok = r.status_code in (401, 403) and "detail" in r.json()
        log_result(
            "3b. Admin login (bad password)",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("3b. Admin login (bad password)", False, f"EXCEPTION: {e}")


def test_admin_login_bad_username():
    try:
        r = requests.post(
            f"{API}/admin/login",
            json={"username": "not-admin", "password": ADMIN_PASS},
            timeout=5,
        )
        ok = r.status_code in (401, 403) and "detail" in r.json()
        log_result(
            "3c. Admin login (bad username)",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("3c. Admin login (bad username)", False, f"EXCEPTION: {e}")


def test_admin_tokens_crud(admin_token):
    if not admin_token:
        log_result("4. Admin tokens CRUD", False, "no admin_token available")
        return

    headers = {"Authorization": f"Bearer {admin_token}"}

    # List
    try:
        r = requests.get(f"{API}/admin/tokens", headers=headers, timeout=5)
        ok = r.status_code == 200 and isinstance(r.json(), list)
        log_result(
            "4a. GET /api/admin/tokens",
            ok,
            f"status={r.status_code}, count={len(r.json()) if ok else 'n/a'}",
        )
    except Exception as e:
        log_result("4a. GET /api/admin/tokens", False, f"EXCEPTION: {e}")

    # Create
    created_id = None
    try:
        r = requests.post(
            f"{API}/admin/tokens",
            headers=headers,
            json={
                "duration_minutes": 60,
                "max_devices": 1,
                "customer_name": "test-cleanup",
                "notes": "",
            },
            timeout=5,
        )
        ok = r.status_code == 200 and "id" in r.json() and "token" in r.json()
        if ok:
            created_id = r.json()["id"]
        log_result(
            "4b. POST /api/admin/tokens (create)",
            ok,
            f"status={r.status_code}, id={created_id}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("4b. POST /api/admin/tokens (create)", False, f"EXCEPTION: {e}")

    if not created_id:
        return

    # Patch
    try:
        r = requests.patch(
            f"{API}/admin/tokens/{created_id}",
            headers=headers,
            json={"customer_name": "test-cleanup-updated", "notes": "updated"},
            timeout=5,
        )
        ok = (
            r.status_code == 200
            and r.json().get("customer_name") == "test-cleanup-updated"
            and r.json().get("notes") == "updated"
        )
        log_result(
            "4c. PATCH /api/admin/tokens/{id}",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("4c. PATCH /api/admin/tokens/{id}", False, f"EXCEPTION: {e}")

    # Delete devices
    try:
        r = requests.delete(
            f"{API}/admin/tokens/{created_id}/devices",
            headers=headers,
            timeout=5,
        )
        ok = r.status_code == 200 and r.json().get("ok") is True
        log_result(
            "4d. DELETE /api/admin/tokens/{id}/devices",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("4d. DELETE /api/admin/tokens/{id}/devices", False, f"EXCEPTION: {e}")

    # Delete token
    try:
        r = requests.delete(
            f"{API}/admin/tokens/{created_id}",
            headers=headers,
            timeout=5,
        )
        ok = r.status_code == 200 and r.json().get("ok") is True
        log_result(
            "4e. DELETE /api/admin/tokens/{id}",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("4e. DELETE /api/admin/tokens/{id}", False, f"EXCEPTION: {e}")


def test_auth_validate_ok():
    t0 = time.time()
    try:
        r = requests.post(
            f"{API}/auth/validate",
            json={"token": TEST_TOKEN, "device_id": DEVICE_ID},
            timeout=5,
        )
        elapsed = time.time() - t0
        body = r.json()
        ok = (
            r.status_code == 200
            and body.get("valid") is True
            and body.get("session")
            and body.get("token_id")
        )
        log_result(
            "5a. POST /api/auth/validate (valid token)",
            ok,
            f"status={r.status_code}, elapsed={elapsed:.2f}s, valid={body.get('valid')}, customer={body.get('customer_name')}, expires={body.get('expires_at')}",
        )
        return body.get("session") if ok else None
    except Exception as e:
        log_result("5a. POST /api/auth/validate (valid token)", False, f"EXCEPTION: {e}")
        return None


def test_auth_validate_notfound():
    try:
        r = requests.post(
            f"{API}/auth/validate",
            json={"token": "TOKEN-NAO-EXISTE", "device_id": "test"},
            timeout=5,
        )
        body = r.json()
        ok = (
            r.status_code == 200
            and body.get("valid") is False
            and body.get("reason") == "not_found"
        )
        log_result(
            "5b. /api/auth/validate (not_found)",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("5b. /api/auth/validate (not_found)", False, f"EXCEPTION: {e}")


def test_auth_validate_empty_token():
    try:
        r = requests.post(
            f"{API}/auth/validate",
            json={"token": "", "device_id": "test"},
            timeout=5,
        )
        ok = r.status_code in (200, 400) and "detail" in r.text or "reason" in r.text or "valid" in r.text
        log_result(
            "5c. /api/auth/validate (empty token)",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("5c. /api/auth/validate (empty token)", False, f"EXCEPTION: {e}")


def test_auth_validate_malformed():
    try:
        r = requests.post(
            f"{API}/auth/validate",
            json={},
            timeout=5,
        )
        ok = r.status_code in (400, 422)
        log_result(
            "5d. /api/auth/validate (malformed)",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("5d. /api/auth/validate (malformed)", False, f"EXCEPTION: {e}")


def test_auth_revalidate(session):
    if not session:
        log_result("6a. /api/auth/revalidate (valid)", False, "no session from 5a")
        return
    try:
        t0 = time.time()
        r = requests.post(
            f"{API}/auth/revalidate",
            json={"session": session, "device_id": DEVICE_ID},
            timeout=5,
        )
        elapsed = time.time() - t0
        body = r.json()
        ok = r.status_code == 200 and body.get("valid") is True
        log_result(
            "6a. /api/auth/revalidate (valid)",
            ok,
            f"status={r.status_code}, elapsed={elapsed:.2f}s, body={short_body(r)}",
        )
    except Exception as e:
        log_result("6a. /api/auth/revalidate (valid)", False, f"EXCEPTION: {e}")


def test_auth_revalidate_invalid():
    try:
        r = requests.post(
            f"{API}/auth/revalidate",
            json={"session": "invalid.jwt.token", "device_id": DEVICE_ID},
            timeout=5,
        )
        body = r.json()
        ok = (
            r.status_code == 200
            and body.get("valid") is False
            and body.get("reason") in ("session_invalid", "session_expired")
        )
        log_result(
            "6b. /api/auth/revalidate (invalid session)",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("6b. /api/auth/revalidate (invalid session)", False, f"EXCEPTION: {e}")


def test_analyze_key_empty():
    try:
        r = requests.post(f"{API}/analyze-key", data=b"", timeout=10)
        ok = r.status_code == 400 and "Áudio vazio" in r.text or "muito pequeno" in r.text
        log_result(
            "7a. /api/analyze-key (empty body)",
            ok,
            f"status={r.status_code}, body={short_body(r)}",
        )
    except Exception as e:
        log_result("7a. /api/analyze-key (empty body)", False, f"EXCEPTION: {e}")


def generate_wav(freq=440.0, duration_s=5.0, sample_rate=16000):
    """Gerar WAV sintético: seno + harmônicos para simular voz/nota."""
    n_samples = int(duration_s * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit PCM
        wf.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_samples):
            t = i / sample_rate
            # Fundamental + 2º harmônico suave (voz humana)
            val = 0.6 * math.sin(2 * math.pi * freq * t)
            val += 0.25 * math.sin(2 * math.pi * freq * 2 * t)
            val += 0.10 * math.sin(2 * math.pi * freq * 3 * t)
            # Envelope suave pra evitar clicks
            env = min(1.0, min(t, duration_s - t) * 5)
            val *= env
            sample = int(val * 20000)
            frames.extend(struct.pack("<h", sample))
        wf.writeframes(bytes(frames))
    return buf.getvalue()


def test_analyze_key_wav():
    t0 = time.time()
    try:
        wav_bytes = generate_wav(freq=440.0, duration_s=5.0, sample_rate=16000)
        # Tenta primeiro como body raw
        r = requests.post(
            f"{API}/analyze-key",
            data=wav_bytes,
            headers={"Content-Type": "audio/wav"},
            timeout=30,
        )
        elapsed = time.time() - t0
        body = r.text
        try:
            j = r.json()
        except Exception:
            j = {}
        ok = r.status_code == 200 and j.get("success") is True and "key_name" in j
        log_result(
            "7b. /api/analyze-key (synthetic WAV)",
            ok,
            f"status={r.status_code}, elapsed={elapsed:.2f}s, body={short_body(r)}",
        )
    except Exception as e:
        log_result("7b. /api/analyze-key (synthetic WAV)", False, f"EXCEPTION: {e}")


def test_cors():
    try:
        # Preflight
        r = requests.options(
            f"{API}/health",
            headers={
                "Origin": "https://example.com",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": "Content-Type",
            },
            timeout=5,
        )
        allow_origin = r.headers.get("access-control-allow-origin", "")
        # Also try simple GET with Origin
        r2 = requests.get(
            f"{API}/health",
            headers={"Origin": "https://example.com"},
            timeout=5,
        )
        ao2 = r2.headers.get("access-control-allow-origin", "")
        ok = (allow_origin in ("*", "https://example.com")) or (ao2 in ("*", "https://example.com"))
        log_result(
            "CORS (Origin header)",
            ok,
            f"preflight_status={r.status_code}, AO_preflight={allow_origin}, AO_get={ao2}",
        )
    except Exception as e:
        log_result("CORS", False, f"EXCEPTION: {e}")


def run_all():
    print(f"\n=== Tom Certo Backend Tests against {API} ===\n")

    test_health()
    test_admin_ui()
    admin_token = test_admin_login_ok()
    test_admin_login_bad_password()
    test_admin_login_bad_username()
    test_admin_tokens_crud(admin_token)
    session = test_auth_validate_ok()
    test_auth_validate_notfound()
    test_auth_validate_empty_token()
    test_auth_validate_malformed()
    test_auth_revalidate(session)
    test_auth_revalidate_invalid()
    test_analyze_key_empty()
    test_analyze_key_wav()
    test_cors()

    print("\n=== SUMMARY ===")
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"Passed: {passed}/{total}")
    failed = [(n, d) for n, ok, d in results if not ok]
    if failed:
        print("\nFAILED:")
        for n, d in failed:
            print(f"  ❌ {n}: {d}")
    return passed, total, failed


if __name__ == "__main__":
    run_all()
