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
import unicodedata
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

# Un lock de escritura por archivo SQLite: los 51 bots ya no se serializan entre sí.
_DB_WRITE_LOCKS = {}
_DB_WRITE_LOCKS_GUARD = threading.Lock()
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
                try:
                    session = boto3.Session(profile_name=profile_name, region_name=region_name)
                    creds = session.get_credentials()
                    if creds is None:
                        client = boto3.client("bedrock-runtime", region_name=region_name, config=cfg)
                    else:
                        client = session.client("bedrock-runtime", config=cfg)
                except Exception:
                    client = boto3.client("bedrock-runtime", region_name=region_name, config=cfg)
            else:
                client = boto3.client("bedrock-runtime", region_name=region_name, config=cfg)
            _BEDROCK_CLIENTS[cache_key] = client
        return client


class _BotConnection(sqlite3.Connection):
    """sqlite3.Connection que recuerda su ruta para resolver el lock de escritura correcto."""

    db_key = ""


def _write_lock(conn: sqlite3.Connection) -> threading.Lock:
    key = getattr(conn, "db_key", "") or "__default__"
    with _DB_WRITE_LOCKS_GUARD:
        lock = _DB_WRITE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _DB_WRITE_LOCKS[key] = lock
        return lock


def get_db_connection(db_path: str) -> sqlite3.Connection:
    parent_dir = os.path.dirname(os.path.abspath(db_path))
    if parent_dir and not os.path.exists(parent_dir):
        os.makedirs(parent_dir, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=15.0, check_same_thread=False, factory=_BotConnection)
    conn.db_key = os.path.normcase(os.path.abspath(db_path))
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
    with _write_lock(conn):
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
    with _write_lock(conn):
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

    with _write_lock(conn):
        cur = conn.cursor()
        # Idempotencia (R1.5): si ya existe un pedido pending reciente (menos de 24h) para el mismo contacto e instancia, reutilizarlo
        cur.execute(
            """
            SELECT id, order_code, total_amount, currency, items_json
            FROM orders
            WHERE customer_contact = ? AND instance_id = ? AND status = 'pending'
              AND created_at >= datetime('now', '-24 hours', 'localtime')
            ORDER BY id DESC LIMIT 1
            """,
            (customer_contact or "Sin contacto", instance_id),
        )
        existing = cur.fetchone()
        if existing:
            try:
                cached_items = json.loads(existing["items_json"] or "[]")
            except Exception:
                cached_items = order_items
            return {
                "id": existing["id"],
                "order_code": existing["order_code"],
                "instance_id": instance_id,
                "customer_name": customer_name,
                "customer_contact": customer_contact,
                "channel": channel,
                "items": cached_items,
                "total_amount": float(existing["total_amount"]),
                "currency": existing["currency"],
                "status": "pending",
                "idempotent_reused": True,
            }

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


