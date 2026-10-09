# DESIGN-AI.md — CPU AI for civ_lite_py (Option C: Threat-Aware Scored AI)

## Overview

This document describes the implemented CPU AI system. All code is in place.

**Approach:** Option C — Threat-Aware Scored AI
**Victory condition:** Domination only (own all original capitals). There are no science/culture
victory paths. The AI always pursues military dominance, but different leaders do so through
different styles (aggressive early rush vs. builder → conquer vs. tech → conquer).

**Design philosophy:**
- Every action is scored numerically; the AI picks the best score
- A strategic layer runs first each turn to set a danger map, unit roles, and attack target
- Roles constrain which actions are scored highly, producing coordinated unit behavior
- Four distinct leader personalities via flavor weights — same code, different behavior
- All AI decisions execute instantly within the same frame (no animation delays)

---

## Codebase Reference

### Key file paths
```
civ_lite_py/
  main.py                          ← game loop & event handling; _do_end_turn() is the hook point
  civ_game/
    game.py                        ← Game class; all action methods live here
    entities/
      civilization.py              ← Civilization dataclass
      unit.py                      ← Unit dataclass + get_reachable_tiles(), get_attackable_tiles()
      city.py                      ← City dataclass
    data/
      units.py                     ← UNIT_DEFS, UNIT_UPGRADES
      buildings.py                 ← BUILDING_DEFS
      techs.py                     ← TECH_DEFS
    map/
      hex_grid.py                  ← hex_distance(), hex_neighbors(), hexes_in_range()
      terrain.py                   ← TERRAIN_PASSABLE, TERRAIN_MOVE_COST, TERRAIN_YIELDS
    systems/
      production.py                ← get_item_cost(), complete_item()
      yields.py                    ← compute_city_yields(city, tiles, civ)
    ui/
      hud.py                       ← UIState dataclass
```

### Data model (fields the AI reads/writes)

**Civilization** (`civ_game/entities/civilization.py`):
```python
player_index: int          # 0–3
cities: list[City]
units: list[Unit]
gold: int
gold_per_turn: int         # cached net gold income (informational)
science: int
science_per_turn: int      # cached science yield (informational)
current_research: str | None
techs_researched: set[str]
original_capital: City | None
is_eliminated: bool
pending_messages: list[str]   # append here; shown to human at turn start
is_cpu: bool = False
```

**Unit** (`civ_game/entities/unit.py`):
```python
unit_type: str    # key into UNIT_DEFS
owner: int
q, r: int         # axial hex coords
hp: int
moves_left: int
fortified: bool
healing: bool
xp: int           # experience; each point adds 1% to effective strength
building_improvement: str | None
build_turns_left: int
is_civilian: bool  # property: True for settler/worker
```

**City** (`civ_game/entities/city.py`):
```python
name: str
q, r: int
owner: int
population: int
production_queue: list[str]
production_progress: int
buildings: list[str]
worked_tiles: list[tuple]
hp: int           # 0–50; city is captured when reduced to 0
```

**Tile** (value in `game.tiles: dict[(q,r) → Tile]`):
```python
terrain: str
owner: int | None
city: City | None
unit: Unit | None       # military unit
civilian: Unit | None   # civilian unit
resource: str | None
improvement: str | None
```

### Utility functions to reuse (DO NOT reimplement)

```python
# Pathfinding — returns {(q,r): move_cost}
from civ_game.entities.unit import get_reachable_tiles, get_attackable_tiles

# Hex geometry
from civ_game.map.hex_grid import hex_distance, hex_neighbors, hexes_in_range, hex_line

# City yields
from civ_game.systems.yields import compute_city_yields

# Item costs
from civ_game.systems.production import get_item_cost

# Data dicts
from civ_game.data.units import UNIT_DEFS, UNIT_UPGRADES
from civ_game.data.buildings import BUILDING_DEFS
from civ_game.data.techs import TECH_DEFS
from civ_game.map.terrain import TERRAIN_PASSABLE, TERRAIN_YIELDS, TERRAIN_BLOCKS_LOS
```

### Game action methods (call these, never mutate state directly)

```python
game.move_unit(unit, q, r, cost)         # move unit; cost from get_reachable_tiles
game.do_attack(attacker, target_q, r)    # returns message str; sets moves_left=0
game.found_city(settler)                 # settler founds city at its position
game.start_improvement(worker, key)      # key: "mine", "farm", "pasture"
game.buy_item(city, item_key)            # returns (bool, str); deducts gold
game.upgrade_unit(unit)                  # returns (bool, str)
game.end_turn()                          # processes end-of-turn; advances current_player
```

