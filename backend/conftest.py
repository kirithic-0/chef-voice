"""
Pytest bootstrap — binds the test database before any test module is imported.

Why this file exists
--------------------
`database.py` reads `CHEFVOICE_DB` once, at import time, and caches a single connection. Test
modules that set that variable at their own module level therefore only win if they happen to
be imported first: run one file on its own and it is isolated, run the whole suite and
whichever module pytest collects first decides the database for everyone.

That is not a theoretical problem. `test_agent.py` does not set the variable, sorts before the
others, and imports `database` — so a full-suite run bound `DB_PATH` to the developer's real
`chefvoice.db`, and any test that cleared the recipes table cleared the real catalogue.

pytest imports conftest.py before any test module, so setting it here is the one place that is
ordering-independent. Individual modules still set it for the case where they are run alone.
"""

import os
import tempfile

TEST_DB = os.path.join(tempfile.gettempdir(), "chefvoice_test.db")

os.environ["CHEFVOICE_DB"] = TEST_DB
os.environ.setdefault("JWT_SECRET", "test-secret-key-for-chefvoice-tests-0123456789")

# Start each session from a clean file, including the WAL sidecars.
for path in (TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def assert_test_database(db_module) -> None:
    """Guard for any fixture that deletes rows.

    Destructive setup must prove it is pointed at a scratch database first. Without this, a
    change in import order silently turns "clear the table" into "clear the user's catalogue".
    """
    actual = os.path.abspath(db_module.DB_PATH)
    expected = os.path.abspath(TEST_DB)
    if actual != expected:
        raise RuntimeError(
            f"refusing to modify {actual!r}: tests may only write to the scratch database "
            f"{expected!r}. database.DB_PATH was bound before conftest.py ran."
        )
