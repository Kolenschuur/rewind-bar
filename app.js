// Rewind Bar POS v6.1 — standalone. Alle gegevens blijven op dit toestel (localStorage + IndexedDB).
const $ = id => document.getElementById(id);
const Cap = window.Capacitor;
const isNative = Boolean(Cap?.isNativePlatform?.());
const Share = isNative && Cap?.registerPlugin ? Cap.registerPlugin('Share') : null;
const Filesystem = isNative && Cap?.registerPlugin ? Cap.registerPlugin('Filesystem') : null;
const AppPlugin = isNative && Cap?.registerPlugin ? Cap.registerPlugin('App') : null;

const fmt = c => (c / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nlDate = iso => new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const nlTime = iso => new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
const notice = s => { $('notice').textContent = s; };

// ---------- Opslag ----------
const K = { settings: 'rewind-sa-settings', event: 'rewind-sa-event', archive: 'rewind-sa-archive', pending: 'rewind-sa-sumup-pending' };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const DEFAULT_PRODUCTS = [['Bier', 300, '🍺'], ['Frisdrank', 250, '🥤'], ['Wijn', 400, '🍷'], ['Water', 200, '💧'], ['Speciaalbier', 450, '🍻'], ['Snack', 350, '🥨']]
  .map(([name, price_cents, emoji], i) => ({ id: i + 1, name, price_cents, emoji, active: true }));

let settings = load(K.settings, null);
let evening = load(K.event, null);

const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open('rewind-pos-standalone', 1);
  req.onupgradeneeded = () => { const st = req.result.createObjectStore('sales', { keyPath: 'id' }); st.createIndex('event', 'event_id'); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction('sales', mode); let out;
    const r = fn(t.objectStore('sales')); r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
const salesOf = eventId => tx('readonly', s => s.index('event').getAll(eventId));
const putSale = sale => tx('readwrite', s => s.put(sale));
navigator.storage?.persist?.().catch(() => {});

// ---------- Codes ----------
async function hash(code) {
  const data = new TextEncoder().encode(settings.salt + ':' + code);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function roleFor(code) {
  const x = await hash(code);
  if (x === settings.adminHash) return 'admin';
  if (x === settings.barHash) return 'bar';
  return null;
}
const normalizePhone = v => { const d = String(v || '').replace(/[^\d+]/g, ''); return d.startsWith('+') ? d.slice(1).replace(/\D/g, '') : d.startsWith('00') ? d.slice(2) : d.startsWith('06') ? '31' + d.slice(1) : d.replace(/\D/g, ''); };
const validEmail = v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// ---------- Toestand ----------
let role = null, cart = {}, history = [], chosen = 1, checkout = false, busy = false, screenLocked = false, sales = [];
const closed = () => Boolean(evening?.closed_at);
const products = () => settings.products;

function ensureEvening() {
  if (!evening) { evening = { id: crypto.randomUUID(), started_at: new Date().toISOString(), closed_at: null, terminal_cents: null, report_text: null }; save(K.event, evening); }
}
async function refreshSales() { sales = await salesOf(evening.id); }

// ---------- Eigen dialoogvenster (Android blokkeert snel achter elkaar getoonde systeemdialogen) ----------
function ask(message, { okLabel = 'OK', cancelLabel = 'Annuleren', input = false, placeholder = '' } = {}) {
  return new Promise(resolve => {
    $('askText').textContent = message;
    $('askOk').textContent = okLabel; $('askCancel').textContent = cancelLabel;
    const field = $('askInput'); field.hidden = !input; field.value = ''; field.placeholder = placeholder;
    $('askLayer').hidden = false;
    (input ? field : $('askOk')).focus();
    const done = value => { $('askLayer').hidden = true; $('askOk').onclick = $('askCancel').onclick = field.onkeydown = null; resolve(value); };
    $('askOk').onclick = () => done(input ? field.value : true);
    $('askCancel').onclick = () => done(input ? null : false);
    field.onkeydown = e => { if (e.key === 'Enter') done(field.value); };
  });
}

// ---------- Codevelden: geen wachtwoordbeheer, wel een oogje om de invoer te controleren ----------
document.querySelectorAll('.code-input').forEach(input => {
  const wrap = document.createElement('span'); wrap.className = 'code-wrap';
  input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
  const eye = document.createElement('button');
  eye.type = 'button'; eye.className = 'code-eye'; eye.textContent = '👁'; eye.setAttribute('aria-label', 'Code tonen of verbergen');
  eye.onclick = () => { input.classList.toggle('reveal'); input.focus(); };
  wrap.appendChild(eye);
});
const clearCodes = () => document.querySelectorAll('.code-input').forEach(i => { i.value = ''; i.classList.remove('reveal'); });

// ---------- Opstarten ----------
function show(view) { for (const v of ['setup', 'login', 'app']) $(v).hidden = v !== view; clearCodes(); }
function boot() {
  if (!settings) { show('setup'); return; }
  ensureEvening();
  $('loginTitle').textContent = `Aanmelden · Bar ${settings.bar}`;
  show('login');
  $('code').focus();
}

$('setupForm').onsubmit = async e => {
  e.preventDefault();
  const barCode = $('setupBarCode').value.trim(), adminCode = $('setupAdminCode').value.trim(), email = $('setupEmail').value.trim();
  if (barCode.length < 4 || adminCode.length < 6) return $('setupError').textContent = 'Barcode minstens 4 en beheerderscode minstens 6 tekens.';
  if (barCode === adminCode) return $('setupError').textContent = 'Barcode en beheerderscode moeten verschillen.';
  if (!validEmail(email)) return $('setupError').textContent = 'Ongeldig e-mailadres.';
  settings = { bar: Number($('setupBar').value), salt: crypto.randomUUID(), whatsapp: normalizePhone($('setupWhatsapp').value), email, products: DEFAULT_PRODUCTS, nextProductId: DEFAULT_PRODUCTS.length + 1 };
  settings.barHash = await hash(barCode); settings.adminHash = await hash(adminCode);
  save(K.settings, settings);
  // ---------- Webversie: offline-cache en installatietip voor de iPhone ----------
if (!isNative && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
(() => {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let dismissed = false; try { dismissed = localStorage.getItem('rewind-sa-installhint') === '1'; } catch { }
  if (!isNative && ios && !standalone && !dismissed) $('installHint').hidden = false;
  $('installHintClose').onclick = () => { $('installHint').hidden = true; try { localStorage.setItem('rewind-sa-installhint', '1'); } catch { } };
})();

boot();
};

$('loginForm').onsubmit = async e => {
  e.preventDefault();
  const r = await roleFor($('code').value.trim());
  $('code').value = '';
  if (!r) { $('loginError').textContent = 'Code onjuist.'; return; }
  role = r; $('loginError').textContent = '';
  show('app');
  $('screenLock').hidden = false;
  $('indicator').textContent = (role === 'admin' ? '● Beheerder · ' : '● ') + `Bar ${settings.bar}`;
  $('barTitle').textContent = `Kassa • Bar ${settings.bar}`;
  $('reportTab').hidden = $('adminTab').hidden = role !== 'admin';
  selectView('kassa');
  await refreshSales();
  restoreSumup();
  renderEverything();
  if (window.__launchSumup) { const u = window.__launchSumup; window.__launchSumup = null; await handleSumupCallback(u); }
};
$('resetDevice').onclick = async () => {
  // Alleen toegestaan zolang er nog niets op dit toestel is verkocht: anders zou iedereen de beheerderscode kunnen omzeilen.
  const count = await tx('readonly', s => s.count());
  if (count > 0 || load(K.archive, []).length) {
    $('loginError').textContent = 'Er staan al verkopen op dit toestel, dus opnieuw instellen kan hier niet. Vraag de beheerder om de code.';
    return;
  }
  if (!(await ask('Codes en instellingen van dit toestel wissen en opnieuw instellen?\nEr staan nog geen verkopen op.', { okLabel: 'Opnieuw instellen' }))) return;
  localStorage.removeItem(K.settings); localStorage.removeItem(K.event);
  settings = null; evening = null; $('loginError').textContent = '';
  // ---------- Webversie: offline-cache en installatietip voor de iPhone ----------
if (!isNative && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
(() => {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let dismissed = false; try { dismissed = localStorage.getItem('rewind-sa-installhint') === '1'; } catch { }
  if (!isNative && ios && !standalone && !dismissed) $('installHint').hidden = false;
  $('installHintClose').onclick = () => { $('installHint').hidden = true; try { localStorage.setItem('rewind-sa-installhint', '1'); } catch { } };
})();

boot();
};
$('logout').onclick = async () => { if (lines().length && !(await ask('Er staat een open bestelling. Toch afmelden?', { okLabel: 'Afmelden' }))) return; location.reload(); };
$('screenLock').onclick = () => { screenLocked = true; $('unlockCode').value = ''; $('unlockError').textContent = ''; $('lockLayer').hidden = false; $('unlockCode').focus(); };
$('unlockForm').onsubmit = async e => {
  e.preventDefault();
  const r = await roleFor($('unlockCode').value.trim());
  if (!r || (role === 'admin' && r !== 'admin')) { $('unlockError').textContent = role === 'admin' ? 'Gebruik de beheerderscode.' : 'Code onjuist.'; return; }
  screenLocked = false; $('lockLayer').hidden = true;
};

// ---------- Kassa ----------
const lines = () => products().filter(p => cart[p.id] > 0).map(p => ({ ...p, qty: cart[p.id] }));
const sum = () => lines().reduce((v, p) => v + p.qty * p.price_cents, 0);
const blocked = () => checkout || closed();
function modify(id, qty) {
  if (blocked() || screenLocked) return;
  history.push({ ...cart });
  cart[id] = Math.max(0, Math.min(100, (cart[id] || 0) + qty));
  if (!cart[id]) delete cart[id];
  renderReceipt();
}
function renderCatalog() {
  $('catalog').innerHTML = products().filter(p => p.active).map(p => `<button class="product" data-id="${p.id}" ${blocked() ? 'disabled' : ''}><span class="emoji">${h(p.emoji)}</span><strong>${h(p.name)}</strong><em>${fmt(p.price_cents)}</em></button>`).join('');
  $('catalog').querySelectorAll('button').forEach(b => b.onclick = () => { modify(Number(b.dataset.id), chosen); chosen = 1; renderQty(); });
}
function renderQty() {
  $('nextQtyLabel').textContent = chosen + '×';
  $('qtyGrid').innerHTML = [1, 2, 3, 4, 5, 10].map(n => `<button data-n="${n}" class="${chosen === n ? 'selected' : ''}" ${blocked() ? 'disabled' : ''}>${n}×</button>`).join('');
  $('qtyGrid').querySelectorAll('button').forEach(b => b.onclick = () => { chosen = Number(b.dataset.n); renderQty(); });
}
function renderReceipt() {
  $('basket').innerHTML = lines().map(p => `<div class="line"><div><b>${h(p.name)}</b><br><small>${fmt(p.price_cents)} / stuk</small></div><div class="controls"><button data-id="${p.id}" data-n="-1" ${blocked() ? 'disabled' : ''}>−</button><b>${p.qty}</b><button data-id="${p.id}" data-n="1" ${blocked() ? 'disabled' : ''}>+</button></div><b>${fmt(p.qty * p.price_cents)}</b></div>`).join('') || '<p class="muted">Selecteer het aantal en tik een product.</p>';
  $('basket').querySelectorAll('button').forEach(b => b.onclick = () => modify(Number(b.dataset.id), Number(b.dataset.n)));
  $('lineCount').textContent = lines().reduce((v, p) => v + p.qty, 0) + ' stuks';
  $('total').textContent = fmt(sum());
  $('undo').disabled = blocked() || !history.length;
  $('clear').disabled = $('checkout').disabled = $('manualPay').disabled = blocked() || !lines().length;
  $('checkout').textContent = sumupOn() ? 'AFREKENEN MET SUMUP' : 'PIN · AFREKENEN';
  $('manualPay').hidden = !sumupOn();
  $('checkoutActions').hidden = checkout;
  $('confirm').hidden = !checkout || Boolean(sumupPending);
  $('sumupWait').hidden = !sumupPending;
}
function renderSummary() {
  const s = totals();
  $('eveningSummary').textContent = `Avond gestart ${nlDate(evening.started_at)} · ${s.orders} bestellingen · ${fmt(s.revenue)}`;
  $('closedBanner').hidden = !closed();
}
function renderEverything() { renderQty(); renderCatalog(); renderReceipt(); renderSummary(); }

$('undo').onclick = () => { if (checkout || !history.length) return; cart = history.pop(); renderReceipt(); };
$('clear').onclick = async () => { if (checkout || !lines().length) return; if (await ask('Hele bestelling wissen?', { okLabel: 'Wissen' })) { history.push({ ...cart }); cart = {}; renderReceipt(); } };
// ---------- Afrekenen ----------
// Betaalwijze: 'manual' = los pinapparaat, zelf bevestigen; 'sumup' = SumUp-app via Payment Switch.
const sumupOn = () => settings.payment === 'sumup' && Boolean(settings.sumupKey);
const defaultAppId = () => isNative ? 'nl.rewindtheparty.bar' : location.hostname;
let sumupPending = null;

$('checkout').onclick = () => {
  if (!lines().length || closed() || checkout) return;
  if (sumupOn()) return startSumup();
  checkout = true; renderEverything();
};
$('manualPay').onclick = () => { if (!lines().length || closed() || checkout) return; checkout = true; renderEverything(); };
$('back').onclick = () => { checkout = false; renderEverything(); };
$('paid').onclick = () => recordSale({ method: 'manual' });

async function recordSale(payment) {
  if (busy || !checkout || closed() || !lines().length) return false;
  busy = true; $('paid').disabled = true;
  const sale = {
    id: crypto.randomUUID(), event_id: evening.id, bar: settings.bar, created_at: new Date().toISOString(),
    total_cents: sum(), items: lines().map(p => ({ product_id: p.id, name: p.name, unit_price_cents: p.price_cents, qty: p.qty })),
    payment, void_reason: null, voided_at: null,
  };
  // Bon direct leegmaken, zodat een snelle volgende tik niet op de oude bon terechtkomt.
  const prevCart = cart, prevHistory = history;
  cart = {}; history = []; checkout = false; chosen = 1; renderEverything();
  try {
    await putSale(sale); sales.push(sale);
    renderSummary();
    notice(`Verkoop ${fmt(sale.total_cents)} opgeslagen${payment.method === 'sumup' ? ' (SumUp' + (payment.tx_code ? ' ' + payment.tx_code : '') + ')' : ''}.`);
    return true;
  } catch (e) {
    if (!lines().length) { cart = prevCart; history = prevHistory; checkout = true; renderEverything(); }
    notice('LET OP: verkoop NIET opgeslagen! Schrijf deze betaling handmatig op. ' + e.message);
    return false;
  } finally { busy = false; $('paid').disabled = false; }
}

function startSumup() {
  if (navigator.onLine === false) { notice('Geen internet: betalen via SumUp lukt nu niet. Gebruik "Los pinapparaat" of wacht op verbinding.'); return; }
  const id = crypto.randomUUID();
  sumupPending = { id, total_cents: sum(), cart: { ...cart }, event_id: evening.id, started_at: new Date().toISOString() };
  save(K.pending, sumupPending);
  checkout = true; renderEverything();
  $('sumupHint').textContent = '';
  const cb = isNative ? 'rewindpos://sumup' : location.origin + location.pathname + '?sumup=1';
  const amount = (sumupPending.total_cents / 100).toFixed(2);
  const q = new URLSearchParams({
    'affiliate-key': settings.sumupKey, 'app-id': settings.sumupAppId || defaultAppId(),
    total: amount, amount, currency: 'EUR', title: `Rewind Bar ${settings.bar}`,
    'foreign-tx-id': id, 'skip-screen-success': 'true', callback: cb, callbacksuccess: cb, callbackfail: cb,
  });
  const url = 'sumupmerchant://pay/1.0?' + q.toString();
  if (typeof window.__openSumup === 'function') window.__openSumup(url); else window.location.href = url; // haakje voor tests
  setTimeout(() => {
    if (sumupPending?.id === id && document.visibilityState === 'visible')
      $('sumupHint').textContent = 'Opent SumUp niet? Controleer of de SumUp Business-app geïnstalleerd en ingelogd is, of kies Mislukt en reken af met het losse pinapparaat.';
  }, 3500);
}

async function finishSumup(txCode, confirmedBy) {
  const p = sumupPending; if (!p) return;
  if (p.event_id !== evening.id) { clearSumup(); notice('Deze SumUp-betaling hoort bij een eerdere avond en is niet geboekt. Controleer de SumUp-app.'); return; }
  if (!lines().length) cart = { ...p.cart };
  checkout = true;
  const ok = await recordSale({ method: 'sumup', tx_code: txCode || null, foreign_tx_id: p.id, confirmed: confirmedBy });
  if (ok) clearSumup();
}
function clearSumup() { sumupPending = null; try { localStorage.removeItem(K.pending); } catch { } renderReceipt(); }
function failSumup(message) {
  clearSumup(); checkout = false; renderEverything();
  notice('SumUp-betaling niet gelukt' + (message ? ': ' + message : '') + '. De bon staat er nog; probeer opnieuw of gebruik het losse pinapparaat.');
}
async function handleSumupCallback(url) {
  let q; try { q = new URL(url).searchParams; } catch { return; }
  if (!q.has('smp-status') && !q.has('foreign-tx-id')) return;
  if (!sumupPending) sumupPending = load(K.pending, null);
  if (!sumupPending || q.get('foreign-tx-id') !== sumupPending.id) { notice('Een SumUp-terugmelding hoorde niet bij de open betaling en is genegeerd. Controleer zo nodig de SumUp-app.'); return; }
  if (!settings || !evening) return;
  if (!sales.length) await refreshSales();
  if (q.get('smp-status') === 'success') await finishSumup(q.get('smp-tx-code'), 'sumup');
  else failSumup(q.get('smp-message') || q.get('smp-status') || 'afgebroken');
}
$('sumupOk').onclick = async () => {
  if (!sumupPending) return;
  if (!(await ask(`Toonde de SumUp-app “Geslaagd” voor ${fmt(sumupPending.total_cents)}?\n\nBevestig alleen als je dat zeker hebt gezien. Twijfel je, kijk dan in de SumUp-app onder Transacties.`, { okLabel: 'Ja, geslaagd', cancelLabel: 'Terug' }))) return;
  await finishSumup(null, 'handmatig');
};
$('sumupFail').onclick = () => { if (sumupPending) failSumup(''); };
function restoreSumup() {
  const p = load(K.pending, null);
  if (!p || !evening || p.event_id !== evening.id) { if (p) clearSumup(); return; }
  sumupPending = p; cart = { ...p.cart }; checkout = true;
  $('sumupHint').textContent = 'Er stond nog een SumUp-betaling open. Kijk in de SumUp-app of die gelukt is en kies hieronder.';
}
// Terugmelding van SumUp: Android via de app-link, webversie via de pagina-URL.
if (AppPlugin) {
  AppPlugin.addListener('appUrlOpen', e => { if (e?.url?.startsWith('rewindpos://sumup')) handleSumupCallback(e.url); });
  AppPlugin.getLaunchUrl?.().then(r => { if (r?.url?.startsWith('rewindpos://sumup')) window.__launchSumup = r.url; }).catch(() => { });
}
if (!isNative && /[?&](sumup=1|smp-status=)/.test(location.search)) { window.__launchSumup = location.href; window.history.replaceState(null, '', location.pathname); }

// ---------- Rapport ----------
function totals() {
  const valid = sales.filter(s => !s.void_reason), voids = sales.filter(s => s.void_reason);
  const items = new Map();
  for (const s of valid) for (const i of s.items) {
    const key = i.product_id + '-' + i.unit_price_cents;
    const row = items.get(key) || { product_id: i.product_id, name: i.name, unit_price_cents: i.unit_price_cents, qty: 0, revenue: 0 };
    row.qty += i.qty; row.revenue += i.qty * i.unit_price_cents; items.set(key, row);
  }
  const viaSumup = valid.filter(s => s.payment?.method === 'sumup');
  return {
    sumupCount: viaSumup.length, sumupRevenue: viaSumup.reduce((n, s) => n + s.total_cents, 0),
    orders: valid.length, revenue: valid.reduce((n, s) => n + s.total_cents, 0),
    voids: voids.length, voidAmount: voids.reduce((n, s) => n + s.total_cents, 0),
    items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name, 'nl') || a.unit_price_cents - b.unit_price_cents),
  };
}
function reportText() {
  const t = totals(), pin = evening.terminal_cents;
  const productLines = t.items.length ? t.items.map(i => `- ${i.name} (${fmt(i.unit_price_cents)}): ${i.qty}× = ${fmt(i.revenue)}`).join('\n') : '- Geen verkopen';
  const pinLine = pin == null ? 'Pin-eindstand: niet ingevoerd' : `Pin-eindstand: ${fmt(pin)} · verschil kassa−pin: ${fmt(t.revenue - pin)}`;
  return [
    `REWIND BAR – EINDRAPPORT BAR ${settings.bar}`,
    `Avond: ${nlDate(evening.started_at)} t/m ${nlTime(evening.closed_at || new Date().toISOString())}`,
    '',
    `Omzet: ${fmt(t.revenue)}`,
    `Bestellingen: ${t.orders}`,
    `Correcties: ${t.voids}${t.voids ? ` (${fmt(t.voidAmount)} geannuleerd)` : ''}`,
    ...(t.sumupCount ? [`Via SumUp: ${fmt(t.sumupRevenue)} (${t.sumupCount}×) · los pinapparaat: ${fmt(t.revenue - t.sumupRevenue)} (${t.orders - t.sumupCount}×)`] : []),
    pinLine,
    '',
    'Producten:',
    productLines,
  ].join('\n');
}
function renderReport() {
  const t = totals();
  $('reportTitle').textContent = closed() ? `Avond afgesloten · ${nlDate(evening.closed_at)}` : `Deze avond · Bar ${settings.bar}`;
  const pin = evening.terminal_cents;
  $('stats').innerHTML = `<div class="stat"><small>Omzet na correcties</small><strong>${fmt(t.revenue)}</strong></div><div class="stat"><small>Bestellingen</small><strong>${t.orders}</strong></div><div class="stat"><small>Correcties</small><strong>${t.voids}</strong></div>${t.sumupCount ? `<div class="stat"><small>Via SumUp</small><strong>${fmt(t.sumupRevenue)}</strong></div>` : ''}<div class="stat"><small>Pin-eindstand</small><strong>${pin == null ? '—' : fmt(pin)}</strong></div><div class="stat"><small>Verschil kassa−pin</small><strong>${pin == null ? '—' : fmt(t.revenue - pin)}</strong></div>`;
  let html = '<div class="panel"><h3>Productomzet (zonder geannuleerde verkopen)</h3><div class="table-scroll"><table><tr><th>Product</th><th>Prijs</th><th>Aantal</th><th>Omzet</th></tr>';
  for (const i of t.items) html += `<tr><td>${h(i.name)}</td><td>${fmt(i.unit_price_cents)}</td><td>${i.qty}</td><td>${fmt(i.revenue)}</td></tr>`;
  html += '</table></div></div><div class="panel"><h3>Transacties</h3><div class="table-scroll"><table><tr><th>Tijd</th><th>Bedrag</th><th>Producten</th><th>Status</th></tr>';
  for (const s of [...sales].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100)) {
    html += `<tr><td>${nlTime(s.created_at)}</td><td>${fmt(s.total_cents)}</td><td><small>${h(s.items.map(i => i.qty + '× ' + i.name).join(', '))}${s.payment?.method === 'sumup' ? '<br>SumUp ' + h(s.payment.tx_code || (s.payment.confirmed === 'handmatig' ? 'handmatig bevestigd' : '')) : ''}</small></td><td>${s.void_reason ? 'Geannuleerd: ' + h(s.void_reason) : closed() ? 'Geboekt' : `<button class="small danger-outline" data-void="${s.id}">Annuleren</button>`}</td></tr>`;
  }
  html += '</table></div></div>';
  $('reportBody').innerHTML = html;
  $('reportBody').querySelectorAll('[data-void]').forEach(b => b.onclick = () => voidSale(b.dataset.void));
  $('terminalTotal').value = pin == null ? '' : (pin / 100).toFixed(2).replace('.', ',');
  $('terminalTotal').disabled = $('saveTotal').disabled = closed();
  $('closePanel').hidden = closed();
  $('sendPanel').hidden = !closed();
  if (closed()) {
    $('reportText').textContent = evening.report_text;
    const hints = [];
    hints.push(settings.whatsapp ? `WhatsApp gaat naar +${settings.whatsapp}.` : 'Geen WhatsApp-nummer ingesteld: je kiest de ontvanger in WhatsApp.');
    hints.push(settings.email ? `Mail gaat naar ${settings.email}.` : 'Geen e-mailadres ingesteld.');
    $('sendHint').textContent = hints.join(' ');
  }
}
async function voidSale(id) {
  const s = sales.find(x => x.id === id); if (!s || s.void_reason || closed()) return;
  const viaSumup = s.payment?.method === 'sumup';
  const refundNote = viaSumup ? `Betaald via SumUp${s.payment.tx_code ? ' (transactie ' + s.payment.tx_code + ')' : ''}. Het geld terugbetalen doe je in de SumUp-app onder Transacties.` : 'Dit annuleert geen echte pinbetaling.';
  const reason = ((await ask(`Verkoop van ${fmt(s.total_cents)} om ${nlTime(s.created_at)} annuleren.\n${refundNote}\nReden (minstens 5 tekens):`, { okLabel: 'Annuleren bevestigen', cancelLabel: 'Terug', input: true, placeholder: 'Reden, bijv. verkeerd aangeslagen' })) || '').trim();
  if (reason.length < 5) { notice(reason ? 'Reden te kort (minstens 5 tekens); niets geannuleerd.' : 'Annuleren afgebroken.'); return; }
  s.void_reason = reason; s.voided_at = new Date().toISOString();
  await putSale(s); renderReport(); renderSummary();
  notice(viaSumup ? 'Correctie verwerkt. Vergeet niet de betaling terug te storten in de SumUp-app.' : 'Correctie verwerkt. Regel zo nodig apart een terugbetaling via het pinapparaat.');
}
function parseCents(v) { const s = String(v).trim().replace(',', '.'); if (!/^\d+(\.\d{1,2})?$/.test(s)) return null; const n = Math.round(Number(s) * 100); return Number.isSafeInteger(n) && n <= 100000000 ? n : null; }
$('saveTotal').onclick = () => {
  const raw = $('terminalTotal').value.trim();
  const n = raw ? parseCents(raw) : null;
  if (raw && n === null) return notice('Ongeldige pin-eindstand.');
  evening.terminal_cents = n; save(K.event, evening); renderReport(); notice('Pin-eindstand opgeslagen.');
};
$('refreshReport').onclick = async () => { await refreshSales(); renderReport(); };

$('closeEvening').onclick = async () => {
  if (lines().length || checkout) return notice('Rond eerst de open bestelling af of wis de bon.');
  if (evening.terminal_cents == null && !(await ask('Er is nog geen pin-eindstand ingevoerd. Toch afsluiten?', { okLabel: 'Toch afsluiten' }))) return;
  if (!(await ask(`Avond afsluiten voor Bar ${settings.bar}?\n\nNa afsluiten kun je op dit toestel niets meer verkopen tot je een nieuwe avond start. Dit kan niet ongedaan worden gemaakt.`, { okLabel: 'Avond afsluiten' }))) return;
  await refreshSales();
  evening.closed_at = new Date().toISOString();
  evening.report_text = reportText();
  save(K.event, evening);
  renderEverything(); renderReport();
  $('sendPanel').scrollIntoView({ behavior: 'smooth' });
  notice('Avond afgesloten. Verstuur het rapport met WhatsApp of e-mail.');
};
$('newEvening').onclick = async () => {
  if (!closed()) return;
  if (!(await ask('Nieuwe avond starten?\n\nHeb je het eindrapport verstuurd? Het blijft bewaard onder Beheer → Eerdere avonden, maar het dashboard begint weer bij nul.', { okLabel: 'Nieuwe avond' }))) return;
  const archive = load(K.archive, []);
  archive.unshift({ id: evening.id, bar: settings.bar, started_at: evening.started_at, closed_at: evening.closed_at, report_text: evening.report_text });
  save(K.archive, archive.slice(0, 100));
  evening = null; ensureEvening(); sales = [];
  renderEverything(); renderReport(); notice('Nieuwe avond gestart.');
};

// ---------- Versturen & delen ----------
function openExternal(url) {
  // Android-app: Capacitor opent externe links (wa.me, mailto:) in WhatsApp of de mail-app.
  // Webversie (iPhone): mailto via de huidige pagina, wa.me in een nieuw venster zodat de kassa open blijft.
  if (isNative || url.startsWith('mailto:')) { window.location.href = url; return; }
  const w = window.open(url, '_blank');
  if (!w) window.location.href = url;
}
const mailSubject = () => `Rewind Bar ${settings.bar} – eindrapport ${new Date(evening.closed_at || Date.now()).toLocaleDateString('nl-NL')}`;
function sendWhatsapp(text) { openExternal(`https://wa.me/${settings.whatsapp || ''}?text=${encodeURIComponent(text)}`); }
async function sendMail(text, subject) {
  if (!settings.email && !(await ask('Geen e-mailadres ingesteld. Mail-app openen zonder ontvanger?', { okLabel: 'Mail openen' }))) return;
  openExternal(`mailto:${encodeURIComponent(settings.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.replace(/\n/g, '\r\n'))}`);
}
async function writeCsv(name, rows) {
  const cell = s => '"' + String(s ?? '').replaceAll('"', '""') + '"';
  const csv = '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
  if (Filesystem) {
    const res = await Filesystem.writeFile({ path: name, data: csv, directory: 'CACHE', encoding: 'utf8' });
    return res.uri;
  }
  // Webversie: via het deelmenu van de telefoon (iPhone), anders als download.
  const file = new File([csv], name, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) return file;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  return null;
}
const stamp = () => new Date(evening.started_at).toISOString().slice(0, 10);
const productRows = () => [['Bar', 'Product-ID', 'Naam', 'Prijs (€)', 'Aantal', 'Omzet (€)'], ...totals().items.map(i => [settings.bar, i.product_id, i.name, (i.unit_price_cents / 100).toFixed(2).replace('.', ','), i.qty, (i.revenue / 100).toFixed(2).replace('.', ',')])];
const transactionRows = () => [['ID', 'Datum/tijd', 'Bar', 'Bedrag (€)', 'Producten', 'Betaalwijze', 'SumUp-transactie', 'Correctiereden'], ...sales.map(s => [s.id, nlDate(s.created_at), s.bar, (s.total_cents / 100).toFixed(2).replace('.', ','), s.items.map(i => i.qty + 'x ' + i.name).join(', '), s.payment?.method === 'sumup' ? 'SumUp' + (s.payment.confirmed === 'handmatig' ? ' (handmatig bevestigd)' : '') : 'Los pinapparaat', s.payment?.tx_code || '', s.void_reason || ''])];
async function exportCsv(name, rows) {
  try {
    const out = await writeCsv(name, rows);
    if (out && Share) await Share.share({ title: name, files: [out], dialogTitle: 'CSV delen' });
    else if (out instanceof File) await navigator.share({ title: name, files: [out] });
  } catch (e) { if (!/cancel/i.test(e?.message || '')) notice('Exporteren mislukt: ' + (e?.message || e)); }
}
$('exportSummary').onclick = () => exportCsv(`rewind-bar${settings.bar}-producten-${stamp()}.csv`, productRows());
$('exportTransactions').onclick = () => exportCsv(`rewind-bar${settings.bar}-transacties-${stamp()}.csv`, transactionRows());
$('sendWhatsapp').onclick = () => sendWhatsapp(evening.report_text);
$('sendMail').onclick = () => sendMail(evening.report_text, mailSubject());
$('sendShare').onclick = async () => {
  try {
    if (Share) {
      const uri = await writeCsv(`rewind-bar${settings.bar}-transacties-${stamp()}.csv`, transactionRows());
      await Share.share({ title: mailSubject(), text: evening.report_text, files: uri ? [uri] : undefined, dialogTitle: 'Eindrapport delen' });
    } else if (navigator.share) {
      const file = await writeCsv(`rewind-bar${settings.bar}-transacties-${stamp()}.csv`, transactionRows());
      await navigator.share({ title: mailSubject(), text: evening.report_text, ...(file instanceof File ? { files: [file] } : {}) });
    }
    else { await navigator.clipboard.writeText(evening.report_text); notice('Rapport gekopieerd naar het klembord.'); }
  } catch (e) { if (!/cancel|abort/i.test(e?.message || e?.name || '')) notice('Delen mislukt: ' + (e?.message || e)); }
};

// ---------- Beheer ----------
function renderProducts() {
  $('productList').innerHTML = products().map(p => `<tr><td>${h(p.emoji)} ${h(p.name)}</td><td>${fmt(p.price_cents)}</td><td>${p.active ? 'Actief' : 'Uit'}</td><td><button data-id="${p.id}" class="small outline">Bewerk</button></td></tr>`).join('');
  $('productList').querySelectorAll('button').forEach(b => b.onclick = () => {
    const p = products().find(x => x.id === Number(b.dataset.id)); if (!p) return;
    $('productId').value = p.id; $('productName').value = p.name; $('productPrice').value = (p.price_cents / 100).toFixed(2).replace('.', ',');
    $('productEmoji').value = p.emoji; $('productActive').checked = p.active; $('editorTitle').textContent = 'Product aanpassen';
    $('productForm').scrollIntoView({ behavior: 'smooth' });
  });
}
function resetEditor() { $('productForm').reset(); $('productId').value = ''; $('editorTitle').textContent = 'Nieuw product'; }
$('cancelEdit').onclick = resetEditor;
$('productForm').onsubmit = e => {
  e.preventDefault();
  if (lines().length || checkout) return notice('Rond eerst de open bestelling af voordat je producten wijzigt.');
  const n = parseCents($('productPrice').value); if (n === null || n > 1000000) return notice('Ongeldige prijs.');
  const name = $('productName').value.trim(); if (!name) return notice('Productnaam ontbreekt.');
  const data = { name, price_cents: n, emoji: $('productEmoji').value.trim() || '🥤', active: $('productActive').checked };
  const id = Number($('productId').value);
  if (id) Object.assign(products().find(p => p.id === id), data);
  else products().push({ id: settings.nextProductId++, ...data });
  save(K.settings, settings); resetEditor(); renderProducts(); renderCatalog(); notice('Product opgeslagen.');
};
function renderSettings() {
  $('setBar').value = settings.bar; $('setWhatsapp').value = settings.whatsapp ? '+' + settings.whatsapp : ''; $('setEmail').value = settings.email || '';
  $('setBarCode').value = $('setAdminCode').value = '';
  $('setPayment').value = settings.payment || 'manual';
  $('setSumupKey').value = settings.sumupKey || '';
  $('setSumupAppId').value = settings.sumupAppId || defaultAppId();
  $('sumupAppIdHint').textContent = `Maak in je SumUp-account (me.sumup.com → Developers → Affiliate keys) een sleutel aan voor App-ID “${defaultAppId()}” en vul hem hierboven in.`;
  $('sumupFields').hidden = $('setPayment').value !== 'sumup';
}
$('setPayment').onchange = () => { $('sumupFields').hidden = $('setPayment').value !== 'sumup'; };
$('settingsForm').onsubmit = async e => {
  e.preventDefault();
  const email = $('setEmail').value.trim(), barCode = $('setBarCode').value.trim(), adminCode = $('setAdminCode').value.trim();
  if (!validEmail(email)) return notice('Ongeldig e-mailadres.');
  if (barCode && barCode.length < 4) return notice('Barcode minstens 4 tekens.');
  if (adminCode && adminCode.length < 6) return notice('Beheerderscode minstens 6 tekens.');
  const newBar = barCode ? await hash(barCode) : settings.barHash, newAdmin = adminCode ? await hash(adminCode) : settings.adminHash;
  if (newBar === newAdmin) return notice('Barcode en beheerderscode moeten verschillen.');
  const bar = Number($('setBar').value);
  if (bar !== settings.bar && sales.length && !closed()) return notice('Wijzig de bar pas na het afsluiten van de avond.');
  const payment = $('setPayment').value, sumupKey = $('setSumupKey').value.trim(), sumupAppId = $('setSumupAppId').value.trim() || defaultAppId();
  if (payment === 'sumup' && !sumupKey) return notice('Vul de SumUp affiliate key in, of kies "Los pinapparaat".');
  if (sumupPending) return notice('Rond eerst de openstaande SumUp-betaling af.');
  Object.assign(settings, { bar, whatsapp: normalizePhone($('setWhatsapp').value), email, barHash: newBar, adminHash: newAdmin, payment, sumupKey, sumupAppId });
  save(K.settings, settings); renderSettings();
  $('indicator').textContent = `● Beheerder · Bar ${settings.bar}`; $('barTitle').textContent = `Kassa • Bar ${settings.bar}`;
  renderReceipt();
  notice('Instellingen opgeslagen.');
};
function renderArchive() {
  const archive = load(K.archive, []);
  $('archiveList').innerHTML = archive.length ? archive.map((a, i) => `<details class="archive"><summary>Bar ${a.bar} · ${nlDate(a.started_at)} – ${nlDate(a.closed_at)}</summary><pre class="report-text">${h(a.report_text)}</pre><div class="button-row"><button class="small success" data-wa="${i}">WhatsApp</button><button class="small primary" data-mail="${i}">E-mail</button></div></details>`).join('') : '<p class="muted">Nog geen afgesloten avonden.</p>';
  $('archiveList').querySelectorAll('[data-wa]').forEach(b => b.onclick = () => sendWhatsapp(archive[b.dataset.wa].report_text));
  $('archiveList').querySelectorAll('[data-mail]').forEach(b => b.onclick = () => { const a = archive[b.dataset.mail]; sendMail(a.report_text, `Rewind Bar ${a.bar} – eindrapport ${new Date(a.closed_at).toLocaleDateString('nl-NL')}`); });
}

// ---------- Navigatie ----------
function selectView(v) {
  if (v !== 'kassa' && role !== 'admin') return;
  for (const item of ['kassa', 'report', 'admin']) $(item).hidden = v !== item;
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('selected', x.dataset.view === v));
  if (v === 'report') refreshSales().then(renderReport);
  if (v === 'admin') { renderProducts(); renderSettings(); renderArchive(); }
}
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => selectView(b.dataset.view));

// ---------- Webversie: offline-cache en installatietip voor de iPhone ----------
if (!isNative && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
(() => {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  let dismissed = false; try { dismissed = localStorage.getItem('rewind-sa-installhint') === '1'; } catch { }
  if (!isNative && ios && !standalone && !dismissed) $('installHint').hidden = false;
  $('installHintClose').onclick = () => { $('installHint').hidden = true; try { localStorage.setItem('rewind-sa-installhint', '1'); } catch { } };
})();

boot();
