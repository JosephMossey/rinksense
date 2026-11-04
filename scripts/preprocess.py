"""
RINKSENSE preprocessing: Big Data Cup CSVs -> compact JS data files for the web viewer.

Usage (Anaconda Prompt, from the repo folder):
    python scripts/preprocess.py --src "C:\\path\\to\\csv\\folder"

Writes data/meta.js, data/p1.js, data/p2.js, data/p3.js. Each file sets a global so the
page also works when opened straight from disk (file://), with no local server needed.
"""
import argparse
import glob
import json
import math
import os

import pandas as pd

KEEP_EVERY = 2          # 30 fps -> 15 fps; the page interpolates between frames
SCALE = 10              # store feet * 10 as ints (0.1 ft precision)
POSSESSION_EVENTS = {"Play", "Puck Recovery", "Takeaway", "Faceoff Win", "Zone Entry",
                     "Dump In/Out", "Incomplete Play", "Shot"}
OPP_POSSESSION = {"Play", "Puck Recovery", "Takeaway", "Faceoff Win", "Zone Entry", "Dump In/Out"}


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


def find(src, suffix):
    hits = sorted(glob.glob(os.path.join(src, "*" + suffix)))
    if not hits:
        raise SystemExit(f"Could not find *{suffix} in {src}")
    return hits[0]


def build_period(path, period, home_team, away_team):
    t = pd.read_csv(path, low_memory=False)
    t["clock_s"] = t["Game Clock"].map(clock_to_sec)
    t["clock_s"] = t["clock_s"].ffill().bfill()

    # Frame order = order of Image Id as it appears in the file.
    ids = pd.unique(t["Image Id"])
    frame_of = {fid: i for i, fid in enumerate(ids)}
    t["f"] = t["Image Id"].map(frame_of)

    goal_frames = sorted(set(t.loc[t["Goal Score"].astype(str) == "G", "f"].tolist()))

    keep = t[t["f"] % KEEP_EVERY == 0].copy()
    keep["k"] = keep["f"] // KEEP_EVERY
    n = int(keep["k"].max()) + 1

    clock = keep.groupby("k")["clock_s"].first().reindex(range(n)).ffill().astype(int).tolist()

    puck = keep[keep["Player or Puck"] == "Puck"].set_index("k")
    px, py = [None] * n, [None] * n
    for k, row in puck.iterrows():
        x, y = row["Rink Location X (Feet)"], row["Rink Location Y (Feet)"]
        if not (pd.isna(x) or pd.isna(y)):
            px[k], py[k] = int(round(x * SCALE)), int(round(y * SCALE))

    pl = keep[keep["Player or Puck"] == "Player"].copy()
    pl["team"] = pl["Team"].map({"Home": home_team, "Away": away_team})
    pl["jersey"] = pl["Player Jersey Number"].map(pid)
    pl = pl.dropna(subset=["jersey", "Rink Location X (Feet)", "Rink Location Y (Feet)"])
    ents = sorted(set(zip(pl["team"], pl["jersey"])), key=lambda e: (e[0], e[1]))
    ent_idx = {e: i for i, e in enumerate(ents)}
    pl["e"] = [ent_idx[(a, b)] for a, b in zip(pl["team"], pl["jersey"])]
    pl["xi"] = (pl["Rink Location X (Feet)"] * SCALE).round().astype(int)
    pl["yi"] = (pl["Rink Location Y (Feet)"] * SCALE).round().astype(int)

    frames = [[] for _ in range(n)]
    for k, e, x, y in zip(pl["k"], pl["e"], pl["xi"], pl["yi"]):
        frames[k].extend((int(e), int(x), int(y)))

    return {
        "period": period,
        "fps": 30 / KEEP_EVERY,
        "n": n,
        "clock": clock,
        "ents": [[team, j] for team, j in ents],
        "frames": frames,
        "px": px,
        "py": py,
        "goalFrames": [g // KEEP_EVERY for g in goal_frames],
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="raw", help="folder with the Big Data Cup CSVs")
    ap.add_argument("--out", default="data")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    ev = pd.read_csv(find(a.src, "Events.csv"))
    sh = pd.read_csv(find(a.src, "Shifts.csv"))
    home, away = ev["Home_Team"].iloc[0], ev["Away_Team"].iloc[0]
    title = os.path.basename(find(a.src, "Events.csv")).replace(".Events.csv", "").replace(".", " ")

    periods = {}
    for p in (1, 2, 3):
        print(f"Period {p}...")
        periods[p] = build_period(find(a.src, f"Tracking_P{p}.csv"), p, home, away)

    ev["pid"] = ev["Player_Id"].map(pid)
    ev["pid2"] = ev["Player_Id_2"].map(pid)
    ev["clock_s"] = ev["Clock"].map(clock_to_sec)

    # Map each event to a playback frame. Goals use the tracking 'Goal Score = G' frame;
    # other events use the first frame at (or after) their clock second. Frames are kept
    # non-decreasing in file order so play-by-play order matches the event log.
    events = []
    for p in (1, 2, 3):
        P = periods[p]
        clock = P["clock"]
        goals_left = list(P["goalFrames"])
        last = 0
        sub = ev[ev["Period"] == p]
        for gi, e in sub.iterrows():
            if e["Event"] == "Goal" and goals_left:
                f = goals_left.pop(0)
            else:
                f = next((k for k, c in enumerate(clock) if c <= e["clock_s"]), P["n"] - 1)
                if goals_left:  # never place a pre-goal event after the next goal
                    f = min(f, goals_left[0])
            f = max(f, last)
            last = f
            rec = {
                "p": p, "f": int(f), "c": int(e["clock_s"]), "t": e["Team"], "pl": e["pid"],
                "ev": e["Event"], "d1": None if pd.isna(e["Detail_1"]) else str(e["Detail_1"]),
                "d2": None if pd.isna(e["Detail_2"]) else str(e["Detail_2"]),
            }
            if e["pid2"]:
                rec["pl2"] = e["pid2"]
            if e["Event"] == "Goal":
                rec["ast"] = estimate_assists(ev, gi)
            events.append(rec)

    shifts = []
    for _, s in sh.iterrows():
        shifts.append([s["Team"], pid(s["Player_Id"]), int(s["period"]),
                       clock_to_sec(s["start_clock"]), clock_to_sec(s["end_clock"])])

    roster = {home: set(), away: set()}
    for team, j, *_ in shifts:
        roster[team].add(j)
    for e in events:
        if e["pl"]:
            roster[e["t"]].add(e["pl"])

    meta = {
        "title": title, "date": str(ev["Date"].iloc[0]), "home": home, "away": away,
        "periods": {str(p): {"n": periods[p]["n"], "fps": periods[p]["fps"]} for p in periods},
        "events": events, "shifts": shifts,
        "roster": {k: sorted(v, key=lambda j: (j != "Go", int(j) if j.isdigit() else 0)) for k, v in roster.items()},
    }

    def write(name, var, obj):
        path = os.path.join(a.out, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(f"window.{var}=")
            json.dump(obj, fh, separators=(",", ":"))
            fh.write(";\n")
        print(f"  {path}: {os.path.getsize(path) / 1e6:.1f} MB")

    write("meta.js", "RS_META", meta)
    for p in (1, 2, 3):
        write(f"p{p}.js", f"RS_P{p}", periods[p])

    for e in events:
        if e["ev"] == "Goal":
            print(f"  Goal P{e['p']} {e['c']//60}:{e['c']%60:02d} {e['t']} #{e['pl']} A*={e['ast']} frame={e['f']}")


if __name__ == "__main__":
    main()
