// PriceCompare front end: plain JS, no framework. Listens to /api/search (Server-Sent Events).
// Page order: the products and the comparison first, then the shops to open by hand, then the
// per-shop statuses (collapsed to one line).
//
// Texts come from public/i18n.js (window.I18N). The language goes to the server with the search
// (lang=sk|en), so shop details and delivery and pickup notes arrive in it. Switching the language
// re-renders everything from the data the page holds; only those server sentences stay in the
// language they were fetched in until the next search.

const $ = (sel) => document.querySelector(sel);
const { t, lookup } = window.I18N;
const UNCHECKED = ['blocked', 'needs_js', 'needs_search_key', 'robots_disallowed', 'no_route', 'error'];
const STATUS_ORDER = ['ok', 'no_match', 'blocked', 'needs_js', 'needs_search_key', 'robots_disallowed', 'no_route', 'error', 'not_relevant'];

let source = null;
let state = null;
let categories = [];
let usage = null;
const PROVIDER_NAMES = { brave: 'Brave', serper: 'Serper', tavily: 'Tavily' };

// Mirrors usageLevel() in src/core/usage.ts: yellow from 80 %, red at 100 % or when marked used up.
function usageLevel(u) {
  if (u.exhausted || (u.limit > 0 && u.used >= u.limit)) return 'full';
  if (u.limit > 0 && u.used >= 0.8 * u.limit) return 'warn';
  return 'ok';
}

// Web search credit per provider with a key, in the footer. Loaded on page load and after each search.
async function loadUsage() {
  try {
    usage = await (await fetch('/api/usage')).json();
  } catch { usage = null; }
  renderUsage();
}