def create_mp_preference_py(main_db_path: str, order_code: str, order_items: list, customer_name: str, customer_contact: str) -> str:
    """Generates a dynamic Mercado Pago checkout link for orders created in chat."""
    conn = get_db_connection(main_db_path)
    mp_cfg = {}
    tunnel_cfg = {}
    try:
        cur = conn.cursor()
        cur.execute("SELECT key, value_json FROM settings WHERE key IN ('mercadopago_config', 'tunnel_config')")
        for row in cur.fetchall():
            if row["key"] == "mercadopago_config":
                try:
                    mp_cfg = json.loads(row["value_json"])
                except Exception:
                    pass
            elif row["key"] == "tunnel_config":
                try:
                    tunnel_cfg = json.loads(row["value_json"])
                except Exception:
                    pass
    finally:
        conn.close()

    portal_url = (tunnel_cfg.get("public_url") or "https://servi-bot-cic.web.app").rstrip("/")
    fallback_url = f"{portal_url}/?order={order_code}"

    if not mp_cfg.get("enabled") or not mp_cfg.get("access_token") or not order_items:
        return fallback_url

    tax_rate = float(mp_cfg.get("tax_rate", 0.16))
    mp_items = []
    for it in order_items:
        price = float(it.get("price") or 0)
        if price > 0:
            unit_with_tax = round(price * (1.0 + tax_rate), 2)
            mp_items.append({
                "id": str(it.get("slug") or "servibot-item")[:120],
                "title": f"{it.get('name', 'Servicio Servi-Bot')} (IVA incluido)"[:250],
                "quantity": 1,
                "currency_id": "MXN",
                "unit_price": unit_with_tax,
            })

    if not mp_items:
        return fallback_url

    success_url = mp_cfg.get("success_url") or f"{portal_url}/?mp_status=approved"
    pending_url = mp_cfg.get("pending_url") or f"{portal_url}/?mp_status=pending"
    failure_url = mp_cfg.get("failure_url") or f"{portal_url}/?mp_status=failure"
    sep = "&" if "?" in success_url else "?"

    body = {
        "items": mp_items,
        "external_reference": order_code,
        "statement_descriptor": "SERVIBOT IA",
        "back_urls": {
            "success": f"{success_url}{sep}order={order_code}",
            "pending": f"{pending_url}{sep}order={order_code}",
            "failure": f"{failure_url}{sep}order={order_code}",
        },
        "auto_return": "approved",
    }

    try:
        req = urllib.request.Request(
            "https://api.mercadopago.com/checkout/preferences",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {mp_cfg.get('access_token')}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("init_point") or fallback_url
    except Exception as e:
        print(f"[MercadoPago Python] Error al crear preferencia: {e}", file=sys.stderr)
        return fallback_url


def build_system_prompt(
    catalog_items: list,
    promotions: list,
    channel: str,
    instance_cfg: dict = None,
    is_whitelisted: bool = False,
    client_state: dict = None,
) -> str:
    inst = instance_cfg or {}
    inst_id = (inst.get("instance_id") or "servibot-00").strip()
    is_bot0 = inst_id == "servibot-00"

    default_biz = "Servi-Bot" if is_bot0 else "Negocio del Cliente"
    default_bot = "Asesor" if is_bot0 else "Asistente ServiBot"
    business_name = (inst.get("business_name") or "").strip() or default_biz
    bot_name = (inst.get("display_name") or "").strip() or default_bot
    tone = (inst.get("tone") or "").strip() or "Amable, claro, directo, sin tecnicismos y enfocado en servir"
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
        f"IDENTIDAD DEL BOT ({inst_id}):",
        f"- Eres {bot_name}, de {business_name} en el canal {channel.upper()}.",
        f"- Tono de comunicación: {tone}.",
    ]
    if is_whitelisted:
        parts.append("- ATENCIÓN PRIORITARIA: Este contacto es prioritario. Atiéndelo con máxima agilidad y calidez.")
    if ai_soul:
        parts.append(f"ALMA DE LA IA:\n{ai_soul}")
    if system_rules:
        parts.append(f"INSTRUCCIONES DEL NEGOCIO:\n{system_rules}")
    if welcome_msg:
        parts.append(f"BIENVENIDA DE REFERENCIA:\n{welcome_msg}")

    if is_bot0:
        c_state = client_state or {}
        has_account = bool(c_state.get("has_account", False))
        curr_step = c_state.get("current_step", 1)
        biz_name = (c_state.get("business_name") or "").strip()
        disp_name = (c_state.get("display_name") or "").strip()
        has_cat = bool(c_state.get("has_catalog", False))
        has_sched = bool(c_state.get("has_schedule", False))

        client_state_summary = (
            "ESTADO EN TIEMPO REAL DEL CLIENTE EN LA PANTALLA:\n"
            f"- ¿Tiene cuenta iniciada / sesión activa?: {'SÍ' if has_account else 'NO'}\n"
            f"- Paso actual en el configurador: Paso {curr_step}\n"
            f"- Nombre de negocio registrado: '{biz_name}' {'(LISTO)' if biz_name else '(PENDIENTE)'}\n"
            f"- Nombre de asistente registrado: '{disp_name}' {'(LISTO)' if disp_name else '(PENDIENTE)'}\n"
            f"- Catálogo de servicios/productos: {'SÍ (LISTO)' if has_cat else 'NO (PENDIENTE)'}\n"
            f"- Horarios y reglas: {'SÍ (LISTO)' if has_sched else 'NO (PENDIENTE)'}"
        )
        parts.append(client_state_summary)

        parts.append(
            "REGLAS OBLIGATORIAS DEL ASESOR SERVIBOT (BOT 0):\n"
            "1. REGLA ESTRICTA DE BREVEDAD Y DIGESTIBILIDAD (PROHIBIDO INFODUMP):\n"
            "   - Respuestas sumamente CORTAS y amables: MÁXIMO 2 A 3 ORACIONES por turno.\n"
            "   - Resuelve dudas o haz preguntas DE UNA POR UNA. Jamás mezcles varias preguntas ni arrojes listas largas de pasos o manuales completos juntos, pues saturan al usuario.\n"
            "   - Tu misión principal es interactuar activamente con la pantalla y CREAR el bot del usuario haciéndole preguntas paso a paso de forma conversacional.\n"
            "\n"
            "2. INTERACCIÓN ACTIVA CON LA INTERFAZ (ACCIONES INTERNAS Y BOTONES SELECTIVOS):\n"
            "   - Tú manipulas la interfaz en lugar del usuario emitiendo etiquetas de acción [ACTION: action://...] y botones [BUTTONS: [...]].\n"
            "   - CHECKLIST SECUENCIAL BASADO EN EL ESTADO EN TIEMPO REAL:\n"
            "     * PASO 0 (CUENTA): Si el usuario NO tiene cuenta iniciada ('NO') y pregunta cómo configurar su bot, cómo empezar o qué hacer:\n"
            "       Dile en 2 oraciones que para crear su bot el primer paso es su cuenta gratuita para guardar y proteger su configuración.\n"
            "       Emite: [ACTION: action://auth/open]\n"
            "       Emite: [BUTTONS: [{\"label\": \"🔑 Iniciar Sesión / Registro\", \"action\": \"action://auth/open\"}, {\"label\": \"⚙️ Explorar sin registrarme\", \"action\": \"action://auth/skip\"}]]\n"
            "     * PASO 1 (NEGOCIO): Si YA tiene cuenta ('SÍ') pero NO tiene nombre de negocio:\n"
            "       Muévele la pantalla a Datos de Negocio y pregúntale: ¿Cómo se llama tu negocio y a qué se dedica?\n"
            "       Emite: [ACTION: action://wizard/step?step=1&focus=cfg-business-name]\n"
            "       Emite: [BUTTONS: [{\"label\": \"🏥 Salud / Clínica\", \"text\": \"Mi negocio es una clínica de salud\"}, {\"label\": \"🍕 Restaurante / Comida\", \"text\": \"Mi negocio es un restaurante o cafetería\"}, {\"label\": \"🛍️ Tienda / Comercio\", \"text\": \"Mi negocio es una tienda de productos\"}, {\"label\": \"💼 Servicios Profesionales\", \"text\": \"Ofrezco servicios profesionales y consultoría\"}]]\n"
            "     * PASO 2 (ASISTENTE Y TONO): Si ya tiene negocio pero falta el nombre del asistente o su tono:\n"
            "       Muévele la pantalla a Identidad y pregúntale: ¿Cómo te gustaría que se llame tu asistente (ej. Sofía) y qué tono prefieres?\n"
            "       Emite: [ACTION: action://wizard/step?step=2&tab=identity&focus=cfg-display-name]\n"
            "       Emite: [CONFIG_UPDATE: {\"business_name\": \"<nombre del negocio que dijo el usuario>\"}]\n"
            "       Emite: [BUTTONS: [{\"label\": \"😊 Cálido y Empático\", \"text\": \"Quiero un tono cálido, empático y servicial\"}, {\"label\": \"👔 Formal y Ejecutivo\", \"text\": \"Prefiero un tono formal, profesional y corporativo\"}, {\"label\": \"⚡ Dinámico y Fresco\", \"text\": \"Quiero un tono ágil, moderno y fresco\"}]]\n"
            "     * PASO 3 (CATÁLOGO): Si falta registrar productos o servicios en el catálogo:\n"
            "       Muévele la pantalla a Catálogo y pregúntale: ¿Cuál es tu servicio o producto principal y qué precio tiene?\n"
            "       Emite: [ACTION: action://wizard/step?step=2&tab=catalog&focus=cat-item-name]\n"
            "       Emite: [CONFIG_UPDATE: {\"display_name\": \"<nombre asistente>\", \"tone\": \"<tono>\"}]\n"
            "       Emite botones de ejemplo: [BUTTONS: [{\"label\": \"📋 Consulta General $500\", \"text\": \"Agrega Consulta General por $500 pesos\"}, {\"label\": \"📦 Paquete Básico $1,200\", \"text\": \"Agrega Paquete Básico por $1,200 pesos\"}]]\n"
            "     * PASO 4 (HORARIOS / REGLAS): Si falta el horario de atención:\n"
            "       Muévele la pantalla a Horarios y pregúntale: ¿Cuáles son tus horarios de atención al cliente?\n"
            "       Emite: [ACTION: action://wizard/step?step=2&tab=schedule]\n"
            "       Emite: [BUTTONS: [{\"label\": \"🕘 Lun-Vie 9:00 a 18:00\", \"text\": \"Atendemos de lunes a viernes de 9:00 a 18:00 hrs\"}, {\"label\": \"📅 Lun-Sáb 9:00 a 19:00\", \"text\": \"Atendemos de lunes a sábado de 9:00 a 19:00 hrs\"}, {\"label\": \"🌐 24/7 Todos los días\", \"text\": \"Atención las 24 horas todos los días\"}]]\n"
            "     * PASO 5 (FINALIZACIÓN Y SIMULADOR): Cuando ya tenga los datos o el usuario diga que ya está listo o quiere probarlo:\n"
            "       Felicítalo en 1 o 2 oraciones breves, dile que su bot ya está creado y que pulse el botón para probarlo en el simulador.\n"
            "       Emite obligatoriamente: [CONFIG_COMPLETE]\n"
            "       Emite: [ACTION: action://wizard/step?step=3&mode=custom]\n"
            "       Emite: [BUTTONS: [{\"label\": \"🚀 Probar en Modo Simulación\", \"action\": \"action://wizard/step?step=3&mode=custom\"}]]\n"
            "\n"
            "3. PREGUNTAS GENERALES, PRECIOS Y PLANES:\n"
            "   - Si el usuario pregunta precios, planes o cómo funciona: responde siempre en MÁXIMO 2 oraciones claras.\n"
            "     'Crear y probar tu bot en el simulador web es 100% gratuito. Para conectarlo a tu WhatsApp oficial 24/7 sin límites, el plan es de $1,500 MXN mensuales (+ IVA). ¿Te gustaría que configuremos tu bot ahora mismo?'\n"
            "     Emite: [BUTTONS: [{\"label\": \"🤖 Configurar mi Bot\", \"text\": \"Quiero configurar mi bot\"}, {\"label\": \"🚀 Ir al Simulador\", \"action\": \"action://wizard/step?step=3&mode=custom\"}]]\n"
            "\n"
            "4. REGLAS DE SINTAXIS PARA BOTONES Y ACCIONES:\n"
            "   - OBLIGATORIO: Siempre que el usuario mencione o proporcione datos de su negocio (nombre de su empresa, nombre de asistente, tono, productos/servicios con precios, u horarios), DEBES incluir la etiqueta [CONFIG_UPDATE: {\"business_name\": \"...\", ...}] al final para que la pantalla del usuario se complete de forma automática.\n"
            "   - Emite siempre las etiquetas al final de tu mensaje.\n"
            "   - [ACTION: action://...] para navegación y enfoque de campos.\n"
            "   - [BUTTONS: [{\"label\": \"...\", \"action\": \"action://...\"}, {\"label\": \"...\", \"text\": \"...\"}]] para botones selectivos clickeables.\n"
            "   - [CONFIG_COMPLETE] cuando el bot del usuario quede listo y configurado.\n"
            "   - Eres el asesor ServiBot (JAMÁS menciones Proyecto Cero ni uses tecnicismos como backend, SQLite, token o API)."
        )
    else:
        parts.append(
            f"REGLAS DE AISLAMIENTO PARA {inst_id}:\n"
            f"1. Eres exclusivamente el bot de {business_name}.\n"
            "2. Muestra y ofrece ÚNICAMENTE los productos, servicios y promociones de tu negocio integrados en tu catálogo. Si no hay productos registrados todavía, responde usando tu alma, tono e instrucciones de tu negocio sin inventar catálogo ni precios."
        )

    parts.append(f"CATÁLOGO DE {inst_id}:\n{catalog_block}")
    parts.append(f"PROMOCIONES DE {inst_id}:\n{promo_block}")

    # Directrices específicas según el tipo de canal
    channel_clean = str(channel or '').strip().lower()
    if channel_clean == "instagram":
        parts.append(
            "DIRECTRICES PARA COMENTARIOS EN INSTAGRAM:\n"
            "- Estás respondiendo a un COMENTARIO público en Instagram (publicación o reel).\n"
            "- Sé conciso, empático y profesional (máximo 1 o 2 oraciones).\n"
            "- Resuelve la duda directamente con información oficial. Si el usuario desea contratar o requiere atención detallada, invítalo amablemente a enviar DM o escribir por el enlace de WhatsApp del perfil."
        )
    elif channel_clean == "tiktok":
        parts.append(
            "DIRECTRICES PARA COMENTARIOS EN TIKTOK:\n"
            "- Estás respondiendo a un COMENTARIO público en TikTok.\n"
            "- Sé dinámico, ágil, fresco y sumamente conciso (máximo 1 o 2 oraciones).\n"
            "- Responde la pregunta con energía positiva e invita a consultar el enlace del perfil o WhatsApp para contratar o ver el catálogo completo."
        )
    elif channel_clean == "email":
        parts.append(
            "DIRECTRICES PARA CORREO ELECTRÓNICO:\n"
            "- Estás redactando una respuesta formal por correo electrónico.\n"
            "- Inicia con un saludo formal, presenta la información solicitada de forma clara y estructurada, y concluye con una despedida cordial y la firma de atención al cliente."
        )
    elif channel_clean in ("whatsapp", "telegram", "teams"):
        if is_bot0:
            parts.append(
                f"DIRECTRICES PARA CHAT EN {channel_clean.upper()}:\n"
                "- Estás atendiendo una conversación en tiempo real como asesor oficial de ServiBot.\n"
                "- Mantén un diálogo pedagógico, paciente, cálido y enfocado en orientar, enseñar cómo funciona la plataforma y cómo se configura su bot en la web sin presionar a la venta."
            )
        else:
            parts.append(
                f"DIRECTRICES PARA CHAT EN {channel_clean.upper()}:\n"
                "- Estás atendiendo una conversación de mensajería directa en tiempo real.\n"
                "- Mantén un diálogo ameno, claro y enfocado en resolver sus dudas y facilitar la atención."
            )

    if is_bot0:
        parts.append("Responde siempre en español con calidez, brevedad estricta (máximo 2 a 3 oraciones), claridad y sin tecnicismos.")
    else:
        parts.append("Responde siempre en español con calidez, claridad y el nivel de detalle necesario para atender las dudas del usuario sin tecnicismos.")

    if catalog_items:
        parts.append(
            "REGLAS CRÍTICAS PARA PEDIDOS:\n"
            "- Si el cliente SOLAMENTE pregunta precios, características, soporte, dudas o saluda, responde amablemente y NO agregues ninguna etiqueta de pedido.\n"
            "- ÚNICAMENTE si el cliente confirma de manera explícita y directa que desea contratar o hacer pedido (ej. 'quiero contratar', 'lo quiero comprar', 'levanta el pedido', 'deseo adquirirlo'), confírmale amablemente y agrega al final de tu mensaje: [PEDIDO: slug]."
        )
    return "\n".join(parts)