---

## Files Created / Modified

| File | Change |
|------|--------|
| `civ_game/systems/ai_e.py` | **CREATED** — all AI logic |
| `civ_game/systems/score.py` | **CREATED** — `compute_score()` for scoreboard and win screen |
| `civ_game/ui/setup_screen.py` | **CREATED** — pre-game player setup UI |
| `civ_game/entities/civilization.py` | **MODIFIED** — added `is_cpu: bool = False` field |
| `civ_game/game.py` | **MODIFIED** — accepts `cpu_flags` list in `__init__`; updated `PLAYER_NAMES` to civ names; expanded `CITY_NAMES` to 12 per civ |
| `main.py` | **MODIFIED** — shows setup screen before Game creation; `_run_cpu_turns()` handles CPU turn loop with rendering, pause, and score recording; `_record_scores()` captures score history |
| `spectate.py` | **CREATED** — AI spectator mode with simplified renderer |
| `simulate.py` | **CREATED** — headless batch simulation |

---

## Leader Flavor System

Each civ leader has flavor weights that multiply into scoring functions.
Same AI code produces distinct playstyles.

```python
# In ai_e.py — top-level constant
LEADER_FLAVORS = {
    0: {  # Rome — balanced
        "military":   1.1,
        "expansion":  0.8,
        "science":    0.9,
        "buildings":  1.0,
        "aggression": 1.0,
    },
    1: {  # Greece — science-leaning, attacks late with better units
        "military":  0.7,
        "expansion": 0.9,
        "science":   1.3,
        "buildings": 1.3,
        "aggression": 0.7,  # waits for tech advantage before attacking
    },
    2: {  # Huns — aggressive early rusher
        "military":  1.8,
        "expansion": 1.2,
        "science":   0.5,
        "buildings": 0.6,
        "aggression": 1.8,  # attacks at lower strength ratio
    },
    3: {  # Babylon — builder, attacks with bought army
        "military":  0.8,
        "expansion": 0.8,
        "science":   1.8,
        "buildings": 1.7,
        "aggression": 0.9,
    },
}
```

---

## Grand Strategy Layer

Each civ re-evaluates its grand strategy every `STRATEGY_REEVAL_INTERVAL = 25` turns (or immediately if a city is under attack). The strategy multiplies on top of the base leader flavors.

Three strategies:

| Strategy | Military | Aggression | Expansion | Science | Buildings |
|----------|----------|------------|-----------|---------|-----------|
| DOMINATION | ×1.4 | ×1.3 | ×0.8 | ×0.7 | ×0.7 |
| SCIENCE    | ×0.8 | ×0.7 | ×0.9 | ×1.5 | ×1.3 |
| EXPANSION  | ×0.9 | ×0.8 | ×1.6 | ×0.9 | ×1.0 |

```python
_civ_strategies: dict = {}   # {player_index: {"strategy": str, "turn": int}}

def _pick_strategy(game, civ, base_flavors) -> str:
    # Scores DOMINATION, SCIENCE, EXPANSION based on unit strength,
    # tech count, city count, land ownership, and proximity to enemies.
    # Returns the highest-scoring strategy name.

def _get_effective_flavors(game, civ) -> dict:
    # Re-evaluates strategy if stale or if any civ city is within 4 hexes
    # of an enemy unit (emergency override → always DOMINATION).
    # Returns {flavor_key: base * strategy_boost} for all 5 keys.
```

`_get_effective_flavors` is called once at the top of `ai_take_turn` and the result is passed down to all component functions.

---

## Component 1 — Danger Map

Computes how much enemy military threat exists on each tile.
Built once at the start of each CPU turn.

```python
def _build_danger_map(game, civ) -> dict:
    """
    Returns {(q, r): danger_value} — sum of enemy unit effective threat per tile.
    Melee units threaten tiles within move range (using strength).
    Ranged units additionally threaten tiles within attack range (using ranged_strength).
    """
    danger = {}
    for other in game.civs:
        if other.player_index == civ.player_index or other.is_eliminated:
            continue
        for unit in other.units:
            if unit.is_civilian:
                continue
            defn = UNIT_DEFS[unit.unit_type]
            strength = defn["strength"]
            move_range = defn["moves"]
            attack_range = defn.get("range", 0)
            ranged_strength = defn.get("ranged_strength", 0)
            for (q, r) in game.tiles:
                d = hex_distance(unit.q, unit.r, q, r)
                if d <= move_range:
                    danger[(q, r)] = danger.get((q, r), 0) + strength
                elif attack_range and d <= attack_range:
                    danger[(q, r)] = danger.get((q, r), 0) + ranged_strength
    return danger
```

