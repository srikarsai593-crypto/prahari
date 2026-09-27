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

---

## 🌌 The five modules

1. **🗺️ Expedition Planning** — Plain-language request → Gemini (→ Ollama → regex)
   → a readiness score weighted across crew, fuel, inbound cargo and berths.
   Every line item reports what is short and by how much.
2. **📦 Cargo Tracking** — QR-driven status chain
   (`dispatched → in_transit → arrived → unloaded`). Unloading replenishes the
   matching inventory item. Blizzard ΔT re-scores risk and pushes the ETA.
3. **🔋 Dynamic Inventory** — `days_of_cover = quantity / (base_burn_rate × crew_factor × (1 + β × ΔT))`,
   recomputed live against the station's blizzard load *and* the crew currently
   on station. The ΔT slider sits on the Inventory page itself, so the formula
   can be driven where its output is read. Stock is adjusted with a **text
   command** (`POST /inventory/command`, e.g. *"Removed 10 litres of diesel
   fuel"*): the command is parsed, previewed, and only written on confirm, always
   scoped to the console's active station. An ambiguous item comes back as
   clickable candidates rather than a dead-end error. `GET /inventory/cross-station`
   answers "does another base have this?" in one query.
4. **📍 Personnel Routing** — Authorise a movement plan on a **map**: click to
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
   resolve-and-redeclare that discards the count.

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

## ⚡ Quick start

**Requirements:** Python 3.11+ and Node 20+.

### 1. Configure

```bash
cp backend/.env.example backend/.env
cp frontend/.env.local.example frontend/.env.local
```

Set `PRAHARI_API_KEY` in `backend/.env` and the **same value** as
`NEXT_PUBLIC_COMMANDER_KEY` in `frontend/.env.local`. `GEMINI_API_KEY` is
optional — without it the chain falls back to Ollama, then to regex, and the UI
says so.

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

### 4. The guided demo

Open <http://localhost:3000/scenario> — a ten-step walkthrough that exercises all
five modules end to end, including a geofence violation and an offline
queue-and-flush cycle.

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

## 🔐 Security model — read before deploying

This is a **single-trust-boundary station console**, not a multi-tenant service.

- Every write endpoint requires the `X-Commander-Key` header. Reads are open.
- `NEXT_PUBLIC_COMMANDER_KEY` is **visible in the browser bundle**. That is
  acceptable only because the backend is meant to sit on the station's own LAN.
- Before any deployment reachable beyond that LAN you must add real
  per-user authentication, rotate the key out of the client bundle, and put the
  API behind TLS.
- `PRAHARI_ALLOW_DEMO_KEY=true` enables the public key `prahari-demo-2024`. Use
  it only for throwaway local demos; the backend refuses to start with no key at all.

### Settings that decide whether a hosted deployment is actually protected

| Variable | What happens if you leave it | 
|---|---|
| `PRAHARI_API_KEY` | Unset, with `PRAHARI_ALLOW_DEMO_KEY=true`, every write endpoint accepts `prahari-demo-2024` — a key published in this README. Set it. (`PRAHARI_COMMANDER_KEY` is read as an alias, because the Render blueprint used that name and a key read under the wrong name protects nothing.) |
| `PRAHARI_ALLOW_DEMO_KEY` | Defaults to `true`, which is right for `npm run dev` and wrong for anything with a public hostname. The blueprint sets it to `false`, so a hosted backend with no key **refuses to boot** rather than coming up unprotected. |
| `PRAHARI_CORS_ORIGINS` | Falls back to an origin *pattern* (below) instead of an exact list. Set it to the console's own hostname. |
| `PRAHARI_CORS_ORIGIN_REGEX` | Defaults to `^https://.*\.vercel\.app$` so preview deployments keep working. That admits **every** `vercel.app` origin, not only yours. Narrow it, or set an exact `PRAHARI_CORS_ORIGINS` list and set this to an empty string. |

The backend logs a warning at boot for each of these that is still on its
permissive default, so the posture is visible in the service log rather than
something you have to remember to check.

---

## 🧪 Verifying a change

```bash
cd frontend && npm run typecheck && npm run build
```

```bash
cd backend && python -c "from app.main import app; print('ok')"
```

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
