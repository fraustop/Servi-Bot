const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { db, DB_PATH, getSetting, setSetting } = require('./db');
const {
  OLLAMA_PORT,
  WORKER_PORT,
  resolvePythonExecutable,
  buildWorkerEnv,
  ensureOllamaOnPort10002,
  getOllamaStatus
} = require('./ollama_service');
const { EVOLUTION_PORT, INSTANCE_IDS, resolveInstanceId, startEvolutionServer } = require('./evolution_server');
const {
  startEmailPolling,
  pollImapOnce,
  simulateIncomingEmail,
  getEmailWorkerStatus
} = require('./channels/email_worker');
const {
  handleTeamsWebhook,
  notifyTeamsIncomingWebhook,
  getTeamsChannelStatus
} = require('./channels/teams_handler');
const { startCloudflareTunnel, getTunnelStatus } = require('./tunnel_manager');

const PORT = Number(process.env.PORT || 10000);
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCZm5qX98Y8ww4ksJWX-xQs6deaSQojhHk';
const FIREBASE_PROJECT_ID = 'servi-bot-cic';

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * Ejecuta de forma asíncrona el agente de ventas mediante el worker persistente (puerto 10003)
 * conectado a Amazon Bedrock, con respaldo automático a subproceso Python bajo demanda.
 */
async function runPythonSalesAgent({
  channel = 'web',
  sender_id = 'anon',
  sender_name = '',
  message = '',
  instance_id = 'servibot-01'
}) {
  const botCfg = getSetting('bot_config', {});
  const canonicalInstance = resolveInstanceId(instance_id);
  const payload = {
    db_path: DB_PATH,
    channel,
    sender_id,
    sender_name,
    message,
    instance_id: canonicalInstance,
    ollama_url: botCfg.ollama_host || `http://127.0.0.1:${OLLAMA_PORT}`,
    ollama_model: botCfg.ollama_model || 'llama3.2:3b',
    ai_provider: botCfg.ai_provider || process.env.AI_PROVIDER || 'bedrock',
    bedrock_model: botCfg.bedrock_model || process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-micro-v1:0',
    aws_region: botCfg.aws_region || process.env.AWS_REGION || 'us-east-2'
  };

  try {
    const resp = await fetch(`http://127.0.0.1:${WORKER_PORT}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45000)
    });
    if (resp.ok) {
      return await resp.json();
    }
  } catch (err) {
    console.warn(`[AsyncWorker] Puerto ${WORKER_PORT} no disponible (${err.message}); usando respaldo CLI.`);
  }

  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, '..', 'python_workers', 'sales_agent.py');
    const pythonBin = resolvePythonExecutable();
    const py = spawn(pythonBin, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildWorkerEnv()
    });

    let stdoutData = '';
    let stderrData = '';

    py.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString('utf8');
    });

    py.stderr.on('data', (chunk) => {
      stderrData += chunk.toString('utf8');
    });

    py.on('error', (err) => {
      console.error('[PythonWorker] Error al iniciar proceso Python:', err.message);
      resolve({
        ok: false,
        error: err.message,
        reply: 'Hola, gracias por escribir a Servi-Bot. ¿En qué servicio te podemos ayudar hoy?'
      });
    });

    py.on('close', () => {
      try {
        const parsed = JSON.parse(stdoutData.trim());
        resolve(parsed);
      } catch (err) {
        console.error('[PythonWorker] Salida no JSON:', stdoutData, stderrData);
        resolve({
          ok: false,
          error: stderrData || err.message,
          reply: stdoutData.trim() || 'Hola, soy el asistente de Servi-Bot. ¿Te gustaría conocer nuestros Bots Autónomos o la Interfaz de Catálogo Dinámico?'
        });
      }
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });
}

/**
 * Middleware de autenticación con Firebase Auth (verifica ID Token contra Google Identity Toolkit)
 */
async function requireFirebaseAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Se requiere autenticación de Firebase Auth (Bearer token).' });
  }
  const idToken = authHeader.slice(7).trim();
  if (!idToken) {
    return res.status(401).json({ ok: false, error: 'Token vacío.' });
  }

  try {
    const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    });
    if (!resp.ok) {
      return res.status(401).json({ ok: false, error: 'Token de Firebase inválido o expirado.' });
    }
    const data = await resp.json();
    const user = data?.users?.[0];
    if (!user || !user.email) {
      return res.status(401).json({ ok: false, error: 'Se requiere una cuenta válida con correo electrónico en Firebase Auth.' });
    }
    req.firebaseUser = {
      uid: user.localId,
      email: user.email,
      displayName: user.displayName || user.email
    };
    return next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Error verificando Firebase Auth: ${err.message}` });
  }
}

function slugify(text) {
  return (
    String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || `item-${Date.now()}`
  );
}

/**
 * Obtiene la configuración activa de Mercado Pago y la tasa de IVA de México (16%).
 */