---

## Component 2 — City Threat Assessment

Uses the danger map to score each city's vulnerability.

```python
def _city_threat(city, danger) -> int:
    """Sum of danger values within radius 3 of city."""
    total = 0
    for (q, r), val in danger.items():
        if hex_distance(city.q, city.r, q, r) <= 3:
            total += val
    return total
```

---

## Component 3 — Attack Target Selection

Picks the single best enemy city to focus on this turn.
Returns None if the AI should not attack (too weak).

```python
def _select_attack_target(game, civ, flavors) -> object:  # City | None

    my_strength = sum(
        UNIT_DEFS[u.unit_type]["strength"]
        for u in civ.units if not u.is_civilian
    )

    best_score = -9999
    best_city = None

    for other in game.civs:
        if other.player_index == civ.player_index or other.is_eliminated:
            continue

        enemy_strength = sum(
            UNIT_DEFS[u.unit_type]["strength"]
            for u in other.units if not u.is_civilian
        )

        # Veto: never attack if enemy is too strong relative to aggression flavor
        # Default threshold: 1.5x. Huns (aggression=1.8) attack at 2.7x disadvantage.
        # Greece (aggression=0.7) only attacks at 1.05x advantage.
        max_enemy_ratio = 1.0 + flavors["aggression"] * 0.5
        if my_strength == 0 or enemy_strength > my_strength * max_enemy_ratio:
            continue

        for city in other.cities:
            score = 0

            # Prefer power advantage
            score += (my_strength - enemy_strength) * 2

            # Prefer damaged cities (easier to take)
            score += (50 - city.hp) * 1.5

            # Prefer original capitals (winning condition)
            if city == other.original_capital:
                score += 40

            # Prefer closer cities
            if civ.cities:
                min_dist = min(
                    hex_distance(city.q, city.r, mc.q, mc.r)
                    for mc in civ.cities
                )
                score -= min_dist * 1.5
            else:
                score -= 30

            if score > best_score:
                best_score = score
                best_city = city

    return best_city
```

---

## Component 4 — Unit Role Assignment

Assigns each military unit a role based on strategic situation.
Roles constrain how scoring functions weight actions.

```python
def _assign_roles(civ, danger, attack_target) -> dict:
    """
    Returns {unit_id: role_str} where role is one of:
      "DEFENDER"  — stay near a threatened city
      "ATTACKER"  — march toward attack_target
      "PATROL"    — move toward borders, fortify if idle
    """
    roles = {}

    # Find cities under significant threat
    threatened_cities = [
        c for c in civ.cities
        if _city_threat(c, danger) > 15
    ]

    military_units = [u for u in civ.units if not u.is_civilian]

    # Sort by proximity to nearest threatened city
    def nearest_threat_dist(unit):
        if not threatened_cities:
            return 999
        return min(hex_distance(unit.q, unit.r, c.q, c.r)
                   for c in threatened_cities)

    military_units.sort(key=nearest_threat_dist)

    # Assign defenders: one unit per threatened city, picking closest unit
    assigned_defender_cities = set()
    for unit in military_units:
        if not threatened_cities:
            break
        nearest = min(
            threatened_cities,
            key=lambda c: hex_distance(unit.q, unit.r, c.q, c.r)
        )
        dist = hex_distance(unit.q, unit.r, nearest.q, nearest.r)
        if dist <= 6 and id(nearest) not in assigned_defender_cities:
            roles[id(unit)] = "DEFENDER"
            roles[id(unit) + 10000] = nearest  # store assigned city reference
            assigned_defender_cities.add(id(nearest))

    # Remaining units: ATTACKER if target exists, else PATROL
    for unit in military_units:
        if id(unit) not in roles:
            roles[id(unit)] = "ATTACKER" if attack_target else "PATROL"

    return roles
```

Note: `roles[id(unit) + 10000]` stores the assigned city for DEFENDER units.
Retrieve with `roles.get(id(unit) + 10000)`.

---

## Component 5 — Unit Action Execution

Main function for each military unit. Scores available actions, executes highest.

