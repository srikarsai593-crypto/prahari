from pydantic import BaseModel, ConfigDict, Field, field_validator
from typing import Optional, List, Dict, Literal

# ── Controlled vocabularies ───────────────────────────────────────────────────
# These were free-form strings, so "Atlantis" was a valid destination and
# "bogus_priority" a valid priority. Rejecting them at the edge keeps every
# downstream aggregate (feasibility, risk, depletion) meaningful.
Station = Literal['Maitri', 'Bharati', 'Himadri']
Priority = Literal['low', 'normal', 'high', 'critical']
CargoCategory = Literal['fuel', 'food', 'equipment', 'medical']
Severity = Literal['low', 'medium', 'high', 'critical']
IncidentType = Literal['medical', 'fire', 'severe_weather', 'power_failure', 'structural']
PersonnelStatus = Literal['at_station', 'in_transit', 'field', 'returned', 'deviated', 'sos']
ExpeditionStatus = Literal['draft', 'active', 'completed', 'cancelled']

# Physical bound on the blizzard temperature delta. An unbounded value silently
# drives every station's days-of-cover to zero.
MAX_DELTA_T = 60.0

class ExpeditionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    station: Station
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    personnel_required: int = Field(ge=0, le=500)
    fuel_required_l: float = Field(ge=0, le=1_000_000)
    # Who is actually going. `personnel_required` is the planned headcount;
    # this is the named roster, and an expedition cannot be activated until
    # enough people are on it. Without this the planner produced traverses
    # nobody was ever assigned to.
    crew_ids: List[str] = Field(default_factory=list, max_length=500)
    raw_request: Optional[str] = None
    readiness_score: Optional[int] = None
    readiness_breakdown: Optional[Dict] = None
    model_config = ConfigDict(from_attributes=True)

class ExpeditionResponse(BaseModel):
    id: str
    name: str
    station: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    personnel_required: int
    fuel_required_l: float
    raw_request: Optional[str] = None
    status: str
    readiness_score: Optional[int] = None
    readiness_breakdown: Optional[str] = None
    feasibility_result: Optional[str] = None
    created_at: str
    model_config = ConfigDict(from_attributes=True)

class FeasibilityRequest(BaseModel):
    station: Station
    personnel_required: int = Field(ge=0, le=500)
    fuel_required_l: float = Field(ge=0, le=1_000_000)
    # How long the station has to cover without the fuel this traverse takes
    # with it. Optional: a planner sketching numbers has not picked dates yet,
    # and the check falls back to a nominal duration rather than refusing.
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    # Scoring an existing expedition counts the crew already on it as
    # available — otherwise assigning people to a traverse made that same
    # traverse read as short-staffed.
    expedition_id: Optional[str] = None


class ExpeditionCrewRequest(BaseModel):
    """The named roster for a draft expedition."""
    crew_ids: List[str] = Field(default_factory=list, max_length=500)

class ResupplyRecommendation(BaseModel):
    """An inbound consignment that would close a shortfall.

    Telling a commander they are 3,500 L short and stopping there sends them to
    the Cargo page to scroll for a tanker by hand. The shipments table already
    knows what is on its way and when.
    """
    shipment_id: str
    barcode_id: str
    item_name: str
    quantity: Optional[float] = None
    unit: Optional[str] = None
    eta: Optional[str] = None
    eta_hours: Optional[float] = None
    status: str
    covers_shortfall: bool
    recommendation_text: str


class FeasibilityLineItem(BaseModel):
    label: str
    required: float
    available: float
    ok: bool
    detail: Optional[str] = None
    resupply: Optional[ResupplyRecommendation] = None

class FeasibilityResponse(BaseModel):
    items: List[FeasibilityLineItem]
    readiness_score: int
    readiness_breakdown: Dict[str, int]

