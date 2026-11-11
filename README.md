# 🤖 Servi-Bot — Plataforma de Bots Autónomos Multicanal + Catálogo Dinámico

**Servi-Bot** es una solución completa de negocio digital para comercializar e implementar agentes de IA autónomos que atienden y cierran ventas automáticamente en **WhatsApp**, **Correo Electrónico (IMAP/SMTP)** y **Microsoft Teams**, conectados en tiempo real a un **Catálogo Dinámico** y un **Panel de Administración** protegido con **Firebase Authentication**.

---

## 🏗️ Arquitectura de Puertos y Servicios

| Servicio | Puerto Local | Tecnología | Descripción |
| :--- | :---: | :--- | :--- |
| **Servidor Principal & API** | `10000` | Node.js + Express + `node:sqlite` | API REST del catálogo, pedidos, panel admin, conectores IMAP/SMTP y Teams, y disparador de workers Python. |
| **Evolution API Engine (WhatsApp)** | `10001` | `@whiskeysockets/baileys` (Gratis / Sin Tokens) | Servidor de WhatsApp multidispositivo con generación de QR en vivo y envío de webhooks al puerto `10000`. |
| **Motor IA Local (Ollama)** | `10002` | Ollama (`llama3.2:3b`) | Servicio de inferencia local sin costo por token consultado a demanda por el agente en Python. |
| **Worker de Ventas a Demanda** | Subproceso | Python 3 (`python_workers/sales_agent.py`) | Consulta el catálogo en SQLite, conversa con tono de servicio, detecta intención de compra y registra pedidos en `orders`. |
| **Túnel Público HTTPS** | Dinámico / Token | Cloudflare Tunnel (`cloudflared`) | Expone el puerto `10000` en HTTPS para conectar la interfaz de Firebase Hosting con tu servidor local. |

---

## 📦 Servicios Semilla Incluidos en SQLite (`data/servibot.db`)

1. **Bots Autónomos Multicanal (WhatsApp, Correo y Teams)**
   - **Precio comercial recomendado**: `$2,490 MXN / mes` (+ `$3,500 MXN` de activación única).
2. **Interfaz de Catálogo Dinámico + Panel Admin Cloud**
   - **Precio comercial recomendado**: `$1,490 MXN / mes` (+ `$2,000 MXN` de activación única).

---

## 🚀 Ejecución y Despliegue

```bash
# Iniciar todos los servicios (Node :10000, Evolution :10001, Ollama :10002 y Cloudflare Tunnel)
npm start

# Desplegar Frontend y Auth a Firebase Hosting (Proyecto: servi-bot-cic)
npm run deploy:hosting
```
