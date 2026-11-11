#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Servi-Bot On-Demand Python Worker (sales_agent.py)
Ejecuta a demanda el procesamiento de lenguaje natural, consulta de catálogo en SQLite,
inferencia contra Ollama (puerto 10002, modelo llama3.2:3b), detección de cierre de venta
y creación automática de pedidos en la base de datos SQLite.
"""

import sys
import os
import json
import sqlite3
import urllib.request
import urllib.error
import datetime
import random
import re

# Force UTF-8 on Windows stdio
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")


def get_db_connection(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA busy_timeout = 5000;")
    return conn


def load_catalog_and_settings(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute(
        "SELECT id, slug, type, name, tagline, description, price, currency, billing_cycle, setup_fee, features_json, badge "
        "FROM catalog_items WHERE active = 1 ORDER BY id ASC"
    )
    items = []
    for row in cur.fetchall():
        d = dict(row)
        try:
            d["features"] = json.loads(d.get("features_json") or "[]")
        except Exception:
            d["features"] = []
        items.append(d)

    cur.execute("SELECT value_json FROM settings WHERE key = 'bot_config'")
    row = cur.fetchone()
    bot_config = {}
    if row:
        try:
            bot_config = json.loads(row["value_json"])
        except Exception:
            bot_config = {}
    return items, bot_config


def get_or_create_conversation(conn: sqlite3.Connection, channel: str, sender_id: str, sender_name: str, last_msg: str) -> int:
    cur = conn.cursor()
    cur.execute(
        "SELECT id, sender_name FROM conversations WHERE channel = ? AND sender_id = ?",
        (channel, sender_id),
    )
    row = cur.fetchone()
    if row:
        conv_id = row["id"]
        new_name = sender_name if sender_name else (row["sender_name"] or "")
        cur.execute(
            "UPDATE conversations SET sender_name = ?, last_message = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
            (new_name, last_msg[:300], conv_id),
        )
        conn.commit()
        return conv_id
    else:
        cur.execute(
            "INSERT INTO conversations (channel, sender_id, sender_name, last_message) VALUES (?, ?, ?, ?)",
            (channel, sender_id, sender_name or sender_id, last_msg[:300]),
        )
        conn.commit()
        return cur.lastrowid


def append_message(conn: sqlite3.Connection, conversation_id: int, role: str, content: str, metadata: dict = None):
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO messages (conversation_id, role, content, metadata_json) VALUES (?, ?, ?, ?)",
        (conversation_id, role, content, json.dumps(metadata or {}, ensure_ascii=False)),
    )
    cur.execute(
        "UPDATE conversations SET last_message = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
        (content[:300], conversation_id),
    )
    conn.commit()


def fetch_conversation_history(conn: sqlite3.Connection, conversation_id: int, limit: int = 10):
    cur = conn.cursor()
    cur.execute(
        "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
        (conversation_id, limit),
    )
    rows = cur.fetchall()
    rows.reverse()
    return [{"role": r["role"], "content": r["content"]} for r in rows]


def create_order_in_db(
    conn: sqlite3.Connection,
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
        order_items.append({
            "id": item["id"],
            "slug": item["slug"],
            "name": item["name"],
            "price": price,
            "setup_fee": setup_fee,
            "billing_cycle": item.get("billing_cycle", "mensual"),
            "currency": currency,
            "line_total": line_total,
        })

    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO orders (
            order_code, customer_name, customer_contact, customer_company,
            channel, items_json, total_amount, currency, notes, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        """,
        (
            order_code,
            customer_name or "Cliente Servi-Bot",
            customer_contact or "Sin contacto",
            customer_company or "",
            channel,
            json.dumps(order_items, ensure_ascii=False),
            total_amount,
            currency,
            notes or "Pedido cerrado automáticamente por el agente Servi-Bot",
        ),
    )
    conn.commit()
    return {
        "id": cur.lastrowid,
        "order_code": order_code,
        "customer_name": customer_name,
        "customer_contact": customer_contact,
        "channel": channel,
        "items": order_items,
        "total_amount": total_amount,
        "currency": currency,
        "status": "pending",
    }


def build_system_prompt(catalog_items: list, bot_config: dict, channel: str, sender_name: str, sender_id: str) -> str:
    business_name = bot_config.get("business_name", "Servi-Bot")
    bot_name = bot_config.get("bot_name", "Asesor Servi-Bot")
    promo_note = bot_config.get("promo_bundle_note", "")

    catalog_text_lines = []
    for idx, item in enumerate(catalog_items, start=1):
        setup_str = f" (+${item['setup_fee']:,.0f} activación)" if item.get("setup_fee") else ""
        catalog_text_lines.append(
            f"{idx}. {item['name']} [slug: {item['slug']}]: ${item['price']:,.0f} {item['currency']}/{item['billing_cycle']}{setup_str}. {item.get('tagline', '')}"
        )

    catalog_block = "\n".join(catalog_text_lines) if catalog_text_lines else "Sin servicios activos."

    return (
        f"Eres {bot_name} de {business_name} (canal {channel.upper()}). "
        f"Responde en español, breve (máximo 3 oraciones), con tono amable de servicio y enfocado en cerrar la venta.\n"
        f"CATÁLOGO EN SQLITE:\n{catalog_block}\n"
        f"PROMO: {promo_note}\n"
        f"Si el cliente confirma que desea contratar o hacer pedido, confírmale su pedido y escribe al final [PEDIDO: slug]."
    )


