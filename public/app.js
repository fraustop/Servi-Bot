import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js';

// Configuración del proyecto Firebase: servi-bot-cic (Servi-Bot)
const firebaseConfig = {
  projectId: 'servi-bot-cic',
  appId: '1:666075664290:web:857c096cc95e522f8bacfb',
  storageBucket: 'servi-bot-cic.firebasestorage.app',
  apiKey: 'AIzaSyCZm5qX98Y8ww4ksJWX-xQs6deaSQojhHk',
  authDomain: 'servi-bot-cic.firebaseapp.com',
  messagingSenderId: '666075664290'
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Feature-detect nativo de Popover API según modern-web-guidance `navbar`
if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {
    // El navegador continuará con la navegación estándar si no puede cargar el polyfill
  });
}

// Fallback para light-dismiss en <dialog closedby="any"> según modern-web-guidance `dialog`
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, dialog)) dialog.close();
    });
  }
}

let API_BASE = '';
let currentUser = null;
let activeView = 'public';
let activeAdminTab = 'tab-catalog';
let catalogCache = [];
let clientInstanceId = localStorage.getItem('servibot_client_instance_id') || '';
let activeChatInstanceId = clientInstanceId || 'servibot-01';
let provisionedInstance = null;
let wizardCurrentStep = 1;
let webSenderId = localStorage.getItem('servibot_sender_id') || `web-${Math.floor(10000 + Math.random() * 90000)}`;
localStorage.setItem('servibot_sender_id', webSenderId);

// ==================== CONEXIÓN CON BACKEND ====================
async function isBackendReachable(baseUrl, timeoutMs = 2200) {
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

async function resolveInitialApiBase() {
  if (location.port === '10000') {
    API_BASE = window.location.origin;
    syncApiOverrideInput();
    return;
  }

  // 1) Intentar backend local en la misma máquina
  if (await isBackendReachable('http://localhost:10000', 2000)) {
    API_BASE = 'http://localhost:10000';
    syncApiOverrideInput();
    return;
  }

  // 2) Intentar override manual guardado en este navegador si sigue activo
  const savedBase = (localStorage.getItem('servibot_api_base') || '').trim().replace(/\/+$/, '');
  if (savedBase) {
    if (await isBackendReachable(savedBase, 2500)) {
      API_BASE = savedBase;
      syncApiOverrideInput();
      return;
    }
    localStorage.removeItem('servibot_api_base');
  }

  // 3) Leer URL vigente del túnel Cloudflare publicada en Hosting
  try {
    const rt = await fetch('/runtime-backend.json', { cache: 'no-store' });
    if (rt.ok) {
      const cfg = await rt.json();
      if (cfg.tunnelUrl) {
        API_BASE = cfg.tunnelUrl.trim().replace(/\/+$/, '');
        syncApiOverrideInput();
        return;
      }
    }
  } catch {
    // ignorar error de runtime-backend.json
  }

  API_BASE = 'http://localhost:10000';
  syncApiOverrideInput();
}

function syncApiOverrideInput() {
  const input = document.getElementById('admin-api-override');
  if (input) input.value = API_BASE || window.location.origin;
}

function resolveAssetUrl(url) {
  if (!url) return '/assets/service-bots.svg';
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url;
  if (url.startsWith('/uploads/') && API_BASE) return `${API_BASE}${url}`;
  return url;
}

async function apiFetch(endpoint, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (currentUser) {
    try {
      const token = await currentUser.getIdToken();
      headers['Authorization'] = `Bearer ${token}`;
    } catch {
      // continuar si el endpoint es público
    }
  }
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: text || `Error HTTP ${res.status}` };
  }
}

// ==================== NAVBAR RESPONSIVA Y MODO DE ENCABEZADO ====================
let navbarObserverInitialized = false;

function isMenuPopoverOpen(siteMenu) {
  if (!siteMenu || !siteMenu.hasAttribute('popover')) return false;
  try {
    return siteMenu.matches(':popover-open') || siteMenu.classList.contains(':popover-open');
  } catch {
    return siteMenu.classList.contains(':popover-open');
  }
}

function closeMenuPopoverIfOpen() {
  const siteMenu = document.getElementById('site-menu');
  if (!siteMenu || !isMenuPopoverOpen(siteMenu)) return;
  try {
    siteMenu.hidePopover?.();
  } catch {
    // ignorar si el navegador no soporta hidePopover aún
  }
}

function updateNavbarLayout() {
  const siteHeader = document.getElementById('site-header');
  const headerInner = document.getElementById('header-inner');
  const siteMenu = document.getElementById('site-menu');
  if (!siteHeader || !headerInner || !siteMenu || siteHeader.classList.contains('hidden')) return;

  const wasOpen = isMenuPopoverOpen(siteMenu);
  if (wasOpen) closeMenuPopoverIfOpen();

  siteHeader.classList.add('is-measuring', 'is-wide');
  // Usar setAttribute/removeAttribute (no .popover IDL) según modern-web-guidance `navbar`
  siteMenu.removeAttribute('popover');

  const fitsInline = headerInner.scrollWidth <= headerInner.clientWidth;

  if (fitsInline) {
    siteHeader.classList.add('is-wide');
    siteMenu.removeAttribute('popover');
  } else {
    siteHeader.classList.remove('is-wide');
    siteMenu.setAttribute('popover', 'auto');
    if (wasOpen) {
      try {
        siteMenu.showPopover?.();
      } catch {
        // ignorar
      }
    }
  }

  requestAnimationFrame(() => {
    siteHeader.classList.remove('is-measuring');
  });
}

function initNavbarMeasurement() {
  if (navbarObserverInitialized) return;
  const siteHeader = document.getElementById('site-header');
  const siteMenu = document.getElementById('site-menu');
  if (!siteHeader || !siteMenu) return;

  navbarObserverInitialized = true;
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => updateNavbarLayout());
    ro.observe(siteHeader);
    ro.observe(siteMenu);
  }
  window.addEventListener('resize', updateNavbarLayout);
  if (document.fonts?.ready) {
    document.fonts.ready.then(updateNavbarLayout).catch(() => {});
  }
  updateNavbarLayout();
}

function hasAdminUrlParam(loc = window.location) {
  const params = new URLSearchParams(loc.search);
  if (params.has('admin')) {
    const val = (params.get('admin') || '').trim().toLowerCase();
    return val !== '0' && val !== 'false';
  }
  return loc.pathname === '/admin' || loc.hash === '#admin';
}

function syncUrlWithView(targetView) {
  const url = new URL(window.location.href);
  if (targetView === 'admin') {
    if (!hasAdminUrlParam()) {
      url.searchParams.set('admin', '');
      const searchStr = url.search.replace(/=(?=&|$)/g, '');
      window.history.pushState({ view: 'admin' }, '', `${url.pathname}${searchStr}${url.hash}`);
    }
  } else if (hasAdminUrlParam()) {
    url.searchParams.delete('admin');
    const cleanPath = url.pathname === '/admin' ? '/' : url.pathname;
    const cleanHash = url.hash === '#admin' ? '' : url.hash;
    const searchStr = url.search.replace(/=(?=&|$)/g, '');
    window.history.pushState({ view: 'public' }, '', `${cleanPath}${searchStr}${cleanHash}`);
  }
}

function syncHeaderAndNavigation() {
  const isPublic = activeView === 'public';
  const isAuthenticatedAdmin = Boolean(currentUser && activeView === 'admin');
  const siteHeader = document.getElementById('site-header');
  const brandSubtitle = document.getElementById('brand-subtitle');
  const userPill = document.getElementById('admin-user-pill');

  document.body.classList.toggle('is-public-view', isPublic);
  document.body.classList.toggle('is-admin-session', isAuthenticatedAdmin);
  siteHeader?.classList.toggle('hidden', !isAuthenticatedAdmin);

  document.querySelectorAll('.admin-nav-item').forEach((el) => {
    el.classList.toggle('hidden', !isAuthenticatedAdmin);
  });

  if (isAuthenticatedAdmin) {
    if (brandSubtitle) brandSubtitle.textContent = 'Panel Administrativo';
    if (userPill) {
      userPill.textContent = currentUser.email || 'Administrador';
      userPill.classList.remove('hidden');
    }
    document.querySelectorAll('.admin-tab-nav').forEach((btn) => {
      if (btn.dataset.tab === activeAdminTab) {
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.removeAttribute('aria-current');
      }
    });
    updateNavbarLayout();
  } else {
    if (brandSubtitle) brandSubtitle.textContent = 'Automatización Comercial IA';
    if (userPill) {
      userPill.textContent = '';
      userPill.classList.add('hidden');
    }
  }
}

function showView(which, { syncUrl = true } = {}) {
  activeView = which === 'admin' ? 'admin' : 'public';
  const viewPublic = document.getElementById('view-public');
  const viewAdmin = document.getElementById('view-admin');

  if (syncUrl) {
    syncUrlWithView(activeView);
  }

  closeMenuPopoverIfOpen();

  if (activeView === 'admin') {
    viewPublic?.classList.add('hidden');
    viewAdmin?.classList.remove('hidden');
    syncHeaderAndNavigation();
    if (currentUser) {
      loadAllAdminData();
    } else {
      setFeedback('auth-status-msg', '');
      requestAnimationFrame(() => document.getElementById('auth-email')?.focus());
    }
  } else {
    viewAdmin?.classList.add('hidden');
    viewPublic?.classList.remove('hidden');
    syncHeaderAndNavigation();
    loadPublicCatalog();
    loadClientProvisionedInstance({ populateForm: !provisionedInstance });
    requestAnimationFrame(() => carouselController?.syncActiveSlideInstant());
  }
}

