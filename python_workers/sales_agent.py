#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servi-Bot Async & On-Demand Python Worker (sales_agent.py)
Ejecuta procesamiento de lenguaje natural con aislamiento total de base de datos por bot:
- Cada instancia (servibot-00 .. servibot-50) lee y escribe únicamente su propio archivo SQLite:
  data/bots/<instance_id>.db (catálogo, promociones, listas blanca/negra/omisiones, conversaciones y pedidos).
- Evalua reglas de Lista Negra (no responde y oculta), Omisión (no responde) y Lista Blanca (prioridad).
- Soporta modo demonio HTTP concurrente (--serve 10003) y modo CLI por stdin.
"""

import argparse
import datetime
import json
import os
import random
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import boto3
    from botocore.config import Config as BotoConfig
except ImportError:
    boto3 = None
    BotoConfig = None

# Force UTF-8 on Windows stdio
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")

DEFAULT_AWS_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-2"
DEFAULT_BEDROCK_MODEL = os.environ.get("BEDROCK_MODEL_ID") or "us.amazon.nova-micro-v1:0"
FALLBACK_BEDROCK_MODEL = os.environ.get("BEDROCK_FALLBACK_MODEL_ID") or "us.amazon.nova-lite-v1:0"

DB_WRITE_LOCK = threading.Lock()
_BEDROCK_CLIENTS = {}
_BEDROCK_CLIENT_LOCK = threading.Lock()


def get_bedrock_client(region_name: str):
    """Returns a cached, thread-safe boto3 bedrock-runtime client with adaptive retries."""
    if boto3 is None or BotoConfig is None:
        raise RuntimeError("boto3 is not installed in the active Python environment.")
    profile_name = (os.environ.get("AWS_PROFILE") or "").strip()
    cache_key = (region_name, profile_name)
    with _BEDROCK_CLIENT_LOCK:
        client = _BEDROCK_CLIENTS.get(cache_key)
        if client is None:
            cfg = BotoConfig(
                retries={"max_attempts": 5, "mode": "adaptive"},
                max_pool_connections=100,
                connect_timeout=5,
                read_timeout=30,
            )
            if profile_name:
                session = boto3.Session(profile_name=profile_name, region_name=region_name)
                client = session.client("bedrock-runtime", config=cfg)
            else:
                client = boto3.client("bedrock-runtime", region_name=region_name, config=cfg)
            _BEDROCK_CLIENTS[cache_key] = client
        return client


def get_db_connection(db_path: str) -> sqlite3.Connection:
    parent_dir = os.path.dirname(os.path.abspath(db_path))
    if parent_dir and not os.path.exists(parent_dir):
        os.makedirs(parent_dir, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


def ensure_bot_schema(conn: sqlite3.Connection):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS catalog_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT UNIQUE NOT NULL,
            type TEXT NOT NULL DEFAULT 'service',
            name TEXT NOT NULL,
            tagline TEXT DEFAULT '',
            description TEXT NOT NULL,
            price REAL NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'MXN',
            billing_cycle TEXT NOT NULL DEFAULT 'mensual',
            setup_fee REAL NOT NULL DEFAULT 0,
            features_json TEXT NOT NULL DEFAULT '[]',
            image_url TEXT NOT NULL DEFAULT '',
            badge TEXT DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1,
            sent_to_bot INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS promotions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            discount_text TEXT DEFAULT '',
            price REAL DEFAULT NULL,
            currency TEXT NOT NULL DEFAULT 'MXN',
            active INTEGER NOT NULL DEFAULT 1,
            sent_to_bot INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS contact_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_value TEXT NOT NULL,
            normalized_value TEXT UNIQUE NOT NULL,
            list_type TEXT NOT NULL CHECK(list_type IN ('whitelist', 'blacklist', 'omission')),
            label TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_code TEXT UNIQUE NOT NULL,
            customer_name TEXT NOT NULL,
            customer_contact TEXT NOT NULL,
            customer_company TEXT DEFAULT '',
            channel TEXT NOT NULL DEFAULT 'whatsapp',
            instance_id TEXT NOT NULL DEFAULT '',
            items_json TEXT NOT NULL DEFAULT '[]',
            total_amount REAL NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'MXN',
            notes TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            sender_name TEXT DEFAULT '',
            last_message TEXT DEFAULT '',
            is_priority INTEGER NOT NULL DEFAULT 0,
            hidden INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            UNIQUE(channel, sender_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            hidden INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        """
    )
    conn.commit()


