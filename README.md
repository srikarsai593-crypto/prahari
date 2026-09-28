<div align="center">

# ❄️ PRAHARI
### Antarctic Logistics & Safety Intelligence Platform

[![Next.js](https://img.shields.io/badge/Next.js-15-black?style=for-the-badge&logo=next.js)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?style=for-the-badge&logo=fastapi)](https://fastapi.tiangolo.com/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL_Mode-003B57?style=for-the-badge&logo=sqlite)](https://sqlite.org/)
[![SIH26062](https://img.shields.io/badge/SIH-26062-FF9900?style=for-the-badge&logo=hackaday)](https://sih.gov.in/)

*Built by **Team 36 OURS** for the extreme edge of the world.*

</div>

---

## 🧊 The Challenge: SIH26062

Antarctic research stations (Maitri, Bharati, Himadri) operate in the harshest
environment on Earth. Conventional logistics tooling assumes constant cloud
connectivity, reliable sensors and a single time zone. When a blizzard closes in
and the satellite uplink drops, the station is blind — and the data it does have
is scattered across five disconnected spreadsheets.

## 🛡️ The Solution

**Prahari** (Hindi: *sentinel*) is an offline-first station command console. It
unifies expedition planning, cargo tracking, inventory depletion, personnel
routing and emergency accountability behind **one shared event log**, so every
module reads the same truth.

### Engineering decisions worth defending

| Decision | Why |
|---|---|
| **Deterministic SQL for stock counts** | The LLM parses *intent*; it never produces a number anyone acts on. `/inventory/{station}/count` is a plain `SUM`, and it refuses to sum rows with mixed units rather than returning a plausible wrong figure. |
| **Honest AI degradation** | Every parse returns `parse_source` (`gemini` / `ollama` / `fallback`), and the UI shows which one ran. A demo must never claim "AI parsed this" when a regex did. |
| **Ordered audit log** | Events are ordered by an autoincrement `seq`, not by `created_at`. One user action emits several events inside the same second; sorting by time alone shows effects before causes. |
| **UTC everywhere, explicitly** | Every timestamp is ISO-8601 with a `Z`. SQLite's `CURRENT_TIMESTAMP` is naive and browsers parse it as *local* time, which silently shifts the whole timeline by the host's UTC offset. |
| **Per-station weather** | The blizzard ΔT is a row in `station_conditions`, not a process global. Cargo writes it, Inventory reads it, and it survives a restart. |
| **One active station, console-wide** | The station picker in the header is the single source of truth (`StationProvider`); every module scopes its queries to it. Personnel carry a `station`, so a berth check for Bharati no longer subtracts Maitri's headcount, and each module reports on the base the header names. |
| **Geographic incident scope** | Incidents carry coordinates, not a station column — an incident happens at a place. `/incidents?station=` filters by response radius rather than pretending the relationship is a foreign key. |
| **Cross-track deviation** | Route deviation is the perpendicular distance to the route's *segments*. Measuring to the nearest waypoint raises false alerts for anyone walking the authorised line between two distant waypoints. |
| **Level-H QR** | Cargo labels use 30% error correction so they still scan when frosted, torn or partly obscured. Images are generated per-label on request, not inlined into every list response. |
| **SQLite WAL** | `journal_mode=WAL` + `busy_timeout=5000` lets telemetry writes and dashboard reads proceed concurrently. |
| **Supply policy per item class** | Criticality is not one flat "< 15 days". A medical flight cannot land at Maitri mid-winter, so 20 days of pharmaceuticals is an emergency while 20 days of diesel is a normal interval between tanker runs. Each row is judged against its class (`app/routes/inventory.py: RISK_CLASS_POLICY`), and a station can override the floor per item. |
| **Burn rate follows the roster** | `base_burn_rate` is the rate at the station's nominal headcount; consumable and medical depletion is scaled by the crew actually on station. A traverse party arriving from Bharati moves the ration runway, which is exactly the figure that arrival should move. |
| **Alerts that outlive the tab** | A toast that vanishes in four seconds is not a record. Crossing a stock floor writes a standing `CRITICAL STOCK ALERT` to the audit log and clears it explicitly on recovery, so an operator who was on another page still finds it. |
| **Readiness is continuous, not a stored claim** | A feasibility score saved at planning time describes a moment that has passed. Any write that moves station conditions re-scores every open traverse (`app/cascade.py`), and the card reports the live figure beside the one it was approved against. |
| **Derived lateness, not a scheduler** | A consignment is overdue if the clock is past its ETA and nothing has been scanned in — computed on read. A station that is offline for days has no background job to catch up on, and the answer is never stale. |
| **No credential in the bundle** | The commander key is exchanged once for an httpOnly session cookie. It used to ship as `NEXT_PUBLIC_COMMANDER_KEY`, readable by anyone who opened devtools on the hosted console. Sessions are signed rather than stored, so a restart does not sign everyone out and there is no session table to leak. |
| **Enough fuel is not the same as sparable fuel** | Readiness asks both whether a traverse can be loaded *and* whether what is left behind outlasts it at the current burn rate. Weather does not take litres out of the tank — it raises the rate they leave it — so the first question alone is blind to the conditions a traverse would depart into. |
| **Alert state is a column, the log is history** | Whether a row is in alert is stored on the row. Deriving it by scanning the audit log meant the dashboard banner got slower every time anything was logged anywhere in the station. |
| **Station facts read once per scoring run** | The fuel row, the roster and the inbound cargo are identical for every traverse departing the same base, and re-scoring runs after every write that moves station conditions. |
| **The database outlives the container** | A hosted filesystem is ephemeral: a SQLite file inside the application directory is wiped by every deploy and every idle spin-down, and the console comes back on the bare seed. `PRAHARI_DB_PATH` puts it on a mounted disk, which is the difference between a station record and a scratchpad. |
| **An empty console says so** | The seed plants crew, stock and geofences but no consignments or incidents, because those are what an exercise creates. A dashboard of zeroes is indistinguishable from a backend that is down, so it says which it is and offers the one call that fills it. |
| **A measured burn rate beside the planned one** | `base_burn_rate` is what the station was *provisioned* to consume, and nothing had ever checked it against what the station actually used — while `days_of_cover` is built entirely on top of it. Every stock movement now lands in the audit log with a signed delta and a reason (`app/stock_ledger.py`), and the observed rate is derived from that. A station burning 40% more diesel than planned has a cover figure that is 40% optimistic, and nothing else on the page said so. |
| **What counts as consumption is narrow** | A stocktake correction is a measurement being put right; a transfer is stock moving house. Counting either would make the observed rate a record of paperwork. Only a recorded usage and fuel loaded onto a departing traverse are burn. |
| **Cold chain catches the failure before the breach** | A threshold tells you a vaccine was ruined; the rate of change tells you a compressor has stopped while the crate is still inside its band. Both are checked. An excursion counts up *on the row*, because the question on arrival is "was it ever out of band" and a crate that recovered reads as fine otherwise. |
| **Every temperature names its source** | Prahari has no sensors. A reading is either a gauge someone read or a logger that was downloaded, and the API requires `source` on every one. A console that could not tell the two apart would be presenting a typed figure as telemetry. |
| **Tamper-evident audit log** | Each entry is a SHA-256 over its own fields *and* the previous entry's hash, so an altered or deleted row breaks every link after it. `GET /events/verify` turns "every action is on the record" from an assurance into arithmetic a sceptic can check. It is evident, not proof — see the honesty matrix. |
| **Idempotency keys on replay** | The case the offline queue cannot detect on its own is a write the station received and acted on whose response never came back. Without a key, replaying it issues the stock twice. Each queue entry carries its own key for its whole life, so a retry is recognisable as the same intent. |
| **Five stages, not two** | `open` and `resolved` could not tell an incident nobody had seen apart from one with a snowcat already on the ice, which during a callout is the only difference that matters. Each stage is timestamped as it is entered, so a debrief can say how long acknowledgement and dispatch took. Committing an asset moves the stage by itself — a lifecycle nobody updates is a dropdown, not a record. |
| **Assets ranked on capability, not just distance** | Distance alone sent the nearest snowcat to a casualty while a helicopter with a medic sat eight minutes further out. Range is judged on the *round trip*, because the asset has to come back. Fuel is scored as reserve rather than tank level: there is nothing to choose between 82% and 100% for a two-kilometre callout. Every component of the score is returned, because a commander overruling a ranking mid-emergency needs to see what it weighed. |
| **Two roles, because there are two** | Commander/Logistics/Field would all currently resolve to "may write", and naming roles without enforcing them makes the console claim an access model it does not have. What genuinely differs is whether you can change the station's record, so that is what is modelled: an observer reads every module and writes nothing, and the role rides inside the signed session so it cannot be edited by its holder. |
| **An empty hosted station seeds itself** | A container comes up bare after every deploy, and a page of zeroes is indistinguishable from a backend that is down. `PRAHARI_SEED_DEMO_ON_BOOT` plants the season *only* when the station holds nothing, so it can never overwrite an operator's records — and it is off by default, because a real station's console must never invent them. |
| **A what-if is a question, not an event** | The console could not answer *if the ship slips ten days, does the traverse still go?* without making the change for real and undoing it — which puts a fiction in the audit log and in everyone else's console. `POST /inventory/what-if` scores the station twice, against the real snapshot and a modified copy, using `score_feasibility` and `compute_depletion` themselves. There is no second model to drift from the first, and it writes nothing: not the scenario, not the result, not an audit row. |
| **A projection says that it is one** | Every figure it returns is labelled, and the response carries the assumptions in the operator's own words. A number with no statement of what it took as given is a number nobody should act on, and an unlabelled projection gets read as a reading. |
| **Stockout risk resamples the station's own history** | Not a fitted curve and nothing learned from another station or season: the daily totals in this station's log, bootstrapped. Thirty days of cover at a steady rate and thirty at a rate that swings by four are different propositions, and `days_of_cover` cannot tell them apart. It refuses below five observed days rather than produce percentiles from three numbers, and the deterministic figure stays primary. |
| **Boundaries per panel, not per page** | A Leaflet tile error used to take the accountability head-count and the resolve button down with the map. During an incident that is the worst possible trade. |

---

## 🌌 The five modules

1. **🗺️ Expedition Planning** — Plain-language request → Gemini (→ Ollama → regex)
   → a readiness score weighted across crew, fuel, inbound cargo and berths.
   Every line item reports what is short and by how much.
2. **📦 Cargo Tracking** — QR-driven status chain
   (`dispatched → in_transit → arrived → unloaded`). Unloading replenishes the
   matching inventory item. Blizzard ΔT re-scores risk and pushes the ETA.
   Medical and food consignments carry a **temperature band** and are checked
   two ways: against the band, and against the rate they are moving — a reefer
   whose compressor has stopped is still inside its band for the first hour.
   Excursions are counted on the crate, so one that recovered still reports
   that it was out of band, and an excursion re-scores the station through the
   same cascade a delay does.
3. **🔋 Dynamic Inventory** — `days_of_cover = quantity / (base_burn_rate × crew_factor × (1 + β × ΔT))`,
   recomputed live against the station's blizzard load *and* the crew currently
   on station. The ΔT slider sits on the Inventory page itself, so the formula
   can be driven where its output is read. Stock is adjusted with a **text
   command** (`POST /inventory/command`, e.g. *"Removed 10 litres of diesel
   fuel"*): the command is parsed, previewed, and only written on confirm, always
   scoped to the console's active station. An ambiguous item comes back as
   clickable candidates rather than a dead-end error. `GET /inventory/cross-station`
   answers "does another base have this?" in one query. Every movement is
   recorded with a signed delta and a reason, which is what makes the
   **measured burn rate** — shown beside the planned one — a reading of the
   station's own record rather than a second guess.
4. **📍 Personnel Routing** — Sign in first: the roster carries live positions
   for everyone in the field and is not served anonymously. Authorise a
   movement plan on a **map**: click to
   place waypoints and steer the corridor around a crevasse field, with a live
   verdict on how many restricted zones the path still crosses. Then replay GPS
   fixes along it with a progress meter and a telemetry read-out — heading,
   ground speed, distance remaining and ETA, derived from the authorised
   schedule rather than from the console's tick rate.
5. **🚨 Emergency Accountability** — SOS or declared incident → head-count inside
   the affected radius + nearest assets by Haversine distance. Only `at_station`
   and `returned` count as verified safe, and an incident **cannot be resolved**
   while anyone is unaccounted for. Each incident type carries a **response
   protocol** whose steps are ticked off and timestamped into the audit log,
   rescue assets are **dispatched and released** from the same panel, and both
   severity and perimeter can be changed on a live incident — widening the
   radius re-runs the head-count against the new circle instead of forcing a
   resolve-and-redeclare that discards the count. A response moves through
   **five stages** — declared, acknowledged, responding, contained, resolved —
   each timestamped as it is entered, and committing an asset advances the
   stage by itself. Assets are ranked on **capability**: distance, fuel in
   reserve, whether the round trip is within range, and whether a medic is
   aboard, with every component of the score shown.

### The cross-module chain

The modules are wired to each other, not merely to the database. A blizzard ΔT
re-scores cargo risk and pushes ETAs; delayed consignments and depleted stock
re-score every open traverse; a traverse that falls below what it was approved
against raises a `FEASIBILITY DEGRADED` alarm *and* offers the inbound
consignment that would close the gap, with the hours to wait. The whole chain
announces itself once as a `SUPPLY CHAIN CASCADE` event and a dashboard banner.
`app/cascade.py` owns the fan-out; it is a separate module because the routers
already import one another and putting it in any of them closes a cycle.

---

## 🚀 Deploying

The backend is closed by default and will not start unprotected, so a first
deploy needs four values. Render prompts for each on a blueprint sync.

**Render** (backend):

| Variable | Value |
|---|---|
| `PRAHARI_API_KEY` | Any long random string. `python -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `PRAHARI_CORS_ORIGINS` | The console's own URL, e.g. `https://prahari.vercel.app` |
| `PRAHARI_CORS_PROJECT` | Your Vercel project name, e.g. `prahari` — only needed if preview deployments should work too |
| `PRAHARI_ALLOW_DEMO_KEY` | `false` (already set in the blueprint) |

The blueprint also sets `healthCheckPath: /health`, which is what Render polls
to decide a deploy came up — and polling it keeps the instance from sleeping,
so nobody's first visit is a cold start. It sets `PRAHARI_ALLOW_OBSERVER` and
`PRAHARI_SEED_DEMO_ON_BOOT` too, so a hosted console opens on a populated
station that a visitor can actually look at. **Unset both for a real
deployment.**

The blueprint also asks for a **1 GB disk at `/var/data`**, with
`PRAHARI_DB_PATH=/var/data/prahari.db`. This is the difference between a
station that remembers what it was told and one that forgets on every deploy.
A disk needs a paid instance type; to stay on the free tier, delete the `plan`
and `disk` blocks and `PRAHARI_DB_PATH` from `render.yaml` and accept that the
record resets on restart — `POST /admin/demo-season` puts a populated season
back in one call.

**Vercel** (console): `NEXT_PUBLIC_COMMANDER_KEY` is **no longer used** — the
console holds no credential. Nothing needs to be set there beyond the backend
URL your `next.config.ts` rewrites point at.

Check `/health` afterwards: it reports whether a real key is configured and
whether reads are public, so the posture can be confirmed from outside rather
than remembered.

---

## ⚡ Quick start

**Requirements:** Python 3.11+ and Node 20+.

### 1. Configure

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Set `PRAHARI_API_KEY` in `backend/.env` — that is the key you sign in with.
The console holds no credential of its own, so `frontend/.env.local` only
matters if the backend is not on `localhost:8000`. `GEMINI_API_KEY` is
optional: without it the chain falls back to Ollama, then to regex, and the UI
says which one ran.

### 2. Backend

```bash
cd backend && pip install -r requirements.txt && python -m uvicorn app.main:app --reload --port 8000
```

On boot it prints which LLM path is live. Interactive API docs: <http://localhost:8000/docs>

### 3. Frontend

```bash
cd frontend && npm install && npm run dev
```

**Fonts:** Inter (interface) and JetBrains Mono (coordinates, IDs, timestamps
and every telemetry figure) are fetched and self-hosted by `next/font` at build
time, so a running console makes no font request to a CDN — which matters when
the station link drops. Nothing to install.

### 4. Put something on it

A freshly seeded station has crew, stock and geofences but nothing in flight,
so Cargo and Emergency open empty. **Load demo season** — on the dashboard
while the station is idle, and always on `/scenario` — plants a mid-season
picture across all three bases: consignments part-way along their run, one
convoy already overdue, a crewed traverse short on fuel at Maitri, and a closed
incident on the record. It restores the baseline first, so it is safe to click
twice, and it announces itself in the audit log as synthetic.

```bash
curl -X POST localhost:8000/admin/demo-season -H 'X-Commander-Key: <your key>'
```

### 5. The guided demo

Open <http://localhost:3000/scenario> — a ten-step walkthrough that exercises all
five modules end to end, including a geofence violation and an offline
queue-and-flush cycle.

---

## 👁 Observer access

A station that is closed by default is the right posture and the wrong first
impression: anyone handed the link meets a key prompt and a console correctly
refusing to show them anything.

`PRAHARI_ALLOW_OBSERVER=true` adds an **Enter as observer** button to the
sign-in screen. It issues a real, expiring, signed session that can read every
module and write nothing — a refused write comes back `403` with a sentence
saying why, and the navigation band carries a standing **READ ONLY** badge so
nobody discovers the limit only when a control refuses them.

It is deliberately *not* the same switch as `PRAHARI_PUBLIC_READS`. That one
serves reads to anyone who knows the URL with no session at all; this one
issues a session the audit log can attribute. Both are off by default, because
the roster carries live positions for people in the field and whether that is
shareable is a decision for whoever runs the station.

The role lives inside the signed session payload, so an observer cannot
promote themselves by editing a cookie, and the `X-Commander-Key` header
always outranks a browser session — a script is never downgraded by whatever
the browser last did.

---

## 🔮 Asking "what if"

`POST /inventory/what-if?station=Maitri` scores the station as it stands and
as a scenario would leave it, side by side. Four levers, all optional:

| Field | Means |
|---|---|
| `extra_crew` | People arriving or leaving. Negative is a party departing. |
| `delta_t` | Blizzard load, absolute — it is the one an operator thinks of as a value rather than a change. |
| `cargo_delay_hours` | Slip every inbound consignment. A ship that is late is still inbound; it just arrives later. |
| `advance_days` | Burn this many days of stock at the projected rate first, so "in a fortnight, with six more people" is one question. |

```bash
curl -X POST 'localhost:8000/inventory/what-if?station=Maitri' \
  -H 'Content-Type: application/json' -H "X-Commander-Key: $KEY" \
  -d '{"extra_crew": 6, "advance_days": 7}'
```

It writes nothing — not the scenario, not the result, not an audit row — and
it is gated as a read, because thinking before committing should not need
write credentials. The Inventory page carries it with three one-click
presets.

The figures come from `score_feasibility` and `compute_depletion`, the same
functions the live console uses, handed a snapshot with the scenario applied.
`test_projection` pins the consequence: a projected blizzard reaches the same
days-of-cover figure as applying one for real. If those two ever disagree,
there are two models and one of them is wrong.

---

## 🎲 Stockout risk

`days_of_cover` answers "at today's rate". `GET /inventory/stockout-risk`
answers "given how this station has actually consumed it" — the soonest
realistic day it runs out and the most likely one, with
`?until_days=30` answering the question an operator really has: *does it
reach the next tanker window?*

The distribution is the station's own daily totals, resampled. No curve is
fitted, nothing is assumed about the shape, and nothing is learned from
another station or another season. Below five observed days of consumption
it reports nothing at all — percentiles from three numbers look exactly as
authoritative as percentiles from thirty, which is the failure worth
avoiding. The deterministic figure stays primary and is never replaced.

---

## 🔍 What is measured, and what is not

Prahari runs on a laptop with no sensor network attached. Everything below is
either something the station recorded, something Prahari worked out from what
it recorded, or a figure that stands in for hardware that is not there. The
distinction matters more than any single feature: a console that cannot tell
you which is which is one you cannot act on.

| Fact on screen | Where it comes from | Honest? |
|---|---|---|
| Station coordinates | Published NCPOR positions, hard-coded and matching the geofence table | **Real** |
| Distances, bearings, route deviation | Computed by great-circle maths from those coordinates | **Derived** — real arithmetic on real positions |
| Daylight state, seasonal normals | Solar declination from the station's own latitude (Cooper's equation) and published climatological normals | **Derived / reference** — never presented as a thermometer reading |
| Stock quantities | What an operator recorded, plus what unloading a consignment added | **Real** — entered, not sensed |
| Days of cover | `quantity / (burn rate × crew factor × weather factor)` | **Derived** |
| Planned burn rate | A configured constant per item | **Assumption** — the console now says so by showing the measured rate beside it |
| A what-if projection | The live formulas run against a modified copy of the station | **Derived, and labelled** — the response says `is_projection` and lists its assumptions; nothing is written |
| Stockout range (P10–P50) | Bootstrap resample of this station's own recorded daily consumption | **Derived from real records**, withheld entirely below five observed days |
| Measured burn rate | Derived from consumption movements in the audit log | **Derived from real records**, and withheld entirely until there is enough history to divide by |
| Crew positions | Seeded, then advanced by the GPS playback | **Simulated** — no GPS hardware exists; the movement is a replay of an authorised route |
| Blizzard ΔT | Typed by an operator on the slider | **Simulated input** — Prahari has no meteorological feed, and the header shows ΔT rather than inventing an air temperature |
| Cargo temperature | Typed by an operator, or entered from a handheld logger read-out | **Recorded** — `source` is stored and shown on every reading; there is no live probe |
| Cargo risk score | Weather ΔT and priority | **Derived** from a simulated input |
| Consignment ETA | Nominal fourteen-day sea leg, pushed by weather | **Modelled** — there is no vessel tracking |
| Overdue detection | The clock against the stored ETA | **Derived** — real time, modelled ETA |
| Beacon ping | Records that the station *asked*, and returns the last facts it holds | **Honest stub** — the response says outright that there is no satellite link |
| Asset fuel, range, seats, medic | Seeded capability figures per asset | **Reference data** — not telemetry from the vehicles |
| Head-counts and accountability | Personnel status, which an operator sets | **Real** — as accurate as the last check-in |
| Audit chain | SHA-256 over each entry and the one before it | **Real, and tamper-*evident*** — a writer with database access could recompute the whole chain. Not tamper-proof, and `/events/verify` says so in its own response |
| Every expedition parse | Gemini, else Ollama, else regex — `parse_source` names which ran | **Real**, and the UI never claims AI when a regex did the work |
| The demonstration season | Synthetic records planted by `/admin/demo-season`, or on boot where `PRAHARI_SEED_DEMO_ON_BOOT` is set and the station is empty | **Synthetic**, and the audit log says so in the entry that creates it |

What Prahari does **not** have, and does not pretend to: a satellite link, a
meteorological feed, GPS hardware, temperature probes, vehicle telemetry, or a
directory of real emergency contacts.

---

## 🧯 Drills

Two switches exist so the failure paths can be exercised without waiting for a
real failure, and both are honest about what they are:

* **Overdue convoy** — a consignment's *Due in (hours)* field accepts a negative
  value, which backdates the ETA. At the nominal fourteen-day sea leg nothing is
  ever overdue inside a demo, so there would otherwise be no way to see the
  stalled-convoy path at all.
* **Beacon ping** — `POST /shipments/{id}/beacon-ping` records that the station
  requested a position report and returns the last facts it holds. Prahari has no
  satellite link and the response says so; the value is the audit entry, which is
  where a real convoy search would start.

---

## 🔐 Security model

A **station console with one shared operator credential**, not a multi-tenant
service. Within that shape, it is now closed by default.

- The commander key is exchanged once at `POST /auth/login` for an **httpOnly
  session cookie**. The key never enters the JavaScript bundle. It previously
  shipped as `NEXT_PUBLIC_COMMANDER_KEY`, which meant anyone who opened
  devtools on the hosted console could read the credential that authorises
  every write.
- **Reads are gated too.** The roster carries live positions for everyone on
  the ice; that is not something to serve to whoever knows the URL. The
  telemetry socket is gated the same way, since it carries the same data.
  `PRAHARI_PUBLIC_READS=true` opens reads for a kiosk or a public demo.
- **`X-Commander-Key` still works** for scripts, the barcode scanner and the
  test suite. A machine caller has nowhere to keep a cookie and no sign-in
  screen to fill in.
- **Sign-in is rate limited** (5 failures/minute/IP). The key is a single
  shared secret, so without a limit it is brute-forceable at network speed.
  Writes are limited an order of magnitude higher, against a runaway client.
  Reads are never throttled — an operator refreshing during an incident is the
  behaviour this console exists to serve.
- Sessions are **signed, not stored**: HMAC over a server secret, so a restart
  does not sign everyone out and there is no session table to leak. With no
  explicit `PRAHARI_SESSION_SECRET` the secret derives from the commander key,
  so **rotating the key invalidates every live session** — which is what an
  operator expects rotation to mean.
- The console sets a **Content-Security-Policy**, `X-Frame-Options: DENY`,
  `nosniff` and a `Permissions-Policy` denying geolocation, camera and
  microphone. Authenticated API responses are `no-store, private`, so the next
  operator through a shared proxy is not served the last one's roster.

- **Work done offline replays exactly once.** Each queued mutation carries an
  `Idempotency-Key` for the life of that entry, so the write the station
  received and acted on — but whose response never came back — is recognised
  on retry rather than applied twice. The key is scoped to the method and
  path; a key reused on another endpoint is refused rather than answered from
  the wrong record.
- **The console survives a reload during an outage.** A service worker caches
  the application shell, the build assets and the map tiles, so a refresh with
  the link down gets the console rather than a browser error page and the map
  keeps its tiles instead of going blank. The API is never cached: stock
  levels, positions and accountability counts are precisely the figures an
  operator must not be shown a stale copy of.
- **The queue follows the browser, not only the operator.** `navigator.onLine`
  going false arms it immediately, so the first write after a real outage is
  no longer spent discovering it. Coming back only triggers a drain — an
  interface being up says nothing about whether the station is reachable, and
  the drain is what proves it. A deliberate blackout is never lifted this way.

**What it is still not.** One credential means one identity: the audit log can
say *what* a commander did and not *which* commander. Per-user accounts are the
next step, and nothing above is a substitute for them.

### Settings that decide whether a hosted deployment is actually protected

| Variable | What happens if you leave it |
|---|---|
| `PRAHARI_API_KEY` | Unset, with `PRAHARI_ALLOW_DEMO_KEY=true`, every write accepts `prahari-demo-2026` — a key published in this README. Set it. (`PRAHARI_COMMANDER_KEY` is read as an alias, because the Render blueprint used that name and a key read under the wrong name protects nothing.) |
| `PRAHARI_ALLOW_DEMO_KEY` | Defaults to `true`, right for `npm run dev` and wrong for anything with a public hostname. The blueprint sets `false`, so a hosted backend with no key **refuses to boot** rather than coming up open. |
| `PRAHARI_PUBLIC_READS` | Defaults to `false`. Setting it serves the roster, with live field positions, to anyone who knows the URL. |
| `PRAHARI_ALLOW_OBSERVER` | Defaults to `false`. Setting it lets anyone with the link take a read-only session — they see the roster, but every write is refused and the session is attributable. Prefer this to `PRAHARI_PUBLIC_READS` for a demo. |
| `PRAHARI_SEED_DEMO_ON_BOOT` | Defaults to `false`. Setting it plants the demonstration season when the station comes up holding nothing. Leave it unset on a real station: a console that invents records is worse than an empty one. |
| `PRAHARI_SESSION_SECRET` | Optional. Without it the secret derives from the commander key, which ties session lifetime to key rotation. Set it if you want sessions to survive a rotation. |
| `PRAHARI_SESSION_TTL_SECONDS` | How long a session lasts. Defaults to 12 hours. |
| `PRAHARI_INSECURE_COOKIES` | Drops the `Secure` flag from the session cookie. **Only** for a local console on plain HTTP with no TLS-terminating proxy in front — setting it on anything public sends the session in the clear. |
| `PRAHARI_LOG_LEVEL` | Defaults to `INFO`. |
| `PRAHARI_DB_PATH` | Defaults to the application directory, which a hosted deploy replaces wholesale — every restart loses the station's whole operational record. Point it at a mounted disk. |
| `PRAHARI_CORS_ORIGINS` | Defaults to localhost only, so a hosted console is refused by the browser until this names it. Set it to the console's own URL. |
| `PRAHARI_CORS_PROJECT` | Your Vercel project name. Also admits that project's *preview* deployments, whose hostnames change per branch and so cannot be listed exactly. Scoped to your project alone. |
| `PRAHARI_CORS_ORIGIN_REGEX` | Escape hatch for a console that is not on Vercel. Overrides the project pattern. |

The backend logs a warning at boot for each of these still on its permissive
default, and `/health` reports the posture, so it can be checked from outside
rather than remembered.

---

## 🧪 Tests

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

```bash
cd frontend
npm install
npm test                 # 186 tests
npm run test:coverage    # with the floor enforced
```

**699 backend tests (~6 s) and 186 frontend tests (~3 s).** No network, no
shared state and no ambient credentials: each backend test gets its own
throwaway SQLite file, the environment is cleared so a developer's own
`backend/.env` cannot change the result, and the LLM chain is stubbed so every
parse falls through to the deterministic regex rules. A test that reached
Gemini would be slow, cost money, need a key, and — worst of all — give a
different answer on a different day.

Both suites, plus the typecheck and the production build, run on every push
and every pull request (`.github/workflows/ci.yml`).

What they cover, and why these things in particular:

| Area | What is pinned |
|---|---|
| `test_geo` | Great-circle distance, spherical bearing, cross-track deviation. The place where a plausible-looking wrong answer is most dangerous, because every alarm and heading is built on it. |
| `test_simulation` | Track densification, the playback cursor, and telemetry derived from the authorised schedule rather than the console's tick rate. |
| `test_inventory` | The depletion formula, the per-class supply policy matrix, headcount scaling, standing alerts and the cross-station lookup. |
| `test_personnel` | The status state machine, pre-flight geofence checks, GPS playback and accountability. |
| `test_incidents` | Head-counts, response protocols, asset dispatch, live severity and perimeter changes. |
| `test_expeditions` | Readiness scoring, crew commitment, the fuel ledger and the resupply recommender. |
| `test_shipments` | The scan chain, unit-safe restock, weather risk and overdue convoy detection. |
| `test_cascade` | The cross-module chain — that a write anywhere reaches the module counting on it, and that the alarm announces a crossing rather than a state. |
| `test_platform` | Credentials, CORS, audit-log ordering, reset hygiene, and where the database file is allowed to live. |
| `test_audit_chain` | That each entry commits to the one before it, that an edited, deleted or inserted row is caught, and that the endpoint states what it does *not* promise. |
| `test_burn_rate` | What counts as consumption and what does not, and the two ways the measured rate refuses to guess — too few movements, too little elapsed time. |
| `test_coldchain` | Band breaches in both directions, rate of change catching a failure before the breach, and that a crate which recovered still reports its excursion. |
| `test_idempotency` | That a replayed write lands once, that two identical writes without keys both land, and that a refusal is not remembered. |
| `test_observer` | That a read-only session reads everything, writes nothing, cannot promote itself by editing its cookie, and can still sign out. |
| `test_incident_lifecycle` | The stages, that a response cannot roll backwards, that dispatch advances it, and that the head-count rule survives having five stages instead of two. |
| `test_asset_ranking` | Each factor in the score, the round-trip range check, and that the ranking follows the incident type. |
| `test_projection` | That a what-if writes nothing, and that a projected blizzard reaches the same figure as applying one for real — the check that there is one set of formulas rather than two. |
| `test_forecast` | What counts as a day of consumption, the refusal below five of them, and that the same station state forecasts the same way every time. |
| `test_demo` | The demonstration season: that it reaches every station, is made of real records, does not stack on a second run, leaves the store at its seeded figures, and says it is synthetic. |
| `test_models` | The bounds that make a malformed LLM parse degrade to rules instead of being believed. |
| `test_session` | Signed sessions, the sign-in rate limit, the read gate and the security headers. |
| `test_performance` | Queries per request, not wall-clock: the shapes that were linear in the data and invisible at seed size. |
| `geo.test.ts` | The console's own hazard check, and that it agrees with the backend to the metre. |
| `offlineQueue.test.ts` | Work recorded during an outage: that it survives, replays in order, and is not discarded when a session lapses. |
| `SessionProvider.test.tsx` | The sign-in gate, and that the key is never retained after it is used. |
| `DemoSeasonButton.test.tsx` | That the season cannot be loaded by accident, and reports what it planted. |
| `WhatIfPanel.test.tsx` | That the result is labelled a projection, states its assumptions, hides rows the scenario did not move, and shows no stale answer when the link is down. |
| `ColdChainCell.test.tsx` | That a recovered crate still shows its excursion, that a typed reading is recorded as manual, and that unmonitored cargo renders nothing. |
| `serviceWorker.test.ts` | That the cache never installs in front of the dev server, and that a console whose cache will not install still boots. |
| `useInventory.test.tsx` | The stock-command preview, including that a queued command is never offered as one to confirm. |

The suite is checked against deliberate regressions rather than trusted on its
line count. Seventy known bugs — a flat criticality rule, bearing by the
flat approximation, deviation measured to waypoints, an incident closable over
a missing person, an unverified session signature, a database back inside the
container, an audit chain that no longer links, a stocktake counted as
consumption, a cold chain that only checks the threshold, a replayed write
applied twice, assets ranked by distance alone — are reintroduced one at a
time and the suite must fail on each:

```bash
cd backend
python -m tests.mutations          # all of them
python -m tests.mutations geo      # just the ones touching geo
python -m tests.mutations --list
```

A mutation that survives is a test that does not really exist. Three survived
the first run and all three were gaps in the tests rather than in the code;
three more surfaced when this batch was added, one of which was a genuine bug
— a query listing the five stage names by hand, which counted an incident
still holding the legacy `open` value as closed.
CI runs it weekly rather than per-commit: it runs the whole suite once per
mutation, so it costs roughly seventy times a normal run.

---

## 🧪 Verifying a change

```bash
cd backend && pytest
```

```bash
cd frontend && npm run typecheck && npm test && npm run build
```

The build is the real frontend gate: `tsc --noEmit` does not catch a server
component importing a browser-only module, which only fails at prerender.

---

## 🛠️ Troubleshooting

- **`npm install` fails with a peer-dependency conflict** — you are on an old
  `package.json` that pinned Next canary against a mismatched React RC. Pull the
  current one; it pins stable releases.
- **`pip install` fails building `pydantic-core` / `Pillow`** — the old pins had
  no wheels for Python 3.13+. The current `requirements.txt` uses ranges that do.
- **Every parse says `fallback`** — check the boot log. A pinned Gemini point
  version (e.g. `gemini-1.5-flash`) returns 404 once Google retires it; the
  default `gemini-flash-lite-latest` is a floating alias that does not expire.
- **404 on `/movement-plans` or `/power-failure`** — static routes must be
  declared before `/{id}` routes in FastAPI.
- **Windows `zbar` ImportError when scanning** — install the Visual C++
  Redistributable, or use the manual barcode entry field.

---
<div align="center">
  <i>"In Antarctica, logistics isn't a spreadsheet. It's survival."</i><br>
  <b>— Team 36 OURS</b>
</div>