// ==================== CARRUSEL PÚBLICO (modern-web-guidance `carousel`) ====================
let carouselController = null;

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
}

function initPublicCarousel() {
  const carousel = document.getElementById('public-carousel');
  const track = document.getElementById('public-carousel-track');
  const markersNav = document.getElementById('carousel-markers');
  const statusEl = document.getElementById('carousel-status');
  const prevBtn = carousel?.querySelector('.carousel-arrow[data-direction="previous"]');
  const nextBtn = carousel?.querySelector('.carousel-arrow[data-direction="next"]');
  if (!carousel || !track || !markersNav || !prevBtn || !nextBtn) return null;

  const slides = Array.from(track.querySelectorAll('.carousel-slide'));
  if (!slides.length) return null;

  const offerSlideIndex = slides.findIndex((s) => s.dataset.section === 'offer');
  const sections = [
    { key: 'description', label: '01 · Descripción', targetIndex: 0 },
    { key: 'offer', label: '02 · Configura tu ServiBot', targetIndex: offerSlideIndex >= 0 ? offerSlideIndex : slides.length - 1 }
  ];

  const stepPills = Array.from(carousel.querySelectorAll('.desc-step-pill[data-goto-slide]'));

  let pendingTarget = null;
  let scrollGeneration = 0;
  let lastSettledIndex = 0;
  let liveMarkerIndex = 0;
  let rafScheduled = false;
  let settleTimer = null;

  // Generar botones marcadores principales de sección (01 · Descripción, 02 · La Oferta)
  markersNav.innerHTML = '';
  const markers = sections.map((sec, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = sec.label;
    btn.setAttribute('aria-label', sec.label);
    btn.dataset.section = sec.key;
    if (idx === 0) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => goToSlide(sec.targetIndex, { announce: true }));
    markersNav.appendChild(btn);
    return btn;
  });

  stepPills.forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.gotoSlide);
      if (Number.isInteger(idx)) {
        goToSlide(idx, { announce: true });
      }
    });
  });

  function getNearestSlideIndex() {
    const tr = track.getBoundingClientRect();
    const trackCenter = tr.left + tr.width / 2;
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    slides.forEach((slide, idx) => {
      const sr = slide.getBoundingClientRect();
      const dist = Math.abs(sr.left + sr.width / 2 - trackCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }

  function applyMarkerCurrent(index) {
    const activeSection = slides[index]?.dataset.section || 'description';
    const currentSectionBtn = markers.find((m) => m.dataset.section === activeSection);
    if (liveMarkerIndex === index && currentSectionBtn?.getAttribute('aria-current') === 'true') {
      return;
    }
    liveMarkerIndex = index;
    markers.forEach((btn) => {
      if (btn.dataset.section === activeSection) {
        btn.setAttribute('aria-current', 'true');
      } else {
        btn.removeAttribute('aria-current');
      }
    });
    stepPills.forEach((pill) => {
      if (Number(pill.dataset.gotoSlide) === index) {
        pill.setAttribute('aria-current', 'true');
      } else {
        pill.removeAttribute('aria-current');
      }
    });
  }

  function updateEndControls(index) {
    // Con 2 diapositivas (< 3), el carrusel es finito y deshabilita botones en los extremos
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index >= slides.length - 1;
  }

  function settleNavigation(expectedGen, allowAnnounce) {
    if (expectedGen !== undefined && expectedGen !== scrollGeneration) return;
    pendingTarget = null;
    const settledIndex = getNearestSlideIndex();
    applyMarkerCurrent(settledIndex);
    updateEndControls(settledIndex);

    if (allowAnnounce && settledIndex !== lastSettledIndex) {
      lastSettledIndex = settledIndex;
      const label = slides[settledIndex]?.dataset.markerName || `Diapositiva ${settledIndex + 1}`;
      if (statusEl) {
        statusEl.textContent = `Diapositiva ${settledIndex + 1} de ${slides.length}: ${label}`;
      }
    } else {
      lastSettledIndex = settledIndex;
    }
  }

  function goToSlide(targetIndex, { announce = true } = {}) {
    const clamped = Math.max(0, Math.min(slides.length - 1, targetIndex));
    const currentIndex = pendingTarget ?? getNearestSlideIndex();
    if (clamped === currentIndex && pendingTarget === null) {
      updateEndControls(clamped);
      return;
    }

    pendingTarget = clamped;
    scrollGeneration += 1;
    const gen = scrollGeneration;

    // Actualizar el marcador al instante al hacer clic
    applyMarkerCurrent(clamped);

    const targetSlide = slides[clamped];
    const sr = targetSlide.getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    const delta = sr.left + sr.width / 2 - (tr.left + tr.width / 2);

    if (Math.abs(delta) < 1) {
      settleNavigation(gen, announce);
      return;
    }

    const instant = prefersReducedMotion();
    track.scrollBy({
      left: delta,
      behavior: instant ? 'auto' : 'smooth'
    });

    if (instant) {
      requestAnimationFrame(() => settleNavigation(gen, announce));
    } else if (!('onscrollend' in window)) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => settleNavigation(gen, announce), 160);
    }
  }

  prevBtn.addEventListener('click', () => {
    const baseIndex = pendingTarget ?? getNearestSlideIndex();
    goToSlide(baseIndex - 1, { announce: true });
  });

  nextBtn.addEventListener('click', () => {
    const baseIndex = pendingTarget ?? getNearestSlideIndex();
    goToSlide(baseIndex + 1, { announce: true });
  });

  track.addEventListener('scroll', () => {
    // Si hay un destino en vuelo iniciado por botón, evitar recalcular en cada frame
    if (pendingTarget === null && !rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        if (pendingTarget === null) {
          applyMarkerCurrent(getNearestSlideIndex());
        }
      });
    }

    if (!('onscrollend' in window)) {
      const gen = scrollGeneration;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => settleNavigation(gen, true), 140);
    }
  }, { passive: true });

  if ('onscrollend' in window) {
    track.addEventListener('scrollend', () => {
      settleNavigation(scrollGeneration, true);
    });
  }

  function syncActiveSlideInstant() {
    const targetSlide = slides[lastSettledIndex];
    if (!targetSlide) return;
    const sr = targetSlide.getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    const delta = sr.left + sr.width / 2 - (tr.left + tr.width / 2);
    if (Math.abs(delta) >= 2) {
      track.scrollBy({ left: delta, behavior: 'auto' });
    }
    applyMarkerCurrent(lastSettledIndex);
    updateEndControls(lastSettledIndex);
  }

  if ('ResizeObserver' in window) {
    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      if (pendingTarget !== null || activeView !== 'public') return;
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(syncActiveSlideInstant);
    });
    ro.observe(track);
  }

  // Sincronización silenciosa inicial sin anunciar en la región aria-live
  applyMarkerCurrent(0);
  updateEndControls(0);

  return {
    goToSlide,
    syncActiveSlideInstant
  };
}

function switchAdminTab(tabId) {
  activeAdminTab = tabId || 'tab-catalog';
  closeMenuPopoverIfOpen();

  document.querySelectorAll('.admin-tab-pane').forEach((p) => {
    p.classList.toggle('hidden', p.id !== activeAdminTab);
  });

  syncHeaderAndNavigation();

  if (activeAdminTab === 'tab-accounts' && currentUser) {
    loadAdminAccounts();
  } else if (activeAdminTab === 'tab-channels' && currentUser) {
    loadWhatsAppStatus();
    refreshHealth();
  } else if (activeAdminTab === 'tab-orders' && currentUser) {
    loadAdminOrders();
  }
}

// ==================== ESTADO DE CANALES Y SALUD (SOLO EN ADMIN) ====================
async function refreshHealth() {
  try {
    const data = await apiFetch('/api/health');
    if (!data.ok) throw new Error('Offline');

    document.getElementById('dot-node')?.classList.add('online');

    const evDot = document.getElementById('dot-evolution');
    if (evDot) {
      evDot.className = 'dot ' + (data.evolution?.state === 'open' ? 'online' : 'warn');
    }

    const olDot = document.getElementById('dot-ollama');
    if (olDot) {
      olDot.className = 'dot ' + (data.ollama?.online ? 'online' : 'warn');
    }
    const modelLbl = document.getElementById('label-model');
    if (modelLbl && data.ollama?.model) {
      modelLbl.textContent = data.ollama.model;
    }

    const tunDot = document.getElementById('dot-tunnel');
    const tunLbl = document.getElementById('label-tunnel');
    if (data.tunnel?.publicUrl) {
      if (tunDot) tunDot.className = 'dot online';
      if (tunLbl) tunLbl.textContent = data.tunnel.publicUrl.replace('https://', '');
      const tunInput = document.getElementById('tunnel-public-url');
      if (tunInput) tunInput.value = data.tunnel.publicUrl;
    } else {
      if (tunDot) tunDot.className = 'dot warn';
      if (tunLbl) tunLbl.textContent = data.tunnel?.state || 'Local';
    }

    const headerOrdersCount = document.getElementById('header-orders-count');
    if (headerOrdersCount) headerOrdersCount.textContent = String(data.stats?.ordersCount ?? 0);
  } catch {
    document.getElementById('dot-node')?.classList.remove('online');
  }
}

