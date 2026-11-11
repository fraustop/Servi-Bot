const crypto = require('node:crypto');
const { getSetting } = require('../db');

let teamsLogs = [];

function logTeamsEvent(type, detail) {
  teamsLogs.unshift({
    timestamp: new Date().toISOString(),
    type,
    detail
  });
  if (teamsLogs.length > 30) teamsLogs.pop();
}

function stripTeamsMentions(text = '') {
  return text.replace(/<at>.*?<\/at>/gi, '').replace(/<[^>]+>/g, '').trim();
}

function verifyTeamsHmac(rawBody, authHeader, secretBase64) {
  if (!secretBase64 || !authHeader) return true;
  try {
    const providedSig = authHeader.replace(/^HMAC\s+/i, '').trim();
    const bufSecret = Buffer.from(secretBase64, 'base64');
    const computed = crypto.createHmac('sha256', bufSecret).update(rawBody, 'utf8').digest('base64');
    return computed === providedSig;
  } catch {
    return false;
  }
}

async function notifyTeamsIncomingWebhook(orderOrMessage) {
  const cfg = getSetting('teams_config', {});
  if (!cfg.incoming_webhook_url) return { sent: false };

  try {
    const payload = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: '2563EB',
      summary: 'Notificación de Servi-Bot',
      sections: [
        {
          activityTitle: `🤖 **${cfg.bot_display_name || 'Servi-Bot Teams'}**`,
          activitySubtitle: new Date().toLocaleString('es-MX'),
          text: typeof orderOrMessage === 'string' ? orderOrMessage : JSON.stringify(orderOrMessage)
        }
      ]
    };

    const res = await fetch(cfg.incoming_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    logTeamsEvent('incoming_webhook_post', `Notificación enviada a Teams (HTTP ${res.status})`);
    return { sent: res.ok, status: res.status };
  } catch (err) {
    logTeamsEvent('webhook_error', err.message);
    return { sent: false, error: err.message };
  }
}

async function handleTeamsWebhook(req, res, runPythonSalesAgent) {
  const cfg = getSetting('teams_config', {});
  const botCfg = getSetting('bot_config', {});

  if (cfg.enabled === false || botCfg.auto_reply_teams === false) {
    return res.json({ type: 'message', text: 'El canal de Microsoft Teams está pausado temporalmente en Servi-Bot.' });
  }

  const body = req.body || {};
  const rawText = stripTeamsMentions(body.text || body.message || '');
  const senderId = body.from?.id || body.from?.aadObjectId || body.sender_id || 'teams-user-01';
  const senderName = body.from?.name || body.sender_name || 'Usuario Microsoft Teams';

  if (!rawText) {
    return res.json({
      type: 'message',
      text: '¡Hola! Soy **Servi-Bot** en Microsoft Teams. Pregúntame por nuestros **Bots Autónomos** o **Interfaz de Catálogo Dinámico**.'
    });
  }

  logTeamsEvent('teams_in', `De ${senderName} (${senderId}): ${rawText}`);

  const agentResult = await runPythonSalesAgent({
    channel: 'teams',
    sender_id: senderId,
    sender_name: senderName,
    message: rawText
  });

  const replyText = agentResult?.reply || 'Gracias por escribirnos por Microsoft Teams.';
  logTeamsEvent('teams_out', `Respuesta IA para ${senderName}: ${replyText.slice(0, 120)}...`);

  if (agentResult?.order_created && agentResult.order && cfg.incoming_webhook_url) {
    await notifyTeamsIncomingWebhook(
      `✅ **Nuevo Pedido Cerrado (${agentResult.order.order_code})**\n` +
        `- Cliente: ${agentResult.order.customer_name}\n` +
        `- Total: $${agentResult.order.total_amount} ${agentResult.order.currency}`
    );
  }

  // Standard Microsoft Teams Outgoing Webhook / Bot Framework response format
  return res.json({
    type: 'message',
    text: replyText,
    servibot: agentResult
  });
}

function getTeamsChannelStatus() {
  const cfg = getSetting('teams_config', {});
  return {
    enabled: cfg.enabled !== false,
    bot_display_name: cfg.bot_display_name || 'Servi-Bot Teams',
    has_incoming_webhook: Boolean(cfg.incoming_webhook_url),
    webhook_endpoint: '/api/channels/teams/webhook',
    recentLogs: teamsLogs.slice(0, 15)
  };
}

module.exports = {
  handleTeamsWebhook,
  notifyTeamsIncomingWebhook,
  getTeamsChannelStatus,
  logTeamsEvent
};
