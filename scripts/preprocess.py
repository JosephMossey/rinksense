"""
RINKSENSE preprocessing: Big Data Cup CSVs -> compact JS data files for the website.

Usage (Anaconda Prompt, from the repo folder):
    python scripts/preprocess.py --src "C:\\path\\to\\csv\\folder"

Every game found in --src (one *Events.csv per game) is written to
    data/games/<game-id>/meta.js, p1.js, p2.js, p3.js (+ p4.js for overtime)
plus one index of all games at data/games.js for the NHL hub page.
Each file sets a global, so the site also works opened straight from disk (file://).
"""
import argparse
import glob
import json
import math
import os
import re
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

KEEP_EVERY = 2          # 30 fps -> 15 fps; the page interpolates between frames
SCALE = 10              # store feet * 10 as ints (0.1 ft precision)
GOAL_MARKER_TOL = 3     # seconds a tracking goal marker may differ from the event clock
CLOCK_MEDIAN_FRAMES = 151  # ~5 s window (30 fps) for cleaning the tracking clock
PERIOD_LENGTH = {1: 1200, 2: 1200, 3: 1200, 4: 300}   # regular-season OT is 5:00
POSSESSION_FT = 8       # a skater within this distance of the puck (nearest one) has possession
PUCK_OUTLIER_FT = 4    # puck points this far from their 7-frame median are treated as misreads
PUCK_FILL_FRAMES = 30   # fill puck gaps up to 1 s (30 fps), never across a camera cut
POSSESSION_EVENTS = {"Play", "Puck Recovery", "Takeaway", "Faceoff Win", "Zone Entry",
                     "Dump In/Out", "Incomplete Play", "Shot"}
OPP_POSSESSION = {"Play", "Puck Recovery", "Takeaway", "Faceoff Win", "Zone Entry", "Dump In/Out"}
PERIOD_FILES = {1: "Tracking_P1.csv", 2: "Tracking_P2.csv", 3: "Tracking_P3.csv", 4: "Tracking_POT.csv"}


def clock_to_sec(c):
    if pd.isna(c):
        return math.nan
    parts = str(c).split(":")
    return int(parts[0]) * 60 + int(float(parts[1]))


def pid(v):
    """Normalize a jersey / Player_Id value to a string label ('Go' stays 'Go')."""
    if pd.isna(v):
        return None
    s = str(v).strip()
    try:
        return str(int(float(s)))
    except ValueError:
        return s


def game_id(prefix):
    # "2025-10-11.Team.A.@.Team.D." -> "2025-10-11-a-at-d"
    m = re.match(r"(\d{4}-\d{2}-\d{2})\.Team\.(\w+)\.@\.Team\.(\w+)\.", prefix)
    return f"{m.group(1)}-{m.group(2).lower()}-at-{m.group(3).lower()}"