// ==================== CONFIGURADOR INTERACTIVO SERVIBOT (WIZARD 3 PASOS) ====================
const GIRO_PRESETS = {
  clinica: {
    label: 'Clínica / Consultorio',
    tone: 'Cálido, empático y profesional',
    ai_soul: 'Atender a pacientes con calma y claridad, resolver dudas sobre servicios o estudios y agendar citas solicitando nombre, horario preferido y motivo.',
    system_prompt: 'Reglas: pedir nombre completo y horario deseado para citas; no emitir diagnósticos médicos; confirmar teléfono de contacto.'
  },
  restaurante: {
    label: 'Restaurante / Café',
    tone: 'Dinámico, amigable y entusiasta',
    ai_soul: 'Dar la bienvenida con calidez, recomendar platillos o bebidas destacadas, tomar reservaciones y confirmar pedidos para recoger o a domicilio.',
    system_prompt: 'Reglas: preguntar número de personas, fecha y hora para reservaciones; confirmar dirección exacta para entregas.'
  },
  salon: {
    label: 'Salón / Spa / Barbería',
    tone: 'Cercano, amable y orientado al cuidado personal',
    ai_soul: 'Asesorar sobre servicios de belleza, tratamientos o cortes, recomendar disponibilidad y cerrar citas rápidas sin hacer esperar al cliente.',
    system_prompt: 'Reglas: consultar servicio deseado y preferencia de día/hora; recordar políticas de puntualidad con amabilidad.'
  },
  tienda: {
    label: 'Tienda / E-commerce',
    tone: 'Ágil, resolutivo y enfocado en cierre de venta',
    ai_soul: 'Guiar al comprador para elegir el producto ideal, resolver dudas de envíos, precios y existencias, y cerrar pedidos completos.',
    system_prompt: 'Reglas: confirmar modelo/talla o cantidad, solicitar nombre y datos de entrega para cotizar envío y cerrar compra.'
  },
  inmobiliaria: {
    label: 'Inmobiliaria / Autos',
    tone: 'Ejecutivo, directo y consultivo',
    ai_soul: 'Calificar presupuesto y necesidades del prospecto, presentar ventajas clave de la propiedad o vehículo y agendar visita o prueba.',
    system_prompt: 'Reglas: preguntar zona de interés, rango de inversión o modelo buscado y confirmar número telefónico para seguimiento.'
  },
  servicios: {
    label: 'Servicios Profesionales',
    tone: 'Confiable, claro y estructurado',
    ai_soul: 'Escuchar el requerimiento del cliente, explicar alcances de manera sencilla y agendar una llamada o diagnóstico formal.',
    system_prompt: 'Reglas: solicitar giro o necesidad principal, ciudad/empresa y mejor horario para llamada de diagnóstico.'
  }
};

function getInstanceStateMeta(inst) {
  const state = inst?.state || 'close';
  if (state === 'open') {
    return { cls: 'is-open', label: 'Conectado', dotClass: 'online' };
  }
  if (state === 'qr_ready' || inst?.hasQr || inst?.qrBase64) {
    return { cls: 'is-qr', label: 'QR Listo', dotClass: 'warn' };
  }
  if (state === 'connecting') {
    return { cls: 'is-qr', label: 'Conectando...', dotClass: 'warn' };
  }
  return { cls: 'is-close', label: 'Disponible', dotClass: '' };
}

function syncSimulatorHeaderLabel(inst = provisionedInstance) {
  const activeLbl = document.getElementById('sim-active-instance-label');
  if (!activeLbl) return;
  if (inst && inst.business_name && !String(inst.business_name).startsWith('Espacio Disponible')) {
    activeLbl.textContent = `${inst.display_name || 'ServiBot'} · ${inst.business_name}`;
  } else {
    activeLbl.textContent = 'En línea · Listo para conversar';
  }
}

function updateWizardLivePreview() {
  const botEl = document.getElementById('wizard-preview-bot-name');
  const msgEl = document.getElementById('wizard-preview-greeting');
  if (!botEl || !msgEl) return;

  const bizName = document.getElementById('cfg-business-name')?.value.trim() || 'tu negocio';
  const displayName = document.getElementById('cfg-display-name')?.value.trim() || `Asistente de ${bizName}`;
  const welcomeVal = document.getElementById('cfg-welcome-message')?.value.trim();

  botEl.textContent = `${displayName} · ${bizName}`;
  msgEl.textContent =
    welcomeVal ||
    `¡Hola! Soy ${displayName}, asesor inteligente de ${bizName}. ¿En qué te ayudo hoy?`;
}

function goToWizardStep(stepNum, { focusHeading = false } = {}) {
  const step = Math.min(3, Math.max(1, Number(stepNum) || 1));
  wizardCurrentStep = step;

  const titles = {
    1: 'Paso 1 de 3 · Tu Negocio',
    2: 'Paso 2 de 3 · Alma e IA',
    3: 'Paso 3 de 3 · WhatsApp y Prueba'
  };

  const progressEl = document.getElementById('wizard-progress-bar');
  const counterEl = document.getElementById('wizard-step-counter');
  if (progressEl) {
    progressEl.value = step;
    progressEl.textContent = `Paso ${step} de 3`;
  }
  if (counterEl) {
    counterEl.textContent = titles[step] || titles[1];
  }

  document.querySelectorAll('#wizard-steps-list .wizard-step-item').forEach((li) => {
    const itemStep = Number(li.dataset.step);
    const btn = li.querySelector('.wizard-step-btn');
    const isActive = itemStep === step;
    const isDone = itemStep < step || (itemStep === 3 && Boolean(clientInstanceId));
    li.classList.toggle('is-active', isActive);
    li.classList.toggle('is-done', !isActive && isDone);
    if (btn) {
      if (isActive) {
        btn.setAttribute('aria-current', 'step');
      } else {
        btn.removeAttribute('aria-current');
      }
      if (itemStep === 3) {
        btn.disabled = !clientInstanceId;
      }
    }
  });

  [1, 2, 3].forEach((n) => {
    const pane = document.getElementById(`wizard-step-${n}`);
    if (!pane) return;
    const isCurrent = n === step;
    pane.classList.toggle('hidden', !isCurrent);
    if (isCurrent) {
      pane.removeAttribute('hidden');
    } else {
      pane.setAttribute('hidden', '');
    }
  });

  if (focusHeading) {
    const heading = document.getElementById(`wizard-step-${step}-title`);
    if (heading) {
      requestAnimationFrame(() => heading.focus({ preventScroll: true }));
    }
  }
}

function populateWizardForm(inst) {
  if (!inst) return;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? '';
  };
  setVal('cfg-instance-id', inst.instance_id || '');
  setVal('cfg-client-name', inst.client_name || '');
  setVal('cfg-client-contact', inst.client_contact || '');
  setVal('cfg-business-name', inst.business_name || '');
  setVal('cfg-display-name', inst.display_name || '');
  setVal('cfg-tone', inst.tone || '');
  setVal('cfg-ai-soul', inst.ai_soul || '');
  setVal('cfg-system-prompt', inst.system_prompt || '');
  setVal('cfg-welcome-message', inst.welcome_message || '');
  updateWizardLivePreview();
}

function renderWizardSummary(inst) {
  if (!inst) return;
  const titleEl = document.getElementById('wizard-summary-title');
  const metaEl = document.getElementById('wizard-summary-meta');
  const soulEl = document.getElementById('wizard-summary-soul');

  if (titleEl) {
    titleEl.textContent = `${inst.display_name || 'ServiBot'} · ${inst.business_name || 'Tu Negocio'}`;
  }
  if (metaEl) {
    const ownerPart = inst.client_name ? `Responsable: ${inst.client_name}` : 'Configuración personalizada';
    const contactPart = inst.client_contact ? ` (${inst.client_contact})` : '';
    const tonePart = inst.tone ? ` · Tono: ${inst.tone}` : '';
    metaEl.textContent = `${ownerPart}${contactPart}${tonePart}`;
  }
  if (soulEl) {
    soulEl.textContent = inst.ai_soul || 'Asistente listo para atender consultas, citas y ventas.';
  }
}

function renderInstanceWaPanel(inst) {
  if (!inst) return;
  const slotLabel = document.getElementById('cfg-wa-slot-label');
  const badge = document.getElementById('cfg-wa-state-badge');
  const qrBox = document.getElementById('cfg-wa-qr-container');
  const connectBtn = document.getElementById('btn-cfg-wa-connect');

  const meta = getInstanceStateMeta(inst);
  if (slotLabel) {
    slotLabel.textContent = `WhatsApp · ${inst.business_name || 'Tu ServiBot'}`;
  }
  if (badge) {
    badge.textContent = meta.label.toUpperCase();
    badge.className = `badge-tag ${inst.state === 'open' ? 'badge-tag-accent' : ''}`;
  }
  if (connectBtn) {
    connectBtn.disabled = inst.state === 'open';
    connectBtn.textContent =
      inst.state === 'open' ? 'WhatsApp Vinculado ✓' : 'Generar QR de WhatsApp';
  }

  if (!qrBox) return;
  if (inst.state === 'open') {
    qrBox.innerHTML = `
      <div class="cfg-wa-connected">
        <strong>✅ WhatsApp Conectado para ${escapeHtml(inst.business_name || inst.display_name || 'tu ServiBot')}</strong><br />
        <span>Número: ${escapeHtml(inst.connectedPhone || 'Vinculado')}</span>
      </div>
    `;
  } else if (inst.qrBase64 || inst.base64) {
    const src = inst.qrBase64 || inst.base64;
    qrBox.innerHTML = `
      <div class="qr-box">
        <img src="${src}" alt="Código QR WhatsApp para ${escapeHtml(inst.business_name || 'tu ServiBot')}" />
      </div>
      <p class="cfg-wa-placeholder">
        Abre WhatsApp ➔ Dispositivos vinculados ➔ Vincular un dispositivo y escanea este código para activar tu bot.
      </p>
    `;
  } else {
    const infoMsg = inst.lastError
      ? escapeHtml(inst.lastError)
      : 'Tu ServiBot ya tiene su espacio dedicado. Haz clic en el botón verde para generar su código QR de WhatsApp.';
    qrBox.innerHTML = `<p class="cfg-wa-placeholder">${infoMsg}</p>`;
  }
}

