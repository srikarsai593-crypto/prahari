"""
LLM integration for Prahari — Gemini Flash → Ollama → regex fallback chain.

Priority:
  1. Google Gemini 1.5 Flash (if GEMINI_API_KEY env var is set)
  2. Ollama llama3.2 (if running locally on port 11434)
  3. Rule-based regex fallback

All parse functions return a dict with an extra `parse_source` field so the
frontend can display which path was taken ("gemini", "ollama", "fallback").
"""

import asyncio
import httpx
import json
import re
import os
from .models import LLMExpeditionParse, LLMStockCommandParse
from datetime import datetime, timedelta, timezone
import logging

logger = logging.getLogger('prahari.llm')

# ── Config ────────────────────────────────────────────────────────────────────
OLLAMA_URL = 'http://localhost:11434/api/generate'
OLLAMA_TIMEOUT = 3.0

def get_gemini_api_key() -> str | None:
    key = os.getenv('GEMINI_API_KEY')
    if not key or key.startswith('REVOKED') or 'REPLACE' in key:
        return None
    return key

# Model is configurable and defaults to the floating "latest" alias.
# A pinned point-version (e.g. gemini-1.5-flash) gets retired by Google and then
# returns 404 forever, which silently degrades every parse to the regex fallback.
# flash-lite is the right tier for strict schema extraction: it answers in
# ~1.5s, where the full flash tier spends seconds on internal reasoning and
# returns 503/timeouts under load.
GEMINI_MODEL = os.getenv('GEMINI_MODEL', 'gemini-flash-lite-latest')
GEMINI_URL = (
    'https://generativelanguage.googleapis.com/v1beta/models/'
    '{model}:generateContent?key={key}'
)
GEMINI_TIMEOUT = float(os.getenv('GEMINI_TIMEOUT', '20'))
GEMINI_MAX_ATTEMPTS = 3
GEMINI_BACKOFF_S = 0.6
TRANSIENT_STATUS = {429, 500, 502, 503, 504}

STATIONS = {'maitri': 'Maitri', 'bharati': 'Bharati', 'himadri': 'Himadri'}
# Longest / most specific names first: the fallback takes the first hit, so
# 'diesel fuel' must be tried before the bare 'fuel'.
KNOWN_ITEMS = [
    'diesel fuel', 'fuel', 'diesel', 'medical supplies', 'medical',
    'thermal blankets', 'blankets', 'emergency rations', 'rations', 'food',
    'generator spares', 'spares',
    'oxygen', 'water', 'batteries', 'clothing', 'tools',
]
KNOWN_LOCATIONS = [
    'maitri', 'bharati', 'himadri', 'camp alpha', 'shed 1', 'shed 2',
    'storage', 'warehouse', 'field camp',
]


# ── Gemini Flash ──────────────────────────────────────────────────────────────

async def call_gemini(system_prompt: str, user_prompt: str) -> str | None:
    """Call Google Gemini 1.5 Flash. Returns raw JSON string or None."""
    api_key = get_gemini_api_key()
    if not api_key:
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
        url = GEMINI_URL.format(model=GEMINI_MODEL, key=api_key)
        async with httpx.AsyncClient(timeout=GEMINI_TIMEOUT) as client:
            for attempt in range(GEMINI_MAX_ATTEMPTS):
                resp = await client.post(url, json=payload)

                # 429/503 are transient capacity errors, not configuration
                # errors. Without a retry a busy minute silently downgrades the
                # whole demo to the regex fallback.
                if resp.status_code in TRANSIENT_STATUS and attempt < GEMINI_MAX_ATTEMPTS - 1:
                    backoff = GEMINI_BACKOFF_S * (2 ** attempt)
                    logger.warning('Gemini HTTP %s (attempt %d/%d) - retrying in %.1fs',
                                   resp.status_code, attempt + 1, GEMINI_MAX_ATTEMPTS, backoff)
                    await asyncio.sleep(backoff)
                    continue

                if resp.status_code != 200:
                    # Surface the reason instead of failing silently to fallback.
                    logger.error('Gemini HTTP %s for model %s: %s',
                                 resp.status_code, GEMINI_MODEL, resp.text[:300])
                    return None

                data = resp.json()
                parts = data['candidates'][0]['content'].get('parts') or []
                # Newer models may emit non-text parts (thought signatures) first.
                for part in parts:
                    if isinstance(part.get('text'), str) and part['text'].strip():
                        return part['text']
                logger.error('Gemini response contained no text part')
                return None
    except Exception as e:
        logger.error('Gemini call failed: %s', e)
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
            logger.warning('%s returned unusable JSON (%s) - trying next provider', source, e)

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
    personnel = int(personnel_match.group(1)) if personnel_match else 8
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


def fallback_parse_stock_command(raw_text: str) -> LLMStockCommandParse:
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
    return LLMStockCommandParse(action=action, quantity=quantity, item=item, location=location)


async def parse_expedition_nl(raw_text: str) -> dict:
    """
    Parse a natural language expedition request.
    Returns LLMExpeditionParse fields + `parse_source` ("gemini"|"ollama"|"fallback").
    """
    # Ground relative dates ("two-week traverse", "next month") against today.
    # Without this the model anchors them to its training cutoff and returns
    # dates years in the past.
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    system = (
        f"Today's date is {today}. Resolve every relative date against it.\n"
        'You are a JSON-only parser. Given a natural language expedition request, '
        'return ONLY a JSON object with these exact fields:\n'
        '- name (string): expedition name\n'
        '- station (string): one of "Maitri", "Bharati", "Himadri"\n'
        '- start_date (string): ISO date YYYY-MM-DD\n'
        '- end_date (string): ISO date YYYY-MM-DD\n'
        '- personnel_required (integer): total number of people across all roles\n'
        '- fuel_required_l (number): litres of fuel; use the stated figure if one '
        'is given, otherwise estimate 20L per person per day\n'
        'No explanation, no markdown, just the JSON object.'
    )

    data, source = await _try_llm_parse(system, raw_text, LLMExpeditionParse)
    if data:
        parsed = LLMExpeditionParse(**data)
        return {**parsed.model_dump(), 'parse_source': source}

    # Regex fallback
    parsed = fallback_parse_expedition(raw_text)
    return {**parsed.model_dump(), 'parse_source': 'fallback'}


async def parse_stock_command(raw_text: str) -> dict:
    """
    Parse a typed inventory stock command.
    Returns LLMStockCommandParse fields + `parse_source`.
    """
    system = (
        'You are a JSON-only parser. Given a text command about inventory changes, '
        'return ONLY a JSON object with these exact fields:\n'
        '- action (string): "increment" or "decrement"\n'
        '- quantity (number): how many units\n'
        '- item (string): the item name\n'
        '- location (string): where the action happened\n'
        'No explanation, no markdown, just the JSON object.'
    )

    data, source = await _try_llm_parse(system, raw_text, LLMStockCommandParse)
    if data:
        parsed = LLMStockCommandParse(**data)
        return {**parsed.model_dump(), 'parse_source': source}

    parsed = fallback_parse_stock_command(raw_text)
    return {**parsed.model_dump(), 'parse_source': 'fallback'}