def normalize_contact(val: str) -> str:
    raw = str(val or "").strip()
    if not raw:
        return ""
    if "@s.whatsapp.net" in raw or "@c.us" in raw or "@lid" in raw:
        bare = raw.split("@", 1)[0]
        digits = re.sub(r"\D", "", bare)
        return digits or bare.lower()
    if "@" in raw:
        return raw.lower()
    digits = re.sub(r"\D", "", raw)
    if len(digits) >= 7:
        return digits
    return raw.lower()


def contacts_match(a: str, b: str) -> bool:
    na = normalize_contact(a)
    nb = normalize_contact(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if na.isdigit() and nb.isdigit() and len(na) >= 10 and len(nb) >= 10:
        return na[-10:] == nb[-10:]
    return False


def load_isolated_bot_data(bot_conn: sqlite3.Connection):
    """Loads catalog items, promotions, and contact rules strictly from this bot's isolated SQLite DB."""
    ensure_bot_schema(bot_conn)
    cur = bot_conn.cursor()

    cur.execute(
        "SELECT id, slug, type, name, tagline, description, price, currency, billing_cycle, setup_fee, features_json, badge "
        "FROM catalog_items WHERE active = 1 AND COALESCE(sent_to_bot, 1) = 1 ORDER BY id ASC"
    )
    items = []
    for row in cur.fetchall():
        d = dict(row)
        try:
            d["features"] = json.loads(d.get("features_json") or "[]")
        except Exception:
            d["features"] = []
        items.append(d)

    cur.execute(
        "SELECT id, title, description, discount_text, price, currency "
        "FROM promotions WHERE active = 1 AND COALESCE(sent_to_bot, 1) = 1 ORDER BY id ASC"
    )
    promotions = [dict(row) for row in cur.fetchall()]

    cur.execute("SELECT id, contact_value, normalized_value, list_type, label FROM contact_rules")
    contact_rules = [dict(row) for row in cur.fetchall()]

    return items, promotions, contact_rules


def load_main_instance_and_provider_cfg(main_db_path: str, instance_id: str):
    """Loads ONLY this instance_id's identity row and technical provider settings from servibot.db."""
    conn = get_db_connection(main_db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT * FROM bot_instances WHERE instance_id = ?", (instance_id,))
        row = cur.fetchone()
        instance_cfg = dict(row) if row else {"instance_id": instance_id}

        cur.execute("SELECT value_json FROM settings WHERE key = 'bot_config'")
        cfg_row = cur.fetchone()
        provider_cfg = {}
        if cfg_row:
            try:
                provider_cfg = json.loads(cfg_row["value_json"])
            except Exception:
                provider_cfg = {}
        return instance_cfg, provider_cfg
    finally:
        conn.close()


def evaluate_contact_lists(sender_id: str, contact_rules: list) -> dict:
    """Checks sender_id against isolated blacklist, omission, and whitelist rules."""
    status = {
        "list_type": None,
        "blacklisted": False,
        "omitted": False,
        "whitelisted": False,
        "matched_rule": None,
    }
    if not sender_id or not contact_rules:
        return status

    for rule in contact_rules:
        candidate = rule.get("normalized_value") or rule.get("contact_value") or ""
        if contacts_match(sender_id, candidate):
            ltype = str(rule.get("list_type") or "").lower()
            if ltype == "blacklist":
                status["list_type"] = "blacklist"
                status["blacklisted"] = True
                status["matched_rule"] = rule
                return status
            if ltype == "omission":
                status["list_type"] = "omission"
                status["omitted"] = True
                status["matched_rule"] = rule
            elif ltype == "whitelist" and not status["omitted"]:
                status["list_type"] = "whitelist"
                status["whitelisted"] = True
                status["matched_rule"] = rule
    return status


def get_or_create_conversation(
    conn: sqlite3.Connection,
    channel: str,
    sender_id: str,
    sender_name: str,
    last_msg: str,
    is_priority: bool = False,
    hidden: bool = False,
) -> int:
    prio_val = 1 if is_priority else 0
    hidden_val = 1 if hidden else 0
    with DB_WRITE_LOCK:
        cur = conn.cursor()
        cur.execute(
            "SELECT id, sender_name, hidden FROM conversations WHERE channel = ? AND sender_id = ?",
            (channel, sender_id),
        )
        row = cur.fetchone()
        if row:
            conv_id = row["id"]
            new_name = sender_name if sender_name else (row["sender_name"] or "")
            next_hidden = 1 if (hidden_val == 1) else 0
            cur.execute(
                "UPDATE conversations SET sender_name = ?, last_message = ?, is_priority = ?, hidden = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
                (new_name, last_msg[:300], prio_val, next_hidden, conv_id),
            )
            conn.commit()
            return conv_id
        else:
            cur.execute(
                "INSERT INTO conversations (channel, sender_id, sender_name, last_message, is_priority, hidden) VALUES (?, ?, ?, ?, ?, ?)",
                (channel, sender_id, sender_name or sender_id, last_msg[:300], prio_val, hidden_val),
            )
            conn.commit()
            return cur.lastrowid


def append_message(
    conn: sqlite3.Connection,
    conversation_id: int,
    role: str,
    content: str,
    metadata: dict = None,
    hidden: bool = False,
):
    hidden_val = 1 if hidden else 0
    with DB_WRITE_LOCK:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO messages (conversation_id, role, content, metadata_json, hidden) VALUES (?, ?, ?, ?, ?)",
            (conversation_id, role, content, json.dumps(metadata or {}, ensure_ascii=False), hidden_val),
        )
        cur.execute(
            "UPDATE conversations SET last_message = ?, hidden = CASE WHEN ? = 1 THEN 1 ELSE hidden END, updated_at = datetime('now', 'localtime') WHERE id = ?",
            (content[:300], hidden_val, conversation_id),
        )
        conn.commit()


def fetch_conversation_history(conn: sqlite3.Connection, conversation_id: int, limit: int = 6):
    cur = conn.cursor()
    cur.execute(
        "SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND COALESCE(hidden, 0) = 0 ORDER BY id DESC LIMIT ?",
        (conversation_id, limit),
    )
    rows = cur.fetchall()
    rows.reverse()
    return [{"role": r["role"], "content": r["content"]} for r in rows]


def create_order_in_db(
    conn: sqlite3.Connection,
    instance_id: str,
    customer_name: str,
    customer_contact: str,
    customer_company: str,
    channel: str,
    matched_items: list,
    notes: str,
):
    now_str = datetime.datetime.now().strftime("%Y%m%d")
    rand_suffix = random.randint(1000, 9999)
    order_code = f"SB-{now_str}-{rand_suffix}"

    total_amount = 0.0
    currency = "MXN"
    order_items = []
    for item in matched_items:
        price = float(item.get("price") or 0)
        setup_fee = float(item.get("setup_fee") or 0)
        line_total = price + setup_fee
        total_amount += price
        currency = item.get("currency") or "MXN"
        order_items.append(
            {
                "id": item["id"],
                "slug": item["slug"],
                "name": item["name"],
                "price": price,
                "setup_fee": setup_fee,
                "billing_cycle": item.get("billing_cycle", "mensual"),
                "currency": currency,
                "line_total": line_total,
            }
        )

    with DB_WRITE_LOCK:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO orders (
                order_code, customer_name, customer_contact, customer_company,
                channel, instance_id, items_json, total_amount, currency, notes, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
            """,
            (
                order_code,
                customer_name or "Cliente",
                customer_contact or "Sin contacto",
                customer_company or "",
                channel,
                instance_id,
                json.dumps(order_items, ensure_ascii=False),
                total_amount,
                currency,
                notes or f"[{instance_id}] Pedido registrado por el agente IA",
            ),
        )
        conn.commit()
        order_id = cur.lastrowid

    return {
        "id": order_id,
        "order_code": order_code,
        "instance_id": instance_id,
        "customer_name": customer_name,
        "customer_contact": customer_contact,
        "channel": channel,
        "items": order_items,
        "total_amount": total_amount,
        "currency": currency,
        "status": "pending",
    }


def build_system_prompt(
    catalog_items: list,
    promotions: list,
    channel: str,
    instance_cfg: dict = None,
    is_whitelisted: bool = False,
) -> str:
    inst = instance_cfg or {}
    inst_id = (inst.get("instance_id") or "servibot-00").strip()
    is_bot0 = inst_id == "servibot-00"

    default_biz = "Proyecto Cero · Servi-Bot" if is_bot0 else "Negocio del Cliente"
    default_bot = "ServiBot #00 · Proyecto Cero" if is_bot0 else "Asistente ServiBot"
    business_name = (inst.get("business_name") or "").strip() or default_biz
    bot_name = (inst.get("display_name") or "").strip() or default_bot
    tone = (inst.get("tone") or "").strip() or "Profesional, claro y enfocado en servicio"
    ai_soul = (inst.get("ai_soul") or "").strip()
    system_rules = (inst.get("system_prompt") or "").strip()
    welcome_msg = (inst.get("welcome_message") or "").strip()

    catalog_text_lines = []
    for idx, item in enumerate(catalog_items, start=1):
        setup_str = f" (+${item['setup_fee']:,.0f} activación)" if item.get("setup_fee") else ""
        desc = (item.get("description") or "").strip()
        tagline = (item.get("tagline") or "").strip()
        summary = desc or tagline
        catalog_text_lines.append(
            f"{idx}. {item['name']} [slug: {item['slug']}]: ${item['price']:,.0f} {item['currency']} ({item['billing_cycle']}){setup_str}. {summary}"
        )

    catalog_block = (
        "\n".join(catalog_text_lines)
        if catalog_text_lines
        else "Ningún producto o servicio ha sido enviado a este bot todavía en su interfaz."
    )

    promo_lines = []
    for idx, pr in enumerate(promotions, start=1):
        price_str = f" | Precio promo: ${float(pr['price']):,.0f} {pr.get('currency') or 'MXN'}" if pr.get("price") is not None else ""
        disc_str = f" ({pr['discount_text']})" if pr.get("discount_text") else ""
        promo_lines.append(
            f"{idx}. {pr['title']}{disc_str}{price_str}: {pr.get('description') or ''}"
        )
    promo_block = (
        "\n".join(promo_lines)
        if promo_lines
        else "No hay promociones activas registradas en la interfaz."
    )

    parts = [
        f"IDENTIDAD AISLADA DEL BOT ({inst_id}):",
        f"- Eres {bot_name}, asistente exclusivo de {business_name} en el canal {channel.upper()}.",
        f"- Tono de comunicación: {tone}.",
    ]
    if is_whitelisted:
        parts.append("- ATENCIÓN PRIORITARIA (LISTA BLANCA): Este contacto es prioritario. Atiéndelo con máxima agilidad y calidez.")
    if ai_soul:
        parts.append(f"ALMA DE LA IA:\n{ai_soul}")
    if system_rules:
        parts.append(f"INSTRUCCIONES DEL NEGOCIO:\n{system_rules}")
    if welcome_msg:
        parts.append(f"BIENVENIDA DE REFERENCIA:\n{welcome_msg}")

    if is_bot0:
        parts.append(
            "REGLAS TAXATIVAS DE PROYECTO CERO (BOT 0):\n"
            "1. Solo debes contestar preguntas relacionadas con el Proyecto Cero (Servi-Bot). Si el usuario pregunta temas ajenos al Proyecto Cero, indica amablemente que únicamente respondes consultas del Proyecto Cero.\n"
            "2. ESTÁ PROHIBIDO inventar ofertas, paquetes especiales, precios no listados o servicios inexistentes.\n"
            "3. Limítate SIEMPRE y ÚNICAMENTE a dar la información exacta del catálogo y las promociones activas creadas en la interfaz (indicando '+ impuestos' cuando aplique)."
        )
    else:
        parts.append(
            f"REGLAS DE AISLAMIENTO ESTRICTO PARA {inst_id}:\n"
            f"1. Eres exclusivamente el bot de {business_name}. Jamás menciones servicios de Servi-Bot Central ni de otros bots.\n"
            "2. Muestra y ofrece ÚNICAMENTE los productos, servicios y promociones integrados en tu propia interfaz abajo listados. Si no hay productos registrados en tu catálogo todavía, responde usando solo tu alma, tono e instrucciones de tu negocio sin inventar catálogo ni precios."
        )

    parts.append(f"CATÁLOGO EXCLUSIVO DE {inst_id} (SQLite aislado):\n{catalog_block}")
    parts.append(f"PROMOCIONES ACTIVAS DE {inst_id} (SQLite aislado):\n{promo_block}")
    parts.append("Responde siempre en español de forma clara y breve (máximo 3 párrafos cortos).")

    if catalog_items:
        parts.append(
            "Si el cliente confirma explícitamente que desea contratar o hacer pedido de alguno de los elementos de tu catálogo listado arriba, confírmale y escribe al final [PEDIDO: slug]."
        )
    return "\n".join(parts)


def generate_smart_fallback(instance_cfg: dict = None, catalog_items: list = None) -> str:
    inst = instance_cfg or {}
    welcome_msg = (inst.get("welcome_message") or "").strip()
    inst_id = inst.get("instance_id") or "servibot-00"
    if welcome_msg:
        base_msg = welcome_msg
    elif inst_id == "servibot-00":
        base_msg = "¡Hola! Soy el asistente de Proyecto Cero (Servi-Bot). ¿En qué servicio del catálogo te podemos ayudar hoy?"
    else:
        bot_name = (inst.get("display_name") or "").strip() or "ServiBot"
        business_name = (inst.get("business_name") or "").strip() or "nuestro negocio"
        base_msg = f"¡Hola! Soy {bot_name} de {business_name}. ¿En qué puedo ayudarte hoy?"

    if catalog_items:
        summary = "; ".join(
            f"{item['name']} (${item['price']:,.0f} {item.get('currency', 'MXN')})"
            for item in catalog_items[:5]
        )
        return f"{base_msg}\n\nCatálogo disponible: {summary}."
    return base_msg


def parse_agent_reply(content: str) -> dict:
    """Extracts [PEDIDO: slug] tags and clean reply text from model output."""
    text = (content or "").strip()
    tag_match = re.search(r"\[PEDIDO:\s*([a-z0-9,-]+)\]", text, re.IGNORECASE)
    clean_reply = re.sub(r"\[PEDIDO:[^\]]*\]", "", text, flags=re.IGNORECASE).strip()
    slugs = []
    if tag_match:
        slugs = [s.strip().lower() for s in tag_match.group(1).split(",") if s.strip()]
    return {
        "reply": clean_reply or text,
        "should_create_order": bool(tag_match),
        "selected_slugs": slugs,
    }


def _normalize_converse_messages(history: list, user_message: str) -> list:
    """Normalizes message history into strictly alternating user/assistant turns for Bedrock Converse."""
    raw_turns = []
    for h in history:
        role = "assistant" if h.get("role") == "assistant" else "user"
        text = str(h.get("content") or "").strip()
        if text:
            raw_turns.append((role, text))
    raw_turns.append(("user", user_message))

    while raw_turns and raw_turns[0][0] != "user":
        raw_turns.pop(0)

    merged = []
    for role, text in raw_turns:
        if merged and merged[-1]["role"] == role:
            merged[-1]["content"][0]["text"] += f"\n{text}"
        else:
            merged.append({"role": role, "content": [{"text": text}]})
    return merged


def call_bedrock_chat(model_id: str, system_prompt: str, history: list, user_message: str, region_name: str) -> dict:
    """Invokes Amazon Bedrock Converse API with explicit maxTokens and adaptive retry."""
    client = get_bedrock_client(region_name)
    messages = _normalize_converse_messages(history, user_message)
    resp = client.converse(
        modelId=model_id,
        system=[{"text": system_prompt}],
        messages=messages,
        inferenceConfig={
            "maxTokens": 220,
            "temperature": 0.2,
        },
    )
    blocks = resp.get("output", {}).get("message", {}).get("content", [])
    content = "\n".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("text")).strip()
    return parse_agent_reply(content)


def call_ollama_chat(ollama_url: str, model: str, messages: list) -> dict:
    url = f"{ollama_url.rstrip('/')}/api/chat"
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "keep_alive": "60m",
        "options": {
            "temperature": 0.2,
            "num_ctx": 2048,
            "num_predict": 220,
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw_body = resp.read().decode("utf-8")
        data = json.loads(raw_body)
        content = data.get("message", {}).get("content", "").strip()
        return parse_agent_reply(content)


def detect_explicit_order_intent(user_text: str, history: list, catalog_items: list) -> tuple:
    if not catalog_items:
        return False, []

    text_lower = user_text.lower()
    confirm_triggers = [
        "quiero contratar",
        "quiero comprar",
        "confirmo el pedido",
        "confirmar pedido",
        "hazme el pedido",
        "levanta el pedido",
        "levantar pedido",
        "lo quiero contratar",
        "si lo quiero",
        "sí lo quiero",
        "registra mi pedido",
        "registrar pedido",
        "quiero adquirir",
        "contratar ambos",
        "quiero el paquete",
    ]
    is_confirming = any(t in text_lower for t in confirm_triggers)
    if not is_confirming:
        return False, []

    combined_context = " ".join([m.get("content", "") for m in history[-4:]] + [user_text]).lower()
    matched = []
    for item in catalog_items:
        slug = item["slug"].lower()
        name_words = [w for w in item["name"].lower().split() if len(w) > 3]
        if slug in combined_context or any(w in combined_context for w in name_words):
            matched.append(item)

    if not matched:
        matched = [catalog_items[0]]

    return True, matched


def _run_inference_with_fallback(
    provider: str,
    bedrock_model: str,
    aws_region: str,
    system_prompt: str,
    history: list,
    user_message: str,
    ollama_url: str,
    ollama_model: str,
):
    last_error = None
    if provider != "ollama":
        candidate_models = [bedrock_model]
        if FALLBACK_BEDROCK_MODEL and FALLBACK_BEDROCK_MODEL not in candidate_models:
            candidate_models.append(FALLBACK_BEDROCK_MODEL)
        for model_id in candidate_models:
            try:
                res = call_bedrock_chat(model_id, system_prompt, history, user_message, aws_region)
                return res, f"bedrock:{model_id}"
            except Exception as exc:
                last_error = exc

    ollama_messages = [{"role": "system", "content": system_prompt}]
    for h in history:
        ollama_messages.append({"role": h["role"], "content": h["content"]})
    ollama_messages.append({"role": "user", "content": user_message})

    try:
        res = call_ollama_chat(ollama_url, ollama_model, ollama_messages)
        return res, ollama_model
    except Exception as exc:
        if last_error is not None:
            raise RuntimeError(f"Bedrock error: {last_error} | Ollama fallback error: {exc}") from exc
        raise


def process_request(payload: dict) -> dict:
    started_at = time.perf_counter()
    main_db_path = payload.get("db_path") or os.path.join(os.path.dirname(__file__), "..", "data", "servibot.db")
    instance_id = str(payload.get("instance_id") or "servibot-00").strip() or "servibot-00"
    bot_db_path = payload.get("bot_db_path") or os.path.join(os.path.dirname(main_db_path), "bots", f"{instance_id}.db")
    channel = payload.get("channel", "web")
    sender_id = str(payload.get("sender_id", "anon"))
    sender_name = str(payload.get("sender_name", "")).strip()
    user_message = str(payload.get("message", "")).strip()

    if not user_message:
        return {"ok": False, "error": "Empty message"}

    instance_cfg = payload.get("instance_cfg")
    provider_cfg = {}
    if not isinstance(instance_cfg, dict) or not instance_cfg.get("instance_id"):
        instance_cfg, provider_cfg = load_main_instance_and_provider_cfg(main_db_path, instance_id)
    resolved_instance_id = instance_cfg.get("instance_id") or instance_id

    bot_conn = get_db_connection(bot_db_path)
    is_whitelisted = False
    catalog_items = []
    try:
        catalog_items, promotions, contact_rules = load_isolated_bot_data(bot_conn)
        list_eval = evaluate_contact_lists(sender_id, contact_rules)

        # 1. Lista Negra: no responde en lo absoluto y oculta el mensaje recibido
        if list_eval["blacklisted"]:
            conv_id = get_or_create_conversation(
                bot_conn, channel, sender_id, sender_name, user_message, is_priority=False, hidden=True
            )
            append_message(
                bot_conn,
                conv_id,
                "user",
                user_message,
                {"sender_id": sender_id, "channel": channel, "instance_id": resolved_instance_id, "list_type": "blacklist"},
                hidden=True,
            )
            return {
                "ok": True,
                "channel": channel,
                "instance_id": resolved_instance_id,
                "sender_id": sender_id,
                "conversation_id": conv_id,
                "ignored": True,
                "blacklisted": True,
                "omitted": False,
                "hidden": True,
                "priority": False,
                "reply": "",
                "order_created": False,
                "latency_ms": int((time.perf_counter() - started_at) * 1000),
            }

        # 2. Omisión: registra el mensaje visible, pero el bot no lo contesta
        if list_eval["omitted"]:
            conv_id = get_or_create_conversation(
                bot_conn, channel, sender_id, sender_name, user_message, is_priority=False, hidden=False
            )
            append_message(
                bot_conn,
                conv_id,
                "user",
                user_message,
                {"sender_id": sender_id, "channel": channel, "instance_id": resolved_instance_id, "list_type": "omission"},
                hidden=False,
            )
            return {
                "ok": True,
                "channel": channel,
                "instance_id": resolved_instance_id,
                "sender_id": sender_id,
                "conversation_id": conv_id,
                "ignored": False,
                "blacklisted": False,
                "omitted": True,
                "hidden": False,
                "priority": False,
                "reply": "",
                "order_created": False,
                "latency_ms": int((time.perf_counter() - started_at) * 1000),
            }

        is_whitelisted = bool(list_eval["whitelisted"])

        ollama_url = payload.get("ollama_url") or provider_cfg.get("ollama_host") or "http://127.0.0.1:10002"
        ollama_model = payload.get("ollama_model") or provider_cfg.get("ollama_model") or "llama3.2:3b"
        provider = str(
            payload.get("ai_provider") or provider_cfg.get("ai_provider") or os.environ.get("AI_PROVIDER") or "bedrock"
        ).lower()
        bedrock_model = str(
            payload.get("bedrock_model") or provider_cfg.get("bedrock_model") or DEFAULT_BEDROCK_MODEL
        )
        aws_region = str(payload.get("aws_region") or provider_cfg.get("aws_region") or DEFAULT_AWS_REGION)

        conv_id = get_or_create_conversation(
            bot_conn, channel, sender_id, sender_name, user_message, is_priority=is_whitelisted, hidden=False
        )
        history = fetch_conversation_history(bot_conn, conv_id, limit=6)
        append_message(
            bot_conn,
            conv_id,
            "user",
            user_message,
            {
                "sender_id": sender_id,
                "channel": channel,
                "instance_id": resolved_instance_id,
                "priority": is_whitelisted,
            },
            hidden=False,
        )

        system_prompt = build_system_prompt(
            catalog_items=catalog_items,
            promotions=promotions,
            channel=channel,
            instance_cfg=instance_cfg,
            is_whitelisted=is_whitelisted,
        )
        ai_result, model_used = _run_inference_with_fallback(
            provider=provider,
            bedrock_model=bedrock_model,
            aws_region=aws_region,
            system_prompt=system_prompt,
            history=history,
            user_message=user_message,
            ollama_url=ollama_url,
            ollama_model=ollama_model,
        )

        reply_text = str(ai_result.get("reply") or "").strip()
        should_order = bool(ai_result.get("should_create_order", False)) and bool(catalog_items)
        selected_slugs = ai_result.get("selected_slugs") or []

        slug_map = {item["slug"]: item for item in catalog_items}
        matched_items = [slug_map[s] for s in selected_slugs if s in slug_map]

        if not should_order and catalog_items:
            det_should, det_items = detect_explicit_order_intent(user_message, history, catalog_items)
            if det_should:
                should_order = True
                matched_items = det_items

        if should_order and not matched_items and catalog_items:
            _, det_items = detect_explicit_order_intent("quiero contratar " + user_message, history, catalog_items)
            matched_items = det_items if det_items else [catalog_items[0]]

        created_order = None
        if should_order and matched_items:
            cust_name = (
                str(ai_result.get("customer_name") or "").strip()
                or sender_name
                or f"Cliente {channel.capitalize()} ({sender_id})"
            )
            cust_company = str(ai_result.get("customer_company") or "").strip()
            notes = str(ai_result.get("notes") or "").strip() or (
                f"[{resolved_instance_id}] Solicitud vía {channel}: {user_message[:180]}"
            )
            created_order = create_order_in_db(
                conn=bot_conn,
                instance_id=resolved_instance_id,
                customer_name=cust_name,
                customer_contact=sender_id,
                customer_company=cust_company,
                channel=channel,
                matched_items=matched_items,
                notes=notes,
            )
            items_summary = ", ".join(f"{i['name']} (${i['price']:,.0f} {i['currency']})" for i in created_order["items"])
            order_banner = (
                f"\n\n✅ *Pedido Registrado Exitosamente*\n"
                f"• Folio: *{created_order['order_code']}*\n"
                f"• Servicio(s): {items_summary}\n"
                f"• Total base: *${created_order['total_amount']:,.0f} {created_order['currency']}*\n"
                f"Ya quedó registrado en el Panel Administrativo de esta instancia."
            )
            if created_order["order_code"] not in reply_text:
                reply_text = f"{reply_text}{order_banner}"

        if not reply_text:
            reply_text = generate_smart_fallback(instance_cfg, catalog_items=catalog_items)

        latency_ms = int((time.perf_counter() - started_at) * 1000)
        append_message(
            bot_conn,
            conv_id,
            "assistant",
            reply_text,
            {
                "instance_id": resolved_instance_id,
                "order_created": bool(created_order),
                "order_code": created_order["order_code"] if created_order else None,
                "model": model_used,
                "priority": is_whitelisted,
                "latency_ms": latency_ms,
            },
            hidden=False,
        )

        return {
            "ok": True,
            "channel": channel,
            "instance_id": resolved_instance_id,
            "instance_name": instance_cfg.get("display_name") or resolved_instance_id,
            "business_name": instance_cfg.get("business_name") or "",
            "sender_id": sender_id,
            "conversation_id": conv_id,
            "reply": reply_text,
            "priority": is_whitelisted,
            "blacklisted": False,
            "omitted": False,
            "order_created": bool(created_order),
            "order": created_order,
            "model_used": model_used,
            "ollama_port": ollama_url,
            "latency_ms": latency_ms,
        }
    except Exception as exc:
        return {
            "ok": False,
            "instance_id": instance_id,
            "priority": is_whitelisted,
            "error": str(exc),
            "reply": generate_smart_fallback(instance_cfg, catalog_items=catalog_items),
        }
    finally:
        bot_conn.close()


class _ConcurrentHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class _WorkerHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send_json(self, status_code: int, body: dict):
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "mode": "async-bedrock-worker",
                    "port": self.server.server_port,
                    "model": DEFAULT_BEDROCK_MODEL,
                    "region": DEFAULT_AWS_REGION,
                },
            )
            return
        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if self.path != "/process":
            self._send_json(404, {"ok": False, "error": "Not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            payload = json.loads(raw_body) if raw_body.strip() else {}
            result = process_request(payload)
            self._send_json(200, result)
        except Exception as exc:
            self._send_json(500, {"ok": False, "error": str(exc)})

    def log_message(self, format, *args):
        return


def serve_worker(port: int):
    """Starts the persistent multi-threaded HTTP worker for low-latency concurrent inference."""
    try:
        get_bedrock_client(DEFAULT_AWS_REGION)
    except Exception:
        pass
    server = _ConcurrentHTTPServer(("127.0.0.1", port), _WorkerHandler)
    print(f"[SalesWorker] Async Bedrock worker listening on http://127.0.0.1:{port} ({DEFAULT_BEDROCK_MODEL} @ {DEFAULT_AWS_REGION})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Servi-Bot Sales Agent Worker")
    parser.add_argument("--serve", nargs="?", const=10003, type=int, help="Run as persistent async HTTP worker on given port")
    args, unknown = parser.parse_known_args()

    if args.serve is not None:
        serve_worker(args.serve)
    else:
        raw_in = sys.stdin.read().strip()
        if not raw_in and unknown:
            raw_in = unknown[0]
        try:
            input_payload = json.loads(raw_in) if raw_in else {}
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"Invalid JSON input: {e}"}))
            sys.exit(1)

        result = process_request(input_payload)
        print(json.dumps(result, ensure_ascii=False))
