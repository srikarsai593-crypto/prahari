from pydantic import BaseModel, ConfigDict
from typing import Optional, List, Dict

class ExpeditionCreate(BaseModel):
    name: str
    station: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    personnel_required: int
    fuel_required_l: float
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
    station: str
    personnel_required: int
    fuel_required_l: float

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
    item_name: str
    category: str
    weight_kg: float
    priority: str
    destination_station: str
    expedition_id: Optional[str] = None

class ShipmentResponse(BaseModel):
    id: str
    barcode_id: str
    expedition_id: Optional[str] = None
    item_name: str
    category: str
    weight_kg: float
    priority: str
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
    delta_t: float

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

class VoiceCommandRequest(BaseModel):
    transcript: str

class VoiceCommandResult(BaseModel):
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
    personnel_id: str
    origin_lat: float
    origin_lng: float
    destination_lat: float
    destination_lng: float
    destination_name: str
    planned_route: List[Dict[str, float]]
    departure_time: str
    expected_arrival: str

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
    type: str
    location_lat: float
    location_lng: float
    affected_radius_m: Optional[float] = 5000.0
    severity: Optional[str] = 'medium'

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

class LLMVoiceCommandParse(BaseModel):
    action: str
    quantity: float
    item: str
    location: str
