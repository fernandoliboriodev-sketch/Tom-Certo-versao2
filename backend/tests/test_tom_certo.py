"""Tom Certo API tests - health, auth, admin endpoints"""
import pytest
import requests
import os

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://tom-certo.preview.emergentagent.com")

@pytest.fixture
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s

@pytest.fixture
def admin_token(client):
    r = client.post(f"{BASE_URL}/api/admin/login", json={"username": "admin", "password": "admin123"})
    assert r.status_code == 200
    return r.json()["access_token"]

# Health
def test_health(client):
    r = client.get(f"{BASE_URL}/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"

# Auth validate - valid token
def test_auth_validate_valid(client):
    r = client.post(f"{BASE_URL}/api/auth/validate", json={"token": "TEST-DEV2026", "device_id": "test-device-001"})
    assert r.status_code == 200
    data = r.json()
    assert data["valid"] is True
    assert "session" in data
    assert data["session"] is not None

# Auth validate - invalid token
def test_auth_validate_invalid(client):
    r = client.post(f"{BASE_URL}/api/auth/validate", json={"token": "INVALID-TOKEN", "device_id": "test-device-001"})
    assert r.status_code == 200
    data = r.json()
    assert data["valid"] is False
    assert data["reason"] == "not_found"

# Auth validate - missing fields
def test_auth_validate_missing_fields(client):
    r = client.post(f"{BASE_URL}/api/auth/validate", json={"token": "", "device_id": ""})
    assert r.status_code == 400

# Admin login - valid
def test_admin_login_valid(client):
    r = client.post(f"{BASE_URL}/api/admin/login", json={"username": "admin", "password": "admin123"})
    assert r.status_code == 200
    data = r.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"

# Admin login - invalid
def test_admin_login_invalid(client):
    r = client.post(f"{BASE_URL}/api/admin/login", json={"username": "admin", "password": "wrong"})
    assert r.status_code == 401

# Admin list tokens - authenticated
def test_admin_list_tokens(client, admin_token):
    r = client.get(f"{BASE_URL}/api/admin/tokens", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)

# Admin list tokens - unauthenticated
def test_admin_list_tokens_unauth(client):
    r = client.get(f"{BASE_URL}/api/admin/tokens")
    assert r.status_code == 401

# Admin create token and verify persistence
def test_admin_create_and_verify_token(client, admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}
    payload = {"duration_minutes": 60, "max_devices": 1, "customer_name": "TEST_pytest_customer"}
    r = client.post(f"{BASE_URL}/api/admin/tokens", json=payload, headers=headers)
    assert r.status_code == 200
    data = r.json()
    assert data["customer_name"] == "TEST_pytest_customer"
    token_id = data["id"]
    
    # Cleanup
    del_r = client.delete(f"{BASE_URL}/api/admin/tokens/{token_id}", headers=headers)
    assert del_r.status_code == 200

# Revalidate with invalid session
def test_revalidate_invalid_session(client):
    r = client.post(f"{BASE_URL}/api/auth/revalidate", json={"session": "invalid.session.token", "device_id": "dev1"})
    assert r.status_code == 200
    assert r.json()["valid"] is False
