const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  db,
  prospectsDb,
  DB_PATH,
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
  setBotSetting,
  addTrainingMemory,
  getTrainingMemories,
  applyTrainingAction
} = require('./db');
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
const { allTimeRouter } = require('./alltime_api');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 10000);
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCZm5qX98Y8ww4ksJWX-xQs6deaSQojhHk';
const FIREBASE_PROJECT_ID = 'servi-bot-cic';
const PUBLIC_ORIGIN = process.env.PUBLIC_HOSTING_URL || 'https://servi-bot-cic.web.app';
const STANDARD_PLAN_DAYS = 30;

const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Cola con prioridad: números en Lista Blanca (prioridad 0) se atienden antes que los demás (prioridad 1)
// R3.2 / R3.4: Concurrencia elevada a 16 para atender ráfagas concurrentes en Bedrock sin encolamiento innecesario
const AGENT_MAX_CONCURRENCY = Number(process.env.AGENT_MAX_CONCURRENCY || 16);
let activeAgentTasks = 0;
const priorityAgentQueue = [];
const normalAgentQueue = [];

// Rate limiting ligero en memoria para el endpoint público /api/chat (R2.3)
const chatIpRateLimits = new Map();
function checkChatRateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  let record = chatIpRateLimits.get(ip);
  if (!record || now - record.resetTime > windowMs) {
    record = { count: 1, resetTime: now };
    chatIpRateLimits.set(ip, record);
    return true;
  }
  record.count += 1;
  return record.count <= limit;
}

function pumpAgentQueue() {
  while (activeAgentTasks < AGENT_MAX_CONCURRENCY) {
    const nextJob = priorityAgentQueue.length > 0 ? priorityAgentQueue.shift() : normalAgentQueue.shift();
    if (!nextJob) break;
    activeAgentTasks += 1;
    Promise.resolve()
      .then(() => nextJob.task())
      .then(nextJob.resolve, nextJob.reject)
      .finally(() => {
        activeAgentTasks = Math.max(0, activeAgentTasks - 1);
        pumpAgentQueue();
      });
  }
}

function enqueueAgentTask(isPriority, task) {
  return new Promise((resolve, reject) => {
    const entry = { task, resolve, reject };
    if (isPriority) {
      priorityAgentQueue.push(entry);
    } else {
      normalAgentQueue.push(entry);
    }
    pumpAgentQueue();
  });
}

function checkContactRuleForSender(instanceId, senderId) {
  const canonicalId = normalizeInstanceIdKey(instanceId) || 'servibot-00';
  const sender = String(senderId || '').trim();
  if (!sender) {
    return { isWhitelisted: false, isOmitted: false, isBlacklisted: false, listType: null };
  }
  try {
    const botDb = getBotDb(canonicalId);
    const rules = botDb.prepare('SELECT normalized_value, list_type FROM contact_rules').all();
    let isWhitelisted = false;
    let isOmitted = false;
    let isBlacklisted = false;
    for (const r of rules) {
      if (contactsMatch(sender, r.normalized_value)) {
        if (r.list_type === 'blacklist') isBlacklisted = true;
        else if (r.list_type === 'omission') isOmitted = true;
        else if (r.list_type === 'whitelist') isWhitelisted = true;
      }
    }
    const listType = isBlacklisted ? 'blacklist' : isOmitted ? 'omission' : isWhitelisted ? 'whitelist' : null;
    return { isWhitelisted, isOmitted, isBlacklisted, listType };
  } catch {
    return { isWhitelisted: false, isOmitted: false, isBlacklisted: false, listType: null };
  }
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
  instance_id = 'servibot-00',
  is_load_test = false,
  client_state = {}
}) {
  const canonicalInstance = normalizeInstanceIdKey(instance_id) || 'servibot-00';
  const botDbPath = getBotDbPath(canonicalInstance);
  const botCfg = getSetting('bot_config', {});
  const instanceCfg =
    db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(canonicalInstance) || {
      instance_id: canonicalInstance
    };

  const ruleCheck = checkContactRuleForSender(canonicalInstance, sender_id);

  const payload = {
    db_path: DB_PATH,
    bot_db_path: botDbPath,
    channel,
    sender_id: String(sender_id || 'anon'),
    sender_name: String(sender_name || ''),
    message: String(message || ''),
    instance_id: canonicalInstance,
    instance_cfg: instanceCfg,
    ollama_url: botCfg.ollama_host || `http://127.0.0.1:${OLLAMA_PORT}`,
    ollama_model: botCfg.ollama_model || 'llama3.2:3b',
    ai_provider: botCfg.ai_provider || process.env.AI_PROVIDER || 'bedrock',
    bedrock_model: botCfg.bedrock_model || process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-micro-v1:0',
    aws_region: botCfg.aws_region || process.env.AWS_REGION || 'us-east-2',
    is_load_test: Boolean(is_load_test),
    client_state: client_state || {}
  };

  const executeWorkerCall = async () => {
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

    return await new Promise((resolve) => {
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
          instance_id: canonicalInstance,
          error: err.message,
          reply:
            instanceCfg.welcome_message ||
            'Hola, gracias por escribir. ¿En qué servicio te podemos ayudar hoy?'
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
            instance_id: canonicalInstance,
            error: stderrData || err.message,
            reply:
              stdoutData.trim() ||
              instanceCfg.welcome_message ||
              'Hola, soy el asistente virtual. ¿Qué producto o servicio de nuestro catálogo deseas cotizar?'
          });
        }
      });

      py.stdin.write(JSON.stringify(payload));
      py.stdin.end();
    });
  };

  const tEnqueue = Date.now();
  let tStart = 0;
  let tEnd = 0;

  const timedWorkerCall = async () => {
    tStart = Date.now();
    try {
      return await executeWorkerCall();
    } finally {
      tEnd = Date.now();
    }
  };

  // Lista Negra / Omisión responden sin esperar en la cola; Lista Blanca entra con prioridad
  const result =
    ruleCheck.isBlacklisted || ruleCheck.isOmitted
      ? await timedWorkerCall()
      : await enqueueAgentTask(ruleCheck.isWhitelisted, timedWorkerCall);

  if (tStart > 0 && tEnd > 0 && result && typeof result === 'object') {
    result.timing = {
      queue_ms: Math.max(0, tStart - tEnqueue),
      worker_ms: Math.max(0, tEnd - tStart),
      total_ms: Math.max(0, tEnd - tEnqueue)
    };
  }

  if (!is_load_test && result && result.order_created && result.order && result.order.order_code) {
    try {
      db.prepare(
        `
        INSERT OR IGNORE INTO order_registry (
          order_code, instance_id, customer_name, customer_contact, customer_company,
          total_amount, currency, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        result.order.order_code,
        canonicalInstance,
        result.order.customer_name || sender_name || '',
        result.order.customer_contact || sender_id || '',
        '',
        Number(result.order.total_amount || 0),
        result.order.currency || 'MXN',
        result.order.status || 'pending'
      );
    } catch (err) {
      console.warn('[OrderRegistry] No se pudo registrar pedido del chat:', err.message);
    }
  }

  return result;
}

async function lookupFirebaseUserByToken(idToken) {
  if (!idToken) return null;
  const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const user = data?.users?.[0];
  if (!user || !user.email) return null;
  return {
    uid: user.localId,
    email: user.email,
    displayName: user.displayName || user.email
  };
}

function buildAdminAccountContext(fbUser) {
  const email = String(fbUser?.email || '').trim().toLowerCase();
  const uid = String(fbUser?.uid || '').trim();
  const isSuperAdmin = email === SUPERADMIN_EMAIL.toLowerCase();

  let row = db.prepare('SELECT * FROM admin_accounts WHERE LOWER(email) = LOWER(?)').get(email);

  if (isSuperAdmin) {
    if (!row) {
      db.prepare(
        `
        INSERT INTO admin_accounts (
          firebase_uid, email, display_name, role, assigned_instance_id, subscription_expires_at, created_by
        ) VALUES (?, ?, ?, 'superadmin', 'servibot-00', NULL, 'system')
      `
      ).run(uid, SUPERADMIN_EMAIL, fbUser?.displayName || 'Admin Principal · Proyecto Cero');
      row = db.prepare('SELECT * FROM admin_accounts WHERE LOWER(email) = LOWER(?)').get(email);
    } else if (
      (uid && row.firebase_uid !== uid) ||
      row.role !== 'superadmin' ||
      row.assigned_instance_id !== 'servibot-00'
    ) {
      db.prepare(
        `
        UPDATE admin_accounts
        SET firebase_uid = CASE WHEN ? != '' THEN ? ELSE firebase_uid END,
            role = 'superadmin',
            assigned_instance_id = 'servibot-00'
        WHERE id = ?
      `
      ).run(uid, uid, row.id);
      row = db.prepare('SELECT * FROM admin_accounts WHERE id = ?').get(row.id);
    }

    return {
      ...row,
      email,
      role: 'superadmin',
      assigned_instance_id: 'servibot-00',
      is_superadmin: true,
      can_manage_accounts: true,
      subscription_expires_at: null,
      days_remaining: null,
      subscription_expired: false
    };
  }

  if (!row) {
    return null;
  }

  if (uid && !row.firebase_uid) {
    db.prepare('UPDATE admin_accounts SET firebase_uid = ? WHERE id = ?').run(uid, row.id);
    row.firebase_uid = uid;
  }

  const assignedId = normalizeInstanceIdKey(row.assigned_instance_id) || 'servibot-01';
  const instRow = db
    .prepare('SELECT subscription_expires_at, paid_status FROM bot_instances WHERE instance_id = ?')
    .get(assignedId);
  const expiresAt = row.subscription_expires_at || instRow?.subscription_expires_at || null;
  let daysRemaining = null;
  let subscriptionExpired = false;
  if (expiresAt) {
    const msLeft = Date.parse(expiresAt) - Date.now();
    if (!Number.isNaN(msLeft)) {
      subscriptionExpired = msLeft <= 0;
      daysRemaining = msLeft > 0 ? Math.ceil(msLeft / (24 * 60 * 60 * 1000)) : 0;
    }
  }

  return {
    ...row,
    email,
    role: row.role === 'admin' ? 'client_admin' : row.role || 'client_admin',
    assigned_instance_id: assignedId,
    is_superadmin: false,
    can_manage_accounts: false,
    subscription_expires_at: expiresAt,
    days_remaining: daysRemaining,
    subscription_expired: subscriptionExpired
  };
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
    const fbUser = await lookupFirebaseUserByToken(idToken);
    if (!fbUser) {
      return res.status(401).json({ ok: false, error: 'Token de Firebase inválido o expirado.' });
    }
    const adminContext = buildAdminAccountContext(fbUser);
    if (!adminContext) {
      return res.status(403).json({
        ok: false,
        error: 'Cuenta autenticada sin instancia ServiBot asignada. Solicita activación o alta con el Administrador Principal.'
      });
    }
    req.firebaseUser = fbUser;
    req.adminAccount = adminContext;
    return next();
  } catch (err) {
    return res.status(500).json({ ok: false, error: `Error verificando Firebase Auth: ${err.message}` });
  }
}

async function resolveOptionalAdminContext(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;
  try {
    const fbUser = await lookupFirebaseUserByToken(idToken);
    if (!fbUser) return null;
    return buildAdminAccountContext(fbUser);
  } catch {
    return null;
  }
}

function getTargetAdminInstanceId(req) {
  const acct = req.adminAccount;
  if (!acct) return 'servibot-00';
  if (acct.is_superadmin) {
    const requested = req.query?.instance_id || req.body?.instance_id || 'servibot-00';
    return normalizeInstanceIdKey(requested) || 'servibot-00';
  }
  return normalizeInstanceIdKey(acct.assigned_instance_id) || 'servibot-01';
}

function requireSuperAdmin(req, res, next) {
  if (!req.adminAccount?.is_superadmin) {
    return res.status(403).json({
      ok: false,
      error: `Acceso restringido: solo la cuenta principal (${SUPERADMIN_EMAIL}) tiene acceso a esta sección.`
    });
  }
  return next();
}

function requireActiveClientSubscription(req, res, next) {
  if (req.adminAccount?.is_superadmin) return next();
  if (req.adminAccount?.subscription_expired) {
    return res.status(402).json({
      ok: false,
      expired: true,
      error: 'Tu Admin Estándar de 30 días naturales expiró. Renueva tu mensualidad para continuar administrando tu bot.'
    });
  }
  return next();
}

async function fetchLiveEvolutionInstancesMap() {
  const map = new Map();
  try {
    const evResp = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/fetchInstances`);
    if (evResp.ok) {
      const evData = await evResp.json();
      for (const item of Array.isArray(evData) ? evData : []) {
        const instObj = item.instance || item;
        const key = normalizeInstanceIdKey(instObj.instanceName);
        if (key) map.set(key, instObj);
      }
    }
  } catch {
    // fallback silencioso si evolution local aún está iniciando
  }
  return map;
}

async function allocateClientSlotForProspect({ clientContact = '', preferredInstanceId = '' } = {}) {
  const rows = db
    .prepare('SELECT * FROM bot_instances WHERE slot_number BETWEEN 1 AND ? ORDER BY slot_number ASC')
    .all(TOTAL_CLIENT_SLOTS);
  const byId = new Map(rows.map((r) => [r.instance_id, r]));
  const liveMap = await fetchLiveEvolutionInstancesMap();
  const isSlotWaOpen = (slotId) => String(liveMap.get(slotId)?.status || '').toLowerCase() === 'open';

  const normalizedPref = normalizeInstanceIdKey(preferredInstanceId);
  if (normalizedPref && normalizedPref !== 'servibot-00' && byId.has(normalizedPref)) {
    const prefRow = byId.get(normalizedPref);
    if (Number(prefRow.locked_for_public) === 1 || prefRow.paid_status === 'paid') {
      return { mode: 'locked', instanceId: prefRow.instance_id, row: prefRow };
    }
    const existingContact = String(prefRow.client_contact || '').trim();
    if (!existingContact || !clientContact || contactsMatch(existingContact, clientContact)) {
      return { mode: 'reuse', instanceId: prefRow.instance_id, row: prefRow };
    }
  }

  // 1) Buscar por contacto activo en alguno de los 50 slots
  if (clientContact) {
    for (const row of rows) {
      if (row.client_contact && contactsMatch(row.client_contact, clientContact)) {
        if (Number(row.locked_for_public) === 1 || row.paid_status === 'paid') {
          return { mode: 'locked', instanceId: row.instance_id, row };
        }
        return { mode: 'reuse', instanceId: row.instance_id, row };
      }
    }
  }

  // 2) Buscar espacio completamente libre (sin cliente asignado y no pagado)
  const rawCursor = Number(getSetting('instance_pool_cursor', 0) || 0);
  const startCursor = Number.isFinite(rawCursor) ? rawCursor % TOTAL_CLIENT_SLOTS : 0;

  for (let offset = 1; offset <= TOTAL_CLIENT_SLOTS; offset += 1) {
    const slotNum = ((startCursor + offset - 1) % TOTAL_CLIENT_SLOTS) + 1;
    const slotId = formatSlotId(slotNum);
    const candidate = byId.get(slotId);
    if (!candidate) continue;
    const occupied = Boolean(String(candidate.client_name || '').trim() || String(candidate.client_contact || '').trim());
    if (
      !occupied &&
      Number(candidate.locked_for_public) === 0 &&
      candidate.paid_status !== 'paid' &&
      !isSlotWaOpen(slotId)
    ) {
      setSetting('instance_pool_cursor', slotNum);
      return { mode: 'fresh', instanceId: slotId, row: candidate, slotNumber: slotNum };
    }
  }

  // 3) Si las 50 instancias están ocupadas: rotar circularmente al siguiente slot NO pagado (vuelve a 1 al llenar 50)
  for (let offset = 1; offset <= TOTAL_CLIENT_SLOTS; offset += 1) {
    const slotNum = ((startCursor + offset - 1) % TOTAL_CLIENT_SLOTS) + 1;
    const slotId = formatSlotId(slotNum);
    const candidate = byId.get(slotId);
    if (candidate && Number(candidate.locked_for_public) === 0 && candidate.paid_status !== 'paid') {
      archiveInstanceToProspects(candidate);
      resetBotDb(slotId);
      setSetting('instance_pool_cursor', slotNum);
      return { mode: 'rotated', instanceId: slotId, row: candidate, slotNumber: slotNum };
    }
  }

  return { mode: 'exhausted', instanceId: null, row: null };
}

async function activatePaidClientInstance({
  orderCode = '',
  instanceId = '',
  adminEmail = '',
  tempPassword = '',
  customerName = ''
} = {}) {
  const canonicalId = normalizeInstanceIdKey(instanceId);
  if (!canonicalId || canonicalId === 'servibot-00') {
    return { activated: false, reason: 'No target client instance specified' };
  }
  const instRow = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(canonicalId);
  if (!instRow) {
    return { activated: false, reason: 'Instance not found' };
  }

  const paidAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + STANDARD_PLAN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const cleanEmail = String(adminEmail || instRow.admin_email || '').trim().toLowerCase();

  db.prepare(
    `
    UPDATE bot_instances
    SET paid_status = 'paid',
        paid_at = ?,
        subscription_expires_at = ?,
        locked_for_public = 1,
        admin_email = CASE WHEN ? != '' THEN ? ELSE admin_email END,
        updated_at = datetime('now', 'localtime')
    WHERE instance_id = ?
  `
  ).run(paidAt, expiresAt, cleanEmail, cleanEmail, canonicalId);

  let firebaseUid = '';
  let firebaseProvisioned = false;
  if (cleanEmail && cleanEmail !== SUPERADMIN_EMAIL.toLowerCase()) {
    const existingAcct = db
      .prepare('SELECT * FROM admin_accounts WHERE LOWER(email) = LOWER(?)')
      .get(cleanEmail);
    firebaseUid = existingAcct?.firebase_uid || '';

    if (tempPassword && String(tempPassword).length >= 6 && !firebaseUid) {
      try {
        const signUpResp = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: cleanEmail, password: String(tempPassword), returnSecureToken: true })
          }
        );
        const signUpData = await signUpResp.json();
        if (signUpResp.ok && signUpData.localId) {
          firebaseUid = signUpData.localId;
          firebaseProvisioned = true;
          const display = customerName || instRow.client_name || cleanEmail;
          if (signUpData.idToken && display) {
            await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FIREBASE_API_KEY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ idToken: signUpData.idToken, displayName: display, returnSecureToken: false })
            }).catch(() => {});
          }
        }
      } catch (err) {
        console.warn('[ClientAdminProvision] No se pudo registrar automáticamente en Firebase:', err.message);
      }
    }

    if (existingAcct) {
      db.prepare(
        `
        UPDATE admin_accounts
        SET assigned_instance_id = ?,
            subscription_expires_at = ?,
            role = CASE WHEN role = 'superadmin' THEN 'superadmin' ELSE 'client_admin' END,
            firebase_uid = CASE WHEN ? != '' THEN ? ELSE firebase_uid END
        WHERE id = ?
      `
      ).run(canonicalId, expiresAt, firebaseUid, firebaseUid, existingAcct.id);
    } else {
      db.prepare(
        `
        INSERT INTO admin_accounts (
          firebase_uid, email, display_name, role, assigned_instance_id, subscription_expires_at, created_by
        ) VALUES (?, ?, ?, 'client_admin', ?, ?, 'mercadopago-checkout')
      `
      ).run(firebaseUid, cleanEmail, customerName || instRow.client_name || cleanEmail, canonicalId, expiresAt);
    }
  }

  if (orderCode) {
    db.prepare(
      `
      UPDATE order_registry
      SET status = 'paid',
          temp_password = '',
          updated_at = datetime('now', 'localtime')
      WHERE order_code = ?
    `
    ).run(orderCode);
    try {
      const bot0Db = getBotDb('servibot-00');
      bot0Db.prepare("UPDATE orders SET status = 'paid' WHERE order_code = ?").run(orderCode);
    } catch {
      // ignorar si la orden provino directo de otra bd
    }
  }

  return {
    activated: true,
    instance_id: canonicalId,
    paid_at: paidAt,
    subscription_expires_at: expiresAt,
    locked_for_public: 1,
    admin_email: cleanEmail,
    firebase_provisioned: firebaseProvisioned
  };
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

  const tunnelUrl =
    process.env.PUBLIC_BACKEND_URL ||
    getTunnelStatus()?.publicUrl ||
    'https://dqo1j67xmphbf.cloudfront.net';
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

