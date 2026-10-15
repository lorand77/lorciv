# AI flavors and seats: who wins AI-only games, and why

Run 2026-10-15 at commit `7359ce0` (`RULES_VERSION` 1), Node 24.22.0, on an
8-thread Intel Xeon 6975P-C (4 cores × 2 hyperthreads). Each run took about
11 minutes, 3000 games in all.

## Question

When all four civs are played by the AI, how often does each one win? And how
much of that comes from the civ's AI personality and how much from its seat,
meaning its place in the turn order?

## Background

- **The civs differ only in how the AI plays them.** In the rules they are
  identical: same units, yields and buildings. Each has an AI personality, a
  set of weights in `LEADER_FLAVORS` (`src/shared/ai.js`):

  | Civ | Military | Expansion | Science | Buildings | Aggression |
  |---|---|---|---|---|---|
  | Rome | 1.1 | 0.8 | 0.9 | 1.0 | 1.0 |
  | Greece | 0.7 | 0.9 | 1.3 | 1.3 | 0.7 |
  | The Huns | 1.8 | 1.2 | 0.5 | 0.6 | 1.8 |
  | Babylon | 0.8 | 0.8 | 1.8 | 1.7 | 0.9 |

- **A seat is a place in the turn order.** Seat 1 moves first every round and
  seat 4 last. In a real game Rome always has seat 1, Greece seat 2, the Huns
  seat 3 and Babylon seat 4. On a given map, a seat also comes with a start
  spot: each map deals the four quadrants to the four seats at random, from
  its seed.
- **Victory is by conquest only.** A civ wins by holding every original
  capital. There is no science or score victory. A game with no winner by
  turn 2000 counts as no one's win.
- **Default settings.** All AIs play at the default difficulty (no production
  or food bonus), on the standard 32×24 map with 4 civs.
- **The runs are repeatable.** No game involves chance once its seed is
  fixed, so the same seed and seating always play out the same way. These
  commands, run at this commit, reproduce every number below exactly.

## Design

Three runs of 1000 games each, all starting from seed 1:

| Run | Maps | Which personality plays each seat | What it measures |
|---|---|---|---|
| `fixed` | seeds 1–1000, one game each | each civ's own, as in the lobby | each civ's win rate as the game is actually played; personality and seat cannot be told apart |
| `rotate` | seeds 1–250, four games each | moved one seat along each game (below) | the personalities' strength with the seat effect removed, and a personality × seat table |
| `mirror:rome` | seeds 1–1000, one game each | Rome's in all four seats | the seat's edge alone |

In `rotate`, each map is played four times:

| Game on a map | Seat 1 | Seat 2 | Seat 3 | Seat 4 |
|---|---|---|---|---|
| 1st | Rome | Greece | The Huns | Babylon |
| 2nd | Babylon | Rome | Greece | The Huns |
| 3rd | The Huns | Babylon | Rome | Greece |
| 4th | Greece | The Huns | Babylon | Rome |

On every map, each personality plays every seat and start spot once. Map and
start-spot luck therefore cancel out between personalities. Each cell of the
personality × seat table is 250 games.

**The runs share games and maps.** The first game on each `rotate` map is the
same game that `fixed` plays on that seed. So 250 of the 1000 `fixed` games
also appear in `rotate`, as its four "own seat" cells (Rome in seat 1, Greece
in seat 2, and so on). The `mirror:rome` run uses the same 1000 maps as
`fixed`.

## Commands

Run from the repo root. The jobs setting was left at its default, one worker
per logical CPU (8 here).

```sh
D=experiments/2026-10-15-ai-flavor-seats
for mode in fixed rotate mirror:rome; do
  f=$D/${mode/:/-}.txt
  echo "start $(date -u +%FT%TZ)" > $f.time
  node tools/simulate.js --games 1000 --seed 1 --seats $mode > $f 2>&1
  echo "exit $? end $(date -u +%FT%TZ)" >> $f.time
done
```

