import httpx
import json
import re
from .models import LLMExpeditionParse, LLMVoiceCommandParse
from datetime import datetime, timedelta

OLLAMA_URL = 'http://localhost:11434/api/generate'
OLLAMA_TIMEOUT = 3.0

STATIONS = {'maitri': 'Maitri', 'bharati': 'Bharati', 'himadri': 'Himadri'}
KNOWN_ITEMS = ['diesel fuel', 'fuel', 'diesel', 'medical supplies', 'medical', 'thermal blankets', 'blankets', 'emergency rations', 'rations', 'food']
KNOWN_LOCATIONS = ['maitri', 'bharati', 'camp alpha', 'shed 1', 'shed 2', 'storage', 'warehouse']

async def call_ollama(system_prompt: str, user_prompt: str) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT) as client:
            resp = await client.post(OLLAMA_URL, json={
                'model': 'llama3.2',
                'prompt': user_prompt,
                'system': system_prompt,
                'stream': False,
                'format': 'json',
                'options': {'temperature': 0.1, 'num_predict': 512}
            })
            if resp.status_code == 200:
                data = resp.json()
                return data.get('response', '')
    except Exception:
        pass
    return None

def strip_markdown_fences(text: str) -> str:
    text = re.sub(r'^```(?:json)?\s*', '', text.strip())
    text = re.sub(r'\s*```$', '', text.strip())
    return text.strip()

def fallback_parse_expedition(raw_text: str) -> LLMExpeditionParse:
    text_lower = raw_text.lower()
    # Extract station
    station = 'Maitri'
    for key, val in STATIONS.items():
        if key in text_lower:
            station = val
            break
    # Extract numbers
    numbers = [int(n) for n in re.findall(r'\b(\d+)\b', raw_text)]
    # Duration (days)
    duration_match = re.search(r'(\d+)[- ]?days?', text_lower)
    duration = int(duration_match.group(1)) if duration_match else 30
    # Personnel
    personnel_match = re.search(r'(\d+)\s*(?:researchers?|engineers?|scientists?|personnel|people|members?|team)', text_lower)
    personnel = int(personnel_match.group(1)) if personnel_match else (numbers[0] if numbers else 8)
    # Total personnel (sum all mentioned groups)
    all_personnel = re.findall(r'(\d+)\s*(?:researchers?|engineers?|scientists?|personnel|people|members?)', text_lower)
    total_personnel = sum(int(p) for p in all_personnel) if all_personnel else personnel
    # Fuel estimate: 20L per person per day
    fuel = total_personnel * duration * 20
    # Name
    name = f'Antarctic Expedition to {station}'
    start_date = datetime.utcnow().strftime('%Y-%m-%d')
    end_date = (datetime.utcnow() + timedelta(days=duration)).strftime('%Y-%m-%d')
    return LLMExpeditionParse(
        name=name, station=station, start_date=start_date, end_date=end_date,
        personnel_required=total_personnel, fuel_required_l=fuel
    )

def fallback_parse_voice(raw_text: str) -> LLMVoiceCommandParse:
    text_lower = raw_text.lower()
    # Action
    action = 'decrement'
    if any(w in text_lower for w in ['added', 'add', 'received', 'restocked', 'increment', 'increase']):
        action = 'increment'
    # Quantity
    qty_match = re.search(r'(\d+\.?\d*)', raw_text)
    quantity = float(qty_match.group(1)) if qty_match else 1.0
    # Item
    item = 'unknown'
    for known in KNOWN_ITEMS:
        if known in text_lower:
            item = known.title()
            break
    # Location
    location = 'Maitri'
    for loc in KNOWN_LOCATIONS:
        if loc in text_lower:
            location = loc.title()
            break
    return LLMVoiceCommandParse(action=action, quantity=quantity, item=item, location=location)

async def parse_expedition_nl(raw_text: str) -> LLMExpeditionParse:
    system = '''You are a JSON-only parser. Given a natural language expedition request, return ONLY a JSON object with these exact fields:
- name (string): expedition name
- station (string): one of "Maitri", "Bharati", "Himadri"
- start_date (string): ISO date YYYY-MM-DD
- end_date (string): ISO date YYYY-MM-DD  
- personnel_required (integer): total number of people
- fuel_required_l (number): liters of fuel needed, estimate 20L/person/day if not stated
No explanation, no markdown, just the JSON object.'''
    response = await call_ollama(system, raw_text)
    if response:
        try:
            cleaned = strip_markdown_fences(response)
            data = json.loads(cleaned)
            return LLMExpeditionParse(**data)
        except Exception:
            pass
    return fallback_parse_expedition(raw_text)

async def parse_voice_command(raw_text: str) -> LLMVoiceCommandParse:
    system = '''You are a JSON-only parser. Given a voice transcript about inventory changes, return ONLY a JSON object with these exact fields:
- action (string): "increment" or "decrement"
- quantity (number): how many units
- item (string): the item name
- location (string): where the action happened
No explanation, no markdown, just the JSON object.'''
    response = await call_ollama(system, raw_text)
    if response:
        try:
            cleaned = strip_markdown_fences(response)
            data = json.loads(cleaned)
            return LLMVoiceCommandParse(**data)
        except Exception:
            pass
    return fallback_parse_voice(raw_text)
