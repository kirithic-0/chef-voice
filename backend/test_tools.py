# Unit tests for deterministic kitchen tools (no live NVIDIA/Supabase)
import tools


def test_parse_amount_fractions():
    assert tools.parse_amount("1/2") == 0.5
    assert tools.parse_amount("1 1/2") == 1.5
    assert tools.parse_amount("2") == 2.0


def test_scale_ingredients_doubles():
    ingredients = [
        {"name": "Flour", "amount": "1", "unit": "cup"},
        {"name": "Milk", "amount": "1/2", "unit": "cup"},
        {"name": "Salt", "amount": "to taste", "unit": ""},
    ]
    scaled = tools.scale_ingredients(ingredients, base_servings=2, new_servings=4)
    assert scaled[0]["amount"] == "2"
    assert scaled[1]["amount"] == "1"
    assert scaled[2]["amount"] == "to taste"


def test_convert_units_volume():
    result = tools.convert_units(1, "cup", "ml", kind="volume")
    assert "error" not in result
    assert abs(result["amount"] - 236.588) < 0.1


def test_tool_definitions_are_the_trimmed_set():
    names = {t["function"]["name"] for t in tools.TOOL_DEFINITIONS}
    # The agent keeps recipe-discovery, cooking-flow, and timer tools...
    assert names == {
        "search_recipes", "past_cooked_recipes", "get_recipe", "select_recipe",
        "import_recipe_from_url", "start_cooking", "get_current_step", "navigate_step",
        "set_timer", "cancel_timer",
    }
    # ...and the kitchen-helper / shopping-list / memory tools were removed.
    for gone in ("scale_recipe", "convert_units", "suggest_substitution",
                 "add_to_shopping_list", "save_note", "recall_memories"):
        assert gone not in names
    # TOOL_HANDLERS stays in lockstep with the definitions.
    assert set(tools.TOOL_HANDLERS) == names


def test_discovery_tools_are_general_chat_only():
    """search_recipes + past_cooked_recipes belong to the home/general chat only;
    the in-recipe cooking chat must not be offered them."""
    home = {t["function"]["name"] for t in tools.tools_for_screen("home")}
    cooking = {t["function"]["name"] for t in tools.tools_for_screen("cooking")}
    assert {"search_recipes", "past_cooked_recipes"} <= home
    assert "search_recipes" not in cooking
    assert "past_cooked_recipes" not in cooking


def test_set_timer_gives_distinct_default_labels():
    assert tools._humanize_duration(600) == "10-minute timer"
    assert tools._humanize_duration(90) == "1m 30s timer"
    assert tools._humanize_duration(3600) == "1-hour timer"
    assert tools._humanize_duration(45) == "45-second timer"


def test_duration_from_text_parses_spoken_durations():
    assert tools._duration_from_text("10 minute") == 600
    assert tools._duration_from_text("90 seconds") == 90
    assert tools._duration_from_text("1 hour") == 3600
    assert tools._duration_from_text("5") == 300  # bare number => minutes