class ShipmentCreate(BaseModel):
    """A consignment.

    `weight_kg` is the shipping weight — what the vessel carries and what the
    risk model scores. `quantity`/`unit` are what the crate *contains* in the
    receiving station's own units, and `inventory_item_id` names the stock row
    it tops up. Unloading previously added kilograms onto a row counted in
    litres, which invented fuel out of a unit mismatch.

    `origin_station` None means an external resupply vessel. A station id makes
    it an inter-station transfer, and the stock leaves that station at dispatch.
    """
    item_name: str = Field(min_length=1, max_length=120)
    category: CargoCategory
    weight_kg: float = Field(gt=0, le=50_000)
    quantity: Optional[float] = Field(default=None, gt=0, le=1_000_000)
    unit: Optional[str] = Field(default=None, max_length=24)
    inventory_item_id: Optional[str] = Field(default=None, max_length=64)
    priority: Priority = 'normal'
    origin_station: Optional[Station] = None
    destination_station: Station
    expedition_id: Optional[str] = None
    # Hours from now until the crate is due. Defaults to the nominal sea leg.
    # Negative values backdate the ETA, which is the only way to exercise the
    # overdue-convoy path without waiting a fortnight for a real one to slip.
    eta_hours: Optional[float] = Field(default=None, ge=-8760, le=8760)
    # Cold chain. Left unset, medical and food consignments take the default
    # band for their category and everything else is not temperature
    # controlled — see app/coldchain.py. Send explicit values to override,
    # including a band on a category that has none by default.
    temp_min: Optional[float] = Field(default=None, ge=-90, le=60)
    temp_max: Optional[float] = Field(default=None, ge=-90, le=60)

    @field_validator('temp_max')
    @classmethod
    def _band_is_the_right_way_round(cls, temp_max, info):
        temp_min = info.data.get('temp_min')
        if temp_max is not None and temp_min is not None and temp_max <= temp_min:
            raise ValueError('temp_max must be above temp_min')
        return temp_max

    @field_validator('destination_station')
    @classmethod
    def _not_a_round_trip(cls, destination, info):
        if info.data.get('origin_station') == destination:
            raise ValueError('origin_station and destination_station must differ')
        return destination

class ShipmentResponse(BaseModel):
    id: str
    barcode_id: str
    expedition_id: Optional[str] = None
    item_name: str
    category: str
    weight_kg: float
    quantity: Optional[float] = None
    unit: Optional[str] = None
    inventory_item_id: Optional[str] = None
    priority: str
    origin_station: Optional[str] = None
    destination_station: str
    status: str
    dispatch_date: Optional[str] = None
    eta: Optional[str] = None
    risk_score: int
    delay_reason: Optional[str] = None
    last_scanned_at: Optional[str] = None
    updated_at: str
    model_config = ConfigDict(from_attributes=True)

class RiskUpdateRequest(BaseModel):
    delta_t: float = Field(ge=0, le=MAX_DELTA_T,
                           description='Blizzard temperature delta in °C.')


class StationWeatherRequest(BaseModel):
    """Weather is a property of a station, not of one crate.

    The old flow required picking a single shipment, wrote the station's ΔT and
    then re-scored only that shipment — so every other consignment bound for the
    same base kept a risk score from the previous weather."""
    station: Station
    delta_t: float = Field(ge=0, le=MAX_DELTA_T,
                           description='Blizzard temperature delta in °C.')

class RiskUpdateResponse(BaseModel):
    risk_score: int
    status: str
    eta: Optional[str] = None
    delay_reason: Optional[str] = None
    delta_t: float

class InventoryItemResponse(BaseModel):
    id: str
    name: str
    category: str
    station: str
    quantity: float
    unit: Optional[str] = None
    base_burn_rate: Optional[float] = None
    beta: float
    days_of_cover: Optional[float] = None
    updated_at: str
    depletion_rate: Optional[float] = None
    model_config = ConfigDict(from_attributes=True)

class StockCommandRequest(BaseModel):
    """A typed stock adjustment, e.g. "Removed 10 litres of diesel fuel".

    `station` is required and is the console's active station: an inventory
    write that is not tied to one base silently matched the same item name at
    all three, which is how a Maitri issue got applied to Bharati stock (or to
    nothing at all).  `dry_run` returns the parse and the matched row without
    writing, so the operator confirms what was understood before it lands.
    """
    transcript: str = Field(min_length=1, max_length=500)
    station: Station
    dry_run: bool = False

class StockCommandResult(BaseModel):
    action: str
    quantity: float
    item: str
    location: str

class PersonnelResponse(BaseModel):
    id: str
    name: str
    role: Optional[str] = None
    expedition_id: Optional[str] = None
    status: str
    current_lat: Optional[float] = None
    current_lng: Optional[float] = None
    last_update_at: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)

