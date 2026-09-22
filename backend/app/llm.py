"""
LLM integration for Prahari — Gemini Flash → Ollama → regex fallback chain.

Priority:
  1. Google Gemini 1.5 Flash (if GEMINI_API_KEY env var is set)
  2. Ollama llama3.2 (if running locally on port 11434)
  3. Rule-based regex fallback

All parse functions return a dict with an extra `parse_source` field so the
frontend can display which path was taken ("gemini", "ollama", "fallback").
"""

import httpx
import json
import re
import os
from .models import LLMExpeditionParse, LLMVoiceCommandParse
from datetime import datetime, timedelta, timezone

# ── Config ────────────────────────────────────────────────────────────────────
OLLAMA_URL = 'http://localhost:11434/api/generate'
OLLAMA_TIMEOUT = 3.0

GEMINI_API_KEY: str | None = os.getenv('GEMINI_API_KEY')
GEMINI_URL = (
    'https://generativelanguage.googleapis.com/v1beta/models/'
    'gemini-1.5-flash:generateContent?key={key}'
)
GEMINI_TIMEOUT = 8.0

STATIONS = {'maitri': 'Maitri', 'bharati': 'Bharati', 'himadri': 'Himadri'}
KNOWN_ITEMS = [
    'diesel fuel', 'fuel', 'diesel', 'medical supplies', 'medical',
    'thermal blankets', 'blankets', 'emergency rations', 'rations', 'food',
    'oxygen', 'water', 'batteries', 'clothing', 'tools',
]
KNOWN_LOCATIONS = [
    'maitri', 'bharati', 'himadri', 'camp alpha', 'shed 1', 'shed 2',
    'storage', 'warehouse', 'field camp',
]


# ── Gemini Flash ──────────────────────────────────────────────────────────────

async def call_gemini(system_prompt: str, user_prompt: str) -> str | None:
    """Call Google Gemini 1.5 Flash. Returns raw JSON string or None."""
    if not GEMINI_API_KEY:
        return None
    try:
        prompt = f"{system_prompt}\n\nUser input: {user_prompt}"
        payload = {
            'contents': [{'parts': [{'text': prompt}]}],
            'generationConfig': {
                'responseMimeType': 'application/json',
                'temperature': 0.1,
                'maxOutputTokens': 512,
            },
        }
        url = GEMINI_URL.format(key=GEMINI_API_KEY)
        async with httpx.AsyncClient(timeout=GEMINI_TIMEOUT) as client:
            resp = await client.post(url, json=payload)
            if resp.status_code == 200:
                data = resp.json()
                return data['candidates'][0]['content']['parts'][0]['text']
    except Exception as e:
        print(f'[Gemini] Error: {e}')
    return None


# ── Ollama ────────────────────────────────────────────────────────────────────

async def call_ollama(system_prompt: str, user_prompt: str) -> str | None:
    """Call local Ollama. Returns raw JSON string or None."""
    try:
        async with httpx.AsyncClient(timeout=OLLAMA_TIMEOUT) as client:
            resp = await client.post(OLLAMA_URL, json={
                'model': 'llama3.2',
                'prompt': user_prompt,
                'system': system_prompt,
                'stream': False,
                'format': 'json',
                'options': {'temperature': 0.1, 'num_predict': 512},
            })
            if resp.status_code == 200:
                data = resp.json()
                return data.get('response', '')
    except Exception:
        pass
    return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _strip_fences(text: str) -> str:
    text = re.sub(r'^```(?:json)?\s*', '', text.strip())
    text = re.sub(r'\s*```$', '', text.strip())
    return text.strip()


async def _try_llm_parse(system_prompt: str, user_prompt: str, model_cls) -> tuple[dict | None, str]:
    """
    Try Gemini, then Ollama. Returns (raw_json_string, source_label).
    source_label is "gemini", "ollama", or "" (empty = no LLM succeeded).
    """
    for source, caller in (('gemini', call_gemini), ('ollama', call_ollama)):
        text = await caller(system_prompt, user_prompt)
        if not text:
            continue
        try:
            data = json.loads(_strip_fences(text))
            model_cls(**data)
            return data, source
        except Exception as e:
            print(f'[{source.upper()}] JSON parse/validation error: {e}')

    return None, ''


