"""Download raw MLB data into ../raw/mlb (never committed).

  python scripts/mlb_fetch.py feeds      # 2026 postseason game feeds (MLB Stats API)
  python scripts/mlb_fetch.py statcast   # 2026 Statcast pitches, one CSV per day (Baseball Savant)

Re-running skips files that already exist. Data (c) MLB Advanced Media, for
individual, non-commercial, non-bulk use.
"""
import argparse
import datetime as dt
import json
import time
from pathlib import Path

import requests

SEASON = 2026
ROOT = Path(__file__).resolve().parents[2] / "raw" / "mlb"
API = "https://statsapi.mlb.com/api"
SAVANT = "https://baseballsavant.mlb.com/statcast_search/csv"
S = requests.Session()
S.headers["User-Agent"] = "rinksense-fetch/1.0"


def get(url, **params):
    for attempt in range(4):
        try:
            r = S.get(url, params=params, timeout=120)
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")


def postseason_games():
    d = get(f"{API}/v1/schedule", sportId=1, season=SEASON, gameType="F,D,L,W").json()
    games = {}
    for day in d["dates"]:
        for g in day["games"]:
            if g["status"]["detailedState"] == "Final":
                games[g["gamePk"]] = g
    return sorted(games.values(), key=lambda g: g["gameDate"])


def fetch_feeds():
    out = ROOT / "feeds"
    out.mkdir(parents=True, exist_ok=True)
    games = postseason_games()
    (out / "schedule.json").write_text(json.dumps(games, indent=1))
    for g in games:
        pk = g["gamePk"]
        for name, url in (("feed", f"{API}/v1.1/game/{pk}/feed/live"),
                          ("wp", f"{API}/v1/game/{pk}/winProbability")):
            f = out / f"{pk}_{name}.json"
            if f.exists():
                continue
            f.write_bytes(get(url).content)
            time.sleep(0.5)
        print(pk, g["officialDate"], g["teams"]["away"]["team"]["name"], "@",
              g["teams"]["home"]["team"]["name"])
    print(f"{len(games)} games -> {out}")


def fetch_statcast():
    out = ROOT / "statcast"
    out.mkdir(parents=True, exist_ok=True)
    s = get(f"{API}/v1/seasons/{SEASON}", sportId=1).json()["seasons"][0]
    day = dt.date.fromisoformat(s["regularSeasonStartDate"])
    end = dt.date.fromisoformat(s.get("postSeasonEndDate") or s["seasonEndDate"])
    while day <= end:
        f = out / f"{day}.csv"
        if not f.exists():
            r = get(SAVANT, all="true", type="details", player_type="pitcher",
                    hfSea=f"{SEASON}|", hfGT="R|F|D|L|W|",
                    game_date_gt=str(day), game_date_lt=str(day))
            f.write_bytes(r.content)
            rows = max(r.text.count("\n") - 1, 0)
            print(day, rows, "pitches")
            if rows >= 24999:
                print("  WARNING: hit Savant's row cap for", day)
            time.sleep(1.5)
        day += dt.timedelta(days=1)
    print("done ->", out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["feeds", "statcast"])
    {"feeds": fetch_feeds, "statcast": fetch_statcast}[ap.parse_args().what]()