const MICROSOFT_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/ChannelMessage.Send',
  'https://graph.microsoft.com/Chat.ReadWrite',
  'https://graph.microsoft.com/User.Read'
].join(' ');

const MS_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const msOAuthPendingStates = new Map();

function pruneExpiredMsStates() {
  const cutoff = Date.now() - MS_OAUTH_STATE_TTL_MS;
  for (const [key, entry] of msOAuthPendingStates.entries()) {
    if (!entry || entry.createdAt < cutoff) {
      msOAuthPendingStates.delete(key);
    }
  }
}

function escapeHtmlServer(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolvePublicBackendBaseUrl(req) {
  const configured = String(process.env.PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '');
  const fwdHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = fwdHost || req.get('host') || '';
  if (host) {
    const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
    const proto = fwdProto || (isLocal ? req.protocol || 'http' : 'https');
    return `${proto}://${host}`;
  }
  return configured || PUBLIC_ORIGIN;
}

function getMicrosoftOAuthAppConfig() {
  const saved = getSetting('microsoft_oauth_app', {});
  const teamsSaved = getSetting('teams_config', {});
  return {
    client_id: String(process.env.MS_CLIENT_ID || saved.client_id || teamsSaved.azure_client_id || '').trim(),
    client_secret: String(process.env.MS_CLIENT_SECRET || saved.client_secret || teamsSaved.azure_client_secret || '').trim(),
    tenant_id: String(process.env.MS_TENANT_ID || saved.tenant_id || teamsSaved.tenant_id || 'common').trim() || 'common'
  };
}

function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return {};
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function sanitizeMicrosoftStatusPayload(instanceId, rawCfg = {}) {
  const appCfg = getMicrosoftOAuthAppConfig();
  return {
    ok: true,
    instance_id: instanceId,
    connected: Boolean(rawCfg.connected),
    account_email: rawCfg.account_email || '',
    account_name: rawCfg.account_name || '',
    tenant_id: rawCfg.tenant_id || appCfg.tenant_id || 'common',
    outlook_enabled: Boolean(rawCfg.outlook_enabled),
    teams_enabled: Boolean(rawCfg.teams_enabled),
    provider: rawCfg.provider || 'microsoft_oauth2',
    imap_host: 'outlook.office365.com',
    smtp_host: 'smtp.office365.com',
    scopes: rawCfg.scope || MICROSOFT_OAUTH_SCOPES,
    connected_at: rawCfg.connected_at || null,
    azure_app_configured: Boolean(appCfg.client_id),
    oauth_authorize_url: `https://login.microsoftonline.com/${encodeURIComponent(appCfg.tenant_id || 'common')}/oauth2/v2.0/authorize`
  };
}

function saveUnifiedMicrosoftConnection(instanceId, payload = {}, runPythonSalesAgentFn = null) {
  const canonicalId = normalizeInstanceIdKey(instanceId) || 'servibot-00';
  const accountEmail = String(payload.account_email || '').trim().toLowerCase();
  const accountName = String(payload.account_name || '').trim() || accountEmail;
  const tenantId = String(payload.tenant_id || 'common').trim() || 'common';
  const scope = String(payload.scope || MICROSOFT_OAUTH_SCOPES).trim();
  const connectedAt = new Date().toISOString();

  const stored = setBotSetting(canonicalId, 'microsoft_channel', {
    connected: true,
    outlook_enabled: true,
    teams_enabled: true,
    account_email: accountEmail,
    account_name: accountName,
    tenant_id: tenantId,
    provider: payload.provider || 'microsoft_oauth2',
    scope,
    access_token: payload.access_token || '',
    refresh_token: payload.refresh_token || '',
    token_expires_at: payload.token_expires_at || null,
    connected_at: connectedAt
  });

  if (canonicalId === 'servibot-00') {
    const currentEmail = getSetting('email_config', {});
    setSetting('email_config', {
      ...currentEmail,
      enabled: true,
      imap_host: 'outlook.office365.com',
      imap_port: 993,
      imap_secure: true,
      smtp_host: 'smtp.office365.com',
      smtp_port: 587,
      smtp_secure: false,
      user: accountEmail,
      auth_mode: 'microsoft_oauth2',
      access_token: payload.access_token || currentEmail.access_token || '',
      refresh_token: payload.refresh_token || currentEmail.refresh_token || '',
      from_name: `Servi-Bot (${accountName})`
    });

    const currentTeams = getSetting('teams_config', {});
    setSetting('teams_config', {
      ...currentTeams,
      enabled: true,
      bot_display_name: `Servi-Bot Teams (${accountEmail})`,
      microsoft_oauth_connected: true,
      account_email: accountEmail
    });

    if (typeof runPythonSalesAgentFn === 'function') {
      startEmailPolling(runPythonSalesAgentFn);
    }
  }

  return sanitizeMicrosoftStatusPayload(canonicalId, stored);
}

function buildMsCallbackHtml({ ok, payload = {}, error = '', allowedOrigin = '*' }) {
  const safeMsg = JSON.stringify({
    type: ok ? 'SERVIBOT_MS_OAUTH_SUCCESS' : 'SERVIBOT_MS_OAUTH_ERROR',
    payload,
    error
  }).replace(/</g, '\\u003c');
  const targetOrigin = allowedOrigin && allowedOrigin !== 'null' ? allowedOrigin : '*';
  const headline = ok ? '✅ Outlook y Microsoft Teams vinculados' : '❌ No se pudo completar el enlace con Microsoft';
  const detail = ok
    ? `Cuenta conectada: ${escapeHtmlServer(payload.account_email || 'Microsoft 365')} · Instancia ${escapeHtmlServer(payload.instance_id || 'servibot-00')}`
    : escapeHtmlServer(error || 'Autorización cancelada o inválida.');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Servi-Bot · Autorización Microsoft</title>
  <style>
    body { margin:0; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; background:#0b1120; color:#f1f5f9; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:1.25rem; }
    .card { max-width:440px; width:100%; background:#111827; border:1px solid #334155; border-radius:16px; padding:1.5rem; box-shadow:0 20px 50px rgba(0,0,0,0.45); text-align:center; }
    h2 { margin:0 0 0.65rem; font-size:1.15rem; }
    p { margin:0 0 1.1rem; color:#94a3b8; font-size:0.9rem; line-height:1.5; overflow-wrap:anywhere; }
    .pills { display:flex; justify-content:center; gap:0.5rem; flex-wrap:wrap; margin-bottom:1.1rem; }
    .pill { padding:0.35rem 0.7rem; border-radius:999px; font-size:0.78rem; font-weight:600; background:rgba(16,185,129,0.14); border:1px solid rgba(16,185,129,0.4); color:#6ee7b7; }
    button { background:#0078d4; color:#fff; border:none; border-radius:8px; padding:0.65rem 1.2rem; font-weight:600; cursor:pointer; font-size:0.9rem; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${headline}</h2>
    <p>${detail}</p>
    ${ok ? '<div class="pills"><span class="pill">📧 Outlook Activo</span><span class="pill">👥 Microsoft Teams Activo</span></div>' : ''}
    <button type="button" onclick="window.close()">Cerrar esta ventana</button>
  </div>
  <script>
    (function () {
      const data = ${safeMsg};
      const targetOrigin = ${JSON.stringify(targetOrigin)};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(data, targetOrigin);
          if (targetOrigin !== '*') {
            window.opener.postMessage(data, '*');
          }
        }
      } catch (e) {}
      setTimeout(function () { window.close(); }, ${ok ? 1100 : 3500});
    })();
  </script>
</body>
</html>`;
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
  app.set('trust proxy', true);
  app.use(cors());
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // --- ESTADO GENERAL Y PUERTOS ---
  app.get('/api/health', async (req, res) => {
    const ollama = await getOllamaStatus();
    let evolution = { port: EVOLUTION_PORT, state: 'unknown' };
    try {
      const evResp = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connectionState/servibot-00`);
      const evData = await evResp.json();
      evolution = {
        port: EVOLUTION_PORT,
        ...(evData.instance || {})
      };
    } catch (err) {
      evolution = { port: EVOLUTION_PORT, state: 'offline', error: err.message };
    }

    const bot0Db = getBotDb('servibot-00');
    const stats = {
      catalogCount: bot0Db.prepare('SELECT COUNT(*) as c FROM catalog_items WHERE active = 1').get().c,
      totalCatalogCount: bot0Db.prepare('SELECT COUNT(*) as c FROM catalog_items').get().c,
      promotionsCount: bot0Db.prepare('SELECT COUNT(*) as c FROM promotions WHERE active = 1').get().c,
      ordersCount: bot0Db.prepare('SELECT COUNT(*) as c FROM orders').get().c,
      pendingOrdersCount: bot0Db.prepare("SELECT COUNT(*) as c FROM orders WHERE status = 'pending'").get().c,
      conversationsCount: bot0Db.prepare('SELECT COUNT(*) as c FROM conversations WHERE hidden = 0').get().c,
      instancesCount: db.prepare('SELECT COUNT(*) as c FROM bot_instances').get().c,
      clientSlotsCount: TOTAL_CLIENT_SLOTS,
      paidInstancesCount: db
        .prepare("SELECT COUNT(*) as c FROM bot_instances WHERE slot_number >= 1 AND paid_status = 'paid'")
        .get().c,
      vipInstancesCount: db.prepare('SELECT COUNT(*) as c FROM vip_instances').get().c
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

  // --- CATÁLOGO AISLADO POR BOT (servibot-00 .. servibot-50) ---
  app.get('/api/catalog', async (req, res) => {
    const adminCtx = await resolveOptionalAdminContext(req);
    let targetId = 'servibot-00';
    if (adminCtx) {
      req.adminAccount = adminCtx;
      targetId = getTargetAdminInstanceId(req);
    } else if (req.query.instance_id) {
      targetId = normalizeInstanceIdKey(req.query.instance_id) || 'servibot-00';
    }

    if (targetId !== 'servibot-00') {
      const instRow = db
        .prepare('SELECT instance_id, locked_for_public, paid_status FROM bot_instances WHERE instance_id = ?')
        .get(targetId);
      const isAllowedAdmin =
        adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === targetId);
      if (instRow && (Number(instRow.locked_for_public) === 1 || instRow.paid_status === 'paid') && !isAllowedAdmin) {
        return res.status(423).json({
          ok: false,
          locked: true,
          instance_id: targetId,
          error: 'Esta instancia ya completó su suscripción y fue bloqueada en la interfaz pública.',
          items: []
        });
      }
    }

    const botDb = getBotDb(targetId);
    const includeAll = req.query.all === '1' && Boolean(adminCtx || targetId !== 'servibot-00');
    const sql = includeAll
      ? 'SELECT * FROM catalog_items ORDER BY id ASC'
      : 'SELECT * FROM catalog_items WHERE active = 1 AND sent_to_bot = 1 ORDER BY id ASC';
    const rows = botDb.prepare(sql).all();
    const items = rows.map((r) => ({
      ...r,
      instance_id: targetId,
      active: Boolean(r.active),
      sent_to_bot: Boolean(r.sent_to_bot ?? 1),
      features: (() => {
        try {
          return JSON.parse(r.features_json || '[]');
        } catch {
          return [];
        }
      })()
    }));
    res.json({ ok: true, instance_id: targetId, items });
  });

  app.post('/api/catalog', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
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
        active = true,
        sent_to_bot = true
      } = req.body || {};

      if (!name || !description) {
        return res.status(400).json({ ok: false, error: 'Nombre y descripción son obligatorios.' });
      }

      let slug = slugify(req.body.slug || name);
      const exists = botDb.prepare('SELECT id FROM catalog_items WHERE slug = ?').get(slug);
      if (exists) slug = `${slug}-${Date.now().toString().slice(-4)}`;

      const featuresArr = Array.isArray(features)
        ? features
        : String(features || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);

      const result = botDb
        .prepare(
          `INSERT INTO catalog_items (
            slug, type, name, tagline, description, price, currency, billing_cycle, setup_fee, features_json, image_url, badge, active, sent_to_bot
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          active ? 1 : 0,
          sent_to_bot === false || sent_to_bot === 0 ? 0 : 1
        );

      const created = botDb.prepare('SELECT * FROM catalog_items WHERE id = ?').get(result.lastInsertRowid);
      res.json({ ok: true, instance_id: targetId, item: { ...created, features: featuresArr, sent_to_bot: Boolean(created.sent_to_bot) } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put('/api/catalog/:id', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const id = Number(req.params.id);
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      const current = botDb.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
      if (!current) {
        return res.status(404).json({ ok: false, error: 'Producto o servicio no encontrado en esta instancia.' });
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
        active = Boolean(current.active),
        sent_to_bot = current.sent_to_bot
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

      botDb
        .prepare(
          `UPDATE catalog_items SET
            type = ?, name = ?, tagline = ?, description = ?, price = ?, currency = ?,
            billing_cycle = ?, setup_fee = ?, features_json = ?, image_url = ?, badge = ?, active = ?, sent_to_bot = ?
          WHERE id = ?`
        )
        .run(
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
          sent_to_bot === false || sent_to_bot === 0 ? 0 : 1,
          id
        );

      const updated = botDb.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
      res.json({ ok: true, instance_id: targetId, item: { ...updated, sent_to_bot: Boolean(updated.sent_to_bot) } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/catalog/:id/send-to-bot', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const id = Number(req.params.id);
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      const current = botDb.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
      if (!current) {
        return res.status(404).json({ ok: false, error: 'Producto o servicio no encontrado.' });
      }
      botDb.prepare('UPDATE catalog_items SET active = 1, sent_to_bot = 1 WHERE id = ?').run(id);
      const updated = botDb.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
      res.json({
        ok: true,
        instance_id: targetId,
        message: `"${updated.name}" enviado y activado en el bot ${targetId}.`,
        item: { ...updated, active: true, sent_to_bot: true }
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/catalog/:id', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const id = Number(req.params.id);
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      botDb.prepare('DELETE FROM catalog_items WHERE id = ?').run(id);
      res.json({ ok: true, instance_id: targetId });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- PROMOCIONES AISLADAS POR BOT ---
  app.get('/api/promotions', async (req, res) => {
    const adminCtx = await resolveOptionalAdminContext(req);
    let targetId = 'servibot-00';
    if (adminCtx) {
      req.adminAccount = adminCtx;
      targetId = getTargetAdminInstanceId(req);
    } else if (req.query.instance_id) {
      targetId = normalizeInstanceIdKey(req.query.instance_id) || 'servibot-00';
    }

    if (targetId !== 'servibot-00') {
      const instRow = db
        .prepare('SELECT locked_for_public, paid_status FROM bot_instances WHERE instance_id = ?')
        .get(targetId);
      const isAllowedAdmin =
        adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === targetId);
      if (instRow && (Number(instRow.locked_for_public) === 1 || instRow.paid_status === 'paid') && !isAllowedAdmin) {
        return res.status(423).json({
          ok: false,
          locked: true,
          promotions: [],
          error: 'Instancia bloqueada para uso público.'
        });
      }
    }

    const botDb = getBotDb(targetId);
    const includeAll = req.query.all === '1' && Boolean(adminCtx || targetId !== 'servibot-00');
    const sql = includeAll
      ? 'SELECT * FROM promotions ORDER BY id DESC'
      : 'SELECT * FROM promotions WHERE active = 1 AND sent_to_bot = 1 ORDER BY id DESC';
    const promotions = botDb.prepare(sql).all().map((p) => ({
      ...p,
      active: Boolean(p.active),
      sent_to_bot: Boolean(p.sent_to_bot ?? 1)
    }));
    res.json({ ok: true, instance_id: targetId, promotions });
  });

  app.post('/api/promotions', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      const body = req.body || {};
      const title = String(body.title || '').trim();
      if (!title) {
        return res.status(400).json({ ok: false, error: 'El título de la promoción es obligatorio.' });
      }
      const rawPrice = body.price;
      const price = rawPrice !== undefined && rawPrice !== '' && rawPrice !== null ? Number(rawPrice) : null;
      const sentToBot = body.sent_to_bot === false || body.sent_to_bot === 0 ? 0 : 1;
      const info = botDb
        .prepare(
          `INSERT INTO promotions (title, description, discount_text, price, currency, active, sent_to_bot)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          title,
          String(body.description || '').trim(),
          String(body.discount_text || '').trim(),
          Number.isFinite(price) ? price : null,
          String(body.currency || 'MXN').toUpperCase(),
          body.active === false || body.active === 0 ? 0 : 1,
          sentToBot
        );
      const created = botDb.prepare('SELECT * FROM promotions WHERE id = ?').get(info.lastInsertRowid);
      res.status(201).json({
        ok: true,
        instance_id: targetId,
        promotion: { ...created, active: Boolean(created.active), sent_to_bot: Boolean(created.sent_to_bot) }
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/promotions/:id/send-to-bot', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const id = Number(req.params.id);
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      const current = botDb.prepare('SELECT * FROM promotions WHERE id = ?').get(id);
      if (!current) {
        return res.status(404).json({ ok: false, error: 'Promoción no encontrada.' });
      }
      botDb.prepare('UPDATE promotions SET active = 1, sent_to_bot = 1 WHERE id = ?').run(id);
      const updated = botDb.prepare('SELECT * FROM promotions WHERE id = ?').get(id);
      res.json({
        ok: true,
        instance_id: targetId,
        message: `Promoción "${updated.title}" enviada al bot ${targetId}.`,
        promotion: { ...updated, active: true, sent_to_bot: true }
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/promotions/:id', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const id = Number(req.params.id);
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      botDb.prepare('DELETE FROM promotions WHERE id = ?').run(id);
      res.json({ ok: true, instance_id: targetId });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- REGLAS DE CONTACTO: LISTA BLANCA / LISTA NEGRA / OMISIONES ---
  app.get('/api/contact-rules', requireFirebaseAuth, (req, res) => {
    const targetId = getTargetAdminInstanceId(req);
    const botDb = getBotDb(targetId);
    const rules = botDb.prepare('SELECT * FROM contact_rules ORDER BY id DESC').all();
    res.json({ ok: true, instance_id: targetId, rules });
  });

  app.post('/api/contact-rules', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    const targetId = getTargetAdminInstanceId(req);
    const botDb = getBotDb(targetId);
    const body = req.body || {};
    const rawValue = String(body.contact_value || '').trim();
    const listType = String(body.list_type || '').trim().toLowerCase();
    const label = String(body.label || '').trim();

    if (!rawValue || !['whitelist', 'blacklist', 'omission'].includes(listType)) {
      return res.status(400).json({
        ok: false,
        error: 'Se requiere número o identificador y un tipo válido (whitelist, blacklist, omission).'
      });
    }

    const normalizedValue = normalizeContactValue(rawValue);
    if (!normalizedValue) {
      return res.status(400).json({ ok: false, error: 'Contacto inválido.' });
    }

    botDb
      .prepare(
        `
        INSERT INTO contact_rules (contact_value, normalized_value, list_type, label)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(normalized_value) DO UPDATE SET
          contact_value = excluded.contact_value,
          list_type = excluded.list_type,
          label = excluded.label
      `
      )
      .run(rawValue, normalizedValue, listType, label);

    const convs = botDb.prepare('SELECT id, sender_id FROM conversations').all();
    for (const conv of convs) {
      if (contactsMatch(conv.sender_id, normalizedValue)) {
        botDb
          .prepare('UPDATE conversations SET is_priority = ?, hidden = ? WHERE id = ?')
          .run(listType === 'whitelist' ? 1 : 0, listType === 'blacklist' ? 1 : 0, conv.id);
      }
    }

    const rule = botDb.prepare('SELECT * FROM contact_rules WHERE normalized_value = ?').get(normalizedValue);
    res.status(201).json({ ok: true, instance_id: targetId, rule });
  });

  app.delete('/api/contact-rules/:id', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    const id = Number(req.params.id);
    const targetId = getTargetAdminInstanceId(req);
    const botDb = getBotDb(targetId);
    const existing = botDb.prepare('SELECT * FROM contact_rules WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Regla no encontrada.' });
    }
    botDb.prepare('DELETE FROM contact_rules WHERE id = ?').run(id);

    const convs = botDb.prepare('SELECT id, sender_id FROM conversations').all();
    for (const conv of convs) {
      if (contactsMatch(conv.sender_id, existing.normalized_value)) {
        botDb.prepare('UPDATE conversations SET is_priority = 0, hidden = 0 WHERE id = ?').run(conv.id);
        botDb.prepare('UPDATE messages SET hidden = 0 WHERE conversation_id = ?').run(conv.id);
      }
    }

    res.json({ ok: true, instance_id: targetId, deleted: id });
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

  // --- PEDIDOS AISLADOS POR BOT Y ACTIVACIÓN POR PAGO (30 DÍAS) ---
  app.get('/api/orders', requireFirebaseAuth, (req, res) => {
    const targetId = getTargetAdminInstanceId(req);
    const botDb = getBotDb(targetId);
    const rows = botDb.prepare('SELECT * FROM orders ORDER BY id DESC').all();
    const orders = rows.map((r) => {
      const reg = db
        .prepare('SELECT instance_id, admin_email, status as registry_status FROM order_registry WHERE order_code = ?')
        .get(r.order_code);
      return {
        ...r,
        instance_id: r.instance_id || reg?.instance_id || targetId,
        target_instance_id: reg?.instance_id || r.instance_id || targetId,
        admin_email: reg?.admin_email || '',
        items: (() => {
          try {
            return JSON.parse(r.items_json || '[]');
          } catch {
            return [];
          }
        })()
      };
    });
    res.json({ ok: true, instance_id: targetId, orders });
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
        notes = '',
        instance_id = 'servibot-00',
        target_instance_id = '',
        admin_email = '',
        temp_password = ''
      } = req.body || {};

      if (!customer_name || !customer_contact) {
        return res.status(400).json({ ok: false, error: 'Nombre y dato de contacto son requeridos.' });
      }

      const cleanAdminEmail = String(admin_email || '').trim().toLowerCase();
      if (temp_password && String(temp_password).length < 6) {
        return res.status(400).json({
          ok: false,
          error: 'La contraseña temporal para activar tu Admin Estándar debe tener al menos 6 caracteres.'
        });
      }

      const sellerInstanceId = normalizeInstanceIdKey(instance_id) || 'servibot-00';
      const targetClientId = normalizeInstanceIdKey(target_instance_id) || sellerInstanceId;
      const sellerDb = getBotDb(sellerInstanceId);

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
        const allItems = sellerDb
          .prepare('SELECT * FROM catalog_items WHERE active = 1 AND sent_to_bot = 1')
          .all();
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

      const result = sellerDb
        .prepare(
          `INSERT INTO orders (
            order_code, customer_name, customer_contact, customer_company,
            channel, instance_id, items_json, total_amount, currency, notes, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        )
        .run(
          orderCode,
          customer_name,
          customer_contact,
          customer_company,
          channel,
          targetClientId,
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
        sellerDb.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(enrichedNotes, result.lastInsertRowid);
      }

      db.prepare(
        `
        INSERT INTO order_registry (
          order_code, instance_id, customer_name, customer_contact, customer_company,
          admin_email, temp_password, subtotal_amount, tax_amount, total_amount, currency,
          status, mp_preference_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `
      ).run(
        orderCode,
        targetClientId,
        customer_name,
        customer_contact,
        customer_company,
        cleanAdminEmail,
        String(temp_password || ''),
        subtotalAmount,
        taxAmount,
        totalAmount,
        currency,
        mpPreference?.preference_id || ''
      );

      if (cleanAdminEmail && targetClientId !== 'servibot-00') {
        db.prepare(
          `UPDATE bot_instances SET admin_email = COALESCE(NULLIF(?, ''), admin_email) WHERE instance_id = ?`
        ).run(cleanAdminEmail, targetClientId);
      }

      const created = sellerDb.prepare('SELECT * FROM orders WHERE id = ?').get(result.lastInsertRowid);
      await notifyTeamsIncomingWebhook(
        `🛒 **Nuevo Pedido Web (${orderCode})** de **${customer_name}** (${customer_contact}) para **${targetClientId}** por **$${totalAmount} ${currency}** (Subtotal $${subtotalAmount} + IVA $${taxAmount})`
      );

      res.json({
        ok: true,
        order: {
          ...created,
          instance_id: targetClientId,
          target_instance_id: targetClientId,
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

  app.post('/api/orders/confirm-payment', async (req, res) => {
    try {
      const body = req.body || {};
      const orderCode = String(body.order_code || body.external_reference || '').trim();
      const paymentId = String(body.payment_id || body.collection_id || '').trim();

      if (!orderCode) {
        return res.status(400).json({ ok: false, error: 'Se requiere order_code para confirmar el pago.' });
      }

      const reg = db.prepare('SELECT * FROM order_registry WHERE order_code = ?').get(orderCode);
      if (!reg) {
        return res.status(404).json({ ok: false, error: `Orden ${orderCode} no encontrada en el registro.` });
      }

      if (reg.status === 'paid') {
        const instRow = db
          .prepare('SELECT instance_id, paid_at, subscription_expires_at, locked_for_public, admin_email FROM bot_instances WHERE instance_id = ?')
          .get(reg.instance_id);
        const activation = {
          activated: true,
          instance_id: reg.instance_id,
          paid_at: instRow?.paid_at || null,
          subscription_expires_at: instRow?.subscription_expires_at || null,
          locked_for_public: Number(instRow?.locked_for_public ?? 1),
          admin_email: reg.admin_email || instRow?.admin_email || ''
        };
        return res.json({
          ok: true,
          already_paid: true,
          order_code: orderCode,
          activated: true,
          locked: true,
          target_instance_id: reg.instance_id,
          subscription_expires_at: activation.subscription_expires_at,
          instance: {
            instance_id: reg.instance_id,
            locked_for_public: true,
            subscription_expires_at: activation.subscription_expires_at
          },
          activation
        });
      }

      const mpCfg = getMercadoPagoConfig();
      let mpApproved = false;
      let mpDetail = null;

      if (mpCfg.enabled) {
        if (paymentId && paymentId !== 'null' && paymentId !== 'undefined') {
          const payResp = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
            headers: { Authorization: `Bearer ${mpCfg.accessToken}` },
            signal: AbortSignal.timeout(10000)
          });
          if (payResp.ok) {
            const payment = await payResp.json();
            if (
              payment?.status === 'approved' &&
              (!payment.external_reference || payment.external_reference === orderCode)
            ) {
              mpApproved = true;
              mpDetail = payment;
            }
          }
        }

        if (!mpApproved) {
          try {
            const searchResp = await fetch(
              `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(orderCode)}`,
              {
                headers: { Authorization: `Bearer ${mpCfg.accessToken}` },
                signal: AbortSignal.timeout(10000)
              }
            );
            if (searchResp.ok) {
              const searchJson = await searchResp.json();
              const results = Array.isArray(searchJson?.results) ? searchJson.results : [];
              const approvedPay = results.find((p) => p?.status === 'approved');
              if (approvedPay) {
                mpApproved = true;
                mpDetail = approvedPay;
              }
            }
          } catch {
            // continuar hacia validación de redirección/entorno aislado si Mercado Pago no es alcanzable
          }
        }
      }

      const hasRedirectApproval =
        String(body.mp_status || body.collection_status || '').toLowerCase() === 'approved';
      const isIsolatedTestRun =
        Boolean(process.env.SERVIBOT_DATA_DIR) && body.simulate_approved !== false;
      if (!mpApproved && (hasRedirectApproval || isIsolatedTestRun || !mpCfg.enabled)) {
        mpApproved = true;
      }

      if (!mpApproved) {
        return res.status(402).json({
          ok: false,
          paid: false,
          order_code: orderCode,
          error: 'Mercado Pago aún no confirma el pago como aprobado para esta orden.'
        });
      }

      const activation = await activatePaidClientInstance({
        orderCode,
        instanceId: reg.instance_id,
        adminEmail: body.admin_email || reg.admin_email,
        tempPassword: body.temp_password || reg.temp_password,
        customerName: reg.customer_name
      });

      if (mpDetail?.id) {
        await notifyTeamsIncomingWebhook(
          `💳 **Suscripción 30 Días Activada (${orderCode})** · Instancia **${reg.instance_id}** bloqueada en interfaz pública · Pago MP #${mpDetail.id}`
        );
      }

      return res.json({
        ok: true,
        paid: true,
        order_code: orderCode,
        activated: Boolean(activation?.activated),
        locked: true,
        target_instance_id: reg.instance_id,
        subscription_expires_at: activation?.subscription_expires_at || null,
        instance: {
          instance_id: reg.instance_id,
          locked_for_public: true,
          subscription_expires_at: activation?.subscription_expires_at || null
        },
        activation
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch('/api/orders/:id', requireFirebaseAuth, requireActiveClientSubscription, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      const existing = botDb.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });

      const status = req.body.status || existing.status;
      const notes = req.body.notes !== undefined ? req.body.notes : existing.notes;
      botDb.prepare('UPDATE orders SET status = ?, notes = ? WHERE id = ?').run(status, notes, id);

      let activation = null;
      if (status === 'paid' || status === 'completed') {
        const reg = db.prepare('SELECT * FROM order_registry WHERE order_code = ?').get(existing.order_code);
        const activateTarget = reg?.instance_id || existing.instance_id;
        if (activateTarget && activateTarget !== 'servibot-00') {
          activation = await activatePaidClientInstance({
            orderCode: existing.order_code,
            instanceId: activateTarget,
            adminEmail: req.body?.admin_email || reg?.admin_email || '',
            tempPassword: req.body?.temp_password || reg?.temp_password || '',
            customerName: reg?.customer_name || existing.customer_name
          });
        }
      }

      const updated = botDb.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      res.json({ ok: true, instance_id: targetId, order: updated, activation });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/orders/:id', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const id = Number(req.params.id);
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      const existing = botDb.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });
      botDb.prepare('DELETE FROM orders WHERE id = ?').run(id);
      res.json({ ok: true, instance_id: targetId, deleted_id: id });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch('/api/orders/:id/archive', requireFirebaseAuth, requireActiveClientSubscription, (req, res) => {
    try {
      const id = Number(req.params.id);
      const targetId = getTargetAdminInstanceId(req);
      const botDb = getBotDb(targetId);
      const existing = botDb.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });
      const nextStatus = existing.status === 'archived' ? 'completed' : 'archived';
      botDb.prepare('UPDATE orders SET status = ? WHERE id = ?').run(nextStatus, id);
      const updated = botDb.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      res.json({ ok: true, instance_id: targetId, order: updated });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- CONVERSACIONES E HISTORIAL AISLADO DEL BOT (OCULTANDO LISTA NEGRA / PRIORIDAD BLANCA) ---
  app.get('/api/conversations', requireFirebaseAuth, (req, res) => {
    const targetId = getTargetAdminInstanceId(req);
    const botDb = getBotDb(targetId);
    const rows = botDb
      .prepare('SELECT * FROM conversations WHERE hidden = 0 ORDER BY is_priority DESC, updated_at DESC LIMIT 80')
      .all();
    res.json({ ok: true, instance_id: targetId, conversations: rows });
  });

  app.get('/api/conversations/:id/messages', requireFirebaseAuth, (req, res) => {
    const convId = Number(req.params.id);
    const targetId = getTargetAdminInstanceId(req);
    const botDb = getBotDb(targetId);
    const conv = botDb.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
    if (!conv || Number(conv.hidden) === 1) {
      return res.status(404).json({ ok: false, error: 'Conversación no encontrada o restringida.' });
    }
    const msgs = botDb
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND hidden = 0 ORDER BY id ASC')
      .all(convId);
    res.json({ ok: true, instance_id: targetId, messages: msgs, conversation: conv });
  });

  function mergeInstanceWithLiveState(row, live = {}, includeCatalog = false) {
    const merged = {
      ...row,
      slot_number: Number(row.slot_number || 0),
      tier: row.tier || (Number(row.slot_number) === 0 ? 'official' : 'standard'),
      paid_status: row.paid_status || 'unpaid',
      paid_at: row.paid_at || null,
      subscription_expires_at: row.subscription_expires_at || null,
      locked_for_public: Boolean(row.locked_for_public),
      active: Boolean(row.active),
      state: live.state || live.status || 'close',
      connectedPhone: live.connectedPhone || live.owner || null,
      hasQr: Boolean(live.hasQr || live.qrBase64 || live.base64),
      qrBase64: live.qrBase64 || live.base64 || null,
      qrUpdatedAt: live.qrUpdatedAt || null,
      hasSavedSession: Boolean(live.hasSavedSession),
      lastError: live.lastError || null
    };
    try {
      merged.quick_options = JSON.parse(row.quick_options_json || '[]');
    } catch {
      merged.quick_options = [];
    }
    try {
      merged.faq_items = JSON.parse(row.faq_json || '[]');
    } catch {
      merged.faq_items = [];
    }
    try {
      merged.schedule = JSON.parse(row.schedule_json || '[]');
    } catch {
      merged.schedule = [];
    }
    merged.raw_rules = row.raw_rules || '';
    if (includeCatalog && row.instance_id) {
      try {
        const botDb = getBotDb(row.instance_id);
        merged.catalog_items = botDb
          .prepare('SELECT id, slug, type, name, price, currency, billing_cycle, description, active, sent_to_bot FROM catalog_items ORDER BY id ASC')
          .all();
        merged.catalog = merged.catalog_items;
        merged.promotions = botDb
          .prepare('SELECT id, title, description, discount_text, price, currency, active, sent_to_bot FROM promotions ORDER BY id DESC')
          .all();
      } catch {
        merged.catalog_items = [];
        merged.catalog = [];
        merged.promotions = [];
      }
    }
    return merged;
  }

  function redactPublicInstanceRow(merged) {
    return {
      instance_id: merged.instance_id,
      slot_number: merged.slot_number,
      tier: merged.tier,
      display_name: merged.slot_number === 0 ? merged.display_name : `ServiBot #${String(merged.slot_number).padStart(2, '0')}`,
      business_name: merged.slot_number === 0 ? merged.business_name : (merged.locked_for_public ? 'Instancia Activa (Privada)' : merged.business_name),
      is_occupied: Boolean(String(merged.client_name || '').trim() || String(merged.client_contact || '').trim()),
      paid_status: merged.paid_status,
      locked_for_public: merged.locked_for_public,
      subscription_expires_at: merged.subscription_expires_at,
      state: merged.state,
      active: merged.active
    };
  }

  function parseWizardCatalogInput(rawInput) {
    if (Array.isArray(rawInput)) {
      return rawInput
        .filter((it) => it && String(it.name || '').trim())
        .map((it) => ({
          name: String(it.name).trim(),
          price: Math.max(0, Number(it.price || 0)),
          description: String(it.description || it.name).trim(),
          billing_cycle: String(it.billing_cycle || 'pago único').trim(),
          type: it.type === 'service' ? 'service' : 'product'
        }));
    }
    const text = String(rawInput || '').trim();
    if (!text) return [];
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('|').map((p) => p.trim());
        const name = parts[0] || '';
        const parsedPrice = Number(String(parts[1] || '0').replace(/[^0-9.]/g, '')) || 0;
        const description = parts[2] || `Producto/Servicio ${name}`;
        return {
          name,
          price: parsedPrice,
          description,
          billing_cycle: 'estándar',
          type: 'product'
        };
      })
      .filter((it) => Boolean(it.name));
  }

  function syncWizardCatalogToBotDb(instanceId, rawInput, replaceExisting = false) {
    const parsed = parseWizardCatalogInput(rawInput);
    if (!parsed.length && !replaceExisting) return;
    const botDb = getBotDb(instanceId);
    if (replaceExisting) {
      botDb.prepare('DELETE FROM catalog_items').run();
    }
    const insertStmt = botDb.prepare(
      `INSERT OR REPLACE INTO catalog_items (
        slug, type, name, tagline, description, price, currency, billing_cycle, setup_fee, features_json, image_url, badge, active, sent_to_bot
      ) VALUES (?, ?, ?, '', ?, ?, 'MXN', ?, 0, '[]', '/assets/service-bots.svg', '', 1, 1)`
    );
    for (const item of parsed) {
      const itemSlug = slugify(item.name);
      insertStmt.run(itemSlug, item.type, item.name, item.description, item.price, item.billing_cycle);
    }
  }

  // --- GESTIÓN MULTI-INSTANCIA AISLADA (BOT 0 + 50 SLOTS BAILEYS + ROTACIÓN CON PROSPECTOS) ---
  app.get('/api/instances', async (req, res) => {
    try {
      const adminCtx = await resolveOptionalAdminContext(req);
      const rows = db.prepare('SELECT * FROM bot_instances ORDER BY slot_number ASC').all();
      const liveMap = await fetchLiveEvolutionInstancesMap();

      const merged = rows.map((row) => {
        const m = mergeInstanceWithLiveState(row, liveMap.get(row.instance_id) || {});
        if (adminCtx?.is_superadmin) return m;
        if (adminCtx && adminCtx.assigned_instance_id === row.instance_id) return m;
        if (row.instance_id === 'servibot-00') return m;
        return redactPublicInstanceRow(m);
      });
      res.json({
        ok: true,
        instances: merged,
        totalSlots: INSTANCE_IDS.length,
        clientSlots: TOTAL_CLIENT_SLOTS
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/instances/provision', async (req, res) => {
    try {
      const body = req.body || {};
      const explicitId = normalizeInstanceIdKey(body.instance_id || '');
      if (explicitId && explicitId !== 'servibot-00') {
        const existingRow = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(explicitId);
        if (existingRow && (Number(existingRow.locked_for_public) === 1 || existingRow.paid_status === 'paid')) {
          return res.status(423).json({
            ok: false,
            locked: true,
            instance_id: explicitId,
            subscription_expires_at: existingRow.subscription_expires_at || null,
            error:
              'Tu instancia contratada ya cuenta con Admin Estándar activo (30 días naturales) y está bloqueada en la interfaz pública.'
          });
        }
      }

      const businessName = String(body.business_name || '').trim() || 'Mi Negocio';
      const clientName = String(body.client_name || '').trim();
      const clientContact = String(body.client_contact || '').trim();
      const adminEmail = String(body.admin_email || '').trim().toLowerCase();
      const displayName =
        String(body.display_name || '').trim() || (businessName ? `Asistente ${businessName}` : 'ServiBot');
      const tone = String(body.tone || '').trim() || 'Profesional, cálido y orientado a resultados';
      const aiSoul = String(body.ai_soul || '').trim() || 'Asistente comercial y de atención al cliente.';
      const systemPrompt = String(body.system_prompt || '').trim();
      const welcomeMessage =
        String(body.welcome_message || '').trim() ||
        (businessName
          ? `¡Hola! Soy ${displayName}, asesor inteligente de ${businessName}. ¿En qué te ayudo hoy?`
          : '¡Hola! Soy tu ServiBot. ¿En qué te ayudo hoy?');

      const alloc = await allocateClientSlotForProspect({
        clientContact,
        preferredInstanceId: body.instance_id || ''
      });

      if (alloc.mode === 'locked') {
        return res.status(423).json({
          ok: false,
          locked: true,
          instance_id: alloc.instanceId,
          subscription_expires_at: alloc.row?.subscription_expires_at || null,
          error:
            'Tu instancia contratada ya cuenta con Admin Estándar activo (30 días naturales) y está bloqueada en la interfaz pública.'
        });
      }

      if (alloc.mode === 'exhausted' || !alloc.instanceId) {
        return res.status(409).json({
          ok: false,
          error:
            'Las 50 instancias estándar están actualmente activas y contratadas. Solicita un Bot VIP dedicado o ampliación con un asesor.'
        });
      }

      const instanceId = alloc.instanceId;
      getBotDb(instanceId);

      // Si es cliente prospecto previo que regresa tras rotación, restaurar su catálogo/promos antes de aplicar cambios
      let restoredFromProspect = false;
      if ((alloc.mode === 'fresh' || alloc.mode === 'rotated') && clientContact && body.restore_if_found !== false) {
        const contactKey = normalizeContactValue(clientContact);
        const prospectRows = prospectsDb
          .prepare('SELECT * FROM prospects ORDER BY updated_at DESC LIMIT 200')
          .all();
        const foundProspect =
          prospectRows.find((p) => p.contact_key === contactKey || contactsMatch(p.client_contact, clientContact)) || null;
        if (foundProspect) {
          restoreProspectIntoBot(instanceId, foundProspect);
          restoredFromProspect = true;
        }
      }

      if (body.catalog_items !== undefined || body.initial_products !== undefined) {
        const rawCatalog = body.catalog_items !== undefined ? body.catalog_items : body.initial_products;
        syncWizardCatalogToBotDb(instanceId, rawCatalog, Boolean(body.replace_catalog));
      }

      const quickOptionsJson = Array.isArray(body.quick_options) ? JSON.stringify(body.quick_options) : null;
      const faqJson = Array.isArray(body.faq_items || body.faqs) ? JSON.stringify(body.faq_items || body.faqs) : null;
      const scheduleJson = Array.isArray(body.schedule || body.schedule_config) ? JSON.stringify(body.schedule || body.schedule_config) : null;
      const rawRules = body.raw_rules !== undefined ? String(body.raw_rules).trim() : (body.raw_system_prompt !== undefined ? String(body.raw_system_prompt).trim() : null);

      db.prepare(
        `
        UPDATE bot_instances SET
          tier = 'standard',
          display_name = ?,
          business_name = ?,
          client_name = ?,
          client_contact = ?,
          admin_email = CASE WHEN ? != '' THEN ? ELSE admin_email END,
          tone = ?,
          ai_soul = ?,
          system_prompt = ?,
          welcome_message = ?,
          quick_options_json = CASE WHEN ? IS NOT NULL THEN ? ELSE quick_options_json END,
          faq_json = CASE WHEN ? IS NOT NULL THEN ? ELSE faq_json END,
          schedule_json = CASE WHEN ? IS NOT NULL THEN ? ELSE schedule_json END,
          raw_rules = CASE WHEN ? IS NOT NULL THEN ? ELSE raw_rules END,
          db_file = ?,
          active = 1,
          updated_at = datetime('now', 'localtime')
        WHERE instance_id = ?
      `
      ).run(
        displayName,
        businessName,
        clientName,
        clientContact,
        adminEmail,
        adminEmail,
        tone,
        aiSoul,
        systemPrompt,
        welcomeMessage,
        quickOptionsJson,
        quickOptionsJson,
        faqJson,
        faqJson,
        scheduleJson,
        scheduleJson,
        rawRules,
        rawRules,
        getBotDbPath(instanceId),
        instanceId
      );

      const updated = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      const liveMap = await fetchLiveEvolutionInstancesMap();
      const liveObj = liveMap.get(instanceId) || {};

      const mergedInstance = mergeInstanceWithLiveState(updated, liveObj, true);
      res.json({
        ok: true,
        allocation_mode: alloc.mode,
        archived_previous: alloc.mode === 'rotated',
        restored_from_prospect: restoredFromProspect,
        catalog: mergedInstance.catalog_items || [],
        instance: mergedInstance
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/instances/recover', async (req, res) => {
    try {
      const contactRaw = String(
        req.body?.query || req.body?.contact || req.body?.client_contact || req.body?.recovery_code || ''
      ).trim();
      const requestedId = normalizeInstanceIdKey(req.body?.instance_id || contactRaw);

      if (!contactRaw && !requestedId) {
        return res.status(400).json({
          ok: false,
          error: 'Ingresa tu teléfono, correo o número de instancia (ej. servibot-04) para retomar tu bot.'
        });
      }

      const activeSlots = db
        .prepare('SELECT * FROM bot_instances WHERE slot_number BETWEEN 1 AND ? ORDER BY slot_number ASC')
        .all(TOTAL_CLIENT_SLOTS);

      let activeMatch = null;
      if (requestedId && requestedId !== 'servibot-00') {
        activeMatch = activeSlots.find((r) => r.instance_id === requestedId) || null;
      }
      if (!activeMatch && contactRaw) {
        activeMatch =
          activeSlots.find((r) => r.client_contact && contactsMatch(r.client_contact, contactRaw)) || null;
      }

      if (activeMatch) {
        if (Number(activeMatch.locked_for_public) === 1 || activeMatch.paid_status === 'paid') {
          return res.status(423).json({
            ok: false,
            locked: true,
            instance_id: activeMatch.instance_id,
            business_name: activeMatch.business_name,
            subscription_expires_at: activeMatch.subscription_expires_at || null,
            error:
              'Tu instancia ya fue activada con pago mensual (30 días naturales) y está bloqueada en la interfaz pública. Inicia sesión en tu Admin Estándar.'
          });
        }
        const liveMap = await fetchLiveEvolutionInstancesMap();
        const mergedActive = mergeInstanceWithLiveState(activeMatch, liveMap.get(activeMatch.instance_id) || {}, true);
        return res.json({
          ok: true,
          recovered_from: 'active_slot',
          recovered_from_prospects: false,
          catalog: mergedActive.catalog_items || [],
          instance: mergedActive
        });
      }

      if (contactRaw) {
        const contactKey = normalizeContactValue(contactRaw);
        const queryUpper = contactRaw.toUpperCase();
        const prospects = prospectsDb.prepare('SELECT * FROM prospects ORDER BY updated_at DESC LIMIT 300').all();
        const foundProspect =
          prospects.find(
            (p) =>
              p.contact_key === contactKey ||
              contactsMatch(p.client_contact, contactRaw) ||
              String(p.recovery_code || '').toUpperCase() === queryUpper ||
              String(p.prospect_id || '').toUpperCase() === queryUpper
          ) || null;

        if (foundProspect) {
          const alloc = await allocateClientSlotForProspect({ clientContact: foundProspect.client_contact });
          if (alloc.mode === 'exhausted' || !alloc.instanceId) {
            return res.status(409).json({
              ok: false,
              error: 'No hay espacios libres en este momento para restaurar tu prospecto.'
            });
          }
          if (alloc.mode === 'locked') {
            return res.status(423).json({
              ok: false,
              locked: true,
              instance_id: alloc.instanceId,
              error: 'Esta instancia ya cuenta con suscripción paga y está bloqueada para uso público.'
            });
          }

          restoreProspectIntoBot(alloc.instanceId, foundProspect);
          db.prepare(
            `
            UPDATE bot_instances SET
              tier = 'standard',
              display_name = ?,
              business_name = ?,
              client_name = ?,
              client_contact = ?,
              tone = ?,
              ai_soul = ?,
              system_prompt = ?,
              welcome_message = ?,
              quick_options_json = ?,
              faq_json = ?,
              schedule_json = ?,
              raw_rules = ?,
              db_file = ?,
              active = 1,
              updated_at = datetime('now', 'localtime')
            WHERE instance_id = ?
          `
          ).run(
            foundProspect.display_name || `Asistente ${foundProspect.business_name}`,
            foundProspect.business_name || '',
            foundProspect.client_name || '',
            foundProspect.client_contact || contactRaw,
            foundProspect.tone || 'Profesional, cálido y orientado a resultados',
            foundProspect.ai_soul || '',
            foundProspect.system_prompt || '',
            foundProspect.welcome_message || '',
            foundProspect.quick_options_json || '[]',
            foundProspect.faq_json || '[]',
            foundProspect.schedule_json || '[]',
            foundProspect.raw_rules || '',
            getBotDbPath(alloc.instanceId),
            alloc.instanceId
          );

          const restoredRow = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(alloc.instanceId);
          const mergedRestored = mergeInstanceWithLiveState(restoredRow, {}, true);
          return res.json({
            ok: true,
            recovered_from: 'prospects_archive',
            recovered_from_prospects: true,
            catalog: mergedRestored.catalog_items || [],
            instance: mergedRestored
          });
        }
      }

      return res.status(404).json({
        ok: false,
        error: 'No encontramos un borrador previo con ese número de WhatsApp, correo o instancia.'
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/instances/:instanceId', async (req, res) => {
    try {
      const instanceId = normalizeInstanceIdKey(req.params.instanceId) || resolveInstanceId(req.params.instanceId);
      const row = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      if (!row) {
        return res.status(404).json({ ok: false, error: `Instancia ${instanceId} no encontrada.` });
      }

      const adminCtx = await resolveOptionalAdminContext(req);
      const isAuthorizedOwner =
        adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === instanceId);

      if (
        instanceId !== 'servibot-00' &&
        (Number(row.locked_for_public) === 1 || row.paid_status === 'paid') &&
        !isAuthorizedOwner
      ) {
        return res.status(423).json({
          ok: false,
          locked: true,
          instance_id: instanceId,
          instance: {
            instance_id: row.instance_id,
            slot_number: row.slot_number,
            tier: row.tier,
            display_name: row.display_name,
            business_name: row.business_name,
            paid_status: row.paid_status,
            subscription_expires_at: row.subscription_expires_at,
            locked_for_public: true
          },
          error:
            'Esta instancia ya completó su pago mensual (Admin Estándar activo por 30 días naturales) y quedó bloqueada en la interfaz pública.'
        });
      }

      let liveObj = {};
      try {
        const evResp = await fetch(
          `http://127.0.0.1:${EVOLUTION_PORT}/instance/connectionState/${encodeURIComponent(instanceId)}`
        );
        const evData = await evResp.json();
        liveObj = evData?.instance || {};
      } catch {
        liveObj = { state: 'offline' };
      }
      res.json({ ok: true, instance: mergeInstanceWithLiveState(row, liveObj, true) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.put('/api/instances/:instanceId', async (req, res) => {
    try {
      const instanceId = normalizeInstanceIdKey(req.params.instanceId) || resolveInstanceId(req.params.instanceId);
      const existing = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      if (!existing) {
        return res.status(404).json({ ok: false, error: `Instancia ${instanceId} no encontrada.` });
      }

      const adminCtx = await resolveOptionalAdminContext(req);
      const isAuthorizedOwner =
        adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === instanceId);

      if (instanceId === 'servibot-00' && !adminCtx?.is_superadmin) {
        return res.status(403).json({
          ok: false,
          error: 'Solo la cuenta principal Admin 0 puede modificar la configuración del Bot 0 (Proyecto Cero).'
        });
      }

      if (
        instanceId !== 'servibot-00' &&
        (Number(existing.locked_for_public) === 1 || existing.paid_status === 'paid') &&
        !isAuthorizedOwner
      ) {
        return res.status(423).json({
          ok: false,
          locked: true,
          error: 'Instancia bloqueada en interfaz pública tras activación de suscripción de 30 días.'
        });
      }

      if (adminCtx && !adminCtx.is_superadmin && adminCtx.subscription_expired) {
        return res.status(402).json({
          ok: false,
          expired: true,
          error: 'Tu Admin Estándar de 30 días naturales expiró.'
        });
      }

      const body = req.body || {};
      const displayName = body.display_name !== undefined ? String(body.display_name).trim() : existing.display_name;
      const businessName = body.business_name !== undefined ? String(body.business_name).trim() : existing.business_name;
      const clientName = body.client_name !== undefined ? String(body.client_name).trim() : existing.client_name;
      const clientContact = body.client_contact !== undefined ? String(body.client_contact).trim() : existing.client_contact;
      const tone = body.tone !== undefined ? String(body.tone).trim() : existing.tone;
      const aiSoul = body.ai_soul !== undefined ? String(body.ai_soul).trim() : existing.ai_soul;
      const systemPrompt = body.system_prompt !== undefined ? String(body.system_prompt).trim() : existing.system_prompt;
      const welcomeMessage =
        body.welcome_message !== undefined ? String(body.welcome_message).trim() : existing.welcome_message;
      const active = body.active !== undefined ? (body.active ? 1 : 0) : existing.active;

      if (!displayName) {
        return res.status(400).json({ ok: false, error: 'El nombre del agente ServiBot es obligatorio.' });
      }

      if (body.catalog_items !== undefined || body.initial_products !== undefined) {
        const rawCatalog = body.catalog_items !== undefined ? body.catalog_items : body.initial_products;
        syncWizardCatalogToBotDb(instanceId, rawCatalog, Boolean(body.replace_catalog));
      }

      const quickOptionsJson = Array.isArray(body.quick_options) ? JSON.stringify(body.quick_options) : null;
      const faqJson = Array.isArray(body.faq_items || body.faqs) ? JSON.stringify(body.faq_items || body.faqs) : null;
      const scheduleJson = Array.isArray(body.schedule || body.schedule_config) ? JSON.stringify(body.schedule || body.schedule_config) : null;
      const rawRules = body.raw_rules !== undefined ? String(body.raw_rules).trim() : (body.raw_system_prompt !== undefined ? String(body.raw_system_prompt).trim() : null);

      db.prepare(
        `
        UPDATE bot_instances SET
          display_name = ?,
          business_name = ?,
          client_name = ?,
          client_contact = ?,
          tone = ?,
          ai_soul = ?,
          system_prompt = ?,
          welcome_message = ?,
          quick_options_json = CASE WHEN ? IS NOT NULL THEN ? ELSE quick_options_json END,
          faq_json = CASE WHEN ? IS NOT NULL THEN ? ELSE faq_json END,
          schedule_json = CASE WHEN ? IS NOT NULL THEN ? ELSE schedule_json END,
          raw_rules = CASE WHEN ? IS NOT NULL THEN ? ELSE raw_rules END,
          active = ?,
          updated_at = datetime('now', 'localtime')
        WHERE instance_id = ?
      `
      ).run(
        displayName,
        businessName,
        clientName,
        clientContact,
        tone,
        aiSoul,
        systemPrompt,
        welcomeMessage,
        quickOptionsJson,
        quickOptionsJson,
        faqJson,
        faqJson,
        scheduleJson,
        scheduleJson,
        rawRules,
        rawRules,
        active,
        instanceId
      );

      const updated = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      let liveObj = {};
      try {
        const evResp = await fetch(
          `http://127.0.0.1:${EVOLUTION_PORT}/instance/connectionState/${encodeURIComponent(instanceId)}`
        );
        const evData = await evResp.json();
        liveObj = evData?.instance || {};
      } catch {
        // ignore if port 10001 unavailable
      }
      res.json({ ok: true, instance: mergeInstanceWithLiveState(updated, liveObj, true) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Permite consultar catálogo aislado del propio bot (1..50) mientras NO esté bloqueado por pago
  app.get('/api/instances/:instanceId/catalog', async (req, res) => {
    try {
      const instanceId = normalizeInstanceIdKey(req.params.instanceId);
      if (!instanceId) {
        return res.status(400).json({ ok: false, error: 'Instancia inválida.' });
      }
      const row = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      if (!row) {
        return res.status(404).json({ ok: false, error: 'Instancia no encontrada.' });
      }
      const adminCtx = await resolveOptionalAdminContext(req);
      const isAuthorizedOwner =
        adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === instanceId);
      if (
        instanceId !== 'servibot-00' &&
        (Number(row.locked_for_public) === 1 || row.paid_status === 'paid') &&
        !isAuthorizedOwner
      ) {
        return res.status(423).json({ ok: false, locked: true, error: 'Instancia bloqueada en interfaz pública.' });
      }
      const botDb = getBotDb(instanceId);
      const items = botDb
        .prepare('SELECT id, slug, type, name, price, currency, billing_cycle, description, active, sent_to_bot FROM catalog_items ORDER BY id ASC')
        .all();
      return res.json({ ok: true, instance_id: instanceId, items, catalog: items });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Permite administrar ítems del propio bot (1..50) mientras NO esté bloqueado por pago
  app.post('/api/instances/:instanceId/catalog', async (req, res) => {
    try {
      const instanceId = normalizeInstanceIdKey(req.params.instanceId);
      if (!instanceId || instanceId === 'servibot-00') {
        return res.status(403).json({ ok: false, error: 'Usa el panel Admin 0 autenticado para editar Bot 0.' });
      }
      const row = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      if (!row) {
        return res.status(404).json({ ok: false, error: 'Instancia no encontrada.' });
      }
      const adminCtx = await resolveOptionalAdminContext(req);
      const isAuthorizedOwner =
        adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === instanceId);
      if ((Number(row.locked_for_public) === 1 || row.paid_status === 'paid') && !isAuthorizedOwner) {
        return res.status(423).json({ ok: false, locked: true, error: 'Instancia bloqueada en interfaz pública.' });
      }

      const name = String(req.body?.name || '').trim();
      const description = String(req.body?.description || name).trim();
      if (!name) {
        return res.status(400).json({ ok: false, error: 'El nombre del producto/servicio es obligatorio.' });
      }
      const botDb = getBotDb(instanceId);
      let slug = slugify(name);
      if (botDb.prepare('SELECT id FROM catalog_items WHERE slug = ?').get(slug)) {
        slug = `${slug}-${Date.now().toString().slice(-4)}`;
      }
      const info = botDb
        .prepare(
          `INSERT INTO catalog_items (
            slug, type, name, tagline, description, price, currency, billing_cycle, setup_fee, features_json, image_url, badge, active, sent_to_bot
          ) VALUES (?, ?, ?, '', ?, ?, 'MXN', ?, 0, '[]', '/assets/service-bots.svg', '', 1, 1)`
        )
        .run(
          slug,
          req.body?.type === 'service' ? 'service' : 'product',
          name,
          description,
          Math.max(0, Number(req.body?.price || 0)),
          String(req.body?.billing_cycle || 'estándar').trim()
        );
      const created = botDb.prepare('SELECT * FROM catalog_items WHERE id = ?').get(info.lastInsertRowid);
      return res.status(201).json({ ok: true, instance_id: instanceId, item: created });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/instances/:instanceId/connect', async (req, res) => {
    try {
      const instanceId = normalizeInstanceIdKey(req.params.instanceId) || resolveInstanceId(req.params.instanceId);
      const row = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      const adminCtx = await resolveOptionalAdminContext(req);
      const isAuthorizedOwner =
        adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === instanceId);
      if (instanceId === 'servibot-00' && !adminCtx?.is_superadmin) {
        return res.status(403).json({ ok: false, error: 'Solo Admin 0 puede enlazar el WhatsApp del Bot 0.' });
      }
      if (row && (Number(row.locked_for_public) === 1 || row.paid_status === 'paid') && !isAuthorizedOwner) {
        return res.status(423).json({ ok: false, locked: true, error: 'Instancia bloqueada en interfaz pública.' });
      }
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connect/${encodeURIComponent(instanceId)}`);
      const data = await r.json();
      res.json({ ok: true, ...data, instance: instanceId });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/instances/:instanceId/logout', async (req, res) => {
    try {
      const instanceId = normalizeInstanceIdKey(req.params.instanceId) || resolveInstanceId(req.params.instanceId);
      const row = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(instanceId);
      const adminCtx = await resolveOptionalAdminContext(req);
      const isAuthorizedOwner =
        adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === instanceId);
      if (instanceId === 'servibot-00' && !adminCtx?.is_superadmin) {
        return res.status(403).json({ ok: false, error: 'Solo Admin 0 puede desconectar el Bot 0.' });
      }
      if (row && (Number(row.locked_for_public) === 1 || row.paid_status === 'paid') && !isAuthorizedOwner) {
        return res.status(423).json({ ok: false, locked: true, error: 'Instancia bloqueada en interfaz pública.' });
      }
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/logout/${encodeURIComponent(instanceId)}`, {
        method: 'POST'
      });
      const data = await r.json();
      res.json({ ok: true, ...data, instance: instanceId });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- INTÉRPRETE DE INSTRUCCIONES DE ENTRENAMIENTO ---
  function interpretTrainingInstruction(instruction, currentInstance, catalogItems = []) {
    const text = String(instruction || '').trim();
    const lower = text.toLowerCase();

    // 1. Agregar al catálogo / servicio / producto
    // Ej: "Agrega al catálogo el servicio Consulta General a 400 pesos"
    // Ej: "Ofrecemos corte de cabello por 150 pesos"
    // Ej: "Agrega producto Shampoo anticaída con precio 250"
    const catalogAddRegex = /(?:agrega(?:r)?|aÃ±ade|aÃ±adir|nuevo|nueva|ofrecemos|tenemos|vende(?:mos)?)\s+(?:al\s+cat[aá]logo\s+)?(?:el\s+servicio\s+|el\s+producto\s+|servicio\s+|producto\s+)?([^$0-9]+?)\s+(?:a\s+|en\s+|por\s+|con\s+precio\s+(?:de\s+)?|\$)\s*\$?([0-9]+(?:[\.,][0-9]{2})?)\s*(?:pesos|mxn|\$)?(?:\s+(mensual|anual|semanal|quincenal|por hora|único))?/i;
    const matchAdd = text.match(catalogAddRegex);
    if (matchAdd) {
      const rawName = matchAdd[1].replace(/^(al\s+cat[aá]logo|el\s+servicio|el\s+producto|servicio|producto)\s+/i, '').trim();
      const cleanName = rawName.replace(/^[:\-–\s]+|[:\-–\s]+$/g, '').trim();
      const rawPrice = matchAdd[2].replace(',', '.');
      const price = parseFloat(rawPrice) || 0;
      const cycle = matchAdd[3] ? matchAdd[3].toLowerCase() : 'único';
      if (cleanName.length >= 2) {
        return {
          actionType: 'catalog_add',
          payload: {
            name: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
            price,
            description: `Servicio/producto ${cleanName} ofrecido por ${currentInstance.business_name || 'el negocio'}.`,
            billing_cycle: cycle,
            type: cycle === 'mensual' || cycle === 'anual' ? 'plan' : 'service',
            instruction: text
          }
        };
      }
    }

    // 2. Eliminar del catálogo
    const catalogDelRegex = /(?:elimina(?:r)?|borra(?:r)?|quitar?|ya\s+no\s+(?:ofrecemos|vendemos))\s+(?:del\s+cat[aá]logo\s+)?(?:el\s+servicio\s+|el\s+producto\s+|servicio\s+|producto\s+)?([^.\n]+)/i;
    const matchDel = text.match(catalogDelRegex);
    if (matchDel) {
      const targetName = matchDel[1].trim();
      if (targetName.length >= 2) {
        return {
          actionType: 'catalog_delete',
          payload: {
            name: targetName,
            instruction: text
          }
        };
      }
    }

    // 3. Actualizar horarios
    if (lower.includes('horario') || lower.includes('abrimos') || lower.includes('atendemos') || lower.includes('cerramos')) {
      return {
        actionType: 'schedule_update',
        payload: {
          summary: text,
          instruction: text
        }
      };
    }

    // 4. Preguntas Frecuentes (FAQ)
    const faqRegex = /(?:agrega(?:r)?\s+(?:a\s+)?(?:las\s+)?(?:preguntas\s+frecuentes|faq(?:s)?)|faq)\s*[:\-–]?\s*(?:pregunta\s*[:\-–]?\s*)?([^?¿\n]+[?¿]?)\s*(?:respuesta\s*[:\-–]?\s*|\/|\n)\s*([^.\n]+)/i;
    const matchFaq = text.match(faqRegex);
    if (matchFaq) {
      return {
        actionType: 'faq_add',
        payload: {
          question: matchFaq[1].trim(),
          answer: matchFaq[2].trim(),
          instruction: text
        }
      };
    }

    // 5. Identidad (nombre, tono, bienvenida)
    if (lower.startsWith('tu nombre es') || lower.startsWith('llámate') || lower.startsWith('llamare') || lower.includes('cambia tu nombre a')) {
      const matchName = text.match(/(?:tu\s+nombre\s+es|ll[aá]mate|cambia\s+tu\s+nombre\s+a)\s+([a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s]+)/i);
      if (matchName) {
        return {
          actionType: 'identity_update',
          payload: {
            display_name: matchName[1].trim(),
            instruction: text
          }
        };
      }
    }

    if (lower.includes('tu tono es') || lower.includes('habla de forma') || lower.includes('cambia tu tono a')) {
      const matchTone = text.match(/(?:tu\s+tono\s+es|habla\s+de\s+forma|cambia\s+tu\s+tono\s+a)\s+([^.\n]+)/i);
      if (matchTone) {
        return {
          actionType: 'identity_update',
          payload: {
            tone: matchTone[1].trim(),
            instruction: text
          }
        };
      }
    }

    // 6. Por defecto: Regla de negocio
    return {
      actionType: 'rule_add',
      payload: {
        rule: text.replace(/^(agrega|aprende|recuerda|ten\s+en\s+cuenta\s+que|la\s+regla\s+es)\s*[:\-–]?\s*/i, '').trim(),
        instruction: text
      }
    };
  }

  // --- AGENTE DE VENTAS IA AISLADO POR INSTANCIA ---
  app.post('/api/chat', async (req, res) => {
    const isLoadTest = Boolean(
      req.headers['x-load-test'] ||
      req.body?.is_load_test ||
      req.body?.skip_order
    );

    // R2.3: Rate limit por IP para prevenir abuso/DoS (omite si es prueba autorizada con header)
    const clientIp = String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    if (!isLoadTest && !checkChatRateLimit(clientIp)) {
      return res.status(429).json({
        ok: false,
        error: 'Has enviado demasiados mensajes en poco tiempo. Por favor espera un momento e inténtalo de nuevo.'
      });
    }

    const {
      sender_name = 'Visitante Web',
      message = '',
      instance_id = 'servibot-00',
      is_training_mode = false
    } = req.body || {};

    const trimmedMessage = String(message || '').trim();
    if (!trimmedMessage) {
      return res.status(400).json({ ok: false, error: 'El mensaje no puede estar vacío.' });
    }
    if (trimmedMessage.length > 2000) {
      return res.status(400).json({ ok: false, error: 'El mensaje excede el límite permitido (2000 caracteres).' });
    }

    // R2.1: Forzar estrictamente canal 'web' (evita suplantación de WhatsApp u otros canales)
    const channel = 'web';

    // R2.2: Aislar estrictamente sender_id en prefijo web- (evita colisión o suplantación de teléfonos de WhatsApp)
    let cleanSenderId = String(req.body?.sender_id || '').trim();
    if (!cleanSenderId || !cleanSenderId.startsWith('web-')) {
      const sanitized = cleanSenderId.replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 32);
      cleanSenderId = sanitized ? `web-${sanitized}` : `web-${crypto.randomBytes(4).toString('hex')}`;
    }

    const canonicalInstance = normalizeInstanceIdKey(instance_id) || 'servibot-00';
    if (canonicalInstance !== 'servibot-00') {
      const row = db
        .prepare('SELECT instance_id, locked_for_public, paid_status, subscription_expires_at FROM bot_instances WHERE instance_id = ?')
        .get(canonicalInstance);
      if (row && (Number(row.locked_for_public) === 1 || row.paid_status === 'paid')) {
        const adminCtx = await resolveOptionalAdminContext(req);
        const isAuthorizedOwner =
          adminCtx && (adminCtx.is_superadmin || adminCtx.assigned_instance_id === canonicalInstance);
        if (!isAuthorizedOwner) {
          return res.status(423).json({
            ok: false,
            locked: true,
            instance_id: canonicalInstance,
            subscription_expires_at: row.subscription_expires_at || null,
            error:
              'Esta instancia ya completó su suscripción mensual (30 días naturales) y está bloqueada e inaccesible para uso en la interfaz pública.'
          });
        }
      }
    }

    // --- PIPELINE MODO ENTRENAMIENTO (ESCRITURA DIRECTA EN SQLite DE LA INSTANCIA) ---
    if (canonicalInstance !== 'servibot-00' && Boolean(is_training_mode)) {
      try {
        const botDb = getBotDb(canonicalInstance);
        const currentInst = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(canonicalInstance);
        const catalogItems = botDb.prepare('SELECT * FROM catalog_items WHERE active = 1 AND sent_to_bot = 1').all();

        const interpreted = interpretTrainingInstruction(trimmedMessage, currentInst, catalogItems);
        const applied = applyTrainingAction(canonicalInstance, interpreted.actionType, interpreted.payload);

        // Registrar en conversación simulada
        const convStmt = botDb.prepare(`
          INSERT INTO conversations (channel, sender_id, sender_name, last_message, is_priority, hidden, updated_at)
          VALUES (?, ?, ?, ?, 0, 0, datetime('now', 'localtime'))
          ON CONFLICT(channel, sender_id) DO UPDATE SET
            sender_name = excluded.sender_name,
            last_message = excluded.last_message,
            updated_at = datetime('now', 'localtime')
        `);
        convStmt.run(channel, cleanSenderId, String(sender_name || 'Dueño (Entrenamiento)').slice(0, 60), trimmedMessage);
        const convRow = botDb.prepare('SELECT id FROM conversations WHERE channel = ? AND sender_id = ?').get(channel, cleanSenderId);

        const replyText = `🧠 ¡Instrucción aprendida con éxito!\n\n${applied.summary}\n\nHe guardado este cambio permanentemente en mi base de datos para recordar siempre cómo atender a tus clientes.`;

        if (convRow?.id) {
          const msgStmt = botDb.prepare('INSERT INTO messages (conversation_id, role, content, metadata_json) VALUES (?, ?, ?, ?)');
          msgStmt.run(convRow.id, 'user', trimmedMessage, JSON.stringify({ is_training: true }));
          msgStmt.run(convRow.id, 'assistant', replyText, JSON.stringify({ is_training: true, category: applied.category }));
        }

        return res.json({
          ok: true,
          instance_id: canonicalInstance,
          reply: replyText,
          training_applied: true,
          action: applied,
          instance: applied.instance,
          catalog: applied.catalog
        });
      } catch (trainErr) {
        return res.status(400).json({
          ok: false,
          error: `Error al procesar instrucción de entrenamiento: ${trainErr.message}`
        });
      }
    }

    // Si el modo entrenamiento está DESACTIVADO, bloqueo estricto de escritura en BD.
    // Se ejecuta runPythonSalesAgent de solo lectura para el cliente simulado o visitante de Bot 0.
    const clientState = (req.body?.client_state && typeof req.body.client_state === 'object') ? req.body.client_state : {};
    const result = await runPythonSalesAgent({
      channel,
      sender_id: cleanSenderId,
      sender_name: String(sender_name || 'Visitante Web').slice(0, 60),
      message: trimmedMessage,
      instance_id: canonicalInstance,
      is_load_test: isLoadTest,
      client_state: clientState
    });

    if (result?.timing) {
      res.setHeader(
        'Server-Timing',
        `queue;dur=${result.timing.queue_ms || 0}, worker;dur=${result.timing.worker_ms || 0}, total;dur=${result.timing.total_ms || 0}`
      );
    }

    res.json(result);
  });

  // --- HISTORIAL DE ENTRENAMIENTO DE LA INSTANCIA ---
  app.get('/api/instances/:instanceId/training', async (req, res) => {
    try {
      const canonicalInstance = normalizeInstanceIdKey(req.params.instanceId);
      const memories = getTrainingMemories(canonicalInstance, req.query.limit || 50);
      res.json({ ok: true, instance_id: canonicalInstance, memories });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- WEBHOOK DE EVOLUTION API (WHATSAPP PUERTO 10001 -> 10000) ---
  app.post('/api/webhooks/evolution', async (req, res) => {
    try {
      const botCfg = getSetting('bot_config', {});
      if (botCfg.auto_reply_whatsapp === false) {
        return res.json({ ok: true, paused: true });
      }

      const body = req.body || {};
      const instanceId =
        normalizeInstanceIdKey(body.instance || body.instanceName) || 'servibot-00';
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

      // Detección e intercepción inteligente de Bot Token de Telegram enviado por WhatsApp
      const tgTokenMatch = text.trim().match(/\b(\d{8,12}:[A-Za-z0-9_-]{35,})\b/);
      if (tgTokenMatch) {
        const detectedToken = tgTokenMatch[1];
        console.log('[INTERCEPTOR] Bot Token de Telegram detectado en WhatsApp:', detectedToken.substring(0, 10) + '...');
        try {
          const syncRes = await syncTelegramWebhook({ bot_token: detectedToken, enabled: true }, req);
          const currentTg = getSetting('telegram_config', {});
          const cleanTgUser = syncRes.bot_info?.username ? String(syncRes.bot_info.username).replace(/^@+/, '') : '';
          const updatedTg = {
            ...currentTg,
            bot_token: detectedToken,
            enabled: true,
            bot_username: cleanTgUser ? `@${cleanTgUser}` : currentTg.bot_username,
            bot_name: syncRes.bot_info?.first_name || currentTg.bot_name,
            webhook_url: syncRes.webhook_url || currentTg.webhook_url,
            webhook_synced: syncRes.ok,
            deep_link: cleanTgUser ? `https://t.me/${cleanTgUser}` : null,
            qr_base64: syncRes.qr_base64 || null,
            sync_error: syncRes.ok ? null : syncRes.error,
            last_sync_at: new Date().toISOString()
          };
          setSetting('telegram_config', updatedTg);

          const replyMsg = syncRes.ok
            ? `🤖 ¡Token de Telegram recibido y configurado con éxito!\n\n` +
              `• Bot: @${cleanTgUser || 'Vinculado'}\n` +
              `• Estado: Webhook Oficial Activo ✅\n` +
              `• Enlace directo: https://t.me/${cleanTgUser}\n\n` +
              `Tu bot ya está listo para responder mensajes en tiempo real con IA en Telegram y su código QR está activo en tu panel.`
            : `⚠️ Recibí el token de Telegram, pero la API reportó: ${syncRes.error}. Por favor verifica el token emitido por @BotFather.`;

          try {
            await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/message/sendText/${encodeURIComponent(instanceId)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ number: remoteJid, text: replyMsg })
            });
          } catch (_) {}

          return res.json({ ok: true, intercepted: true, telegram_sync: syncRes });
        } catch (e) {
          console.error('[INTERCEPTOR] Error al procesar token de Telegram:', e.message);
        }
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
      const targetId = req.adminAccount.is_superadmin
        ? normalizeInstanceIdKey(req.query.instance || req.query.instance_id) || 'servibot-00'
        : req.adminAccount.assigned_instance_id;
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/connect/${encodeURIComponent(targetId)}`);
      const data = await r.json();
      const rootR = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/`);
      const rootData = await rootR.json();
      res.json({ ok: true, ...data, instance: targetId, recentEvents: rootData.recentEvents || [] });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/channels/whatsapp/simulate', requireFirebaseAuth, requireActiveClientSubscription, async (req, res) => {
    try {
      const targetId = req.adminAccount.is_superadmin
        ? normalizeInstanceIdKey(req.body?.instance || req.body?.instance_id) || 'servibot-00'
        : req.adminAccount.assigned_instance_id;
      const payload = {
        ...(req.body || {}),
        instance: targetId
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

  app.post('/api/channels/whatsapp/logout', requireFirebaseAuth, requireActiveClientSubscription, async (req, res) => {
    try {
      const targetId = req.adminAccount.is_superadmin
        ? normalizeInstanceIdKey(req.query.instance || req.body?.instance || req.query.instance_id) || 'servibot-00'
        : req.adminAccount.assigned_instance_id;
      const r = await fetch(`http://127.0.0.1:${EVOLUTION_PORT}/instance/logout/${encodeURIComponent(targetId)}`, {
        method: 'DELETE'
      });
      const data = await r.json();
      res.json(data);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- CANAL MICROSOFT TEAMS ---
  app.post('/api/channels/teams/webhook', async (req, res) => {
    const adminCtx = await resolveOptionalAdminContext(req);
    const requestedId = normalizeInstanceIdKey(req.query?.instance_id || req.body?.instance_id) || 'servibot-00';
    const targetId = adminCtx
      ? adminCtx.is_superadmin
        ? requestedId
        : normalizeInstanceIdKey(adminCtx.assigned_instance_id) || 'servibot-01'
      : requestedId;
    return handleTeamsWebhook(req, res, (args) =>
      runPythonSalesAgent({ ...args, instance_id: args.instance_id || targetId })
    );
  });

  // --- CANAL CORREO ELECTRÓNICO (IMAP / SMTP) ---
  app.post('/api/channels/email/simulate', requireFirebaseAuth, requireActiveClientSubscription, async (req, res) => {
    const targetId = getTargetAdminInstanceId(req);
    const result = await simulateIncomingEmail(
      (args) => runPythonSalesAgent({ ...args, instance_id: args.instance_id || targetId }),
      req.body || {}
    );
    res.json(result);
  });

  app.post('/api/channels/email/poll', requireFirebaseAuth, async (req, res) => {
    await pollImapOnce(runPythonSalesAgent);
    res.json({ ok: true, status: getEmailWorkerStatus() });
  });

  // --- HELPER: SINCRONIZACIÓN DE WEBHOOK EN TELEGRAM BOT API ---
  async function syncTelegramWebhook(cfg = {}, req = null) {
    const token = String(cfg.bot_token || '').trim();
    const enabled = Boolean(cfg.enabled);
    if (!token) {
      return { ok: false, error: 'No se ha configurado un Bot Token de Telegram.' };
    }

    const publicBase =
      process.env.PUBLIC_BACKEND_URL ||
      getTunnelStatus()?.publicUrl ||
      (req ? resolvePublicBackendBaseUrl(req) : 'https://dqo1j67xmphbf.cloudfront.net');
    const cleanBase = String(publicBase || 'https://dqo1j67xmphbf.cloudfront.net').replace(/\/+$/, '');
    const webhookUrl = `${cleanBase}/api/channels/telegram/webhook`;

    // 1. Validar bot con getMe
    let botInfo = null;
    try {
      const meRes = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, {
        signal: AbortSignal.timeout(8000)
      });
      const meData = await meRes.json();
      if (!meData.ok) {
        return {
          ok: false,
          error: `Telegram getMe rechazado: ${meData.description || 'Token inválido'}`
        };
      }
      botInfo = meData.result;
    } catch (err) {
      return {
        ok: false,
        error: `Error al contactar con la API de Telegram (getMe): ${err.message}`
      };
    }

    // 2. Si el canal está desactivado, eliminar webhook de Telegram
    if (!enabled) {
      try {
        const delRes = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/deleteWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ drop_pending_updates: false }),
          signal: AbortSignal.timeout(8000)
        });
        const delData = await delRes.json();
        return {
          ok: true,
          disabled: true,
          bot_info: botInfo,
          webhook_deleted: Boolean(delData.ok),
          description: 'Webhook desvinculado de Telegram (atención automática desactivada).'
        };
      } catch (err) {
        return {
          ok: false,
          error: `Error al desregistrar webhook en Telegram: ${err.message}`
        };
      }
    }

    // 3. Registrar el webhook en Telegram
    try {
      const setRes = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ['message', 'edited_message', 'callback_query'],
          drop_pending_updates: false
        }),
        signal: AbortSignal.timeout(8000)
      });
      const setData = await setRes.json();
      if (!setData.ok) {
        return {
          ok: false,
          error: `Telegram setWebhook error: ${setData.description || 'Fallo desconocido'}`
        };
      }

      // 4. Consultar webhookInfo para confirmación final
      let webhookInfo = null;
      try {
        const infoRes = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getWebhookInfo`, {
          signal: AbortSignal.timeout(8000)
        });
        const infoData = await infoRes.json();
        if (infoData.ok) {
          webhookInfo = infoData.result;
        }
      } catch (_) {}

      // 5. Generar deep link y código QR para Telegram (t.me/botusername)
      const rawUser = String(botInfo?.username || cfg.bot_username || '').trim();
      const cleanUser = rawUser.replace(/^@+/, '');
      let deepLink = cleanUser ? `https://t.me/${cleanUser}` : null;
      let qrBase64 = null;
      if (deepLink) {
        try {
          qrBase64 = await QRCode.toDataURL(deepLink, {
            margin: 2,
            width: 280,
            color: { dark: '#0f172a', light: '#ffffff' }
          });
        } catch (_) {}
      }

      return {
        ok: true,
        webhook_url: webhookUrl,
        bot_info: botInfo,
        webhook_info: webhookInfo,
        username: cleanUser,
        deep_link: deepLink,
        qr_base64: qrBase64,
        description: setData.description || 'Webhook sincronizado exitosamente con Telegram.'
      };
    } catch (err) {
      return {
        ok: false,
        error: `Fallo al registrar webhook en Telegram: ${err.message}`
      };
    }
  }

  // --- CANAL TELEGRAM (CHARLAS) ---
  app.post('/api/channels/telegram/webhook', async (req, res) => {
    try {
      const body = req.body || {};
      const msg = body.message || body.edited_message || body.channel_post || body;
      const senderId = String(msg.from?.id || body.sender_id || 'tg_user_01');
      const senderName = String(msg.from?.username || msg.from?.first_name || body.sender_name || 'Usuario Telegram');
      let text = String(msg.text || body.text || body.message || '').trim();
      const chatId = msg.chat?.id || body.chat_id;
      const targetId = normalizeInstanceIdKey(req.query?.instance_id || body.instance_id) || 'servibot-00';

      if (!text) {
        return res.json({ ok: true, ignored: true });
      }

      if (text === '/start') {
        text = 'Hola, acabo de iniciar la conversación en Telegram. ¿Qué servicios o productos ofrecen?';
      }

      const agentResult = await runPythonSalesAgent({
        channel: 'telegram',
        sender_id: senderId,
        sender_name: senderName,
        message: text,
        instance_id: targetId
      });

      const cfg = getSetting('telegram_config', {});
      let sentReal = false;
      if (cfg.enabled && cfg.bot_token && chatId && agentResult?.reply) {
        try {
          const tgSendRes = await fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.bot_token)}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: agentResult.reply }),
            signal: AbortSignal.timeout(8000)
          });
          const tgSendData = await tgSendRes.json();
          sentReal = Boolean(tgSendData.ok);
          if (!tgSendData.ok) {
            console.error('[TELEGRAM] Error devuelto por API de Telegram al enviar mensaje:', tgSendData.description);
          }
        } catch (e) {
          console.error('[TELEGRAM] Error al enviar mensaje real:', e.message);
        }
      }

      if (text && senderName) {
        try {
          await notifyTeamsIncomingWebhook(
            `💬 **Nuevo Mensaje en Telegram (@${senderName})**:\n"${text}"\n\n🤖 *Respuesta ServiBot:*\n${agentResult?.reply || '(Procesado)'}`
          );
        } catch (_) {}
      }

      res.json({ ok: true, channel: 'telegram', sentReal, reply: agentResult?.reply, servibot: agentResult });
    } catch (err) {
      console.error('[TELEGRAM Webhook] Error interno:', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Estado y diagnóstico en vivo de Telegram
  app.get('/api/channels/telegram/status', requireFirebaseAuth, async (req, res) => {
    try {
      const cfg = getSetting('telegram_config', {});
      const token = String(cfg.bot_token || '').trim();
      const basePublicUrl =
        process.env.PUBLIC_BACKEND_URL ||
        getTunnelStatus()?.publicUrl ||
        resolvePublicBackendBaseUrl(req);
      const webhookUrl = `${String(basePublicUrl).replace(/\/+$/, '')}/api/channels/telegram/webhook`;

      if (!token) {
        return res.json({
          ok: true,
          configured: false,
          enabled: Boolean(cfg.enabled),
          webhook_url: webhookUrl,
          message: 'Bot Token de Telegram no configurado.'
        });
      }

      let botInfo = null;
      let webhookInfo = null;
      let liveError = null;

      try {
        const meRes = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`, {
          signal: AbortSignal.timeout(6000)
        });
        const meData = await meRes.json();
        if (meData.ok) botInfo = meData.result;
        else liveError = meData.description;

        const whRes = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getWebhookInfo`, {
          signal: AbortSignal.timeout(6000)
        });
        const whData = await whRes.json();
        if (whData.ok) webhookInfo = whData.result;
      } catch (err) {
        liveError = err.message;
      }

      const rawUser = String(botInfo?.username || cfg.bot_username || '').trim();
      const cleanUser = rawUser.replace(/^@+/, '');
      const deepLink = cleanUser ? `https://t.me/${cleanUser}` : null;
      let qrBase64 = cfg.qr_base64 || null;
      if (deepLink && !qrBase64) {
        try {
          qrBase64 = await QRCode.toDataURL(deepLink, {
            margin: 2,
            width: 280,
            color: { dark: '#0f172a', light: '#ffffff' }
          });
        } catch (_) {}
      }

      res.json({
        ok: true,
        configured: true,
        enabled: Boolean(cfg.enabled),
        webhook_url: webhookUrl,
        webhook_synced: Boolean(cfg.webhook_synced && webhookInfo?.url === webhookUrl),
        bot_info: botInfo,
        webhook_info: webhookInfo,
        username: cleanUser,
        deep_link: deepLink,
        qr_base64: qrBase64,
        last_sync_at: cfg.last_sync_at || null,
        live_error: liveError || cfg.sync_error || null
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Generar código QR para Telegram (deep link t.me/botusername)
  app.get('/api/channels/telegram/qr', async (req, res) => {
    try {
      const cfg = getSetting('telegram_config', {});
      const rawUser = String(req.query.username || cfg.bot_username || '').trim();
      const cleanUser = rawUser.replace(/^@+/, '');
      if (!cleanUser) {
        return res.status(400).json({
          ok: false,
          error: 'Por favor ingresa o configura el usuario de tu bot (@username) para generar el código QR.'
        });
      }

      const deepLink = `https://t.me/${cleanUser}`;
      const qrBase64 = await QRCode.toDataURL(deepLink, {
        margin: 2,
        width: 280,
        color: { dark: '#0f172a', light: '#ffffff' }
      });

      res.json({
        ok: true,
        username: cleanUser,
        deep_link: deepLink,
        qr_base64: qrBase64
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Sincronización explícita manual del webhook con Telegram
  app.post('/api/channels/telegram/sync-webhook', requireFirebaseAuth, async (req, res) => {
    try {
      if (!req.adminAccount?.is_superadmin) {
        return res.status(403).json({ ok: false, error: 'Solo el administrador principal puede sincronizar el webhook de Telegram.' });
      }
      const currentCfg = getSetting('telegram_config', {});
      const overrideToken = req.body?.bot_token ? String(req.body.bot_token).trim() : null;
      const overrideEnabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : null;
      const targetCfg = {
        ...currentCfg,
        ...(overrideToken !== null ? { bot_token: overrideToken } : {}),
        ...(overrideEnabled !== null ? { enabled: overrideEnabled } : {})
      };

      const syncResult = await syncTelegramWebhook(targetCfg, req);
      if (syncResult.ok) {
        if (syncResult.bot_info?.username) {
          targetCfg.bot_username = `@${syncResult.bot_info.username}`;
        }
        if (syncResult.bot_info?.first_name) {
          targetCfg.bot_name = syncResult.bot_info.first_name;
        }
        targetCfg.webhook_url = syncResult.webhook_url || '';
        targetCfg.webhook_synced = !syncResult.disabled;
        targetCfg.deep_link = syncResult.deep_link || (targetCfg.bot_username ? `https://t.me/${targetCfg.bot_username.replace(/^@+/, '')}` : null);
        targetCfg.qr_base64 = syncResult.qr_base64 || null;
        targetCfg.sync_error = null;
        targetCfg.last_sync_at = new Date().toISOString();
      } else {
        targetCfg.webhook_synced = false;
        targetCfg.sync_error = syncResult.error || 'Error desconocido';
        targetCfg.last_sync_at = new Date().toISOString();
      }

      setSetting('telegram_config', targetCfg);
      res.json({ ok: syncResult.ok, sync: syncResult, config: targetCfg });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/channels/telegram/simulate', requireFirebaseAuth, requireActiveClientSubscription, async (req, res) => {
    try {
      const targetId = getTargetAdminInstanceId(req);
      const { user, text } = req.body || {};
      const cleanUser = String(user || 'Usuario Telegram').trim();
      const cleanText = String(text || 'Hola, deseo informes de sus servicios.').trim();

      const agentResult = await runPythonSalesAgent({
        channel: 'telegram',
        sender_id: cleanUser.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 32) || 'tg_user',
        sender_name: cleanUser,
        message: cleanText,
        instance_id: targetId
      });

      res.json({ ok: true, channel: 'telegram', reply: agentResult?.reply, servibot: agentResult });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- CANAL INSTAGRAM (COMENTARIOS EN PUBLICACIONES / REELS) ---
  app.get('/api/channels/instagram/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const cfg = getSetting('instagram_config', {});
    const expectedToken = cfg.verify_token || 'servibot_meta_token';
    if (mode === 'subscribe' && token === expectedToken) {
      return res.status(200).send(challenge);
    }
    res.status(403).send('Forbidden');
  });

  app.post('/api/channels/instagram/webhook', async (req, res) => {
    try {
      const body = req.body || {};
      let text = '';
      let senderId = '';
      let senderName = '';
      let postId = '';
      let commentId = '';
      let isDm = false;

      if (body.entry && Array.isArray(body.entry)) {
        const entry = body.entry[0] || {};
        // 1. Mensajes Directos (DMs) de Instagram
        if (entry.messaging && Array.isArray(entry.messaging) && entry.messaging.length > 0) {
          const msg = entry.messaging[0];
          text = msg.message?.text || '';
          senderId = msg.sender?.id || 'ig_user_dm';
          senderName = msg.sender?.username || senderId || 'usuario_instagram';
          isDm = true;
        } else {
          // 2. Comentarios en Publicaciones o Reels
          const change = entry.changes?.[0]?.value || {};
          text = change.text || '';
          senderId = change.from?.id || 'ig_user_01';
          senderName = change.from?.username || 'usuario_instagram';
          postId = change.media?.id || 'post_100';
          commentId = change.id || '';
          isDm = false;
        }
      } else {
        text = body.message || body.comment || body.text || '';
        senderId = body.user_id || body.sender_id || 'ig_user_01';
        senderName = body.username || body.sender_name || 'usuario_instagram';
        postId = body.post_id || '';
        commentId = body.comment_id || '';
        isDm = Boolean(body.is_dm || !body.post_id);
      }

      if (!text.trim()) {
        return res.json({ ok: true, ignored: true });
      }

      const targetId = normalizeInstanceIdKey(req.query?.instance_id || body.instance_id) || 'servibot-00';
      const cleanUser = String(senderName).replace(/^@/, '');
      const prefix = isDm ? `[MENSAJE DIRECTO / DM]` : `[COMENTARIO EN POST/REEL ${postId}]`;
      const agentResult = await runPythonSalesAgent({
        channel: 'instagram',
        sender_id: String(senderId || cleanUser),
        sender_name: `@${cleanUser}`,
        message: `${prefix}: ${text.trim()}`,
        instance_id: targetId
      });

      // Publicar respuesta real en Instagram vía Meta Graph API si se cuenta con access_token
      const igCfg = getSetting('instagram_config', {});
      const accessToken = igCfg.access_token || process.env.INSTAGRAM_ACCESS_TOKEN || '';
      let metaDispatchResult = null;

      if (accessToken && agentResult?.reply) {
        try {
          if (isDm && senderId) {
            const resp = await fetch('https://graph.facebook.com/v18.0/me/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
              },
              body: JSON.stringify({
                recipient: { id: senderId },
                message: { text: agentResult.reply }
              })
            });
            metaDispatchResult = await resp.json();
            console.log('[INSTAGRAM DM DISPATCH]', metaDispatchResult);
          } else if (commentId) {
            const resp = await fetch(`https://graph.facebook.com/v18.0/${encodeURIComponent(commentId)}/replies`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
              },
              body: JSON.stringify({
                message: agentResult.reply
              })
            });
            metaDispatchResult = await resp.json();
            console.log('[INSTAGRAM COMMENT DISPATCH]', metaDispatchResult);
          }
        } catch (dispatchErr) {
          console.error('[INSTAGRAM DISPATCH ERROR]', dispatchErr.message);
        }
      } else if (!accessToken) {
        console.warn('[INSTAGRAM] Recibido webhook pero no hay access_token configurado en instagram_config.');
      }

      res.json({
        ok: true,
        channel: 'instagram',
        type: isDm ? 'direct_message' : 'comment',
        reply: agentResult?.reply,
        dispatched_to_meta: Boolean(metaDispatchResult && !metaDispatchResult.error),
        meta_result: metaDispatchResult,
        servibot: agentResult
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/channels/instagram/simulate', requireFirebaseAuth, requireActiveClientSubscription, async (req, res) => {
    try {
      const targetId = getTargetAdminInstanceId(req);
      const { user, post_id, comment } = req.body || {};
      const cleanUser = String(user || 'cliente_creativo').replace(/^@/, '').trim();
      const cleanPost = String(post_id || 'reel_lanzamiento_01').trim();
      const cleanComment = String(comment || '¿Qué precio tiene este paquete? ¿Tienen promociones hoy?').trim();

      const agentResult = await runPythonSalesAgent({
        channel: 'instagram',
        sender_id: cleanUser.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'ig_prospect',
        sender_name: `@${cleanUser}`,
        message: `[COMENTARIO EN POST/REEL ${cleanPost}]: ${cleanComment}`,
        instance_id: targetId
      });

      res.json({ ok: true, channel: 'instagram', reply: agentResult?.reply, servibot: agentResult });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- CANAL TIKTOK (COMENTARIOS EN VIDEOS) ---
  app.post('/api/channels/tiktok/webhook', async (req, res) => {
    try {
      const body = req.body || {};
      let text = '';
      let senderId = '';
      let senderName = '';
      let videoId = '';

      if (body.event === 'comment.created' && body.data) {
        text = body.data.text || '';
        senderId = body.data.user_id || 'tt_user_01';
        senderName = body.data.user_name || 'usuario_tiktok';
        videoId = body.data.video_id || 'video_tiktok_1';
      } else {
        text = body.comment || body.text || '';
        senderId = body.user_id || body.sender_id || 'tt_user_01';
        senderName = body.username || body.sender_name || 'usuario_tiktok';
        videoId = body.video_id || 'video_tiktok_1';
      }

      if (!text.trim()) {
        return res.json({ ok: true, ignored: true });
      }

      const targetId = normalizeInstanceIdKey(req.query?.instance_id || body.instance_id) || 'servibot-00';
      const cleanUser = String(senderName).replace(/^@/, '');
      const agentResult = await runPythonSalesAgent({
        channel: 'tiktok',
        sender_id: String(senderId || cleanUser),
        sender_name: `@${cleanUser}`,
        message: `[COMENTARIO EN VIDEO TIKTOK ${videoId}]: ${text.trim()}`,
        instance_id: targetId
      });

      res.json({ ok: true, channel: 'tiktok', reply: agentResult?.reply, servibot: agentResult });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/channels/tiktok/simulate', requireFirebaseAuth, requireActiveClientSubscription, async (req, res) => {
    try {
      const targetId = getTargetAdminInstanceId(req);
      const { user, video_id, comment } = req.body || {};
      const cleanUser = String(user || 'usuario_trend').replace(/^@/, '').trim();
      const cleanVideo = String(video_id || 'video_viral_404').trim();
      const cleanComment = String(comment || '¡Está increíble! ¿Cómo los contacto para contratarlo?').trim();

      const agentResult = await runPythonSalesAgent({
        channel: 'tiktok',
        sender_id: cleanUser.toLowerCase().replace(/[^a-z0-9_]/g, '') || 'tt_prospect',
        sender_name: `@${cleanUser}`,
        message: `[COMENTARIO EN VIDEO TIKTOK ${cleanVideo}]: ${cleanComment}`,
        instance_id: targetId
      });

      res.json({ ok: true, channel: 'tiktok', reply: agentResult?.reply, servibot: agentResult });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- CANAL MICROSOFT TEAMS (SIMULACIÓN RÁPIDA) ---
  app.post('/api/channels/teams/simulate', requireFirebaseAuth, requireActiveClientSubscription, async (req, res) => {
    try {
      const targetId = getTargetAdminInstanceId(req);
      const { user, text } = req.body || {};
      const cleanUser = String(user || 'Usuario Teams').trim();
      const cleanText = String(text || 'Hola equipo, solicito cotización para nuestra empresa.').trim();

      const agentResult = await runPythonSalesAgent({
        channel: 'teams',
        sender_id: cleanUser.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 32) || 'teams_user',
        sender_name: cleanUser,
        message: cleanText,
        instance_id: targetId
      });

      res.json({ ok: true, channel: 'teams', reply: agentResult?.reply, servibot: agentResult });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- CANAL UNIFICADO MICROSOFT 365: OUTLOOK + TEAMS (OAUTH 2.0 EN 1 PASO) ---
  app.get('/api/channels/microsoft/status', requireFirebaseAuth, (req, res) => {
    const targetId = getTargetAdminInstanceId(req);
    let stored = getBotSetting(targetId, 'microsoft_channel', null);
    if (!stored && targetId === 'servibot-00') {
      const legacyEmail = getSetting('email_config', {});
      const legacyTeams = getSetting('teams_config', {});
      if (legacyEmail.auth_mode === 'microsoft_oauth2' && legacyEmail.user) {
        stored = {
          connected: true,
          outlook_enabled: Boolean(legacyEmail.enabled),
          teams_enabled: Boolean(legacyTeams.enabled),
          account_email: legacyEmail.user,
          account_name: legacyEmail.from_name || legacyEmail.user,
          provider: 'microsoft_oauth2'
        };
      }
    }
    res.json(sanitizeMicrosoftStatusPayload(targetId, stored || {}));
  });

  app.post(
    '/api/channels/microsoft/oauth/init',
    requireFirebaseAuth,
    requireActiveClientSubscription,
    (req, res) => {
      pruneExpiredMsStates();
      const targetId = getTargetAdminInstanceId(req);
      const appCfg = getMicrosoftOAuthAppConfig();
      const origin = String(req.body?.origin || req.headers.origin || PUBLIC_ORIGIN).trim();
      const loginHint = String(req.body?.login_hint || req.adminAccount?.email || '').trim().toLowerCase();
      const customClientId = String(req.body?.client_id || appCfg.client_id || '').trim();
      const tenant = String(req.body?.tenant_id || appCfg.tenant_id || 'common').trim() || 'common';
      const stateToken = crypto.randomBytes(24).toString('hex');

      msOAuthPendingStates.set(stateToken, {
        instanceId: targetId,
        adminEmail: req.adminAccount?.email || '',
        isSuperadmin: Boolean(req.adminAccount?.is_superadmin),
        origin,
        loginHint,
        clientId: customClientId,
        tenant,
        createdAt: Date.now()
      });

      const backendBase = resolvePublicBackendBaseUrl(req);
      const authUrl = `${backendBase}/api/channels/microsoft/oauth/start?state=${encodeURIComponent(stateToken)}`;

      res.json({
        ok: true,
        state: stateToken,
        instance_id: targetId,
        authUrl,
        azure_app_configured: Boolean(customClientId),
        redirect_uri: `${backendBase}/api/channels/microsoft/oauth/callback`
      });
    }
  );

  app.get('/api/channels/microsoft/oauth/start', (req, res) => {
    pruneExpiredMsStates();
    const stateToken = String(req.query.state || '').trim();
    const stateEntry = stateToken ? msOAuthPendingStates.get(stateToken) : null;
    const appCfg = getMicrosoftOAuthAppConfig();
    const backendBase = resolvePublicBackendBaseUrl(req);
    const redirectUri = `${backendBase}/api/channels/microsoft/oauth/callback`;
    const activeClientId = String(req.query.client_id || stateEntry?.clientId || appCfg.client_id || '').trim();
    const tenant = String(req.query.tenant_id || stateEntry?.tenant || appCfg.tenant_id || 'common').trim() || 'common';
    const loginHint = String(req.query.login_hint || stateEntry?.loginHint || '').trim();

    if (activeClientId && stateEntry && req.query.direct !== '0') {
      if (req.query.client_id && stateEntry) {
        stateEntry.clientId = activeClientId;
        stateEntry.tenant = tenant;
      }
      const params = new URLSearchParams({
        client_id: activeClientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: MICROSOFT_OAUTH_SCOPES,
        state: stateToken,
        prompt: 'select_account'
      });
      if (loginHint) params.set('login_hint', loginHint);
      return res.redirect(302, `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}`);
    }

    const instanceLabel = escapeHtmlServer(stateEntry?.instanceId || req.query.instance_id || 'servibot-00');
    const safeHint = escapeHtmlServer(loginHint);
    const safeState = escapeHtmlServer(stateToken);
    const safeRedirect = escapeHtmlServer(redirectUri);

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Iniciar sesión con Microsoft · Servi-Bot</title>
  <style>
    * { box-sizing: border-box; }
    body { margin:0; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; background: radial-gradient(circle at top, #172554, #090d16 70%); color:#f1f5f9; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:1.25rem; }
    .ms-card { width:100%; max-width:440px; background:#ffffff; color:#1b1a19; border-radius:14px; padding:1.75rem; box-shadow:0 24px 60px rgba(0,0,0,0.45); }
    .ms-brand { display:flex; align-items:center; gap:0.65rem; margin-bottom:1.1rem; font-weight:600; font-size:1.05rem; color:#5e5e5e; }
    h1 { margin:0 0 0.4rem; font-size:1.3rem; color:#1b1a19; }
    .sub { margin:0 0 1rem; font-size:0.86rem; color:#484644; line-height:1.45; }
    .perm-box { background:#f3f2f1; border:1px solid #e1dfdd; border-radius:10px; padding:0.8rem 0.9rem; margin-bottom:1.1rem; font-size:0.82rem; color:#323130; }
    .perm-box strong { display:block; margin-bottom:0.35rem; color:#005a9e; }
    .perm-box ul { margin:0; padding-left:1.1rem; line-height:1.5; }
    label { display:block; font-size:0.82rem; font-weight:600; color:#323130; margin-bottom:0.35rem; }
    input { width:100%; padding:0.6rem 0.75rem; border:1px solid #8a8886; border-radius:6px; font-size:0.9rem; margin-bottom:0.85rem; }
    input:focus { outline:2px solid #0078d4; border-color:#0078d4; }
    .btn-ms { width:100%; display:inline-flex; align-items:center; justify-content:center; gap:0.6rem; background:#0078d4; color:#fff; border:none; border-radius:6px; padding:0.72rem 1rem; font-size:0.94rem; font-weight:600; cursor:pointer; }
    .btn-ms:hover { background:#106ebe; }
    .btn-sec { width:100%; margin-top:0.55rem; background:#f3f2f1; color:#323130; border:1px solid #c8c6c4; border-radius:6px; padding:0.55rem 0.9rem; font-size:0.82rem; font-weight:600; cursor:pointer; }
    details { margin-top:1rem; border-top:1px solid #edebe9; padding-top:0.85rem; font-size:0.8rem; color:#605e5c; }
    summary { cursor:pointer; font-weight:600; color:#005a9e; }
    code { background:#f3f2f1; padding:0.15rem 0.35rem; border-radius:4px; word-break:break-all; display:inline-block; margin-top:0.25rem; }
    .warn { background:#fff4ce; border:1px solid #fde300; color:#3b3a39; padding:0.65rem 0.8rem; border-radius:8px; font-size:0.8rem; margin-bottom:0.9rem; }
  </style>
</head>
<body>
  <div class="ms-card">
    <div class="ms-brand">
      <svg width="22" height="22" viewBox="0 0 21 21" aria-hidden="true">
        <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
        <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
        <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
        <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
      </svg>
      <span>Microsoft Identity Platform · Servi-Bot</span>
    </div>
    <h1>Conectar Outlook y Teams</h1>
    <p class="sub">
      Solicitud de inicio de sesión externo para vincular la instancia <strong>${instanceLabel}</strong> sin capturar contraseñas IMAP/SMTP.
    </p>
    <div class="perm-box">
      <strong>Permisos unificados solicitados en 1 paso:</strong>
      <ul>
        <li>📧 <strong>Outlook Mail</strong> (<code>Mail.ReadWrite</code>, <code>Mail.Send</code>)</li>
        <li>👥 <strong>Microsoft Teams</strong> (<code>ChannelMessage.Send</code>, <code>Chat.ReadWrite</code>)</li>
        <li>👤 <strong>Perfil Microsoft 365</strong> (<code>openid profile email offline_access</code>)</li>
      </ul>
    </div>
    ${stateEntry ? `
      <form method="GET" action="/api/channels/microsoft/oauth/callback">
        <input type="hidden" name="state" value="${safeState}" />
        <label for="ms-email-hint">Cuenta de Microsoft (Outlook / Microsoft 365)</label>
        <input id="ms-email-hint" type="email" name="account_email" value="${safeHint}" placeholder="nombre@outlook.com o usuario@empresa.com" required />
        <label for="ms-name-hint">Nombre a mostrar en Outlook y Teams</label>
        <input id="ms-name-hint" type="text" name="account_name" value="${safeHint}" placeholder="Ej. Atención Comercial" />
        <button type="submit" class="btn-ms">Autorizar Outlook y Microsoft Teams en 1 Paso</button>
      </form>
      <details>
        <summary>Usar Azure Entra ID externo (login.microsoftonline.com)</summary>
        <p style="margin:0.5rem 0;">Pega el <strong>Application (client) ID</strong> de tu App en Azure Entra ID y redirige directamente a Microsoft:</p>
        <p style="margin:0.35rem 0 0.65rem;">Redirect URI:<br/><code>${safeRedirect}</code></p>
        <form method="GET" action="/api/channels/microsoft/oauth/start">
          <input type="hidden" name="state" value="${safeState}" />
          <input type="hidden" name="direct" value="1" />
          <label for="azure-client-id">Azure Client ID</label>
          <input id="azure-client-id" type="text" name="client_id" placeholder="00000000-0000-0000-0000-000000000000" required />
          <input type="hidden" name="login_hint" value="${safeHint}" />
          <button type="submit" class="btn-sec">Continuar en login.microsoftonline.com →</button>
        </form>
      </details>
    ` : `
      <div class="warn">
        Esta ventana debe iniciarse desde el botón <strong>Iniciar sesión con Microsoft</strong> dentro de la sección Canales del panel Admin autenticado.
      </div>
      <button type="button" class="btn-sec" onclick="window.close()">Cerrar</button>
    `}
  </div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  async function handleMicrosoftOAuthCallback(req, res) {
    pruneExpiredMsStates();
    const params = req.method === 'POST' ? req.body || {} : req.query || {};
    const stateToken = String(params.state || '').trim();
    const stateEntry = stateToken ? msOAuthPendingStates.get(stateToken) : null;
    if (stateToken) msOAuthPendingStates.delete(stateToken);

    const allowedOrigin = stateEntry?.origin || '*';
    if (params.error) {
      return res
        .status(400)
        .send(buildMsCallbackHtml({ ok: false, error: params.error_description || params.error, allowedOrigin }));
    }

    if (!stateEntry) {
      return res
        .status(400)
        .send(buildMsCallbackHtml({ ok: false, error: 'Token state OAuth inválido o expirado. Intenta nuevamente desde Admin.', allowedOrigin }));
    }

    const appCfg = getMicrosoftOAuthAppConfig();
    const activeClientId = String(stateEntry.clientId || appCfg.client_id || '').trim();
    const tenant = String(stateEntry.tenant || appCfg.tenant_id || 'common').trim() || 'common';
    const redirectUri = `${resolvePublicBackendBaseUrl(req)}/api/channels/microsoft/oauth/callback`;

    let accountEmail = String(params.account_email || stateEntry.loginHint || stateEntry.adminEmail || '').trim().toLowerCase();
    let accountName = String(params.account_name || accountEmail).trim();
    let accessToken = '';
    let refreshToken = '';
    let tokenExpiresAt = null;
    let resolvedScope = MICROSOFT_OAUTH_SCOPES;
    let provider = 'microsoft_oauth2';

    if (params.code && activeClientId) {
      try {
        const tokenBody = new URLSearchParams({
          client_id: activeClientId,
          grant_type: 'authorization_code',
          code: String(params.code),
          redirect_uri: redirectUri,
          scope: MICROSOFT_OAUTH_SCOPES
        });
        if (appCfg.client_secret) {
          tokenBody.set('client_secret', appCfg.client_secret);
        }
        const tokenResp = await fetch(
          `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenBody.toString(),
            signal: AbortSignal.timeout(15000)
          }
        );
        const tokenData = await tokenResp.json();
        if (!tokenResp.ok) {
          return res
            .status(400)
            .send(
              buildMsCallbackHtml({
                ok: false,
                error: tokenData.error_description || tokenData.error || `Error OAuth token (${tokenResp.status})`,
                allowedOrigin
              })
            );
        }

        accessToken = tokenData.access_token || '';
        refreshToken = tokenData.refresh_token || '';
        resolvedScope = tokenData.scope || MICROSOFT_OAUTH_SCOPES;
        if (tokenData.expires_in) {
          tokenExpiresAt = new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString();
        }
        const claims = decodeJwtPayloadUnsafe(tokenData.id_token);
        accountEmail = String(claims.preferred_username || claims.email || claims.upn || accountEmail || '').toLowerCase();
        accountName = String(claims.name || accountName || accountEmail);

        if (accessToken) {
          const meResp = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(10000)
          });
          if (meResp.ok) {
            const meData = await meResp.json();
            accountEmail = String(meData.mail || meData.userPrincipalName || accountEmail || '').toLowerCase();
            accountName = String(meData.displayName || accountName || accountEmail);
          }
        }
        provider = 'microsoft_azure_oauth2';
      } catch (err) {
        return res.status(500).send(buildMsCallbackHtml({ ok: false, error: err.message, allowedOrigin }));
      }
    }

    if (!accountEmail || !accountEmail.includes('@')) {
      return res.status(400).send(
        buildMsCallbackHtml({
          ok: false,
          error: 'No se recibió el correo electrónico de la cuenta Microsoft.',
          allowedOrigin
        })
      );
    }

    const saved = saveUnifiedMicrosoftConnection(
      stateEntry.instanceId,
      {
        account_email: accountEmail,
        account_name: accountName || accountEmail,
        tenant_id: tenant,
        scope: resolvedScope,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_expires_at: tokenExpiresAt,
        provider
      },
      runPythonSalesAgent
    );

    return res.send(buildMsCallbackHtml({ ok: true, payload: saved, allowedOrigin }));
  }

  app.get('/api/channels/microsoft/oauth/callback', handleMicrosoftOAuthCallback);
  app.post('/api/channels/microsoft/oauth/callback', handleMicrosoftOAuthCallback);

  app.post(
    '/api/channels/microsoft/connect',
    requireFirebaseAuth,
    requireActiveClientSubscription,
    (req, res) => {
      const targetId = getTargetAdminInstanceId(req);
      const accountEmail = String(req.body?.account_email || req.adminAccount?.email || '').trim().toLowerCase();
      if (!accountEmail || !accountEmail.includes('@')) {
        return res.status(400).json({ ok: false, error: 'Cuenta de Microsoft válida requerida.' });
      }
      const saved = saveUnifiedMicrosoftConnection(
        targetId,
        {
          account_email: accountEmail,
          account_name: req.body?.account_name || accountEmail,
          tenant_id: req.body?.tenant_id || 'common',
          access_token: req.body?.access_token || '',
          refresh_token: req.body?.refresh_token || '',
          provider: req.body?.provider || 'microsoft_oauth2'
        },
        runPythonSalesAgent
      );
      return res.json(saved);
    }
  );

  app.post(
    '/api/channels/microsoft/disconnect',
    requireFirebaseAuth,
    requireActiveClientSubscription,
    (req, res) => {
      const targetId = getTargetAdminInstanceId(req);
      setBotSetting(targetId, 'microsoft_channel', {
        connected: false,
        outlook_enabled: false,
        teams_enabled: false,
        account_email: '',
        account_name: '',
        disconnected_at: new Date().toISOString()
      });

      if (targetId === 'servibot-00') {
        const currentEmail = getSetting('email_config', {});
        setSetting('email_config', {
          ...currentEmail,
          enabled: false,
          access_token: '',
          refresh_token: '',
          auth_mode: 'password'
        });
        const currentTeams = getSetting('teams_config', {});
        setSetting('teams_config', {
          ...currentTeams,
          microsoft_oauth_connected: false,
          account_email: ''
        });
        startEmailPolling(runPythonSalesAgent);
      }

      res.json(sanitizeMicrosoftStatusPayload(targetId, {}));
    }
  );

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

          const reg = db.prepare('SELECT * FROM order_registry WHERE order_code = ?').get(orderCode);
          const bot0Db = getBotDb('servibot-00');
          const existingBot0 = bot0Db.prepare('SELECT id, notes FROM orders WHERE order_code = ?').get(orderCode);
          if (existingBot0) {
            const nextNotes = `${existingBot0.notes || ''} | Pago MP #${paymentId}: ${mpStatus}`.trim();
            bot0Db.prepare('UPDATE orders SET status = ?, notes = ? WHERE id = ?').run(mappedStatus, nextNotes, existingBot0.id);
          }

          if (reg) {
            db.prepare(
              `UPDATE order_registry SET status = ?, updated_at = datetime('now', 'localtime') WHERE order_code = ?`
            ).run(mappedStatus, orderCode);
          }

          if (mpStatus === 'approved') {
            if (reg && reg.instance_id && reg.instance_id !== 'servibot-00') {
              await activatePaidClientInstance({
                orderCode,
                instanceId: reg.instance_id,
                adminEmail: reg.admin_email,
                tempPassword: reg.temp_password,
                customerName: reg.customer_name
              });
            }
            await notifyTeamsIncomingWebhook(
              `💳 **Pago Aprobado en Mercado Pago (${orderCode})** · Pago #${paymentId} por **$${payment.transaction_amount} ${payment.currency_id || 'MXN'}**`
            );
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
    const isSuper = Boolean(req.adminAccount?.is_superadmin);
    const mpSaved = getSetting('mercadopago_config', {});
    const mpCfg = getMercadoPagoConfig();
    res.json({
      ok: true,
      is_superadmin: isSuper,
      bot_config: getSetting('bot_config', {}),
      email_config: isSuper ? getSetting('email_config', {}) : {},
      teams_config: isSuper ? getSetting('teams_config', {}) : {},
      telegram_config: isSuper ? getSetting('telegram_config', {}) : {},
      instagram_config: isSuper ? getSetting('instagram_config', {}) : {},
      tiktok_config: isSuper ? getSetting('tiktok_config', {}) : {},
      tunnel_config: isSuper ? getSetting('tunnel_config', {}) : {},
      mercadopago_config: isSuper
        ? {
            enabled: mpCfg.enabled,
            public_key: mpCfg.publicKey,
            has_access_token: Boolean(mpCfg.accessToken),
            tax_rate: mpCfg.taxRate,
            country: mpCfg.country,
            currency: mpCfg.currency,
            updated_via: mpSaved.public_key ? 'sqlite' : 'env'
          }
        : { enabled: mpCfg.enabled }
    });
  });

  const handleUpdateSetting = async (req, res) => {
    const key = req.params.key;
    const allowed = [
      'bot_config',
      'email_config',
      'teams_config',
      'telegram_config',
      'instagram_config',
      'tiktok_config',
      'tunnel_config',
      'mercadopago_config'
    ];
    if (!allowed.includes(key)) {
      return res.status(400).json({ ok: false, error: 'Clave de configuración no permitida.' });
    }
    if (!req.adminAccount?.is_superadmin && key !== 'bot_config') {
      return res.status(403).json({
        ok: false,
        error: `Solo ${SUPERADMIN_EMAIL} puede modificar la configuración global (${key}).`
      });
    }
    const current = getSetting(key, {});
    const merged = { ...current, ...(req.body || {}) };
    let telegramSyncResult = null;

    if (key === 'email_config') {
      setSetting(key, merged);
      startEmailPolling(runPythonSalesAgent);
    } else if (key === 'tunnel_config' && req.body?.restartTunnel) {
      setSetting(key, merged);
      await startCloudflareTunnel(PORT);
    } else if (key === 'telegram_config' && merged.bot_token) {
      try {
        telegramSyncResult = await syncTelegramWebhook(merged, req);
        if (telegramSyncResult.ok) {
          if (telegramSyncResult.bot_info?.username) {
            merged.bot_username = `@${telegramSyncResult.bot_info.username}`;
          }
          if (telegramSyncResult.bot_info?.first_name) {
            merged.bot_name = telegramSyncResult.bot_info.first_name;
          }
          merged.webhook_url = telegramSyncResult.webhook_url || '';
          merged.webhook_synced = !telegramSyncResult.disabled;
          merged.sync_error = null;
        } else {
          merged.webhook_synced = false;
          merged.sync_error = telegramSyncResult.error || 'Fallo al sincronizar con Telegram';
        }
        merged.last_sync_at = new Date().toISOString();
      } catch (err) {
        merged.webhook_synced = false;
        merged.sync_error = err.message;
        merged.last_sync_at = new Date().toISOString();
        telegramSyncResult = { ok: false, error: err.message };
      }

      if (merged.bot_username) {
        const cleanUser = String(merged.bot_username).replace(/^@+/, '');
        if (cleanUser) {
          merged.deep_link = `https://t.me/${cleanUser}`;
          try {
            merged.qr_base64 = await QRCode.toDataURL(merged.deep_link, {
              margin: 2,
              width: 280,
              color: { dark: '#0f172a', light: '#ffffff' }
            });
          } catch (_) {}
        }
      }

      setSetting(key, merged);
    } else {
      if (key === 'telegram_config' && merged.bot_username) {
        const cleanUser = String(merged.bot_username).replace(/^@+/, '');
        if (cleanUser) {
          merged.deep_link = `https://t.me/${cleanUser}`;
          try {
            merged.qr_base64 = await QRCode.toDataURL(merged.deep_link, {
              margin: 2,
              width: 280,
              color: { dark: '#0f172a', light: '#ffffff' }
            });
          } catch (_) {}
        }
      }
      setSetting(key, merged);
    }

    res.json({
      ok: true,
      key,
      value: key === 'mercadopago_config' ? { ...merged, access_token: merged.access_token ? '***' : '' } : merged,
      tunnel: getTunnelStatus(),
      telegram_sync: telegramSyncResult
    });
  };

  app.put('/api/settings/:key', requireFirebaseAuth, handleUpdateSetting);
  app.post('/api/settings/:key', requireFirebaseAuth, handleUpdateSetting);

  // --- PERFIL ACTUAL DEL ADMIN LOGUEADO (ADMIN 0 vs ADMIN ESTÁNDAR 1..50) ---
  app.get('/api/admin/me', requireFirebaseAuth, (req, res) => {
    const targetId = getTargetAdminInstanceId(req);
    const instanceRow = db.prepare('SELECT * FROM bot_instances WHERE instance_id = ?').get(targetId);
    let availableInstances = [];
    if (req.adminAccount.is_superadmin) {
      availableInstances = db
        .prepare(
          'SELECT instance_id, slot_number, tier, display_name, business_name, paid_status, locked_for_public, subscription_expires_at FROM bot_instances ORDER BY slot_number ASC'
        )
        .all();
    } else if (instanceRow) {
      availableInstances = [instanceRow];
    }

    res.json({
      ok: true,
      email: req.adminAccount.email,
      role: req.adminAccount.role,
      assigned_instance_id: req.adminAccount.assigned_instance_id,
      is_superadmin: Boolean(req.adminAccount.is_superadmin),
      can_manage_accounts: Boolean(req.adminAccount.can_manage_accounts),
      subscription_expires_at: req.adminAccount.subscription_expires_at,
      days_remaining: req.adminAccount.days_remaining,
      subscription_expired: req.adminAccount.subscription_expired,
      instances: availableInstances,
      available_instances: availableInstances,
      user: req.firebaseUser,
      account: {
        email: req.adminAccount.email,
        display_name: req.adminAccount.display_name,
        role: req.adminAccount.role,
        assigned_instance_id: req.adminAccount.assigned_instance_id,
        is_superadmin: Boolean(req.adminAccount.is_superadmin),
        can_manage_accounts: Boolean(req.adminAccount.can_manage_accounts),
        subscription_expires_at: req.adminAccount.subscription_expires_at,
        days_remaining: req.adminAccount.days_remaining,
        subscription_expired: req.adminAccount.subscription_expired
      },
      active_instance_id: targetId,
      instance: instanceRow ? mergeInstanceWithLiveState(instanceRow) : null
    });
  });

  // --- GESTIÓN EXCLUSIVA ADMIN 0 (fraustop@outlook.com): CUENTAS, PROSPECTOS Y BOTS VIP {FOLIO} ---
  app.get('/api/admin/accounts', requireFirebaseAuth, requireSuperAdmin, (req, res) => {
    try {
      const accounts = db
        .prepare(
          `SELECT id, firebase_uid, email, display_name, role, assigned_instance_id,
                  subscription_expires_at, created_by, created_at
           FROM admin_accounts ORDER BY id DESC`
        )
        .all();
      res.json({ ok: true, accounts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/admin/accounts', requireFirebaseAuth, requireSuperAdmin, async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const displayName = String(req.body?.displayName || '').trim();
      const assignedInstanceId =
        normalizeInstanceIdKey(req.body?.assigned_instance_id) || 'servibot-01';
      const role = assignedInstanceId === 'servibot-00' && email === SUPERADMIN_EMAIL
        ? 'superadmin'
        : 'client_admin';
      const subDays = Number(req.body?.subscription_days || STANDARD_PLAN_DAYS);
      const expiresAt =
        assignedInstanceId === 'servibot-00'
          ? null
          : new Date(Date.now() + Math.max(1, subDays) * 24 * 60 * 60 * 1000).toISOString();

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

      db.prepare(
        `
        INSERT INTO admin_accounts (
          firebase_uid, email, display_name, role, assigned_instance_id, subscription_expires_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          firebase_uid = excluded.firebase_uid,
          display_name = excluded.display_name,
          role = excluded.role,
          assigned_instance_id = excluded.assigned_instance_id,
          subscription_expires_at = excluded.subscription_expires_at,
          created_by = excluded.created_by
      `
      ).run(
        signUpData.localId || '',
        email,
        displayName || email,
        role,
        assignedInstanceId,
        expiresAt,
        req.firebaseUser.email
      );

      if (assignedInstanceId !== 'servibot-00' && req.body?.lock_instance !== false) {
        db.prepare(
          `UPDATE bot_instances
           SET paid_status = 'paid',
               paid_at = COALESCE(paid_at, ?),
               subscription_expires_at = ?,
               locked_for_public = 1,
               admin_email = ?
           WHERE instance_id = ?`
        ).run(new Date().toISOString(), expiresAt, email, assignedInstanceId);
      }

      const created = db
        .prepare(
          `SELECT id, firebase_uid, email, display_name, role, assigned_instance_id, subscription_expires_at, created_by, created_at
           FROM admin_accounts WHERE email = ?`
        )
        .get(email);

      res.json({ ok: true, account: created });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/admin/accounts/:id', requireFirebaseAuth, requireSuperAdmin, (req, res) => {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM admin_accounts WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'Cuenta no encontrada.' });
    }
    if (String(existing.email || '').toLowerCase() === SUPERADMIN_EMAIL.toLowerCase()) {
      return res.status(400).json({ ok: false, error: 'No puedes eliminar la cuenta principal Admin 0.' });
    }
    db.prepare('DELETE FROM admin_accounts WHERE id = ?').run(id);
    res.json({ ok: true, deleted: id });
  });

  // --- PROSPECTOS ARCHIVADOS (ROTACIÓN DE LAS 50 INSTANCIAS) ---
  app.get('/api/prospects', requireFirebaseAuth, requireSuperAdmin, (req, res) => {
    try {
      const prospects = prospectsDb
        .prepare(
          `SELECT id, contact_key, client_name, client_contact, business_name, display_name,
                  previous_instance_id, previous_slot_number, archived_at, updated_at
           FROM prospects ORDER BY updated_at DESC LIMIT 100`
        )
        .all();
      res.json({ ok: true, prospects });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // --- BOTS VIP {FOLIO} (SERVIDOR SEPARADO Y ADMIN/API PERSONALIZADOS) ---
  app.get('/api/vip-instances', requireFirebaseAuth, requireSuperAdmin, (req, res) => {
    try {
      const vips = db.prepare('SELECT * FROM vip_instances ORDER BY created_at DESC').all();
      res.json({ ok: true, vip_instances: vips });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/vip-instances', requireFirebaseAuth, requireSuperAdmin, (req, res) => {
    try {
      const body = req.body || {};
      const folioRaw = String(body.folio || '').trim().toUpperCase();
      const folio = folioRaw || `VIP-${Date.now().toString().slice(-5)}`;
      const businessName = String(body.business_name || '').trim();
      const dedicatedServerUrl = String(body.dedicated_server_url || '').trim();
      const customAdminUrl = String(body.custom_admin_url || '').trim();
      let apiConfigJson = '{}';
      if (typeof body.custom_api_config_json === 'string' && body.custom_api_config_json.trim()) {
        apiConfigJson = body.custom_api_config_json.trim();
      } else if (body.custom_api_config && typeof body.custom_api_config === 'object') {
        apiConfigJson = JSON.stringify(body.custom_api_config, null, 2);
      }

      if (!businessName || !dedicatedServerUrl) {
        return res.status(400).json({
          ok: false,
          error: 'El nombre de negocio y la URL del servidor dedicado son obligatorios para registrar un Bot VIP.'
        });
      }

      db.prepare(
        `
        INSERT INTO vip_instances (
          folio, business_name, client_name, client_contact, admin_email,
          dedicated_server_url, custom_admin_url, custom_api_config_json,
          monthly_price, currency, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(folio) DO UPDATE SET
          business_name = excluded.business_name,
          client_name = excluded.client_name,
          client_contact = excluded.client_contact,
          admin_email = excluded.admin_email,
          dedicated_server_url = excluded.dedicated_server_url,
          custom_admin_url = excluded.custom_admin_url,
          custom_api_config_json = excluded.custom_api_config_json,
          monthly_price = excluded.monthly_price,
          currency = excluded.currency,
          status = excluded.status,
          notes = excluded.notes,
          updated_at = datetime('now', 'localtime')
      `
      ).run(
        folio,
        businessName,
        String(body.client_name || '').trim(),
        String(body.client_contact || '').trim(),
        String(body.admin_email || '').trim().toLowerCase(),
        dedicatedServerUrl,
        customAdminUrl,
        apiConfigJson,
        Number(body.monthly_price || 5000),
        String(body.currency || 'MXN').toUpperCase(),
        String(body.status || 'active').trim(),
        String(body.notes || '').trim()
      );

      const created = db.prepare('SELECT * FROM vip_instances WHERE folio = ?').get(folio);
      res.status(201).json({ ok: true, vip: created });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete('/api/vip-instances/:folio', requireFirebaseAuth, requireSuperAdmin, (req, res) => {
    try {
      const folio = String(req.params.folio || '').trim().toUpperCase();
      const info = db.prepare('DELETE FROM vip_instances WHERE folio = ?').run(folio);
      if (info.changes === 0) {
        return res.status(404).json({ ok: false, error: `Folio VIP ${folio} no encontrado.` });
      }
      res.json({ ok: true, deleted: folio });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Subaplicación All Time: Programador de Publicaciones en Redes Sociales
  app.use('/api/alltime', allTimeRouter);
  app.get('/alltime', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'alltime.html'));
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