function getMercadoPagoConfig() {
  const saved = getSetting('mercadopago_config', {});
  const publicKey = process.env.MP_PUBLIC_KEY || saved.public_key || '';
  const accessToken = process.env.MP_ACCESS_TOKEN || saved.access_token || '';
  const parsedTax = Number(process.env.MP_TAX_RATE ?? saved.tax_rate ?? 0.16);
  const taxRate = Number.isFinite(parsedTax) && parsedTax >= 0 ? parsedTax : 0.16;
  return {
    enabled: Boolean(accessToken),
    publicKey,
    accessToken,
    taxRate,
    currency: 'MXN',
    country: 'MX',
    successUrl:
      process.env.MP_SUCCESS_URL || saved.success_url || 'https://servi-bot-cic.web.app/?mp_status=approved',
    pendingUrl:
      process.env.MP_PENDING_URL || saved.pending_url || 'https://servi-bot-cic.web.app/?mp_status=pending',
    failureUrl:
      process.env.MP_FAILURE_URL || saved.failure_url || 'https://servi-bot-cic.web.app/?mp_status=failure'
  };
}

/**
 * Crea una preferencia de pago Checkout Pro en Mercado Pago México (MXN).
 */
async function createMercadoPagoPreference({
  orderCode,
  customer_name = '',
  customer_contact = '',
  customer_company = '',
  orderItems = []
}) {
  const mpCfg = getMercadoPagoConfig();
  if (!mpCfg.enabled || !orderItems.length) return null;

  const appendOrderParam = (urlStr, extraStatus = '') => {
    const sep = urlStr.includes('?') ? '&' : '?';
    return `${urlStr}${sep}order=${encodeURIComponent(orderCode)}${extraStatus}`;
  };

  const mpItems = orderItems
    .filter((it) => Number(it.price || 0) > 0)
    .map((it) => ({
      id: String(it.slug || 'servibot-item').slice(0, 120),
      title: String(it.name || 'Servicio Servi-Bot').slice(0, 250),
      description: String(customer_company ? `${it.name} · ${customer_company}` : it.name).slice(0, 250),
      quantity: 1,
      currency_id: 'MXN',
      unit_price: Math.round(Number(it.price || 0) * 100) / 100
    }));

  if (!mpItems.length) return null;

  const payer = { name: String(customer_name || 'Cliente Servi-Bot').slice(0, 120) };
  const contactStr = String(customer_contact || '').trim();
  if (contactStr.includes('@')) {
    payer.email = contactStr;
  } else {
    const digits = contactStr.replace(/\D/g, '');
    if (digits.length >= 8) {
      payer.phone = { number: digits.slice(-10) };
    }
  }

  const body = {
    items: mpItems,
    payer,
    external_reference: orderCode,
    statement_descriptor: 'SERVIBOT IA',
    back_urls: {
      success: appendOrderParam(mpCfg.successUrl),
      pending: appendOrderParam(mpCfg.pendingUrl),
      failure: appendOrderParam(mpCfg.failureUrl)
    },
    auto_return: 'approved',
    metadata: {
      order_code: orderCode,
      company: customer_company || '',
      country: 'MX',
      tax_rate: mpCfg.taxRate
    }
  };

  const tunnelUrl = getTunnelStatus()?.publicUrl || '';
  if (tunnelUrl.startsWith('https://')) {
    body.notification_url = `${tunnelUrl.replace(/\/+$/, '')}/api/payments/mercadopago/webhook`;
  }

  try {
    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mpCfg.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    const data = await resp.json();
    if (!resp.ok || !data?.id) {
      console.error('[MercadoPago] Error creando preferencia:', resp.status, data);
      return { ok: false, error: data?.message || `HTTP ${resp.status}` };
    }
    return {
      ok: true,
      preference_id: data.id,
      init_point: data.init_point,
      sandbox_init_point: data.sandbox_init_point,
      public_key: mpCfg.publicKey
    };
  } catch (err) {
    console.error('[MercadoPago] Excepción creando preferencia:', err.message);
    return { ok: false, error: err.message };
  }
}

