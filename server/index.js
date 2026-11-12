const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { db, DB_PATH, getSetting, setSetting } = require('./db');
const { OLLAMA_PORT, ensureOllamaOnPort10002, getOllamaStatus } = require('./ollama_service');
const { EVOLUTION_PORT, startEvolutionServer } = require('./evolution_server');
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
 * Ejecuta a demanda el agente de ventas en Python (python_workers/sales_agent.py)
 * conectado a SQLite y a Ollama en el puerto 10002.
 */
function runPythonSalesAgent({ channel = 'web', sender_id = 'anon', sender_name = '', message = '' }) {
  return new Promise((resolve) => {
    const botCfg = getSetting('bot_config', {});
    const scriptPath = path.join(__dirname, '..', 'python_workers', 'sales_agent.py');
    const payload = {
      db_path: DB_PATH,
      channel,
      sender_id,
      sender_name,
      message,
      ollama_url: botCfg.ollama_host || `http://127.0.0.1:${OLLAMA_PORT}`,
      ollama_model: botCfg.ollama_model || 'llama3.2:3b'
    };

    const py = spawn('python', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
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
      conversationsCount: db.prepare('SELECT COUNT(*) as c FROM conversations').get().c
    };

    res.json({
      ok: true,
      service: 'Servi-Bot Main Orchestrator',
      firebaseProject: FIREBASE_PROJECT_ID,
      ports: {
        server: PORT,
        evolution: EVOLUTION_PORT,
        ollama: OLLAMA_PORT
      },
      ollama,
      evolution,
      email: getEmailWorkerStatus(),
      teams: getTeamsChannelStatus(),
      tunnel: getTunnelStatus(),
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
        notes = ''
      } = req.body || {};

      if (!customer_name || !customer_contact) {
        return res.status(400).json({ ok: false, error: 'Nombre y dato de contacto son requeridos.' });
      }

      const allItems = db.prepare('SELECT * FROM catalog_items WHERE active = 1').all();
      const selected = item_ids.length
        ? allItems.filter((i) => item_ids.includes(i.id) || item_ids.includes(i.slug))
        : [allItems[0]].filter(Boolean);

      let totalAmount = 0;
      let currency = 'MXN';
      const orderItems = selected.map((item) => {
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

      const created = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
      await notifyTeamsIncomingWebhook(
        `🛒 **Nuevo Pedido Web (${orderCode})** de **${customer_name}** (${customer_contact}) por **$${totalAmount} ${currency}**`
      );

      res.json({ ok: true, order: { ...created, items: orderItems } });
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

  // --- AGENTE DE VENTAS IA (PYTHON A DEMANDA + OLLAMA PUERTO 10002) ---
  app.post('/api/chat', async (req, res) => {
    const {
      channel = 'web',
      sender_id = 'web-visitor',
      sender_name = 'Visitante Web',
      message = ''
    } = req.body || {};

    if (!message || !String(message).trim()) {
      return res.status(400).json({ ok: false, error: 'El mensaje no puede estar vacío.' });
    }

    const result = await runPythonSalesAgent({
      channel,
      sender_id,
      sender_name,
      message: String(message).trim()
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
        message: text.trim()
      });

      res.json(agentResult);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- ENDPOINTS DE CONTROL EVOLUTION (PUENTE ADMIN -> 10001) ---
  app.get('/api/channels/whatsapp/status', requireFirebaseAuth, async (req, res) => {
    try {
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connect/servibot-main`);
      const data = await r.json();
      const rootR = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/`);
      const rootData = await rootR.json();
      res.json({ ok: true, ...data, recentEvents: rootData.recentEvents || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/channels/whatsapp/simulate', requireFirebaseAuth, async (req, res) => {
    try {
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/webhook/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body || {})
      });
      const data = await r.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/channels/whatsapp/logout', requireFirebaseAuth, async (req, res) => {
    try {
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/logout/servibot-main`, {
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

  // --- CONFIGURACIÓN GENERAL Y CREDENCIALES DE CANALES ---
  app.get('/api/settings', requireFirebaseAuth, (req, res) => {
    res.json({
      ok: true,
      bot_config: getSetting('bot_config', {}),
      email_config: getSetting('email_config', {}),
      teams_config: getSetting('teams_config', {}),
      tunnel_config: getSetting('tunnel_config', {})
    });
  });

  app.put('/api/settings/:key', requireFirebaseAuth, async (req, res) => {
    const key = req.params.key;
    const allowed = ['bot_config', 'email_config', 'teams_config', 'tunnel_config'];
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

    res.json({ ok: true, key, value: merged, tunnel: getTunnelStatus() });
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
