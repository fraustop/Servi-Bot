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
  if (!siteHeader || !headerInner || !siteMenu) return;

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

function syncHeaderAndNavigation() {
  const isPublic = activeView === 'public';
  const isAuthenticatedAdmin = Boolean(currentUser && activeView === 'admin');
  const brandSubtitle = document.getElementById('brand-subtitle');
  const userPill = document.getElementById('admin-user-pill');
  const navAdmin = document.getElementById('nav-admin');

  document.body.classList.toggle('is-public-view', isPublic);
  document.body.classList.toggle('is-admin-session', isAuthenticatedAdmin);

  document.querySelectorAll('.public-nav-item').forEach((el) => {
    el.classList.toggle('hidden', isAuthenticatedAdmin);
  });
  document.querySelectorAll('.admin-nav-item').forEach((el) => {
    el.classList.toggle('hidden', !isAuthenticatedAdmin);
  });

  if (isAuthenticatedAdmin) {
    if (brandSubtitle) brandSubtitle.textContent = 'Panel Administrativo';
    if (userPill) {
      userPill.textContent = currentUser.email || 'Administrador';
      userPill.classList.remove('hidden');
    }
    navAdmin?.removeAttribute('aria-current');
    document.querySelectorAll('.admin-tab-nav').forEach((btn) => {
      if (btn.dataset.tab === activeAdminTab) {
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.removeAttribute('aria-current');
      }
    });
  } else {
    if (brandSubtitle) brandSubtitle.textContent = 'Automatización Comercial IA';
    if (userPill) {
      userPill.textContent = '';
      userPill.classList.add('hidden');
    }
    if (activeView === 'admin') {
      navAdmin?.setAttribute('aria-current', 'page');
    } else {
      navAdmin?.removeAttribute('aria-current');
    }
  }

  updateNavbarLayout();
}

function showView(which) {
  activeView = which === 'admin' ? 'admin' : 'public';
  const viewPublic = document.getElementById('view-public');
  const viewAdmin = document.getElementById('view-admin');

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

  let pendingTarget = null;
  let scrollGeneration = 0;
  let lastSettledIndex = 0;
  let liveMarkerIndex = 0;
  let rafScheduled = false;
  let settleTimer = null;

  // Generar botones marcadores con su nombre de destino (01 · Descripción, 02 · La Oferta)
  markersNav.innerHTML = '';
  const markers = slides.map((slide, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = slide.dataset.markerName || `Diapositiva ${idx + 1}`;
    btn.setAttribute('aria-label', slide.dataset.markerName || `Ir a diapositiva ${idx + 1}`);
    if (idx === 0) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => goToSlide(idx, { announce: true }));
    markersNav.appendChild(btn);
    return btn;
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
    if (liveMarkerIndex === index && markers[index]?.getAttribute('aria-current') === 'true') {
      return;
    }
    liveMarkerIndex = index;
    markers.forEach((btn, idx) => {
      if (idx === index) {
        btn.setAttribute('aria-current', 'true');
      } else {
        btn.removeAttribute('aria-current');
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

  document.getElementById('nav-admin')?.addEventListener('click', () => showView('admin'));
  document.getElementById('btn-view-store')?.addEventListener('click', () => showView('public'));
  document.getElementById('btn-back-to-public')?.addEventListener('click', () => showView('public'));
  document.getElementById('link-home')?.addEventListener('click', (e) => {
    e.preventDefault();
    showView('public');
  });

  document.getElementById('btn-go-offer')?.addEventListener('click', () => {
    carouselController?.goToSlide(1, { announce: true });
  });
  document.getElementById('btn-go-description')?.addEventListener('click', () => {
    carouselController?.goToSlide(0, { announce: true });
  });

  if (location.pathname === '/admin' || location.hash === '#admin') {
    showView('admin');
  } else {
    syncHeaderAndNavigation();
  }

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

  document.getElementById('btn-hero-demo')?.addEventListener('click', () => {
    sendChatMessage('Hola, quiero contratar el servicio de Bots Autónomos para mi negocio, mi nombre es Alejandro Garza y mi WhatsApp es 8115559900, por favor registra mi pedido.');
  });

  document.getElementById('btn-reset-chat')?.addEventListener('click', () => {
    webSenderId = `web-${Math.floor(10000 + Math.random() * 90000)}`;
    localStorage.setItem('servibot_sender_id', webSenderId);
    const box = document.getElementById('chat-messages');
    if (box) {
      box.innerHTML = `<div class="chat-bubble assistant">Sesión reiniciada. ¡Hola! Soy el asesor de Servi-Bot, ¿en qué servicio te puedo apoyar hoy?</div>`;
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
    await loadPublicCatalog();
    if (currentUser) await loadAllAdminData();
  });
}

// Inicialización
(async () => {
  await resolveInitialApiBase();
  setupEventListeners();
  await loadPublicCatalog();
  await refreshHealth();
  setInterval(refreshHealth, 12000);
  setInterval(() => {
    const chTab = document.getElementById('tab-channels');
    if (currentUser && activeView === 'admin' && chTab && !chTab.classList.contains('hidden')) {
      loadWhatsAppStatus();
    }
  }, 4000);
})();