def generate_smart_fallback(instance_cfg: dict = None, catalog_items: list = None) -> str:
    inst = instance_cfg or {}
    welcome_msg = (inst.get("welcome_message") or "").strip()
    inst_id = inst.get("instance_id") or "servibot-00"
    if welcome_msg:
        base_msg = welcome_msg
    elif inst_id == "servibot-00":
        base_msg = "Hola, soy ServiBot, ¿cómo puedo facilitar tu día? Soy el asesor ServiBot, ¿en qué puedo servirte?"
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
    try:
        resp = client.converse(
            modelId=model_id,
            system=[{"text": system_prompt}],
            messages=messages,
            inferenceConfig={
                "maxTokens": 700,
                "temperature": 0.2,
            },
        )
    except Exception as exc:
        if "could not be found" in str(exc).lower() or "profilenotfound" in type(exc).__name__.lower():
            fallback_client = boto3.client("bedrock-runtime", region_name=region_name)
            resp = fallback_client.converse(
                modelId=model_id,
                system=[{"text": system_prompt}],
                messages=messages,
                inferenceConfig={
                    "maxTokens": 700,
                    "temperature": 0.2,
                },
            )
        else:
            raise
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
            "num_predict": 700,
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


def _normalize_text_for_intent(text: str) -> str:
    nfkd = unicodedata.normalize("NFKD", (text or "").lower())
    return "".join(c for c in nfkd if not unicodedata.combining(c)).strip()