function renderUsage() {
  const box = $('#usage');
  if (!Array.isArray(usage)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const { int } = window.I18N;
  // Without any key: one quiet line, no heading and no bars.
  $('#usage-title').hidden = !usage.length;
  $('#usage-list').hidden = !usage.length;
  if (!usage.length) {
    $('#usage-list').replaceChildren();
    $('#usage-note').textContent = t('usageNoKey');
    return;
  }
  $('#usage-list').replaceChildren(...usage.map((u) => {
    const level = usageLevel(u);
    const p = { used: int(u.used), limit: int(u.limit), limitN: u.limit, period: u.period, exhausted: u.exhausted };
    const pct = u.limit > 0 ? Math.min(100, (100 * u.used) / u.limit) : 100;
    const name = PROVIDER_NAMES[u.provider] || u.provider;
    return el('li', { class: `usage-${level}` },
      el('span', { class: 'uname' }, name),
      el('span', { class: 'ucount' }, t('usageCount', p),
        u.exhausted ? ` · ${t('usageExhausted')}` : '',
        u.source === 'provider' ? el('span', { class: 'usrc' }, ` (${t('usageFromProvider')})`) : null),
      el('span', {
        class: 'ubar', role: 'progressbar', 'aria-label': name, 'aria-valuemin': '0', 'aria-valuemax': String(u.limit),
        'aria-valuenow': String(Math.min(u.used, u.limit)), 'aria-valuetext': t('usageValueText', p),
      }, el('span', { style: `width: ${pct.toFixed(1)}%` })));
  }));
  $('#usage-note').textContent = usage.some((u) => u.source === 'provider') ? t('usageNoteProvider') : t('usageNote');
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const eur = (n) => window.I18N.eur(n);
const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
// The search location, for "Shops with a branch in Košice" / "Obchody s pobočkou v Košiciach".
const where = () => ({ locName: state?.locName || 'Košice', inCity: window.I18N.inCity(state?.loc || 'kosice', state?.locName || 'Košice') });

// Mirrors headlineText() in src/core/totals.ts
function headlineText(h) {
  if (h.bestItemEur === null) return t('noPriceReachesSk');
  const parts = [t('from', { price: eur(h.bestItemEur), known: h.bestItemTotalKnown })];
  if (h.bestTotalEur !== null && !(h.bestItemTotalKnown && h.bestTotalEur === h.bestItemEur)) {
    parts.push(t('cheapestKnownTotal', { price: eur(h.bestTotalEur), shop: h.bestTotalShop, pickup: h.bestTotalKind === 'pickup' }));
  } else if (h.bestTotalEur === null) parts.push(t('noKnownTotal'));
  return parts.join(' · ');
}

// Mirrors groupNotes() in src/core/group.ts; a product without noteFacts keeps the server's notes.
function groupNotes(g) {
  const f = g.noteFacts;
  if (!f) return g.notes;
  const notes = [];
  if (f.noDelivery) notes.push(t('noteNoDelivery', { n: f.noDelivery }));
  if (f.gtins) notes.push(t('noteGtins', { n: f.gtins }));
  if (f.mixed) notes.push(t('noteMixed'));
  if (f.noGtin) notes.push(f.gtins ? t('noteSomeByName') : t('noteAllByName'));
  return notes;
}

// The variant's colour and telling words; the GTIN is shown on its own line.
function variantLabel(v) {
  if (!Array.isArray(v.words)) return v.label.replace(/,? ?GTIN \d+$/, '');
  const colour = v.colour ? lookup('colour', v.colour) || v.colour : t('colourNotStated');
  return [colour, v.words.length ? v.words.join(' ') : null].filter(Boolean).join(', ');
}

// The matcher's reasons in the page's language, from their codes; the English strings when a code is unknown.
function matchReasons(m) {
  if (!Array.isArray(m.reasonCodes) || m.reasonCodes.length !== m.reasons.length) return m.reasons;
  return m.reasonCodes.map((r, i) => window.I18N.reasonText(r) ?? m.reasons[i]);
}

// A schema.org availability value: English "In Stock" (the value with spaces), Slovak "Skladom".
function stockText(a) {
  if (!a) return '?';
  return lookup('stock', a) || a.replace(/([a-z])([A-Z])/g, '$1 $2');
}

// The categories a search covers: English the server's label; Slovak from the category ids or the chosen group.
function scopeLabel(c) {
  if (window.I18N.getLang() === 'en') return c.label;
  if (!c.categories) return lookup('group', 'all').toLowerCase();
  if (c.mode === 'group' && lookup('group', state.cat)) return lookup('group', state.cat);
  return c.categories.map((x) => lookup('category', x) || x).join(', ');
}

async function init() {
  window.I18N.setLang(window.I18N.initialLang());
  for (const b of document.querySelectorAll('[data-lang]')) b.addEventListener('click', () => switchLang(b.dataset.lang));
  void loadUsage();
  try {
    const [locs, cats] = await Promise.all([(await fetch('/api/locations')).json(), (await fetch('/api/categories')).json()]);
    for (const l of locs) $('#location').append(el('option', { value: l.id }, l.name));
    categories = cats;
    for (const c of cats) $('#cat').append(el('option', { value: c.id }, c.label));
    renderCategoryOptions();
  } catch { /* server not reachable: the form still renders */ }
  const params = new URLSearchParams(location.search);
  if (params.get('cat')) $('#cat').value = params.get('cat');
  if (params.get('q')) {
    $('#q').value = params.get('q');
    start(params.get('q'), params.get('location') || 'kosice', params.get('cat') || 'auto', params.get('as_typed') === '1');
  }
  $('#search').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = $('#q').value.trim();
    if (q) go(q, $('#location').value || 'kosice', $('#cat').value || 'auto');
  });
}

function renderCategoryOptions() {
  for (const o of $('#cat').options) {
    const c = categories.find((x) => x.id === o.value);
    o.textContent = (window.I18N.getLang() === 'en' ? null : lookup('group', o.value)) || c?.label || o.value;
  }
}

// The language switch: remembered, kept in the address if it has a search, and everything on screen re-rendered.
function switchLang(l) {
  window.I18N.setLang(l, true);
  if (location.search) {
    const params = new URLSearchParams(location.search);
    params.set('lang', window.I18N.getLang());
    history.replaceState(null, '', `?${params}`);
  }
  renderCategoryOptions();
  renderUsage();
  if (state) {
    renderStart();
    renderRates();
    renderAll();
  }
}

// asTyped: search the query exactly as typed, without the brand correction (the server's as_typed=1).
function searchParams(q, loc, cat, asTyped) {
  return `q=${encodeURIComponent(q)}&location=${encodeURIComponent(loc)}&cat=${encodeURIComponent(cat)}${asTyped ? '&as_typed=1' : ''}&lang=${window.I18N.getLang()}`;
}

function go(q, loc, cat, asTyped = false) {
  history.replaceState(null, '', `?${searchParams(q, loc, cat, asTyped)}`);
  $('#cat').value = cat;
  start(q, loc, cat, asTyped);
}

