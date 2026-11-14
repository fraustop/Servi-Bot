const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const pino = require('pino');
const QRCode = require('qrcode');

const EVOLUTION_PORT = Number(process.env.EVOLUTION_PORT || 10001);
const MAIN_SERVER_WEBHOOK = process.env.MAIN_WEBHOOK_URL || 'http://127.0.0.1:10000/api/webhooks/evolution';
const BASE_AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');

const INSTANCE_IDS = Array.from({ length: 10 }, (_, idx) => `servibot-${String(idx + 1).padStart(2, '0')}`);

const instances = new Map();
for (let i = 0; i < INSTANCE_IDS.length; i += 1) {
  const instanceId = INSTANCE_IDS[i];
  instances.set(instanceId, {
    instanceId,
    slotNumber: i + 1,
    authDir: path.join(BASE_AUTH_DIR, instanceId),
    sock: null,
    state: 'close', // 'close' | 'connecting' | 'qr_ready' | 'open'
    qrRaw: null,
    qrBase64: null,
    qrUpdatedAt: null,
    connectedPhone: null,
    lastError: null,
    isInitializing: false,
    reconnectTimer: null
  });
}

const recentEvents = [];

function recordEvent(type, detail, instanceId = 'system') {
  recentEvents.unshift({
    timestamp: new Date().toISOString(),
    instanceId,
    type,
    detail
  });
  if (recentEvents.length > 80) recentEvents.pop();
}

function resolveInstanceId(rawName) {
  const raw = String(rawName || '').trim().toLowerCase();
  if (!raw || raw === 'servibot-main' || raw === 'default' || raw === 'main') {
    return 'servibot-01';
  }
  if (instances.has(raw)) {
    return raw;
  }
  const numMatch = raw.match(/^(\d{1,2})$/);
  if (numMatch) {
    const num = Number(numMatch[1]);
    if (num >= 1 && num <= 10) {
      return `servibot-${String(num).padStart(2, '0')}`;
    }
  }
  return 'servibot-01';
}

function hasRegisteredSession(authDir) {
  const credsPath = path.join(authDir, 'creds.json');
  if (!fs.existsSync(credsPath)) return false;
  try {
    const raw = fs.readFileSync(credsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.me?.id || parsed?.registered);
  } catch {
    return false;
  }
}

/**
 * Migra la sesión previa almacenada directamente en `auth_info_baileys/creds.json`
 * hacia `auth_info_baileys/servibot-01/` para conservar la conexión existente.
 */
function migrateLegacyRootSession() {
  const rootCreds = path.join(BASE_AUTH_DIR, 'creds.json');
  const firstInstDir = path.join(BASE_AUTH_DIR, 'servibot-01');
  const firstCreds = path.join(firstInstDir, 'creds.json');

  if (!fs.existsSync(rootCreds) || fs.existsSync(firstCreds)) {
    return;
  }

  try {
    fs.mkdirSync(firstInstDir, { recursive: true });
    const entries = fs.readdirSync(BASE_AUTH_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      fs.copyFileSync(
        path.join(BASE_AUTH_DIR, entry.name),
        path.join(firstInstDir, entry.name)
      );
    }
    recordEvent('session_migrated', 'Sesión WhatsApp existente migrada a servibot-01', 'servibot-01');
    console.log('[Evolution:10001] Sesión previa migrada exitosamente a auth_info_baileys/servibot-01');
  } catch (err) {
    console.error('[Evolution:10001] Error migrando sesión previa:', err.message);
  }
}

