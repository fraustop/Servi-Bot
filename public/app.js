import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  updateProfile
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
let currentAdminMeta = null;
let adminSelectedInstanceId = 'servibot-00';
let activeView = 'public';
let activeAdminTab = 'tab-catalog';
let catalogCache = [];
let promotionsCache = [];
let rulesCache = [];
let vipCache = [];
let clientInstanceId = localStorage.getItem('servibot_client_instance_id') || '';
let activeChatInstanceId = clientInstanceId || 'servibot-00';
let provisionedInstance = null;
let activeBotMode = 'official';
let mobileSimTriggerEl = null;
let wizardCurrentStep = 1;
let webSenderId = localStorage.getItem('servibot_sender_id') || `web-${Math.floor(10000 + Math.random() * 90000)}`;
localStorage.setItem('servibot_sender_id', webSenderId);

let prospectProfile = (() => {
  try {
    return JSON.parse(localStorage.getItem('servibot_prospect_profile') || 'null');
  } catch {
    return null;
  }
})();
let prospectAuthMode = 'register';

function setProspectAuthMode(mode) {
  prospectAuthMode = mode === 'login' ? 'login' : 'register';
  const tabReg = document.getElementById('tab-btn-register');
  const tabLog = document.getElementById('tab-btn-login');
  const nameField = document.getElementById('field-prospect-name');
  const submitBtn = document.getElementById('btn-prospect-submit-auth');
  const title = document.querySelector('#prospect-gate-auth .prospect-gate-title');

  if (tabReg) {
    tabReg.classList.toggle('is-active', prospectAuthMode === 'register');
    tabReg.setAttribute('aria-selected', prospectAuthMode === 'register');
  }
  if (tabLog) {
    tabLog.classList.toggle('is-active', prospectAuthMode === 'login');
    tabLog.setAttribute('aria-selected', prospectAuthMode === 'login');
  }
  if (nameField) {
    nameField.classList.toggle('hidden', prospectAuthMode === 'login');
    if (prospectAuthMode === 'login') nameField.setAttribute('hidden', '');
    else nameField.removeAttribute('hidden');
  }
  if (submitBtn) {
    submitBtn.textContent = prospectAuthMode === 'register' ? 'Crear Cuenta y Continuar →' : 'Iniciar Sesión →';
  }
  if (title) {
    title.textContent = prospectAuthMode === 'register' ? 'Identifícate para crear tu ServiBot' : 'Inicia sesión para tu ServiBot';
  }
  setFeedback('prospect-auth-feedback', '');
}

function showProspectContactStep(user, isEditing = false) {
  const gateShell = document.getElementById('prospect-gate-shell');
  const gateAuth = document.getElementById('prospect-gate-auth');
  const gateContact = document.getElementById('prospect-gate-contact');
  const unlocked = document.getElementById('wizard-unlocked-content');
  if (!gateShell || !gateContact) return;

  gateShell.classList.remove('hidden');
  gateShell.removeAttribute('hidden');
  gateAuth?.classList.add('hidden');
  gateAuth?.setAttribute('hidden', '');
  gateContact.classList.remove('hidden');
  gateContact.removeAttribute('hidden');
  unlocked?.classList.add('hidden');
  unlocked?.setAttribute('hidden', '');

  const isGoogle = Boolean(user.providerData?.some((p) => p.providerId === 'google.com'));
  const heading = document.getElementById('prospect-contact-heading');
  const sub = document.getElementById('prospect-contact-sub');

  if (heading && sub) {
    if (isGoogle) {
      heading.textContent = 'Confirma tus datos de contacto detectados de Google';
      sub.textContent = `Detectamos tu cuenta de Google (${user.email}). Por favor verifica tus datos e indícanos tu número de celular para asociarlo a tu ServiBot:`;
    } else {
      heading.textContent = 'Completa tus datos de contacto';
      sub.textContent = `Para crear y asociar tu ServiBot a tu cuenta (${user.email}), completa tus datos y número de celular para darte seguimiento:`;
    }
  }

  const nameInput = document.getElementById('prospect-input-name');
  const emailInput = document.getElementById('prospect-input-email');
  const phoneInput = document.getElementById('prospect-input-phone');
  const bizInput = document.getElementById('prospect-input-business');
  const termsChk = document.getElementById('prospect-terms-checkbox');

  if (emailInput) emailInput.value = user.email || '';
  if (nameInput && (!nameInput.value || isEditing)) {
    nameInput.value = prospectProfile?.name || user.displayName || '';
  }
  if (phoneInput && (!phoneInput.value || isEditing)) {
    phoneInput.value = prospectProfile?.phone || user.phoneNumber || '';
  }
  if (bizInput && (!bizInput.value || isEditing)) {
    bizInput.value = prospectProfile?.business || '';
  }
  if (termsChk && isEditing) {
    termsChk.checked = true;
  }
  setFeedback('prospect-contact-feedback', '');
}

function unlockWizardWithProspect(profile) {
  const gateShell = document.getElementById('prospect-gate-shell');
  const unlocked = document.getElementById('wizard-unlocked-content');
  if (!gateShell || !unlocked) return;

  gateShell.classList.add('hidden');
  gateShell.setAttribute('hidden', '');
  unlocked.classList.remove('hidden');
  unlocked.removeAttribute('hidden');

  const barName = document.getElementById('bar-prospect-name');
  const barBiz = document.getElementById('bar-prospect-business');
  const barPhone = document.getElementById('bar-prospect-phone');
  const barEmail = document.getElementById('bar-prospect-email');
  if (barName) barName.textContent = profile.name || 'Cliente';
  if (barBiz) barBiz.textContent = profile.business || 'Empresa';
  if (barPhone) barPhone.textContent = profile.phone || '';
  if (barEmail) barEmail.textContent = currentUser?.email || '-';

  const topbarUserBtn = document.getElementById('btn-topbar-user');
  const topbarUserName = document.getElementById('topbar-user-name');
  if (topbarUserBtn) {
    topbarUserBtn.classList.remove('hidden');
    topbarUserBtn.removeAttribute('hidden');
  }
  if (topbarUserName) {
    topbarUserName.textContent = profile.name || currentUser?.displayName || 'Mi Cuenta';
  }

  // Pre-llenar paso 1 del wizard si está vacío o difiere
  const cfgName = document.getElementById('cfg-client-name');
  const cfgContact = document.getElementById('cfg-client-contact');
  const cfgBiz = document.getElementById('cfg-business-name');
  if (cfgName && (!cfgName.value.trim() || cfgName.value.trim() === 'Mariana López')) {
    cfgName.value = profile.name;
  }
  if (cfgContact && (!cfgContact.value.trim() || cfgContact.value.trim() === '8112345678')) {
    cfgContact.value = profile.phone;
  }
  if (cfgBiz && (!cfgBiz.value.trim() || cfgBiz.value.trim() === 'Clínica Dental Sonrisa Norte')) {
    cfgBiz.value = profile.business;
  }
}

function syncProspectGateUI() {
  const gateShell = document.getElementById('prospect-gate-shell');
  const gateAuth = document.getElementById('prospect-gate-auth');
  const gateContact = document.getElementById('prospect-gate-contact');
  const unlocked = document.getElementById('wizard-unlocked-content');
  if (!gateShell) return;

  if (!currentUser) {
    const topbarUserBtn = document.getElementById('btn-topbar-user');
    if (topbarUserBtn) {
      topbarUserBtn.classList.add('hidden');
      topbarUserBtn.setAttribute('hidden', '');
    }
    gateShell.classList.remove('hidden');
    gateShell.removeAttribute('hidden');
    gateAuth?.classList.remove('hidden');
    gateAuth?.removeAttribute('hidden');
    gateContact?.classList.add('hidden');
    gateContact?.setAttribute('hidden', '');
    unlocked?.classList.add('hidden');
    unlocked?.setAttribute('hidden', '');
    setProspectAuthMode(prospectAuthMode);
    return;
  }

  const topbarUserBtn = document.getElementById('btn-topbar-user');
  const topbarUserName = document.getElementById('topbar-user-name');
  if (topbarUserBtn) {
    topbarUserBtn.classList.remove('hidden');
    topbarUserBtn.removeAttribute('hidden');
  }
  if (topbarUserName) {
    topbarUserName.textContent =
      prospectProfile?.name ||
      currentUser.displayName ||
      currentUser.email?.split('@')[0] ||
      'Mi Cuenta';
  }

  // Hay usuario autenticado con Firebase Auth
  const hasValidProfile = Boolean(
    prospectProfile &&
      prospectProfile.uid === currentUser.uid &&
      prospectProfile.phone &&
      prospectProfile.business &&
      prospectProfile.name
  );

  if (hasValidProfile) {
    unlockWizardWithProspect(prospectProfile);
  } else {
    showProspectContactStep(currentUser);
  }
}

