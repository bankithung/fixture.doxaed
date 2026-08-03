# OBS broadcast scoreboard overlay — operator guide

One URL per court. Paste it into an OBS **Browser Source** once at the start of
the tournament and never touch it again. The overlay follows whatever match is
live on that court by itself: it shows the scorebug while a match is on, the
result when one finishes, what is up next, and the court name when the court is
empty. There is nothing to click and nothing to refresh.

---

## 1. The URL

```
https://fixture.doxaed.com/overlay/t/<slug>/<tournament-id>/court/<court>
```

- `<slug>` / `<tournament-id>` — the same pair as any public tournament link.
  Copy them out of the public schedule URL: `/t/nagaland-schools-cup/9f1c…/schedule`.
- `<court>` — the **venue string exactly as it appears on the fixture**,
  URL-encoded. `Court2 · T3` becomes `Court2%20%C2%B7%20T3`.
  Leading/trailing spaces and letter case do not matter; anything else must match.

### Query options

| Option | Values | Default | What it does |
|---|---|---|---|
| `?scale=` | `0.4`–`4` | `1` | Multiplies the whole graphic. Geometry is authored for a **1920×1080** canvas — for a 1280×720 canvas use `?scale=0.667`. |
| `?side=` | `left`, `right` | see note | Anchor corner. Court sports default to **top-left**; football defaults to **top-centre** (a centred clock is the broadcast convention). Setting `side` overrides both. |
| `?server=` | `home`, `away` | `home` | Which side served first. Only affects table tennis and sepak takraw (see §6). |

Options combine: `…/court/Court%201?scale=0.667&side=right`.

---

## 2. Browser Source settings

In OBS: **Sources → + → Browser → Create new**, name it `Overlay — Court 1`.

| Field | Value |
|---|---|
| URL | the court URL from §1 |
| Width | **1920** |
| Height | **1080** |
| Use custom frame rate (`fps_custom`) | **OFF** — let it follow the canvas |
| Custom CSS | `body { background: transparent; margin: 0; overflow: hidden; }` |
| Shutdown source when not visible | **OFF** (this is the default — leave it) |
| Refresh browser when scene becomes active | **OFF** (this is the default — leave it) |
| Control audio via OBS | OFF |

Then **right-click the source → Transform → Fit to screen** only if your canvas
is not 1920×1080. Do **not** resize the source rectangle by dragging: scaling a
browser source visibly softens thin type and hairlines. Set the source to
exactly 1920×1080 and use `?scale=` instead if you need a different size.

Notes:

- A Browser Source is already transparent (`body { background-color: rgba(0,0,0,0) }`
  is built in), and the page removes the app's own background as well. The custom
  CSS above is belt-and-braces and harmless.
- **Leave "Refresh browser when scene becomes active" OFF.** Turning it on
  reloads the page every time you cut to that scene, which throws away the
  overlay's live state mid-rally.
- **Leave "Shutdown source when not visible" OFF** so the overlay stays
  connected and is already correct the moment you cut to it.
- Put the overlay **above** the camera source in the scene's source list, or it
  will be hidden behind the video.

---

## 3. One line per court — a 6-court event

Replace `SLUG` and `TID`, and use each court's real venue string.

| Court | Browser Source URL |
|---|---|
| Court 1 | `https://fixture.doxaed.com/overlay/t/SLUG/TID/court/Court%201` |
| Court 2 | `https://fixture.doxaed.com/overlay/t/SLUG/TID/court/Court%202` |
| Court 3 | `https://fixture.doxaed.com/overlay/t/SLUG/TID/court/Court%203` |
| Court 4 | `https://fixture.doxaed.com/overlay/t/SLUG/TID/court/Court%204` |
| Court 5 | `https://fixture.doxaed.com/overlay/t/SLUG/TID/court/Court%205` |
| Court 6 | `https://fixture.doxaed.com/overlay/t/SLUG/TID/court/Court%206` |

Common encodings: space `%20`, `·` `%C2%B7`, `&` `%26`.
A venue containing a **slash** (`Hall A / B`) cannot be addressed — rename the
venue in the fixture instead.

---

## 4. What you will see