class MovementPlanCreate(BaseModel):
    personnel_id: str = Field(min_length=1)
    origin_lat: float = Field(ge=-90, le=90)
    origin_lng: float = Field(ge=-180, le=180)
    destination_lat: float = Field(ge=-90, le=90)
    destination_lng: float = Field(ge=-180, le=180)
    destination_name: str = Field(min_length=1, max_length=120)
    planned_route: List[Dict[str, float]] = Field(min_length=2)
    departure_time: str
    expected_arrival: str

    @field_validator('planned_route')
    @classmethod
    def _waypoints_are_coordinates(cls, route):
        for i, wp in enumerate(route):
            if 'lat' not in wp or 'lng' not in wp:
                raise ValueError(f'waypoint {i} must have lat and lng')
            if not (-90 <= wp['lat'] <= 90) or not (-180 <= wp['lng'] <= 180):
                raise ValueError(f'waypoint {i} is outside valid coordinate range')
        return route

class MovementPlanResponse(BaseModel):
    id: str
    personnel_id: str
    origin_lat: float
    origin_lng: float
    destination_lat: float
    destination_lng: float
    destination_name: str
    planned_route: str
    departure_time: str
    expected_arrival: str
    status: str
    model_config = ConfigDict(from_attributes=True)

class IncidentCreate(BaseModel):
    type: IncidentType
    location_lat: float = Field(ge=-90, le=90)
    location_lng: float = Field(ge=-180, le=180)
    affected_radius_m: float = Field(default=5000.0, gt=0, le=500_000)
    severity: Severity = 'medium'

class IncidentResponse(BaseModel):
    id: str
    type: str
    location_lat: float
    location_lng: float
    affected_radius_m: float
    severity: str
    status: str
    expected_count: Optional[int] = None
    confirmed_safe_count: int
    unaccounted_count: Optional[int] = None
    created_at: str
    model_config = ConfigDict(from_attributes=True)

class AccountabilityCount(BaseModel):
    expected: int
    confirmed_safe: int
    unaccounted: int

class EventResponse(BaseModel):
    id: str
    module: str
    action: str
    actor: str
    related_id: Optional[str] = None
    metadata: Optional[str] = None
    created_at: str
    model_config = ConfigDict(from_attributes=True)

class LLMExpeditionParse(BaseModel):
    """What a model is allowed to have understood from a written request.

    These bounds are the point of the class, not decoration. `_try_llm_parse`
    treats a validation failure as "this provider did not answer" and moves on
    to the next one, and finally to the deterministic regex fallback - so a
    model that invents a station or a negative crew size degrades to rules
    instead of feeding a nonsense figure into a readiness score.
    """
    name: str = Field(min_length=1, max_length=120)
    station: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    personnel_required: int = Field(ge=0, le=500)
    fuel_required_l: float = Field(ge=0, le=1_000_000)

    @field_validator('station')
    @classmethod
    def _known_station(cls, value):
        match = {s.lower(): s for s in ('Maitri', 'Bharati', 'Himadri')}
        resolved = match.get(str(value).strip().lower())
        if resolved is None:
            raise ValueError(f'unknown station {value!r}')
        return resolved


# Words a model may reasonably use for the two things that can happen to stock.
_STOCK_ACTIONS = {
    'increment': 'increment', 'increase': 'increment', 'add': 'increment',
    'added': 'increment', 'restock': 'increment', 'restocked': 'increment',
    'receive': 'increment', 'received': 'increment', 'in': 'increment',
    'decrement': 'decrement', 'decrease': 'decrement', 'remove': 'decrement',
    'removed': 'decrement', 'issue': 'decrement', 'issued': 'decrement',
    'consume': 'decrement', 'consumed': 'decrement', 'out': 'decrement',
}


class LLMStockCommandParse(BaseModel):
    """A parsed stock adjustment, bounded before it can touch a quantity.

    `quantity` is non-negative and `action` carries the direction. Letting the
    sign live in the quantity too means the two can disagree: a decrement of
    -200 reads as "removed 200" and writes +200, inventing life-support stock
    out of a malformed parse. The regex fallback cannot produce that, but a
    model can, and this is the last place to catch it before the route
    arithmetic runs.
    """
    action: str
    quantity: float = Field(ge=0, le=1_000_000)
    item: str = Field(min_length=1, max_length=120)
    location: str

    @field_validator('action')
    @classmethod
    def _known_action(cls, value):
        resolved = _STOCK_ACTIONS.get(str(value).strip().lower())
        if resolved is None:
            raise ValueError(f'unknown stock action {value!r}')
        return resolved