function validateWizardStep1() {
  const clientInput = document.getElementById('cfg-client-name');
  const contactInput = document.getElementById('cfg-client-contact');
  const bizInput = document.getElementById('cfg-business-name');

  setFeedback('wizard-step-1-error', '');

  if (!clientInput?.value.trim()) {
    setFeedback('wizard-step-1-error', 'Por favor escribe tu nombre completo para continuar.', false);
    clientInput?.focus();
    return false;
  }
  if (!contactInput?.value.trim()) {
    setFeedback('wizard-step-1-error', 'Indica tu WhatsApp o correo de contacto.', false);
    contactInput?.focus();
    return false;
  }
  if (!bizInput?.value.trim()) {
    setFeedback('wizard-step-1-error', 'Escribe el nombre de tu empresa o marca.', false);
    bizInput?.focus();
    return false;
  }

  const bizName = bizInput.value.trim();
  const displayInput = document.getElementById('cfg-display-name');
  if (displayInput && !displayInput.value.trim()) {
    displayInput.value = `Asistente de ${bizName}`;
  }

  const welcomeInput = document.getElementById('cfg-welcome-message');
  if (welcomeInput && (!welcomeInput.value.trim() || welcomeInput.dataset.autoFilled === '1')) {
    const agentName = displayInput?.value.trim() || `Asistente de ${bizName}`;
    welcomeInput.value = `¡Hola! Soy ${agentName}, asesor inteligente de ${bizName}. ¿En qué te ayudo hoy?`;
    welcomeInput.dataset.autoFilled = '1';
  }

  updateWizardLivePreview();
  return true;
}

function resetWizardForNewBot() {
  clientInstanceId = '';
  provisionedInstance = null;
  activeChatInstanceId = 'servibot-01';
  localStorage.removeItem('servibot_client_instance_id');

  const form = document.getElementById('servibot-wizard-form');
  form?.reset();
  const idInput = document.getElementById('cfg-instance-id');
  if (idInput) idInput.value = '';

  ['cfg-tone', 'cfg-ai-soul', 'cfg-system-prompt', 'cfg-welcome-message'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      delete el.dataset.fromPreset;
      delete el.dataset.autoFilled;
    }
  });

  document.querySelectorAll('.preset-chip').forEach((chip) => {
    chip.classList.remove('is-selected');
    chip.setAttribute('aria-pressed', 'false');
  });

  setFeedback('wizard-step-1-error', '');
  setFeedback('instance-save-status', '');
  setFeedback('instance-wa-feedback', '');
  syncSimulatorHeaderLabel(null);
  updateWizardLivePreview();
  goToWizardStep(1, { focusHeading: true });
}

async function loadClientProvisionedInstance({ populateForm = true } = {}) {
  if (!clientInstanceId) {
    activeChatInstanceId = 'servibot-01';
    syncSimulatorHeaderLabel(null);
    if (populateForm) {
      updateWizardLivePreview();
      goToWizardStep(wizardCurrentStep || 1);
    }
    return;
  }

  try {
    const data = await apiFetch(`/api/instances/${encodeURIComponent(clientInstanceId)}`);
    if (!data.ok || !data.instance) {
      throw new Error('Instancia previa no disponible');
    }
    const inst = data.instance;
    const isUnconfigured =
      String(inst.business_name || '').startsWith('Espacio Disponible') && !String(inst.client_name || '').trim();
    if (isUnconfigured) {
      clientInstanceId = '';
      localStorage.removeItem('servibot_client_instance_id');
      activeChatInstanceId = 'servibot-01';
      syncSimulatorHeaderLabel(null);
      return;
    }

    provisionedInstance = inst;
    activeChatInstanceId = inst.instance_id;
    syncSimulatorHeaderLabel(inst);
    renderWizardSummary(inst);
    renderInstanceWaPanel(inst);

    if (populateForm) {
      populateWizardForm(inst);
      goToWizardStep(3);
    }
  } catch {
    clientInstanceId = '';
    localStorage.removeItem('servibot_client_instance_id');
    activeChatInstanceId = 'servibot-01';
    syncSimulatorHeaderLabel(null);
  }
}

async function refreshProvisionedInstanceWaOnly() {
  if (!clientInstanceId) return;
  try {
    const data = await apiFetch(`/api/instances/${encodeURIComponent(clientInstanceId)}`);
    if (!data.ok || !data.instance) return;
    provisionedInstance = data.instance;
    renderInstanceWaPanel(data.instance);
  } catch {
    // ignore transient polling failure
  }
}

// ==================== CATÁLOGO PÚBLICO ====================
async function loadPublicCatalog() {
  const grid = document.getElementById('catalog-grid');
  if (!grid) return;

  try {
    const data = await apiFetch('/api/catalog');
    catalogCache = data.items || [];
    if (!catalogCache.length) {
      grid.innerHTML = '<p style="color:var(--text-muted);">No hay servicios activos en este momento.</p>';
      return;
    }

    grid.innerHTML = catalogCache
      .map((item) => {
        const featsHtml = (item.features || [])
          .map((f) => `<li>${escapeHtml(f)}</li>`)
          .join('');
        const setupHtml = Number(item.setup_fee) > 0
          ? `<div style="font-size:0.78rem; color:var(--text-muted);">+ $${Number(item.setup_fee).toLocaleString('es-MX')} ${escapeHtml(item.currency)} activación única</div>`
          : `<div style="font-size:0.78rem; color:var(--accent-emerald);">Activación inmediata incluida</div>`;

        // Estructura <article class="card"> siguiendo modern-web-guidance `card`
        return `
          <article class="card">
            <img src="${escapeHtml(resolveAssetUrl(item.image_url))}" alt="${escapeHtml(item.name)}" loading="lazy" />
            <header>
              <div class="card-meta-row">
                <span class="badge-tag">${escapeHtml(item.type === 'service' ? 'Servicio IA' : 'Producto Digital')}</span>
                ${item.badge ? `<span class="badge-tag badge-tag-accent">${escapeHtml(item.badge)}</span>` : ''}
              </div>
              <h3>${escapeHtml(item.name)}</h3>
              ${item.tagline ? `<p class="tagline">${escapeHtml(item.tagline)}</p>` : ''}
            </header>
            <div class="card-content">
              <div class="price-box">
                <div>
                  <span class="price-amount">$${Number(item.price).toLocaleString('es-MX')} ${escapeHtml(item.currency)}</span>
                  <span class="price-cycle">/ ${escapeHtml(item.billing_cycle)}</span>
                </div>
                ${setupHtml}
              </div>
              <p style="margin:0; font-size:0.9rem; color:var(--text-secondary);">${escapeHtml(item.description)}</p>
              ${featsHtml ? `<ul class="feature-list">${featsHtml}</ul>` : ''}
            </div>
            <footer>
              <button type="button" class="btn btn-emerald btn-order-item" data-slug="${escapeHtml(item.slug)}" data-name="${escapeHtml(item.name)}">
                🛒 Contratar Ahora
              </button>
              <button type="button" class="btn btn-outline btn-ask-bot" data-name="${escapeHtml(item.name)}">
                🤖 Preguntar al Bot
              </button>
            </footer>
          </article>
        `;
      })
      .join('');

    grid.querySelectorAll('.btn-order-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        openOrderDialog(btn.dataset.slug, btn.dataset.name);
      });
    });

    grid.querySelectorAll('.btn-ask-bot').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.name;
        const input = document.getElementById('chat-input');
        if (input) {
          input.value = `Me interesa el servicio "${name}", ¿me explicas qué incluye y cómo lo contrato?`;
          input.focus();
          document.getElementById('chat-form')?.requestSubmit();
          if (window.matchMedia?.('(max-width: 979px)')?.matches) {
            input.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          }
        }
      });
    });
  } catch (err) {
    grid.innerHTML = `<p style="color:#fda4af;">No se pudo conectar con el servicio de catálogo: ${escapeHtml(err.message)}</p>`;
  }
}

