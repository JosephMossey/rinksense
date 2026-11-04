# RINKSENSE

**Tracking where the game actually happens.** RINKSENSE replays a full NHL-style game from player and puck tracking data (Big Data Cup 2026, Oct 11 2025, Team A @ Team D). It runs as a single fast HTML/JS page with no server, no framework and no build step.

- Smooth animated replay at 1x / 1.5x / 2x / 5x. You can change speed mid-play without restarting.
- Live scoreboard that only changes at the exact tracked goal frame.
- Puck-carrier highlight: the nearest skater within 8 ft of the puck gets a gold ring.
- Live player stats for both teams: TOI, SOG, G, estimated assists (A*) and PEN, all computed through the current game time.
- GOAL banner over the rink, a play-by-play feed, period buttons, and a scrubber with goal markers.

It started as a Streamlit/Plotly prototype (`tracking_app_hockey.py`). Plotly needed about 6,900 frames per period and was far too slow, so this version draws an SVG rink and animates it with `requestAnimationFrame`. It interpolates 15 fps tracking data up to the display refresh rate, and each frame takes about 1 ms to render.

## Run it

Open `index.html` in a browser. That's it, because the data files are plain `<script>` files and work from disk.

## Rebuild the data

The raw CSVs are not in this repo. Put the Big Data Cup files for the game (`*Events.csv`, `*Shifts.csv`, `*Tracking_P1/P2/P3.csv`) in a folder, then run this from Anaconda Prompt:

```
python -m pip install pandas
python scripts/preprocess.py --src "C:\path\to\csv\folder"
```

This writes `data/meta.js` and `data/p1.js` to `data/p3.js`, about 6 MB in total.

## How it works

| Piece | What it does |
|---|---|
| `scripts/preprocess.py` | Downsamples 30 fps tracking to 15 fps and stores coordinates as 0.1 ft integers. It maps every event to a playback frame, using the tracking `Goal Score = G` frame for goals. It also estimates assists. |
| `app.js` | Runs playback, interpolation, carrier detection, the live score, stats and play-by-play. |
| `index.html`, `styles.css` | The layout and theme. |

Notes on the data: coordinates are in feet with center ice at (0, 0). Event scores in the source data are the score *before* the goal, so the scoreboard counts goals as they happen instead. The data has no assist field, so A\* is an estimate: up to two teammates who touched the puck since the scoring team last gained possession.

## Data

The data comes from the Big Data Cup 2026. Its terms apply to the derived files in `data/`.
