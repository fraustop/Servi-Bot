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

  CREATE TABLE IF NOT EXISTS admin_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firebase_uid TEXT DEFAULT '',
    email TEXT UNIQUE NOT NULL,
    display_name TEXT DEFAULT '',
    role TEXT NOT NULL DEFAULT 'admin',
    created_by TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS bot_instances (
    instance_id TEXT PRIMARY KEY,
    slot_number INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    business_name TEXT NOT NULL DEFAULT '',
    client_name TEXT NOT NULL DEFAULT '',
    client_contact TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT 'Ejecutivo, cálido y resolutivo',
    ai_soul TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    welcome_message TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
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

  // Seed 10 independent ServiBot instances if table is empty
  const instCountRow = db.prepare('SELECT COUNT(*) as total FROM bot_instances').get();
  if (instCountRow && instCountRow.total === 0) {
    const insertInstance = db.prepare(`
      INSERT INTO bot_instances (
        instance_id, slot_number, display_name, business_name, client_name, client_contact,
        tone, ai_soul, system_prompt, welcome_message, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const defaultInstances = [
      {
        instance_id: 'servibot-01',
        slot_number: 1,
        display_name: 'ServiBot #01 · Principal',
        business_name: 'Servi-Bot Central',
        tone: 'Consultivo, ejecutivo y persuasivo',
        ai_soul: 'Asesor comercial experto en automatización omnicanal con IA, enfocado en entender el giro del cliente y cerrar citas o ventas sin fricción.',
        system_prompt: 'Prioriza identificar el dolor operativo del cliente, ofrece agendar demostración o activar su bot y responde en máximo 3 párrafos breves.',
        welcome_message: '¡Hola! Soy ServiBot #01. ¿Listo para automatizar la atención y ventas de tu negocio?'
      },
      {
        instance_id: 'servibot-02',
        slot_number: 2,
        display_name: 'ServiBot #02 · Clínica / Salud',
        business_name: 'Espacio Disponible #02',
        tone: 'Empático, profesional y cuidadoso',
        ai_soul: 'Recepcionista médica digital con trato humano y cálido, enfocada en dar tranquilidad al paciente y gestionar citas clínicas.',
        system_prompt: 'Atiende consultas de horarios, especialidades y agendamiento de citas médicas con precisión y empatía.',
        welcome_message: '¡Hola! Bienvenido a nuestra línea de atención y citas. ¿En qué podemos ayudarte hoy?'
      },
      {
        instance_id: 'servibot-03',
        slot_number: 3,
        display_name: 'ServiBot #03 · Inmobiliaria',
        business_name: 'Espacio Disponible #03',
        tone: 'Asesor patrimonial sofisticado y dinámico',
        ai_soul: 'Especialista inmobiliario que perfila presupuesto, zona de interés y agenda visitas guiadas con alto sentido de oportunidad.',
        system_prompt: 'Califica al prospecto preguntando zona, presupuesto e intención (compra o renta) y agenda visita.',
        welcome_message: '¡Hola! Estoy listo para ayudarte a encontrar tu próxima propiedad ideal.'
      },
      {
        instance_id: 'servibot-04',
        slot_number: 4,
        display_name: 'ServiBot #04 · Restaurante / Gastro',
        business_name: 'Espacio Disponible #04',
        tone: 'Anfitrión cordial, ágil y antojadizo',
        ai_soul: 'Anfitrión gastronómico entusiasta que recomienda platillos estrella, confirma reservaciones y toma pedidos rápidamente.',
        system_prompt: 'Ayuda a reservar mesa indicando fecha, hora y número de personas, o sugiere especialidades del menú.',
        welcome_message: '¡Hola! Qué gusto saludarte. ¿Te gustaría reservar una mesa o conocer nuestro menú?'
      },
      {
        instance_id: 'servibot-05',
        slot_number: 5,
        display_name: 'ServiBot #05 · E-Commerce / Retail',
        business_name: 'Espacio Disponible #05',
        tone: 'Personal shopper energético y directo',
        ai_soul: 'Vendedor experto en catálogo digital, tallas, envíos y cierre rápido de carritos de compra.',
        system_prompt: 'Resuelve dudas de disponibilidad y envío al instante e impulsa el cierre de la compra.',
        welcome_message: '¡Hola! ¿Buscas algún producto en especial hoy? Te ayudo a elegir.'
      },
      {
        instance_id: 'servibot-06',
        slot_number: 6,
        display_name: 'ServiBot #06 · Despacho / Legal',
        business_name: 'Espacio Disponible #06',
        tone: 'Formal, confidencial y estructurado',
        ai_soul: 'Asistente jurídico-contable discreto y ordenado que filtra casos urgentes y agenda asesorías.',
        system_prompt: 'Recaba el motivo general de la consulta con total discreción y ofrece horarios de asesoría.',
        welcome_message: 'Buen día. Le atiende nuestro asistente digital. ¿En qué asunto legal o corporativo podemos asistirle?'
      },
      {
        instance_id: 'servibot-07',
        slot_number: 7,
        display_name: 'ServiBot #07 · Fitness / Wellness',
        business_name: 'Espacio Disponible #07',
        tone: 'Motivador, cercano y positivo',
        ai_soul: 'Coach de bienvenida que inspira a iniciar un estilo de vida saludable y agenda clases muestra.',
        system_prompt: 'Invita al usuario a conocer planes de entrenamiento y agendar su clase de prueba.',
        welcome_message: '¡Hola! Qué gran paso escribirnos hoy. ¿Agendamos tu sesión de valoración?'
      },
      {
        instance_id: 'servibot-08',
        slot_number: 8,
        display_name: 'ServiBot #08 · Educación / Academia',
        business_name: 'Espacio Disponible #08',
        tone: 'Orientador académico claro e inspirador',
        ai_soul: 'Consejero educativo que guía a estudiantes y padres sobre programas, inscripciones y becas.',
        system_prompt: 'Identifica el curso de interés del aspirante y comparte requisitos e inicio de clases.',
        welcome_message: '¡Hola! Bienvenido a admisiones. ¿Qué programa o curso te interesa conocer?'
      },
      {
        instance_id: 'servibot-09',
        slot_number: 9,
        display_name: 'ServiBot #09 · Automotriz / Taller',
        business_name: 'Espacio Disponible #09',
        tone: 'Técnico, confiable y transparente',
        ai_soul: 'Asesor de servicio automotriz que transmite confianza técnica, cotiza mantenimientos y agenda ingreso a taller.',
        system_prompt: 'Solicita marca, modelo y año del vehículo para cotizar servicio o agendar cita en bahía.',
        welcome_message: '¡Hola! Te ayudamos con el mantenimiento o revisión de tu auto. ¿Qué modelo tienes?'
      },
      {
        instance_id: 'servibot-10',
        slot_number: 10,
        display_name: 'ServiBot #10 · Personalizado',
        business_name: 'Espacio Disponible #10',
        tone: 'Versátil, adaptable y centrado en el cliente',
        ai_soul: 'Agente autónomo listo para moldear su personalidad, esencia y reglas de negocio al 100% según la marca del cliente.',
        system_prompt: 'Adapta tu conversación al giro configurado por el cliente, resuelve dudas y agenda citas.',
        welcome_message: '¡Hola! Soy tu ServiBot personalizado. ¿Cómo puedo ayudarte hoy?'
      }
    ];

    for (const inst of defaultInstances) {
      insertInstance.run(
        inst.instance_id,
        inst.slot_number,
        inst.display_name,
        inst.business_name,
        '',
        '',
        inst.tone,
        inst.ai_soul,
        inst.system_prompt,
        inst.welcome_message,
        1
      );
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
