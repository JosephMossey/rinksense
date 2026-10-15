"""
Hockey Team Movement Viewer — Plotly animated edition
Same Stats Perform data as before, but instead of a manual slider you
scrub, this builds a real animated rink with Play/Pause and speed
controls (1x / 1.5x / 2x / 5x), plus a live scoreboard.

DATA SETUP
----------
Put these files in a folder called "data" next to this script:
  - <game>_Tracking_P1.csv, _P2.csv, _P3.csv   (period tracking)
  - <game>_Events.csv                          (play-by-play + score)

RUN
---
pip install streamlit pandas plotly
streamlit run tracking_app_hockey_animated.py
"""

import glob
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
from pathlib import Path

DATA_DIR = Path("./data")
RINK_LENGTH = 200
RINK_WIDTH = 85
SOURCE_FPS = 30  # Stats Perform tracking frame rate

# ---------- PAGE / THEME ----------
st.set_page_config(page_title="RinkSense", layout="wide")

st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Inter:wght@400;500;600&display=swap');

.stApp { background: linear-gradient(180deg, #0b1220 0%, #111a2e 100%); }
html, body, p, label, .stMarkdown, [data-testid="stSidebar"] * {
    font-family: 'Inter', sans-serif !important;
}
h1, h2, h3, p, label, .stMarkdown { color: #e8edf7 !important; }
[data-testid="stSidebar"] { background: #0d1526; border-right: 1px solid #22304a; }

.app-title {
    font-family: 'Bebas Neue', sans-serif;
    font-size: 56px;
    letter-spacing: 4px;
    color: #ffffff;
    margin-bottom: 0;
    line-height: 1;
}
.app-subtitle {
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #6b7fa8;
    margin-top: 4px;
    margin-bottom: 22px;
}

.scoreboard {
    display: flex; justify-content: center; align-items: center; gap: 28px;
    background: #111a2e; border: 1px solid #22304a; border-radius: 14px;
    padding: 14px 28px; margin-bottom: 18px; box-shadow: 0 4px 18px rgba(0,0,0,0.35);
}
.team-block { text-align: center; min-width: 140px; }
.team-name { font-size: 15px; letter-spacing: 1px; color: #9db2d6; text-transform: uppercase; }
.team-score { font-family: 'Bebas Neue', sans-serif; font-size: 46px; color: #ffffff; line-height: 1.1; }
.score-sep { font-size: 28px; color: #4a5b82; font-weight: 300; }
.clock-block { text-align: center; color: #ffd166; font-size: 20px; font-weight: 600; }
.period-tag {
    background: #1e2b47; color: #9db2d6; font-size: 12px; padding: 3px 10px;
    border-radius: 20px; margin-top: 4px; display: inline-block;
}
</style>
""", unsafe_allow_html=True)

st.markdown("""
<div class="app-title">RINKSENSE</div>
<div class="app-subtitle">tracking where the game actually happens</div>
""", unsafe_allow_html=True)


# ---------- DATA LOADING ----------
@st.cache_data
def load_tracking() -> pd.DataFrame:
    files = sorted(glob.glob(str(DATA_DIR / "*Tracking*.csv")))
    if not files:
        return pd.DataFrame()
    frames = [pd.read_csv(f, low_memory=False) for f in files]
    df = pd.concat(frames, ignore_index=True)
    df = df.rename(columns={
        "Image Id": "frame_id", "Period": "period", "Game Clock": "clock",
        "Player or Puck": "kind", "Team": "team", "Player Jersey Number": "jersey",
        "Rink Location X (Feet)": "x", "Rink Location Y (Feet)": "y",
    })
    df = df.dropna(subset=["x", "y"])
    df["clock_seconds"] = df["clock"].apply(_clock_to_seconds)
    df["game_seconds"] = (df["period"] - 1) * 1200 + (1200 - df["clock_seconds"])
    return df


@st.cache_data
def load_events() -> pd.DataFrame:
    files = glob.glob(str(DATA_DIR / "*Events*.csv"))
    if not files:
        return pd.DataFrame()
    ev = pd.read_csv(files[0])
    ev["clock_seconds"] = ev["Clock"].apply(_clock_to_seconds)
    ev["game_seconds"] = (ev["Period"] - 1) * 1200 + (1200 - ev["clock_seconds"])
    home_team = ev["Home_Team"].iloc[0]
    ev["team_side"] = ev["Team"].apply(lambda t: "Home" if t == home_team else "Away")
    return ev


def _clock_to_seconds(clock_str) -> int:
    try:
        m, s = str(clock_str).split(":")
        return int(m) * 60 + int(s)
    except Exception:
        return 0


@st.cache_data
def build_enriched_tracking(_tracking: pd.DataFrame, _events: pd.DataFrame) -> pd.DataFrame:
    """Attaches possession team, puck-carrier jersey, and running score
    to every tracking row, using the most recent event at or before
    that moment in game time."""
    ev_sorted = _events.sort_values("game_seconds")[
        ["game_seconds", "team_side", "Event", "Player_Id", "Home_Team_Goals", "Away_Team_Goals"]
    ].rename(columns={"Player_Id": "puck_carrier_jersey"})
    ev_sorted["puck_carrier_jersey"] = ev_sorted["puck_carrier_jersey"].astype(str)
    trk_sorted = _tracking.sort_values("game_seconds")
    merged = pd.merge_asof(trk_sorted, ev_sorted, on="game_seconds", direction="backward")
    merged[["Home_Team_Goals", "Away_Team_Goals"]] = merged[["Home_Team_Goals", "Away_Team_Goals"]].fillna(0)
    return merged


# ---------- RINK SHAPES (Plotly layout.shapes) ----------
def rink_shapes():
    half_l, half_w = RINK_LENGTH / 2, RINK_WIDTH / 2
    ice = "#12213d"
    line_c = "#3d7fff"
    red_c = "#ff5c6c"
    shapes = [
        dict(type="rect", x0=-half_l, x1=half_l, y0=-half_w, y1=half_w,
             line=dict(color="#5c7cad", width=2), fillcolor=ice, layer="below"),
        dict(type="line", x0=0, x1=0, y0=-half_w + 1, y1=half_w - 1,
             line=dict(color=red_c, width=2)),
        dict(type="line", x0=-89, x1=-89, y0=-half_w + 1, y1=half_w - 1,
             line=dict(color=red_c, width=1.5)),
        dict(type="line", x0=89, x1=89, y0=-half_w + 1, y1=half_w - 1,
             line=dict(color=red_c, width=1.5)),
        dict(type="line", x0=-25, x1=-25, y0=-half_w + 1, y1=half_w - 1,
             line=dict(color=line_c, width=2.5)),
        dict(type="line", x0=25, x1=25, y0=-half_w + 1, y1=half_w - 1,
             line=dict(color=line_c, width=2.5)),
        dict(type="circle", x0=-15, x1=15, y0=-15, y1=15,
             line=dict(color=line_c, width=1.5)),
    ]
    for x in (-69, 69):
        for y in (22, -22):
            shapes.append(dict(type="circle", x0=x - 15, x1=x + 15, y0=y - 15, y1=y + 15,
                                line=dict(color=red_c, width=1.2)))
    for x, y0, y1 in [(-89, -6, 6), (89, -6, 6)]:
        shapes.append(dict(
            type="circle", x0=x - 6, x1=x + 6, y0=y0, y1=y1,
            line=dict(color=red_c, width=1), fillcolor="#1b3a63", layer="below"
        ))
    return shapes


# ---------- FRAME BUILDING ----------
TEAM_COLORS = {"Home": "#3d7fff", "Away": "#ff5c6c"}


def make_trace_data(frame_df: pd.DataFrame):
    """Builds the Plotly trace(s) representing one animation frame."""
    players = frame_df[frame_df["kind"] == "Player"]
    carrier_jersey = frame_df["puck_carrier_jersey"].iloc[0] if not frame_df.empty else None
    carrier_team = frame_df["team_side"].iloc[0] if not frame_df.empty else None

    traces = []
    for team in ("Home", "Away"):
        grp = players[players["team"] == team]
        line_colors = [
            "#ffd166" if (str(j) == str(carrier_jersey) and team == carrier_team) else "#0b1220"
            for j in grp["jersey"]
        ]
        line_widths = [
            4 if (str(j) == str(carrier_jersey) and team == carrier_team) else 1
            for j in grp["jersey"]
        ]
        traces.append(go.Scatter(
            x=grp["x"], y=grp["y"], mode="markers+text",
            marker=dict(size=22, color=TEAM_COLORS[team],
                        line=dict(color=line_colors, width=line_widths)),
            text=grp["jersey"], textposition="middle center",
            textfont=dict(size=9, color="white"),
            name=team, hoverinfo="skip",
        ))

    puck = frame_df[frame_df["kind"] == "Puck"]
    traces.append(go.Scatter(
        x=puck["x"], y=puck["y"], mode="markers",
        marker=dict(size=9, color="black", line=dict(color="white", width=1)),
        name="Puck", hoverinfo="skip",
    ))
    return traces


@st.cache_data(show_spinner="Building animation…")
def build_figure(_enriched: pd.DataFrame, period: int, step: int):
    """Builds the animated figure with a placeholder frame duration.
    Cached on (period, step) only — NOT on speed — so changing speed
    later doesn't trigger an expensive rebuild."""
    period_df = _enriched[_enriched["period"] == period]
    all_frame_ids = sorted(period_df["frame_id"].unique())
    sampled_ids = all_frame_ids[::step]
    placeholder_ms = 100  # overwritten instantly by apply_speed() below

    # Filter down to only the frames we're actually going to render FIRST,
    # then group once. Filtering inside the loop (one full-table scan per
    # frame) was the bug that made this take 10+ minutes.
    sampled_set = set(sampled_ids)
    subset = period_df[period_df["frame_id"].isin(sampled_set)]
    grouped = {fid: fdf for fid, fdf in subset.groupby("frame_id", sort=False)}
    empty_df = period_df.iloc[0:0]

    frames = []
    slider_steps = []
    first_traces = None
    first_annotation = None
    for i, fid in enumerate(sampled_ids):
        fdf = grouped.get(fid, empty_df)
        traces = make_trace_data(fdf)
        clock = fdf["clock"].iloc[0] if not fdf.empty else ""
        home_g = int(fdf["Home_Team_Goals"].iloc[0]) if not fdf.empty else 0
        away_g = int(fdf["Away_Team_Goals"].iloc[0]) if not fdf.empty else 0
        annotation = _live_annotation(clock, period, home_g, away_g)
        frame_name = str(i)
        frames.append(go.Frame(
            data=traces, name=frame_name,
            layout=go.Layout(annotations=[annotation]),
        ))
        if i == 0:
            first_traces = traces
            first_annotation = annotation
        slider_steps.append(dict(
            method="animate", label="",
            args=[[frame_name], dict(mode="immediate",
                                      frame=dict(duration=placeholder_ms, redraw=True),
                                      transition=dict(duration=0))]
        ))

    fig = go.Figure(
        data=first_traces,
        frames=frames,
        layout=go.Layout(
            shapes=rink_shapes(),
            xaxis=dict(range=[-105, 105], visible=False, fixedrange=True),
            yaxis=dict(range=[-48, 48], visible=False, fixedrange=True,
                       scaleanchor="x", scaleratio=1),
            plot_bgcolor="#0b1220", paper_bgcolor="#0b1220",
            font=dict(color="#e8edf7"),
            margin=dict(l=10, r=10, t=60, b=110),
            height=600,
            showlegend=True,
            legend=dict(orientation="h", yanchor="bottom", y=1.05, x=0.5, xanchor="center",
                        bgcolor="rgba(0,0,0,0)"),
            annotations=[first_annotation],
            updatemenus=[dict(
                type="buttons", direction="left",
                x=0.5, y=-0.32, xanchor="center", yanchor="top",
                pad=dict(t=10, r=10),
                showactive=False, bgcolor="#1e2b47", bordercolor="#3d7fff", font=dict(color="white", size=13),
                buttons=[
                    dict(label="Play", method="animate",
                         args=[None, dict(frame=dict(duration=placeholder_ms, redraw=True),
                                           fromcurrent=True, transition=dict(duration=0))]),
                    dict(label="Pause", method="animate",
                         args=[[None], dict(mode="immediate", frame=dict(duration=0, redraw=False),
                                             transition=dict(duration=0))]),
                ],
            )],
            sliders=[dict(
                active=0, x=0.05, y=-0.18, len=0.9, xanchor="left", yanchor="top",
                currentvalue=dict(visible=False),
                pad=dict(t=10, b=10),
                steps=slider_steps,
                bgcolor="#1e2b47", activebgcolor="#3d7fff",
            )],
        ),
    )
    return fig


def _live_annotation(clock, period, home_g, away_g):
    return dict(
        text=f"Period {period}   •   {clock}   •   Home {home_g} – Away {away_g}",
        x=0.5, y=1.10, xref="paper", yref="paper",
        showarrow=False, font=dict(size=15, color="#ffd166", family="Inter, sans-serif"),
    )


def apply_speed(fig: go.Figure, frame_ms: int) -> go.Figure:
    """Mutates the (already-built, cached) figure's frame duration in
    place — cheap, so switching speed never triggers a rebuild."""
    fig.layout.updatemenus[0].buttons[0].args[1]["frame"]["duration"] = frame_ms
    for step in fig.layout.sliders[0].steps:
        step.args[1]["frame"]["duration"] = frame_ms
    return fig


# ---------- APP ----------
tracking = load_tracking()
events = load_events()

if tracking.empty or events.empty:
    st.warning(
        "No data found. Put your Tracking_P*.csv and Events.csv files in a "
        "folder called 'data' next to this script."
    )
    st.stop()

enriched = build_enriched_tracking(tracking, events)
home_team_name = events["Home_Team"].iloc[0]
away_team_name = events["Away_Team"].iloc[0]
final_home_g = int(events["Home_Team_Goals"].iloc[-1])
final_away_g = int(events["Away_Team_Goals"].iloc[-1])

# --- Sidebar controls ---
st.sidebar.header("Controls")
period = st.sidebar.selectbox("Period", sorted(enriched["period"].unique()))

STEP = 5  # fixed smooth playback (~6 frames/sec) — no other option offered

speed = st.sidebar.radio("Speed", ["1x", "1.5x", "2x", "5x"], horizontal=True, index=0)
speed_map = {"1x": 1, "1.5x": 1.5, "2x": 2, "5x": 5}
base_duration_ms = (STEP / SOURCE_FPS) * 1000
frame_ms = max(10, int(base_duration_ms / speed_map[speed]))

# --- Final score panel (context — the live score during playback is shown
# above the rink itself, in sync with the animation) ---
st.markdown(f"""
<div class="scoreboard">
    <div class="team-block">
        <div class="team-name">{home_team_name}</div>
        <div class="team-score">{final_home_g}</div>
    </div>
    <div class="team-block" style="min-width:auto;">
        <div class="team-name">final</div>
        <div class="score-sep">—</div>
    </div>
    <div class="team-block">
        <div class="team-name">{away_team_name}</div>
        <div class="team-score">{final_away_g}</div>
    </div>
</div>
""", unsafe_allow_html=True)

fig = build_figure(enriched, period, STEP)
fig = apply_speed(fig, frame_ms)
st.plotly_chart(
    fig, use_container_width=True, config={"displayModeBar": False},
    key=f"rink_{period}_{STEP}",
)

st.caption(
    f"{home_team_name} vs {away_team_name} — gold ring marks the player on the puck. "
    "The score and clock above the rink update live as the animation plays."
)