// ==================== CHAT EN VIVO CON ASESOR COMERCIAL ====================
function appendChatBubble(role, text) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = `chat-bubble ${role}`;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendChatMessage(text) {
  const sendBtn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-input');
  appendChatBubble('user', text);
  if (input) input.value = '';
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Pensando...';
  }

  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'web',
        instance_id: activeChatInstanceId || 'servibot-01',
        sender_id: webSenderId,
        sender_name: 'Prospecto Web',
        message: text
      })
    });

    appendChatBubble('assistant', res.reply || 'Gracias por tu mensaje.');
    if (res.order_created) {
      await refreshHealth();
      if (currentUser) await loadAdminOrders();
    }
  } catch (err) {
    appendChatBubble('assistant', `No se pudo obtener respuesta del asesor en este momento: ${err.message}`);
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Enviar';
    }
  }
}

// ==================== MODAL DE PEDIDO DIRECTO ====================
function openOrderDialog(slug, name) {
  const dlg = document.getElementById('order-dialog');
  if (!dlg) return;
  document.getElementById('order-item-slug').value = slug;
  document.getElementById('order-item-name').value = name;
  dlg.showModal();
}

// ==================== HELPERS DE FEEDBACK Y CONTRASEÑAS ====================
function setFeedback(elId, message, isSuccess = false) {
  const box = document.getElementById(elId);
  if (!box) return;
  box.textContent = message || '';
  box.classList.toggle('is-success', Boolean(isSuccess && message));
}

function resetPasswordToggle(btnId, inputId) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (input) input.type = 'password';
  if (btn) {
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = 'Mostrar';
  }
}

function setupPasswordToggle(btnId, inputId) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;

  btn.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(reveal));
    btn.textContent = reveal ? 'Ocultar' : 'Mostrar';
  });
}

function mapFirebaseAuthError(err) {
  const code = err?.code || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'Correo o contraseña incorrectos. Verifica tus datos o solicita un restablecimiento.';
    case 'auth/invalid-email':
      return 'El formato del correo electrónico no es válido.';
    case 'auth/user-disabled':
      return 'Esta cuenta se encuentra deshabilitada.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos fallidos. Espera un momento antes de volver a intentar.';
    case 'auth/network-request-failed':
      return 'Sin conexión con el servicio de autenticación. Revisa tu red.';
    default:
      return err?.message || 'No se pudo completar la autenticación.';
  }
}

// ==================== FIREBASE AUTH & PANEL ADMIN ====================
onAuthStateChanged(auth, async (user) => {
  // Rechazar sesiones anónimas heredadas; el acceso Admin exige cuenta con correo y contraseña
  if (user && (user.isAnonymous || !user.email)) {
    currentUser = null;
    await signOut(auth).catch(() => {});
    return;
  }

  currentUser = user;
  const gate = document.getElementById('auth-gate');
  const dash = document.getElementById('admin-dashboard');

  if (user) {
    gate?.classList.add('hidden');
    dash?.classList.remove('hidden');
    setFeedback('auth-status-msg', '');
    syncHeaderAndNavigation();
    switchAdminTab(activeAdminTab);
    await loadAllAdminData();
  } else {
    gate?.classList.remove('hidden');
    dash?.classList.add('hidden');
    syncHeaderAndNavigation();
  }
});

async function loadAllAdminData() {
  if (!currentUser) return;
  await Promise.all([
    loadAdminCatalog(),
    loadAdminOrders(),
    loadAdminSettings(),
    loadWhatsAppStatus(),
    loadAdminConversations(),
    loadAdminAccounts(),
    refreshHealth()
  ]);
}

async function loadAdminCatalog() {
  const list = document.getElementById('admin-catalog-list');
  if (!list) return;
  const data = await apiFetch('/api/catalog?all=1');
  const items = data.items || [];

  list.innerHTML = items
    .map(
      (item) => `
      <article class="card">
        <img src="${escapeHtml(resolveAssetUrl(item.image_url))}" alt="${escapeHtml(item.name)}" />
        <header>
          <div class="card-meta-row">
            <span class="badge-tag">${item.active ? '🟢 Activo' : '⚪ Oculto'}</span>
            <span class="badge-tag">${escapeHtml(item.slug)}</span>
          </div>
          <h3>${escapeHtml(item.name)}</h3>
          <p class="tagline">$${Number(item.price).toLocaleString('es-MX')} ${escapeHtml(item.currency)} / ${escapeHtml(item.billing_cycle)}</p>
        </header>
        <div class="card-content">
          <p style="margin:0; font-size:0.86rem; color:var(--text-muted);">${escapeHtml(item.description)}</p>
        </div>
        <footer>
          <button type="button" class="btn btn-outline btn-sm btn-edit-cat" data-id="${item.id}">✏️ Editar</button>
          <button type="button" class="btn btn-danger btn-sm btn-del-cat" data-id="${item.id}">🗑️ Eliminar</button>
        </footer>
      </article>
    `
    )
    .join('');

  list.querySelectorAll('.btn-edit-cat').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = items.find((i) => i.id === Number(btn.dataset.id));
      if (!item) return;
      document.getElementById('item-id').value = item.id;
      document.getElementById('item-name').value = item.name;
      document.getElementById('item-type').value = item.type || 'service';
      document.getElementById('item-badge').value = item.badge || '';
      document.getElementById('item-price').value = item.price;
      document.getElementById('item-currency').value = item.currency || 'MXN';
      document.getElementById('item-cycle').value = item.billing_cycle || 'mensual';
      document.getElementById('item-setup').value = item.setup_fee || 0;
      document.getElementById('item-tagline').value = item.tagline || '';
      document.getElementById('item-description').value = item.description || '';
      document.getElementById('item-features').value = (item.features || []).join('\n');
      document.getElementById('item-image-url').value = item.image_url || '/assets/service-bots.svg';
      document.getElementById('item-active').checked = Boolean(item.active);
      document.getElementById('catalog-form-title').textContent = `✏️ Editando: ${item.name}`;
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  list.querySelectorAll('.btn-del-cat').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      await apiFetch(`/api/catalog/${id}`, { method: 'DELETE' });
      await loadAdminCatalog();
      await loadPublicCatalog();
    });
  });
}

async function loadAdminOrders() {
  const tbody = document.getElementById('orders-tbody');
  if (!tbody) return;
  const data = await apiFetch('/api/orders');
  const orders = data.orders || [];

  const headerOrdersCount = document.getElementById('header-orders-count');
  if (headerOrdersCount) headerOrdersCount.textContent = String(orders.length);

  if (!orders.length) {
    tbody.innerHTML = `<tr><th scope="row">—</th><td colspan="6" style="color:var(--text-muted);">Aún no hay pedidos registrados. Prueba el chat IA o los simuladores de canales para cerrar una venta.</td></tr>`;
    return;
  }

  tbody.innerHTML = orders
    .map((o) => {
      const itemsText = (o.items || []).map((i) => i.name).join(', ') || 'Servicio Servi-Bot';
      return `
        <tr>
          <th scope="row">${escapeHtml(o.order_code)}</th>
          <td>
            <strong>${escapeHtml(o.customer_name)}</strong>
            <div style="font-size:0.78rem; color:var(--text-muted);">${escapeHtml(o.customer_contact)}</div>
          </td>
          <td><span class="badge-tag">${escapeHtml(o.channel.toUpperCase())}</span></td>
          <td>
            <div>${escapeHtml(itemsText)}</div>
            ${o.notes ? `<div style="font-size:0.75rem; color:var(--text-muted);">${escapeHtml(o.notes)}</div>` : ''}
          </td>
          <td><strong style="color:var(--accent-emerald);">$${Number(o.total_amount).toLocaleString('es-MX')} ${escapeHtml(o.currency)}</strong></td>
          <td>
            <select class="order-status-select" data-id="${o.id}" style="background:var(--bg-card); color:var(--text-main); border:1px solid var(--border-color); padding:0.3rem 0.5rem; border-radius:8px;">
              <option value="pending" ${o.status === 'pending' ? 'selected' : ''}>⏳ Pendiente</option>
              <option value="confirmed" ${o.status === 'confirmed' ? 'selected' : ''}>✅ Confirmado</option>
              <option value="in_progress" ${o.status === 'in_progress' ? 'selected' : ''}>⚙️ En Implementación</option>
              <option value="completed" ${o.status === 'completed' ? 'selected' : ''}>🎉 Completado</option>
              <option value="cancelled" ${o.status === 'cancelled' ? 'selected' : ''}>❌ Cancelado</option>
            </select>
          </td>
          <td style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(o.created_at)}</td>
        </tr>
      `;
    })
    .join('');

  tbody.querySelectorAll('.order-status-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      await apiFetch(`/api/orders/${sel.dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: sel.value })
      });
      await refreshHealth();
    });
  });
}

