const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { getSetting, setSetting } = require('./db');

let tunnelProcess = null;
let currentTunnelUrl = '';
let tunnelState = 'stopped'; // 'stopped' | 'starting' | 'running' | 'error'
let lastTunnelLog = '';

function getCloudflaredBinaryPath() {
  const winBin = path.join(__dirname, '..', 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe');
  if (fs.existsSync(winBin)) return winBin;
  const unixBin = path.join(__dirname, '..', 'node_modules', 'cloudflared', 'bin', 'cloudflared');
  if (fs.existsSync(unixBin)) return unixBin;
  return 'cloudflared';
}

function updatePublicFrontendTunnelJson(publicUrl) {
  try {
    const publicDir = path.join(__dirname, '..', 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    const cfgFile = path.join(publicDir, 'runtime-backend.json');
    fs.writeFileSync(
      cfgFile,
      JSON.stringify(
        {
          localUrl: 'http://localhost:10000',
          tunnelUrl: publicUrl || '',
          updatedAt: new Date().toISOString()
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (err) {
    console.warn('[CloudflareTunnel] No se pudo escribir runtime-backend.json:', err.message);
  }
}

async function startCloudflareTunnel(port = 10000) {
  const cfg = getSetting('tunnel_config', { enabled: true, mode: 'quick', tunnel_token: '', public_url: '' });
  if (cfg.enabled === false) {
    tunnelState = 'stopped';
    return { state: tunnelState, publicUrl: '' };
  }

  if (tunnelProcess) {
    try {
      tunnelProcess.kill();
    } catch {
      // ignore
    }
    tunnelProcess = null;
  }

  const binPath = getCloudflaredBinaryPath();
  tunnelState = 'starting';

  return new Promise((resolve) => {
    let resolved = false;
    const args = cfg.tunnel_token
      ? ['tunnel', 'run', '--token', cfg.tunnel_token]
      : ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];

    try {
      tunnelProcess = spawn(binPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      tunnelState = 'error';
      lastTunnelLog = err.message;
      return resolve({ state: tunnelState, error: err.message });
    }

    const handleOutput = (chunk) => {
      const text = chunk.toString('utf8');
      lastTunnelLog = text.slice(-400);
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && match[0]) {
        currentTunnelUrl = match[0];
        tunnelState = 'running';
        const updated = { ...cfg, public_url: currentTunnelUrl };
        setSetting('tunnel_config', updated);
        updatePublicFrontendTunnelJson(currentTunnelUrl);
        console.log(`[Cloudflare] Túnel HTTPS público activo: ${currentTunnelUrl} -> http://127.0.0.1:${port}`);
        if (!resolved) {
          resolved = true;
          resolve({ state: tunnelState, publicUrl: currentTunnelUrl });
        }
      } else if (cfg.tunnel_token && /Registered tunnel connection/i.test(text)) {
        tunnelState = 'running';
        if (cfg.public_url) {
          currentTunnelUrl = cfg.public_url;
          updatePublicFrontendTunnelJson(currentTunnelUrl);
        }
        if (!resolved) {
          resolved = true;
          resolve({ state: tunnelState, publicUrl: currentTunnelUrl });
        }
      }
    };

    tunnelProcess.stdout.on('data', handleOutput);
    tunnelProcess.stderr.on('data', handleOutput);

    tunnelProcess.on('exit', (code) => {
      tunnelState = 'stopped';
      lastTunnelLog = `Proceso cloudflared finalizó (${code})`;
      if (!resolved) {
        resolved = true;
        resolve({ state: tunnelState, publicUrl: currentTunnelUrl });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ state: tunnelState, publicUrl: currentTunnelUrl });
      }
    }, 9000);
  });
}

function getTunnelStatus() {
  const cfg = getSetting('tunnel_config', {});
  return {
    state: tunnelState,
    publicUrl: currentTunnelUrl || cfg.public_url || '',
    mode: cfg.tunnel_token ? 'named_token' : 'quick_trycloudflare',
    hasToken: Boolean(cfg.tunnel_token),
    lastLog: lastTunnelLog
  };
}

module.exports = {
  startCloudflareTunnel,
  getTunnelStatus,
  updatePublicFrontendTunnelJson
};