The loop runs these three commands, one after another:

```sh
node tools/simulate.js --games 1000 --seed 1 --seats fixed
node tools/simulate.js --games 1000 --seed 1 --seats rotate
node tools/simulate.js --games 1000 --seed 1 --seats mirror:rome
```

Each run's raw output is in `fixed.txt`, `rotate.txt` and `mirror-rome.txt`,
with its start and end times in the matching `.time` file.
`start-quadrants.js` is the start-placement check described under
Discussion.

## Results

± is the 95% margin of each share. The p-values come from a chi-square test
against equal shares (3 degrees of freedom), or from a z-test for the
difference between two shares from the same games.

### `fixed`: the civs as they play in the lobby

| Seat | Civ | Wins | Win % |
|---|---|---|---|
| 1 | Rome | 281 | 28.1 ± 2.8 |
| 2 | Greece | 258 | 25.8 ± 2.7 |
| 3 | The Huns | 288 | 28.8 ± 2.8 |
| 4 | Babylon | 173 | 17.3 ± 2.3 |

The shares are unequal (χ² 33.6, p < 0.0001). Every game had a winner; the
average game lasted 282 turns.

### `rotate`: each personality in every seat

By personality:

| Personality | Wins | Win % |
|---|---|---|
| The Huns | 308 | 30.8 ± 2.9 |
| Rome | 272 | 27.2 ± 2.8 |
| Greece | 225 | 22.5 ± 2.6 |
| Babylon | 194 | 19.4 ± 2.5 |

By seat:

| Seat | Wins | Win % |
|---|---|---|
| 1 | 246 | 24.6 ± 2.7 |
| 2 | 289 | 28.9 ± 2.8 |
| 3 | 233 | 23.3 ± 2.6 |
| 4 | 231 | 23.1 ± 2.6 |

Win % by personality and seat (250 games per cell):

| | Seat 1 | Seat 2 | Seat 3 | Seat 4 |
|---|---|---|---|---|
| Rome | **28.4** ± 5.6 | 29.2 ± 5.6 | 25.6 ± 5.4 | 25.6 ± 5.4 |
| Greece | 22.0 ± 5.1 | **26.8** ± 5.5 | 20.4 ± 5.0 | 20.8 ± 5.0 |
| The Huns | 28.4 ± 5.6 | 34.4 ± 5.9 | **29.6** ± 5.7 | 30.8 ± 5.7 |
| Babylon | 19.6 ± 4.9 | 25.2 ± 5.4 | 17.6 ± 4.7 | **15.2** ± 4.5 |

Bold cells are each civ's own seat, the lineup a real game uses.

- **Personalities differ:** χ² 30.5, p < 0.0001.
- **Seats differ:** χ² 8.8, p = 0.033.
- **Timeouts:** one game had no winner by turn 2000.
- **Length:** the average game lasted 282 turns.

### `mirror:rome`: Rome's personality in every seat

| Seat | Wins | Win % |
|---|---|---|
| 1 | 252 | 25.2 ± 2.7 |
| 2 | 283 | 28.3 ± 2.8 |
| 3 | 219 | 21.9 ± 2.6 |
| 4 | 246 | 24.6 ± 2.7 |

The seats differ: χ² 8.3, p = 0.041. Every game had a winner; the average
game lasted 282 turns.

## Discussion

### 1. The AI personality is the main effect

With seats balanced, the four personalities' win rates range from 19% to 31%,
far beyond chance. They fall into two tiers:

- **Military:** the Huns (30.8%) and Rome (27.2%).
- **Builders:** Greece (22.5%) and Babylon (19.4%).

The gap between the tiers is real; for example, Rome against Greece gives
p = 0.035. The gaps within each tier are not significant at this sample size
(p ≈ 0.13 for both pairs). The ranking holds across the table: the Huns are
top or tied in every seat, and Babylon is bottom in every seat.

