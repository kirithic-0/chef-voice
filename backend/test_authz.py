"""
Authorization and data-ownership tests.

Each case here corresponds to a bug found by exploring the running app. They all share a shape:
nothing raised, no error was logged — the wrong data just came back, or the wrong person got to
write. That makes them exactly the kind of regression a test suite has to hold down.

Note on the admin model: self-promotion via PUT /profile/admin is DELIBERATE in this project so
the demo can show admin features without seeding an admin. These tests therefore assert the
consistency of the admin gate (every catalogue write is gated the same way), not that admin is
unreachable.
"""

import os
import tempfile

os.environ.setdefault("CHEFVOICE_DB", os.path.join(tempfile.gettempdir(), "chefvoice_test.db"))
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-chefvoice-tests-0123456789")

import uuid  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import database as db  # noqa: E402
import providers  # noqa: E402
from main import app, get_current_user  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def real_authentication():
    """Run these tests against the real auth dependency.

    Other test modules install `app.dependency_overrides[get_current_user]` at import time to
    pin every request to one fixed test user. Those overrides live on the shared `app` object
    and are never removed, so in a full-suite run they silently apply here too — every request
    would run as that fixed user regardless of the bearer token, and these tests would be
    checking nothing (they fail loudly on a foreign-key violation, which is how this was found).
    Ownership tests need two genuinely different callers, so drop the override for this module
    and restore whatever was there afterwards.
    """
    saved = app.dependency_overrides.pop(get_current_user, None)
    try:
        yield
    finally:
        if saved is not None:
            app.dependency_overrides[get_current_user] = saved