function start(q, loc, cat, asTyped = false) {
  if (source) source.close();
  state = {
    q, loc, cat, shops: new Map(), groups: [], nearby: { models: [], total: 0 }, nearbyOpenFor: null, selected: null, done: false, heureka: null,
    locName: $('#location').selectedOptions[0]?.textContent || 'Košice', start: null, rates: null, rejected: false, lost: false,
  };
  for (const id of ['#products', '#comparison', '#manual', '#shops']) $(id).hidden = true;
  $('#scope').hidden = true;
  $('#corrected').hidden = true;
  $('#progress').hidden = false;
  $('#progress').textContent = t('asking');
  $('#rates-note').textContent = '';
  $('#local-title').textContent = t('localTitle', where());
  $('#search button').disabled = true;
  source = new EventSource(`/api/search?${searchParams(q, loc, cat, asTyped)}`);
  source.addEventListener('start', (m) => {
    const ev = JSON.parse(m.data);
    state.start = ev;
    state.heureka = ev.heurekaUrl;
    for (const s of ev.shops) state.shops.set(s.id, { info: s, result: null });
    renderStart();
    renderAll();
  });
  source.addEventListener('rates', (m) => {
    state.rates = JSON.parse(m.data);
    renderRates();
  });
  source.addEventListener('shop', (m) => {
    const { result } = JSON.parse(m.data);
    const entry = state.shops.get(result.shopId) || { info: { id: result.shopId, name: result.shopName, section: result.section } };
    entry.result = result;
    state.shops.set(result.shopId, entry);
    renderShops();
  });
  source.addEventListener('products', (m) => {
    const ev = JSON.parse(m.data);
    state.groups = ev.groups;
    state.nearby = ev.nearby || { models: [], total: 0 };
    renderProducts();
  });
  source.addEventListener('done', () => {
    state.done = true;
    source.close();
    $('#search button').disabled = false;
    renderAll();
    void loadUsage();
  });
  // A pasted link without the product's name: nothing was searched; ask for the name.
  source.addEventListener('rejected', () => {
    state.done = true;
    state.rejected = true;
    source.close();
    $('#search button').disabled = false;
    renderStart();
    $('#progress').hidden = true;
    $('#q').focus();
  });
  source.onerror = () => {
    if (!state.done) {
      state.lost = true;
      $('#progress').textContent = t('connectionLost');
      $('#search button').disabled = false;
      source.close();
    }
  };
}

// The lines under the search box: what was searched (a pasted link, a corrected brand typo, or a
// rejected link) and which shops were asked.
function renderStart() {
  const { q, loc, cat } = state;
  if (state.rejected) {
    $('#corrected').replaceChildren(t('rejected'));
    $('#corrected').hidden = false;
    return;
  }
  const ev = state.start;
  if (!ev) return;
  // A pasted link: say which name was taken from it. A corrected brand typo: say what was searched,
  // with a way to search exactly as typed.
  if (ev.fromLink) {
    $('#corrected').replaceChildren(t('fromLink', { query: ev.query }), ev.linkShop ? t('linkShop', { shop: ev.linkShop }) : '');
  } else if (ev.corrected) {
    $('#corrected').replaceChildren(t('corrected', { query: ev.query, typed: ev.typed }),
      el('button', { type: 'button', class: 'link', onclick: () => go(ev.typed, loc, cat, true) }, t('asTyped')));
  }
  $('#corrected').hidden = !(ev.fromLink || ev.corrected);
  const c = ev.categories;
  const widen = c.categories ? el('button', { type: 'button', class: 'link', onclick: () => go(q, loc, 'all') }, t('searchAll')) : null;
  // By rule id (categories.ts); English, an unknown id or an older server: the server's English text.
  const reasons = c.mode === 'auto' && c.categories
    ? c.reasons.map((r, i) => (window.I18N.getLang() === 'en' ? null : lookup('reason', c.reasonIds?.[i])) || r).join(', ') : '';
  $('#scope').replaceChildren(t('scope', { label: scopeLabel(c), reasons }), widen || '');
  $('#scope').hidden = false;
}

function renderRates() {
  const ev = state.rates;
  if (!ev) return;
  $('#rates-note').textContent = ev.rates
    ? t('rates', { date: ev.rates.date ? window.I18N.date(ev.rates.date) : '', list: Object.entries(ev.rates.rates).map(([k, v]) => t('rateItem', { rate: window.I18N.rate(v), cur: k })).join(', ') })
    : t('ratesUnavailable', { error: ev.error });
}

