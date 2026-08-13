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


def test_tool_definitions_have_no_allergens():
    names = [t["function"]["name"] for t in tools.TOOL_DEFINITIONS]
    assert "check_allergens" not in names
    assert "search_recipes" in names
    assert "navigate_step" in names
    assert "add_to_shopping_list" in names