# ── Regex fallbacks ───────────────────────────────────────────────────────────

def fallback_parse_expedition(raw_text: str) -> LLMExpeditionParse:
    text_lower = raw_text.lower()
    station = 'Maitri'
    for key, val in STATIONS.items():
        if key in text_lower:
            station = val
            break
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
    start_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    end_date = (datetime.now(timezone.utc) + timedelta(days=duration)).strftime('%Y-%m-%d')
    return LLMExpeditionParse(
        name=name, station=station, start_date=start_date, end_date=end_date,
        personnel_required=total_personnel, fuel_required_l=fuel
    )
    total_personnel = sum(int(p) for p in all_personnel) if all_personnel else 8
    fuel = total_personnel * duration * 20
    now = datetime.now(timezone.utc)
    return LLMExpeditionParse(
        name=f'Antarctic Expedition to {station}',
        station=station,
        start_date=now.strftime('%Y-%m-%d'),
        end_date=(now + timedelta(days=duration)).strftime('%Y-%m-%d'),
        personnel_required=total_personnel,
        fuel_required_l=fuel,
    )


def fallback_parse_voice(raw_text: str) -> LLMVoiceCommandParse:
    text_lower = raw_text.lower()
    action = 'decrement'
    if any(w in text_lower for w in ['added', 'add', 'received', 'restocked', 'increment', 'increase', 'loaded']):
        action = 'increment'
    qty_match = re.search(r'(\d+\.?\d*)', raw_text)
    quantity = float(qty_match.group(1)) if qty_match else 1.0
    item = 'unknown'
    for known in KNOWN_ITEMS:
        if known in text_lower:
            item = known.title()
            break
    location = 'Maitri'
    for loc in KNOWN_LOCATIONS:
        if loc in text_lower:
            location = loc.title()
            break
    return LLMVoiceCommandParse(action=action, quantity=quantity, item=item, location=location)

async def parse_expedition_nl(raw_text: str) -> tuple:
    """Returns (LLMExpeditionParse, ai_used: bool)"""
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
            return LLMExpeditionParse(**data), True
        except Exception:
            pass
    return fallback_parse_expedition(raw_text), False

# ── Public parse functions ────────────────────────────────────────────────────

async def parse_expedition_nl(raw_text: str) -> dict:
    """
    Parse a natural language expedition request.
    Returns LLMExpeditionParse fields + `parse_source` ("gemini"|"ollama"|"fallback").
    """
    system = (
        'You are a JSON-only parser. Given a natural language expedition request, '
        'return ONLY a JSON object with these exact fields:\n'
        '- name (string): expedition name\n'
        '- station (string): one of "Maitri", "Bharati", "Himadri"\n'
        '- start_date (string): ISO date YYYY-MM-DD\n'
        '- end_date (string): ISO date YYYY-MM-DD\n'
        '- personnel_required (integer): total number of people\n'
        '- fuel_required_l (number): litres of fuel, estimate 20L/person/day if not stated\n'
        'No explanation, no markdown, just the JSON object.'
    )

    data, source = await _try_llm_parse(system, raw_text, LLMExpeditionParse)
    if data:
        parsed = LLMExpeditionParse(**data)
        return {**parsed.model_dump(), 'parse_source': source}

    # Regex fallback
    parsed = fallback_parse_expedition(raw_text)
    return {**parsed.model_dump(), 'parse_source': 'fallback'}


async def parse_voice_command(raw_text: str) -> dict:
    """
    Parse a voice inventory command.
    Returns LLMVoiceCommandParse fields + `parse_source`.
    """
    system = (
        'You are a JSON-only parser. Given a voice transcript about inventory changes, '
        'return ONLY a JSON object with these exact fields:\n'
        '- action (string): "increment" or "decrement"\n'
        '- quantity (number): how many units\n'
        '- item (string): the item name\n'
        '- location (string): where the action happened\n'
        'No explanation, no markdown, just the JSON object.'
    )

    data, source = await _try_llm_parse(system, raw_text, LLMVoiceCommandParse)
    if data:
        parsed = LLMVoiceCommandParse(**data)
        return {**parsed.model_dump(), 'parse_source': source}

    parsed = fallback_parse_voice(raw_text)
    return {**parsed.model_dump(), 'parse_source': 'fallback'}
