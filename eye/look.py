"""The reel face's look: every setting the look editor (/look) tunes.

Each setting has two values, one for the first reels and one for the full
face, and the face slides from one to the other as it forms (its progress:
distortion.py, or the operator's intensity). The look is kept in setup.json
with any presets saved from the editor, so it survives restarts and reaches
every screen at once. Its background is the colour behind the face; empty,
the reel face source's own (set in the setup editor).

Categories (A3 phase 3): each category the classifier knows shows in the face.
Its fragments land in its regions of the face and take its material, and it
pushes some of the look's settings, as far as its share of the visit
(profile.py's weights). Their defaults are in config.yaml (category_looks);
the look keeps them like any setting: each push and each material's strength is
a ramp in values ("Food/gloss", "Food/material"), and each category's regions
and material in categories. The Chrome version's copy is
web/js/eye/look-settings.js: change both together.
"""

from __future__ import annotations

# name, label, lowest, highest, step, first reels, full face, what it does
SETTINGS = [
    ("Energy", [
        ("energy_size", "Shard size", 0.2, 3, 0.01, 1, 1, "How big the shards are (they also follow Fragment size)"),
        ("energy_pull", "Pull", 0.1, 3, 0.01, 1, 1, "How much of the cloud each fragment pulls in: more uses it up sooner"),
        ("energy_mix", "Mixing", 0, 1, 0.01, 0.85, 0.85, "How far a shard crossing the face takes on the face's own picture"),
        ("energy_crumble", "Crumbling", 0, 1, 0.01, 0.8, 0.5, "How much the face's edges break up into blocks like the shards"),
        ("energy_shed", "Shedding", 0, 3, 0.01, 1, 1, "How fast the face sheds shards back into the cloud"),
        ("energy_flow", "Flow", 0, 3, 0.01, 1, 1, "How fast it flows"),
        ("energy_spread", "Spread", 0.3, 2, 0.01, 1, 1, "How far it reaches round the person"),
        ("energy_colour", "Colour", 0, 1, 0.01, 0.65, 0.65, "From white and grey (0) to full colour (1)"),
        ("energy_glow", "Brightness", 0, 2, 0.01, 1, 1, "How bright it burns (it also brightens as people come closer)"),
    ]),
    ("Formation", [
        ("fragments", "Fragments per reel", 1, 40, 1, 3, 14, "How many pieces each reel breaks into"),
        ("fragment_size", "Fragment size", 0.03, 0.6, 0.01, 0.32, 0.08, "How big each piece is, as a share of the face"),
        ("jagged", "Torn edges", 0, 1, 0.01, 0.35, 0.8, "How ragged each piece's outline is"),
        ("faint", "Faintness", 0, 1, 0.01, 0.55, 0.0, "How see-through the pieces are"),
        ("likeness", "Likeness", 0, 1, 0.01, 0.45, 0.9, "How much of the live face's light and dark the reels take"),
        ("findable", "Eyes and mouth", 0, 1, 0.01, 0.85, 0.7, "How clearly the eyes and mouth come through, live and spared the damage"),
    ]),
    ("Liquid", [
        ("melt", "Melt", 0, 1, 0.01, 0.05, 0.45, "The face's shape flowing like liquid"),
        ("flow", "Flow", 0, 1, 0.01, 0.1, 0.7, "How far the picture is dragged along, block by block (datamosh)"),
        ("flow_speed", "Flow speed", 0, 1, 0.01, 0.3, 0.6, "How fast the flow drifts"),
        ("flow_scale", "Swirl size", 0, 1, 0.01, 0.5, 0.35, "Big slow swirls (1) or small busy ones (0)"),
        ("block", "Block size (px)", 2, 48, 1, 8, 16, "The datamosh's squares"),
        ("mosh", "Trails", 0, 0.98, 0.01, 0.3, 0.88, "How long the old picture hangs on and smears"),
    ]),
    ("Pixels", [
        ("pixelate", "Pixel size (px)", 1, 24, 1, 1, 4, "Everything in chunky pixels"),
        ("jpeg", "JPEG damage", 0, 1, 0.01, 0.1, 0.8, "JPEG's squares and banding; each new reel saved worse"),
        ("stretch", "Stretched rows", 0, 1, 0.01, 0.0, 0.35, "Short runs of pixels smeared sideways"),
        ("bleed", "Colour bleed", 0, 1, 0.01, 0.0, 0.5, "Colours split and run"),
    ]),
    ("Light and colour", [
        ("gloss", "Gloss lines", 0, 1, 0.01, 0.15, 0.6, "Bright lines where the surface ripples, like wet wax"),
        ("heat", "Heat colour", 0, 1, 0.01, 0.0, 0.35, "Towards orange, yellow and green, like a heat camera"),
        ("flush", "Flush", 0, 1, 0.01, 0.1, 0.5, "The fever of wanting more (grows with desire too)"),
    ]),
    ("Breaking", [
        ("fracture", "Fracture", 0, 1, 0.01, 0.0, 0.4, "Pieces pulled apart and sliding"),
        ("holes", "Holes", 0, 1, 0.01, 0.0, 0.15, "Pieces missing"),
        ("drip", "Dripping edges", 0, 1, 0.01, 0.1, 0.6, "The outline breaking into blobs and drips"),
    ]),
    ("Hair and ears", [
        ("hair", "Show hair and ears", 0, 1, 0.01, 0.9, 1.0, "How much of the hair and ears comes through; 0 at both ends switches them off"),
        ("hair_fragments", "Fragments per reel", 0, 40, 1, 10, 10, "How many pieces of each reel land on the head round the face, for the hair and ears"),
        ("hair_size", "Fragment size", 0.03, 0.6, 0.01, 0.4, 0.18, "How big each piece is, as a share of the face"),
        ("hair_likeness", "Likeness", 0, 1, 0.01, 0.35, 0.7, "How much of the real hair's light and dark the reels take"),
    ]),
]


