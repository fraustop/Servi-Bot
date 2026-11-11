const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { getSetting } = require('../db');

let pollTimer = null;
let isPolling = false;
let emailLogs = [];

function logEmailEvent(type, detail) {
  emailLogs.unshift({
    timestamp: new Date().toISOString(),
    type,
    detail
  });
  if (emailLogs.length > 30) emailLogs.pop();
}

async function sendSmtpReply(cfg, { to, subject, text, inReplyTo }) {
  const transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: Number(cfg.smtp_port || 465),
    secure: Boolean(cfg.smtp_secure),
    auth: {
      user: cfg.user,
      pass: cfg.pass
    }
  });

  const cleanSubject = subject?.toLowerCase().startsWith('re:') ? subject : `Re: ${subject || 'Consulta Servi-Bot'}`;

  const htmlBody = `
    <div style="font-family: system-ui, -apple-system, sans-serif; color: #0f172a; max-width: 620px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
      <div style="background: linear-gradient(135deg, #0f172a, #1e3a8a); color: #ffffff; padding: 18px 24px;">
        <strong style="font-size: 18px;">🤖 ${cfg.from_name || 'Servi-Bot Atención Automática'}</strong>
      </div>
      <div style="padding: 24px; line-height: 1.6; white-space: pre-wrap;">${text}</div>
      <div style="background: #f8fafc; padding: 12px 24px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0;">
        Respuesta generada automáticamente por Servi-Bot (IA Local Ollama + Python).
      </div>
    </div>
  `;

  const info = await transporter.sendMail({
    from: `"${cfg.from_name || 'Servi-Bot'}" <${cfg.user}>`,
    to,
    subject: cleanSubject,
    text,
    html: htmlBody,
    ...(inReplyTo ? { inReplyTo, references: [inReplyTo] } : {})
  });

  logEmailEvent('smtp_sent', `Correo enviado a ${to} (${info.messageId})`);
  return info;
}

async function pollImapOnce(runPythonSalesAgent) {
  if (isPolling) return;
  const cfg = getSetting('email_config', {});
  const botCfg = getSetting('bot_config', {});

  if (!cfg.enabled || !cfg.user || !cfg.pass || !cfg.imap_host || botCfg.auto_reply_email === false) {
    return;
  }

  isPolling = true;
  const client = new ImapFlow({
    host: cfg.imap_host,
    port: Number(cfg.imap_port || 993),
    secure: Boolean(cfg.imap_secure),
    auth: {
      user: cfg.user,
      pass: cfg.pass
    },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseenUids = await client.search({ seen: false });
      for (const uid of unseenUids.slice(-5)) {
        const msg = await client.fetchOne(uid, { source: true, envelope: true });
        if (!msg || !msg.source) continue;

        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from?.value?.[0]?.address || '';
        const fromName = parsed.from?.value?.[0]?.name || fromAddr;
        const subject = parsed.subject || 'Sin asunto';
        const textBody = (parsed.text || '').trim();

        // Skip self emails or no-reply automated emails
        if (!fromAddr || fromAddr.toLowerCase() === cfg.user.toLowerCase() || /no-?reply|mailer-daemon/i.test(fromAddr)) {
          await client.messageFlagsAdd(uid, ['\\Seen']);
          continue;
        }

        logEmailEvent('imap_received', `De ${fromName} <${fromAddr}>: ${subject}`);

        const fullPromptText = `Asunto del correo: ${subject}\nMensaje: ${textBody || subject}`;
        const agentResponse = await runPythonSalesAgent({
          channel: 'email',
          sender_id: fromAddr,
          sender_name: fromName,
          message: fullPromptText
        });

        if (agentResponse && agentResponse.reply) {
          await sendSmtpReply(cfg, {
            to: fromAddr,
            subject,
            text: agentResponse.reply,
            inReplyTo: parsed.messageId
          });
        }

        await client.messageFlagsAdd(uid, ['\\Seen']);
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    logEmailEvent('imap_error', err.message);
  } finally {
    isPolling = false;
  }
}

function startEmailPolling(runPythonSalesAgent) {
  if (pollTimer) clearInterval(pollTimer);
  const cfg = getSetting('email_config', {});
  const intervalMs = Math.max(20, Number(cfg.poll_interval_sec || 45)) * 1000;

  pollTimer = setInterval(() => {
    pollImapOnce(runPythonSalesAgent);
  }, intervalMs);

  logEmailEvent('worker_ready', `Monitor IMAP/SMTP activo (intervalo: ${intervalMs / 1000}s)`);
}

async function simulateIncomingEmail(runPythonSalesAgent, { fromEmail, fromName, subject, body }) {
  const emailAddr = fromEmail || 'cliente@empresa.com.mx';
  const name = fromName || 'Director Comercial';
  const subj = subject || 'Cotización de Bots Autónomos para mi empresa';
  const msgBody = body || 'Hola, vi su página de Servi-Bot y me interesa conocer el precio del servicio de Bots Autónomos y Catálogo Dinámico.';

  logEmailEvent('simulated_in', `De ${name} <${emailAddr}> | Asunto: ${subj}`);

  const agentResponse = await runPythonSalesAgent({
    channel: 'email',
    sender_id: emailAddr,
    sender_name: name,
    message: `Asunto: ${subj}\nContenido del correo: ${msgBody}`
  });

  // If SMTP is enabled and configured, also attempt real send if requested
  const cfg = getSetting('email_config', {});
  let smtpSent = false;
  if (cfg.enabled && cfg.user && cfg.pass && cfg.smtp_host && agentResponse?.reply) {
    try {
      await sendSmtpReply(cfg, {
        to: emailAddr,
        subject: subj,
        text: agentResponse.reply
      });
      smtpSent = true;
    } catch (err) {
      logEmailEvent('smtp_error', err.message);
    }
  } else {
    logEmailEvent('simulated_out', `Respuesta IA por Correo para <${emailAddr}>: ${(agentResponse?.reply || '').slice(0, 120)}...`);
  }

  return {
    ...agentResponse,
    smtpSent
  };
}

function getEmailWorkerStatus() {
  const cfg = getSetting('email_config', {});
  return {
    enabled: Boolean(cfg.enabled),
    configured: Boolean(cfg.user && cfg.pass && cfg.imap_host && cfg.smtp_host),
    imap_host: cfg.imap_host,
    smtp_host: cfg.smtp_host,
    user: cfg.user ? `${cfg.user.slice(0, 3)}***@${cfg.user.split('@')[1] || ''}` : '',
    recentLogs: emailLogs.slice(0, 15)
  };
}

module.exports = {
  startEmailPolling,
  pollImapOnce,
  simulateIncomingEmail,
  getEmailWorkerStatus,
  logEmailEvent
};