def _new_user() -> dict:
    """Sign up a fresh ordinary (non-admin) user and return {token, headers, id}."""
    username = f"authz_{uuid.uuid4().hex[:10]}"
    resp = client.post("/auth/signup", json={"username": username, "password": "password123"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return {
        "id": body["user"]["id"],
        "token": body["token"],
        "headers": {"Authorization": f"Bearer {body['token']}"},
    }


@pytest.fixture()
def alice():
    return _new_user()


@pytest.fixture()
def bob():
    return _new_user()


# --------------------------------------------------------------------------- #
# Shopping list ownership
# --------------------------------------------------------------------------- #

def test_patching_another_users_item_does_not_leak_it(alice, bob):
    """The UPDATE was scoped by user_id but the read-back that followed was not, so PATCHing a
    guessed id returned 200 with the owner's item — name, quantity and their internal user_id."""
    secret = client.post(
        "/shopping-list",
        json={"name": "Bob private truffles", "quantity": "9", "unit": "vials"},
        headers=bob["headers"],
    ).json()

    resp = client.patch(
        f"/shopping-list/{secret['id']}", json={"checked": True}, headers=alice["headers"]
    )
    assert resp.status_code == 404
    assert "truffles" not in resp.text
    assert bob["id"] not in resp.text

    # And the write itself must not have landed.
    still = client.get("/shopping-list", headers=bob["headers"]).json()
    assert still[0]["checked"] is False


def test_deleting_another_users_item_reports_not_found(alice, bob):
    """This used to answer 200 {"status":"success"} for an item the caller did not own — a
    no-op the client had no way to distinguish from a real delete."""
    item = client.post(
        "/shopping-list", json={"name": "Bob saffron"}, headers=bob["headers"]
    ).json()

    assert client.delete(f"/shopping-list/{item['id']}", headers=alice["headers"]).status_code == 404
    assert len(client.get("/shopping-list", headers=bob["headers"]).json()) == 1

    # The owner can still delete it.
    assert client.delete(f"/shopping-list/{item['id']}", headers=bob["headers"]).status_code == 200
    assert client.get("/shopping-list", headers=bob["headers"]).json() == []


def test_adding_the_same_item_twice_folds_into_one_row(alice):
    """Two identical rows is never what someone shopping wants, and it happened easily because
    the voice agent and the panel both add items."""
    first = client.post("/shopping-list", json={"name": "Tomatoes", "quantity": "2", "unit": "kg"},
                        headers=alice["headers"]).json()
    again = client.post("/shopping-list", json={"name": "  tomatoes  "},
                        headers=alice["headers"]).json()

    items = client.get("/shopping-list", headers=alice["headers"]).json()
    assert len(items) == 1
    assert again["id"] == first["id"]
    # A bare re-add must not wipe a quantity that was already there.
    assert items[0]["quantity"] == "2"
    assert items[0]["unit"] == "kg"


def test_re_adding_a_ticked_item_unticks_it(alice):
    item = client.post("/shopping-list", json={"name": "Flour"}, headers=alice["headers"]).json()
    client.patch(f"/shopping-list/{item['id']}", json={"checked": True}, headers=alice["headers"])

    client.post("/shopping-list", json={"name": "flour"}, headers=alice["headers"])
    items = client.get("/shopping-list", headers=alice["headers"]).json()
    assert len(items) == 1 and items[0]["checked"] is False


# --------------------------------------------------------------------------- #
# Catalogue writes are gated consistently
# --------------------------------------------------------------------------- #

RECIPE = {
    "title": "Authz Probe", "cuisine": "Test", "time": 5, "difficulty": "Easy", "servings": 1,
    "dietary": [], "image_url": "",
    "ingredients": [{"name": "Water", "amount": "1", "unit": "cup"}],
    "steps": [{"step": 1, "text": "Boil.", "timer_duration": None, "safety_alert": None}],
}


def test_every_catalogue_write_requires_admin(alice):
    """POST /recipes was gated and POST /recipes/import was not, so the gate on the first was
    decorative: the importer wrote to the same shared catalogue."""
    assert client.post("/recipes", json=RECIPE, headers=alice["headers"]).status_code == 403
    assert client.post("/recipes/import", json={"url": "http://example.com/r"},
                       headers=alice["headers"]).status_code == 403


@pytest.mark.asyncio
async def test_agent_import_tool_requires_admin_too(alice):
    """Gating only the HTTP endpoint would move the bypass to the voice socket, which reaches
    the tool function directly rather than going through FastAPI."""
    from tools import ToolContext, tool_import_recipe_from_url

    ctx = ToolContext(cooking_state={}, user_id=alice["id"], http_client=None,
                      embedding_model=None, llm_api_key="x", llm_model="x", llm_base_url="x")
    result = await tool_import_recipe_from_url({"url": "http://example.com/r"}, ctx)
    assert "error" in result and "admin" in result["error"].lower()


def test_admin_can_write_to_the_catalogue(alice):
    """Self-promotion is intentional here; what matters is that the gate is real once crossed."""
    client.put("/profile/admin", json={"is_admin": True}, headers=alice["headers"])
    created = client.post("/recipes", json=RECIPE, headers=alice["headers"])
    assert created.status_code == 200
    assert client.delete(f"/recipes/{created.json()['id']}",
                         headers=alice["headers"]).status_code == 200
    client.put("/profile/admin", json={"is_admin": False}, headers=alice["headers"])


# --------------------------------------------------------------------------- #
# Provider registry
# --------------------------------------------------------------------------- #

def test_groq_points_at_a_model_that_still_exists():
    """Groq retired llama-3.3-70b-versatile and llama-3.1-8b-instant; both 404 with a valid
    key, which took down the default provider for voice, chat and import."""
    resolved = providers.resolve_provider("llama")
    assert "llama-3.3-70b-versatile" not in resolved["model"]
    assert resolved["model"] == "openai/gpt-oss-120b"
    assert resolved["fallback_model"] == "openai/gpt-oss-20b"


def test_retired_openrouter_aliases_degrade_instead_of_raising():
    """The nvidia/Nemotron provider is gone. A stale client — or a leftover
    DEFAULT_MODEL_PROVIDER=nvidia — must not KeyError inside resolve_provider()."""
    for stale in ("nvidia", "nemotron", "openrouter"):
        resolved = providers.resolve_provider(stale)
        assert resolved["id"] == "llama"


def test_only_supported_providers_are_offered():
    ids = {p["id"] for p in providers.list_providers()}
    assert ids == {"llama", "local"}