function buildAdminEndpoint(endpoint) {
  const isSuper = Boolean(currentAdminMeta?.is_superadmin || currentUser?.email?.toLowerCase() === 'fraustop@outlook.com');
  if (!isSuper || !adminSelectedInstanceId) return endpoint;
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}instance_id=${encodeURIComponent(adminSelectedInstanceId)}`;
}

function getSelectedAdminInstanceId() {
  const isSuper = Boolean(currentAdminMeta?.is_superadmin || currentUser?.email?.toLowerCase() === 'fraustop@outlook.com');
  if (isSuper) return adminSelectedInstanceId || 'servibot-00';
  return currentAdminMeta?.assigned_instance_id || 'servibot-01';
}

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
  if (location.port === '10000' || location.hostname.endsWith('.cloudfront.net')) {
    API_BASE = window.location.origin;
    syncApiOverrideInput();
    return;
  }

  const isLocalHostPage = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  // 1) En servidor dev local, intentar backend local primero
  if (isLocalHostPage && (await isBackendReachable('http://localhost:10000', 1800))) {
    API_BASE = 'http://localhost:10000';
    syncApiOverrideInput();
    return;
  }

  // 2) Intentar override manual guardado (excluyendo localhost si estamos en Hosting público)
  const savedBase = (localStorage.getItem('servibot_api_base') || '').trim().replace(/\/+$/, '');
  if (savedBase && (isLocalHostPage || !savedBase.includes('localhost'))) {
    if (await isBackendReachable(savedBase, 2500)) {
      API_BASE = savedBase;
      syncApiOverrideInput();
      return;
    }
    localStorage.removeItem('servibot_api_base');
  }

  // 3) Leer URL vigente del servidor remoto publicada en Hosting (/runtime-backend.json)
  try {
    const rt = await fetch('/runtime-backend.json', { cache: 'no-store' });
    if (rt.ok) {
      const cfg = await rt.json();
      if (cfg.tunnelUrl) {
        const candidate = cfg.tunnelUrl.trim().replace(/\/+$/, '');
        if (candidate.endsWith('.cloudfront.net') || (await isBackendReachable(candidate, 2500))) {
          API_BASE = candidate;
          syncApiOverrideInput();
          return;
        }
      }
    }
  } catch {
    // ignorar error de runtime-backend.json
  }

  if (await isBackendReachable('http://localhost:10000', 1500)) {
    API_BASE = 'http://localhost:10000';
    syncApiOverrideInput();
    return;
  }

  API_BASE = 'https://dqo1j67xmphbf.cloudfront.net';
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
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers
    });

    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.statusCode == null) {
        parsed.statusCode = res.status;
      }
      return parsed;
    } catch {
      return { ok: false, statusCode: res.status, error: text || `Error HTTP ${res.status}` };
    }
  } catch (err) {
    console.warn(`[apiFetch] Falló la petición a ${API_BASE}${endpoint}:`, err);
    return {
      ok: false,
      statusCode: 0,
      error: `Error de conexión con el servidor (${err.message || 'sin conexión'}).`
    };
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
  siteHeader?.classList.remove('hidden');

  document.querySelectorAll('.admin-nav-item').forEach((el) => {
    el.classList.toggle('hidden', !isAuthenticatedAdmin);
  });
  document.querySelectorAll('.public-nav-item').forEach((el) => {
    el.classList.toggle('hidden', isAuthenticatedAdmin);
  });

  const navLoginLabel = document.getElementById('btn-nav-login-label');
  if (navLoginLabel) {
    navLoginLabel.textContent = currentUser ? 'Mi Panel Admin' : 'Iniciar Sesión / Admin';
  }

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
    closeMobileSimulator();
    viewPublic?.classList.add('hidden');
    viewAdmin?.classList.remove('hidden');
    syncHeaderAndNavigation();
    if (currentUser) {
      const gate = document.getElementById('auth-gate');
      const dash = document.getElementById('admin-dashboard');
      setFeedback('auth-status-msg', 'Verificando sesión administrativa...', true);
      apiFetch('/api/admin/me')
        .then((me) => {
          if (me?.ok) {
            gate?.classList.add('hidden');
            dash?.classList.remove('hidden');
            setFeedback('auth-status-msg', '');
            syncAdminRoleUI(me);
            syncHeaderAndNavigation();
            switchAdminTab(activeAdminTab);
            loadAllAdminData();
          } else {
            gate?.classList.remove('hidden');
            dash?.classList.add('hidden');
            setFeedback('auth-status-msg', me?.error || 'Tu cuenta no tiene rol de Administrador. Si eres cliente, regresa al inicio.', false);
          }
        })
        .catch((err) => {
          gate?.classList.remove('hidden');
          dash?.classList.add('hidden');
          setFeedback('auth-status-msg', `No se pudo conectar con el servidor: ${err.message}`, false);
        });
    } else {
      setFeedback('auth-status-msg', '');
      requestAnimationFrame(() => document.getElementById('auth-email')?.focus());
    }
  } else {
    viewAdmin?.classList.add('hidden');
    viewPublic?.classList.remove('hidden');
    syncHeaderAndNavigation();
    syncProspectGateUI();
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
  const autoplayBtns = Array.from(carousel.querySelectorAll('[data-autoplay-toggle]'));
  const AUTOPLAY_INTERVAL_MS = 5000;

  let pendingTarget = null;
  let pendingAnnounce = false;
  let scrollGeneration = 0;
  let lastSettledIndex = 0;
  let liveMarkerIndex = 0;
  let rafScheduled = false;
  let settleTimer = null;
  let autoplayPaused = prefersReducedMotion();
  let autoplayTimer = null;

  function syncAutoplayButtons() {
    autoplayBtns.forEach((btn) => {
      btn.dataset.paused = String(autoplayPaused);
      btn.setAttribute(
        'aria-label',
        autoplayPaused ? 'Reanudar carrusel automático' : 'Pausar carrusel automático'
      );
      const iconEl = btn.querySelector('[data-autoplay-icon]');
      const textEl = btn.querySelector('[data-autoplay-text]');
      if (iconEl) iconEl.textContent = autoplayPaused ? '▶' : '⏸';
      if (textEl) textEl.textContent = autoplayPaused ? 'Reanudar' : 'Pausar';
    });
  }

  function canAutoplayAdvance() {
    if (autoplayPaused || document.hidden || activeView !== 'public') return false;
    if (carousel.dataset.activeSection === 'offer') return false;
    const panel = document.getElementById('simulator-panel');
    if (panel?.classList.contains('is-mobile-open')) return false;
    return true;
  }

  function stopAutoplay() {
    if (autoplayTimer !== null) {
      clearInterval(autoplayTimer);
      autoplayTimer = null;
    }
  }

  function scheduleAutoplay() {
    stopAutoplay();
    if (autoplayPaused) return;
    autoplayTimer = setInterval(() => {
      if (!canAutoplayAdvance()) return;
      const maxDescIndex = offerSlideIndex > 0 ? offerSlideIndex - 1 : slides.length - 1;
      const currentIndex = pendingTarget ?? getNearestSlideIndex();
      if (currentIndex > maxDescIndex) return;
      const nextIndex = currentIndex >= maxDescIndex ? 0 : currentIndex + 1;
      goToSlide(nextIndex, { announce: false, fromAutoplay: true });
    }, AUTOPLAY_INTERVAL_MS);
  }

  // Generar botones marcadores principales de sección (01 · Descripción, 02 · La Oferta)
  markersNav.innerHTML = '';
  const markers = sections.map((sec, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = sec.label;
    btn.setAttribute('aria-label', sec.label);
    btn.dataset.section = sec.key;
    if (idx === 0) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => goToSlide(sec.targetIndex, { announce: true, instant: true }));
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
    carousel.dataset.activeSection = activeSection;
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
    // Recorrido finito dentro de las diapositivas de descripción (las flechas se ocultan en Configuración)
    const maxDescIndex = offerSlideIndex > 0 ? offerSlideIndex - 1 : slides.length - 1;
    prevBtn.disabled = index <= 0;
    nextBtn.disabled = index >= maxDescIndex;
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

  function goToSlide(targetIndex, { announce = true, instant = false, fromAutoplay = false } = {}) {
    if (!fromAutoplay) {
      scheduleAutoplay();
    }
    const clamped = Math.max(0, Math.min(slides.length - 1, targetIndex));
    const currentIndex = pendingTarget ?? getNearestSlideIndex();
    if (clamped === currentIndex && pendingTarget === null) {
      updateEndControls(clamped);
      return;
    }

    pendingTarget = clamped;
    pendingAnnounce = Boolean(announce);
    scrollGeneration += 1;
    const gen = scrollGeneration;
    clearTimeout(settleTimer);

    // Actualizar el marcador al instante al hacer clic
    applyMarkerCurrent(clamped);

    const targetSlide = slides[clamped];
    if (targetSlide) {
      targetSlide.scrollTop = 0;
    }
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
    const sr = targetSlide.getBoundingClientRect();
    const tr = track.getBoundingClientRect();
    const delta = sr.left + sr.width / 2 - (tr.left + tr.width / 2);

    if (Math.abs(delta) < 1) {
      settleNavigation(gen, announce);
      return;
    }

    const currentSection = slides[currentIndex]?.dataset.section || 'description';
    const targetSection = targetSlide?.dataset.section || 'description';
    const useInstant = Boolean(
      instant
      || prefersReducedMotion()
      || currentSection !== targetSection
    );

    if (useInstant) {
      track.style.scrollBehavior = 'auto';
      track.style.scrollSnapType = 'none';
      track.scrollLeft += delta;
      void track.offsetWidth;
      track.style.scrollSnapType = '';
      track.style.scrollBehavior = '';
      settleNavigation(gen, announce);
      return;
    }

    track.scrollBy({
      left: delta,
      behavior: 'smooth'
    });

    if (!('onscrollend' in window)) {
      settleTimer = setTimeout(() => settleNavigation(gen, announce), 160);
    }
  }

  prevBtn.addEventListener('click', () => {
    const baseIndex = pendingTarget ?? getNearestSlideIndex();
    goToSlide(baseIndex - 1, { announce: true });
  });

  nextBtn.addEventListener('click', () => {
    const baseIndex = pendingTarget ?? getNearestSlideIndex();
    const maxDescIndex = offerSlideIndex > 0 ? offerSlideIndex - 1 : slides.length - 1;
    goToSlide(Math.min(maxDescIndex, baseIndex + 1), { announce: true });
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
      settleTimer = setTimeout(
        () => settleNavigation(gen, pendingTarget !== null ? pendingAnnounce : true),
        140
      );
    }
  }, { passive: true });

  if ('onscrollend' in window) {
    track.addEventListener('scrollend', () => {
      const shouldAnnounce = pendingTarget !== null ? pendingAnnounce : true;
      settleNavigation(scrollGeneration, shouldAnnounce);
    });
  }

  autoplayBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      autoplayPaused = !autoplayPaused;
      syncAutoplayButtons();
      scheduleAutoplay();
    });
  });

  carousel.addEventListener(
    'pointerdown',
    () => {
      if (!autoplayPaused) scheduleAutoplay();
    },
    { passive: true }
  );

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoplay();
    else scheduleAutoplay();
  });

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
  syncAutoplayButtons();
  scheduleAutoplay();

  return {
    goToSlide,
    syncActiveSlideInstant,
    scheduleAutoplay,
    stopAutoplay
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
    loadMicrosoftChannelStatus();
    refreshHealth();
  } else if (activeAdminTab === 'tab-orders' && currentUser) {
    loadAdminOrders();
  } else if (activeAdminTab === 'tab-bot-soul' && currentUser) {
    loadAdminBotSoul();
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

function buildAssistantIdentityHeader(mode, inst = provisionedInstance) {
  if (mode === 'custom' && inst) {
    const customName = `${inst.display_name || 'Mi ServiBot'} · ${inst.business_name || 'Tu Negocio'}`;
    return `<div class="bubble-identity bubble-identity-custom"><span class="bubble-bot-emoji" aria-hidden="true">🤖</span><strong>${escapeHtml(customName)}</strong></div>`;
  }
  return `<div class="bubble-identity bubble-identity-official"><img src="/assets/servibot-logo.png" alt="" width="18" height="18" decoding="async" /><strong>Asesor Oficial Servi-Bot</strong></div>`;
}

function toggleVisibilityPair(imgEl, emojiEl, showCustomEmoji) {
  if (imgEl) {
    imgEl.classList.toggle('hidden', showCustomEmoji);
    if (showCustomEmoji) imgEl.setAttribute('hidden', '');
    else imgEl.removeAttribute('hidden');
  }
  if (emojiEl) {
    emojiEl.classList.toggle('hidden', !showCustomEmoji);
    if (showCustomEmoji) emojiEl.removeAttribute('hidden');
    else emojiEl.setAttribute('hidden', '');
  }
}

function syncSimulatorHeaderLabel(inst = provisionedInstance) {
  const panel = document.getElementById('simulator-panel');
  const fabBtn = document.getElementById('btn-sim-fab');
  const topbarBtn = document.getElementById('btn-topbar-sim');
  const badgeEl = document.getElementById('sim-mode-badge');
  const titleEl = document.getElementById('sim-header-title');
  const activeLbl = document.getElementById('sim-active-instance-label');
  const switchOfficialBtn = document.getElementById('btn-switch-official-bot');
  const switchCustomBtn = document.getElementById('btn-switch-custom-bot');
  const switchCustomLbl = document.getElementById('sim-switch-custom-label');
  const fabText = document.getElementById('sim-fab-text');
  const topbarLbl = document.getElementById('topbar-sim-label');
  const chatInput = document.getElementById('chat-input');

  const hasCustom = Boolean(
    inst &&
      inst.instance_id &&
      !inst.locked_for_public &&
      inst.business_name &&
      !String(inst.business_name).startsWith('Espacio Disponible')
  );
  if (!hasCustom && activeBotMode === 'custom') {
    activeBotMode = 'official';
  }

  const isCustom = activeBotMode === 'custom' && hasCustom;
  activeChatInstanceId = isCustom ? inst.instance_id : 'servibot-00';

  if (panel) panel.dataset.botMode = isCustom ? 'custom' : 'official';
  if (fabBtn) fabBtn.dataset.botMode = isCustom ? 'custom' : 'official';
  topbarBtn?.classList.toggle('is-custom-mode', isCustom);

  toggleVisibilityPair(
    document.getElementById('sim-bot-avatar-img'),
    document.getElementById('sim-bot-avatar-emoji'),
    isCustom
  );
  toggleVisibilityPair(document.getElementById('sim-fab-img'), document.getElementById('sim-fab-emoji'), isCustom);
  toggleVisibilityPair(
    document.getElementById('topbar-sim-icon-img'),
    document.getElementById('topbar-sim-icon-emoji'),
    isCustom
  );

  const customName =
    (hasCustom && inst && (inst.display_name || inst.business_name)) ||
    document.getElementById('cfg-display-name')?.value.trim() ||
    document.getElementById('cfg-business-name')?.value.trim() ||
    'Mi Bot';

  if (switchCustomLbl) {
    switchCustomLbl.textContent = customName;
  }
  if (switchOfficialBtn) {
    switchOfficialBtn.classList.toggle('is-active', !isCustom);
    switchOfficialBtn.setAttribute('aria-pressed', String(!isCustom));
  }
  if (switchCustomBtn) {
    switchCustomBtn.classList.toggle('is-active', isCustom);
    switchCustomBtn.setAttribute('aria-pressed', String(isCustom));
  }

  const lateralTabLbl = document.getElementById('sim-tab-label');
  const lateralTabIcon = document.getElementById('sim-tab-icon');
  if (lateralTabLbl) {
    lateralTabLbl.textContent = isCustom ? customName : 'ServiBot';
  }
  if (lateralTabIcon) {
    lateralTabIcon.textContent = isCustom ? '🤖' : '💬';
  }

  if (isCustom) {
    if (badgeEl) badgeEl.textContent = '🤖 BOT CREADO · EN VIVO';
    if (titleEl) titleEl.textContent = customName;
    if (activeLbl) activeLbl.textContent = `Atendiendo a ${inst?.business_name || 'tu negocio'}`;
    if (fabText) fabText.textContent = customName;
    if (topbarLbl) topbarLbl.textContent = customName;
    if (chatInput) chatInput.placeholder = `Escríbele como cliente a ${customName}...`;
  } else {
    if (badgeEl) badgeEl.textContent = 'ASESOR OFICIAL SERVI-BOT';
    if (titleEl) titleEl.textContent = 'Asesor Comercial Servi-Bot';
    if (activeLbl) activeLbl.textContent = 'En línea · Información y Contratación';
    if (fabText) fabText.textContent = 'Asesor Servi-Bot';
    if (topbarLbl) topbarLbl.textContent = 'Abrir Bot';
    if (chatInput) chatInput.placeholder = 'Pregúntale al Asesor Oficial Servi-Bot...';
  }

  updateQuickPrompts(isCustom, inst);
}

function setSimulatorBotMode(mode, { announceGreeting = false } = {}) {
  const hasCustom = Boolean(
    provisionedInstance &&
      provisionedInstance.instance_id &&
      provisionedInstance.business_name &&
      !String(provisionedInstance.business_name).startsWith('Espacio Disponible')
  );

  if (mode === 'custom' && !hasCustom) {
    activeBotMode = 'official';
    syncSimulatorHeaderLabel(provisionedInstance);
    closeMobileSimulator();
    carouselController?.goToSlide?.(3, { instant: true });
    goToWizardStep(1, { focusHeading: true });
    return false;
  }

  activeBotMode = mode === 'custom' ? 'custom' : 'official';
  syncSimulatorHeaderLabel(provisionedInstance);

  if (announceGreeting) {
    const box = document.getElementById('chat-messages');
    if (box) {
      if (activeBotMode === 'custom' && provisionedInstance) {
        const greeting =
          provisionedInstance.welcome_message ||
          `¡Hola! Soy ${provisionedInstance.display_name} de ${provisionedInstance.business_name}. ¿En qué te ayudo hoy?`;
        box.innerHTML = `<div class="chat-bubble assistant is-custom-bot">${buildAssistantIdentityHeader('custom', provisionedInstance)}${escapeHtml(greeting)}</div>`;
      } else {
        const officialMsg =
          '¡Hola! Soy el Asesor Oficial de Servi-Bot. Pregúntame sobre nuestros planes, funcionamiento o cómo automatizar WhatsApp, Outlook y Teams.';
        box.innerHTML = `<div class="chat-bubble assistant is-official-bot">${buildAssistantIdentityHeader('official', null)}${escapeHtml(officialMsg)}</div>`;
      }
      box.scrollTop = box.scrollHeight;
    }
  }
  return true;
}

function openMobileSimulator(triggerEl = null) {
  const panel = document.getElementById('simulator-panel');
  const backdrop = document.getElementById('sim-backdrop');
  const fabBtn = document.getElementById('btn-sim-fab');
  const topbarBtn = document.getElementById('btn-topbar-sim');
  const input = document.getElementById('chat-input');

  const isMobileViewport = window.matchMedia?.('(max-width: 979px)')?.matches;
  if (!isMobileViewport) {
    input?.focus();
    return;
  }

  mobileSimTriggerEl = triggerEl || document.activeElement;
  panel?.classList.add('is-mobile-open');
  if (backdrop) {
    backdrop.classList.remove('hidden');
    backdrop.removeAttribute('hidden');
  }
  fabBtn?.setAttribute('aria-expanded', 'true');
  topbarBtn?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => input?.focus({ preventScroll: true }));
}

function closeMobileSimulator() {
  const panel = document.getElementById('simulator-panel');
  const backdrop = document.getElementById('sim-backdrop');
  const fabBtn = document.getElementById('btn-sim-fab');
  const topbarBtn = document.getElementById('btn-topbar-sim');

  const wasOpen = panel?.classList.contains('is-mobile-open');
  panel?.classList.remove('is-mobile-open');
  if (backdrop) {
    backdrop.classList.add('hidden');
    backdrop.setAttribute('hidden', '');
  }
  fabBtn?.setAttribute('aria-expanded', 'false');
  topbarBtn?.setAttribute('aria-expanded', 'false');
  if (wasOpen && mobileSimTriggerEl && typeof mobileSimTriggerEl.focus === 'function') {
    mobileSimTriggerEl.focus({ preventScroll: true });
  }
  mobileSimTriggerEl = null;
}

function updateQuickPrompts(isCustom, inst = provisionedInstance) {
  const container = document.querySelector('.bot-quick-prompts');
  if (!container) return;

  if (isCustom) {
    const bizName = inst?.business_name || document.getElementById('cfg-business-name')?.value.trim() || 'tu negocio';
    container.innerHTML = `
      <button type="button" class="quick-chip" data-prompt="Hola, ¿qué servicios o productos ofrecen y cuáles son sus costos?">¿Qué servicios tienen?</button>
      <button type="button" class="quick-chip" data-prompt="¿Cuáles son sus horarios de atención y su ubicación?">Horarios y Ubicación</button>
      <button type="button" class="quick-chip" data-prompt="Hola, me gustaría agendar una cita o hacer un pedido en ${bizName}.">Agendar Cita / Pedido</button>
    `;
  } else {
    container.innerHTML = `
      <button type="button" class="quick-chip" data-prompt="Hola, ¿qué servicios ofrecen y cuáles son sus precios?">¿Qué planes tienen?</button>
      <button type="button" class="quick-chip" data-prompt="¿Cómo funciona el bot de WhatsApp, Correo y Teams sin tokens?">¿Cómo funciona sin tokens?</button>
      <button type="button" class="quick-chip" data-prompt="Quiero contratar el servicio de Bots Autónomos, mi nombre es Carlos Ruiz y mi correo es carlos@negocio.mx, confirma mi pedido.">¡Contratar Bots Autónomos!</button>
    `;
  }

  container.querySelectorAll('.quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const promptText = chip.dataset.prompt;
      if (promptText) sendChatMessage(promptText);
    });
  });
}

function toggleSimulatorMinimize(forceState) {
  const stage = document.querySelector('.public-stage');
  const lateralTab = document.getElementById('btn-expand-sim-tab');
  const isMobile = window.matchMedia('(max-width: 979px)').matches;

  if (isMobile) {
    closeMobileSimulator();
    return;
  }

  if (!stage) return;
  const shouldMinimize = typeof forceState === 'boolean'
    ? forceState
    : !stage.classList.contains('sim-minimized');

  stage.classList.toggle('sim-minimized', shouldMinimize);
  if (lateralTab) {
    lateralTab.classList.toggle('hidden', !shouldMinimize);
    if (shouldMinimize) {
      lateralTab.removeAttribute('hidden');
    } else {
      lateralTab.setAttribute('hidden', '');
    }
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
    3: 'Paso 3 de 3 · Simulador y Costo'
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

  const productsText = Array.isArray(inst.catalog)
    ? inst.catalog
        .map((item) => {
          const parts = [String(item.title || '').trim(), item.price != null ? String(item.price) : '0'];
          if (item.description) parts.push(String(item.description).trim());
          return parts.join(' | ');
        })
        .filter(Boolean)
        .join('\n')
    : (inst.initial_products || '');
  setVal('cfg-initial-products', productsText);
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

function toggleCheckoutPanel(showCheckout) {
  const overview = document.getElementById('wizard-cost-overview');
  const checkout = document.getElementById('wizard-checkout-panel');
  if (!overview || !checkout) return;

  const show = Boolean(showCheckout);
  overview.classList.toggle('hidden', show);
  checkout.classList.toggle('hidden', !show);
  if (show) {
    overview.setAttribute('hidden', '');
    checkout.removeAttribute('hidden');
    updateCheckoutPricing();
    const title = document.getElementById('wizard-checkout-title');
    if (title) requestAnimationFrame(() => title.focus({ preventScroll: true }));
  } else {
    checkout.setAttribute('hidden', '');
    overview.removeAttribute('hidden');
  }
}

function resetCheckoutMpCta() {
  const wrap = document.getElementById('checkout-mp-cta-wrap');
  const link = document.getElementById('btn-mp-pay-now');
  if (wrap) {
    wrap.classList.add('hidden');
    wrap.setAttribute('hidden', '');
  }
  if (link) {
    link.setAttribute('href', '#');
    link.textContent = 'Pagar ahora en Mercado Pago ↗';
  }
}

function updateCheckoutPricing() {
  const BASE_BOT_PRICE = 1500;
  const TAX_RATE = 0.16;
  const checks = Array.from(document.querySelectorAll('.checkout-addon-check'));
  const selectedAddons = checks
    .filter((chk) => chk.checked)
    .map((chk) => ({
      slug: chk.dataset.slug || chk.id,
      label: chk.dataset.label || 'Servicio adicional',
      price: Number(chk.value || 0)
    }));

  const addonsTotal = selectedAddons.reduce((sum, item) => sum + item.price, 0);
  const subtotal = BASE_BOT_PRICE + addonsTotal;
  const taxAmount = Math.round(subtotal * TAX_RATE);
  const totalWithTax = subtotal + taxAmount;

  const fmtSubtotal = `$${subtotal.toLocaleString('es-MX')}`;
  const fmtTax = `$${taxAmount.toLocaleString('es-MX')}`;
  const fmtTotal = `$${totalWithTax.toLocaleString('es-MX')}`;

  const subtotalEl = document.getElementById('checkout-subtotal-amount');
  const taxEl = document.getElementById('checkout-tax-amount');
  const totalEl = document.getElementById('checkout-total-amount');
  const breakdownEl = document.getElementById('checkout-total-breakdown');
  const confirmBtn = document.getElementById('btn-confirm-checkout');

  if (subtotalEl) {
    subtotalEl.textContent = `${fmtSubtotal} pesos`;
  }
  if (taxEl) {
    taxEl.textContent = `+${fmtTax} pesos (16%)`;
  }
  if (totalEl) {
    totalEl.textContent = `${fmtTotal} pesos (${fmtSubtotal} + ${fmtTax} IVA)`;
  }
  if (breakdownEl) {
    breakdownEl.textContent = selectedAddons.length
      ? `Incluye Bot configurado ($1,500) + ${selectedAddons.map((a) => `${a.label} ($${a.price})`).join(' + ')} = ${fmtSubtotal} + ${fmtTax} IVA (16%) = ${fmtTotal} MXN.`
      : `Incluye únicamente tu bot ServiBot configurado ($1,500) + $240 IVA México (16%) = $1,740 MXN.`;
  }
  if (confirmBtn && !confirmBtn.disabled) {
    confirmBtn.textContent = `Pagar con Mercado Pago (${fmtTotal} MXN IVA incl.) →`;
  }

  return { basePrice: BASE_BOT_PRICE, selectedAddons, addonsTotal, subtotal, taxRate: TAX_RATE, taxAmount, totalWithTax };
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

function clearLockedWizardBanner() {
  const banner = document.getElementById('wizard-locked-banner');
  const createdCard = document.getElementById('wizard-created-card');
  const pricingCard = document.getElementById('wizard-pricing-card');
  if (banner) {
    banner.classList.add('hidden');
    banner.setAttribute('hidden', '');
  }
  if (createdCard) {
    createdCard.classList.remove('hidden');
    createdCard.removeAttribute('hidden');
  }
  if (pricingCard) {
    pricingCard.classList.remove('hidden');
    pricingCard.removeAttribute('hidden');
  }
}

function renderLockedWizardState(instOrLock) {
  const banner = document.getElementById('wizard-locked-banner');
  const titleEl = document.getElementById('wizard-locked-title');
  const descEl = document.getElementById('wizard-locked-desc');
  const createdCard = document.getElementById('wizard-created-card');
  const pricingCard = document.getElementById('wizard-pricing-card');

  const instId = instOrLock?.instance_id || clientInstanceId || '';
  const exp = instOrLock?.subscription_expires_at || '';
  const expText = exp ? ` · Vigencia hasta ${new Date(exp).toLocaleDateString('es-MX')}` : '';

  if (titleEl) {
    titleEl.textContent = `🔒 Instancia ${instId || 'Contratada'} Bloqueada · Plan Mensual (30 Días Naturales${expText})`;
  }
  if (descEl) {
    descEl.textContent =
      instOrLock?.message ||
      'Esta instancia ya realizó su pago y quedó bloqueada e inaccesible para edición o chat en la interfaz pública. Inicia sesión en tu Panel Admin Estándar para administrarla.';
  }

  if (banner) {
    banner.classList.remove('hidden');
    banner.removeAttribute('hidden');
  }
  if (createdCard) {
    createdCard.classList.add('hidden');
    createdCard.setAttribute('hidden', '');
  }
  if (pricingCard) {
    pricingCard.classList.add('hidden');
    pricingCard.setAttribute('hidden', '');
  }

  activeBotMode = 'official';
  activeChatInstanceId = 'servibot-00';
  provisionedInstance = null;
  syncSimulatorHeaderLabel(null);
}

function resetWizardForNewBot() {
  clientInstanceId = '';
  provisionedInstance = null;
  activeChatInstanceId = 'servibot-00';
  localStorage.removeItem('servibot_client_instance_id');
  clearLockedWizardBanner();

  const form = document.getElementById('servibot-wizard-form');
  form?.reset();
  const idInput = document.getElementById('cfg-instance-id');
  if (idInput) idInput.value = '';
  const initProdInput = document.getElementById('cfg-initial-products');
  if (initProdInput) initProdInput.value = '';

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

  document.querySelectorAll('.checkout-addon-check').forEach((chk) => {
    chk.checked = true;
  });

  setFeedback('wizard-step-1-error', '');
  setFeedback('instance-save-status', '');
  setFeedback('checkout-feedback', '');
  setFeedback('wizard-recover-status', '');
  resetCheckoutMpCta();
  toggleCheckoutPanel(false);
  updateCheckoutPricing();
  activeBotMode = 'official';
  syncSimulatorHeaderLabel(null);
  updateWizardLivePreview();
  goToWizardStep(1, { focusHeading: true });
}

async function loadClientProvisionedInstance({ populateForm = true } = {}) {
  if (!clientInstanceId) {
    clearLockedWizardBanner();
    activeBotMode = 'official';
    activeChatInstanceId = 'servibot-00';
    syncSimulatorHeaderLabel(null);
    if (populateForm) {
      updateWizardLivePreview();
      updateCheckoutPricing();
      goToWizardStep(wizardCurrentStep || 1);
    }
    return;
  }

  try {
    const data = await apiFetch(`/api/instances/${encodeURIComponent(clientInstanceId)}`);
    if (!data.ok || (!data.instance && !data.locked)) {
      throw new Error('Instancia previa no disponible');
    }

    if (data.locked || data.instance?.locked_for_public) {
      renderLockedWizardState(data.locked ? data : data.instance);
      if (populateForm) {
        goToWizardStep(3);
      }
      return;
    }

    const inst = data.instance;
    const isUnconfigured =
      String(inst.business_name || '').startsWith('Espacio Disponible') && !String(inst.client_name || '').trim();
    if (isUnconfigured) {
      clientInstanceId = '';
      localStorage.removeItem('servibot_client_instance_id');
      clearLockedWizardBanner();
      activeBotMode = 'official';
      activeChatInstanceId = 'servibot-00';
      syncSimulatorHeaderLabel(null);
      return;
    }

    clearLockedWizardBanner();
    const enriched = { ...inst, catalog: Array.isArray(data.catalog) ? data.catalog : inst.catalog };
    provisionedInstance = enriched;
    activeBotMode = 'custom';
    activeChatInstanceId = inst.instance_id;
    syncSimulatorHeaderLabel(enriched);
    renderWizardSummary(enriched);
    updateCheckoutPricing();

    if (populateForm) {
      populateWizardForm(enriched);
      goToWizardStep(3);
    }
  } catch (err) {
    if (err?.status === 423 || err?.payload?.locked) {
      renderLockedWizardState(err.payload || { instance_id: clientInstanceId, message: err.message });
      if (populateForm) goToWizardStep(3);
      return;
    }
    clientInstanceId = '';
    localStorage.removeItem('servibot_client_instance_id');
    clearLockedWizardBanner();
    activeBotMode = 'official';
    activeChatInstanceId = 'servibot-00';
    syncSimulatorHeaderLabel(null);
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
        setSimulatorBotMode('official', { announceGreeting: false });
        openMobileSimulator(btn);
        const input = document.getElementById('chat-input');
        if (input) {
          input.value = `Me interesa el servicio "${name}", ¿me explicas qué incluye y cómo lo contrato?`;
          input.focus();
          document.getElementById('chat-form')?.requestSubmit();
        }
      });
    });
  } catch (err) {
    grid.innerHTML = `<p style="color:#fda4af;">No se pudo conectar con el servicio de catálogo: ${escapeHtml(err.message)}</p>`;
  }
}

// ==================== CHAT EN VIVO CON ASESOR COMERCIAL ====================
function appendChatBubble(role, text, botMode = activeBotMode) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const div = document.createElement('div');
  if (role === 'assistant') {
    const isCustom = botMode === 'custom' && Boolean(provisionedInstance);
    div.className = `chat-bubble assistant ${isCustom ? 'is-custom-bot' : 'is-official-bot'}`;
    div.innerHTML = `${buildAssistantIdentityHeader(isCustom ? 'custom' : 'official', provisionedInstance)}${escapeHtml(text)}`;
  } else {
    div.className = `chat-bubble ${role}`;
    div.textContent = text;
  }
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
        instance_id: activeChatInstanceId || 'servibot-00',
        sender_id: webSenderId,
        sender_name: 'Prospecto Web',
        message: text
      })
    });

    if (res?.locked || res?.statusCode === 423) {
      renderLockedWizardState(res);
      appendChatBubble(
        'assistant',
        `🔒 ${res.message || res.error || 'Esta instancia ya realizó su pago y quedó bloqueada en la vista pública. Adminístrala desde tu Panel Admin Estándar.'}`,
        'official'
      );
      return;
    }

    if ((res?.blacklisted || res?.omitted) && !res?.reply) {
      return;
    }

    if (res && res.ok === false && res.error) {
      appendChatBubble('assistant', `⚠️ ${res.error}`);
      return;
    }

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
    case 'auth/email-already-in-use':
      return 'Este correo ya cuenta con una cuenta registrada. Cambia a "Ya tengo cuenta" para iniciar sesión o inicia con Google.';
    case 'auth/weak-password':
      return 'La contraseña es muy débil. Debe tener al menos 6 caracteres.';
    case 'auth/popup-closed-by-user':
      return 'Se cerró la ventana de inicio de sesión de Google antes de completar la autorización.';
    case 'auth/cancelled-popup-request':
      return 'Operación de inicio de sesión cancelada.';
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
function syncAdminRoleUI(meData) {
  if (!meData) {
    currentAdminMeta = null;
    const banner = document.getElementById('admin-role-banner');
    if (banner) {
      banner.classList.add('hidden');
      banner.setAttribute('hidden', '');
    }
    return;
  }

  const acct = meData.account || meData;
  const userEmail = String(acct.email || meData.email || currentUser?.email || '').trim().toLowerCase();
  const isSuper = Boolean(
    meData.is_superadmin ||
    acct.is_superadmin ||
    acct.role === 'superadmin' ||
    userEmail === 'fraustop@outlook.com'
  );
  const assignedInstance = isSuper ? 'servibot-00' : (acct.assigned_instance_id || meData.assigned_instance_id || 'servibot-01');

  currentAdminMeta = {
    ...meData,
    ...acct,
    is_superadmin: isSuper,
    email: userEmail,
    assigned_instance_id: assignedInstance,
    instances: meData.instances || meData.available_instances || acct.instances || []
  };

  document.querySelectorAll('[data-superadmin-only="1"]').forEach((el) => {
    const hide = !isSuper;
    el.classList.toggle('hidden', hide);
    if (hide) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  });

  if (!isSuper && activeAdminTab === 'tab-accounts') {
    activeAdminTab = 'tab-catalog';
  }

  const banner = document.getElementById('admin-role-banner');
  const roleBadge = document.getElementById('admin-role-badge');
  const instLabel = document.getElementById('admin-instance-label');
  const expiryBadge = document.getElementById('admin-expiry-badge');
  const superControls = document.getElementById('admin-super-controls');
  const switcher = document.getElementById('admin-instance-switcher');
  const accInstSelect = document.getElementById('account-instance-select');

  ['tunnel-token-input', 'admin-api-override'].forEach((id) => {
    const card = document.getElementById(id)?.closest('.panel-card');
    if (card) {
      const hideCard = !isSuper;
      card.classList.toggle('hidden', hideCard);
      if (hideCard) card.setAttribute('hidden', '');
      else card.removeAttribute('hidden');
    }
  });

  if (banner) {
    banner.classList.remove('hidden');
    banner.removeAttribute('hidden');
  }

  if (isSuper) {
    if (!adminSelectedInstanceId || adminSelectedInstanceId === 'servibot-01') {
      adminSelectedInstanceId = 'servibot-00';
    }
    if (roleBadge) {
      roleBadge.textContent = `👑 SuperAdmin · ${userEmail || 'fraustop@outlook.com'}`;
    }
    if (superControls) {
      superControls.classList.remove('hidden');
      superControls.removeAttribute('hidden');
    }
    const instances = Array.isArray(currentAdminMeta.instances) ? currentAdminMeta.instances : [];
    const optionsHtml = instances.length
      ? instances
          .map((inst) => {
            const label =
              inst.instance_id === 'servibot-00'
                ? 'servibot-00 · Bot 0 (Proyecto Cero Principal)'
                : `${inst.instance_id} · ${inst.business_name || inst.slot_status || 'Disponible'}`;
            return `<option value="${escapeHtml(inst.instance_id)}" ${
              inst.instance_id === adminSelectedInstanceId ? 'selected' : ''
            }>${escapeHtml(label)}</option>`;
          })
          .join('')
      : '<option value="servibot-00">servibot-00 · Bot 0 (Proyecto Cero Principal)</option>';

    if (switcher) {
      switcher.innerHTML = optionsHtml;
      switcher.value = adminSelectedInstanceId;
    }
    if (accInstSelect) {
      accInstSelect.innerHTML = optionsHtml;
    }
    if (instLabel) {
      instLabel.textContent = `Base activa en panel: ${adminSelectedInstanceId}`;
    }
    if (expiryBadge) {
      expiryBadge.classList.add('hidden');
      expiryBadge.setAttribute('hidden', '');
    }
  } else {
    adminSelectedInstanceId = assignedInstance;
    if (roleBadge) {
      roleBadge.textContent = `🤖 Admin Estándar · ${userEmail || ''}`;
    }
    if (superControls) {
      superControls.classList.add('hidden');
      superControls.setAttribute('hidden', '');
    }
    const biz = meData.instance?.business_name ? ` · ${meData.instance.business_name}` : '';
    if (instLabel) {
      instLabel.textContent = `Instancia Asignada: ${assignedInstance}${biz}`;
    }
    if (expiryBadge) {
      if (acct.subscription_expired) {
        expiryBadge.className = 'admin-expiry-badge is-expired';
        expiryBadge.textContent = '⛔ Suscripción Vencida';
      } else if (acct.days_remaining !== null) {
        expiryBadge.className = 'admin-expiry-badge is-active';
        expiryBadge.textContent = `⏳ ${acct.days_remaining} días restantes`;
      } else {
        expiryBadge.classList.add('hidden');
        expiryBadge.setAttribute('hidden', '');
      }
    }
  }
}

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
  const submitBtn = document.getElementById('btn-login-email');

  if (user) {
    const isSuper = user.email?.toLowerCase() === 'fraustop@outlook.com';

    // Si el usuario es el Administrador Principal y está en la portada, dirigirlo a la consola de administración
    if (activeView === 'public' && isSuper) {
      showView('admin');
      return;
    }

    if (activeView === 'admin') {
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verificando permisos...';
      }
      setFeedback('auth-status-msg', 'Autenticado. Verificando rol en el servidor...', true);

      try {
        const me = await apiFetch('/api/admin/me');
        if (!me?.ok || me?.statusCode === 403) {
          currentAdminMeta = null;
          adminSelectedInstanceId = '';
          gate?.classList.remove('hidden');
          dash?.classList.add('hidden');
          setFeedback(
            'auth-status-msg',
            me?.error || 'Esta cuenta está registrada pero no tiene rol de Administrador. Si deseas crear o configurar tu bot, regresa al inicio.',
            false
          );
          syncHeaderAndNavigation();
        } else {
          gate?.classList.add('hidden');
          dash?.classList.remove('hidden');
          setFeedback('auth-status-msg', '');
          syncAdminRoleUI(me);
          syncHeaderAndNavigation();
          switchAdminTab(activeAdminTab);
          await loadAllAdminData();
        }
      } catch (err) {
        gate?.classList.remove('hidden');
        dash?.classList.add('hidden');
        setFeedback('auth-status-msg', `Error de conexión al validar permisos: ${err?.message || 'Servidor inaccesible'}`, false);
        syncHeaderAndNavigation();
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Iniciar sesión';
        }
      }
    } else {
      syncHeaderAndNavigation();
      syncProspectGateUI();
    }
  } else {
    currentAdminMeta = null;
    adminSelectedInstanceId = '';
    syncAdminRoleUI(null);
    gate?.classList.remove('hidden');
    dash?.classList.add('hidden');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Iniciar sesión';
    }
    syncHeaderAndNavigation();
    syncProspectGateUI();
  }
});

async function loadAllAdminData() {
  if (!currentUser) return;
  const tasks = [
    loadAdminCatalog(),
    loadAdminPromotions(),
    loadAdminContactRules(),
    loadAdminOrders(),
    loadAdminSettings(),
    loadWhatsAppStatus(),
    loadMicrosoftChannelStatus(),
    loadAdminConversations(),
    loadAdminBotSoul(),
    refreshHealth()
  ];
  if (currentAdminMeta?.is_superadmin) {
    tasks.push(loadAdminAccounts(), loadAdminVipInstances(), loadAdminProspects());
  }
  await Promise.all(tasks);
}

let adminCatalogCache = [];
let selectedCatalogItemId = null;

function resetCatalogForm() {
  const form = document.getElementById('catalog-form');
  if (form) form.reset();
  const idEl = document.getElementById('item-id');
  if (idEl) idEl.value = '';
  const imgUrl = document.getElementById('item-image-url');
  if (imgUrl) imgUrl.value = '/assets/service-bots.svg';
  const activeChk = document.getElementById('item-active');
  if (activeChk) activeChk.checked = true;
  const sentBotChk = document.getElementById('item-sent-to-bot');
  if (sentBotChk) sentBotChk.checked = true;
  const title = document.getElementById('catalog-form-title');
  if (title) title.textContent = '➕ Crear Producto / Servicio';
}

function openCatalogModal(mode = 'create', item = null) {
  const modal = document.getElementById('catalog-modal');
  const titleEl = document.getElementById('catalog-form-title');
  if (!modal) return;

  if (mode === 'edit' && item) {
    document.getElementById('item-id').value = item.id;
    document.getElementById('item-name').value = item.name || '';
    document.getElementById('item-type').value = item.type || 'service';
    document.getElementById('item-badge').value = item.badge || '';
    document.getElementById('item-price').value = item.price || 0;
    document.getElementById('item-currency').value = item.currency || 'MXN';
    document.getElementById('item-cycle').value = item.billing_cycle || 'mensual';
    document.getElementById('item-setup').value = item.setup_fee || 0;
    document.getElementById('item-tagline').value = item.tagline || '';
    document.getElementById('item-description').value = item.description || '';
    document.getElementById('item-features').value = (item.features || []).join('\n');
    document.getElementById('item-image-url').value = item.image_url || '/assets/service-bots.svg';
    document.getElementById('item-active').checked = Boolean(item.active);
    const sentBotChk = document.getElementById('item-sent-to-bot');
    if (sentBotChk) sentBotChk.checked = Boolean(item.sent_to_bot);
    if (titleEl) titleEl.textContent = `✏️ Editar: ${item.name}`;
  } else {
    resetCatalogForm();
    if (titleEl) titleEl.textContent = '➕ Crear Producto / Servicio';
  }

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  }
}

function renderProductDetail(item) {
  const emptyState = document.getElementById('catalog-detail-empty');
  const detailView = document.getElementById('catalog-detail-view');
  if (!emptyState || !detailView) return;

  if (!item) {
    emptyState.classList.remove('hidden');
    detailView.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  detailView.classList.remove('hidden');

  const titleEl = document.getElementById('detail-title');
  if (titleEl) titleEl.textContent = item.name || 'Sin nombre';

  const taglineEl = document.getElementById('detail-tagline');
  if (taglineEl) {
    taglineEl.textContent = item.tagline || '';
    taglineEl.style.display = item.tagline ? 'block' : 'none';
  }

  const typeBadge = document.getElementById('detail-type-badge');
  if (typeBadge) {
    typeBadge.textContent = item.type === 'product' ? '📦 Producto' : '⚙️ Servicio';
    typeBadge.className = `badge-tag ${item.type === 'product' ? 'badge-tag-purple' : 'badge-tag-accent'}`;
  }

  const statusBadge = document.getElementById('detail-status-badge');
  if (statusBadge) {
    statusBadge.textContent = item.active ? '🟢 Activo en Tienda' : '⚪ Oculto';
    statusBadge.className = `badge-tag ${item.active ? 'badge-status-dot-active' : 'badge-status-dot-hidden'}`;
  }

  const botBadge = document.getElementById('detail-bot-badge');
  if (botBadge) {
    botBadge.textContent = item.sent_to_bot ? '🤖 Enviado al Bot' : 'Solo interfaz';
    botBadge.className = `badge-tag ${item.sent_to_bot ? 'badge-tag-custom' : 'badge-status-dot-hidden'}`;
  }

  const sendBotBtn = document.getElementById('btn-send-selected-to-bot');
  if (sendBotBtn) {
    sendBotBtn.textContent = item.sent_to_bot ? '✅ En Bot (Reenviar)' : '🤖 Enviar a mi Bot';
  }

  const highlightBadge = document.getElementById('detail-highlight-badge');
  if (highlightBadge) {
    if (item.badge) {
      highlightBadge.textContent = `★ ${item.badge}`;
      highlightBadge.classList.remove('hidden');
    } else {
      highlightBadge.classList.add('hidden');
    }
  }

  const imgEl = document.getElementById('detail-image');
  if (imgEl) {
    imgEl.src = resolveAssetUrl(item.image_url || '/assets/service-bots.svg');
    imgEl.alt = item.name;
  }

  const priceEl = document.getElementById('detail-price');
  if (priceEl) priceEl.textContent = `$${Number(item.price).toLocaleString('es-MX')}`;

  const currencyCycleEl = document.getElementById('detail-currency-cycle');
  if (currencyCycleEl) currencyCycleEl.textContent = `${escapeHtml(item.currency || 'MXN')} / ${escapeHtml(item.billing_cycle || 'mensual')}`;

  const setupRow = document.getElementById('detail-setup-row');
  const setupText = document.getElementById('detail-setup-text');
  if (setupRow && setupText) {
    if (Number(item.setup_fee) > 0) {
      setupRow.classList.remove('hidden');
      setupText.textContent = `+ $${Number(item.setup_fee).toLocaleString('es-MX')} ${escapeHtml(item.currency || 'MXN')} activación inicial`;
    } else {
      setupRow.classList.remove('hidden');
      setupText.textContent = 'Activación inmediata incluida';
    }
  }

  const slugEl = document.getElementById('detail-slug');
  if (slugEl) slugEl.textContent = item.slug || String(item.id);

  const descEl = document.getElementById('detail-description');
  if (descEl) descEl.textContent = item.description || 'Sin descripción detallada.';

  const featsList = document.getElementById('detail-features-list');
  const featsSection = document.getElementById('detail-features-section');
  if (featsList) {
    const feats = item.features || [];
    if (feats.length) {
      if (featsSection) featsSection.classList.remove('hidden');
      featsList.innerHTML = feats
        .map((f) => `<li><span class="feat-check" aria-hidden="true">✔</span><span>${escapeHtml(f)}</span></li>`)
        .join('');
    } else {
      if (featsSection) featsSection.classList.add('hidden');
      featsList.innerHTML = '';
    }
  }
}

function renderAdminCatalogList(filterTerm = '') {
  const list = document.getElementById('admin-catalog-list');
  if (!list) return;

  let items = adminCatalogCache;
  if (filterTerm) {
    const term = filterTerm.toLowerCase();
    items = items.filter(
      (it) =>
        (it.name && it.name.toLowerCase().includes(term)) ||
        (it.type && it.type.toLowerCase().includes(term)) ||
        (it.tagline && it.tagline.toLowerCase().includes(term)) ||
        (it.slug && it.slug.toLowerCase().includes(term))
    );
  }

  if (!items.length) {
    list.innerHTML = `
      <div class="product-list-empty-msg">
        ${filterTerm ? 'No se encontraron resultados para tu búsqueda.' : 'No hay productos o servicios registrados. Haz clic en "➕ Nuevo Producto" para crear uno.'}
      </div>
    `;
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const isSelected = item.id === selectedCatalogItemId;
      return `
        <div class="product-list-card ${isSelected ? 'active' : ''}" role="option" aria-selected="${isSelected ? 'true' : 'false'}" data-id="${item.id}" tabindex="0">
          <img class="product-list-card-thumb" src="${escapeHtml(resolveAssetUrl(item.image_url))}" alt="${escapeHtml(item.name)}" loading="lazy" />
          <div class="product-list-card-body">
            <div class="product-list-card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
            <div class="product-list-card-meta">
              <span class="product-list-card-price">$${Number(item.price).toLocaleString('es-MX')} ${escapeHtml(item.currency)}</span>
              <span>·</span>
              <span class="product-list-card-cycle">${escapeHtml(item.billing_cycle)}</span>
              ${item.sent_to_bot ? '<span class="badge-tag badge-tag-custom" style="margin-left:0.25rem; font-size:0.7rem;">🤖 Bot</span>' : ''}
            </div>
          </div>
          <span class="badge-tag ${item.active ? 'badge-status-dot-active' : 'badge-status-dot-hidden'}">${item.active ? 'Activo' : 'Oculto'}</span>
        </div>
      `;
    })
    .join('');

  list.querySelectorAll('.product-list-card').forEach((card) => {
    const handleSelect = () => {
      const id = Number(card.dataset.id);
      selectedCatalogItemId = id;
      list.querySelectorAll('.product-list-card').forEach((c) => {
        const isCur = Number(c.dataset.id) === id;
        c.classList.toggle('active', isCur);
        c.setAttribute('aria-selected', isCur ? 'true' : 'false');
      });
      const selectedItem = adminCatalogCache.find((it) => it.id === id);
      renderProductDetail(selectedItem || null);
    };

    card.addEventListener('click', handleSelect);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect();
      }
    });
  });
}

async function loadAdminCatalog() {
  const list = document.getElementById('admin-catalog-list');
  if (!list) return;
  const data = await apiFetch(buildAdminEndpoint('/api/catalog?all=1'));
  adminCatalogCache = data.items || [];

  const countBadge = document.getElementById('catalog-items-count');
  if (countBadge) {
    countBadge.textContent = `${adminCatalogCache.length} ${adminCatalogCache.length === 1 ? 'item' : 'items'}`;
  }

  const searchInput = document.getElementById('catalog-search-input');
  const filterTerm = searchInput?.value?.trim() || '';

  renderAdminCatalogList(filterTerm);

  if (selectedCatalogItemId) {
    const found = adminCatalogCache.find((it) => it.id === selectedCatalogItemId);
    if (found) {
      renderProductDetail(found);
    } else {
      selectedCatalogItemId = null;
      renderProductDetail(null);
    }
  } else {
    renderProductDetail(null);
  }
}

async function loadAdminOrders() {
  const tbody = document.getElementById('orders-tbody');
  if (!tbody) return;
  const data = await apiFetch(buildAdminEndpoint('/api/orders'));
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
      await apiFetch(buildAdminEndpoint(`/api/orders/${sel.dataset.id}`), {
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
    const data = await apiFetch(buildAdminEndpoint('/api/channels/whatsapp/status'));
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

async function loadChannelsStatus() {
  await Promise.all([
    loadWhatsAppStatus(),
    loadAdminSettings()
  ]);
}
const loadMicrosoftChannelStatus = loadChannelsStatus;

async function loadAdminSettings() {
  try {
    const data = await apiFetch('/api/settings');
    if (!data.ok) return;

    // 1. Correo Electrónico (IMAP / SMTP con usuario y contraseña)
    const em = data.email_config || {};
    const imapHostEl = document.getElementById('cfg-imap-host');
    const imapPortEl = document.getElementById('cfg-imap-port');
    const smtpHostEl = document.getElementById('cfg-smtp-host');
    const smtpPortEl = document.getElementById('cfg-smtp-port');
    const emailUserEl = document.getElementById('cfg-email-user');
    const emailPassEl = document.getElementById('cfg-email-pass');
    const emailEnabledEl = document.getElementById('cfg-email-enabled');
    const emailBadge = document.getElementById('email-state-badge');

    if (imapHostEl) imapHostEl.value = em.imap_host || 'outlook.office365.com';
    if (imapPortEl) imapPortEl.value = em.imap_port || 993;
    if (smtpHostEl) smtpHostEl.value = em.smtp_host || 'smtp.office365.com';
    if (smtpPortEl) smtpPortEl.value = em.smtp_port || 465;
    if (emailUserEl) emailUserEl.value = em.user || '';
    if (emailPassEl) emailPassEl.value = em.pass || '';
    if (emailEnabledEl) emailEnabledEl.checked = Boolean(em.enabled);

    if (emailBadge) {
      if (em.enabled && em.user) {
        emailBadge.textContent = 'ACTIVO (IMAP/SMTP)';
        emailBadge.className = 'badge-tag badge-status-dot-active';
      } else if (em.user) {
        emailBadge.textContent = 'CREDENCIALES LISTAS';
        emailBadge.className = 'badge-tag';
      } else {
        emailBadge.textContent = 'SIN CONFIGURAR';
        emailBadge.className = 'badge-tag';
      }
    }

    // 2. Microsoft Teams
    const tm = data.teams_config || {};
    const teamsNameEl = document.getElementById('cfg-teams-name');
    const teamsHookEl = document.getElementById('cfg-teams-webhook');
    const teamsEnabledEl = document.getElementById('cfg-teams-enabled');
    const teamsBadge = document.getElementById('teams-state-badge');

    if (teamsNameEl) teamsNameEl.value = tm.bot_display_name || 'Servi-Bot Teams';
    if (teamsHookEl) teamsHookEl.value = tm.incoming_webhook_url || '';
    if (teamsEnabledEl) teamsEnabledEl.checked = tm.enabled !== false;

    if (teamsBadge) {
      const isTeamsActive = tm.enabled !== false;
      teamsBadge.textContent = isTeamsActive ? 'ACTIVO' : 'PAUSADO';
      teamsBadge.className = isTeamsActive ? 'badge-tag badge-status-dot-active' : 'badge-tag';
    }

    // 3. Telegram
    const tg = data.telegram_config || {};
    const tgNameEl = document.getElementById('cfg-telegram-name');
    const tgUserEl = document.getElementById('cfg-telegram-username');
    const tgTokenEl = document.getElementById('cfg-telegram-token');
    const tgEnabledEl = document.getElementById('cfg-telegram-enabled');
    const tgBadge = document.getElementById('tg-state-badge');

    if (tgNameEl) tgNameEl.value = tg.bot_name || 'Servi-Bot Telegram';
    if (tgUserEl) tgUserEl.value = tg.bot_username || '';
    if (tgTokenEl) tgTokenEl.value = tg.bot_token || '';
    if (tgEnabledEl) tgEnabledEl.checked = Boolean(tg.enabled);

    if (tgBadge) {
      if (tg.enabled && tg.bot_token) {
        tgBadge.textContent = 'BOT EN LÍNEA';
        tgBadge.className = 'badge-tag badge-status-dot-active';
      } else if (tg.bot_token) {
        tgBadge.textContent = 'CONFIGURADO';
        tgBadge.className = 'badge-tag';
      } else {
        tgBadge.textContent = 'SIN VINCULAR';
        tgBadge.className = 'badge-tag';
      }
    }

    // 4. Instagram (Comentarios)
    const ig = data.instagram_config || {};
    const igUserEl = document.getElementById('cfg-instagram-user');
    const igTokenEl = document.getElementById('cfg-instagram-token');
    const igEnabledEl = document.getElementById('cfg-instagram-enabled');
    const igBadge = document.getElementById('ig-state-badge');

    if (igUserEl) igUserEl.value = ig.account_username || '';
    if (igTokenEl) igTokenEl.value = ig.access_token || '';
    if (igEnabledEl) igEnabledEl.checked = Boolean(ig.enabled);

    if (igBadge) {
      if (ig.enabled && ig.account_username) {
        igBadge.textContent = 'RESPONDIENDO COMENTARIOS';
        igBadge.className = 'badge-tag badge-status-dot-active';
      } else if (ig.account_username) {
        igBadge.textContent = 'CONFIGURADO';
        igBadge.className = 'badge-tag';
      } else {
        igBadge.textContent = 'SIN VINCULAR';
        igBadge.className = 'badge-tag';
      }
    }

    // 5. TikTok (Comentarios)
    const tt = data.tiktok_config || {};
    const ttUserEl = document.getElementById('cfg-tiktok-user');
    const ttKeyEl = document.getElementById('cfg-tiktok-key');
    const ttEnabledEl = document.getElementById('cfg-tiktok-enabled');
    const ttBadge = document.getElementById('tt-state-badge');

    if (ttUserEl) ttUserEl.value = tt.account_username || '';
    if (ttKeyEl) ttKeyEl.value = tt.client_key || '';
    if (ttEnabledEl) ttEnabledEl.checked = Boolean(tt.enabled);

    if (ttBadge) {
      if (tt.enabled && tt.account_username) {
        ttBadge.textContent = 'RESPONDIENDO VIDEOS';
        ttBadge.className = 'badge-tag badge-status-dot-active';
      } else if (tt.account_username) {
        ttBadge.textContent = 'CONFIGURADO';
        ttBadge.className = 'badge-tag';
      } else {
        ttBadge.textContent = 'SIN VINCULAR';
        ttBadge.className = 'badge-tag';
      }
    }

    // 6. Túnel Cloudflare
    const tun = data.tunnel_config || {};
    const pubUrlEl = document.getElementById('tunnel-public-url');
    const tokEl = document.getElementById('tunnel-token-input');
    if (pubUrlEl && tun.public_url) pubUrlEl.value = tun.public_url;
    if (tokEl) tokEl.value = tun.tunnel_token || '';
  } catch {
    // ignorar error de carga inicial de ajustes
  }
}

async function loadAdminConversations() {
  const box = document.getElementById('conversations-list');
  if (!box) return;
  const data = await apiFetch(buildAdminEndpoint('/api/conversations'));
  const convs = (data.conversations || []).filter((c) => !c.hidden);
  if (!convs.length) {
    box.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">Sin conversaciones visibles registradas aún.</p>';
    return;
  }
  box.innerHTML = convs
    .map(
      (c) => `
      <div style="padding:0.7rem; background:var(--bg-dark); border:1px solid ${c.is_priority ? 'rgba(250, 204, 21, 0.55)' : 'var(--border-color)'}; border-radius:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; font-size:0.8rem;">
          <strong>
            [${escapeHtml(c.channel.toUpperCase())}] ${escapeHtml(c.sender_name || c.sender_id)}
            ${c.is_priority ? '<span class="badge-tag" style="margin-left:0.35rem; background:rgba(250,204,21,0.18); color:#fde047;">⭐ Lista Blanca</span>' : ''}
          </strong>
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
  if (!currentAdminMeta?.is_superadmin) {
    tbody.innerHTML = '';
    return;
  }

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
        const isMaster = acc.role === 'superadmin' || String(acc.email || '').toLowerCase() === 'fraustop@outlook.com';
        const roleLabel = isMaster
          ? '👑 SuperAdmin (Bot 0)'
          : acc.role === 'operator'
            ? 'Operador'
            : 'Admin Estándar';
        const instBadge = acc.assigned_instance_id
          ? `<span class="badge-tag badge-tag-custom" style="margin-left:0.35rem;">${escapeHtml(acc.assigned_instance_id)}</span>`
          : '';
        const expText = acc.subscription_expires_at
          ? `<div style="font-size:0.74rem; color:var(--text-muted);">Vigencia: ${escapeHtml(new Date(acc.subscription_expires_at).toLocaleDateString('es-MX'))}</div>`
          : '';
        const delBtn = !isMaster && acc.uid
          ? `<button type="button" class="btn btn-outline btn-sm btn-del-account" data-uid="${escapeHtml(acc.uid)}" data-email="${escapeHtml(acc.email)}" style="margin-top:0.3rem; border-color:rgba(244,63,94,0.45); color:#fda4af;">Eliminar</button>`
          : '';
        return `
          <tr>
            <th scope="row">${escapeHtml(acc.display_name || acc.email)}</th>
            <td>${escapeHtml(acc.email)}${expText}</td>
            <td><span class="badge-tag">${escapeHtml(roleLabel)}</span>${instBadge}</td>
            <td>${escapeHtml(acc.created_by || 'Firebase Auth')}</td>
            <td style="font-size:0.8rem; color:var(--text-muted);">
              <div>${escapeHtml(acc.created_at || '—')}</div>
              ${delBtn}
            </td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('.btn-del-account').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar la cuenta admin ${btn.dataset.email}?`)) return;
        await apiFetch(`/api/admin/accounts/${encodeURIComponent(btn.dataset.uid)}`, { method: 'DELETE' });
        await loadAdminAccounts();
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><th scope="row">—</th><td colspan="4" style="color:#fda4af;">Error cargando cuentas: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadAdminPromotions() {
  const list = document.getElementById('admin-promotions-list');
  if (!list) return;
  try {
    const data = await apiFetch(buildAdminEndpoint('/api/promotions?all=1'));
    const promos = data.promotions || [];
    if (!promos.length) {
      list.innerHTML = '<p style="color:var(--text-muted); font-size:0.86rem; margin:0;">No hay promociones activas en esta instancia. Crea una nueva arriba si deseas ofrecer descuentos reales en el bot.</p>';
      return;
    }

    list.innerHTML = promos
      .map(
        (p) => `
        <div class="promo-item-card" data-promo-id="${p.id}">
          <div class="promo-item-head">
            <div>
              <strong>${escapeHtml(p.title)}</strong>
              <span class="badge-tag badge-tag-accent" style="margin-left:0.35rem;">${escapeHtml(p.discount_text || 'Promo')}</span>
              <span class="badge-tag ${p.sent_to_bot ? 'badge-tag-custom' : 'badge-status-dot-hidden'}" style="margin-left:0.25rem;">
                ${p.sent_to_bot ? '🤖 En Bot' : 'Solo interfaz'}
              </span>
            </div>
            ${p.promo_price != null ? `<strong style="color:var(--accent-emerald);">$${Number(p.promo_price).toLocaleString('es-MX')} MXN</strong>` : ''}
          </div>
          ${p.description ? `<p class="promo-item-desc">${escapeHtml(p.description)}</p>` : ''}
          <div class="promo-item-actions">
            <button type="button" class="btn btn-outline btn-sm btn-send-promo-bot" data-id="${p.id}">
              ${p.sent_to_bot ? '✅ Reenviar a mi Bot' : '🤖 Enviar a mi Bot'}
            </button>
            <button type="button" class="btn btn-outline btn-sm btn-del-promo" data-id="${p.id}" style="border-color:rgba(244,63,94,0.45); color:#fda4af;">
              🗑️ Eliminar
            </button>
          </div>
        </div>
      `
      )
      .join('');

    list.querySelectorAll('.btn-send-promo-bot').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await apiFetch(buildAdminEndpoint(`/api/promotions/${btn.dataset.id}/send-to-bot`), {
          method: 'POST',
          body: JSON.stringify({ sent_to_bot: true, active: true })
        });
        await loadAdminPromotions();
      });
    });

    list.querySelectorAll('.btn-del-promo').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar esta promoción?')) return;
        await apiFetch(buildAdminEndpoint(`/api/promotions/${btn.dataset.id}`), { method: 'DELETE' });
        await loadAdminPromotions();
      });
    });
  } catch (err) {
    list.innerHTML = `<p style="color:#fda4af; font-size:0.85rem;">Error cargando promociones: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadAdminContactRules() {
  const whiteBox = document.getElementById('rules-whitelist');
  const omBox = document.getElementById('rules-omission');
  const blackBox = document.getElementById('rules-blacklist');
  if (!whiteBox && !omBox && !blackBox) return;

  try {
    const data = await apiFetch(buildAdminEndpoint('/api/contact-rules'));
    const rules = data.rules || [];
    const renderBucket = (type, container, emptyText) => {
      if (!container) return;
      const subset = rules.filter((r) => r.list_type === type);
      if (!subset.length) {
        container.innerHTML = `<p style="color:var(--text-muted); font-size:0.82rem; margin:0;">${escapeHtml(emptyText)}</p>`;
        return;
      }
      container.innerHTML = subset
        .map(
          (r) => `
          <div class="rule-item-row">
            <div>
              <strong>${escapeHtml(r.contact_value)}</strong>
              ${r.label ? `<div class="rule-item-label">${escapeHtml(r.label)}</div>` : ''}
            </div>
            <button type="button" class="btn btn-outline btn-sm btn-del-rule" data-id="${r.id}" aria-label="Quitar regla" style="border-color:rgba(244,63,94,0.45); color:#fda4af;">
              Quitar
            </button>
          </div>
        `
        )
        .join('');
    };

    renderBucket('whitelist', whiteBox, 'Sin números en Lista Blanca.');
    renderBucket('omission', omBox, 'Sin contactos en Omisiones.');
    renderBucket('blacklist', blackBox, 'Sin contactos en Lista Negra.');

    document.querySelectorAll('.btn-del-rule').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await apiFetch(buildAdminEndpoint(`/api/contact-rules/${btn.dataset.id}`), { method: 'DELETE' });
        await loadAdminContactRules();
      });
    });
  } catch (err) {
    if (whiteBox) whiteBox.innerHTML = `<p style="color:#fda4af;">${escapeHtml(err.message)}</p>`;
  }
}

async function loadAdminBotSoul() {
  const instanceId = adminSelectedInstanceId || 'servibot-00';
  const pill = document.getElementById('soul-instance-pill');
  if (pill) pill.textContent = instanceId;

  try {
    const res = await apiFetch(`/api/instances/${encodeURIComponent(instanceId)}`);
    if (!res.ok || !res.instance) {
      throw new Error(res.error || 'No se pudo cargar la configuración de la instancia.');
    }
    const inst = res.instance;

    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val ?? '';
    };

    setVal('soul-display-name', inst.display_name || '');
    setVal('soul-business-name', inst.business_name || '');
    setVal('soul-welcome-message', inst.welcome_message || '');
    setVal('soul-tone', inst.tone || '');
    setVal('soul-ai-soul', inst.ai_soul || '');
    setVal('soul-system-prompt', inst.system_prompt || '');

    // Sincronizar estado visual de los chips de tono
    const currentTone = String(inst.tone || '').trim().toLowerCase();
    document.querySelectorAll('#soul-tone-presets .preset-chip').forEach((btn) => {
      const btnTone = String(btn.dataset.tone || '').trim().toLowerCase();
      const isActive = currentTone && (currentTone === btnTone || currentTone.includes(btnTone.split(',')[0]));
      btn.classList.toggle('is-selected', Boolean(isActive));
      btn.setAttribute('aria-pressed', String(Boolean(isActive)));
    });

    setFeedback('bot-soul-feedback', '');
  } catch (err) {
    setFeedback('bot-soul-feedback', `⚠️ Error al cargar alma del bot: ${err.message}`, false);
  }
}

async function loadAdminVipInstances() {
  const list = document.getElementById('vip-instances-list');
  if (!list || !currentAdminMeta?.is_superadmin) return;
  try {
    const data = await apiFetch('/api/vip-instances');
    const items = data.vip_instances || [];
    if (!items.length) {
      list.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No hay folios VIP registrados aún.</p>';
      return;
    }
    list.innerHTML = items
      .map(
        (v) => `
        <div class="vip-item-card">
          <div class="vip-item-head">
            <div>
              <span class="badge-tag badge-tag-accent">${escapeHtml(v.folio)}</span>
              <strong style="margin-left:0.35rem;">${escapeHtml(v.business_name)}</strong>
            </div>
            <strong style="color:var(--accent-emerald);">$${Number(v.monthly_price || 0).toLocaleString('es-MX')} MXN/mes</strong>
          </div>
          <div class="vip-item-meta">
            ${v.client_name ? `<span>Titular: ${escapeHtml(v.client_name)}</span>` : ''}
            ${v.client_contact ? `<span>· ${escapeHtml(v.client_contact)}</span>` : ''}
            ${v.admin_email ? `<span>· Admin: ${escapeHtml(v.admin_email)}</span>` : ''}
          </div>
          <div class="vip-item-links">
            ${v.server_url ? `<a href="${escapeHtml(v.server_url)}" target="_blank" rel="noopener noreferrer">Servidor Dedicado ↗</a>` : ''}
            ${v.custom_admin_url ? `<a href="${escapeHtml(v.custom_admin_url)}" target="_blank" rel="noopener noreferrer">Admin Personalizado ↗</a>` : ''}
          </div>
          ${v.notes ? `<p style="font-size:0.8rem; color:var(--text-muted); margin:0.35rem 0 0;">${escapeHtml(v.notes)}</p>` : ''}
          <div style="display:flex; justify-content:flex-end; margin-top:0.5rem;">
            <button type="button" class="btn btn-outline btn-sm btn-del-vip" data-folio="${escapeHtml(v.folio)}" style="border-color:rgba(244,63,94,0.45); color:#fda4af;">
              Eliminar VIP
            </button>
          </div>
        </div>
      `
      )
      .join('');

    list.querySelectorAll('.btn-del-vip').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(`¿Eliminar registro VIP ${btn.dataset.folio}?`)) return;
        await apiFetch(`/api/vip-instances/${encodeURIComponent(btn.dataset.folio)}`, { method: 'DELETE' });
        await loadAdminVipInstances();
      });
    });
  } catch (err) {
    list.innerHTML = `<p style="color:#fda4af;">${escapeHtml(err.message)}</p>`;
  }
}

async function loadAdminProspects() {
  const box = document.getElementById('admin-prospects-list');
  if (!box || !currentAdminMeta?.is_superadmin) return;
  try {
    const data = await apiFetch('/api/prospects');
    const prospects = data.prospects || [];
    if (!prospects.length) {
      box.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">La base de prospectos está vacía (se archivan aquí cuando las 50 instancias rotan sin haber pagado).</p>';
      return;
    }
    box.innerHTML = prospects
      .map(
        (p) => `
        <div class="prospect-item-row">
          <div>
            <strong>${escapeHtml(p.business_name || 'Sin empresa')}</strong>
            <span class="badge-tag" style="margin-left:0.35rem;">${escapeHtml(p.recovery_code || p.prospect_id)}</span>
            ${p.last_instance_id ? `<span class="badge-tag badge-tag-custom" style="margin-left:0.25rem;">Ex-${escapeHtml(p.last_instance_id)}</span>` : ''}
            <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.2rem;">
              ${escapeHtml(p.client_name || '')} · ${escapeHtml(p.client_contact || '')} · Estado: ${escapeHtml(p.status || 'archived')}
            </div>
          </div>
          <button type="button" class="btn btn-outline btn-sm btn-recover-prospect" data-contact="${escapeHtml(p.client_contact || p.recovery_code || '')}">
            ♻️ Recuperar en Bot Libre
          </button>
        </div>
      `
      )
      .join('');

    box.querySelectorAll('.btn-recover-prospect').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const res = await apiFetch('/api/instances/recover', {
          method: 'POST',
          body: JSON.stringify({ query: btn.dataset.contact })
        });
        if (res?.ok && res.instance) {
          clientInstanceId = res.instance.instance_id;
          localStorage.setItem('servibot_client_instance_id', clientInstanceId);
          await loadClientProvisionedInstance({ populateForm: true });
          await loadAdminProspects();
          alert(`Prospecto restaurado en instancia ${res.instance.instance_id}`);
        } else {
          alert(res?.error || 'No se pudo recuperar el prospecto.');
        }
      });
    });
  } catch (err) {
    box.innerHTML = `<p style="color:#fda4af;">${escapeHtml(err.message)}</p>`;
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
      carouselController?.goToSlide(offerIdx, { announce: true, instant: true });
      requestAnimationFrame(() => {
        const targetFocus =
          wizardCurrentStep === 2
            ? document.getElementById('cfg-display-name')
            : wizardCurrentStep === 3
              ? document.getElementById('btn-test-instance-sim')
              : document.getElementById('cfg-client-name');
        targetFocus?.focus({ preventScroll: true });
      });
    });
  });
  document.getElementById('btn-go-description')?.addEventListener('click', () => {
    carouselController?.goToSlide(0, { announce: true, instant: true });
  });

  document.getElementById('btn-topbar-admin')?.addEventListener('click', (e) => {
    e.preventDefault();
    showView('admin');
  });

  if (hasAdminUrlParam()) {
    showView('admin', { syncUrl: false });
  } else {
    showView('public', { syncUrl: false });
  }

  const handleRouteSync = () => {
    showView(hasAdminUrlParam() ? 'admin' : 'public', { syncUrl: false });
  };
  window.addEventListener('popstate', handleRouteSync);
  window.addEventListener('hashchange', handleRouteSync);

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

    setFeedback('auth-status-msg', 'Conectando con Firebase Auth...', true);
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Verificando...';
    }

    try {
      await signInWithEmailAndPassword(auth, email, pass);
      setFeedback('auth-status-msg', 'Autenticado. Verificando rol de administración...', true);
    } catch (err) {
      setFeedback('auth-status-msg', mapFirebaseAuthError(err), false);
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

  // Selector de Bot / Instancia exclusivo para SuperAdmin (fraustop@outlook.com)
  document.getElementById('admin-instance-switcher')?.addEventListener('change', async (e) => {
    adminSelectedInstanceId = e.target.value || 'servibot-00';
    const instLabel = document.getElementById('admin-instance-label');
    if (instLabel) instLabel.textContent = `Base activa en panel: ${adminSelectedInstanceId}`;
    selectedCatalogItemId = null;
    await Promise.all([
      loadAdminCatalog(),
      loadAdminPromotions(),
      loadAdminContactRules(),
      loadAdminOrders(),
      loadWhatsAppStatus(),
      loadMicrosoftChannelStatus(),
      loadAdminConversations(),
      loadAdminBotSoul(),
      refreshHealth()
    ]);
  });

  // Crear nueva cuenta dentro de Admin (solo SuperAdmin)
  document.getElementById('create-account-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const displayName = document.getElementById('new-acc-name').value.trim();
    const email = document.getElementById('new-acc-email').value.trim();
    const role = document.getElementById('new-acc-role').value;
    const password = document.getElementById('new-acc-password').value;
    const assignedInstanceId = document.getElementById('account-instance-select')?.value || 'servibot-01';
    const subscriptionDays = Number(document.getElementById('account-sub-days')?.value || 30);
    const createBtn = document.getElementById('btn-create-account');

    setFeedback('create-account-feedback', '');
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.textContent = 'Creando cuenta...';
    }

    try {
      const res = await apiFetch('/api/admin/accounts', {
        method: 'POST',
        body: JSON.stringify({
          displayName,
          email,
          role,
          password,
          assigned_instance_id: assignedInstanceId,
          subscription_days: subscriptionDays
        })
      });

      if (!res.ok) {
        setFeedback('create-account-feedback', res.error || 'No se pudo crear la cuenta.', false);
        return;
      }

      setFeedback(
        'create-account-feedback',
        `✅ Cuenta creada en Firebase Auth: ${res.account?.email || email} → Instancia ${assignedInstanceId} (${subscriptionDays} días)`,
        true
      );
      document.getElementById('create-account-form')?.reset();
      const subDaysInput = document.getElementById('account-sub-days');
      if (subDaysInput) subDaysInput.value = '30';
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

  // --- FILTRO PREVIO: FIREBASE AUTH & CONFIRMACIÓN DE CONTACTO ---
  const googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: 'select_account' });

  document.getElementById('btn-prospect-google')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-prospect-google');
    setFeedback('prospect-auth-feedback', '');
    if (btn) btn.disabled = true;
    try {
      await signInWithPopup(auth, googleProvider);
      syncProspectGateUI();
    } catch (err) {
      setFeedback('prospect-auth-feedback', mapFirebaseAuthError(err), false);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById('tab-btn-register')?.addEventListener('click', () => {
    setProspectAuthMode('register');
  });

  document.getElementById('tab-btn-login')?.addEventListener('click', () => {
    setProspectAuthMode('login');
  });

  document.getElementById('form-prospect-auth')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFeedback('prospect-auth-feedback', '');
    const email = document.getElementById('input-prospect-email')?.value.trim();
    const pass = document.getElementById('input-prospect-password')?.value;
    const name = document.getElementById('input-prospect-auth-name')?.value.trim();
    const submitBtn = document.getElementById('btn-prospect-submit-auth');

    if (!email || !pass) {
      setFeedback('prospect-auth-feedback', 'Ingresa tu correo y contraseña.', false);
      return;
    }
    if (pass.length < 6) {
      setFeedback('prospect-auth-feedback', 'La contraseña debe tener al menos 6 caracteres.', false);
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      if (prospectAuthMode === 'register') {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        if (name && cred?.user) {
          await updateProfile(cred.user, { displayName: name }).catch(() => {});
        }
      } else {
        await signInWithEmailAndPassword(auth, email, pass);
        if (email.toLowerCase() === 'fraustop@outlook.com') {
          showView('admin');
          return;
        }
        const me = await apiFetch('/api/admin/me');
        if (me?.ok) {
          showView('admin');
          return;
        }
      }
      syncProspectGateUI();
    } catch (err) {
      setFeedback('prospect-auth-feedback', mapFirebaseAuthError(err), false);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  document.getElementById('btn-skip-auth-wizard')?.addEventListener('click', () => {
    document.getElementById('prospect-gate-shell')?.classList.add('hidden');
    document.getElementById('prospect-gate-shell')?.setAttribute('hidden', '');
    document.getElementById('wizard-unlocked-content')?.classList.remove('hidden');
    document.getElementById('wizard-unlocked-content')?.removeAttribute('hidden');
    goToWizardStep(2, { focusHeading: true });
  });

  document.getElementById('btn-nav-login')?.addEventListener('click', () => {
    closeMenuPopoverIfOpen();
    showView('admin');
  });

  document.getElementById('nav-btn-goto-wizard')?.addEventListener('click', () => {
    closeMenuPopoverIfOpen();
    showView('public');
    const wizardEl = document.getElementById('servibot-wizard-card') || document.getElementById('wizard-pane');
    wizardEl?.scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('form-prospect-contact')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    setFeedback('prospect-contact-feedback', '');
    const name = document.getElementById('prospect-input-name')?.value.trim();
    const business = document.getElementById('prospect-input-business')?.value.trim();
    const phone = document.getElementById('prospect-input-phone')?.value.trim();
    const email = document.getElementById('prospect-input-email')?.value.trim();
    const termsChecked = document.getElementById('prospect-terms-checkbox')?.checked;

    if (!name) {
      setFeedback('prospect-contact-feedback', 'Por favor ingresa tu nombre completo.', false);
      document.getElementById('prospect-input-name')?.focus();
      return;
    }
    if (!business) {
      setFeedback('prospect-contact-feedback', 'Ingresa el nombre de tu empresa o marca.', false);
      document.getElementById('prospect-input-business')?.focus();
      return;
    }
    const digitsOnly = phone ? phone.replace(/\D/g, '') : '';
    if (digitsOnly.length < 10) {
      setFeedback('prospect-contact-feedback', 'Ingresa un número de celular válido a 10 dígitos (o con lada internacional).', false);
      document.getElementById('prospect-input-phone')?.focus();
      return;
    }
    if (!termsChecked) {
      setFeedback('prospect-contact-feedback', 'Debes aceptar los Términos y Condiciones y autorizar el uso de tu celular para notificaciones sobre tu bot.', false);
      return;
    }

    if (!currentUser) {
      setFeedback('prospect-contact-feedback', 'Tu sesión expiró. Por favor identifícate nuevamente.', false);
      syncProspectGateUI();
      return;
    }

    const isGoogle = Boolean(currentUser.providerData?.some((p) => p.providerId === 'google.com'));
    prospectProfile = {
      uid: currentUser.uid,
      email: email || currentUser.email,
      name,
      business,
      phone,
      provider: isGoogle ? 'google' : 'password',
      confirmedAt: new Date().toISOString()
    };
    localStorage.setItem('servibot_prospect_profile', JSON.stringify(prospectProfile));

    if (currentUser.displayName !== name) {
      updateProfile(currentUser, { displayName: name }).catch(() => {});
    }

    unlockWizardWithProspect(prospectProfile);
  });

  const handleProspectSignOut = async () => {
    await signOut(auth);
    prospectProfile = null;
    localStorage.removeItem('servibot_prospect_profile');
    syncProspectGateUI();
  };

  document.getElementById('btn-prospect-switch-account')?.addEventListener('click', handleProspectSignOut);
  document.getElementById('btn-prospect-logout')?.addEventListener('click', handleProspectSignOut);
  document.getElementById('btn-prospect-signout')?.addEventListener('click', () => {
    document.getElementById('user-profile-dialog')?.close();
    handleProspectSignOut();
  });

  document.getElementById('btn-edit-prospect-data')?.addEventListener('click', () => {
    document.getElementById('user-profile-dialog')?.close();
    if (currentUser) {
      showProspectContactStep(currentUser, true);
    }
  });

  document.getElementById('btn-topbar-user')?.addEventListener('click', () => {
    const dialog = document.getElementById('user-profile-dialog');
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  });

  document.getElementById('btn-close-profile-modal')?.addEventListener('click', () => {
    document.getElementById('user-profile-dialog')?.close();
  });

  const openTermsModal = (e) => {
    e.preventDefault();
    const dialog = document.getElementById('terms-modal');
    if (dialog && typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      window.open('/terminos.html', '_blank', 'noopener');
    }
  };
  document.getElementById('link-terms-open')?.addEventListener('click', openTermsModal);
  document.getElementById('footer-terms-link')?.addEventListener('click', openTermsModal);

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

  document.getElementById('btn-locked-go-admin')?.addEventListener('click', () => {
    showView('admin');
    document.getElementById('auth-email')?.focus({ preventScroll: true });
  });

  document.getElementById('btn-locked-new-instance')?.addEventListener('click', () => {
    resetWizardForNewBot();
  });

  document.getElementById('btn-wizard-recover')?.addEventListener('click', async () => {
    const input = document.getElementById('wizard-recover-input');
    const query = input?.value?.trim() || '';
    setFeedback('wizard-recover-status', '');
    if (!query) {
      setFeedback('wizard-recover-status', 'Ingresa tu teléfono, correo o código de recuperación.', false);
      input?.focus();
      return;
    }

    const btn = document.getElementById('btn-wizard-recover');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Buscando...';
    }
    try {
      const res = await apiFetch('/api/instances/recover', {
        method: 'POST',
        body: JSON.stringify({ query })
      });

      if (res?.locked || res?.statusCode === 423) {
        renderLockedWizardState(res);
        setFeedback('wizard-recover-status', res.message || res.error || 'Instancia contratada y bloqueada para uso público.', false);
        goToWizardStep(3, { focusHeading: true });
        return;
      }

      if (!res?.ok || !res.instance) {
        setFeedback('wizard-recover-status', res?.error || 'No se encontró configuración previa para ese dato.', false);
        return;
      }

      const inst = { ...res.instance, catalog: Array.isArray(res.catalog) ? res.catalog : [] };
      clientInstanceId = inst.instance_id;
      provisionedInstance = inst;
      activeBotMode = 'custom';
      activeChatInstanceId = inst.instance_id;
      localStorage.setItem('servibot_client_instance_id', clientInstanceId);

      clearLockedWizardBanner();
      populateWizardForm(inst);
      syncSimulatorHeaderLabel(inst);
      renderWizardSummary(inst);
      updateCheckoutPricing();

      const box = document.getElementById('chat-messages');
      if (box) {
        const greeting =
          inst.welcome_message ||
          `¡Hola! Soy ${inst.display_name} de ${inst.business_name}. ¿En qué te ayudo hoy?`;
        box.innerHTML = `<div class="chat-bubble assistant is-custom-bot">${buildAssistantIdentityHeader('custom', inst)}${escapeHtml(greeting)}</div>`;
      }

      setFeedback('wizard-recover-status', `✅ Configuración recuperada en instancia ${inst.instance_id}.`, true);
      goToWizardStep(3, { focusHeading: true });
    } catch (err) {
      setFeedback('wizard-recover-status', `Error recuperando instancia: ${err.message}`, false);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Recuperar Bot';
      }
    }
  });

  document.getElementById('servibot-wizard-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (wizardCurrentStep === 1) {
      if (validateWizardStep1()) goToWizardStep(2, { focusHeading: true });
      return;
    }

    if (!currentUser || !prospectProfile) {
      setFeedback('instance-save-status', 'Por favor inicia sesión y confirma tus datos de contacto antes de crear tu ServiBot.', false);
      syncProspectGateUI();
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
      client_name: document.getElementById('cfg-client-name')?.value.trim() || prospectProfile?.name || '',
      client_contact: document.getElementById('cfg-client-contact')?.value.trim() || prospectProfile?.phone || '',
      business_name: document.getElementById('cfg-business-name')?.value.trim() || prospectProfile?.business || '',
      admin_email: prospectProfile?.email || currentUser?.email || '',
      firebase_uid: currentUser?.uid || prospectProfile?.uid || '',
      display_name: displayInput.value.trim(),
      tone: document.getElementById('cfg-tone')?.value.trim() || '',
      ai_soul: soulInput.value.trim(),
      system_prompt: document.getElementById('cfg-system-prompt')?.value.trim() || '',
      welcome_message: document.getElementById('cfg-welcome-message')?.value.trim() || '',
      initial_products: document.getElementById('cfg-initial-products')?.value.trim() || ''
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

      if (res?.locked || res?.statusCode === 423) {
        renderLockedWizardState(res);
        setFeedback('instance-save-status', res.message || res.error || 'Esta instancia ya fue pagada y quedó bloqueada en la vista pública.', false);
        goToWizardStep(3, { focusHeading: true });
        return;
      }

      if (!res.ok || !res.instance) {
        setFeedback('instance-save-status', res.error || 'No se pudo configurar tu ServiBot.', false);
        return;
      }

      const inst = { ...res.instance, catalog: Array.isArray(res.catalog) ? res.catalog : [] };
      clientInstanceId = inst.instance_id;
      activeBotMode = 'custom';
      activeChatInstanceId = inst.instance_id;
      provisionedInstance = inst;
      localStorage.setItem('servibot_client_instance_id', clientInstanceId);

      clearLockedWizardBanner();
      const idHidden = document.getElementById('cfg-instance-id');
      if (idHidden) idHidden.value = inst.instance_id;

      syncSimulatorHeaderLabel(inst);
      renderWizardSummary(inst);
      toggleCheckoutPanel(false);
      updateCheckoutPricing();

      const box = document.getElementById('chat-messages');
      if (box) {
        const greeting =
          inst.welcome_message ||
          `¡Hola! Soy ${inst.display_name} de ${inst.business_name}. ¿En qué te ayudo hoy?`;
        box.innerHTML = `<div class="chat-bubble assistant is-custom-bot">${buildAssistantIdentityHeader('custom', inst)}${escapeHtml(greeting)}</div>`;
      }

      setFeedback('checkout-feedback', '');
      goToWizardStep(3, { focusHeading: true });
    } catch (err) {
      setFeedback('instance-save-status', `Error de conexión: ${err.message}`, false);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Crear mi ServiBot y Probar en el Simulador →';
      }
    }
  });

  document.getElementById('btn-test-instance-sim')?.addEventListener('click', (e) => {
    const inst = provisionedInstance;
    setSimulatorBotMode('custom', { announceGreeting: false });
    openMobileSimulator(e.currentTarget);

    const input = document.getElementById('chat-input');
    const box = document.getElementById('chat-messages');
    const currentBiz = inst?.business_name || document.getElementById('cfg-business-name')?.value.trim() || 'mi negocio';
    const currentName = inst?.display_name || document.getElementById('cfg-display-name')?.value.trim() || 'ServiBot';
    const currentWelcome =
      inst?.welcome_message ||
      document.getElementById('cfg-welcome-message')?.value.trim() ||
      `¡Hola! Soy ${currentName} de ${currentBiz}.`;

    if (box) {
      box.innerHTML = `<div class="chat-bubble assistant is-custom-bot">${buildAssistantIdentityHeader('custom', inst || { display_name: currentName, business_name: currentBiz })}${escapeHtml(currentWelcome)}</div>`;
    }
    if (input) {
      input.value = 'Hola, ¿me puedes explicar cómo atiendes a los clientes de nuestro negocio?';
      input.focus();
    }
  });

  // Controles de apertura/cierre móvil y cambio entre Nuestro Bot vs Mi Bot Creado
  document.getElementById('btn-sim-fab')?.addEventListener('click', (e) => {
    const panel = document.getElementById('simulator-panel');
    if (panel?.classList.contains('is-mobile-open')) {
      closeMobileSimulator();
    } else {
      openMobileSimulator(e.currentTarget);
    }
  });

  document.getElementById('btn-topbar-sim')?.addEventListener('click', (e) => {
    const panel = document.getElementById('simulator-panel');
    if (panel?.classList.contains('is-mobile-open')) {
      closeMobileSimulator();
    } else {
      openMobileSimulator(e.currentTarget);
    }
  });

  document.getElementById('btn-close-sim-drawer')?.addEventListener('click', () => {
    closeMobileSimulator();
  });

  document.getElementById('btn-minimize-chat')?.addEventListener('click', () => {
    toggleSimulatorMinimize(true);
  });

  document.getElementById('btn-expand-sim-tab')?.addEventListener('click', () => {
    toggleSimulatorMinimize(false);
  });

  ['cfg-business-name', 'cfg-display-name'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => {
      const customLbl = document.getElementById('sim-switch-custom-label');
      const tabLbl = document.getElementById('sim-tab-label');
      const name =
        document.getElementById('cfg-display-name')?.value.trim() ||
        document.getElementById('cfg-business-name')?.value.trim() ||
        'Mi Bot';
      if (customLbl) customLbl.textContent = name;
      if (tabLbl && activeBotMode === 'custom') tabLbl.textContent = name;
    });
  });

  document.getElementById('sim-backdrop')?.addEventListener('click', () => {
    closeMobileSimulator();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const panel = document.getElementById('simulator-panel');
      if (panel?.classList.contains('is-mobile-open')) {
        closeMobileSimulator();
      }
    }
  });

  document.getElementById('btn-switch-official-bot')?.addEventListener('click', () => {
    setSimulatorBotMode('official', { announceGreeting: true });
  });

  document.getElementById('btn-switch-custom-bot')?.addEventListener('click', () => {
    setSimulatorBotMode('custom', { announceGreeting: true });
  });

  document.getElementById('btn-go-checkout')?.addEventListener('click', () => {
    setFeedback('checkout-feedback', '');
    toggleCheckoutPanel(true);
  });

  document.getElementById('btn-back-from-checkout')?.addEventListener('click', () => {
    setFeedback('checkout-feedback', '');
    toggleCheckoutPanel(false);
  });

  document.querySelectorAll('.checkout-addon-check').forEach((chk) => {
    chk.addEventListener('change', () => {
      resetCheckoutMpCta();
      setFeedback('checkout-feedback', '');
      updateCheckoutPricing();
    });
  });

  document.getElementById('btn-confirm-checkout')?.addEventListener('click', async () => {
    if (!provisionedInstance) {
      setFeedback('checkout-feedback', 'Primero completa el Paso 2 para crear tu ServiBot.', false);
      return;
    }

    if (provisionedInstance.locked_for_public) {
      renderLockedWizardState(provisionedInstance);
      return;
    }

    const adminEmailInput = document.getElementById('checkout-admin-email');
    const adminPasswordInput = document.getElementById('checkout-admin-password');
    const admin_email = adminEmailInput?.value?.trim() || '';
    const temp_password = adminPasswordInput?.value || '';

    if (admin_email && temp_password.length < 6) {
      setFeedback('checkout-feedback', 'Ingresa una contraseña de al menos 6 caracteres para activar tu Admin Estándar.', false);
      adminPasswordInput?.focus();
      return;
    }
    if (temp_password && !admin_email) {
      setFeedback('checkout-feedback', 'Ingresa el correo electrónico con el que entrarás a tu Admin Estándar.', false);
      adminEmailInput?.focus();
      return;
    }

    const btn = document.getElementById('btn-confirm-checkout');
    setFeedback('checkout-feedback', '');
    resetCheckoutMpCta();

    const customItems = [
      {
        slug: 'servibot-configurado',
        name: `ServiBot Configurado (${provisionedInstance.display_name || provisionedInstance.instance_id})`,
        price: 1500,
        currency: 'MXN',
        billing_cycle: 'mensual'
      }
    ];

    document.querySelectorAll('.checkout-addon-check').forEach((chk) => {
      if (chk.checked) {
        customItems.push({
          slug: chk.dataset.slug || chk.id,
          name: chk.dataset.label || chk.dataset.name || 'Servicio opcional',
          price: Number(chk.value || chk.dataset.price || 0),
          currency: 'MXN',
          billing_cycle: 'mensual'
        });
      }
    });

    const subtotalPesos = customItems.reduce((acc, it) => acc + Number(it.price || 0), 0);
    const ivaPesos = Math.round(subtotalPesos * 0.16);
    const totalConIva = subtotalPesos + ivaPesos;
    const addonLabels = customItems
      .slice(1)
      .map((it) => `${it.name} ($${it.price})`)
      .join(', ');

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Generando link de Mercado Pago...';
    }

    try {
      const data = await apiFetch('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          instance_id: 'servibot-00',
          target_instance_id: provisionedInstance.instance_id,
          admin_email,
          temp_password,
          customer_name:
            provisionedInstance.client_name ||
            document.getElementById('cfg-client-name')?.value?.trim() ||
            'Cliente Web',
          customer_contact:
            provisionedInstance.client_contact ||
            document.getElementById('cfg-client-contact')?.value?.trim() ||
            'Sin contacto',
          customer_company: provisionedInstance.business_name || '',
          channel: 'web',
          custom_items: customItems,
          apply_tax: true,
          notes: `Configuración ServiBot (${provisionedInstance.instance_id}). Adicionales: ${addonLabels || 'Ninguno'}. Subtotal $${subtotalPesos} + IVA 16% ($${ivaPesos}) = $${totalConIva} MXN.`
        })
      });

      if (!data.ok || !data.order) {
        setFeedback('checkout-feedback', data.error || 'No se pudo generar tu orden de pago.', false);
        return;
      }

      const orderCode = data.order.order_code;
      const srvSub = Number(data.order.subtotal_amount ?? subtotalPesos);
      const srvTax = Number(data.order.tax_amount ?? ivaPesos);
      const srvTotal = Number(data.order.total_amount ?? totalConIva);
      const fmtSub = srvSub.toLocaleString('es-MX');
      const fmtTax = srvTax.toLocaleString('es-MX');
      const fmtTotal = srvTotal.toLocaleString('es-MX');

      const mpUrl = data.mercadopago?.init_point || '';
      if (mpUrl) {
        const wrap = document.getElementById('checkout-mp-cta-wrap');
        const link = document.getElementById('btn-mp-pay-now');
        if (link) {
          link.setAttribute('href', mpUrl);
          link.textContent = `Ir a Pagar en Mercado Pago ($${fmtTotal} MXN) ↗`;
        }
        if (wrap) {
          wrap.classList.remove('hidden');
          wrap.removeAttribute('hidden');
        }
        setFeedback(
          'checkout-feedback',
          `¡Pedido ${orderCode} listo para pago! Subtotal: $${fmtSub} + IVA (16%): $${fmtTax} = Total: $${fmtTotal} MXN. Haz clic en el botón azul para completar tu pago en Mercado Pago.`,
          true
        );
      } else {
        setFeedback(
          'checkout-feedback',
          `¡Pedido ${orderCode} registrado! Subtotal: $${fmtSub} + IVA (16%): $${fmtTax} = Total: $${fmtTotal} MXN.`,
          true
        );
      }

      const box = document.getElementById('chat-messages');
      if (box) {
        const isCustom = activeBotMode === 'custom' && Boolean(provisionedInstance);
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble assistant ${isCustom ? 'is-custom-bot' : 'is-official-bot'}`;
        const mpHtml = mpUrl
          ? `<br /><a href="${escapeHtml(mpUrl)}" target="_blank" rel="noopener noreferrer" style="color: #8cc8ff; font-weight: 700; text-decoration: underline;">Pagar $${escapeHtml(fmtTotal)} MXN en Mercado Pago ↗</a>`
          : '';
        bubble.innerHTML = `${buildAssistantIdentityHeader(isCustom ? 'custom' : 'official', provisionedInstance)}Pedido <strong>${escapeHtml(orderCode)}</strong> · Subtotal: <strong>$${escapeHtml(fmtSub)}</strong> + IVA México (16%): <strong>$${escapeHtml(fmtTax)}</strong> = <strong>$${escapeHtml(fmtTotal)} MXN</strong> (${addonLabels || 'solo ServiBot configurado'}).${mpHtml}`;
        box.appendChild(bubble);
        box.scrollTop = box.scrollHeight;
      }

      await refreshHealth();
    } catch (err) {
      setFeedback('checkout-feedback', `Error al generar orden de pago: ${err.message}`, false);
    } finally {
      if (btn) {
        btn.disabled = false;
        updateCheckoutPricing();
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
    setSimulatorBotMode(activeBotMode, { announceGreeting: true });
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

  // Botones para crear nuevo producto (cabecera del listado y estado vacío)
  document.getElementById('btn-open-create-catalog')?.addEventListener('click', () => openCatalogModal('create'));
  document.getElementById('btn-empty-create-catalog')?.addEventListener('click', () => openCatalogModal('create'));

  // Botón editar producto seleccionado
  document.getElementById('btn-edit-selected-item')?.addEventListener('click', () => {
    const item = adminCatalogCache.find((it) => it.id === selectedCatalogItemId);
    if (item) {
      openCatalogModal('edit', item);
    }
  });

  // Botón enviar producto seleccionado al Bot aislado de esta instancia
  document.getElementById('btn-send-selected-to-bot')?.addEventListener('click', async () => {
    const item = adminCatalogCache.find((it) => it.id === selectedCatalogItemId);
    if (!item) return;
    await apiFetch(buildAdminEndpoint(`/api/catalog/${item.id}/send-to-bot`), {
      method: 'POST',
      body: JSON.stringify({ sent_to_bot: true, active: true })
    });
    await loadAdminCatalog();
    await loadPublicCatalog();
  });

  // Botón eliminar producto seleccionado
  document.getElementById('btn-delete-selected-item')?.addEventListener('click', async () => {
    const item = adminCatalogCache.find((it) => it.id === selectedCatalogItemId);
    if (!item) return;
    if (!confirm(`¿Deseas eliminar "${item.name}" del catálogo? Esta acción no se puede deshacer.`)) return;
    await apiFetch(buildAdminEndpoint(`/api/catalog/${item.id}`), { method: 'DELETE' });
    selectedCatalogItemId = null;
    await loadAdminCatalog();
    await loadPublicCatalog();
  });

  // Filtro de búsqueda en tiempo real sobre el listado
  document.getElementById('catalog-search-input')?.addEventListener('input', (e) => {
    renderAdminCatalogList(e.target.value.trim());
  });

  async function saveCatalogFormItem(forceSendToBot = null) {
    const id = document.getElementById('item-id').value;
    const sentCheckbox = document.getElementById('item-sent-to-bot');
    const sentToBot = forceSendToBot !== null ? forceSendToBot : Boolean(sentCheckbox ? sentCheckbox.checked : true);
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
      active: document.getElementById('item-active').checked,
      sent_to_bot: sentToBot
    };

    let res;
    if (id) {
      res = await apiFetch(buildAdminEndpoint(`/api/catalog/${id}`), { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      res = await apiFetch(buildAdminEndpoint('/api/catalog'), { method: 'POST', body: JSON.stringify(payload) });
    }

    if (res?.item?.id) {
      selectedCatalogItemId = res.item.id;
    }

    document.getElementById('catalog-modal')?.close();
    resetCatalogForm();
    await loadAdminCatalog();
    await loadPublicCatalog();
  }

  // Guardar Producto / Servicio en Admin (Modal)
  document.getElementById('catalog-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveCatalogFormItem(null);
  });

  // Guardar y Enviar directamente al Bot
  document.getElementById('btn-save-send-to-bot')?.addEventListener('click', async () => {
    const form = document.getElementById('catalog-form');
    if (form && !form.reportValidity()) return;
    await saveCatalogFormItem(true);
  });

  // Promociones reales en interfaz aislada por Bot
  async function savePromotionFormItem(sentToBot) {
    const title = document.getElementById('promo-title')?.value.trim() || '';
    if (!title) return;
    const discount_text = document.getElementById('promo-discount')?.value.trim() || '';
    const rawPrice = document.getElementById('promo-price')?.value;
    const promo_price = rawPrice !== '' && rawPrice != null ? Number(rawPrice) : null;
    const description = document.getElementById('promo-desc')?.value.trim() || '';

    await apiFetch(buildAdminEndpoint('/api/promotions'), {
      method: 'POST',
      body: JSON.stringify({
        title,
        discount_text,
        promo_price,
        description,
        active: true,
        sent_to_bot: Boolean(sentToBot)
      })
    });

    document.getElementById('promotion-form')?.reset();
    await loadAdminPromotions();
  }

  document.getElementById('promotion-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await savePromotionFormItem(false);
  });

  document.getElementById('btn-save-send-promo')?.addEventListener('click', async () => {
    const form = document.getElementById('promotion-form');
    if (form && !form.reportValidity()) return;
    await savePromotionFormItem(true);
  });

  // Listas de Control: Lista Blanca, Omisiones y Lista Negra
  document.getElementById('contact-rule-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const contact_value = document.getElementById('rule-contact-value')?.value.trim() || '';
    const list_type = document.getElementById('rule-list-type')?.value || 'whitelist';
    const label = document.getElementById('rule-label')?.value.trim() || '';
    if (!contact_value) return;

    await apiFetch(buildAdminEndpoint('/api/contact-rules'), {
      method: 'POST',
      body: JSON.stringify({ contact_value, list_type, label })
    });

    document.getElementById('contact-rule-form')?.reset();
    await loadAdminContactRules();
  });

  // Registro de Folios VIP en Servidores Dedicados (solo SuperAdmin)
  document.getElementById('vip-instance-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const folio = document.getElementById('vip-folio')?.value.trim() || '';
    const monthly_price = Number(document.getElementById('vip-price')?.value || 0);
    const business_name = document.getElementById('vip-business')?.value.trim() || '';
    const client_name = document.getElementById('vip-client-name')?.value.trim() || '';
    const client_contact = document.getElementById('vip-client-contact')?.value.trim() || '';
    const server_url = document.getElementById('vip-server-url')?.value.trim() || '';
    const custom_admin_url = document.getElementById('vip-admin-url')?.value.trim() || '';
    const admin_email = document.getElementById('vip-admin-email')?.value.trim() || '';
    const rawApiConfig = document.getElementById('vip-api-config')?.value.trim() || '{}';
    const notes = document.getElementById('vip-notes')?.value.trim() || '';

    let api_config = {};
    try {
      api_config = rawApiConfig ? JSON.parse(rawApiConfig) : {};
    } catch {
      setFeedback('vip-feedback', 'El JSON de APIs específicas no tiene formato válido.', false);
      return;
    }

    const res = await apiFetch('/api/vip-instances', {
      method: 'POST',
      body: JSON.stringify({
        folio,
        monthly_price,
        business_name,
        client_name,
        client_contact,
        server_url,
        custom_admin_url,
        admin_email,
        api_config,
        notes
      })
    });

    if (!res?.ok) {
      setFeedback('vip-feedback', res?.error || 'No se pudo guardar el folio VIP.', false);
      return;
    }

    setFeedback('vip-feedback', `✅ Folio VIP ${res.vip?.folio || ''} guardado.`, true);
    document.getElementById('vip-instance-form')?.reset();
    await loadAdminVipInstances();
  });

  document.getElementById('btn-cancel-edit')?.addEventListener('click', () => {
    resetCatalogForm();
    document.getElementById('catalog-modal')?.close();
  });

  // Light-dismiss fallback para el modal de catálogo (modern-web-guidance `light-dismiss-a-dialog`)
  const catModal = document.getElementById('catalog-modal');
  if (catModal && !('closedBy' in HTMLDialogElement.prototype)) {
    catModal.addEventListener('click', (event) => {
      if (event.target !== catModal) return;
      const rect = catModal.getBoundingClientRect();
      const isInside = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
      if (!isInside) catModal.close();
    });
  }

  // Controles de Canales (WhatsApp, Correo, Teams)
  document.getElementById('btn-wa-refresh')?.addEventListener('click', loadWhatsAppStatus);
  document.getElementById('btn-wa-logout')?.addEventListener('click', async () => {
    await apiFetch(buildAdminEndpoint('/api/channels/whatsapp/logout'), { method: 'POST' });
    setTimeout(loadWhatsAppStatus, 1800);
  });

  const outBox = document.getElementById('channel-test-output');

  document.getElementById('btn-sim-wa')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Enviando evento MESSAGES_UPSERT por Evolution (:10001 -> :10000 -> Python -> Ollama :10002)...';
    const phone = document.getElementById('sim-wa-phone').value;
    const text = document.getElementById('sim-wa-text').value;
    const res = await apiFetch(buildAdminEndpoint('/api/channels/whatsapp/simulate'), {
      method: 'POST',
      body: JSON.stringify({ phone, name: 'Cliente WhatsApp', text })
    });
    if (outBox) outBox.textContent = JSON.stringify(res, null, 2);
    await loadAdminOrders();
    await loadAdminConversations();
    await refreshHealth();
  });

  // Presets rápidos para completar servidores de Correo
  document.getElementById('btn-email-preset-gmail')?.addEventListener('click', () => {
    const imap = document.getElementById('cfg-imap-host');
    const iport = document.getElementById('cfg-imap-port');
    const smtp = document.getElementById('cfg-smtp-host');
    const sport = document.getElementById('cfg-smtp-port');
    if (imap) imap.value = 'imap.gmail.com';
    if (iport) iport.value = 993;
    if (smtp) smtp.value = 'smtp.gmail.com';
    if (sport) sport.value = 465;
    if (outBox) outBox.textContent = 'ℹ️ Servidores de Gmail cargados (IMAP 993 SSL, SMTP 465 SSL). Recuerda usar Contraseña de Aplicación de Google.';
  });

  document.getElementById('btn-email-preset-outlook')?.addEventListener('click', () => {
    const imap = document.getElementById('cfg-imap-host');
    const iport = document.getElementById('cfg-imap-port');
    const smtp = document.getElementById('cfg-smtp-host');
    const sport = document.getElementById('cfg-smtp-port');
    if (imap) imap.value = 'outlook.office365.com';
    if (iport) iport.value = 993;
    if (smtp) smtp.value = 'smtp.office365.com';
    if (sport) sport.value = 587;
    if (outBox) outBox.textContent = 'ℹ️ Servidores de Outlook / Hotmail / Microsoft 365 cargados (IMAP 993, SMTP 587 STARTTLS).';
  });

  document.getElementById('btn-email-preset-yahoo')?.addEventListener('click', () => {
    const imap = document.getElementById('cfg-imap-host');
    const iport = document.getElementById('cfg-imap-port');
    const smtp = document.getElementById('cfg-smtp-host');
    const sport = document.getElementById('cfg-smtp-port');
    if (imap) imap.value = 'imap.mail.yahoo.com';
    if (iport) iport.value = 993;
    if (smtp) smtp.value = 'smtp.mail.yahoo.com';
    if (sport) sport.value = 465;
    if (outBox) outBox.textContent = 'ℹ️ Servidores de Yahoo cargados (IMAP 993, SMTP 465).';
  });

  document.getElementById('btn-email-preset-custom')?.addEventListener('click', () => {
    const imap = document.getElementById('cfg-imap-host');
    const iport = document.getElementById('cfg-imap-port');
    const smtp = document.getElementById('cfg-smtp-host');
    const sport = document.getElementById('cfg-smtp-port');
    if (imap) imap.value = 'mail.tuempresa.com';
    if (iport) iport.value = 993;
    if (smtp) smtp.value = 'mail.tuempresa.com';
    if (sport) sport.value = 465;
    if (outBox) outBox.textContent = 'ℹ️ Servidores corporativos / cPanel cargados. Sustituye tuempresa.com por tu dominio oficial.';
  });

  // Guardar configuración de Correo (IMAP / SMTP con Usuario y Contraseña)
  document.getElementById('email-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (outBox) outBox.textContent = 'Guardando configuración de Correo Electrónico...';
    const payload = {
      imap_host: document.getElementById('cfg-imap-host')?.value.trim() || 'outlook.office365.com',
      imap_port: Number(document.getElementById('cfg-imap-port')?.value || 993),
      smtp_host: document.getElementById('cfg-smtp-host')?.value.trim() || 'smtp.office365.com',
      smtp_port: Number(document.getElementById('cfg-smtp-port')?.value || 465),
      user: document.getElementById('cfg-email-user')?.value.trim() || '',
      pass: document.getElementById('cfg-email-pass')?.value.trim() || '',
      enabled: Boolean(document.getElementById('cfg-email-enabled')?.checked)
    };
    const res = await apiFetch('/api/settings/email_config', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (outBox) outBox.textContent = res.ok ? '✅ Configuración de Correo Electrónico guardada con éxito en SQLite.' : `❌ Error: ${res.error}`;
    await loadAdminSettings();
  });

  // Guardar configuración de Microsoft Teams
  document.getElementById('teams-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (outBox) outBox.textContent = 'Guardando configuración de Microsoft Teams...';
    const payload = {
      bot_display_name: document.getElementById('cfg-teams-name')?.value.trim() || 'Servi-Bot Teams',
      incoming_webhook_url: document.getElementById('cfg-teams-webhook')?.value.trim() || '',
      enabled: Boolean(document.getElementById('cfg-teams-enabled')?.checked)
    };
    const res = await apiFetch('/api/settings/teams_config', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (outBox) outBox.textContent = res.ok ? '✅ Configuración de Microsoft Teams guardada con éxito.' : `❌ Error: ${res.error}`;
    await loadAdminSettings();
  });

  // Guardar configuración de Telegram
  document.getElementById('telegram-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (outBox) outBox.textContent = 'Guardando configuración de Telegram Bot...';
    const payload = {
      bot_name: document.getElementById('cfg-telegram-name')?.value.trim() || 'Servi-Bot Telegram',
      bot_username: document.getElementById('cfg-telegram-username')?.value.trim() || '',
      bot_token: document.getElementById('cfg-telegram-token')?.value.trim() || '',
      enabled: Boolean(document.getElementById('cfg-telegram-enabled')?.checked)
    };
    const res = await apiFetch('/api/settings/telegram_config', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (outBox) outBox.textContent = res.ok ? '✅ Configuración de Telegram guardada con éxito.' : `❌ Error: ${res.error}`;
    await loadAdminSettings();
  });

  // Guardar configuración de Instagram
  document.getElementById('instagram-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (outBox) outBox.textContent = 'Guardando configuración de Instagram...';
    const payload = {
      account_username: document.getElementById('cfg-instagram-user')?.value.trim() || '',
      access_token: document.getElementById('cfg-instagram-token')?.value.trim() || '',
      enabled: Boolean(document.getElementById('cfg-instagram-enabled')?.checked)
    };
    const res = await apiFetch('/api/settings/instagram_config', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (outBox) outBox.textContent = res.ok ? '✅ Configuración de Instagram guardada con éxito.' : `❌ Error: ${res.error}`;
    await loadAdminSettings();
  });

  // Guardar configuración de TikTok
  document.getElementById('tiktok-config-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (outBox) outBox.textContent = 'Guardando configuración de TikTok...';
    const payload = {
      account_username: document.getElementById('cfg-tiktok-user')?.value.trim() || '',
      client_key: document.getElementById('cfg-tiktok-key')?.value.trim() || '',
      enabled: Boolean(document.getElementById('cfg-tiktok-enabled')?.checked)
    };
    const res = await apiFetch('/api/settings/tiktok_config', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (outBox) outBox.textContent = res.ok ? '✅ Configuración de TikTok guardada con éxito.' : `❌ Error: ${res.error}`;
    await loadAdminSettings();
  });

  // Simulador de Mensaje de Telegram
  document.getElementById('btn-sim-telegram')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Simulando mensaje entrante en Telegram (ejecutando IA Python)...';
    const user = document.getElementById('sim-telegram-user')?.value.trim();
    const text = document.getElementById('sim-telegram-text')?.value.trim();
    const res = await apiFetch(buildAdminEndpoint('/api/channels/telegram/simulate'), {
      method: 'POST',
      body: JSON.stringify({ user, text })
    });
    if (outBox) outBox.textContent = JSON.stringify(res, null, 2);
    await loadAdminOrders();
    await loadAdminConversations();
    await refreshHealth();
  });

  // Simulador de Comentario en Instagram
  document.getElementById('btn-sim-instagram')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Simulando comentario entrante en publicación de Instagram...';
    const user = document.getElementById('sim-instagram-user')?.value.trim();
    const postId = document.getElementById('sim-instagram-post')?.value.trim();
    const comment = document.getElementById('sim-instagram-comment')?.value.trim();
    const res = await apiFetch(buildAdminEndpoint('/api/channels/instagram/simulate'), {
      method: 'POST',
      body: JSON.stringify({ user, post_id: postId, comment })
    });
    if (outBox) outBox.textContent = JSON.stringify(res, null, 2);
    await loadAdminOrders();
    await loadAdminConversations();
    await refreshHealth();
  });

  // Simulador de Comentario en TikTok
  document.getElementById('btn-sim-tiktok')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Simulando comentario entrante en video de TikTok...';
    const user = document.getElementById('sim-tiktok-user')?.value.trim();
    const videoId = document.getElementById('sim-tiktok-video')?.value.trim();
    const comment = document.getElementById('sim-tiktok-comment')?.value.trim();
    const res = await apiFetch(buildAdminEndpoint('/api/channels/tiktok/simulate'), {
      method: 'POST',
      body: JSON.stringify({ user, video_id: videoId, comment })
    });
    if (outBox) outBox.textContent = JSON.stringify(res, null, 2);
    await loadAdminOrders();
    await loadAdminConversations();
    await refreshHealth();
  });

  // Simulador de Correo Entrante
  document.getElementById('btn-sim-email')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Procesando correo entrante con Python Worker + Ollama :10002...';
    const fromEmail = document.getElementById('sim-email-from')?.value.trim() || 'cliente@pyme.com';
    const subject = document.getElementById('sim-email-subject')?.value.trim() || 'Solicitud de Contratación Servi-Bot';
    const body = document.getElementById('sim-email-body')?.value.trim() || '';
    const res = await apiFetch(buildAdminEndpoint('/api/channels/email/simulate'), {
      method: 'POST',
      body: JSON.stringify({
        fromEmail,
        fromName: 'Cliente Correo',
        subject,
        body
      })
    });
    if (outBox) outBox.textContent = JSON.stringify(res, null, 2);
    await loadAdminOrders();
    await loadAdminConversations();
    await refreshHealth();
  });

  // Simulador de Teams
  document.getElementById('btn-sim-teams')?.addEventListener('click', async () => {
    if (outBox) outBox.textContent = 'Enviando payload al canal de Microsoft Teams (/api/channels/teams/simulate)...';
    const user = document.getElementById('sim-teams-user')?.value.trim();
    const text = document.getElementById('sim-teams-text')?.value.trim();
    const res = await apiFetch(buildAdminEndpoint('/api/channels/teams/simulate'), {
      method: 'POST',
      body: JSON.stringify({ user, text })
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

  // ==================== SECCIÓN ALMA DEL BOT (PERSONALIDAD E IA) ====================
  // 1. Guardar cambios del Alma e Instrucciones del Bot
  document.getElementById('bot-soul-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const instanceId = adminSelectedInstanceId || 'servibot-00';
    const saveBtn = document.getElementById('btn-save-bot-soul');

    const displayName = document.getElementById('soul-display-name')?.value.trim();
    const businessName = document.getElementById('soul-business-name')?.value.trim();
    const welcomeMessage = document.getElementById('soul-welcome-message')?.value.trim();
    const tone = document.getElementById('soul-tone')?.value.trim();
    const aiSoul = document.getElementById('soul-ai-soul')?.value.trim();
    const systemPrompt = document.getElementById('soul-system-prompt')?.value.trim();

    if (!displayName) {
      setFeedback('bot-soul-feedback', '⚠️ El nombre del asistente es obligatorio.', false);
      return;
    }
    if (!businessName) {
      setFeedback('bot-soul-feedback', '⚠️ El nombre de la empresa o marca es obligatorio.', false);
      return;
    }
    if (!aiSoul) {
      setFeedback('bot-soul-feedback', '⚠️ El propósito y alma de la IA (AI Soul) es obligatorio.', false);
      return;
    }

    setFeedback('bot-soul-feedback', 'Guardando cambios en el alma del bot...', true);
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Guardando...';
    }

    try {
      const res = await apiFetch(`/api/instances/${encodeURIComponent(instanceId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          display_name: displayName,
          business_name: businessName,
          welcome_message: welcomeMessage,
          tone: tone || 'Profesional, cálido y enfocado en servicio',
          ai_soul: aiSoul,
          system_prompt: systemPrompt
        })
      });

      if (!res.ok) {
        throw new Error(res.error || 'Error al guardar.');
      }

      setFeedback('bot-soul-feedback', '✅ ¡Alma, personalidad e instrucciones guardadas con éxito!', true);

      // Sincronizar en memoria y en el encabezado del simulador
      if (provisionedInstance && provisionedInstance.instance_id === instanceId) {
        provisionedInstance = { ...provisionedInstance, ...res.instance };
        syncSimulatorHeaderLabel(provisionedInstance);
      }
    } catch (err) {
      setFeedback('bot-soul-feedback', `⚠️ Error al guardar: ${err.message}`, false);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Guardar Alma y Reglas del Bot';
      }
    }
  });

  // 2. Chips de selección rápida de tono para el alma
  document.querySelectorAll('#soul-tone-presets .preset-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const toneVal = btn.dataset.tone;
      const toneInput = document.getElementById('soul-tone');
      if (toneInput && toneVal) {
        toneInput.value = toneVal;
        document.querySelectorAll('#soul-tone-presets .preset-chip').forEach((b) => {
          const isCurrent = b === btn;
          b.classList.toggle('is-selected', isCurrent);
          b.setAttribute('aria-pressed', String(isCurrent));
        });
      }
    });
  });

  // 3. Plantillas rápidas para insertar en instrucciones y preguntas específicas
  const appendToSystemPrompt = (snippet) => {
    const area = document.getElementById('soul-system-prompt');
    if (!area) return;
    const current = area.value.trim();
    area.value = current ? `${current}\n\n${snippet.trim()}` : snippet.trim();
    area.focus();
    area.scrollTop = area.scrollHeight;
  };

  document.getElementById('btn-tmpl-faq')?.addEventListener('click', () => {
    appendToSystemPrompt(
      `--- PREGUNTAS FRECUENTES (FAQ) ---\n` +
      `- Horarios de atención: Lunes a Sábado de 9:00 a 19:00 hrs.\n` +
      `- Ubicación: Av. Principal #123, Col. Centro.\n` +
      `- Formas de pago: Tarjeta de débito/crédito, transferencia bancaria y efectivo.\n` +
      `- Facturación: Emitimos factura fiscal (CFDI) dentro del mes de compra.`
    );
  });

  document.getElementById('btn-tmpl-hours')?.addEventListener('click', () => {
    appendToSystemPrompt(
      `--- REGLAS DE ATENCIÓN Y CONTACTO ---\n` +
      `- Si el cliente pregunta por cotización personalizada o agendar cita, solicita su nombre y teléfono para que un asesor le dé seguimiento.\n` +
      `- Si escriben fuera de horario laboral, agradecer amablemente e indicar que su mensaje será atendido a primera hora del siguiente día hábil.`
    );
  });

  document.getElementById('btn-tmpl-limits')?.addEventListener('click', () => {
    appendToSystemPrompt(
      `--- REGLAS ESTRICTAS Y PROHIBICIONES ---\n` +
      `- NUNCA inventar precios, descuentos ni servicios que no estén explícitamente en el catálogo registrado.\n` +
      `- Responder siempre con amabilidad, precisión y sin usar respuestas excesivamente largas (máximo 3 párrafos cortos).\n` +
      `- Si no conoces la respuesta a una duda técnica muy específica, indica amablemente que consultarás con el equipo correspondiente.`
    );
  });

  // 4. Botón "Probar en Simulador" desde el panel de Alma
  document.getElementById('btn-soul-test-simulator')?.addEventListener('click', () => {
    openMobileSimulator();
    if (adminSelectedInstanceId && adminSelectedInstanceId !== 'servibot-00') {
      setSimulatorBotMode('custom', { announceGreeting: true });
    } else {
      setSimulatorBotMode('official', { announceGreeting: true });
    }
  });

  // 5. Botón de acceso directo en el encabezado del simulador
  document.getElementById('btn-sim-edit-soul')?.addEventListener('click', () => {
    if (currentUser) {
      switchAdminTab('tab-bot-soul');
      closeMobileSimulator();
    } else {
      closeMobileSimulator();
      carouselController?.goToSlide?.(3, { instant: true });
      goToWizardStep(2, { focusHeading: true });
    }
  });
}

async function handleMercadoPagoReturn() {
  try {
    const params = new URLSearchParams(window.location.search);
    const mpStatus = params.get('mp_status') || params.get('collection_status') || '';
    const orderCode = params.get('order') || params.get('external_reference') || '';
    if (!mpStatus) return;

    const statusMap = {
      approved: {
        ok: true,
        msg: `✅ ¡Pago aprobado en Mercado Pago${orderCode ? ` para el pedido ${orderCode}` : ''}! Activando tu Admin Estándar por 30 días naturales.`
      },
      pending: {
        ok: true,
        msg: `⏳ Pago en proceso en Mercado Pago${orderCode ? ` (${orderCode})` : ''}. En cuanto se acredite activaremos tu instancia.`
      },
      in_process: {
        ok: true,
        msg: `⏳ Pago en revisión en Mercado Pago${orderCode ? ` (${orderCode})` : ''}.`
      },
      failure: {
        ok: false,
        msg: `El pago en Mercado Pago no se completó${orderCode ? ` (${orderCode})` : ''}. Puedes volver a intentarlo desde el checkout.`
      }
    };

    const info = statusMap[mpStatus];
    if (!info) return;

    const offerIdx = Math.max(0, document.querySelectorAll('#public-carousel-track .carousel-slide').length - 1);
    carouselController?.goToSlide(offerIdx, { instant: true });
    goToWizardStep(3);

    let finalMsg = info.msg;
    if (mpStatus === 'approved' && orderCode) {
      const confirmRes = await apiFetch('/api/orders/confirm-payment', {
        method: 'POST',
        body: JSON.stringify({
          order_code: orderCode,
          mp_status: mpStatus,
          payment_id: params.get('payment_id') || params.get('collection_id') || ''
        })
      });
      if (confirmRes?.ok && (confirmRes.activated || confirmRes.locked || confirmRes.instance?.locked_for_public)) {
        const exp = confirmRes.subscription_expires_at || confirmRes.instance?.subscription_expires_at || '';
        const expLabel = exp ? ` hasta el ${new Date(exp).toLocaleDateString('es-MX')}` : '';
        finalMsg = `✅ ¡Pago confirmado (${orderCode})! Tu Admin Estándar quedó activo por 30 días naturales${expLabel} y tu instancia ya quedó bloqueada e inaccesible en la vista pública.`;
        renderLockedWizardState({
          instance_id: confirmRes.target_instance_id || confirmRes.instance?.instance_id || clientInstanceId,
          subscription_expires_at: exp,
          message: finalMsg
        });
      } else {
        toggleCheckoutPanel(true);
      }
    } else {
      toggleCheckoutPanel(true);
    }

    setFeedback('checkout-feedback', finalMsg, info.ok);

    const box = document.getElementById('chat-messages');
    if (box) {
      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble assistant is-official-bot';
      bubble.innerHTML = `${buildAssistantIdentityHeader('official', null)}${escapeHtml(finalMsg)}`;
      box.appendChild(bubble);
      box.scrollTop = box.scrollHeight;
    }
  } catch {
    // ignore URL parse issues
  }
}

// Inicialización
(async () => {
  await resolveInitialApiBase();
  setupEventListeners();
  await Promise.all([loadClientProvisionedInstance({ populateForm: true }), loadPublicCatalog()]);
  await handleMercadoPagoReturn();
  await refreshHealth();
  setInterval(refreshHealth, 12000);
  setInterval(() => {
    const chTab = document.getElementById('tab-channels');
    if (currentUser && activeView === 'admin' && chTab && !chTab.classList.contains('hidden')) {
      loadWhatsAppStatus();
    }
  }, 4000);
})();
