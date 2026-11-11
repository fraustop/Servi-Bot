const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'servibot.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

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
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT UNIQUE NOT NULL,
    customer_name TEXT NOT NULL,
    customer_contact TEXT NOT NULL,
    customer_company TEXT DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'whatsapp',
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE(channel, sender_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

function seedDatabase() {
  const countRow = db.prepare('SELECT COUNT(*) as total FROM catalog_items').get();
  if (countRow && countRow.total === 0) {
    const insertItem = db.prepare(`
      INSERT INTO catalog_items (
        slug, type, name, tagline, description, price, currency, billing_cycle, setup_fee, features_json, image_url, badge, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertItem.run(
      'bots-autonomos',
      'service',
      'Bots Autónomos Multicanal (WhatsApp, Correo y Teams)',
      'Atención, cotización y cierre de ventas 24/7 sin costo por token',
      'Servicio integral de agentes autónomos impulsados por IA local (Ollama) y motor Python a demanda. Contesta automáticamente mensajes de WhatsApp (vía Evolution API sin cargos por mensaje), correos electrónicos empresariales (IMAP/SMTP) y canales de Microsoft Teams. El bot conoce todo tu inventario en tiempo real, asesora con tono cálido de servicio, resuelve objeciones y registra los pedidos cerrados directamente en tu panel administrativo.',
      2490,
      'MXN',
      'mensual',
      3500,
      JSON.stringify([
        'Autocontestador WhatsApp con Evolution API (0 costo de tokens)',
        'Respuesta automática de Correos Electrónicos (IMAP/SMTP) con contexto de hilo',
        'Integración nativa con Microsoft Teams para atención corporativa',
        'Motor IA local con Ollama (llama3.2:3b) + Procesamiento Python a demanda',
        'Cierre automático de ventas y generación de pedidos en tiempo real',
        'Entrenamiento dinámico conectado a tu catálogo de productos y servicios'
      ]),
      '/assets/service-bots.svg',
      'Más Vendido',
      1
    );

    insertItem.run(
      'interfaz-catalogo-dinamico',
      'service',
      'Interfaz de Catálogo Dinámico + Panel Admin Cloud',
      'Escaparate digital en Firebase Hosting conectado a tu bot vendedor',
      'Plataforma web comercial de alta conversión desplegada en Firebase Hosting con seguridad Firebase Authentication. Permite a cualquier negocio exhibir sus servicios y productos con imágenes, precios, planes y especificaciones técnicas, mientras el Panel de Administración permite dar de alta nuevos artículos al instante, gestionar pedidos capturados por el bot y monitorear los canales de comunicación.',
      1490,
      'MXN',
      'mensual',
      2000,
      JSON.stringify([
        'Página pública responsiva de alta velocidad en Firebase Hosting',
        'Panel de Administración protegido con Firebase Auth (Email y Google)',
        'Alta y edición dinámica de productos/servicios con galería de imágenes',
        'Sincronización inmediata entre la web y la memoria del Bot Vendedor',
        'Tablero de control de pedidos (WhatsApp, Correo, Teams y Web)',
        'Widget interactivo de chat en vivo integrado en la página pública'
      ]),
      '/assets/service-catalog.svg',
      'Esencial para Negocios',
      1
    );
  }

  // Seed default settings if not present
  const defaultSettings = {
    bot_config: {
      business_name: 'Servi-Bot',
      bot_name: 'Asesor Servi-Bot',
      tone: 'Profesional, consultivo, amable y enfocado en ayudar al cliente y cerrar la venta.',
      ollama_host: 'http://127.0.0.1:10002',
      ollama_model: 'llama3.2:3b',
      evolution_url: 'http://127.0.0.1:10001',
      evolution_instance: 'servibot-main',
      auto_reply_whatsapp: true,
      auto_reply_email: true,
      auto_reply_teams: true,
      promo_bundle_note: 'Paquete Completo Servi-Bot (Bots Autónomos + Interfaz de Catálogo Dinámico) con 15% de descuento: $3,380 MXN/mes.'
    },
    email_config: {
      enabled: false,
      imap_host: 'imap.gmail.com',
      imap_port: 993,
      imap_secure: true,
      smtp_host: 'smtp.gmail.com',
      smtp_port: 465,
      smtp_secure: true,
      user: '',
      pass: '',
      from_name: 'Servi-Bot Atención Automática',
      poll_interval_sec: 45
    },
    teams_config: {
      enabled: true,
      bot_display_name: 'Servi-Bot Teams',
      incoming_webhook_url: '',
      outgoing_webhook_secret: '',
      notify_new_orders: true
    },
    tunnel_config: {
      enabled: true,
      mode: 'quick',
      tunnel_token: '',
      public_url: ''
    }
  };

  const getSettingStmt = db.prepare('SELECT key FROM settings WHERE key = ?');
  const insertSettingStmt = db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)');

  for (const [k, v] of Object.entries(defaultSettings)) {
    if (!getSettingStmt.get(k)) {
      insertSettingStmt.run(k, JSON.stringify(v));
    }
  }
}

seedDatabase();

function getSetting(key, fallback = {}) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return fallback;
  }
}

function setSetting(key, valueObj) {
  db.prepare(`
    INSERT INTO settings (key, value_json, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = datetime('now', 'localtime')
  `).run(key, JSON.stringify(valueObj));
  return valueObj;
}

module.exports = {
  db,
  DB_PATH,
  getSetting,
  setSetting
};