```python
def _act_military_unit(game, civ, unit, roles, defender_cities, attack_target,
                       danger, flavors, assault_ready=True):
    if unit.moves_left == 0:
        return

    role = roles.get(id(unit), "PATROL")
    defn = UNIT_DEFS[unit.unit_type]
    xp_factor = 1.0 + unit.xp * 0.01
    my_eff_str = defn["strength"] * xp_factor

    best_score = -9999
    best_action = None

    attackable = get_attackable_tiles(unit, game.tiles)  # LOS-aware for ranged
    reachable  = get_reachable_tiles(unit, game.tiles, game.turn)

    # 1. Score attack options (from current position only)
    for (tq, tr) in attackable:
        tile = game.tiles.get((tq, tr))
        if not tile: continue
        target_unit = tile.unit or tile.civilian
        target_city = tile.city
        score = 0
        if unit.hp < 30: continue  # too wounded to attack

        if target_unit:
            t_str = UNIT_DEFS[target_unit.unit_type]["strength"]
            score += (my_eff_str - t_str) * 4
            score += (100 - target_unit.hp) * 0.3
        elif target_city and target_city.owner != civ.player_index:
            score += 30 + (50 - target_city.hp) * 0.5
            if target_city == attack_target:
                score += 25
            if role == "ATTACKER":
                score *= 1.5

        score *= flavors["military"]
        if score > best_score:
            best_score = score
            best_action = ("attack", tq, tr)

    # 2. Score movement options
    # ATTACKER: use BFS path distance (not straight-line) so units navigate terrain
    attack_path_dist = None
    if role == "ATTACKER" and attack_target:
        attack_path_dist = _bfs_dist_map(attack_target.q, attack_target.r, game.tiles)

    # Retreat: if on a dangerous tile with no attack options, prefer safer tiles
    current_danger = danger.get((unit.q, unit.r), 0)
    should_retreat = current_danger > 0 and not attackable

    for (tq, tr), cost in reachable.items():
        score = 0

        if role == "DEFENDER":
            assigned_city = defender_cities.get(id(unit))
            if assigned_city:
                current_dist = hex_distance(unit.q, unit.r, assigned_city.q, assigned_city.r)
                new_dist     = hex_distance(tq, tr, assigned_city.q, assigned_city.r)
                score = (current_dist - new_dist) * 15
                tile = game.tiles.get((tq, tr))
                if tile and tile.city == assigned_city:
                    score += 20

        elif role == "ATTACKER" and attack_target:
            current_dist = attack_path_dist.get((unit.q, unit.r), 999)
            new_dist     = attack_path_dist.get((tq, tr), 999)
            if not assault_ready:
                HOLD_DIST = 5
                if new_dist < HOLD_DIST:
                    continue  # staging perimeter — don't advance yet
            score = (current_dist - new_dist) * 12
            tile_danger = danger.get((tq, tr), 0)
            if tile_danger > my_eff_str * 1.5:
                score -= 40

        else:  # PATROL
            nearest_enemy_dist = min(
                (hex_distance(tq, tr, eu.q, eu.r)
                 for other in game.civs
                 if other.player_index != civ.player_index and not other.is_eliminated
                 for eu in other.units),
                default=999
            )
            score = max(0, 10 - nearest_enemy_dist)
            tile_danger = danger.get((tq, tr), 0)
            if tile_danger > my_eff_str:
                score -= 25

        # Retreat bonus: if in danger with no attack option, prefer safer tiles
        if should_retreat:
            if danger.get((tq, tr), 0) < current_danger:
                score += 25

        # Bonus: tile puts unit in attack range of an enemy unit next turn
        unit_attack_range = defn.get("range", 1)
        for other in game.civs:
            if other.player_index == civ.player_index or other.is_eliminated: continue
            for eu in other.units:
                if eu.is_civilian: continue
                d = hex_distance(tq, tr, eu.q, eu.r)
                if 1 <= d <= unit_attack_range:
                    score += 15

        if score > best_score:
            best_score = score
            best_action = ("move", tq, tr, cost)

    # 3. Score fortify
    tile = game.tiles.get((unit.q, unit.r))
    in_city = tile and tile.city and tile.city.owner == civ.player_index
    fortify_score = 5
    if in_city:         fortify_score += 10
    if role == "DEFENDER": fortify_score += 15
    if fortify_score > best_score:
        best_score = fortify_score
        best_action = ("fortify",)

    # 4. Score heal
    hp_max = defn["hp_max"]
    if unit.hp < hp_max:
        missing = hp_max - unit.hp
        heal_score = missing * 0.3
        if in_city: heal_score += 10
        if heal_score > best_score:
            best_action = ("heal",)

    # Execute
    if best_action[0] == "attack":
        game.do_attack(unit, best_action[1], best_action[2])
    elif best_action[0] == "move":
        game.move_unit(unit, best_action[1], best_action[2], cost=best_action[3])
    elif best_action[0] == "fortify":
        unit.fortified = True; unit.moves_left = 0
    elif best_action[0] == "heal":
        unit.healing = True; unit.moves_left = 0
```