def build_period(path, period, home_team, away_team):
    t = pd.read_csv(path, low_memory=False)
    ids = pd.unique(t["Image Id"])
    frame_of = {fid: i for i, fid in enumerate(ids)}
    t["f"] = t["Image Id"].map(frame_of)
    t["clock_s"] = t["Game Clock"].map(clock_to_sec)

    # Clock per (30 fps) frame. The raw clock has short stray blocks (e.g. a '20:00' run in the
    # middle of a period, or '0:00' on pre-faceoff OT frames), so: fill gaps, compare each
    # value with a ~5 s rolling median, swap out values that disagree by more than 2 s, then
    # force it to only count down. Values that agree are kept exactly (20:00 stays 20:00).
    raw_clock = t.groupby("f")["clock_s"].first().reindex(range(len(ids))).ffill().bfill()
    med = raw_clock.rolling(CLOCK_MEDIAN_FRAMES, center=True, min_periods=1).median()
    fixed = raw_clock.where((raw_clock - med).abs() <= 2, med.round()).to_numpy()
    full_clock = np.minimum.accumulate(fixed).astype(int)

    goal_frames = sorted(set(t.loc[t["Goal Score"].astype(str) == "G", "f"].tolist()))

    # Camera cuts: the Image Id sequence skips when the broadcast footage jumps ahead
    # (stoppages, replays). Positions legitimately teleport there, so nothing should be
    # interpolated across one. cut_after[f] = True means a cut between frame f and f+1.
    img_no = np.array([int(str(s).rsplit("_", 1)[-1]) for s in ids])
    cut_after = np.append(np.diff(img_no) != 1, False)
    segment = np.concatenate([[0], np.cumsum(cut_after[:-1])])   # footage segment of each frame

    n = (len(ids) - 1) // KEEP_EVERY + 1
    clock = full_clock[::KEEP_EVERY][:n].tolist()
    # downsampled frame k covers raw frames [k*KEEP_EVERY, (k+1)*KEEP_EVERY)
    cuts = sorted({int(f // KEEP_EVERY) for f in np.nonzero(cut_after)[0] if f // KEEP_EVERY < n - 1})

    # Puck, cleaned at full 30 fps within each footage segment: drop points that sit far from
    # their neighbours (impossible jumps), fill gaps up to PUCK_FILL_FRAMES, light smoothing.
    pk = t[t["Player or Puck"] == "Puck"].drop_duplicates("f").set_index("f").reindex(range(len(ids)))
    pxs = pk["Rink Location X (Feet)"].astype(float)
    pys = pk["Rink Location Y (Feet)"].astype(float)
    seg = pd.Series(segment)
    clean_x, clean_y = pxs.copy(), pys.copy()
    for _, idx in seg.groupby(seg).groups.items():
        x, y = pxs.loc[idx], pys.loc[idx]
        mx = x.rolling(7, center=True, min_periods=3).median()
        my = y.rolling(7, center=True, min_periods=3).median()
        bad = np.hypot(x - mx, y - my) > PUCK_OUTLIER_FT
        x, y = x.mask(bad), y.mask(bad)
        x = x.interpolate(limit=PUCK_FILL_FRAMES, limit_area="inside")
        y = y.interpolate(limit=PUCK_FILL_FRAMES, limit_area="inside")
        sx = x.rolling(3, center=True, min_periods=1).mean().where(x.notna())
        sy = y.rolling(3, center=True, min_periods=1).mean().where(y.notna())
        clean_x.loc[idx], clean_y.loc[idx] = sx, sy
    px, py = [None] * n, [None] * n
    for k in range(n):
        x, y = clean_x.iat[k * KEEP_EVERY], clean_y.iat[k * KEEP_EVERY]
        if not (np.isnan(x) or np.isnan(y)):
            px[k], py[k] = int(round(x * SCALE)), int(round(y * SCALE))

    # Recover jersey numbers missing on some rows from the tracklet's other rows.
    pl_all = t[t["Player or Puck"] == "Player"]
    known = (pl_all.dropna(subset=["Player Jersey Number"])
             .groupby(["Team", "Player Id"])["Player Jersey Number"].agg(lambda s: s.mode().iat[0]))
    keep = t[t["f"] % KEEP_EVERY == 0].copy()
    keep["k"] = keep["f"] // KEEP_EVERY
    pl = keep[keep["Player or Puck"] == "Player"].copy()
    miss = pl["Player Jersey Number"].isna()
    if miss.any():
        fill = pd.MultiIndex.from_arrays([pl.loc[miss, "Team"], pl.loc[miss, "Player Id"]]).map(known.to_dict().get)
        pl.loc[miss, "Player Jersey Number"] = list(fill)
    pl["team"] = pl["Team"].map({"Home": home_team, "Away": away_team})
    pl["jersey"] = pl["Player Jersey Number"].map(pid)
    pl = pl.dropna(subset=["team", "jersey", "Rink Location X (Feet)", "Rink Location Y (Feet)"])
    ents = sorted(set(zip(pl["team"], pl["jersey"])))
    ent_idx = {e: i for i, e in enumerate(ents)}
    pl["e"] = [ent_idx[(a, b)] for a, b in zip(pl["team"], pl["jersey"])]
    pl["xi"] = (pl["Rink Location X (Feet)"] * SCALE).round().astype(int)
    pl["yi"] = (pl["Rink Location Y (Feet)"] * SCALE).round().astype(int)

    frames = [[] for _ in range(n)]
    for k, e, x, y in zip(pl["k"], pl["e"], pl["xi"], pl["yi"]):
        frames[k].extend((int(e), int(x), int(y)))

    # Tracked possession: in each frame, the team of the nearest skater (not goalie) within
    # POSSESSION_FT of the puck. Stored as running totals so the page can read "through now".
    puck_k = pd.DataFrame({"k": range(n), "pkx": [v / SCALE if v is not None else np.nan for v in px],
                           "pky": [v / SCALE if v is not None else np.nan for v in py]})
    sk = pl[pl["jersey"] != "Go"][["k", "team", "Rink Location X (Feet)", "Rink Location Y (Feet)"]].merge(puck_k, on="k")
    sk["d"] = np.hypot(sk["Rink Location X (Feet)"] - sk["pkx"], sk["Rink Location Y (Feet)"] - sk["pky"])
    sk = sk[sk["d"] <= POSSESSION_FT]
    owner = sk.loc[sk.groupby("k")["d"].idxmin()].set_index("k")["team"].reindex(range(n))
    poss_h = np.cumsum((owner == home_team).to_numpy()).astype(int)
    poss_a = np.cumsum((owner == away_team).to_numpy()).astype(int)

    return {
        "period": period,
        "fps": 30 / KEEP_EVERY,
        "n": n,
        "clock": clock,
        "ents": [[team, j] for team, j in ents],
        "frames": frames,
        "px": px,
        "py": py,
        "cuts": cuts,
        "possH": poss_h.tolist(),
        "possA": poss_a.tolist(),
        "goalMarkers": [[g // KEEP_EVERY, int(full_clock[g])] for g in goal_frames],
    }


def estimate_assists(ev, gi):
    """Walk back from a goal: up to two distinct teammates (not the scorer) who touched
    the puck since the scoring team last gained possession."""
    goal = ev.loc[gi]
    team, scorer = goal["Team"], goal["pid"]
    out = []
    for i in range(gi - 1, -1, -1):
        e = ev.loc[i]
        if e["Period"] != goal["Period"]:
            break
        if e["Team"] != team:
            if e["Event"] in OPP_POSSESSION:
                break
            continue
        if e["Event"] not in POSSESSION_EVENTS:
            continue
        p = e["pid"]
        if p and p != scorer and p not in out:
            out.append(p)
        if len(out) == 2:
            break
    return out


def write_js(path, var, obj):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(f"window.{var}=")
        json.dump(obj, fh, separators=(",", ":"))
        fh.write(";\n")


def process_game(args):
    src, prefix, out_root = args
    gid = game_id(prefix)
    out = os.path.join(out_root, "games", gid)
    os.makedirs(out, exist_ok=True)

    ev = pd.read_csv(os.path.join(src, prefix + "Events.csv"))
    sh = pd.read_csv(os.path.join(src, prefix + "Shifts.csv"))
    home, away = ev["Home_Team"].iloc[0], ev["Away_Team"].iloc[0]

    periods = {}
    for p, suffix in PERIOD_FILES.items():
        path = os.path.join(src, prefix + suffix)
        if os.path.exists(path):
            periods[p] = build_period(path, p, home, away)

    ev["pid"] = ev["Player_Id"].map(pid)
    ev["pid2"] = ev["Player_Id_2"].map(pid)
    ev["clock_s"] = ev["Clock"].map(clock_to_sec)

    # Map each event to a playback frame. Goals use the tracking 'Goal Score = G' frame when
    # one sits within a few seconds of the event clock; everything else uses the first frame
    # at (or after) its clock second. Frames stay non-decreasing in event-log order.
    events = []
    markers_used = 0
    for p in sorted(periods):
        P = periods[p]
        clock = P["clock"]
        markers = list(P["goalMarkers"])
        sub = ev[ev["Period"] == p]
        goal_frame = {}
        for gi, e in sub[sub["Event"] == "Goal"].iterrows():
            near = [m for m in markers if abs(m[1] - e["clock_s"]) <= GOAL_MARKER_TOL]
            if near:
                m = min(near, key=lambda m: abs(m[1] - e["clock_s"]))
                markers.remove(m)
                goal_frame[gi] = m[0]
        markers_used += len(goal_frame)
        last = 0
        goal_idx = [gi for gi in sub.index if sub.loc[gi, "Event"] == "Goal"]
        for gi, e in sub.iterrows():
            if gi in goal_frame:
                f = goal_frame[gi]
            else:
                f = next((k for k, c in enumerate(clock) if c <= e["clock_s"]), P["n"] - 1)
                nxt = next((goal_frame[g] for g in goal_idx if g > gi and g in goal_frame), None)
                if nxt is not None:  # never place a pre-goal event after the next goal
                    f = min(f, nxt)
            f = max(f, last)
            last = f
            rec = {
                "p": p, "f": int(f), "c": int(e["clock_s"]), "t": e["Team"], "pl": e["pid"],
                "ev": e["Event"], "d1": None if pd.isna(e["Detail_1"]) else str(e["Detail_1"]),
                "d2": None if pd.isna(e["Detail_2"]) else str(e["Detail_2"]),
            }
            if e["pid2"]:
                rec["pl2"] = e["pid2"]
            if e["clock_s"] > clock[0] + 1:
                rec["pre"] = 1   # happened before this period's tracking starts

            if e["Event"] == "Goal":
                rec["ast"] = estimate_assists(ev, gi)
                x, y = e["X_Coordinate"], e["Y_Coordinate"]
                if not (pd.isna(x) or pd.isna(y)):
                    # mirror so every goal is shown attacking the right-hand net
                    rec["xy"] = [round(abs(x), 1), round(y if x >= 0 else -y, 1)]
            events.append(rec)

    shifts = []
    for _, s in sh.iterrows():
        if int(s["period"]) in periods and pid(s["Player_Id"]):
            shifts.append([s["Team"], pid(s["Player_Id"]), int(s["period"]),
                           clock_to_sec(s["start_clock"]), clock_to_sec(s["end_clock"])])

    roster = {home: set(), away: set()}
    for team, j, *_ in shifts:
        roster[team].add(j)
    for e in events:
        if e["pl"] and e["t"] in roster:
            roster[e["t"]].add(e["pl"])

    meta = {
        "id": gid, "date": str(ev["Date"].iloc[0]), "home": home, "away": away,
        "periods": {str(p): {"n": periods[p]["n"], "fps": periods[p]["fps"],
                             "start": periods[p]["clock"][0], "len": PERIOD_LENGTH[p],
                             "poss": [periods[p]["possH"][-1], periods[p]["possA"][-1]]} for p in periods},
        "events": events, "shifts": shifts,
        "roster": {k: sorted(v, key=lambda j: (j != "Go", int(j) if j.isdigit() else 0)) for k, v in roster.items()},
    }
    write_js(os.path.join(out, "meta.js"), "RS_META", meta)
    for p in periods:
        P = dict(periods[p])
        P.pop("goalMarkers")
        write_js(os.path.join(out, f"p{p}.js"), f"RS_P{p}", P)

    goals = [e for e in events if e["ev"] == "Goal"]
    count = lambda team, pred: sum(1 for e in events if e["t"] == team and pred(e))
    sog = lambda e: e["ev"] == "Goal" or (e["ev"] == "Shot" and e["d2"] == "On Net")
    summary = {
        "id": gid, "date": meta["date"], "home": home, "away": away,
        "score": {home: count(home, lambda e: e["ev"] == "Goal"), away: count(away, lambda e: e["ev"] == "Goal")},
        "sog": {home: count(home, sog), away: count(away, sog)},
        "pen": {home: count(home, lambda e: e["ev"] == "Penalty Taken"), away: count(away, lambda e: e["ev"] == "Penalty Taken")},
        "ot": 4 in periods,
        "goals": [{"p": g["p"], "c": g["c"], "t": g["t"], "pl": g["pl"], "d1": g["d1"], "xy": g.get("xy")} for g in goals],
        "periodLength": {str(p): PERIOD_LENGTH[p] for p in periods},
        "trackStart": {str(p): periods[p]["clock"][0] for p in periods},
        "frames": sum(P["n"] for P in periods.values()) * KEEP_EVERY,
        "events": len(events),
    }
    print(f"  {gid}: {away} {summary['score'][away]} @ {home} {summary['score'][home]}"
          f"{' (OT)' if summary['ot'] else ''}  periods={sorted(periods)}  goals synced to tracking={markers_used}/{len(goals)}")
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="raw", help="folder with the Big Data Cup CSVs")
    ap.add_argument("--out", default="data")
    ap.add_argument("--workers", type=int, default=max(1, min(5, (os.cpu_count() or 2) - 1)))
    a = ap.parse_args()

    prefixes = sorted(os.path.basename(f)[: -len("Events.csv")] for f in glob.glob(os.path.join(a.src, "*Events.csv"))
                      if "checkpoint" not in f)
    if not prefixes:
        raise SystemExit(f"No *Events.csv files found in {a.src}")
    print(f"Processing {len(prefixes)} games with {a.workers} workers...")
    os.makedirs(os.path.join(a.out, "games"), exist_ok=True)
    with ProcessPoolExecutor(a.workers) as pool:
        games = list(pool.map(process_game, [(a.src, p, a.out) for p in prefixes]))
    games.sort(key=lambda g: (g["date"], g["id"]))
    write_js(os.path.join(a.out, "games.js"), "RS_GAMES", games)
    print(f"Wrote {len(games)} games to {a.out}")


if __name__ == "__main__":
    main()