| Board | When |
|---|---|
| **Court name + tournament** | Nothing scheduled or live on this court. |
| **UP NEXT** + both teams + kickoff time | A match is scheduled here next. |
| **Scorebug** | A match is live. |
| **"Game N complete"** | A game/set just ended and the match continues. |
| **FINAL / WALKOVER** | A match just finished. Holds ~60 s, then moves on. |
| **Scorebug with an amber dot** | The feed is more than 20 s old (see §5). |

Court sports show: team names, the running game score large, the games/sets
each side has won, every completed game, and a serve dot. Football shows: team
codes, goals, the period, and a running match clock.

A yellow pill under the panel appears for **MATCH POINT**, **GAME/SET POINT**,
**SETTING UP TO 17** (or whatever the rules cap at) and **CHANGE ENDS**. All of
these are computed from the match's own scoring rules — the overlay never
guesses one.

---

## 5. Live / no dot / amber dot

The dot in the header tells you how current the numbers are:

- **Red dot** — connected, live, updating in real time.
- **No dot** — the update stream dropped but the score is still recent. The
  score stays on screen; the overlay simply stops claiming to be live.
- **Amber dot** — nothing has been confirmed for more than 20 seconds. The last
  known score stays on screen.

The overlay **never blanks and never falls back to 0-0**, because a blank
scorebug reads to viewers as a broken stream. If the backend restarts (a
deploy) or the venue link drops, the bug holds its last score, goes amber, and
repairs itself automatically within seconds of the connection returning — no
refresh needed.

---

## 6. Serve indicator

- **Table tennis** and **sepak takraw** — service rotates by points played, so
  the overlay derives it exactly from the score and the tournament's rules.
  It assumes the **home** side served first; if the toss went the other way add
  `?server=away` to that court's URL.
- **Badminton** and **volleyball** — service goes to whoever won the last rally,
  which cannot be read from a score alone. The overlay watches the score change
  and shows the dot from the first point it can attribute. After a restart, a
  new game, or a gap in the feed it **hides the dot** until it can attribute a
  point again. That is deliberate: a wrong serve arrow on a live broadcast is
  worse than no arrow.

---

## 7. Troubleshooting

**The overlay is blank**

1. Is the source **above** the camera in the scene list? Move it to the top.
2. Open the URL in a normal browser. If the page is blank there too, the slug
   or tournament id is wrong — re-copy them from the public schedule URL.
3. If the browser shows the court name but OBS shows nothing, right-click the
   source → **Refresh cache of current page**.
4. Check the source is 1920×1080 and not 0×0 (this happens if the width/height
   fields were cleared).

**The score is frozen / the dot is amber**

1. Amber means the venue's internet dropped or the backend restarted. It fixes
   itself — do **not** refresh; the overlay reconnects on its own with a short
   backoff and will repaint as soon as the connection returns.
2. If it stays amber for more than a minute, check the venue's network.
3. If other courts are fine and this one is amber, the scorer's device for this
   court has probably stopped sending — check with the court's scorer, not the
   overlay.
4. Confirm the match is actually `live` on the control room board. A match still
   in `scheduled` shows UP NEXT, not a score, however loud the court is.

**Wrong court / wrong match**

1. The `court` in the URL must match the fixture's **venue** string. Open the
   public schedule and copy the venue text exactly, then URL-encode it.
2. If the match was moved to another court, the fixture's venue has to be
   updated in the control room — the overlay follows the fixture, not the room.
3. If two matches are live on one court (an ops mistake), the overlay shows the
   earlier-scheduled one. Fix the duplicate in the control room.

**Serve dot is on the wrong side** (table tennis / sepak takraw only)

Add `?server=away` to that court's URL and refresh the source once. See §6.

**Team name is truncated**

Names are drawn from the team's short name when it is set, otherwise the full
name, ellipsised to fit. Set a proper short name on the team to control what
goes on air.

---

## 8. Deployment note (for whoever configures nginx)

The overlay page carries `<meta name="referrer" content="no-referrer">` and
`<meta name="robots" content="noindex, nofollow">` itself. Serving these
response headers for `/overlay/` as well is recommended:

```nginx
location ^~ /overlay/ {
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Cache-Control "no-store" always;
    try_files $uri /index.html;
}
```

The overlay reads only the existing public endpoints (`…/schedule/` and
`/api/live/match/<id>/`), so it needs no auth and no new backend surface.