async function loadWhatsAppStatus() {
  const container = document.getElementById('wa-qr-container');
  const badge = document.getElementById('wa-state-badge');
  if (!container) return;

  try {
    const data = await apiFetch('/api/channels/whatsapp/status');
    if (badge) badge.textContent = (data.state || 'close').toUpperCase();

    if (data.state === 'open') {
      container.innerHTML = `
        <div style="padding:1rem; background:rgba(16,185,129,0.12); border:1px solid rgba(16,185,129,0.4); border-radius:12px; color:#6ee7b7;">
          ✅ <strong>WhatsApp Conectado Activamente</strong><br/>
          <span style="font-size:0.84rem;">Número vinculado: ${escapeHtml(data.connectedPhone || 'Activo')}</span>
        </div>
      `;
    } else if (data.base64) {
      container.innerHTML = `
        <div class="qr-box">
          <img src="${data.base64}" alt="Código QR de WhatsApp Evolution" />
        </div>
        <div style="font-size:0.8rem; color:var(--text-muted);">
          Abre WhatsApp en tu teléfono ➔ Dispositivos vinculados ➔ Vincular un dispositivo.
        </div>
      `;
    } else {
      container.innerHTML = `<p style="color:var(--text-muted); font-size:0.84rem;">Estado: ${escapeHtml(data.state || 'preparando QR')}. Haz clic en Actualizar QR en unos segundos.</p>`;
    }
  } catch (err) {
    container.innerHTML = `<p style="color:#fda4af; font-size:0.84rem;">Error consultando puerto 10001: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadAdminSettings() {
  try {
    const data = await apiFetch('/api/settings');
    if (!data.ok) return;

    const em = data.email_config || {};
    document.getElementById('cfg-imap-host').value = em.imap_host || 'imap.gmail.com';
    document.getElementById('cfg-smtp-host').value = em.smtp_host || 'smtp.gmail.com';
    document.getElementById('cfg-email-user').value = em.user || '';
    document.getElementById('cfg-email-pass').value = em.pass || '';
    document.getElementById('cfg-email-enabled').checked = Boolean(em.enabled);

    const tm = data.teams_config || {};
    document.getElementById('cfg-teams-name').value = tm.bot_display_name || 'Servi-Bot Teams';
    document.getElementById('cfg-teams-webhook').value = tm.incoming_webhook_url || '';

    const tun = data.tunnel_config || {};
    if (tun.public_url) {
      document.getElementById('tunnel-public-url').value = tun.public_url;
    }
    document.getElementById('tunnel-token-input').value = tun.tunnel_token || '';
  } catch {
    // ignorar error de carga inicial de ajustes
  }
}

async function loadAdminConversations() {
  const box = document.getElementById('conversations-list');
  if (!box) return;
  const data = await apiFetch('/api/conversations');
  const convs = data.conversations || [];
  if (!convs.length) {
    box.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">Sin conversaciones registradas aún.</p>';
    return;
  }
  box.innerHTML = convs
    .map(
      (c) => `
      <div style="padding:0.7rem; background:var(--bg-dark); border:1px solid var(--border-color); border-radius:10px;">
        <div style="display:flex; justify-content:space-between; font-size:0.8rem;">
          <strong>[${escapeHtml(c.channel.toUpperCase())}] ${escapeHtml(c.sender_name || c.sender_id)}</strong>
          <span style="color:var(--text-muted);">${escapeHtml(c.updated_at)}</span>
        </div>
        <div style="font-size:0.82rem; color:#cbd5e1; margin-top:0.25rem;">${escapeHtml(c.last_message || '')}</div>
      </div>
    `
    )
    .join('');
}

async function loadAdminAccounts() {
  const tbody = document.getElementById('accounts-tbody');
  if (!tbody) return;

  try {
    const data = await apiFetch('/api/admin/accounts');
    if (!data.ok) {
      tbody.innerHTML = `<tr><th scope="row">—</th><td colspan="4" style="color:#fda4af;">${escapeHtml(data.error || 'No se pudieron consultar las cuentas.')}</td></tr>`;
      return;
    }

    const accounts = data.accounts || [];
    if (!accounts.length) {
      tbody.innerHTML = `<tr><th scope="row">—</th><td colspan="4" style="color:var(--text-muted);">No hay cuentas registradas aún.</td></tr>`;
      return;
    }

    tbody.innerHTML = accounts
      .map((acc) => {
        const roleLabel = acc.role === 'operator' ? 'Operador de Ventas' : 'Administrador';
        return `
          <tr>
            <th scope="row">${escapeHtml(acc.display_name || acc.email)}</th>
            <td>${escapeHtml(acc.email)}</td>
            <td><span class="badge-tag">${escapeHtml(roleLabel)}</span></td>
            <td>${escapeHtml(acc.created_by || 'Firebase Auth')}</td>
            <td style="font-size:0.8rem; color:var(--text-muted);">${escapeHtml(acc.created_at || '—')}</td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><th scope="row">—</th><td colspan="4" style="color:#fda4af;">Error cargando cuentas: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== EVENT LISTENERS ====================
function setupEventListeners() {
  initNavbarMeasurement();
  carouselController = initPublicCarousel();

  document.getElementById('btn-view-store')?.addEventListener('click', () => showView('public'));
  document.getElementById('btn-back-to-public')?.addEventListener('click', () => showView('public'));

  const goHomeAndDescription = (e) => {
    e.preventDefault();
    showView('public');
    carouselController?.goToSlide(0, { announce: true });
  };
  document.getElementById('link-home')?.addEventListener('click', goHomeAndDescription);
  document.getElementById('admin-link-home')?.addEventListener('click', goHomeAndDescription);

  document.querySelectorAll('.btn-go-offer').forEach((btn) => {
    btn.addEventListener('click', () => {
      const offerIdx = Math.max(0, document.querySelectorAll('#public-carousel-track .carousel-slide').length - 1);
      carouselController?.goToSlide(offerIdx, { announce: true });
    });
  });
  document.getElementById('btn-go-description')?.addEventListener('click', () => {
    carouselController?.goToSlide(0, { announce: true });
  });

  if (hasAdminUrlParam()) {
    showView('admin', { syncUrl: false });
  } else {
    showView('public', { syncUrl: false });
  }

  window.addEventListener('popstate', () => {
    showView(hasAdminUrlParam() ? 'admin' : 'public', { syncUrl: false });
  });

  // Botones de navegación del Panel Admin en el encabezado
  document.querySelectorAll('.admin-tab-nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchAdminTab(btn.dataset.tab);
    });
  });

  // Toggles de mostrar/ocultar contraseña
  setupPasswordToggle('btn-toggle-login-pw', 'auth-password');
  setupPasswordToggle('btn-toggle-new-pw', 'new-acc-password');

  // Login administrativo Firebase Auth (sin autocreación ni credenciales precargadas)
  document.getElementById('firebase-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const pass = document.getElementById('auth-password').value;
    const submitBtn = document.getElementById('btn-login-email');

    setFeedback('auth-status-msg', '');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verificando...';
    }

    try {
      await signInWithEmailAndPassword(auth, email, pass);
    } catch (err) {
      setFeedback('auth-status-msg', mapFirebaseAuthError(err), false);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Iniciar sesión';
      }
    }
  });

  // Recuperar contraseña con Firebase Auth
  document.getElementById('btn-forgot-password')?.addEventListener('click', async () => {
    const emailInput = document.getElementById('auth-email');
    const email = emailInput?.value?.trim() || '';
    if (!email) {
      setFeedback('auth-status-msg', 'Escribe tu correo electrónico arriba para enviarte el enlace de recuperación.', false);
      emailInput?.focus();
      return;
    }

    try {
      await sendPasswordResetEmail(auth, email);
      setFeedback(
        'auth-status-msg',
        `Se envió un correo de restablecimiento a ${email}. Revisa tu bandeja de entrada o spam.`,
        true
      );
    } catch (err) {
      setFeedback('auth-status-msg', mapFirebaseAuthError(err), false);
    }
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    closeMenuPopoverIfOpen();
    await signOut(auth);
    document.getElementById('firebase-login-form')?.reset();
    resetPasswordToggle('btn-toggle-login-pw', 'auth-password');
    setFeedback('auth-status-msg', 'Sesión cerrada correctamente.', true);
  });

  document.getElementById('btn-refresh-admin')?.addEventListener('click', () => {
    closeMenuPopoverIfOpen();
    loadAllAdminData();
  });

  // Crear nueva cuenta dentro de Admin (sin cerrar sesión actual)
  document.getElementById('create-account-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const displayName = document.getElementById('new-acc-name').value.trim();
    const email = document.getElementById('new-acc-email').value.trim();
    const role = document.getElementById('new-acc-role').value;
    const password = document.getElementById('new-acc-password').value;
    const createBtn = document.getElementById('btn-create-account');

    setFeedback('create-account-feedback', '');
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.textContent = 'Creando cuenta...';
    }

    try {
      const res = await apiFetch('/api/admin/accounts', {
        method: 'POST',
        body: JSON.stringify({ displayName, email, role, password })
      });

      if (!res.ok) {
        setFeedback('create-account-feedback', res.error || 'No se pudo crear la cuenta.', false);
        return;
      }

      setFeedback(
        'create-account-feedback',
        `✅ Cuenta creada en Firebase Auth: ${res.account?.email || email}`,
        true
      );
      document.getElementById('create-account-form')?.reset();
      resetPasswordToggle('btn-toggle-new-pw', 'new-acc-password');
      await loadAdminAccounts();
    } catch (err) {
      setFeedback('create-account-feedback', `Error de conexión: ${err.message}`, false);
    } finally {
      if (createBtn) {
        createBtn.disabled = false;
        createBtn.textContent = 'Crear cuenta';
      }
    }
  });

  // Wizard Interactivo de 3 Pasos para Crear / Editar ServiBot
  document.querySelectorAll('#preset-giro-chips .preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const giroKey = chip.dataset.giro;
      const preset = GIRO_PRESETS[giroKey];
      document.querySelectorAll('#preset-giro-chips .preset-chip').forEach((c) => {
        const active = c === chip;
        c.classList.toggle('is-selected', active);
        c.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      if (!preset) return;

      const applyPresetField = (id, val) => {
        const el = document.getElementById(id);
        if (el && (!el.value.trim() || el.dataset.fromPreset === '1')) {
          el.value = val;
          el.dataset.fromPreset = '1';
        }
      };
      applyPresetField('cfg-tone', preset.tone);
      applyPresetField('cfg-ai-soul', preset.ai_soul);
      applyPresetField('cfg-system-prompt', preset.system_prompt);
      updateWizardLivePreview();
    });
  });

  document.querySelectorAll('#preset-tone-chips .preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const toneInput = document.getElementById('cfg-tone');
      if (toneInput) {
        toneInput.value = chip.dataset.tone || chip.textContent.trim();
        delete toneInput.dataset.fromPreset;
      }
      document.querySelectorAll('#preset-tone-chips .preset-chip').forEach((c) => {
        const active = c === chip;
        c.classList.toggle('is-selected', active);
        c.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      updateWizardLivePreview();
    });
  });

  ['cfg-tone', 'cfg-ai-soul', 'cfg-system-prompt'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', (e) => {
      delete e.target.dataset.fromPreset;
    });
  });

  ['cfg-business-name', 'cfg-display-name', 'cfg-welcome-message'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', (e) => {
      setFeedback('wizard-step-1-error', '');
      if (id === 'cfg-welcome-message') {
        delete e.target.dataset.autoFilled;
      }
      updateWizardLivePreview();
    });
  });

  ['cfg-client-name', 'cfg-client-contact'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => {
      setFeedback('wizard-step-1-error', '');
    });
  });

  document.querySelectorAll('#wizard-steps-list .wizard-step-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetStep = Number(btn.dataset.step);
      if (targetStep === 1) {
        goToWizardStep(1, { focusHeading: true });
      } else if (targetStep === 2) {
        if (validateWizardStep1()) {
          goToWizardStep(2, { focusHeading: true });
        }
      } else if (targetStep === 3 && clientInstanceId) {
        goToWizardStep(3, { focusHeading: true });
      }
    });
  });

  document.getElementById('btn-wizard-next-1')?.addEventListener('click', () => {
    if (validateWizardStep1()) {
      goToWizardStep(2, { focusHeading: true });
    }
  });

  document.getElementById('btn-wizard-prev-2')?.addEventListener('click', () => {
    setFeedback('instance-save-status', '');
    goToWizardStep(1, { focusHeading: true });
  });

  document.getElementById('btn-wizard-edit')?.addEventListener('click', () => {
    goToWizardStep(2, { focusHeading: true });
  });

  document.getElementById('btn-wizard-new')?.addEventListener('click', () => {
    resetWizardForNewBot();
  });

  document.getElementById('servibot-wizard-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (wizardCurrentStep === 1) {
      if (validateWizardStep1()) goToWizardStep(2, { focusHeading: true });
      return;
    }

    const saveBtn = document.getElementById('btn-save-instance');
    const displayInput = document.getElementById('cfg-display-name');
    const soulInput = document.getElementById('cfg-ai-soul');
    setFeedback('instance-save-status', '');

    if (!displayInput?.value.trim()) {
      setFeedback('instance-save-status', 'Asigna un nombre para tu asistente ServiBot.', false);
      displayInput?.focus();
      return;
    }
    if (!soulInput?.value.trim()) {
      setFeedback('instance-save-status', 'Describe brevemente el propósito o alma de tu asistente.', false);
      soulInput?.focus();
      return;
    }

    const payload = {
      instance_id: clientInstanceId || document.getElementById('cfg-instance-id')?.value || '',
      client_name: document.getElementById('cfg-client-name')?.value.trim() || '',
      client_contact: document.getElementById('cfg-client-contact')?.value.trim() || '',
      business_name: document.getElementById('cfg-business-name')?.value.trim() || '',
      display_name: displayInput.value.trim(),
      tone: document.getElementById('cfg-tone')?.value.trim() || '',
      ai_soul: soulInput.value.trim(),
      system_prompt: document.getElementById('cfg-system-prompt')?.value.trim() || '',
      welcome_message: document.getElementById('cfg-welcome-message')?.value.trim() || ''
    };

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Creando tu ServiBot...';
    }

    try {
      const res = await apiFetch('/api/instances/provision', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!res.ok || !res.instance) {
        setFeedback('instance-save-status', res.error || 'No se pudo configurar tu ServiBot.', false);
        return;
      }

      const inst = res.instance;
      clientInstanceId = inst.instance_id;
      activeChatInstanceId = inst.instance_id;
      provisionedInstance = inst;
      localStorage.setItem('servibot_client_instance_id', clientInstanceId);

      const idHidden = document.getElementById('cfg-instance-id');
      if (idHidden) idHidden.value = inst.instance_id;

      syncSimulatorHeaderLabel(inst);
      renderWizardSummary(inst);
      renderInstanceWaPanel(inst);

      const box = document.getElementById('chat-messages');
      if (box) {
        const greeting =
          inst.welcome_message ||
          `¡Hola! Soy ${inst.display_name} de ${inst.business_name}. ¿En qué te ayudo hoy?`;
        box.innerHTML = `<div class="chat-bubble assistant"><strong>${escapeHtml(inst.display_name)} · ${escapeHtml(inst.business_name)}</strong><br />${escapeHtml(greeting)}</div>`;
      }

      setFeedback('instance-wa-feedback', '');
      goToWizardStep(3, { focusHeading: true });
    } catch (err) {
      setFeedback('instance-save-status', `Error de conexión: ${err.message}`, false);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Crear mi ServiBot y Conectar WhatsApp →';
      }
    }
  });

  document.getElementById('btn-test-instance-sim')?.addEventListener('click', () => {
    const inst = provisionedInstance;
    const input = document.getElementById('chat-input');
    const box = document.getElementById('chat-messages');
    const currentBiz = inst?.business_name || document.getElementById('cfg-business-name')?.value.trim() || 'mi negocio';
    const currentName = inst?.display_name || document.getElementById('cfg-display-name')?.value.trim() || 'ServiBot';
    const currentWelcome =
      inst?.welcome_message ||
      document.getElementById('cfg-welcome-message')?.value.trim() ||
      `¡Hola! Soy ${currentName} de ${currentBiz}.`;

    if (box) {
      box.innerHTML = `<div class="chat-bubble assistant"><strong>${escapeHtml(currentName)} · ${escapeHtml(currentBiz)}</strong><br />${escapeHtml(currentWelcome)}</div>`;
    }
    if (input) {
      input.value = 'Hola, ¿me puedes explicar cómo atiendes a los clientes de nuestro negocio?';
      input.focus();
      if (window.matchMedia?.('(max-width: 979px)')?.matches) {
        input.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      }
    }
  });

  document.getElementById('btn-cfg-wa-connect')?.addEventListener('click', async () => {
    if (!clientInstanceId) {
      setFeedback('instance-wa-feedback', 'Primero completa el Paso 2 para crear tu ServiBot.', false);
      return;
    }
    const btn = document.getElementById('btn-cfg-wa-connect');
    setFeedback('instance-wa-feedback', '');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Generando QR WhatsApp...';
    }
    try {
      const data = await apiFetch(`/api/instances/${encodeURIComponent(clientInstanceId)}/connect`, {
        method: 'POST'
      });
      if (!data.ok) {
        setFeedback('instance-wa-feedback', data.error || 'No se pudo iniciar la sesión WhatsApp.', false);
      } else {
        provisionedInstance = {
          ...(provisionedInstance || { instance_id: clientInstanceId }),
          state: data.state,
          connectedPhone: data.connectedPhone,
          qrBase64: data.qrBase64 || data.base64,
          hasQr: Boolean(data.qrBase64 || data.base64),
          lastError: data.lastError || null
        };
        renderInstanceWaPanel(provisionedInstance);
        if (data.lastError) {
          setFeedback('instance-wa-feedback', data.lastError, false);
        }
      }
    } catch (err) {
      setFeedback('instance-wa-feedback', `Error conectando con WhatsApp: ${err.message}`, false);
    } finally {
      if (btn) {
        btn.disabled = provisionedInstance?.state === 'open';
        btn.textContent =
          provisionedInstance?.state === 'open' ? 'WhatsApp Vinculado ✓' : 'Generar QR de WhatsApp';
      }
    }
  });

  document.getElementById('btn-cfg-wa-logout')?.addEventListener('click', async () => {
    if (!clientInstanceId) return;
    const btn = document.getElementById('btn-cfg-wa-logout');
    setFeedback('instance-wa-feedback', '');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Reiniciando sesión...';
    }
    try {
      const data = await apiFetch(`/api/instances/${encodeURIComponent(clientInstanceId)}/logout`, {
        method: 'POST'
      });
      provisionedInstance = {
        ...(provisionedInstance || { instance_id: clientInstanceId }),
        state: data.state || 'close',
        connectedPhone: null,
        qrBase64: data.qrBase64 || data.base64 || null,
        hasQr: Boolean(data.qrBase64 || data.base64)
      };
      renderInstanceWaPanel(provisionedInstance);
      setFeedback('instance-wa-feedback', 'Sesión de WhatsApp reiniciada correctamente.', true);
    } catch (err) {
      setFeedback('instance-wa-feedback', `Error reiniciando sesión: ${err.message}`, false);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Reiniciar Sesión WA';
      }
    }
  });

  // Chat en vivo
  document.getElementById('chat-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    const msg = input?.value?.trim();
    if (msg) sendChatMessage(msg);
  });

  document.querySelectorAll('.quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const promptText = chip.dataset.prompt;
      if (promptText) sendChatMessage(promptText);
    });
  });

  document.getElementById('btn-reset-chat')?.addEventListener('click', () => {
    webSenderId = `web-${Math.floor(10000 + Math.random() * 90000)}`;
    localStorage.setItem('servibot_sender_id', webSenderId);
    const inst = provisionedInstance;
    const greeting =
      inst?.welcome_message ||
      'Sesión reiniciada. ¡Hola! Soy el asesor de Servi-Bot, ¿en qué servicio te puedo apoyar hoy?';
    const box = document.getElementById('chat-messages');
    if (box) {
      const header = inst
        ? `<strong>${escapeHtml(inst.display_name || 'ServiBot')} · ${escapeHtml(inst.business_name || '')}</strong><br />`
        : '';
      box.innerHTML = `<div class="chat-bubble assistant">${header}${escapeHtml(greeting)}</div>`;
    }
  });

  // Modal de pedido directo
  document.getElementById('btn-close-order-modal')?.addEventListener('click', () => {
    document.getElementById('order-dialog')?.close();
  });

  document.getElementById('direct-order-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const slug = document.getElementById('order-item-slug').value;
    const customer_name = document.getElementById('order-cust-name').value.trim();
    const customer_contact = document.getElementById('order-cust-contact').value.trim();
    const customer_company = document.getElementById('order-cust-company').value.trim();
    const notes = document.getElementById('order-cust-notes').value.trim();

    const res = await apiFetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        customer_name,
        customer_contact,
        customer_company,
        channel: 'web',
        item_ids: [slug],
        notes
      })
    });

    document.getElementById('order-dialog')?.close();
    if (res.ok && res.order) {
      appendChatBubble(
        'assistant',
        `🎉 ¡Gracias ${customer_name}! Tu pedido con folio ${res.order.order_code} por $${Number(res.order.total_amount).toLocaleString('es-MX')} ${res.order.currency} ha quedado registrado en nuestro Panel de Administración.`
      );
      await refreshHealth();
    }
  });

  // Subida de archivo de imagen en el formulario de catálogo
  document.getElementById('item-image-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const up = await apiFetch('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ dataUrl, filename: file.name })
      });
      if (up.ok && up.imageUrl) {
        document.getElementById('item-image-url').value = up.imageUrl;
      }
    };
    reader.readAsDataURL(file);
  });

  // Guardar Producto / Servicio en Admin
  document.getElementById('catalog-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('item-id').value;
    const payload = {
      name: document.getElementById('item-name').value.trim(),
      type: document.getElementById('item-type').value,
      badge: document.getElementById('item-badge').value.trim(),
      price: Number(document.getElementById('item-price').value || 0),
      currency: document.getElementById('item-currency').value,
      billing_cycle: document.getElementById('item-cycle').value,
      setup_fee: Number(document.getElementById('item-setup').value || 0),
      tagline: document.getElementById('item-tagline').value.trim(),
      description: document.getElementById('item-description').value.trim(),
      features: document.getElementById('item-features').value,
      image_url: document.getElementById('item-image-url').value.trim(),
      active: document.getElementById('item-active').checked
    };

    if (id) {
      await apiFetch(`/api/catalog/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiFetch('/api/catalog', { method: 'POST', body: JSON.stringify(payload) });
    }

    resetCatalogForm();
    await loadAdminCatalog();
    await loadPublicCatalog();
  });

  document.getElementById('btn-cancel-edit')?.addEventListener('click', resetCatalogForm);

  function resetCatalogForm() {
    document.getElementById('item-id').value = '';
    document.getElementById('catalog-form')?.reset();
    document.getElementById('item-image-url').value = '/assets/service-bots.svg';
    document.getElementById('catalog-form-title').textContent = '➕ Crear o Editar Producto / Servicio';
  }

  // Controles de Canales (WhatsApp, Correo, Teams)
  document.getElementById('btn-wa-refresh')?.addEventListener('click', loadWhatsAppStatus);
  document.getElementById('btn-wa-logout')?.addEventListener('click', async () => {
    await apiFetch('/api/channels/whatsapp/logout', { method: 'POST' });
    setTimeout(loadWhatsAppStatus, 1800);
  });

  const outBox = document.getElementById('channel-test-output');

  document.getElementById('btn-sim-wa')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Enviando evento MESSAGES_UPSERT por Evolution (:10001 -> :10000 -> Python -> Ollama :10002)...';
    const phone = document.getElementById('sim-wa-phone').value;
    const text = document.getElementById('sim-wa-text').value;
    const res = await apiFetch('/api/channels/whatsapp/simulate', {
      method: 'POST',
      body: JSON.stringify({ phone, name: 'Cliente WhatsApp', text })
    });
    if (outBox) outBox.textContent = JSON.stringify(res, null, 2);
    await loadAdminOrders();
    await loadAdminConversations();
    await refreshHealth();
  });

  document.getElementById('email-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/settings/email_config', {
      method: 'PUT',
      body: JSON.stringify({
        imap_host: document.getElementById('cfg-imap-host').value.trim(),
        smtp_host: document.getElementById('cfg-smtp-host').value.trim(),
        user: document.getElementById('cfg-email-user').value.trim(),
        pass: document.getElementById('cfg-email-pass').value,
        enabled: document.getElementById('cfg-email-enabled').checked
      })
    });
    if (outBox) outBox.textContent = '✅ Configuración IMAP/SMTP guardada en SQLite.';
  });

  document.getElementById('btn-sim-email')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Procesando correo entrante con Python Worker + Ollama :10002...';
    const fromEmail = document.getElementById('sim-email-from').value.trim();
    const body = document.getElementById('sim-email-body').value.trim();
    const res = await apiFetch('/api/channels/email/simulate', {
      method: 'POST',
      body: JSON.stringify({
        fromEmail,
        fromName: 'Cliente Correo',
        subject: 'Solicitud de Contratación Servi-Bot',
        body
      })
    });
    if (outBox) outBox.textContent = JSON.stringify(res, null, 2);
    await loadAdminOrders();
    await loadAdminConversations();
    await refreshHealth();
  });

  document.getElementById('teams-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await apiFetch('/api/settings/teams_config', {
      method: 'PUT',
      body: JSON.stringify({
        bot_display_name: document.getElementById('cfg-teams-name').value.trim(),
        incoming_webhook_url: document.getElementById('cfg-teams-webhook').value.trim()
      })
    });
    if (outBox) outBox.textContent = '✅ Configuración de Microsoft Teams guardada en SQLite.';
  });

  document.getElementById('btn-sim-teams')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Enviando payload al webhook de Microsoft Teams (/api/channels/teams/webhook)...';
    const user = document.getElementById('sim-teams-user').value.trim();
    const text = document.getElementById('sim-teams-text').value.trim();
    const res = await apiFetch('/api/channels/teams/webhook', {
      method: 'POST',
      body: JSON.stringify({
        from: { id: 'teams-corp-01', name: user },
        text
      })
    });
    if (outBox) outBox.textContent = JSON.stringify(res, null, 2);
    await loadAdminOrders();
    await loadAdminConversations();
    await refreshHealth();
  });

  // Configuración de Túnel Cloudflare y override manual de URL (solo en Admin)
  document.getElementById('btn-save-tunnel')?.addEventListener('click', async () => {
    const token = document.getElementById('tunnel-token-input').value.trim();
    const res = await apiFetch('/api/settings/tunnel_config', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        tunnel_token: token,
        restartTunnel: true
      })
    });
    if (res.tunnel?.publicUrl) {
      document.getElementById('tunnel-public-url').value = res.tunnel.publicUrl;
    }
    await refreshHealth();
  });

  document.getElementById('btn-use-tunnel-url')?.addEventListener('click', () => {
    const url = document.getElementById('tunnel-public-url').value.trim().replace(/\/+$/, '');
    if (url && url.startsWith('https://')) {
      API_BASE = url;
      localStorage.setItem('servibot_api_base', API_BASE);
      syncApiOverrideInput();
      loadAllAdminData();
    }
  });

  document.getElementById('btn-apply-api-override')?.addEventListener('click', async () => {
    const input = document.getElementById('admin-api-override');
    const next = (input?.value || '').trim().replace(/\/+$/, '');
    if (!next) {
      localStorage.removeItem('servibot_api_base');
      await resolveInitialApiBase();
    } else {
      API_BASE = next;
      localStorage.setItem('servibot_api_base', API_BASE);
      syncApiOverrideInput();
    }
    await Promise.all([loadClientProvisionedInstance({ populateForm: true }), loadPublicCatalog()]);
    if (currentUser) await loadAllAdminData();
  });
}

// Inicialización
(async () => {
  await resolveInitialApiBase();
  setupEventListeners();
  await Promise.all([loadClientProvisionedInstance({ populateForm: true }), loadPublicCatalog()]);
  await refreshHealth();
  setInterval(refreshHealth, 12000);
  setInterval(() => {
    const chTab = document.getElementById('tab-channels');
    if (currentUser && activeView === 'admin' && chTab && !chTab.classList.contains('hidden')) {
      loadWhatsAppStatus();
    } else if (activeView === 'public' && clientInstanceId && provisionedInstance) {
      if (provisionedInstance.state === 'connecting' || provisionedInstance.state === 'qr_ready') {
        refreshProvisionedInstanceWaOnly();
      }
    }
  }, 4000);
})();