The order follows the military and aggression weights. That fits the victory
rule. The only way to win is to take every capital, so a personality that
favours science and buildings must still win by conquest. Its tech lead
apparently does not make up for the armies it does not build. This is a
reading of the results, not something these runs measured. They record only
who won.

### 2. The seat matters less, and not in the expected way

**Moving first is not an advantage, and moving last is not a penalty.** Seat 1
sits at about 25% in both runs that balance personalities, and seat 4 at
23–25%.

**Seat 2 does better.** It wins 28.9% in `rotate` and 28.3% in `mirror:rome`,
and it is the best seat for every personality in the table. Each run alone is
only moderate evidence (p ≈ 0.03–0.04). Pooled, seat 2 wins 28.6% (p = 0.001).
That pooled figure overstates the evidence, for two reasons: the runs share
maps, and seat 2 was singled out after seeing the data. So read this as a
likely edge of about 3–4 points, not yet confirmed. These runs can't say why
seat 2 would be better.

**Seat 3 is lowest in `mirror:rome`** (21.9%; against seat 2, p = 0.004).
Part of this could be map luck. Seeds 1–1000 happen to deal start quadrants
unevenly:

- Seat 1 starts in the top-left quadrant in 29.7% of maps and seat 3 in only
  19.9%, against an expected 25% (χ² 30.1, 9 degrees of freedom, p < 0.001).
- Seat 2's starts are even (23.6–26.2% in each quadrant).

Over seeds 1001–11000 and 5000001–5010000 the deal is even (χ² 15.6 and 4.7,
both below the 5% level of 16.9). So this is a quirk of these seeds, not a bug
in placement. If the top-left quadrant is better, it would lift seat 1 and
hold back seat 3 in these runs; whether it is better was not measured.
`start-quadrants.js` reproduces these numbers.

### 3. The lobby lineup combines both effects

In a real all-AI game, Babylon wins only 17.3%. It has the weakest
personality, and it plays from seat 4, its worst seat in the table (15.2%).
Greece's 25.8% is helped by sitting in seat 2: its average over all seats is
22.5%. The `fixed` results agree with the bold cells of the table. That
agreement is partly by construction, since 250 of the games are shared.

### 4. What this means for the game

- **Among AI opponents, the Huns and Rome are the dangerous ones**, and
  Babylon the easiest. If the four AIs are meant to be about equal, Greece and
  Babylon need more weight on military and aggression. Changing
  `LEADER_FLAVORS` changes how saved games play out, so it needs a
  `RULES_VERSION` bump.
- **For a person, choosing a civ only chooses a seat.** The personalities
  apply only to AI-played civs. Any seat edge measured here is between AIs;
  it may differ when a person holds a seat.
- **Games are reliably decisive.** One game in 3000 hit the 2000-turn cap.

## Caveats

- **Scope.** These are AI-only games at default difficulty, on one map size
  with four civs.
- **One seed range.** All runs use seeds 1–1000, whose start-quadrant skew is
  described above.
- **Turn-order neighbours are fixed.** The rotation keeps the lobby's cyclic
  order, so each personality always moves right after the same one (the Huns
  after Greece, Rome after Babylon, and so on). Any effect of who moves just
  before you is not separated out.
- **Only Rome was mirrored.** The seat effect might differ for a more
  aggressive personality, or a more passive one.
- **Several comparisons.** Many comparisons were made, so a single p ≈ 0.03
  is weak evidence on its own.

## Follow-ups

- **Mirror the other personalities** (`mirror:huns`, `mirror:greece`,
  `mirror:babylon`, about 11 minutes each), to see whether seat 2's edge holds
  for every one.
- **Rerun `mirror:rome` on new seeds** (for example `--seed 1001`) or with more
  games, to confirm the seat 2 and seat 3 numbers without the start-quadrant
  skew.
- **Record each game's details:** start quadrants, who took whose capital, and
  when. That would show why seat 2 does well, and whether the top-left quadrant
  matters.
- **Seat by all 24 orderings** instead of 4 rotations, to balance turn-order
  neighbours too.