function renderAll() {
  $('#local-title').textContent = t('localTitle', where());
  renderShops();
  renderProducts();
}

function results() {
  return [...state.shops.values()].map((e) => e.result).filter(Boolean);
}

function renderShops() {
  if (state.rejected) return;
  const all = [...state.shops.values()];
  const asked = all.filter((e) => !e.result || e.result.status !== 'not_relevant');
  const finished = asked.filter((e) => e.result).length;
  if (!state.lost) {
    $('#progress').textContent = state.done ? t('done', { n: asked.length }) : t('checking', { finished, n: asked.length });
  } else $('#progress').textContent = t('connectionLost');

  const counts = {};
  for (const r of results()) counts[r.status] = (counts[r.status] || 0) + 1;
  const list = STATUS_ORDER.filter((s) => counts[s]).map((s) => lookup('summary', s)(counts[s])).join(', ');
  $('#shops-summary').textContent = t('shopsSummary', { list, done: state.done });
  $('#shops').hidden = false;

  const order = { ok: 0, no_match: 1, needs_search_key: 2, robots_disallowed: 3, needs_js: 4, blocked: 5, no_route: 6, error: 7, not_relevant: 8 };
  const lists = { local: [], online: [] };
  const sorted = all.sort((a, b) => (a.result ? order[a.result.status] : -1) - (b.result ? order[b.result.status] : -1));
  for (const { info, result } of sorted) {
    const status = result ? result.status : 'pending';
    lists[info.section].push(el('li', {},
      el('span', {}, info.name, info.branchKnown === 'unknown' && info.section === 'online' ? el('span', { class: 'muted small' }, t('branchNotVerified', where())) : null),
      el('span', { class: `badge ${status}` }, lookup('status', status) || status),
      result ? el('span', { class: 'detail' }, result.detail) : null));
  }
  $('#shops-local').replaceChildren(...(lists.local.length ? lists.local : [el('li', { class: 'empty' }, t('none'))]));
  $('#shops-online').replaceChildren(...lists.online);

  const todo = results().filter((r) => UNCHECKED.includes(r.status))
    .sort((a, b) => (a.section === b.section ? a.shopName.localeCompare(b.shopName) : a.section === 'local' ? -1 : 1));
  const items = [];
  if (state.heureka) items.push(el('li', {}, link(state.heureka, t('heureka')), el('span', { class: 'muted small' }, t('heurekaNote'))));
  for (const r of todo) {
    items.push(el('li', {}, link(r.manualUrl || `https://${r.domain}/`, `${r.shopName} ↗`),
      el('span', { class: `badge ${r.status}` }, lookup('status', r.status)),
      r.section === 'local' ? el('span', { class: 'muted small' }, t('branchIn', where())) : null));
  }
  $('#manual-list').replaceChildren(...items);
  $('#manual').hidden = !items.length;
}

function groupKey(g) { return g.signature; }

function productItem(g) {
  const selected = state.selected === groupKey(g);
  const notes = groupNotes(g);
  return el('li', {}, el('button', { type: 'button', 'aria-pressed': selected ? 'true' : 'false', onclick: () => { state.selected = groupKey(g); state.picked = true; renderProducts(); } },
    el('span', { class: 'ptitle' }, g.title),
    el('span', { class: 'price' }, headlineText(g)),
    el('span', { class: 'pmeta' },
      el('span', { class: `badge ${g.level}` }, lookup('fit', g.level)), ' ',
      g.condition !== 'new' ? el('span', { class: 'badge cond' }, lookup('cond', g.condition) || g.condition) : null, ' ',
      t('productMeta', { shops: g.shopCount, offers: g.offerCount, variants: g.variants.length }),
      notes.length ? ` · ${notes.join(' · ')}` : '')));
}