class InventoryUpdateRequest(BaseModel):
    """Stock cannot go negative — a negative quantity produced a negative
    days-of-cover that the dashboard rendered as a real reading.

    `station` is the console's active station. It is checked against the item's
    own station so an edit made while looking at one base cannot land on
    another base's identically named row."""
    quantity: float = Field(ge=0, le=10_000_000)
    station: Optional[Station] = None


class PersonnelStatusRequest(BaseModel):
    status: PersonnelStatus


class IncidentUpdateRequest(BaseModel):
    """An incident is fluid. Severity and perimeter were frozen at declaration,
    so a medium generator fire that became a station-threatening blaze, or a
    fume leak that spread from 1 km to 3.5 km, could only be represented by
    resolving the record and declaring a new one - which discards the running
    accountability count and the audit trail that goes with it.

    Every field is optional; send only what changed."""
    # 'open' is the legacy word and normalises to 'declared'; see
    # app/incident_lifecycle.py for what each stage means.
    status: Optional[Literal['open', 'declared', 'acknowledged', 'responding',
                             'contained', 'resolved']] = None
    severity: Optional[Severity] = None
    affected_radius_m: Optional[float] = Field(default=None, gt=0, le=500_000)


class IncidentTaskRequest(BaseModel):
    """Tick or untick one step of an incident's response protocol."""
    done: bool


class AssetDeployRequest(BaseModel):
    """Commit a search-and-rescue asset to an incident, or release it.

    `incident_id` None releases the asset back to `available`."""
    incident_id: Optional[str] = Field(default=None, max_length=64)


class InventoryPolicyRequest(BaseModel):
    """This row's own supply floor.

    `clear_*` exists because None means "leave unchanged" on a PATCH, so
    removing a floor needs to be said explicitly rather than implied by
    omission."""
    minimum_threshold: Optional[float] = Field(default=None, ge=0, le=10_000_000)
    safety_stock_days: Optional[float] = Field(default=None, gt=0, le=3650)
    clear_minimum: bool = False
    clear_safety_stock_days: bool = False
    station: Optional[Station] = None


class ExpeditionStatusRequest(BaseModel):
    """Expeditions have a lifecycle. Without one every record stayed 'draft'
    forever and the dashboard's "Active Expeditions" was really a draft count."""
    status: ExpeditionStatus


class SyncReportRequest(BaseModel):
    """Counts from a console that has just drained its offline queue.

    Deliberately counts only — the audit line is composed server-side so a
    client cannot write arbitrary prose into the station's record."""
    flushed: int = Field(ge=0, le=100_000)
    dropped: int = Field(default=0, ge=0, le=100_000)
    pending: int = Field(default=0, ge=0, le=100_000)
    station: Optional[Station] = None


class TemperatureReading(BaseModel):
    """One temperature observation for a consignment.

    `source` is required and has no default. Prahari has no sensor network:
    a reading is either something an operator read off a gauge or something a
    handheld logger reported, and a console that could not tell the two apart
    would be presenting a typed figure as telemetry.
    """
    temp_c: float = Field(ge=-90, le=60)
    source: Literal['manual', 'logger'] = 'manual'
    note: Optional[str] = Field(default=None, max_length=200)


class ResetRequest(BaseModel):
    """Demo reset. `confirm` must be the literal string so an accidental POST
    cannot wipe a station's operational record."""
    confirm: Literal['RESET']
    scope: Literal['operational', 'all'] = 'operational'


class DemoSeasonRequest(BaseModel):
    """Load the demonstration season. It restores the baseline first, so no
    confirm token is required beyond the credentials every write carries -
    what it clears, the reset endpoint would clear anyway."""
    clear_events: bool = False 


class AssetUpdateRequest(BaseModel):
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    status: Optional[Literal['available', 'standby', 'deployed', 'unavailable']] = None


class PowerFailureRequest(BaseModel):
    station: Station = 'Maitri'


class ParseNLRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class LoginRequest(BaseModel):
    """The commander key, exchanged for a session cookie.

    Bounded so a sign-in attempt cannot be used to push a megabyte through the
    constant-time comparison."""
    key: str = Field(min_length=1, max_length=256)


class BarcodeScanRequest(BaseModel):
    barcode_id: str = Field(min_length=1, max_length=64)
