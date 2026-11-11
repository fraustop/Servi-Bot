const http = require('node:http');
const { spawn } = require('node:child_process');

const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 10002);
const DEFAULT_OLLAMA_PORT = 11434;

let ollamaStatus = {
  port: OLLAMA_PORT,
  mode: 'initializing',
  model: 'llama3.2:3b',
  online: false,
  available_models: []
};

function checkPortUrl(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/tags`, { timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(body);
            resolve({ ok: true, models: (parsed.models || []).map((m) => m.name) });
          } catch {
            resolve({ ok: true, models: [] });
          }
        } else {
          resolve({ ok: false, models: [] });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, models: [] }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, models: [] });
    });
  });
}

async function ensureOllamaOnPort10002() {
  // 1. Check if port 10002 is already serving Ollama
  const existing10002 = await checkPortUrl(OLLAMA_PORT);
  if (existing10002.ok) {
    ollamaStatus = {
      port: OLLAMA_PORT,
      mode: 'native-10002',
      model: existing10002.models[0] || 'llama3.2:3b',
      online: true,
      available_models: existing10002.models
    };
    console.log(`[Ollama] Activo directamente en puerto ${OLLAMA_PORT}. Modelos:`, existing10002.models);
    return ollamaStatus;
  }

  // 2. Check if system Ollama is running on 11434; if not, start ollama serve on 10002
  const system11434 = await checkPortUrl(DEFAULT_OLLAMA_PORT);
  if (!system11434.ok) {
    console.log(`[Ollama] Iniciando proceso 'ollama serve' en puerto ${OLLAMA_PORT}...`);
    const child = spawn('ollama', ['serve'], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}` },
      stdio: 'ignore',
      detached: true
    });
    child.unref();

    // Wait a moment and re-check
    await new Promise((r) => setTimeout(r, 2500));
    const started = await checkPortUrl(OLLAMA_PORT);
    if (started.ok) {
      ollamaStatus = {
        port: OLLAMA_PORT,
        mode: 'spawned-10002',
        model: started.models[0] || 'llama3.2:3b',
        online: true,
        available_models: started.models
      };
      console.log(`[Ollama] Levantado en puerto ${OLLAMA_PORT}. Modelos:`, started.models);
      return ollamaStatus;
    }
  }

  // 3. Bridge port 10002 -> 11434 so Ollama is always accessible on 127.0.0.1:10002
  const proxyServer = http.createServer((clientReq, clientRes) => {
    const options = {
      hostname: '127.0.0.1',
      port: DEFAULT_OLLAMA_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: clientReq.headers
    };

    const proxyReq = http.request(options, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(clientRes, { end: true });
    });

    proxyReq.on('error', (err) => {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: `Ollama bridge error: ${err.message}` }));
    });

    clientReq.pipe(proxyReq, { end: true });
  });

  await new Promise((resolve) => {
    proxyServer.on('error', (err) => {
      console.warn(`[Ollama] Aviso en puerto ${OLLAMA_PORT}:`, err.message);
      resolve();
    });
    proxyServer.listen(OLLAMA_PORT, '0.0.0.0', () => {
      console.log(`[Ollama] Servicio Ollama escuchando en puerto ${OLLAMA_PORT} (conectado al motor local llama3.2:3b)`);
      resolve();
    });
  });

  const verify = await checkPortUrl(OLLAMA_PORT);
  ollamaStatus = {
    port: OLLAMA_PORT,
    mode: 'bridge-10002',
    model: verify.models[0] || 'llama3.2:3b',
    online: verify.ok,
    available_models: verify.models
  };
  return ollamaStatus;
}

async function getOllamaStatus() {
  const verify = await checkPortUrl(OLLAMA_PORT);
  ollamaStatus.online = verify.ok;
  if (verify.models.length > 0) {
    ollamaStatus.available_models = verify.models;
  }
  return ollamaStatus;
}

module.exports = {
  OLLAMA_PORT,
  ensureOllamaOnPort10002,
  getOllamaStatus
};