def call_ollama_chat(ollama_url: str, model: str, messages: list) -> dict:
    url = f"{ollama_url.rstrip('/')}/api/chat"
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "keep_alive": "60m",
        "options": {
            "temperature": 0.3,
            "num_ctx": 1024,
            "num_predict": 120,
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
        tag_match = re.search(r"\[PEDIDO:\s*([a-z0-9,-]+)\]", content, re.IGNORECASE)
        clean_reply = re.sub(r"\[PEDIDO:[^\]]*\]", "", content, flags=re.IGNORECASE).strip()
        slugs = []
        if tag_match:
            slugs = [s.strip().lower() for s in tag_match.group(1).split(",") if s.strip()]
        return {
            "reply": clean_reply or content,
            "should_create_order": bool(tag_match),
            "selected_slugs": slugs,
        }


def detect_explicit_order_intent(user_text: str, history: list, catalog_items: list) -> tuple:
    """
    Respaldo determinístico en Python por si el modelo 3B omite activar should_create_order
    cuando el usuario explícitamente pide cerrar el pedido.
    """
    text_lower = user_text.lower()
    confirm_Triggers = [
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
    is_confirming = any(t in text_lower for t in confirm_Triggers)
    if not is_confirming:
        return False, []

    combined_context = " ".join([m.get("content", "") for m in history[-4:]] + [user_text]).lower()
    matched = []
    for item in catalog_items:
        slug = item["slug"].lower()
        name_words = [w for w in item["name"].lower().split() if len(w) > 3]
        if slug in combined_context or any(w in combined_context for w in name_words):
            matched.append(item)

    if not matched and catalog_items:
        matched = [catalog_items[0]]

    return True, matched


def process_request(payload: dict) -> dict:
    db_path = payload.get("db_path") or os.path.join(os.path.dirname(__file__), "..", "data", "servibot.db")
    channel = payload.get("channel", "web")
    sender_id = str(payload.get("sender_id", "anon"))
    sender_name = str(payload.get("sender_name", "")).strip()
    user_message = str(payload.get("message", "")).strip()
    ollama_url = payload.get("ollama_url") or "http://127.0.0.1:10002"
    ollama_model = payload.get("ollama_model") or "llama3.2:3b"

    if not user_message:
        return {"ok": False, "error": "Empty message"}

    conn = get_db_connection(db_path)
    try:
        catalog_items, bot_config = load_catalog_and_settings(conn)
        ollama_url = payload.get("ollama_url") or bot_config.get("ollama_host") or "http://127.0.0.1:10002"
        ollama_model = payload.get("ollama_model") or bot_config.get("ollama_model") or "llama3.2:3b"

        conv_id = get_or_create_conversation(conn, channel, sender_id, sender_name, user_message)
        history = fetch_conversation_history(conn, conv_id, limit=8)
        append_message(conn, conv_id, "user", user_message, {"sender_id": sender_id, "channel": channel})

        system_prompt = build_system_prompt(catalog_items, bot_config, channel, sender_name, sender_id)
        ollama_messages = [{"role": "system", "content": system_prompt}]
        for h in history:
            ollama_messages.append({"role": h["role"], "content": h["content"]})
        ollama_messages.append({"role": "user", "content": user_message})

        ai_result = call_ollama_chat(ollama_url, ollama_model, ollama_messages)
        reply_text = str(ai_result.get("reply") or "").strip()
        should_order = bool(ai_result.get("should_create_order", False))
        selected_slugs = ai_result.get("selected_slugs") or []

        # Match items from slugs or deterministic fallback
        slug_map = {item["slug"]: item for item in catalog_items}
        matched_items = [slug_map[s] for s in selected_slugs if s in slug_map]

        if not should_order:
            det_should, det_items = detect_explicit_order_intent(user_message, history, catalog_items)
            if det_should:
                should_order = True
                matched_items = det_items

        if should_order and not matched_items and catalog_items:
            # Match by keywords in user_message or history
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
            notes = str(ai_result.get("notes") or "").strip() or f"Solicitud vía {channel}: {user_message[:200]}"
            created_order = create_order_in_db(
                conn=conn,
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
                f"• Mensualidad Total: *${created_order['total_amount']:,.0f} {created_order['currency']}*\n"
                f"Nuestro equipo ya lo tiene en el Panel de Administración para activación inmediata."
            )
            if created_order["order_code"] not in reply_text:
                reply_text = f"{reply_text}{order_banner}"

        if not reply_text:
            reply_text = (
                "¡Hola! Soy el asesor virtual de Servi-Bot. Contamos con Bots Autónomos para WhatsApp, "
                "Correo y Teams, así como nuestra Interfaz de Catálogo Dinámico. ¿Cuál te gustaría conocer o contratar?"
            )

        append_message(
            conn,
            conv_id,
            "assistant",
            reply_text,
            {
                "order_created": bool(created_order),
                "order_code": created_order["order_code"] if created_order else None,
                "model": ollama_model,
            },
        )

        return {
            "ok": True,
            "channel": channel,
            "sender_id": sender_id,
            "conversation_id": conv_id,
            "reply": reply_text,
            "order_created": bool(created_order),
            "order": created_order,
            "model_used": ollama_model,
            "ollama_port": ollama_url,
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "reply": "Hola, gracias por comunicarte a Servi-Bot. En este instante estoy procesando tu solicitud, ¿me confirmas qué servicio te interesa?",
        }
    finally:
        conn.close()


if __name__ == "__main__":
    raw_in = sys.stdin.read().strip()
    if not raw_in and len(sys.argv) > 1:
        raw_in = sys.argv[1]
    try:
        input_payload = json.loads(raw_in) if raw_in else {}
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    result = process_request(input_payload)
    print(json.dumps(result, ensure_ascii=False))