### Helper: `_bfs_dist_map`

Computes step-count (not move-cost) from a target tile to all reachable tiles, ignoring unit obstacles. Used by ATTACKER movement scoring to correctly reward alternate routes around terrain.

```python
def _bfs_dist_map(q, r, tiles) -> dict:
    """Returns {(q,r): steps} via BFS from (q,r), terrain passability only."""
```

---

## Component 6 — Settler Behavior

Settlers find the best unclaimed tile and move toward it.

```python
def _act_settler(game, civ, settler):
    if settler.moves_left == 0:
        return

    # Can we found here right now?
    tile = game.tiles.get((settler.q, settler.r))
    if tile and tile.terrain != "ocean" and tile.city is None:
        # Score this tile as a found location
        found_score = _score_settle_tile(settler.q, settler.r, game, civ)
        if found_score > 30:   # threshold: don't found on terrible land
            game.found_city(settler)
            return

    # Find best reachable tile to move toward
    flavors = LEADER_FLAVORS[civ.player_index]
    reachable = get_reachable_tiles(settler, game.tiles, game.turn)

    best_score = -9999
    best_move = None

    for (tq, tr), cost in reachable.items():
        tile = game.tiles.get((tq, tr))
        if not tile or tile.terrain == "ocean" or tile.city:
            continue
        s = _score_settle_tile(tq, tr, game, civ)
        s *= flavors["expansion"]
        if s > best_score:
            best_score = s
            best_move = (tq, tr, cost)

    if best_move:
        tq, tr, cost = best_move
        game.move_unit(settler, tq, tr, cost=cost)


def _score_settle_tile(q, r, game, civ) -> float:
    from civ_game.map.terrain import TERRAIN_YIELDS, RESOURCES
    score = 0.0

    # Sum yields of all tiles within radius 2
    for (tq, tr) in hexes_in_range(q, r, 2):
        t = game.tiles.get((tq, tr))
        if not t or t.terrain == "ocean":
            continue
        y = TERRAIN_YIELDS.get(t.terrain, {})
        score += y.get("food", 0) * 3
        score += y.get("prod", 0) * 2
        score += y.get("gold", 0) * 1
        if t.resource:
            score += 10

    # Penalty: too close to existing city (own or enemy)
    for other_civ in game.civs:
        for city in other_civ.cities:
            dist = hex_distance(q, r, city.q, city.r)
            if dist < 4:
                score -= (4 - dist) * 20

    return score
```

---

## Component 7 — Worker Behavior

Workers build improvements on worked tiles, prioritizing yield gain.

```python
def _act_worker(game, civ, worker):
    if worker.moves_left == 0 or worker.building_improvement:
        return  # already building something

    from civ_game.entities.improvement import IMPROVEMENT_DEFS

    tile = game.tiles.get((worker.q, worker.r))
    if not tile:
        return

    # Try to build an improvement on the current tile
    best_imp = None
    best_gain = 0

    for key, defn in IMPROVEMENT_DEFS.items():
        if tile.terrain not in defn.get("valid_terrain", []):
            continue
        if tile.improvement == key:
            continue  # already built
        req_tech = defn.get("requires_tech")
        if req_tech and req_tech not in civ.techs_researched:
            continue
        # Estimate yield gain
        gain = sum(defn.get("yield_bonus", {}).values())
        if gain > best_gain:
            best_gain = gain
            best_imp = key

    if best_imp:
        game.start_improvement(worker, best_imp)
        return

    # No useful improvement here — move to nearest unimproved worked tile
    reachable = get_reachable_tiles(worker, game.tiles, game.turn)
    for (tq, tr) in reachable:
        t = game.tiles.get((tq, tr))
        if not t:
            continue
        if t.owner == civ.player_index and not t.improvement:
            game.move_unit(worker, tq, tr, cost=reachable[(tq, tr)])
            return
```

---

## Component 8 — City Production Scoring