def detect_explicit_order_intent(user_text: str, history: list, catalog_items: list) -> tuple:
    if not catalog_items or not user_text:
        return False, []

    text_clean = _normalize_text_for_intent(user_text)
    confirm_triggers = [
        "proceder al pago",
        "proceder con el pago",
        "dame el link de pago",
        "dame el enlace de pago",
        "pasame el link de pago",
        "pasame el enlace de pago",
        "enlace de pago",
        "link de pago",
        "enlace para pagar",
        "link para pagar",
        "si, quiero pagar",
        "si quiero pagar",
        "listo para pagar",
        "quiero pagar",
        "proceder a pagar",
        "confirmo el pago",
        "confirmo la contratacion",
        "confirmar contratacion",
        "confirmo el pedido",
        "confirmar pedido",
        "confirmo la orden",
        "confirmar orden",
        "si confirmo",
        "si, confirmo",
        "si lo contrato y confirmo",
        "proceder a la compra"
    ]
    is_confirming = any(t in text_clean for t in confirm_triggers)
    if not is_confirming:
        return False, []

    combined_context = _normalize_text_for_intent(" ".join([m.get("content", "") for m in history[-4:]] + [user_text]))
    matched = []
    for item in catalog_items:
        slug = _normalize_text_for_intent(item.get("slug", ""))
        name_words = [w for w in _normalize_text_for_intent(item.get("name", "")).split() if len(w) > 3]
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
    is_load_test = bool(payload.get("is_load_test") or payload.get("skip_order"))
    main_db_path = payload.get("db_path") or os.path.join(os.path.dirname(__file__), "..", "data", "servibot.db")
    instance_id = str(payload.get("instance_id") or "servibot-00").strip() or "servibot-00"
    bot_db_path = payload.get("bot_db_path") or os.path.join(os.path.dirname(main_db_path), "bots", f"{instance_id}.db")
    channel = payload.get("channel", "web")
    sender_id = str(payload.get("sender_id", "anon"))
    sender_name = str(payload.get("sender_name", "")).strip()
    user_message = str(payload.get("message", "")).strip()
    client_state = payload.get("client_state") or {}

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
            bot_conn, channel, sender_id, sender_name, user_message, is_priority=is_whitelisted, hidden=is_load_test
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
            hidden=is_load_test,
        )

        system_prompt = build_system_prompt(
            catalog_items=catalog_items,
            promotions=promotions,
            channel=channel,
            instance_cfg=instance_cfg,
            is_whitelisted=is_whitelisted,
            client_state=client_state,
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
        llm_wants_order = bool(ai_result.get("should_create_order", False)) and bool(catalog_items)
        selected_slugs = ai_result.get("selected_slugs") or []

        slug_map = {item["slug"]: item for item in catalog_items}
        matched_items = [slug_map[s] for s in selected_slugs if s in slug_map]

        # Doble Llave de Seguridad (R1.1):
        # Para que se cree una orden, el usuario DEBE haber expresado confirmación o intención explícita de compra/contratación.
        det_should, det_items = detect_explicit_order_intent(user_message, history, catalog_items) if catalog_items else (False, [])

        should_order = False
        if is_load_test:
            should_order = False
            matched_items = []
        elif llm_wants_order:
            # El LLM etiquetó pedido: solo se permite si el usuario realmente expresó intención explícita
            if det_should:
                should_order = True
                if not matched_items:
                    matched_items = det_items if det_items else [catalog_items[0]]
            else:
                # Falso positivo del LLM (el usuario solo preguntó dudas, precios, soporte, etc.): VETO a la orden
                should_order = False
                matched_items = []
        elif det_should:
            # El usuario dijo explícitamente "quiero contratar / comprar", aunque el LLM olvidó poner la etiqueta
            should_order = True
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
            tax_rate = 0.16
            subtotal = float(created_order["total_amount"])
            total_with_tax = round(subtotal * (1.0 + tax_rate), 2)

            pay_link = create_mp_preference_py(
                main_db_path=main_db_path,
                order_code=created_order["order_code"],
                order_items=created_order["items"],
                customer_name=cust_name,
                customer_contact=sender_id,
            )

            order_banner = (
                f"\n\n📋 *Detalles de tu Orden (Pendiente de Pago)*\n"
                f"• Folio: *{created_order['order_code']}*\n"
                f"• Servicio: {items_summary}\n"
                f"• Total a pagar: *${total_with_tax:,.2f} MXN* (IVA incluido)\n\n"
                f"💳 *Enlace de Pago Seguro (Mercado Pago):*\n"
                f"{pay_link}\n\n"
                f"⚠️ *Nota:* Recuerda que tu bot y canales en vivo se activan automáticamente en cuanto se acredite tu pago."
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
            hidden=is_load_test,
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
    request_queue_size = 128  # R3.2: amplía el backlog de socket de 5 a 128 conexiones concurrentes


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