function renderProducts() {
  if (state.rejected) return;
  const groups = state.groups;
  const near = state.nearby;
  const main = groups.filter((g) => g.level !== 'different');
  const other = groups.filter((g) => g.level === 'different');
  $('#products').hidden = !groups.length && !near.models.length && !state.done;
  let empty;
  if (near.models.length) {
    empty = state.done ? t('nearbyNoneDone') : t('nearbyNoneSoFar');
  } else if (!groups.length) {
    empty = state.done ? t('noProducts') : t('waiting');
  } else {
    empty = t('nothingMatches');
  }
  $('#product-list').replaceChildren(...(main.length ? main.map(productItem) : [el('li', { class: 'empty' }, empty)]));
  const exact = main.some((g) => g.level === 'exact');
  // Only possible matches: the list opens below them, with its own introduction.
  $('#nearby-intro').hidden = !(main.length && !exact && near.models.length);
  $('#nearby-intro').textContent = t('nearbyIntro');
  renderNearby(near, !exact);
  $('#other-products').hidden = !other.length;
  $('#other-list').replaceChildren(...other.map(productItem));
  if (!groups.length) {
    $('#comparison').hidden = true;
    return;
  }
  // Until the user picks a product, the comparison follows the first one as results arrive.
  if (!state.picked || !groups.some((g) => groupKey(g) === state.selected)) state.selected = main[0] ? groupKey(main[0]) : null;
  renderComparison(groups.find((g) => groupKey(g) === state.selected));
}

// Similar models the shops list (computed on the server, src/core/nearby.ts): open when no product
// matches the query exactly, collapsed below the products when one does. The open state is set only
// when that situation changes, so a list the user opened or closed stays so while shops keep arriving.
function renderNearby(near, open) {
  const box = $('#nearby');
  box.hidden = !near.models.length;
  if (!near.models.length) return;
  if (state.nearbyOpenFor !== open) {
    box.open = open;
    state.nearbyOpenFor = open;
  }
  const n = near.models.length;
  $('#nearby-summary').textContent = t('nearbySummary', { n, total: near.total });
  $('#nearby-list').replaceChildren(...near.models.map(nearbyItem));
}

// How a model differs from the query: English as the server wrote it; other languages from its arrays.
function differsText(m) {
  if (window.I18N.getLang() === 'en' && m.differs !== undefined) return m.differs;
  return t('differs', { missing: m.missing || [], distinguishing: m.distinguishing || [] });
}

function nearbyItem(m) {
  const shops = m.shops.flatMap((s, i) => [
    i ? ', ' : '',
    el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.title }, s.shopName),
    s.section === 'local' ? el('span', { class: 'muted small' }, t('nearbyBranch', where())) : null,
  ]);
  return el('li', {},
    el('div', { class: 'ninfo' },
      el('span', { class: 'nname' }, m.query),
      el('span', { class: 'nmeta' }, differsText(m)),
      el('span', { class: 'nshops' }, t('listedBy'), ...shops),
      m.seenPrice ? seenPriceLine(m.seenPrice) : null),
    el('button', { type: 'button', onclick: () => compareModel(m.query) }, t('compareModel')));
}

// A price of a similar model, from one shop page (read by the search, or afterwards for the list):
// shown with its shop, a link to the page and a warning, never as a comparison.
function seenPriceLine(p) {
  const warning = t('seenPriceWarning');
  return el('span', { class: 'nprice' },
    el('strong', {}, eur(p.eur)), t('seenAt'), link(p.url, `${p.shopName} ↗`), ' ',
    el('span', { class: 'nwarn', title: warning }, el('span', { 'aria-hidden': 'true' }, '⚠ '), warning));
}

function compareModel(q) {
  $('#q').value = q;
  window.scrollTo({ top: 0 });
  go(q, $('#location').value || state.loc, $('#cat').value || state.cat);
}

const td = (label, attrs, ...children) => el('td', { 'data-label': label, ...attrs }, ...children);
const H = (k) => t(`head.${k}`);

