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
    # Scoring an existing expedition counts the crew already on it as
    # available — otherwise assigning people to a traverse made that same
    # traverse read as short-staffed.
    expedition_id: Optional[str] = None


class ExpeditionCrewRequest(BaseModel):
    """The named roster for a draft expedition."""
    crew_ids: List[str] = Field(default_factory=list, max_length=500)

class FeasibilityLineItem(BaseModel):
    label: str
    required: float
    available: float
    ok: bool
    detail: Optional[str] = None

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
    name: str
    station: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    personnel_required: int
    fuel_required_l: float

class LLMStockCommandParse(BaseModel):
    action: str
    quantity: float
    item: str
    location: str


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
    status: Literal['open', 'resolved']


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


class ResetRequest(BaseModel):
    """Demo reset. `confirm` must be the literal string so an accidental POST
    cannot wipe a station's operational record."""
    confirm: Literal['RESET']
    scope: Literal['operational', 'all'] = 'operational' 


class AssetUpdateRequest(BaseModel):
    lat: Optional[float] = Field(default=None, ge=-90, le=90)
    lng: Optional[float] = Field(default=None, ge=-180, le=180)
    status: Optional[Literal['available', 'standby', 'deployed', 'unavailable']] = None


class PowerFailureRequest(BaseModel):
    station: Station = 'Maitri'


class ParseNLRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class BarcodeScanRequest(BaseModel):
    barcode_id: str = Field(min_length=1, max_length=64)