Called when a city's queue is empty. Scores all available items and queues the best one.

```python
def _act_city(game, civ, city):
    if city.production_queue:
        return  # already has something queued

    flavors = LEADER_FLAVORS[civ.player_index]
    yields = compute_city_yields(city, game.tiles, civ)
    prod_pt = max(1, yields["prod"])

    military_count = sum(1 for u in civ.units if not u.is_civilian)
    city_count = len(civ.cities)
    military_need = max(0, city_count * 2 - military_count)  # target: 2 military per city

    best_score = -9999
    best_key = None

    # Score units
    for key, defn in UNIT_DEFS.items():
        if defn["type"] == "civilian":
            if key == "settler":
                if city_count >= 4:
                    continue  # don't over-expand
                if city.population < 2:
                    continue  # don't starve the city
                score = 55 * flavors["expansion"]
            elif key == "worker":
                has_worker = any(u.unit_type == "worker" and u.owner == civ.player_index
                                 for u in civ.units)
                score = 40 if not has_worker else 5
            else:
                continue
        else:
            # Military unit
            req_tech = defn.get("requires_tech")
            if req_tech and req_tech not in civ.techs_researched:
                continue
            req_res = defn.get("requires_resource")
            if req_res and not any(
                t.resource == req_res and t.owner == civ.player_index
                for t in game.tiles.values()
            ):
                continue
            base = 30 + defn["strength"] * 1.5
            score = (base + military_need * 8) * flavors["military"]

        # Slight penalty for items that take very long to build
        turns = max(1, (get_item_cost(key) - city.production_progress + prod_pt - 1) // prod_pt)
        score -= turns * 0.5

        if score > best_score:
            best_score = score
            best_key = key

    # Score buildings
    for key, defn in BUILDING_DEFS.items():
        if key == "palace" or key in city.buildings:
            continue
        req_tech = defn.get("requires_tech")
        if req_tech and req_tech not in civ.techs_researched:
            continue

        effects = defn.get("effects", {})
        score = 0
        score += effects.get("food_per_turn",    0) * 8  * flavors["buildings"]
        score += effects.get("prod_per_turn",    0) * 7  * flavors["buildings"]
        score += effects.get("gold_per_turn",    0) * 6  * flavors["buildings"]
        score += effects.get("science_per_turn", 0) * 9  * flavors["science"]
        score += effects.get("culture_per_turn", 0) * 4  * flavors["buildings"]

        # Special case: forge gives prod on hills — hard to score generically
        if "prod_bonus_hills" in effects:
            score += 20 * flavors["buildings"]

        # Penalty for expensive buildings when military is urgent
        if military_need > 2:
            score *= 0.6

        turns = max(1, (get_item_cost(key) - city.production_progress + prod_pt - 1) // prod_pt)
        score -= turns * 0.3

        if score > best_score:
            best_score = score
            best_key = key

    if best_key:
        city.production_queue.append(best_key)
```

---

## Component 9 — Research Scoring

Called when civ has no current research.

```python
def _pick_research(game, civ):
    if civ.current_research:
        return

    flavors = LEADER_FLAVORS[civ.player_index]
    best_score = -9999
    best_tech = None

    for key, defn in TECH_DEFS.items():
        if key in civ.techs_researched:
            continue
        # Check prerequisites
        prereqs = defn.get("prerequisites", [])
        if not all(p in civ.techs_researched for p in prereqs):
            continue

        score = 0

        # Value unlocked units by their strength
        for unit_key in defn.get("unlocks_units", []):
            udef = UNIT_DEFS.get(unit_key, {})
            score += udef.get("strength", 5) * 2 * flavors["military"]

        # Value unlocked buildings by their effects
        for bld_key in defn.get("unlocks_buildings", []):
            bdef = BUILDING_DEFS.get(bld_key, {})
            effects = bdef.get("effects", {})
            score += effects.get("science_per_turn", 0) * 8 * flavors["science"]
            score += effects.get("gold_per_turn",    0) * 5 * flavors["buildings"]
            score += effects.get("prod_per_turn",    0) * 4 * flavors["buildings"]
            score += effects.get("food_per_turn",    0) * 4 * flavors["buildings"]

        # Value improvements (especially if civ has relevant resources)
        for imp_key in defn.get("unlocks_improvements", []):
            score += 15 * flavors["buildings"]

        # Bonus if revealed resource exists in civ territory
        for res in defn.get("reveals_resources", []):
            has = any(t.resource == res and t.owner == civ.player_index
                      for t in game.tiles.values())
            if has:
                score += 25

        # Slight cost penalty
        score -= defn["science_cost"] * 0.05

        if score > best_score:
            best_score = score
            best_tech = key

    if best_tech:
        civ.current_research = best_tech
```

