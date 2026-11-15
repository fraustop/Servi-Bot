const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SUPERADMIN_EMAIL = 'fraustop@outlook.com';
const TOTAL_CLIENT_SLOTS = 50;

const DATA_DIR = process.env.SERVIBOT_DATA_DIR
  ? path.resolve(process.env.SERVIBOT_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const BOTS_DB_DIR = path.join(DATA_DIR, 'bots');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(BOTS_DB_DIR)) {
  fs.mkdirSync(BOTS_DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'servibot.db');
const PROSPECTS_DB_PATH = path.join(DATA_DIR, 'prospects.db');

const db = new DatabaseSync(DB_PATH);
const prospectsDb = new DatabaseSync(PROSPECTS_DB_PATH);
const botDbCache = new Map();

function ensureColumn(conn, tableName, colName, definitionSql) {
  const cols = conn.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some((c) => c.name === colName)) {
    conn.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${definitionSql};`);
  }
}

function formatSlotId(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return 'servibot-00';
  const clamped = Math.min(TOTAL_CLIENT_SLOTS, Math.max(1, Math.trunc(n)));
  return `servibot-${String(clamped).padStart(2, '0')}`;
}

function normalizeInstanceIdKey(rawName) {
  const raw = String(rawName || '').trim().toLowerCase();
  if (
    !raw ||
    raw === 'servibot-00' ||
    raw === 'servibot-0' ||
    raw === '0' ||
    raw === '00' ||
    raw === 'bot-0' ||
    raw === 'servibot-main' ||
    raw === 'main' ||
    raw === 'default'
  ) {
    return 'servibot-00';
  }
  const fullMatch = raw.match(/^servibot-(\d{1,2})$/);
  if (fullMatch) {
    return formatSlotId(Number(fullMatch[1]));
  }
  const numMatch = raw.match(/^(\d{1,2})$/);
  if (numMatch) {
    return formatSlotId(Number(numMatch[1]));
  }
  return 'servibot-00';
}

function getBotDbPath(instanceId) {
  const canonical = normalizeInstanceIdKey(instanceId);
  return path.join(BOTS_DB_DIR, `${canonical}.db`);
}

function normalizeContactValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.includes('@s.whatsapp.net') || raw.includes('@c.us') || raw.includes('@lid')) {
    const bare = raw.split('@')[0];
    const digits = bare.replace(/\D/g, '');
    return digits || bare.toLowerCase();
  }
  if (raw.includes('@')) {
    return raw.toLowerCase();
  }
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 7) {
    return digits;
  }
  return raw.toLowerCase();
}

function contactsMatch(a, b) {
  const na = normalizeContactValue(a);
  const nb = normalizeContactValue(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (/^\d{10,}$/.test(na) && /^\d{10,}$/.test(nb)) {
    return na.slice(-10) === nb.slice(-10);
  }
  return false;
}

// ==================== ESQUEMA CENTRAL (ORQUESTACIÓN MAESTRA) ====================
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

  CREATE TABLE IF NOT EXISTS admin_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firebase_uid TEXT DEFAULT '',
    email TEXT UNIQUE NOT NULL,
    display_name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'client_admin',
    assigned_instance_id TEXT NOT NULL DEFAULT 'servibot-01',
    subscription_expires_at TEXT DEFAULT NULL,
    created_by TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS bot_instances (
    instance_id TEXT PRIMARY KEY,
    slot_number INTEGER NOT NULL,
    tier TEXT NOT NULL DEFAULT 'standard',
    display_name TEXT NOT NULL,
    business_name TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL DEFAULT '',
    client_contact TEXT NOT NULL DEFAULT '',
    admin_email TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT 'Profesional, cálido y orientado a resultados',
    ai_soul TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    welcome_message TEXT NOT NULL DEFAULT '',
    db_file TEXT NOT NULL DEFAULT '',
    paid_status TEXT NOT NULL DEFAULT 'unpaid',
    paid_at TEXT DEFAULT NULL,
    subscription_expires_at TEXT DEFAULT NULL,
    locked_for_public INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS vip_instances (
    folio TEXT PRIMARY KEY,
    business_name TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL DEFAULT '',
    client_contact TEXT NOT NULL DEFAULT '',
    admin_email TEXT NOT NULL DEFAULT '',
    dedicated_server_url TEXT NOT NULL DEFAULT '',
    custom_admin_url TEXT NOT NULL DEFAULT '',
    custom_api_config_json TEXT NOT NULL DEFAULT '{}',
    monthly_price REAL NOT NULL DEFAULT 5000,
    currency TEXT NOT NULL DEFAULT 'MXN',
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS order_registry (
    order_code TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    customer_name TEXT DEFAULT '',
    customer_contact TEXT DEFAULT '',
    customer_company TEXT DEFAULT '',
    admin_email TEXT DEFAULT '',
    temp_password TEXT DEFAULT '',
    subtotal_amount REAL NOT NULL DEFAULT 0,
    tax_amount REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'MXN',
    status TEXT NOT NULL DEFAULT 'pending',
    mp_preference_id TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

// Migraciones seguras en bases preexistentes
ensureColumn(db, 'bot_instances', 'tier', "TEXT NOT NULL DEFAULT 'standard'");
ensureColumn(db, 'bot_instances', 'admin_email', "TEXT NOT NULL DEFAULT ''");
ensureColumn(db, 'bot_instances', 'db_file', "TEXT NOT NULL DEFAULT ''");
ensureColumn(db, 'bot_instances', 'paid_status', "TEXT NOT NULL DEFAULT 'unpaid'");
ensureColumn(db, 'bot_instances', 'paid_at', 'TEXT DEFAULT NULL');
ensureColumn(db, 'bot_instances', 'subscription_expires_at', 'TEXT DEFAULT NULL');
ensureColumn(db, 'bot_instances', 'locked_for_public', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn(db, 'bot_instances', 'quick_options_json', "TEXT NOT NULL DEFAULT '[]'");

ensureColumn(prospectsDb, 'prospects', 'quick_options_json', "TEXT NOT NULL DEFAULT '[]'");

ensureColumn(db, 'admin_accounts', 'assigned_instance_id', "TEXT NOT NULL DEFAULT 'servibot-01'");
ensureColumn(db, 'admin_accounts', 'subscription_expires_at', 'TEXT DEFAULT NULL');

// ==================== BASE DE DATOS DE PROSPECTOS (ROTACIÓN 1..50) ====================
prospectsDb.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS prospects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_key TEXT NOT NULL,
    client_name TEXT DEFAULT '',
    client_contact TEXT DEFAULT '',
    business_name TEXT DEFAULT '',
    display_name TEXT DEFAULT '',
    tone TEXT DEFAULT '',
    ai_soul TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    welcome_message TEXT DEFAULT '',
    previous_instance_id TEXT DEFAULT '',
    previous_slot_number INTEGER DEFAULT 0,
    catalog_snapshot_json TEXT NOT NULL DEFAULT '[]',
    promotions_snapshot_json TEXT NOT NULL DEFAULT '[]',
    archived_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_prospects_contact_key ON prospects(contact_key);
`);

// ==================== BASES DE DATOS AISLADAS POR BOT ====================
function initBotDbSchema(conn) {
  conn.exec(`
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

    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);

  ensureColumn(conn, 'catalog_items', 'sent_to_bot', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(conn, 'promotions', 'sent_to_bot', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(conn, 'orders', 'instance_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(conn, 'conversations', 'is_priority', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(conn, 'conversations', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(conn, 'messages', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
}

function seedBot0Database(conn) {
  const total = conn.prepare('SELECT COUNT(*) as c FROM catalog_items').get()?.c || 0;
  if (total > 0) return;

  const insert = conn.prepare(`
    INSERT INTO catalog_items (
      slug, type, name, tagline, description, price, currency, billing_cycle,
      setup_fee, features_json, image_url, badge, active, sent_to_bot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // ÚNICAMENTE los 3 servicios solicitados para Bot 0 (sin promociones preincluidas)
  insert.run(
    'servicio-bot-mensual',
    'service',
    'Servicio de Bot Configurado',
    'Costo mensual de $1,500 MXN más impuestos',
    'Servicio de bot autónomo personalizado para tu negocio con atención inteligente, seguimiento a clientes y operación directa en tu instancia por $1,500 pesos mensuales más impuestos.',
    1500,
    'MXN',
    'mensual',
    0,
    JSON.stringify([
      'Bot autónomo configurado a la medida de tu negocio',
      'Costo mensual de $1,500 pesos más impuestos',
      'Operación aislada en su propia base de datos'
    ]),
    '/assets/service-bots.svg',
    'Base',
    1,
    1
  );

  insert.run(
    'pagina-web-reconfiguracion',
    'service',
    'Página Web con Reconfiguración Mensual',
    'Costo mensual de $300 MXN más impuestos',
    'Página web profesional para tu negocio con reconfiguración mensual incluida por $300 pesos mensuales más impuestos.',
    300,
    'MXN',
    'mensual',
    0,
    JSON.stringify([
      'Página web optimizada para convertir visitantes',
      'Reconfiguración mensual incluida',
      'Costo mensual de $300 pesos más impuestos'
    ]),
    '/assets/service-catalog.svg',
    'Web',
    1,
    1
  );

  insert.run(
    'soporte-tecnico-24-7',
    'service',
    'Soporte Técnico y Entrenamiento 24/7',
    'Costo adicional de $200 MXN al mes más impuestos',
    'Incluye apoyo con su página y los servicios contratados, ajustes menores en su página y apoyo 24/7 de nuestro bot para entrenar a su bot personalizado por $200 pesos adicionales al mes más impuestos.',
    200,
    'MXN',
    'mensual',
    0,
    JSON.stringify([
      'Apoyo continuo con tu página y los servicios contratados',
      'Ajustes menores mensuales en tu página web',
      'Apoyo 24/7 de nuestro bot para entrenar a tu bot personalizado',
      '$200 pesos adicionales al mes más impuestos'
    ]),
    '/assets/service-bots.svg',
    'Soporte 24/7',
    1,
    1
  );
}

function getBotDb(rawInstanceId) {
  const instanceId = normalizeInstanceIdKey(rawInstanceId);
  if (botDbCache.has(instanceId)) {
    return botDbCache.get(instanceId);
  }
  const dbFile = getBotDbPath(instanceId);
  const conn = new DatabaseSync(dbFile);
  initBotDbSchema(conn);
  if (instanceId === 'servibot-00') {
    seedBot0Database(conn);
  }
  botDbCache.set(instanceId, conn);
  return conn;
}

function resetBotDb(rawInstanceId) {
  const instanceId = normalizeInstanceIdKey(rawInstanceId);
  if (instanceId === 'servibot-00') {
    throw new Error('La base de datos de Bot 0 no puede reiniciarse mediante rotación.');
  }
  const cached = botDbCache.get(instanceId);
  if (cached) {
    try {
      cached.close();
    } catch {
      // ignore close failure
    }
    botDbCache.delete(instanceId);
  }
  const basePath = getBotDbPath(instanceId);
  for (const suffix of ['', '-wal', '-shm']) {
    const candidate = `${basePath}${suffix}`;
    if (fs.existsSync(candidate)) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch {
        // ignore lock on removal
      }
    }
  }
  return getBotDb(instanceId);
}

function archiveInstanceToProspects(instanceRow) {
  if (!instanceRow || instanceRow.slot_number === 0 || instanceRow.instance_id === 'servibot-00') {
    return null;
  }
  const clientName = String(instanceRow.client_name || '').trim();
  const clientContact = String(instanceRow.client_contact || '').trim();
  const businessName = String(instanceRow.business_name || '').trim();
  const isDefaultSlot = businessName.startsWith('Espacio Disponible') && !clientName && !clientContact;
  if (isDefaultSlot || (!clientName && !clientContact && !businessName)) {
    return null;
  }

  const contactKey = normalizeContactValue(clientContact || clientName || businessName);
  let catalogSnapshot = [];
  let promotionsSnapshot = [];
  try {
    const botDb = getBotDb(instanceRow.instance_id);
    catalogSnapshot = botDb.prepare('SELECT * FROM catalog_items ORDER BY id ASC').all();
    promotionsSnapshot = botDb.prepare('SELECT * FROM promotions ORDER BY id ASC').all();
  } catch {
    // keep empty snapshots if unreadable
  }

  const existing = prospectsDb
    .prepare('SELECT id FROM prospects WHERE contact_key = ? ORDER BY id DESC LIMIT 1')
    .get(contactKey);

  if (existing) {
    prospectsDb
      .prepare(`
        UPDATE prospects SET
          client_name = ?,
          client_contact = ?,
          business_name = ?,
          display_name = ?,
          tone = ?,
          ai_soul = ?,
          system_prompt = ?,
          welcome_message = ?,
          previous_instance_id = ?,
          previous_slot_number = ?,
          catalog_snapshot_json = ?,
          promotions_snapshot_json = ?,
          archived_at = datetime('now', 'localtime'),
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `)
      .run(
        clientName,
        clientContact,
        businessName,
        instanceRow.display_name || '',
        instanceRow.tone || '',
        instanceRow.ai_soul || '',
        instanceRow.system_prompt || '',
        instanceRow.welcome_message || '',
        instanceRow.instance_id,
        Number(instanceRow.slot_number || 0),
        JSON.stringify(catalogSnapshot),
        JSON.stringify(promotionsSnapshot),
        existing.id
      );
    return existing.id;
  }

  const res = prospectsDb
    .prepare(`
      INSERT INTO prospects (
        contact_key, client_name, client_contact, business_name, display_name,
        tone, ai_soul, system_prompt, welcome_message,
        previous_instance_id, previous_slot_number,
        catalog_snapshot_json, promotions_snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      contactKey,
      clientName,
      clientContact,
      businessName,
      instanceRow.display_name || '',
      instanceRow.tone || '',
      instanceRow.ai_soul || '',
      instanceRow.system_prompt || '',
      instanceRow.welcome_message || '',
      instanceRow.instance_id,
      Number(instanceRow.slot_number || 0),
      JSON.stringify(catalogSnapshot),
      JSON.stringify(promotionsSnapshot)
    );
  return res.lastInsertRowid;
}

function restoreProspectIntoBot(targetInstanceId, prospectRow) {
  if (!prospectRow) return;
  const botDb = resetBotDb(targetInstanceId);
  let catalogItems = [];
  let promotions = [];
  try {
    catalogItems = JSON.parse(prospectRow.catalog_snapshot_json || '[]');
  } catch {
    catalogItems = [];
  }
  try {
    promotions = JSON.parse(prospectRow.promotions_snapshot_json || '[]');
  } catch {
    promotions = [];
  }

  const insertItem = botDb.prepare(`
    INSERT OR IGNORE INTO catalog_items (
      slug, type, name, tagline, description, price, currency, billing_cycle,
      setup_fee, features_json, image_url, badge, active, sent_to_bot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const it of catalogItems) {
    if (!it || !it.name) continue;
    insertItem.run(
      it.slug || `item-${Date.now()}`,
      it.type || 'service',
      it.name,
      it.tagline || '',
      it.description || it.name,
      Number(it.price || 0),
      it.currency || 'MXN',
      it.billing_cycle || 'mensual',
      Number(it.setup_fee || 0),
      it.features_json || JSON.stringify(it.features || []),
      it.image_url || '/assets/service-bots.svg',
      it.badge || '',
      it.active === 0 ? 0 : 1,
      it.sent_to_bot === 0 ? 0 : 1
    );
  }

  const insertPromo = botDb.prepare(`
    INSERT INTO promotions (title, description, discount_text, price, currency, active, sent_to_bot)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const pr of promotions) {
    if (!pr || !pr.title) continue;
    insertPromo.run(
      pr.title,
      pr.description || '',
      pr.discount_text || '',
      pr.price !== null && pr.price !== undefined ? Number(pr.price) : null,
      pr.currency || 'MXN',
      pr.active === 0 ? 0 : 1,
      pr.sent_to_bot === 0 ? 0 : 1
    );
  }
}

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

function getBotSetting(rawInstanceId, key, fallback = {}) {
  const botDb = getBotDb(rawInstanceId);
  const row = botDb.prepare('SELECT value_json FROM bot_settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return fallback;
  }
}

function setBotSetting(rawInstanceId, key, valueObj) {
  const botDb = getBotDb(rawInstanceId);
  botDb.prepare(`
    INSERT INTO bot_settings (key, value_json, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = datetime('now', 'localtime')
  `).run(key, JSON.stringify(valueObj));
  return valueObj;
}

function seedDatabase() {
  const defaultSettings = {
    bot_config: {
      business_name: 'Proyecto Cero · Servi-Bot',
      bot_name: 'ServiBot #00 · Proyecto Cero',
      tone: 'Consultivo, ejecutivo, claro y estricto con la información oficial',
      ollama_host: 'http://127.0.0.1:10002',
      ollama_model: 'llama3.2:3b',
      evolution_url: 'http://127.0.0.1:10001',
      evolution_instance: 'servibot-00',
      auto_reply_whatsapp: true,
      auto_reply_email: true,
      auto_reply_teams: true,
      promo_bundle_note: ''
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
    telegram_config: {
      enabled: false,
      bot_name: 'Servi-Bot Telegram',
      bot_username: '',
      bot_token: '',
      notify_new_orders: true
    },
    instagram_config: {
      enabled: false,
      account_username: '',
      access_token: '',
      auto_reply_comments: true
    },
    tiktok_config: {
      enabled: false,
      account_username: '',
      client_key: '',
      auto_reply_comments: true
    },
    tunnel_config: {
      enabled: true,
      mode: 'quick',
      tunnel_token: '',
      public_url: ''
    },
    instance_pool_cursor: {
      last_recycled_slot: 0
    }
  };

  const getSettingStmt = db.prepare('SELECT key FROM settings WHERE key = ?');
  const insertSettingStmt = db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings)) {
    if (!getSettingStmt.get(k)) {
      insertSettingStmt.run(k, JSON.stringify(v));
    }
  }

  // Limpiar nota promocional antigua heredada para no inyectar precios ni promos no autorizadas en Bot 0
  const currentBotCfg = getSetting('bot_config', {});
  if (currentBotCfg && (String(currentBotCfg.promo_bundle_note || '').includes('3,380') || currentBotCfg.evolution_instance === 'servibot-main')) {
    setSetting('bot_config', {
      ...currentBotCfg,
      business_name: 'Proyecto Cero · Servi-Bot',
      bot_name: 'ServiBot #00 · Proyecto Cero',
      evolution_instance: 'servibot-00',
      promo_bundle_note: ''
    });
  }

  // Sembrar cuenta superadmin Admin 0 (fraustop@outlook.com)
  db.prepare(`
    INSERT INTO admin_accounts (email, display_name, role, assigned_instance_id, created_by)
    VALUES (?, 'Administrador Principal (Bot 0)', 'superadmin', 'servibot-00', 'system')
    ON CONFLICT(email) DO UPDATE SET
      role = 'superadmin',
      assigned_instance_id = 'servibot-00'
  `).run(SUPERADMIN_EMAIL);

  const bot0Config = {
    instance_id: 'servibot-00',
    slot_number: 0,
    tier: 'official',
    display_name: 'ServiBot #00 · Proyecto Cero',
    business_name: 'Proyecto Cero · Servi-Bot',
    tone: 'Consultivo, ejecutivo, claro y estricto con la información oficial',
    ai_soul:
      'Asesor oficial de Proyecto Cero (Servi-Bot). Atiende exclusivamente preguntas relacionadas con el Proyecto Cero y los servicios registrados en el catálogo de su interfaz.',
    system_prompt:
      'REGLAS ESTRICTAS: 1) Solo debes contestar preguntas relacionadas con el Proyecto Cero (Servi-Bot). Si te preguntan algo ajeno al Proyecto Cero, indica amablemente que solo atiendes consultas del Proyecto Cero. 2) Prohibido inventar ofertas, descuentos, paquetes o servicios. 3) Limítate siempre y únicamente a dar la información del catálogo y promociones activas creadas en la interfaz.',
    welcome_message:
      '¡Hola! Soy el asistente oficial de Proyecto Cero (Servi-Bot). ¿Te gustaría conocer nuestro servicio de bot, página web o soporte técnico?'
  };

  db.prepare(`
    INSERT INTO bot_instances (
      instance_id, slot_number, tier, display_name, business_name, client_name, client_contact,
      admin_email, tone, ai_soul, system_prompt, welcome_message, db_file, paid_status, locked_for_public, active
    ) VALUES (?, 0, 'official', ?, ?, '', '', ?, ?, ?, ?, ?, ?, 'official', 0, 1)
    ON CONFLICT(instance_id) DO UPDATE SET
      slot_number = 0,
      tier = 'official',
      admin_email = excluded.admin_email,
      db_file = excluded.db_file
  `).run(
    bot0Config.instance_id,
    bot0Config.display_name,
    bot0Config.business_name,
    SUPERADMIN_EMAIL,
    bot0Config.tone,
    bot0Config.ai_soul,
    bot0Config.system_prompt,
    bot0Config.welcome_message,
    getBotDbPath('servibot-00')
  );

  // Si servibot-00 aún tiene campos genéricos vacíos, asegurar su configuración oficial
  const currentBot0 = db.prepare("SELECT * FROM bot_instances WHERE instance_id = 'servibot-00'").get();
  if (currentBot0 && !currentBot0.ai_soul) {
    db.prepare(`
      UPDATE bot_instances SET display_name = ?, business_name = ?, tone = ?, ai_soul = ?, system_prompt = ?, welcome_message = ?
      WHERE instance_id = 'servibot-00'
    `).run(
      bot0Config.display_name,
      bot0Config.business_name,
      bot0Config.tone,
      bot0Config.ai_soul,
      bot0Config.system_prompt,
      bot0Config.welcome_message
    );
  }

  // Convertir antiguo servibot-01 semilla ("Servi-Bot Central") en espacio libre de clientes si nunca fue configurado por cliente
  const oldSlot1 = db.prepare("SELECT * FROM bot_instances WHERE instance_id = 'servibot-01'").get();
  if (oldSlot1 && oldSlot1.business_name === 'Servi-Bot Central' && !String(oldSlot1.client_name || '').trim()) {
    db.prepare(`
      UPDATE bot_instances SET
        tier = 'standard',
        display_name = 'ServiBot #01 · Disponible',
        business_name = 'Espacio Disponible #01',
        tone = 'Profesional, cálido y orientado a resultados',
        ai_soul = '',
        system_prompt = '',
        welcome_message = '¡Hola! Soy tu ServiBot #01. ¿Cómo puedo ayudarte hoy?',
        db_file = ?
      WHERE instance_id = 'servibot-01'
    `).run(getBotDbPath('servibot-01'));
  }

  // Asegurar las 50 instancias (servibot-01 .. servibot-50)
  const insertClientSlot = db.prepare(`
    INSERT OR IGNORE INTO bot_instances (
      instance_id, slot_number, tier, display_name, business_name, client_name, client_contact,
      admin_email, tone, ai_soul, system_prompt, welcome_message, db_file, paid_status, locked_for_public, active
    ) VALUES (?, ?, 'standard', ?, ?, '', '', '', 'Profesional, cálido y orientado a resultados', '', '', ?, ?, 'unpaid', 0, 1)
  `);

  const setDbFileStmt = db.prepare("UPDATE bot_instances SET db_file = ? WHERE instance_id = ? AND (db_file IS NULL OR db_file = '')");

  for (let slot = 1; slot <= TOTAL_CLIENT_SLOTS; slot += 1) {
    const instanceId = formatSlotId(slot);
    insertClientSlot.run(
      instanceId,
      slot,
      `ServiBot #${String(slot).padStart(2, '0')} · Disponible`,
      `Espacio Disponible #${String(slot).padStart(2, '0')}`,
      `¡Hola! Soy tu ServiBot #${String(slot).padStart(2, '0')}. ¿Cómo puedo ayudarte hoy?`,
      getBotDbPath(instanceId)
    );
    setDbFileStmt.run(getBotDbPath(instanceId), instanceId);
  }

  // Inicializar de inmediato la BD aislada de Bot 0 con exactamente los 3 servicios solicitados
  getBotDb('servibot-00');
}

seedDatabase();

module.exports = {
  db,
  prospectsDb,
  DB_PATH,
  PROSPECTS_DB_PATH,
  BOTS_DB_DIR,
  SUPERADMIN_EMAIL,
  TOTAL_CLIENT_SLOTS,
  formatSlotId,
  normalizeInstanceIdKey,
  normalizeContactValue,
  contactsMatch,
  getBotDbPath,
  getBotDb,
  resetBotDb,
  archiveInstanceToProspects,
  restoreProspectIntoBot,
  getSetting,
  setSetting,
  getBotSetting,
  setBotSetting
};