async function forwardToMainWebhook(payload) {
  try {
    const res = await fetch(MAIN_SERVER_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error('[Evolution:10001] Error enviando webhook al servidor 10000:', err.message);
    return { ok: false, error: err.message };
  }
}

function cleanupInstanceSocket(inst) {
  if (inst.reconnectTimer) {
    clearTimeout(inst.reconnectTimer);
    inst.reconnectTimer = null;
  }
  if (inst.sock) {
    try {
      inst.sock.ev.removeAllListeners('connection.update');
      inst.sock.ev.removeAllListeners('creds.update');
      inst.sock.ev.removeAllListeners('messages.upsert');
      inst.sock.ws?.close();
    } catch {
      // ignore cleanup errors
    }
    inst.sock = null;
  }
}

function serializeInstance(inst) {
  return {
    instanceName: inst.instanceId,
    instanceId: inst.instanceId,
    slotNumber: inst.slotNumber,
    status: inst.state,
    state: inst.state,
    owner: inst.connectedPhone,
    connectedPhone: inst.connectedPhone,
    hasQr: Boolean(inst.qrBase64),
    qrBase64: inst.qrBase64,
    qrUpdatedAt: inst.qrUpdatedAt,
    hasSavedSession: hasRegisteredSession(inst.authDir),
    lastError: inst.lastError,
    serverUrl: `http://127.0.0.1:${EVOLUTION_PORT}`
  };
}

async function waitForQrOrOpen(inst, maxWaitMs = 5500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (inst.state === 'open' || inst.qrBase64 || (inst.state === 'close' && !inst.isInitializing)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function initBaileysInstance(rawInstanceId, forceNew = false) {
  const instanceId = resolveInstanceId(rawInstanceId);
  const inst = instances.get(instanceId);
  if (!inst || inst.isInitializing) return;
  inst.isInitializing = true;

  try {
    cleanupInstanceSocket(inst);

    if (forceNew && fs.existsSync(inst.authDir)) {
      fs.rmSync(inst.authDir, { recursive: true, force: true });
      inst.qrRaw = null;
      inst.qrBase64 = null;
      inst.qrUpdatedAt = null;
      inst.connectedPhone = null;
      inst.lastError = null;
    }
    if (!fs.existsSync(inst.authDir)) {
      fs.mkdirSync(inst.authDir, { recursive: true });
    }

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const {
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      DisconnectReason,
      Browsers
    } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(inst.authDir);
    let version = [2, 3000, 1019707846];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest && latest.version) version = latest.version;
    } catch {
      // Fallback to pinned recent version
    }

    inst.state = 'connecting';
    inst.lastError = null;
    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers ? Browsers.ubuntu(`Chrome-${inst.instanceId}`) : ['Ubuntu', 'Chrome', '128.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });
    inst.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      if (inst.sock !== sock) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        inst.qrRaw = qr;
        inst.qrBase64 = await QRCode.toDataURL(qr, { margin: 2, width: 300 });
        inst.qrUpdatedAt = new Date().toISOString();
        inst.state = 'qr_ready';
        inst.lastError = null;
        recordEvent('qr_updated', `Nuevo código QR generado para ${inst.instanceId}`, inst.instanceId);
      }

      if (connection === 'open') {
        inst.state = 'open';
        inst.qrRaw = null;
        inst.qrBase64 = null;
        inst.qrUpdatedAt = null;
        inst.lastError = null;
        inst.connectedPhone = sock?.user?.id || 'Conectado';
        recordEvent('connected', `WhatsApp vinculado en ${inst.instanceId} como ${inst.connectedPhone}`, inst.instanceId);
        console.log(`[Evolution:10001] ✅ [${inst.instanceId}] WhatsApp conectado (${inst.connectedPhone})`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || `Cerrado (${statusCode || 'unknown'})`;
        const isRegistered = hasRegisteredSession(inst.authDir);
        inst.sock = null;

        recordEvent('disconnected', `${errMsg} [code: ${statusCode}]`, inst.instanceId);
        console.log(`[Evolution:10001] [${inst.instanceId}] Conexión cerrada: ${errMsg} (code: ${statusCode}, registered: ${isRegistered})`);

        // Caso 1: Restart required tras emparejamiento QR (515) o reconexión de sesión ya registrada
        if (
          statusCode === DisconnectReason.restartRequired ||
          statusCode === 515 ||
          (isRegistered &&
            (statusCode === DisconnectReason.timedOut ||
              statusCode === DisconnectReason.connectionLost ||
              statusCode === DisconnectReason.connectionClosed))
        ) {
          inst.state = 'connecting';
          inst.lastError = null;
          recordEvent('reconnecting', `Reconectando ${inst.instanceId} (code ${statusCode})...`, inst.instanceId);
          inst.reconnectTimer = setTimeout(() => {
            initBaileysInstance(inst.instanceId, false);
          }, 800);
          return;
        }

        // Caso 2: Conflicto temporal (440) en sesión registrada
        if (isRegistered && (statusCode === DisconnectReason.connectionReplaced || statusCode === 440)) {
          inst.state = 'connecting';
          inst.reconnectTimer = setTimeout(() => {
            initBaileysInstance(inst.instanceId, false);
          }, 2500);
          return;
        }

        // Caso 3: QR expirado sin escanear (408 / QR refs attempts ended) -> detener para no saturar
        if (!isRegistered && (statusCode === 408 || String(errMsg).toLowerCase().includes('qr refs'))) {
          inst.state = 'close';
          inst.qrRaw = null;
          inst.qrBase64 = null;
          inst.connectedPhone = null;
          inst.lastError = 'El código QR expiró sin escanearse. Haz clic en Generar QR para intentar de nuevo.';
          if (fs.existsSync(inst.authDir)) {
            fs.rmSync(inst.authDir, { recursive: true, force: true });
          }
          recordEvent('qr_expired', `QR expirado en ${inst.instanceId}`, inst.instanceId);
          return;
        }

        // Caso 4: Sesión cerrada desde el teléfono (401) o credenciales inválidas -> limpiar y esperar nueva acción
        inst.state = 'close';
        inst.qrRaw = null;
        inst.qrBase64 = null;
        inst.connectedPhone = null;
        inst.lastError = errMsg;
        if (fs.existsSync(inst.authDir)) {
          fs.rmSync(inst.authDir, { recursive: true, force: true });
        }
        recordEvent('session_reset', `Sesión cerrada/reiniciada en ${inst.instanceId}`, inst.instanceId);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          msg.message.imageMessage?.caption ||
          '';

        if (!text.trim()) continue;

        const pushName = msg.pushName || remoteJid.split('@')[0];
        recordEvent('message_in', `[${inst.instanceId}] De ${pushName} (${remoteJid}): ${text}`, inst.instanceId);

        const webhookResponse = await forwardToMainWebhook({
          event: 'messages.upsert',
          instance: inst.instanceId,
          data: {
            key: msg.key,
            pushName,
            message: { conversation: text }
          }
        });

        if (webhookResponse && webhookResponse.reply && inst.sock && inst.state === 'open') {
          await inst.sock.sendMessage(remoteJid, { text: webhookResponse.reply });
          recordEvent('message_out', `[${inst.instanceId}] Para ${remoteJid}: ${webhookResponse.reply.slice(0, 120)}...`, inst.instanceId);
        }
      }
    });
  } catch (err) {
    inst.lastError = err.message;
    inst.state = 'close';
    inst.sock = null;
    recordEvent('error', `[${inst.instanceId}] ${err.message}`, inst.instanceId);
  } finally {
    inst.isInitializing = false;
  }
}