# The effects, and their value when switched off: the look editor's solo
# shows one effect alone by switching the others off (preview only).
OFF = {"melt": 0, "flow": 0, "mosh": 0, "pixelate": 1, "jpeg": 0, "stretch": 0, "bleed": 0,
       "gloss": 0, "heat": 0, "flush": 0, "fracture": 0, "holes": 0, "drip": 0}


REGIONS = ["eyes", "brows", "forehead", "nose", "mouth", "cheeks", "jaw", "skin", "whole"]
MATERIALS = ["none", "gloss", "porcelain", "gold", "deepfried", "glassy", "tight", "cracked", "sunset", "smear"]
_SETTING = {name: (label, low, high, step) for _, group in SETTINGS for name, label, low, high, step, *_ in group}
_categories: dict = {}  # config.yaml's category_looks.categories, set once by the eye


def set_categories(categories: dict | None) -> None:
    """The categories' defaults, from config.yaml (category_looks.categories)."""
    _categories.clear()
    for name, category in (categories or {}).items():
        pushes = {setting: list(ramp) for setting, ramp in (category.get("pushes") or {}).items() if setting in _SETTING}
        _categories[name] = {"regions": [region for region in category.get("regions", []) if region in REGIONS],
                             "material": category.get("material") if category.get("material") in MATERIALS else "none",
                             "material_amount": list(category.get("material_amount", [0.5, 0.9])), "pushes": pushes}


def default_look() -> dict:
    values = {name: [start, full] for _, group in SETTINGS for name, _, _, _, _, start, full, _ in group}
    for name, category in _categories.items():
        values[f"{name}/material"] = list(category["material_amount"])
        values.update({f"{name}/{setting}": list(ramp) for setting, ramp in category["pushes"].items()})
    return {
        "values": values,
        "categories": {name: {"regions": list(category["regions"]), "material": category["material"]}
                       for name, category in _categories.items()},
        "background": "",
        "presets": {},
    }


def complete(look: dict | None) -> dict:
    """A look with every setting there (an older one may miss newer settings)."""
    full = default_look()
    if not isinstance(look, dict):
        return full
    values = {**full["values"], **{k: v for k, v in (look.get("values") or {}).items() if k in full["values"]}}
    categories = {}
    for name, default in full["categories"].items():
        saved = (look.get("categories") or {}).get(name) or {}
        regions = saved.get("regions")
        categories[name] = {
            "regions": [region for region in regions if region in REGIONS] if isinstance(regions, list) else default["regions"],
            "material": saved.get("material") if saved.get("material") in MATERIALS else default["material"]}
    return {**full, **look, "values": values, "categories": categories}


def value(look: dict, name: str, progress: float, shares: dict | None = None) -> float:
    """A setting's value this far into the face forming; with the categories'
    shares of the visit, pushed by each as far as its share (kept in range)."""
    start, end = look["values"][name]
    at = min(1.0, max(0.0, progress))
    result = start + (end - start) * at
    if shares:
        for category, part in shares.items():
            push = look["values"].get(f"{category}/{name}")
            if push:
                result += part * (push[0] + (push[1] - push[0]) * at)
        _, low, high, _ = _SETTING[name]
        result = min(high, max(low, result))
    return result


def shares(weights: dict | None) -> dict:
    """Each category's share of the visit (profile.py's weights), for the ones the look knows; 0-1, adding to 1."""
    known = {name: weight for name, weight in (weights or {}).items() if name in _categories and weight > 0}
    total = sum(known.values())
    return {name: round(weight / total, 3) for name, weight in known.items()} if total else {}


def described() -> list:
    """The settings, as the look editor shows them; the Categories group last, each setting with its category."""
    groups = [{"group": title, "settings": [
        {"name": name, "label": label, "min": low, "max": high, "step": step, "default": [start, full],
         "off": OFF.get(name), "help": help}
        for name, label, low, high, step, start, full, help in group]} for title, group in SETTINGS]
    settings = []
    for name, category in _categories.items():
        settings.append({"name": f"{name}/material", "category": name, "label": "Material", "min": 0, "max": 1, "step": 0.01,
                         "default": list(category["material_amount"]), "off": None,
                         "help": f"How strongly {name}'s fragments take its material as they land"})
        for setting, ramp in category["pushes"].items():
            label, low, high, step = _SETTING[setting]
            span = high - low
            settings.append({"name": f"{name}/{setting}", "category": name, "label": label, "min": -span, "max": span,
                             "step": step, "default": list(ramp), "off": None,
                             "help": f"How far {name} pushes {label} when the whole visit is {name} (less as its share falls)"})
    if settings:
        groups.append({"group": "Categories", "settings": settings, "regions": REGIONS, "materials": MATERIALS,
                       "defaults": {name: {"regions": list(category["regions"]), "material": category["material"]}
                                    for name, category in _categories.items()}})
    return groups
