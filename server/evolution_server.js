const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const pino = require('pino');
const QRCode = require('qrcode');

const EVOLUTION_PORT = Number(process.env.EVOLUTION_PORT || 10001);
const MAIN_SERVER_WEBHOOK = process.env.MAIN_WEBHOOK_URL || 'http://127.0.0.1:10000/api/webhooks/evolution';
const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');

let sock = null;
let connectionState = 'close'; // 'close' | 'connecting' | 'qr_ready' | 'open'
let latestQrRaw = null;
let latestQrBase64 = null;
let connectedPhone = null;
let lastError = null;
let isInitializing = false;
let reconnectTimer = null;
let recentEvents = [];

function recordEvent(type, detail) {
  recentEvents.unshift({
    timestamp: new Date().toISOString(),
    type,
    detail
  });
  if (recentEvents.length > 40) recentEvents.pop();
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

function cleanupExistingSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ws?.close();
    } catch {
      // ignore cleanup errors
    }
    sock = null;
  }
}

async function initBaileysInstance(forceNew = false) {
  if (isInitializing) return;
  isInitializing = true;

  try {
    cleanupExistingSocket();

    if (forceNew && fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      latestQrRaw = null;
      latestQrBase64 = null;
      connectedPhone = null;
    }
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const {
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      DisconnectReason,
      Browsers
    } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1019707846];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest && latest.version) version = latest.version;
    } catch {
      // Fallback to recent version
    }

    connectionState = 'connecting';
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '128.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQrRaw = qr;
        latestQrBase64 = await QRCode.toDataURL(qr, { margin: 2, width: 300 });
        connectionState = 'qr_ready';
        recordEvent('qr_updated', 'Nuevo código QR generado para vincular WhatsApp');
      }

      if (connection === 'open') {
        connectionState = 'open';
        latestQrRaw = null;
        latestQrBase64 = null;
        lastError = null;
        connectedPhone = sock?.user?.id || 'Conectado';
        recordEvent('connected', `WhatsApp vinculado como ${connectedPhone}`);
        console.log(`[Evolution:10001] ✅ WhatsApp conectado exitosamente (${connectedPhone})`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || `Cerrado (${statusCode || 'unknown'})`;
        lastError = errMsg;
        recordEvent('disconnected', `${errMsg} [code: ${statusCode}]`);
        console.log(`[Evolution:10001] Conexión cerrada: ${errMsg} (code: ${statusCode})`);

        // Caso 1: 515 Stream Errored (restart required) justo después de escanear el QR
        // o desconexiones temporales de red -> Reconectar de inmediato conservando creds.json
        if (
          statusCode === DisconnectReason.restartRequired ||
          statusCode === 515 ||
          statusCode === DisconnectReason.timedOut ||
          statusCode === DisconnectReason.connectionLost ||
          statusCode === DisconnectReason.connectionClosed
        ) {
          connectionState = 'connecting';
          recordEvent('reconnecting', `Completando emparejamiento / reconexión automática (code ${statusCode})...`);
          reconnectTimer = setTimeout(() => {
            initBaileysInstance(false);
          }, 600);
          return;
        }

        // Caso 2: 440 Conflict (otra instancia cerró la sesión) -> esperar un poco y reconectar si hay credenciales
        if (statusCode === DisconnectReason.connectionReplaced || statusCode === 440) {
          connectionState = 'connecting';
          reconnectTimer = setTimeout(() => {
            initBaileysInstance(false);
          }, 2500);
          return;
        }

        // Caso 3: Sesión cerrada desde el teléfono (401 loggedOut) o credenciales corruptas/expiradas (403, 405, 500)
        // Limpiar auth_info_baileys y generar un QR nuevo automáticamente
        connectionState = 'close';
        latestQrRaw = null;
        latestQrBase64 = null;
        connectedPhone = null;
        recordEvent('session_reset', 'Credenciales expiradas o sesión cerrada; generando nuevo código QR limpio...');
        reconnectTimer = setTimeout(() => {
          initBaileysInstance(true);
        }, 1000);
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
        recordEvent('message_in', `De ${pushName} (${remoteJid}): ${text}`);

        const webhookResponse = await forwardToMainWebhook({
          event: 'messages.upsert',
          instance: 'servibot-main',
          data: {
            key: msg.key,
            pushName,
            message: { conversation: text }
          }
        });

        if (webhookResponse && webhookResponse.reply && sock && connectionState === 'open') {
          await sock.sendMessage(remoteJid, { text: webhookResponse.reply });
          recordEvent('message_out', `Para ${remoteJid}: ${webhookResponse.reply.slice(0, 120)}...`);
        }
      }
    });
  } catch (err) {
    lastError = err.message;
    connectionState = 'close';
    recordEvent('error', err.message);
  } finally {
    isInitializing = false;
  }
}

function startEvolutionServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.get('/', (req, res) => {
    res.json({
      status: 200,
      service: 'Servi-Bot Evolution API Engine (Free / No-Token Baileys)',
      port: EVOLUTION_PORT,
      instance: 'servibot-main',
      connectionState,
      connectedPhone,
      hasQr: Boolean(latestQrBase64),
      webhookTarget: MAIN_SERVER_WEBHOOK,
      recentEvents: recentEvents.slice(0, 15)
    });
  });

  app.get('/instance/fetchInstances', (req, res) => {
    res.json([
      {
        instance: {
          instanceName: 'servibot-main',
          status: connectionState,
          owner: connectedPhone,
          serverUrl: `http://127.0.0.1:${EVOLUTION_PORT}`
        }
      }
    ]);
  });

  app.get('/instance/connectionState/:instance', (req, res) => {
    res.json({
      instance: {
        instanceName: req.params.instance || 'servibot-main',
        state: connectionState,
        connectedPhone,
        hasQr: Boolean(latestQrBase64),
        qrBase64: latestQrBase64,
        lastError
      }
    });
  });

  app.get('/instance/connect/:instance', async (req, res) => {
    // Solo iniciar si no hay socket activo ni inicializando
    if (!sock && connectionState === 'close' && !isInitializing) {
      initBaileysInstance(false);
      await new Promise((r) => setTimeout(r, 1200));
    }
    res.json({
      instance: req.params.instance || 'servibot-main',
      state: connectionState,
      connectedPhone,
      base64: latestQrBase64,
      code: latestQrRaw,
      lastError
    });
  });

  app.post('/instance/create', async (req, res) => {
    if (!sock && !isInitializing) {
      await initBaileysInstance(false);
    }
    res.json({
      instance: {
        instanceName: req.body?.instanceName || 'servibot-main',
        status: connectionState
      },
      qrcode: {
        base64: latestQrBase64,
        code: latestQrRaw
      }
    });
  });

  app.delete('/instance/logout/:instance', async (req, res) => {
    try {
      if (sock) {
        try {
          await sock.logout();
        } catch {
          // ignore
        }
      }
      cleanupExistingSocket();
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      }
      connectionState = 'close';
      latestQrBase64 = null;
      latestQrRaw = null;
      connectedPhone = null;
      recordEvent('logout', 'Sesión de WhatsApp reiniciada manualmente');
      initBaileysInstance(true);
      await new Promise((r) => setTimeout(r, 1500));
      res.json({ ok: true, state: connectionState, base64: latestQrBase64 });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/message/sendText/:instance', async (req, res) => {
    const { number, text } = req.body || {};
    if (!number || !text) {
      return res.status(400).json({ ok: false, error: 'Se requiere number y text' });
    }
    const jid = number.includes('@') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`;

    if (sock && connectionState === 'open') {
      try {
        const sent = await sock.sendMessage(jid, { text });
        recordEvent('message_out', `Enviado a ${jid}: ${text.slice(0, 100)}`);
        return res.json({ ok: true, key: sent?.key, status: 'SENT' });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    } else {
      recordEvent('message_out_simulated', `[Simulado sin WA activo] Para ${jid}: ${text.slice(0, 100)}`);
      return res.json({
        ok: true,
        simulated: true,
        state: connectionState,
        message: 'WhatsApp aún no tiene QR escaneado; mensaje registrado en bitácora de simulación.'
      });
    }
  });

  app.post('/webhook/simulate', async (req, res) => {
    const { phone = '5218112345678', name = 'Prospecto WhatsApp', text = 'Hola, ¿qué servicios de bots ofrecen?' } = req.body || {};
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    recordEvent('simulated_in', `Simulación WA de ${name} (${jid}): ${text}`);

    const webhookResult = await forwardToMainWebhook({
      event: 'messages.upsert',
      instance: 'servibot-main',
      simulated: true,
      data: {
        key: { remoteJid: jid, fromMe: false, id: `SIM-${Date.now()}` },
        pushName: name,
        message: { conversation: text }
      }
    });

    if (webhookResult?.reply) {
      recordEvent('simulated_out', `Respuesta IA para ${jid}: ${webhookResult.reply.slice(0, 120)}...`);
    }

    res.json(webhookResult);
  });

  return new Promise((resolve) => {
    const server = app.listen(EVOLUTION_PORT, '0.0.0.0', () => {
      console.log(`[Evolution] Backend WhatsApp (Baileys sin tokens) activo en http://127.0.0.1:${EVOLUTION_PORT}`);
      initBaileysInstance(false);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startEvolutionServer();
}

module.exports = {
  EVOLUTION_PORT,
  startEvolutionServer
};