function startEvolutionServer() {
  migrateLegacyRootSession();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.get('/', (req, res) => {
    const primary = instances.get('servibot-01');
    const summaryList = INSTANCE_IDS.map((id) => serializeInstance(instances.get(id)));
    res.json({
      status: 200,
      service: 'Servi-Bot Evolution API Multi-Instance Engine (10 Instancias Baileys)',
      port: EVOLUTION_PORT,
      instanceCount: INSTANCE_IDS.length,
      instance: primary.instanceId,
      connectionState: primary.state,
      connectedPhone: primary.connectedPhone,
      hasQr: Boolean(primary.qrBase64),
      instances: summaryList,
      webhookTarget: MAIN_SERVER_WEBHOOK,
      recentEvents: recentEvents.slice(0, 20)
    });
  });

  app.get('/instance/fetchInstances', (req, res) => {
    const list = INSTANCE_IDS.map((id) => ({
      instance: serializeInstance(instances.get(id))
    }));
    res.json(list);
  });

  app.get('/instance/connectionState/:instance', (req, res) => {
    const instanceId = resolveInstanceId(req.params.instance);
    const inst = instances.get(instanceId);
    res.json({
      instance: serializeInstance(inst)
    });
  });

  async function handleConnectOrQr(req, res) {
    const instanceId = resolveInstanceId(req.params.instance);
    const inst = instances.get(instanceId);

    if (inst.state !== 'open' && !inst.sock && !inst.isInitializing) {
      initBaileysInstance(instanceId, false);
    }

    if (inst.state !== 'open' && !inst.qrBase64) {
      await waitForQrOrOpen(inst, 5500);
    }

    res.json({
      ok: true,
      instance: inst.instanceId,
      slotNumber: inst.slotNumber,
      state: inst.state,
      connectedPhone: inst.connectedPhone,
      base64: inst.qrBase64,
      qrBase64: inst.qrBase64,
      code: inst.qrRaw,
      qrUpdatedAt: inst.qrUpdatedAt,
      lastError: inst.lastError
    });
  }

  app.get('/instance/connect/:instance', handleConnectOrQr);
  app.get('/instance/qr/:instance', handleConnectOrQr);

  app.post('/instance/create', async (req, res) => {
    const instanceId = resolveInstanceId(req.body?.instanceName);
    const inst = instances.get(instanceId);
    if (inst.state !== 'open' && !inst.sock && !inst.isInitializing) {
      initBaileysInstance(instanceId, false);
      await waitForQrOrOpen(inst, 5500);
    }
    res.json({
      instance: serializeInstance(inst),
      qrcode: {
        base64: inst.qrBase64,
        code: inst.qrRaw
      }
    });
  });

  async function handleLogoutInstance(req, res) {
    try {
      const instanceId = resolveInstanceId(req.params.instance);
      const inst = instances.get(instanceId);

      if (inst.sock) {
        try {
          await inst.sock.logout();
        } catch {
          // ignore logout errors on closing socket
        }
      }

      cleanupInstanceSocket(inst);
      if (fs.existsSync(inst.authDir)) {
        fs.rmSync(inst.authDir, { recursive: true, force: true });
      }
      inst.state = 'close';
      inst.qrBase64 = null;
      inst.qrRaw = null;
      inst.qrUpdatedAt = null;
      inst.connectedPhone = null;
      inst.lastError = null;

      recordEvent('logout', `Sesión WhatsApp reiniciada en ${instanceId}`, instanceId);
      initBaileysInstance(instanceId, true);
      await waitForQrOrOpen(inst, 5500);

      res.json({
        ok: true,
        instance: inst.instanceId,
        state: inst.state,
        base64: inst.qrBase64,
        qrBase64: inst.qrBase64,
        lastError: inst.lastError
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }

  app.delete('/instance/logout/:instance', handleLogoutInstance);
  app.post('/instance/logout/:instance', handleLogoutInstance);

  app.post('/message/sendText/:instance', async (req, res) => {
    const instanceId = resolveInstanceId(req.params.instance);
    const inst = instances.get(instanceId);
    const { number, text } = req.body || {};
    if (!number || !text) {
      return res.status(400).json({ ok: false, error: 'Se requiere number y text' });
    }
    const jid = number.includes('@') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`;

    if (inst.sock && inst.state === 'open') {
      try {
        const sent = await inst.sock.sendMessage(jid, { text });
        recordEvent('message_out', `[${instanceId}] Enviado a ${jid}: ${text.slice(0, 100)}`, instanceId);
        return res.json({ ok: true, instance: instanceId, key: sent?.key, status: 'SENT' });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    } else {
      recordEvent('message_out_simulated', `[${instanceId} sin WA activo] Para ${jid}: ${text.slice(0, 100)}`, instanceId);
      return res.json({
        ok: true,
        simulated: true,
        instance: instanceId,
        state: inst.state,
        message: `La instancia ${instanceId} aún no tiene QR escaneado; mensaje registrado en bitácora de simulación.`
      });
    }
  });

  app.post('/webhook/simulate', async (req, res) => {
    const {
      instance = 'servibot-01',
      phone = '5218112345678',
      name = 'Prospecto WhatsApp',
      text = 'Hola, ¿qué servicios de bots ofrecen?'
    } = req.body || {};
    const instanceId = resolveInstanceId(instance);
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    recordEvent('simulated_in', `[${instanceId}] Simulación WA de ${name} (${jid}): ${text}`, instanceId);

    const webhookResult = await forwardToMainWebhook({
      event: 'messages.upsert',
      instance: instanceId,
      simulated: true,
      data: {
        key: { remoteJid: jid, fromMe: false, id: `SIM-${Date.now()}` },
        pushName: name,
        message: { conversation: text }
      }
    });

    if (webhookResult?.reply) {
      recordEvent('simulated_out', `[${instanceId}] Respuesta IA para ${jid}: ${webhookResult.reply.slice(0, 120)}...`, instanceId);
    }

    res.json(webhookResult);
  });

  return new Promise((resolve) => {
    const server = app.listen(EVOLUTION_PORT, '0.0.0.0', () => {
      console.log(`[Evolution] Backend WhatsApp Multi-Instancia (10 slots Baileys) activo en http://127.0.0.1:${EVOLUTION_PORT}`);
      // Auto-conectar únicamente las instancias que ya tienen una sesión registrada en disco
      for (const instId of INSTANCE_IDS) {
        const inst = instances.get(instId);
        if (hasRegisteredSession(inst.authDir)) {
          console.log(`[Evolution:10001] Auto-iniciando sesión guardada para ${instId}`);
          initBaileysInstance(instId, false);
        }
      }
      resolve(server);
    });
  });
}

if (require.main === module) {
  startEvolutionServer();
}

module.exports = {
  EVOLUTION_PORT,
  INSTANCE_IDS,
  resolveInstanceId,
  startEvolutionServer
};