async function main() {
  // 1. Iniciar Ollama en puerto 10002
  await ensureOllamaOnPort10002();

  // 2. Iniciar Evolution API (WhatsApp Baileys sin tokens) en puerto 10001
  await startEvolutionServer();

  // 3. Iniciar worker de Correo IMAP/SMTP
  startEmailPolling(runPythonSalesAgent);

  // 4. Configurar servidor principal Express en puerto 10000
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '15mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- ESTADO GENERAL Y PUERTOS ---
  app.get('/api/health', async (req, res) => {
    const ollama = await getOllamaStatus();
    let evolution = { port: EVOLUTION_PORT, state: 'unknown' };
    try {
      const evResp = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connectionState/servibot-main`);
      const evData = await evResp.json();
      evolution = {
        port: EVOLUTION_PORT,
        ...(evData.instance || {})
      };
    } catch (err) {
      evolution = { port: EVOLUTION_PORT, state: 'offline', error: err.message };
    }

    const stats = {
      catalogCount: db.prepare('SELECT COUNT(*) as c FROM catalog_items WHERE active = 1').get().c,
      totalCatalogCount: db.prepare('SELECT COUNT(*) as c FROM catalog_items').get().c,
      ordersCount: db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
      pendingOrdersCount: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get().c,
      conversationsCount: db.prepare('SELECT COUNT(*) as c FROM conversations').get().c,
      instancesCount: db.prepare('SELECT COUNT(*) as c FROM bot_instances').get().c
    };

    const mpCfg = getMercadoPagoConfig();
    res.json({
      ok: true,
      service: 'Servi-Bot Main Orchestrator',
      firebaseProject: FIREBASE_PROJECT_ID,
      ports: {
        server: PORT,
        evolution: EVOLUTION_PORT,
        ollama: OLLAMA_PORT,
        worker: WORKER_PORT
      },
      ollama,
      evolution,
      email: getEmailWorkerStatus(),
      teams: getTeamsChannelStatus(),
      tunnel: getTunnelStatus(),
      mercadopago: {
        enabled: mpCfg.enabled,
        publicKey: mpCfg.publicKey,
        taxRate: mpCfg.taxRate,
        country: mpCfg.country,
        currency: mpCfg.currency
      },
      stats
    });
  });

  // --- CATÁLOGO DE PRODUCTOS Y SERVICIOS ---
  app.get('/api/catalog', (req, res) => {
    const includeAll = req.query.all === '1';
    const sql = includeAll
      ? 'SELECT * FROM catalog_items ORDER BY id ASC'
      : 'SELECT * FROM catalog_items WHERE active = 1 ORDER BY id ASC';
    const rows = db.prepare(sql).all();
    const items = rows.map((r) => ({
      ...r,
      active: Boolean(r.active),
      features: (() => {
        try {
          return JSON.parse(r.features_json || '[]');
        } catch {
          return [];
        }
      })()
    }));
    res.json({ ok: true, items });
  });

  app.post('/api/catalog', requireFirebaseAuth, (req, res) => {
    try {
      const {
        type = 'service',
        name,
        tagline = '',
        description = '',
        price = 0,
        currency = 'MXN',
        billing_cycle = 'mensual',
        setup_fee = 0,
        features = [],
        image_url = '/assets/service-bots.svg',
        badge = '',
        active = true
      } = req.body || {};

      if (!name || !description) {
        return res.status(400).json({ ok: false, error: 'Nombre y descripción son obligatorios.' });
      }

      let slug = slugify(req.body.slug || name);
      const exists = db.prepare('SELECT id FROM catalog_items WHERE slug = ?').get(slug);
      if (exists) slug = `${slug}-${Date.now().toString().slice(-4)}`;

      const featuresArr = Array.isArray(features)
        ? features
        : String(features || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);

      const result = db
        .prepare(
          `INSERT INTO catalog_items (
            slug, type, name, tagline, description, price, currency, billing_cycle, setup_fee, features_json, image_url, badge, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          slug,
          type,
          name,
          tagline,
          description,
          Number(price || 0),
          currency,
          billing_cycle,
          Number(setup_fee || 0),
          JSON.stringify(featuresArr),
          image_url || '/assets/service-bots.svg',
          badge,
          active ? 1 : 0
        );

      const created = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(result.lastInsertRowid);
      res.json({ ok: true, item: created });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put('/api/catalog/:id', requireFirebaseAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      const current = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
      if (!current) {
        return res.status(404).json({ ok: false, error: 'Producto o servicio no encontrado.' });
      }

      const {
        type = current.type,
        name = current.name,
        tagline = current.tagline,
        description = current.description,
        price = current.price,
        currency = current.currency,
        billing_cycle = current.billing_cycle,
        setup_fee = current.setup_fee,
        features,
        image_url = current.image_url,
        badge = current.badge,
        active = Boolean(current.active)
      } = req.body || {};

      let featuresJson = current.features_json;
      if (features !== undefined) {
        const arr = Array.isArray(features)
          ? features
          : String(features || '')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean);
        featuresJson = JSON.stringify(arr);
      }

      db.prepare(
        `UPDATE catalog_items SET
          type = ?, name = ?, tagline = ?, description = ?, price = ?, currency = ?,
          billing_cycle = ?, setup_fee = ?, features_json = ?, image_url = ?, badge = ?, active = ?
        WHERE id = ?`
      ).run(
        type,
        name,
        tagline,
        description,
        Number(price || 0),
        currency,
        billing_cycle,
        Number(setup_fee || 0),
        featuresJson,
        image_url,
        badge,
        active ? 1 : 0,
        id
      );

      const updated = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
      res.json({ ok: true, item: updated });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/catalog/:id', requireFirebaseAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      db.prepare('DELETE FROM catalog_items WHERE id = ?').run(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- SUBIDA DE IMÁGENES PARA PRODUCTOS Y SERVICIOS ---
  app.post('/api/upload', requireFirebaseAuth, (req, res) => {
    try {
      const { dataUrl, filename = 'imagen.png' } = req.body || {};
      if (!dataUrl || !dataUrl.startsWith('data:image/')) {
        return res.status(400).json({ ok: false, error: 'Formato de imagen inválido.' });
      }
      const matches = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
      if (!matches) {
        return res.status(400).json({ ok: false, error: 'No se pudo decodificar la imagen base64.' });
      }
      const ext = matches[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg');
      const buffer = Buffer.from(matches[2], 'base64');
      const safeName = `${Date.now()}-${slugify(filename.replace(/\.[^.]+$/, ''))}.${ext}`;
      const filePath = path.join(UPLOADS_DIR, safeName);
      fs.writeFileSync(filePath, buffer);
      res.json({
        ok: true,
        imageUrl: `/uploads/${safeName}`
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- PEDIDOS (ORDERS) ---
  app.get('/api/orders', requireFirebaseAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
    const orders = rows.map((r) => ({
      ...r,
      items: (() => {
        try {
          return JSON.parse(r.items_json || '[]');
        } catch {
          return [];
        }
      })()
    }));
    res.json({ ok: true, orders });
  });

  app.post('/api/orders', async (req, res) => {
    try {
      const {
        customer_name,
        customer_contact,
        customer_company = '',
        channel = 'web',
        item_ids = [],
        custom_items = [],
        notes = ''
      } = req.body || {};

      if (!customer_name || !customer_contact) {
        return res.status(400).json({ ok: false, error: 'Nombre y dato de contacto son requeridos.' });
      }

      let totalAmount = 0;
      let currency = 'MXN';
      let orderItems = [];

      if (Array.isArray(custom_items) && custom_items.length > 0) {
        orderItems = custom_items
          .filter((item) => item && item.name)
          .map((item) => {
            const unitPrice = Math.max(0, Number(item.price || 0));
            const itemCurrency = String(item.currency || 'MXN');
            totalAmount += unitPrice;
            currency = itemCurrency;
            return {
              id: null,
              slug: String(item.slug || 'servibot-custom'),
              name: String(item.name).trim(),
              price: unitPrice,
              setup_fee: 0,
              billing_cycle: String(item.billing_cycle || 'Más impuestos'),
              currency: itemCurrency
            };
          });
      }

      if (!orderItems.length) {
        const allItems = db.prepare('SELECT * FROM catalog_items WHERE active = 1').all();
        const selected = item_ids.length
          ? allItems.filter((i) => item_ids.includes(i.id) || item_ids.includes(i.slug))
          : [allItems[0]].filter(Boolean);

        orderItems = selected.map((item) => {
          totalAmount += Number(item.price || 0);
          currency = item.currency || 'MXN';
          return {
            id: item.id,
            slug: item.slug,
            name: item.name,
            price: Number(item.price || 0),
            setup_fee: Number(item.setup_fee || 0),
            billing_cycle: item.billing_cycle,
            currency
          };
        });
      }

      const mpCfg = getMercadoPagoConfig();
      const taxRate = req.body?.apply_tax === false ? 0 : mpCfg.taxRate;
      const subtotalAmount = Math.round(totalAmount * 100) / 100;
      const taxAmount = Math.round(subtotalAmount * taxRate * 100) / 100;

      if (taxAmount > 0) {
        orderItems.push({
          id: null,
          slug: 'iva-mexico-16',
          name: `IVA México (${Math.round(taxRate * 100)}%)`,
          price: taxAmount,
          setup_fee: 0,
          billing_cycle: 'Impuesto México',
          currency
        });
      }

      totalAmount = Math.round((subtotalAmount + taxAmount) * 100) / 100;

      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const orderCode = `SB-${dateStr}-${Math.floor(1000 + Math.random() * 9000)}`;

      const result = db
        .prepare(
          `INSERT INTO orders (
            order_code, customer_name, customer_contact, customer_company,
            channel, items_json, total_amount, currency, notes, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        )
        .run(
          orderCode,
          customer_name,
          customer_contact,
          customer_company,
          channel,
          JSON.stringify(orderItems),
          totalAmount,
          currency,
          notes || 'Pedido creado desde el catálogo web'
        );

      const mpPreference = await createMercadoPagoPreference({
        orderCode,
        customer_name,
        customer_contact,
        customer_company,
        orderItems
      });

      if (mpPreference?.preference_id) {
        const enrichedNotes = `${notes || 'Pedido web'} | MP Pref: ${mpPreference.preference_id}`.trim();
        db.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(enrichedNotes, result.lastInsertRowid);
      }

      const created = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
      await notifyTeamsIncomingWebhook(
        `🛒 **Nuevo Pedido Web (${orderCode})** de **${customer_name}** (${customer_contact}) por **$${totalAmount} ${currency}** (Subtotal $${subtotalAmount} + IVA $${taxAmount})`
      );

      res.json({
        ok: true,
        order: {
          ...created,
          subtotal_amount: subtotalAmount,
          tax_rate: taxRate,
          tax_amount: taxAmount,
          total_amount: totalAmount,
          items: orderItems
        },
        mercadopago: mpPreference
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch('/api/orders/:id', requireFirebaseAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });

      const status = req.body.status || existing.status;
      const notes = req.body.notes !== undefined ? req.body.notes : existing.notes;
      db.prepare('UPDATE orders SET status = ?, notes = ? WHERE id = ?').run(status, notes, id);

      const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      res.json({ ok: true, order: updated });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- CONVERSACIONES E HISTORIAL DEL BOT ---
  app.get('/api/conversations', requireFirebaseAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 50').all();
    res.json({ ok: true, conversations: rows });
  });

  app.get('/api/conversations/:id/messages', requireFirebaseAuth, (req, res) => {
    const convId = Number(req.params.id);
    const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC').all(convId);
    res.json({ ok: true, messages: msgs });
  });

  function mergeInstanceWithLiveState(row, live = {}) {
    return {
      ...row,
      active: Boolean(row.active),
      state: live.state || live.status || 'close',
      connectedPhone: live.connectedPhone || live.owner || null,
      hasQr: Boolean(live.hasQr || live.qrBase64 || live.base64),
      qrBase64: live.qrBase64 || live.base64 || null,
      qrUpdatedAt: live.qrUpdatedAt || null,
      hasSavedSession: Boolean(live.hasSavedSession),
      lastError: live.lastError || null
    };
  }

  // --- GESTIÓN MULTI-INSTANCIA DE SERVIBOTS (10 SLOTS BAILEYS + SISTEMA Y ALMA IA) ---
  app.get('/api/instances', async (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM bot_instances ORDER BY slot_number ASC').all();
      const liveMap = new Map();
      try {
        const evResp = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/fetchInstances`);
        const evList = await evResp.json();
        if (Array.isArray(evList)) {
          for (const entry of evList) {
            const instObj = entry?.instance || entry;
            if (instObj?.instanceName) {
              liveMap.set(resolveInstanceId(instObj.instanceName), instObj);
            }
          }
        }
      } catch {
        // Evolution server offline fallback
      }

      const merged = rows.map((row) =>
        mergeInstanceWithLiveState(row, liveMap.get(row.instance_id) || {})
      );
      res.json({ ok: true, instances: merged, totalSlots: INSTANCE_IDS.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/instances/provision', async (req, res) => {
    try {
      const body = req.body || {};
      const businessName = String(body.business_name || '').trim();
      const clientName = String(body.client_name || '').trim();
      const clientContact = String(body.client_contact || '').trim();
      const displayName = String(body.display_name || '').trim()
        || (businessName ? `Asistente ${businessName}` : 'ServiBot');
      const tone = String(body.tone || '').trim() || 'Profesional, cálido y orientado a resultados';
      const aiSoul = String(body.ai_soul || '').trim();
      const systemPrompt = String(body.system_prompt || '').trim();
      const welcomeMessage = String(body.welcome_message || '').trim()
        || (businessName
          ? `¡Hola! Soy ${displayName}, asesor inteligente de ${businessName}. ¿En qué te ayudo hoy?`
          : '¡Hola! Soy tu ServiBot. ¿En qué te ayudo hoy?');

      if (!businessName || !aiSoul) {
        return res.status(400).json({
          ok: false,
          error: 'Indica al menos el nombre de tu negocio y el alma o propósito de tu ServiBot.'
        });
      }

      const poolRows = db
        .prepare('SELECT * FROM bot_instances WHERE slot_number >= 2 ORDER BY slot_number ASC')
        .all();

      if (!poolRows.length) {
        return res.status(503).json({
          ok: false,
          error: 'No hay instancias disponibles en el servidor en este momento.'
        });
      }

      let liveMap = {};
      try {
        const evResp = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/fetchInstances`);
        const evData = await evResp.json();
        const evList = Array.isArray(evData) ? evData : (evData?.instances || []);
        for (const item of evList) {
          const name = item?.instance?.instanceName || item?.instanceName;
          if (name) liveMap[name] = item?.instance || item;
        }
      } catch {
        // port 10001 temporarily unavailable; treat live state as unknown/close
      }

      let targetRow = null;
      if (body.instance_id) {
        const requestedId = resolveInstanceId(body.instance_id);
        targetRow = poolRows.find((r) => r.instance_id === requestedId) || null;
      }

      if (!targetRow) {
        targetRow = poolRows.find((r) => {
          const liveState = liveMap[r.instance_id]?.state || liveMap[r.instance_id]?.status || 'close';
          const isDefaultSlot = String(r.business_name || '').startsWith('Espacio Disponible')
            && !String(r.client_name || '').trim();
          return liveState !== 'open' && isDefaultSlot;
        }) || null;
      }

      if (!targetRow) {
        const availableNonOpen = poolRows
          .filter((r) => (liveMap[r.instance_id]?.state || liveMap[r.instance_id]?.status || 'close') !== 'open')
          .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || a.slot_number - b.slot_number);
        targetRow = availableNonOpen[0] || null;
      }

      if (!targetRow) {
        return res.status(409).json({
          ok: false,
          error: 'Todas las instancias disponibles tienen una sesión activa de WhatsApp en este momento.'
        });
      }

      const instanceId = targetRow.instance_id;
      db.prepare(`
        UPDATE bot_instances SET
          display_name = ?,
          business_name = ?,
          client_name = ?,
          client_contact = ?,
          tone = ?,
          ai_soul = ?,
          system_prompt = ?,
          welcome_message = ?,
          active = 1,
          updated_at = datetime('now', 'localtime')
        WHERE instance_id = ?
      `).run(
        displayName,
        businessName,
        clientName,
        clientContact,
        tone,
        aiSoul,
        systemPrompt,
        welcomeMessage,
        instanceId
      );

      const updated = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      let liveObj = liveMap[instanceId] || {};
      try {
        const evResp = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connectionState/${encodeURIComponent(instanceId)}`);
        const evData = await evResp.json();
        liveObj = evData?.instance || liveObj;
      } catch {
        // ignore if port 10001 unavailable
      }
      res.json({ ok: true, instance: mergeInstanceWithLiveState(updated, liveObj) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/instances/:instanceId', async (req, res) => {
    try {
      const instanceId = resolveInstanceId(req.params.instanceId);
      const row = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      if (!row) {
        return res.status(404).json({ ok: false, error: `Instancia ${instanceId} no encontrada.` });
      }
      let liveObj = {};
      try {
        const evResp = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connectionState/${encodeURIComponent(instanceId)}`);
        const evData = await evResp.json();
        liveObj = evData?.instance || {};
      } catch {
        liveObj = { state: 'offline' };
      }
      res.json({ ok: true, instance: mergeInstanceWithLiveState(row, liveObj) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put('/api/instances/:instanceId', async (req, res) => {
    try {
      const instanceId = resolveInstanceId(req.params.instanceId);
      const existing = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      if (!existing) {
        return res.status(404).json({ ok: false, error: `Instancia ${instanceId} no encontrada.` });
      }

      const body = req.body || {};
      const displayName = body.display_name !== undefined ? String(body.display_name).trim() : existing.display_name;
      const businessName = body.business_name !== undefined ? String(body.business_name).trim() : existing.business_name;
      const clientName = body.client_name !== undefined ? String(body.client_name).trim() : existing.client_name;
      const clientContact = body.client_contact !== undefined ? String(body.client_contact).trim() : existing.client_contact;
      const tone = body.tone !== undefined ? String(body.tone).trim() : existing.tone;
      const aiSoul = body.ai_soul !== undefined ? String(body.ai_soul).trim() : existing.ai_soul;
      const systemPrompt = body.system_prompt !== undefined ? String(body.system_prompt).trim() : existing.system_prompt;
      const welcomeMessage = body.welcome_message !== undefined ? String(body.welcome_message).trim() : existing.welcome_message;
      const active = body.active !== undefined ? (body.active ? 1 : 0) : existing.active;

      if (!displayName) {
        return res.status(400).json({ ok: false, error: 'El nombre del agente ServiBot es obligatorio.' });
      }

      db.prepare(`
        UPDATE bot_instances SET
          display_name = ?,
          business_name = ?,
          client_name = ?,
          client_contact = ?,
          tone = ?,
          ai_soul = ?,
          system_prompt = ?,
          welcome_message = ?,
          active = ?,
          updated_at = datetime('now', 'localtime')
        WHERE instance_id = ?
      `).run(
        displayName,
        businessName,
        clientName,
        clientContact,
        tone,
        aiSoul,
        systemPrompt,
        welcomeMessage,
        active,
        instanceId
      );

      const updated = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      let liveObj = {};
      try {
        const evResp = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connectionState/${encodeURIComponent(instanceId)}`);
        const evData = await evResp.json();
        liveObj = evData?.instance || {};
      } catch {
        // ignore if port 10001 unavailable
      }
      res.json({ ok: true, instance: mergeInstanceWithLiveState(updated, liveObj) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/instances/:instanceId/connect', async (req, res) => {
    try {
      const instanceId = resolveInstanceId(req.params.instanceId);
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connect/${encodeURIComponent(instanceId)}`);
      const data = await r.json();
      res.json({ ok: true, ...data, instance: instanceId });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/instances/:instanceId/logout', async (req, res) => {
    try {
      const instanceId = resolveInstanceId(req.params.instanceId);
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/logout/${encodeURIComponent(instanceId)}`, {
        method: 'POST'
      });
      const data = await r.json();
      res.json({ ok: true, ...data, instance: instanceId });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- AGENTE DE VENTAS IA (PYTHON A DEMANDA + OLLAMA PUERTO 10002) ---
  app.post('/api/chat', async (req, res) => {
    const {
      channel = 'web',
      sender_id = 'web-visitor',
      sender_name = 'Visitante Web',
      message = '',
      instance_id = 'servibot-01'
    } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ ok: false, error: 'El mensaje no puede estar vacío.' });
    }

    const result = await runPythonSalesAgent({
      channel,
      sender_id,
      sender_name,
      message: String(message).trim(),
      instance_id: resolveInstanceId(instance_id)
    });

    res.json(result);
  });

  // --- WEBHOOK DE EVOLUTION API (WHATSAPP PUERTO 10001 -> 10000) ---
  app.post('/api/webhooks/evolution', async (req, res) => {
    try {
      const botCfg = getSetting('bot_config', {});
      if (botCfg.auto_reply_whatsapp === false) {
        return res.json({ ok: true, paused: true });
      }

      const body = req.body || {};
      const instanceId = resolveInstanceId(body.instance || body.instanceName || 'servibot-01');
      const data = body.data || {};
      const remoteJid = data.key?.remoteJid || body.sender || 'whatsapp-user';
      const pushName = data.pushName || remoteJid.split('@')[0];
      const text =
        data.message?.conversation ||
        data.message?.extendedTextMessage?.text ||
        body.text ||
        '';

      if (!text.trim()) {
        return res.json({ ok: true, ignored: true });
      }

      const agentResult = await runPythonSalesAgent({
        channel: 'whatsapp',
        sender_id: remoteJid.replace('@s.whatsapp.net', ''),
        sender_name: pushName,
        message: text.trim(),
        instance_id: instanceId
      });

      res.json(agentResult);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- ENDPOINTS DE CONTROL EVOLUTION (PUENTE ADMIN -> 10001) ---
  app.get('/api/channels/whatsapp/status', requireFirebaseAuth, async (req, res) => {
    try {
      const instanceId = resolveInstanceId(req.query.instance || 'servibot-01');
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connect/${encodeURIComponent(instanceId)}`);
      const data = await r.json();
      const rootR = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/`);
      const rootData = await rootR.json();
      res.json({ ok: true, ...data, instance: instanceId, recentEvents: rootData.recentEvents || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/channels/whatsapp/simulate', requireFirebaseAuth, async (req, res) => {
    try {
      const payload = {
        ...(req.body || {}),
        instance: resolveInstanceId(req.body?.instance || 'servibot-01')
      };
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/webhook/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/channels/whatsapp/logout', requireFirebaseAuth, async (req, res) => {
    try {
      const instanceId = resolveInstanceId(req.query.instance || req.body?.instance || 'servibot-01');
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/logout/${encodeURIComponent(instanceId)}`, {
        method: 'DELETE'
      });
      const data = await r.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- CANAL MICROSOFT TEAMS ---
  app.post('/api/channels/teams/webhook', (req, res) => {
    return handleTeamsWebhook(req, res, runPythonSalesAgent);
  });

  // --- CANAL CORREO ELECTRÓNICO (IMAP / SMTP) ---
  app.post('/api/channels/email/simulate', requireFirebaseAuth, async (req, res) => {
    const result = await simulateIncomingEmail(runPythonSalesAgent, req.body || {});
    res.json(result);
  });

  app.post('/api/channels/email/poll', requireFirebaseAuth, async (req, res) => {
    await pollImapOnce(runPythonSalesAgent);
    res.json({ ok: true, status: getEmailWorkerStatus() });
  });

  // --- MERCADO PAGO CHECKOUT PRO Y WEBHOOK (MÉXICO MXN) ---
  app.get('/api/payments/mercadopago/config', (req, res) => {
    const mpCfg = getMercadoPagoConfig();
    res.json({
      ok: true,
      enabled: mpCfg.enabled,
      publicKey: mpCfg.publicKey,
      taxRate: mpCfg.taxRate,
      taxLabel: `IVA México (${Math.round(mpCfg.taxRate * 100)}%)`,
      currency: mpCfg.currency,
      country: mpCfg.country
    });
  });

  app.post('/api/payments/mercadopago/webhook', async (req, res) => {
    try {
      const mpCfg = getMercadoPagoConfig();
      const topic = req.body?.type || req.body?.topic || req.query?.topic || req.query?.type || '';
      const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id || '';

      if (!mpCfg.enabled || !paymentId || (topic && topic !== 'payment')) {
        return res.status(200).json({ ok: true, received: true });
      }

      const payResp = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Bearer ${mpCfg.accessToken}` },
        signal: AbortSignal.timeout(10000)
      });
      if (payResp.ok) {
        const payment = await payResp.json();
        const orderCode = payment?.external_reference;
        const mpStatus = payment?.status;
        if (orderCode) {
          const mappedStatus =
            mpStatus === 'approved'
              ? 'paid'
              : mpStatus === 'rejected' || mpStatus === 'cancelled'
                ? 'cancelled'
                : 'pending';
          const existing = db.prepare('SELECT id, notes FROM orders WHERE order_code = ?').get(orderCode);
          if (existing) {
            const nextNotes = `${existing.notes || ''} | Pago MP #${paymentId}: ${mpStatus}`.trim();
            db.prepare('UPDATE orders SET status = ?, notes = ? WHERE id = ?').run(mappedStatus, nextNotes, existing.id);
            if (mpStatus === 'approved') {
              await notifyTeamsIncomingWebhook(
                `💳 **Pago Aprobado en Mercado Pago (${orderCode})** · Pago #${paymentId} por **$${payment.transaction_amount} ${payment.currency_id || 'MXN'}**`
              );
            }
          }
        }
      }

      return res.status(200).json({ ok: true, received: true });
    } catch (err) {
      console.error('[MercadoPago Webhook] Error:', err.message);
      return res.status(200).json({ ok: false, error: err.message });
    }
  });

  // --- CONFIGURACIÓN GENERAL Y CREDENCIALES DE CANALES ---
  app.get('/api/settings', requireFirebaseAuth, (req, res) => {
    const mpSaved = getSetting('mercadopago_config', {});
    const mpCfg = getMercadoPagoConfig();
    res.json({
      ok: true,
      bot_config: getSetting('bot_config', {}),
      email_config: getSetting('email_config', {}),
      teams_config: getSetting('teams_config', {}),
      tunnel_config: getSetting('tunnel_config', {}),
      mercadopago_config: {
        enabled: mpCfg.enabled,
        public_key: mpCfg.publicKey,
        has_access_token: Boolean(mpCfg.accessToken),
        tax_rate: mpCfg.taxRate,
        country: mpCfg.country,
        currency: mpCfg.currency,
        updated_via: mpSaved.public_key ? 'sqlite' : 'env'
      }
    });
  });

  app.put('/api/settings/:key', requireFirebaseAuth, async (req, res) => {
    const key = req.params.key;
    const allowed = ['bot_config', 'email_config', 'teams_config', 'tunnel_config', 'mercadopago_config'];
    if (!allowed.includes(key)) {
      return res.status(400).json({ ok: false, error: 'Clave de configuración no permitida.' });
    }
    const current = getSetting(key, {});
    const merged = { ...current, ...(req.body || {}) };
    setSetting(key, merged);

    if (key === 'email_config') {
      startEmailPolling(runPythonSalesAgent);
    } else if (key === 'tunnel_config' && req.body?.restartTunnel) {
      await startCloudflareTunnel(PORT);
    }

    res.json({ ok: true, key, value: key === 'mercadopago_config' ? { ...merged, access_token: merged.access_token ? '***' : '' } : merged, tunnel: getTunnelStatus() });
  });

  // --- GESTIÓN DE CUENTAS DE ADMINISTRACIÓN (FIREBASE AUTH + SQLITE) ---
  app.get('/api/admin/accounts', requireFirebaseAuth, (req, res) => {
    try {
      db.prepare(`
        INSERT INTO admin_accounts (firebase_uid, email, display_name, role, created_by)
        VALUES (?, ?, ?, 'admin', 'firebase-auth')
        ON CONFLICT(email) DO UPDATE SET
          firebase_uid = COALESCE(NULLIF(excluded.firebase_uid, ''), admin_accounts.firebase_uid),
          display_name = COALESCE(NULLIF(excluded.display_name, ''), admin_accounts.display_name)
      `).run(req.firebaseUser.uid, req.firebaseUser.email.toLowerCase(), req.firebaseUser.displayName || '');

      const accounts = db
        .prepare('SELECT id, firebase_uid, email, display_name, role, created_by, created_at FROM admin_accounts ORDER BY id DESC')
        .all();
      res.json({ ok: true, accounts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/admin/accounts', requireFirebaseAuth, async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const displayName = String(req.body?.displayName || '').trim();
      const role = req.body?.role === 'operator' ? 'operator' : 'admin';

      if (!email || !email.includes('@')) {
        return res.status(400).json({ ok: false, error: 'Ingresa un correo electrónico válido.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 6 caracteres.' });
      }

      const signUpResp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true })
        }
      );
      const signUpData = await signUpResp.json();

      if (!signUpResp.ok) {
        const fbCode = signUpData?.error?.message || 'UNKNOWN';
        const errorMap = {
          EMAIL_EXISTS: 'Ya existe una cuenta en Firebase con este correo electrónico.',
          INVALID_EMAIL: 'El formato del correo electrónico no es válido.',
          OPERATION_NOT_ALLOWED: 'El registro por correo y contraseña no está habilitado en Firebase Auth.',
          WEAK_PASSWORD: 'La contraseña es demasiado débil (mínimo 6 caracteres).'
        };
        const cleanMsg = Object.entries(errorMap).find(([k]) => fbCode.includes(k))?.[1] || `Firebase error: ${fbCode}`;
        return res.status(400).json({ ok: false, error: cleanMsg });
      }

      if (displayName && signUpData.idToken) {
        await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FIREBASE_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken: signUpData.idToken,
            displayName,
            returnSecureToken: false
          })
        });
      }

      db.prepare(`
        INSERT INTO admin_accounts (firebase_uid, email, display_name, role, created_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          firebase_uid = excluded.firebase_uid,
          display_name = excluded.display_name,
          role = excluded.role,
          created_by = excluded.created_by
      `).run(
        signUpData.localId || '',
        email,
        displayName || email,
        role,
        req.firebaseUser.email
      );

      const created = db
        .prepare('SELECT id, firebase_uid, email, display_name, role, created_by, created_at FROM admin_accounts WHERE email = ?')
        .get(email);

      res.json({ ok: true, account: created });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[Servi-Bot] Servidor Principal Node activo en http://127.0.0.1:${PORT}`);
    // 5. Iniciar Túnel Cloudflare hacia el puerto 10000
    await startCloudflareTunnel(PORT);
  });
}

main().catch((err) => {
  console.error('[Servi-Bot] Error fatal al iniciar:', err);
  process.exit(1);
});