---

## Component 10 — Gold / Buy Decisions

After all units and cities have acted, check if buying something is worthwhile.

```python
def _act_gold(game, civ):
    """
    If gold is plentiful and military is urgently needed, buy the strongest
    available unit in the most threatened city.
    """
    flavors = LEADER_FLAVORS[civ.player_index]
    military_count = sum(1 for u in civ.units if not u.is_civilian)
    city_count = len(civ.cities)
    urgent_need = military_count < city_count  # fewer than 1 unit per city = urgent

    if not urgent_need:
        return
    if civ.gold < 80:   # minimum meaningful purchase
        return

    # Find the most threatened city with space to receive a unit
    best_city = None
    best_threat = -1
    for city in civ.cities:
        tile = game.tiles.get((city.q, city.r))
        if tile and tile.unit is None:  # tile is free for a unit
            # Use a simple danger proxy: any enemy within 5 hexes
            threat = sum(
                1 for oc in game.civs if oc.player_index != civ.player_index
                for u in oc.units
                if not u.is_civilian and hex_distance(u.q, u.r, city.q, city.r) <= 5
            )
            if threat > best_threat:
                best_threat = threat
                best_city = city

    if not best_city:
        return

    # Find best unit we can afford
    best_key = None
    best_str = 0
    for key, defn in UNIT_DEFS.items():
        if defn["type"] == "civilian":
            continue
        req_tech = defn.get("requires_tech")
        if req_tech and req_tech not in civ.techs_researched:
            continue
        gold_cost = get_item_cost(key) * 2
        if civ.gold >= gold_cost and defn["strength"] > best_str:
            best_str = defn["strength"]
            best_key = key

    if best_key:
        game.buy_item(best_city, best_key)
```

---

## Component 11 — Unit Upgrades

Called before unit actions so units fight with updated stats. Upgrades if affordable and the strength gain is meaningful.

```python
def _act_upgrades(game, civ, flavors):
    gold_reserve = int(40 / flavors["aggression"])  # aggressive civs spend more
    for unit in list(civ.units):
        if unit.is_civilian or unit.moves_left == 0: continue
        path = UNIT_UPGRADES.get(unit.unit_type)     # e.g. warrior → swordsman
        if not path: continue
        target_type, gold_cost = path
        if civ.gold - gold_cost < gold_reserve: continue
        if UNIT_DEFS[target_type]["strength"] <= UNIT_DEFS[unit.unit_type]["strength"]: continue
        game.upgrade_unit(unit)
```

---

## Main AI Entry Point

The top-level function called once per CPU civ per turn.

```python
def ai_take_turn(game, civ):
    """
    Execute a full turn for a CPU-controlled civilization.
    All actions execute instantly (no animation).
    """
    # Grand strategy — compute effective flavors (base × strategy boosts)
    flavors = _get_effective_flavors(game, civ)

    # Strategic layer
    danger        = _build_danger_map(game, civ)
    attack_target = _select_attack_target(game, civ, flavors)
    roles, defender_cities = _assign_roles(civ, danger, attack_target)

    # Assault readiness: enough ATTACKER units mustered near target?
    # min_attackers scales with city HP; requires at least one melee unit.
    assault_ready = True
    if attack_target:
        # ... muster check (see code) ...

    # Research
    _pick_research(game, civ, flavors)

    # City production
    for city in civ.cities:
        _act_city(game, civ, city, flavors, attack_target)

    # Upgrade units before acting (fight with new stats)
    _act_upgrades(game, civ, flavors)

    # Civilians first (settlers, workers), then military
    for unit in list(civ.units):
        if unit.unit_type == "settler": _act_settler(game, civ, unit, flavors)
        elif unit.unit_type == "worker": _act_worker(game, civ, unit)

    for unit in list(civ.units):
        if not unit.is_civilian:
            _act_military_unit(game, civ, unit, roles, defender_cities,
                               attack_target, danger, flavors, assault_ready)

    # Gold / buy
    _act_gold(game, civ)
```

---

## Implemented: Player Setup Screen (civ_game/ui/setup_screen.py)

A full-screen UI shown **before** the Game object is created. The player toggles
each of the 4 civs between Human and CPU, then clicks Start Game. Returns a list of
4 bools (`cpu_flags`) passed to `Game.__init__`.

