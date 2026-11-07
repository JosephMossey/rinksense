# RINKSENSE

**Watch the game the way the data saw it.** RINKSENSE is a personal sports-analytics project that rebuilds full hockey games from player and puck tracking data and replays them in the browser. It's a static site: no server, no framework, no build step.

**NHL page (`index.html`)**
- Every game as a card with the final score, a goal timeline and shots on goal. You can filter by team and sort by newest, oldest or most goals.
- An "every goal, one net" rink map. Click any goal to open its game.

**Game report (`report.html?g=<game-id>`)**: the full-game breakdown (it includes the final result; the replay never does).
- Win probability over the whole game, with power plays shaded and the three biggest turning points, each linking straight to that moment in the replay.
- Team comparison: xG, shots, possession, power plays, offensive-zone time, team spacing, and reaction burst after turnovers.
- Skating and movement for every player: top speed, burst acceleration, bursts per 10 minutes, feet per minute, sprint share, with vs without the puck, speed zones, and shift-start speed across the game (a fatigue signal).
- Pass networks by team and period.
- A share card (1200 × 630 image) with an auto-written headline.

**Methods (`methods.html`)**: how every stat and model is built, how accurate it is, and its limits.

**Game replay (`game.html?g=<game-id>`)**
- Smooth animated replay at 1x / 1.5x / 2x / 5x. You can change speed mid-play without restarting, and overtime is supported.
- Live scoreboard that only changes at the tracked goal frame, plus a team stat strip: expected goals, shots on goal, shot attempts, penalties, and tracked possession with time with puck.
- **Expected goals (xG):** a ridge logistic regression trained on 900 unblocked shots (58 goals) from all 10 games. Its inputs are distance, angle, rebound (within 3 s), one-timer, traffic, deflection and power play. Tested leave-one-game-out (each game predicted by a model that never saw it), it scores AUC 0.78 with 12% lower log loss than a flat shooting-percentage baseline, and its predicted goals total 58.5 against 58 actual. The fitted model and these numbers are written to `data/xg_model.js`.
- **Power plays:** each penalty opens a power-play window. The window ends at the 2:00 expiry, at a power-play goal, or when the event log's skater counts go back to even (e.g. offsetting minors). Delayed-penalty extra attackers and late-game pulled goalies are never counted as power plays. The replay shows a live PP countdown to the normal expiry, so it never hints at an early goal. It also tints the rink, counts power plays as goals / chances with PP xG, shades power plays on the momentum chart, and adds a recap line to the play-by-play.
- **Time with puck / possession:** in each tracked frame, the nearest skater within 6 ft of the puck has it. Summed per player that's time with puck (TWP); summed per team it's possession.
- Momentum chart of shot attempts per 2 minutes, filled in only up to the current moment, and a short puck trail on the rink.
- Players the broadcast camera isn't tracking stay on the ice (faded) using the shift chart, so the rink always shows who's actually out there.
- Puck-carrier highlight: the nearest skater within 8 ft of the puck gets a gold ring.
- Live player stats per team (TOI, SOG, G, estimated A\*, PEN), all computed through the current game time.
- GOAL banner over the rink, a play-by-play feed, period buttons, and a scrubber with goal markers.

It started as a Streamlit/Plotly prototype (`tracking_app_hockey.py`). Plotly needed about 6,900 frames per period and was far too slow, so this version draws an SVG rink and animates it with `requestAnimationFrame`. It interpolates 15 fps tracking data up to the display refresh rate, and each frame takes about 1 ms to render.

## Run it

Open `index.html` in a browser. The data files are plain `<script>` files, so this works straight from disk and on GitHub Pages.

## Rebuild the data

The raw CSVs are not in this repo. Put each game's `*Events.csv`, `*Shifts.csv` and `*Tracking_P1/P2/P3.csv` files (plus `*Tracking_POT.csv` for overtime) in one folder, then run this from Anaconda Prompt:

```
python -m pip install pandas numpy
python scripts/preprocess.py --src "C:\path\to\csv\folder"
```

This writes `data/games.js`, which indexes every game for the NHL page, and one folder per game in `data/games/<game-id>/`. Ten games come to about 50 MB.

## How it works

| Piece | What it does |
|---|---|
| `scripts/preprocess.py` | Processes games in parallel. It downsamples 30 fps tracking to 15 fps as 0.1 ft integers, and cleans the tracking clock: stray blocks are dropped and the clock is forced to only count down. It maps every event to a playback frame, using the tracking goal marker for goals. It also estimates assists and builds the game summaries. |
| `scripts/analytics.py` | Computes movement metrics from the raw 30 fps tracking (with ID-swap and jitter cleanup), team shape, the win-probability timeline and turning points, and pass networks. They're written to `data/games/<id>/report.js`. |
| `report.html`, `report-page.js`, `report.css`, `methods.html` | The game report and methods pages. |
| `hub.js` | Runs the NHL page: game cards, filters and the goal map. |
| `app.js` | Runs the replay: playback, interpolation, carrier detection, the live score, stats and play-by-play. |
| `index.html`, `game.html`, `styles.css` | The pages and the shared theme. |

Notes on the data:
- Coordinates are in feet with center ice at (0, 0).
- The source has no assist field, so A\* is an estimate: up to two teammates who touched the puck since the scoring team last gained possession.
- A few periods only have tracking for part of the period. The replay says where tracking starts, and earlier events still count toward the score and stats.

## Data

The tracking and event data is Stathletes' public hockey dataset. It's free to use for non-commercial work.
