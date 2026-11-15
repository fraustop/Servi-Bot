const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OLLAMA_PORT = Number(process.env.OLLAMA_PORT || 10002);
const WORKER_PORT = Number(process.env.WORKER_PORT || 10003);
const DEFAULT_OLLAMA_PORT = 11434;
const DEFAULT_BEDROCK_MODEL = process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-micro-v1:0';

let ollamaStatus = {
  port: WORKER_PORT,
  worker_port: WORKER_PORT,
  mode: 'initializing',
  provider: 'bedrock',
  model: DEFAULT_BEDROCK_MODEL,
  online: false,
  available_models: []
};

function resolvePythonExecutable() {
  const rootDir = path.join(__dirname, '..');
  const winVenv = path.join(rootDir, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(winVenv)) return winVenv;
  const posixVenv = path.join(rootDir, '.venv', 'bin', 'python');
  if (fs.existsSync(posixVenv)) return posixVenv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function buildWorkerEnv() {
  const env = {
    ...process.env,
    AWS_REGION: process.env.AWS_REGION || 'us-east-2',
    BEDROCK_MODEL_ID: process.env.BEDROCK_MODEL_ID || DEFAULT_BEDROCK_MODEL,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1'
  };
  if (!env.AWS_PROFILE) {
    try {
      const awsCfgPath = path.join(os.homedir(), '.aws', 'config');
      if (fs.existsSync(awsCfgPath)) {
        const cfgText = fs.readFileSync(awsCfgPath, 'utf8');
        if (cfgText.includes('[profile Server-Bot]')) {
          env.AWS_PROFILE = 'Server-Bot';
        }
      }
    } catch {
      // Ignore if ~/.aws/config is unreadable; EC2 uses instance profile
    }
  }
  return env;
}

function checkLocalJson(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, { timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve({ ok: true, data: JSON.parse(body) });
          } catch {
            resolve({ ok: true, data: {} });
          }
        } else {
          resolve({ ok: false, data: {} });
        }
      });
    });
    req.on('error', () => resolve({ ok: false, data: {} }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, data: {} });
    });
  });
}

async function checkPortUrl(port) {
  const res = await checkLocalJson(port, '/api/tags');
  return {
    ok: res.ok,
    models: Array.isArray(res.data?.models) ? res.data.models.map((m) => m.name) : []
  };
}

async function ensureAsyncWorkerOnPort10003() {
  const existing = await checkLocalJson(WORKER_PORT, '/health');
  if (existing.ok && existing.data?.ok) {
    return existing.data;
  }

  const pythonBin = resolvePythonExecutable();
  const scriptPath = path.join(__dirname, '..', 'python_workers', 'sales_agent.py');
  console.log(`[SalesWorker] Iniciando worker asíncrono Bedrock en puerto ${WORKER_PORT} (${pythonBin})...`);

  const child = spawn(pythonBin, [scriptPath, '--serve', String(WORKER_PORT)], {
    env: buildWorkerEnv(),
    stdio: 'ignore',
    detached: true,
    windowsHide: true
  });
  child.unref();

  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 400));
    const check = await checkLocalJson(WORKER_PORT, '/health');
    if (check.ok && check.data?.ok) {
      console.log(`[SalesWorker] Activo en http://127.0.0.1:${WORKER_PORT} (${check.data.model} @ ${check.data.region})`);
      return check.data;
    }
  }

  console.warn(`[SalesWorker] No respondió en puerto ${WORKER_PORT}; se usará respaldo local si está disponible.`);
  return null;
}

async function ensureOllamaOnPort10002() {
  // 1. Priorizar worker asíncrono persistente con Amazon Bedrock en puerto 10003
  const workerHealth = await ensureAsyncWorkerOnPort10003();
  if (workerHealth) {
    const modelName = workerHealth.model || DEFAULT_BEDROCK_MODEL;
    ollamaStatus = {
      port: WORKER_PORT,
      worker_port: WORKER_PORT,
      mode: 'bedrock-async-10003',
      provider: 'bedrock',
      region: workerHealth.region || 'us-east-2',
      model: modelName,
      online: true,
      available_models: [modelName]
    };
    return ollamaStatus;
  }

  // 2. Respaldo: verificar si el puerto 10002 ya está sirviendo Ollama
  const existing10002 = await checkPortUrl(OLLAMA_PORT);
  if (existing10002.ok) {
    ollamaStatus = {
      port: OLLAMA_PORT,
      worker_port: WORKER_PORT,
      mode: 'native-10002',
      provider: 'ollama',
      model: existing10002.models[0] || 'llama3.2:3b',
      online: true,
      available_models: existing10002.models
    };
    console.log(`[Ollama] Activo directamente en puerto ${OLLAMA_PORT}. Modelos:`, existing10002.models);
    return ollamaStatus;
  }

  // 3. Respaldo: iniciar 'ollama serve' local si está instalado y disponible
  const system11434 = await checkPortUrl(DEFAULT_OLLAMA_PORT);
  if (!system11434.ok) {
    console.log(`[Ollama] Iniciando proceso 'ollama serve' en puerto ${OLLAMA_PORT}...`);
    const child = spawn('ollama', ['serve'], {
      env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}` },
      stdio: 'ignore',
      detached: true
    });
    child.on('error', (err) => {
      console.warn('[Ollama] Binario ollama no disponible como respaldo:', err.message);
    });
    child.unref();

    await new Promise((r) => setTimeout(r, 2500));
    const started = await checkPortUrl(OLLAMA_PORT);
    if (started.ok) {
      ollamaStatus = {
        port: OLLAMA_PORT,
        worker_port: WORKER_PORT,
        mode: 'spawned-10002',
        provider: 'ollama',
        model: started.models[0] || 'llama3.2:3b',
        online: true,
        available_models: started.models
      };
      console.log(`[Ollama] Levantado en puerto ${OLLAMA_PORT}. Modelos:`, started.models);
      return ollamaStatus;
    }
  }

  // 4. Bridge port 10002 -> 11434
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
      console.log(`[Ollama] Servicio Ollama escuchando en puerto ${OLLAMA_PORT}`);
      resolve();
    });
  });

  const verify = await checkPortUrl(OLLAMA_PORT);
  ollamaStatus = {
    port: OLLAMA_PORT,
    worker_port: WORKER_PORT,
    mode: 'bridge-10002',
    provider: 'ollama',
    model: verify.models[0] || 'llama3.2:3b',
    online: verify.ok,
    available_models: verify.models
  };
  return ollamaStatus;
}

async function getOllamaStatus() {
  const workerHealth = await checkLocalJson(WORKER_PORT, '/health');
  if (workerHealth.ok && workerHealth.data?.ok) {
    const modelName = workerHealth.data.model || DEFAULT_BEDROCK_MODEL;
    ollamaStatus = {
      port: WORKER_PORT,
      worker_port: WORKER_PORT,
      mode: 'bedrock-async-10003',
      provider: 'bedrock',
      region: workerHealth.data.region || 'us-east-2',
      model: modelName,
      online: true,
      available_models: [modelName]
    };
    return ollamaStatus;
  }

  const verify = await checkPortUrl(OLLAMA_PORT);
  ollamaStatus.online = verify.ok;
  if (verify.models.length > 0) {
    ollamaStatus.available_models = verify.models;
  }
  return ollamaStatus;
}

module.exports = {
  OLLAMA_PORT,
  WORKER_PORT,
  resolvePythonExecutable,
  buildWorkerEnv,
  ensureAsyncWorkerOnPort10003,
  ensureOllamaOnPort10002,
  getOllamaStatus
};