function offerRow(o, local) {
  const tt = o.totals;
  const noDelivery = tt.deliversToSk === false;
  const seller = o.seller && !o.shopName.toLowerCase().includes(o.seller.toLowerCase().split(/[ .]/)[0]) ? el('span', { class: 'sub' }, t('seller', { seller: o.seller })) : null;
  const delivery = noDelivery ? el('span', { class: 'badge nodelivery' }, t('noDelivery'))
    : o.shipsToSk === 'unknown' && !local ? el('span', { class: 'sub' }, t('deliveryNotVerified')) : null;
  const unknown = t('unknown');
  const cells = [
    td(H('shop'), { class: 'shop' }, o.shopName, seller, delivery),
    td(H('variant'), {}, o._variant),
    td(H('item'), { class: 'num' }, eur(tt.itemEur), o.currency !== 'EUR' ? el('span', { class: 'sub' }, window.I18N.money(o.price, o.currency)) : null),
  ];
  if (local) {
    cells.push(
      td(H('pickup'), { class: 'num' }, tt.pickupEur === null ? unknown : tt.pickupEur === 0 ? t('free') : eur(tt.pickupEur), el('span', { class: 'sub' }, tt.pickupNote)),
      td(H('pickupTotal'), { class: 'num total' }, tt.pickupTotalEur === null ? unknown : eur(tt.pickupTotalEur)),
      td(H('delivered'), { class: 'num' }, tt.totalEur === null ? unknown : eur(tt.totalEur), el('span', { class: 'sub' }, tt.shippingNote)),
    );
  } else {
    cells.push(
      td(H('deliveryToSk'), { class: 'num' }, noDelivery ? '—' : tt.shippingEur === null ? unknown : eur(tt.shippingEur), noDelivery ? null : el('span', { class: 'sub' }, tt.shippingNote)),
      td(H('total'), { class: 'num total' }, noDelivery ? t('notRanked') : tt.totalEur === null ? unknown : eur(tt.totalEur)),
    );
  }
  cells.push(
    td(H('stock'), {}, stockText(o.availability)),
    td(H('match'), {}, el('span', { class: `badge ${o.match.level}` }, lookup('fit', o.match.level)),
      o.match.reasons.length ? el('span', { class: 'sub' }, matchReasons(o.match).join('; ')) : null),
    td('', {}, link(o.url, t('open'))),
  );
  return el('tr', { class: [tt.bestTotalEur === null ? 'unknown-total' : '', noDelivery ? 'nodelivery' : ''].join(' ').trim() || null }, ...cells);
}

function offerTable(offers, local) {
  if (!offers.length) return el('p', { class: 'empty' }, t('noOffers'));
  const heads = local
    ? [H('shop'), H('variant'), H('item'), H('pickup'), H('pickupTotal'), H('delivered'), H('stock'), H('match'), '']
    : [H('shop'), H('variant'), H('item'), H('deliveryToSk'), H('total'), H('stock'), H('match'), ''];
  const numeric = new Set(local ? [2, 3, 4, 5] : [2, 3, 4]);
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, heads.map((h, i) => el('th', { class: numeric.has(i) ? 'num' : null }, h)))),
    el('tbody', {}, offers.map((o) => offerRow(o, local)))));
}

// Mirrors sortOffers() in src/core/totals.ts
function sortOffers(list) {
  const reach = (tt) => tt.deliversToSk !== false || tt.pickupTotalEur !== null;
  const tier = (o) => (!reach(o.totals) ? 2 : o.totals.bestTotalEur !== null ? 0 : 1);
  return [...list].sort((a, b) => tier(a) - tier(b)
    || (a.totals.bestTotalEur ?? a.totals.itemEur ?? Infinity) - (b.totals.bestTotalEur ?? b.totals.itemEur ?? Infinity));
}

function renderComparison(g) {
  if (!g) {
    $('#comparison').hidden = true;
    return;
  }
  $('#comparison').hidden = false;
  $('#cmp-title').textContent = t('comparison', { title: g.title });
  $('#cmp-headline').textContent = headlineText(g);
  $('#cmp-notes').textContent = [lookup('fit', g.level), g.condition !== 'new' ? lookup('cond', g.condition) : null, ...groupNotes(g)].filter(Boolean).join(' · ');
  $('#variants').replaceChildren(...g.variants.map((v) => el('div', { class: 'variant' },
    el('b', {}, variantLabel(v)), t('offers', { n: v.offers.length }),
    el('span', { class: 'sub' }, v.bestItemEur === null ? t('noPriceReachesSk')
      : `${t('from', { price: eur(v.bestItemEur), known: v.bestItemTotalKnown })}${v.bestTotalEur !== null && v.bestTotalEur !== v.bestItemEur ? t('knownTotalFrom', { price: eur(v.bestTotalEur) }) : ''}`),
    v.gtin ? el('span', { class: 'sub' }, `GTIN ${v.gtin.replace(/^0/, '')}`) : null)));
  const offers = g.variants.flatMap((v) => v.offers.map((o) => ({ ...o, _variant: variantLabel(v) || '—' })));
  $('#cmp-local-title').textContent = t('localTitle', where());
  $('#cmp-local').replaceChildren(offerTable(sortOffers(offers.filter((o) => o.section === 'local')), true));
  $('#cmp-online').replaceChildren(offerTable(sortOffers(offers.filter((o) => o.section === 'online')), false));
}

init();