Default: Rome = Human, Greece/The Huns/Babylon = CPU.

### Visual layout (centered panel, 500×380px on the 1850×1000 screen)

```
┌─────────────────────────────────────┐
│         CivPy — Player Setup        │
│                                     │
│  ■  Rome          [  Human  ]       │
│  ■  Greece        [   CPU   ]       │
│  ■  The Huns      [   CPU   ]       │
│  ■  Babylon       [   CPU   ]       │
│                                     │
│             [ Start Game ]          │
└─────────────────────────────────────┘
```

- Each row: colored square swatch + civ name + toggle button
- Toggle button: **Human** = blue `(40, 80, 140)` / **CPU** = gray `(70, 70, 90)`
- Start Game button: green, centered at bottom of panel
- `run_setup_screen(screen) -> list[bool]` — blocking loop; returns `cpu_flags`

---

## Implemented: civilization.py changes

Added `is_cpu: bool = False` field. The field is set by `Game.__init__` based on `cpu_flags`.

---

## Implemented: game.py changes

`Game.__init__` now accepts `cpu_flags=None` parameter. When provided, sets `civ.is_cpu` for each player. When `None`, defaults to players 1–3 as CPU.

`PLAYER_NAMES` updated to `["Rome", "Greece", "The Huns", "Babylon"]`.

`CITY_NAMES` expanded to 12 names per civ (was 5).

---

## Implemented: main.py changes

### Setup screen integration
`main()` calls `run_setup_screen(screen)` before creating the `Game` object, passing the returned `cpu_flags` list.

### CPU turn loop: `_run_cpu_turns(game, ui_state)`
Runs all consecutive CPU turns before returning to a human player. For each CPU civ:
1. Processes pygame events (quit, P=pause, zoom, camera pan)
2. Applies keyboard camera pan (arrow keys)
3. If paused: renders and waits, then repeats without advancing
4. Calls `ai_take_turn(game, civ)`
5. Pans camera to that civ's capital (or first unit)
6. Renders and flips display
7. Waits `CPU_TURN_DELAY_MS = 10 ms`
8. Calls `game.end_turn()` and `_record_scores()`

After the loop ends (human player reached or game won), shows the turn banner and centers the camera.

### Score recording: `_record_scores(game, ui_state)`
Called after every `game.end_turn()`. Appends `[compute_score(c, game) for c in game.civs]` to `ui_state.score_history` once per unique game turn.

---

## Complete File Outline — civ_game/systems/ai.py

```
ai.py
├── LEADER_FLAVORS dict
├── _build_danger_map(game, civ) -> dict
├── _city_threat(city, danger) -> int
├── _select_attack_target(game, civ) -> City | None
├── _assign_roles(civ, danger, attack_target) -> dict
├── _act_military_unit(game, civ, unit, roles, attack_target, danger)
├── _score_settle_tile(q, r, game, civ) -> float
├── _act_settler(game, civ, settler)
├── _act_worker(game, civ, worker)
├── _act_city(game, civ, city)
├── _pick_research(game, civ)
├── _act_gold(game, civ)
└── ai_take_turn(game, civ)          ← public entry point
```

Total: approximately 600 lines.

---

## Known Limitations (by design — not bugs)

- **No multi-turn planning**: The AI doesn't pre-commit to "build 3 units then attack." It re-evaluates every turn. Military buildup happens naturally because `_act_city` keeps queuing units when `military_need > 0`.
- **No inter-civ diplomacy**: Target selection is purely based on strength ratio and proximity, not "who is a bigger threat to my long-term position."
- **Single victory path**: Only domination exists; the AI always builds toward military strength regardless of flavor (science/builder flavors just delay military, they don't pursue alternate wins).
- **No multi-unit siege coordination**: Role system prevents premature lone attacks, but doesn't actively assemble a specific stack before attacking. Units converge naturally from their ATTACKER movement scores.

---

## Known Behavior

- All-human hot-seat: set all 4 to Human; each player takes turns manually
- All-CPU watch: set all 4 to CPU; the AI loop runs continuously (no human banner)
- CPU founds cities within ~5–10 turns
- CPU trains 2+ military units within ~15 turns
- Huns attack earlier and more aggressively than Babylon or Greece
- Greece builds more science buildings and attacks later with stronger units
- `spectate.py` and `simulate.py` can be used to observe and benchmark AI behavior
