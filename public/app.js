// PriceCompare front end: plain JS, no framework. Listens to /api/search (Server-Sent Events).
// Page order: the products and the comparison first, then the shops to open by hand, then the
// per-shop statuses (collapsed to one line).

const $ = (sel) => document.querySelector(sel);
const STATUS_TEXT = {
  pending: 'searching…', ok: 'found', no_match: 'no match', blocked: 'blocked', robots_disallowed: 'robots.txt disallows',
  needs_js: 'needs a browser', needs_search_key: 'needs a search key', no_route: 'no automatic route', error: 'error',
  not_relevant: 'not asked',
};
const FIT_TEXT = { exact: 'match', possible: 'possible match, check it', different: 'other product' };
const COND_TEXT = { used: 'used', refurbished: 'refurbished', damaged: 'damaged', unknown_used: 'unpacked / ex-display' };
// Mirrors src/core/report.ts
const SUMMARY = [
  ['ok', (n) => `${n} found`], ['no_match', (n) => `${n} no match`], ['blocked', (n) => `${n} blocked`],
  ['needs_js', (n) => `${n} need${n === 1 ? 's' : ''} a browser`], ['needs_search_key', (n) => `${n} need${n === 1 ? 's' : ''} a search key`],
  ['robots_disallowed', (n) => `${n} disallowed by robots.txt`], ['no_route', (n) => `${n} no automatic route`],
  ['error', (n) => `${n} error${n === 1 ? '' : 's'}`], ['not_relevant', (n) => `${n} not asked (not relevant)`],
];
const UNCHECKED = ['blocked', 'needs_js', 'needs_search_key', 'robots_disallowed', 'no_route', 'error'];

let source = null;
let state = null;

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
const eur = (n) => (n === null || n === undefined ? '?' : `${n.toFixed(2)} €`);
const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

// Mirrors headlineText() in src/core/totals.ts
function headlineText(h) {
  if (h.bestItemEur === null) return 'no price that reaches Slovakia';
  const parts = [`from ${eur(h.bestItemEur)}${h.bestItemTotalKnown ? '' : ' + shipping?'}`];
  if (h.bestTotalEur !== null && !(h.bestItemTotalKnown && h.bestTotalEur === h.bestItemEur)) {
    parts.push(`cheapest known total ${eur(h.bestTotalEur)}${h.bestTotalShop ? ` (${h.bestTotalShop}${h.bestTotalKind === 'pickup' ? ', pickup' : ''})` : ''}`);
  } else if (h.bestTotalEur === null) parts.push('no known total');
  return parts.join(' · ');
}

async function init() {
  try {
    const [locs, cats] = await Promise.all([(await fetch('/api/locations')).json(), (await fetch('/api/categories')).json()]);
    for (const l of locs) $('#location').append(el('option', { value: l.id }, l.name));
    for (const c of cats) $('#cat').append(el('option', { value: c.id }, c.label));
  } catch { /* server not reachable: the form still renders */ }
  const params = new URLSearchParams(location.search);
  if (params.get('cat')) $('#cat').value = params.get('cat');
  if (params.get('q')) {
    $('#q').value = params.get('q');
    start(params.get('q'), params.get('location') || 'kosice', params.get('cat') || 'auto');
  }
  $('#search').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = $('#q').value.trim();
    if (q) go(q, $('#location').value || 'kosice', $('#cat').value || 'auto');
  });
}

function go(q, loc, cat) {
  history.replaceState(null, '', `?q=${encodeURIComponent(q)}&location=${encodeURIComponent(loc)}&cat=${encodeURIComponent(cat)}`);
  $('#cat').value = cat;
  start(q, loc, cat);
}

function start(q, loc, cat) {
  if (source) source.close();
  state = {
    q, loc, cat, shops: new Map(), groups: [], nearby: { models: [], total: 0 }, nearbyOpenFor: null, selected: null, done: false, heureka: null,
    locName: $('#location').selectedOptions[0]?.textContent || 'Košice',
  };
  for (const id of ['#products', '#comparison', '#manual', '#shops']) $(id).hidden = true;
  $('#scope').hidden = true;
  $('#progress').hidden = false;
  $('#progress').textContent = 'Asking the shops…';
  $('#rates-note').textContent = '';
  $('#local-title').textContent = `Shops with a branch in ${state.locName}`;
  $('#search button').disabled = true;
  source = new EventSource(`/api/search?q=${encodeURIComponent(q)}&location=${encodeURIComponent(loc)}&cat=${encodeURIComponent(cat)}`);
  source.addEventListener('start', (m) => {
    const ev = JSON.parse(m.data);
    state.heureka = ev.heurekaUrl;
    for (const s of ev.shops) state.shops.set(s.id, { info: s, result: null });
    const c = ev.categories;
    const widen = c.categories ? el('button', { type: 'button', class: 'link', onclick: () => go(q, loc, 'all') }, 'Search all shops instead') : null;
    $('#scope').replaceChildren(`Shops asked: ${c.label}${c.mode === 'auto' && c.categories ? ` (guessed from the query: ${c.reasons.join(', ')})` : ''}. `, widen || '');
    $('#scope').hidden = false;
    renderAll();
  });
  source.addEventListener('rates', (m) => {
    const ev = JSON.parse(m.data);
    $('#rates-note').textContent = ev.rates
      ? `Exchange rates: ECB reference rates of ${ev.rates.date || 'today'} (${Object.entries(ev.rates.rates).map(([k, v]) => `1 € = ${v} ${k}`).join(', ')}).`
      : `Exchange rates unavailable (${ev.error}); prices in other currencies have no EUR total.`;
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
  });
  source.onerror = () => {
    if (!state.done) {
      $('#progress').textContent = 'Connection to the local server lost.';
      $('#search button').disabled = false;
      source.close();
    }
  };
}

function renderAll() {
  renderShops();
  renderProducts();
}

function results() {
  return [...state.shops.values()].map((e) => e.result).filter(Boolean);
}

function renderShops() {
  const all = [...state.shops.values()];
  const asked = all.filter((e) => !e.result || e.result.status !== 'not_relevant');
  const finished = asked.filter((e) => e.result).length;
  $('#progress').textContent = state.done
    ? `Done: ${asked.length} shops asked.`
    : `Checking shops: ${finished} of ${asked.length} finished…`;

  const counts = {};
  for (const r of results()) counts[r.status] = (counts[r.status] || 0) + 1;
  $('#shops-summary').textContent = `Shops: ${SUMMARY.filter(([s]) => counts[s]).map(([s, f]) => f(counts[s])).join(', ') || 'waiting…'}${state.done ? '' : ' (still searching)'}`;
  $('#shops').hidden = false;

  const order = { ok: 0, no_match: 1, needs_search_key: 2, robots_disallowed: 3, needs_js: 4, blocked: 5, no_route: 6, error: 7, not_relevant: 8 };
  const lists = { local: [], online: [] };
  const sorted = all.sort((a, b) => (a.result ? order[a.result.status] : -1) - (b.result ? order[b.result.status] : -1));
  for (const { info, result } of sorted) {
    const status = result ? result.status : 'pending';
    lists[info.section].push(el('li', {},
      el('span', {}, info.name, info.branchKnown === 'unknown' && info.section === 'online' ? el('span', { class: 'muted small' }, ' (Košice branch not verified)') : null),
      el('span', { class: `badge ${status}` }, STATUS_TEXT[status] || status),
      result ? el('span', { class: 'detail' }, result.detail) : null));
  }
  $('#shops-local').replaceChildren(...(lists.local.length ? lists.local : [el('li', { class: 'empty' }, 'none')]));
  $('#shops-online').replaceChildren(...lists.online);

  const todo = results().filter((r) => UNCHECKED.includes(r.status))
    .sort((a, b) => (a.section === b.section ? a.shopName.localeCompare(b.shopName) : a.section === 'local' ? -1 : 1));
  const items = [];
  if (state.heureka) items.push(el('li', {}, link(state.heureka, 'Heureka.sk ↗'), el('span', { class: 'muted small' }, 'comparator; never fetched by this app')));
  for (const r of todo) {
    items.push(el('li', {}, link(r.manualUrl || `https://${r.domain}/`, `${r.shopName} ↗`),
      el('span', { class: `badge ${r.status}` }, STATUS_TEXT[r.status]),
      r.section === 'local' ? el('span', { class: 'muted small' }, `branch in ${state.locName}`) : null));
  }
  $('#manual-list').replaceChildren(...items);
  $('#manual').hidden = !items.length;
}

function groupKey(g) { return g.signature; }

function productItem(g) {
  const selected = state.selected === groupKey(g);
  return el('li', {}, el('button', { type: 'button', 'aria-pressed': selected ? 'true' : 'false', onclick: () => { state.selected = groupKey(g); state.picked = true; renderProducts(); } },
    el('span', { class: 'ptitle' }, g.title),
    el('span', { class: 'price' }, headlineText(g)),
    el('span', { class: 'pmeta' },
      el('span', { class: `badge ${g.level}` }, FIT_TEXT[g.level]), ' ',
      g.condition !== 'new' ? el('span', { class: 'badge cond' }, COND_TEXT[g.condition] || g.condition) : null, ' ',
      `${g.shopCount} shop${g.shopCount > 1 ? 's' : ''}, ${g.offerCount} offer${g.offerCount > 1 ? 's' : ''}, ${g.variants.length} variant${g.variants.length > 1 ? 's' : ''}`,
      g.notes.length ? ` · ${g.notes.join(' · ')}` : '')));
}

function renderProducts() {
  const groups = state.groups;
  const near = state.nearby;
  const main = groups.filter((g) => g.level !== 'different');
  const other = groups.filter((g) => g.level === 'different');
  $('#products').hidden = !groups.length && !near.models.length && !state.done;
  let empty;
  if (near.models.length) {
    empty = state.done ? 'No shop lists exactly what you typed. Similar models the shops list:'
      : 'No shop has listed exactly what you typed so far. Similar models the shops list:';
  } else if (!groups.length) {
    empty = state.done ? 'No priced products found. Use the links below to check the shops yourself.' : 'Waiting for shops…';
  } else {
    empty = 'Nothing matches the query exactly or possibly; see the other products below.';
  }
  $('#product-list').replaceChildren(...(main.length ? main.map(productItem) : [el('li', { class: 'empty' }, empty)]));
  const exact = main.some((g) => g.level === 'exact');
  // Only possible matches: the list opens below them, with its own introduction.
  $('#nearby-intro').hidden = !(main.length && !exact && near.models.length);
  $('#nearby-intro').textContent = 'No shop lists exactly what you typed; the products above are possible matches. Similar models the shops list:';
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
  $('#nearby-summary').textContent = `Similar models the shops list (${near.total > n ? `the ${n} closest of ${near.total}` : n})`;
  $('#nearby-list').replaceChildren(...near.models.map(nearbyItem));
}

function nearbyItem(m) {
  const shops = m.shops.flatMap((s, i) => [
    i ? ', ' : '',
    el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.title }, s.shopName),
    s.section === 'local' ? el('span', { class: 'muted small' }, ` (branch in ${state.locName})`) : null,
  ]);
  return el('li', {},
    el('div', { class: 'ninfo' },
      el('span', { class: 'nname' }, m.query),
      el('span', { class: 'nmeta' }, m.differs),
      el('span', { class: 'nshops' }, 'Listed by ', ...shops),
      m.seenPrice ? el('span', { class: 'nmeta' }, `seen at ${eur(m.seenPrice.eur)} at ${m.seenPrice.shopName} (one shop's price, not a comparison)`) : null),
    el('button', { type: 'button', onclick: () => compareModel(m.query) }, 'Compare this model'));
}

function compareModel(q) {
  $('#q').value = q;
  window.scrollTo({ top: 0 });
  go(q, $('#location').value || state.loc, $('#cat').value || state.cat);
}

const td = (label, attrs, ...children) => el('td', { 'data-label': label, ...attrs }, ...children);

function offerRow(o, local) {
  const t = o.totals;
  const noDelivery = t.deliversToSk === false;
  const seller = o.seller && !o.shopName.toLowerCase().includes(o.seller.toLowerCase().split(/[ .]/)[0]) ? el('span', { class: 'sub' }, `seller: ${o.seller}`) : null;
  const delivery = noDelivery ? el('span', { class: 'badge nodelivery' }, 'does not deliver to Slovakia')
    : o.shipsToSk === 'unknown' && !local ? el('span', { class: 'sub' }, 'delivery to SK not verified') : null;
  const cells = [
    td('Shop', { class: 'shop' }, o.shopName, seller, delivery),
    td('Variant', {}, o._variant),
    td('Item', { class: 'num' }, eur(t.itemEur), o.currency !== 'EUR' ? el('span', { class: 'sub' }, `${o.price} ${o.currency}`) : null),
  ];
  if (local) {
    cells.push(
      td('Pickup', { class: 'num' }, t.pickupEur === null ? 'unknown' : t.pickupEur === 0 ? 'free' : eur(t.pickupEur), el('span', { class: 'sub' }, t.pickupNote)),
      td('Pickup total', { class: 'num total' }, t.pickupTotalEur === null ? 'unknown' : eur(t.pickupTotalEur)),
      td('Delivered', { class: 'num' }, t.totalEur === null ? 'unknown' : eur(t.totalEur), el('span', { class: 'sub' }, t.shippingNote)),
    );
  } else {
    cells.push(
      td('Delivery to SK', { class: 'num' }, noDelivery ? '—' : t.shippingEur === null ? 'unknown' : eur(t.shippingEur), noDelivery ? null : el('span', { class: 'sub' }, t.shippingNote)),
      td('Total', { class: 'num total' }, noDelivery ? 'not ranked' : t.totalEur === null ? 'unknown' : eur(t.totalEur)),
    );
  }
  cells.push(
    td('Stock', {}, (o.availability || '?').replace(/([a-z])([A-Z])/g, '$1 $2')),
    td('Match', {}, el('span', { class: `badge ${o.match.level}` }, FIT_TEXT[o.match.level]),
      o.match.reasons.length ? el('span', { class: 'sub' }, o.match.reasons.join('; ')) : null),
    td('', {}, link(o.url, 'open ↗')),
  );
  return el('tr', { class: [t.bestTotalEur === null ? 'unknown-total' : '', noDelivery ? 'nodelivery' : ''].join(' ').trim() || null }, ...cells);
}

function offerTable(offers, local) {
  if (!offers.length) return el('p', { class: 'empty' }, 'No offers for this product.');
  const heads = local
    ? ['Shop', 'Variant', 'Item', 'Pickup', 'Pickup total', 'Delivered', 'Stock', 'Match', '']
    : ['Shop', 'Variant', 'Item', 'Delivery to SK', 'Total', 'Stock', 'Match', ''];
  const numeric = new Set(local ? [2, 3, 4, 5] : [2, 3, 4]);
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, heads.map((h, i) => el('th', { class: numeric.has(i) ? 'num' : null }, h)))),
    el('tbody', {}, offers.map((o) => offerRow(o, local)))));
}

// Mirrors sortOffers() in src/core/totals.ts
function sortOffers(list) {
  const reach = (t) => t.deliversToSk !== false || t.pickupTotalEur !== null;
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
  $('#cmp-title').textContent = `Comparison: ${g.title}`;
  $('#cmp-headline').textContent = headlineText(g);
  $('#cmp-notes').textContent = [FIT_TEXT[g.level], g.condition !== 'new' ? COND_TEXT[g.condition] : null, ...g.notes].filter(Boolean).join(' · ');
  $('#variants').replaceChildren(...g.variants.map((v) => el('div', { class: 'variant' },
    el('b', {}, v.label.replace(/,? ?GTIN \d+$/, '')), ` · ${v.offers.length} offer${v.offers.length > 1 ? 's' : ''}`,
    el('span', { class: 'sub' }, v.bestItemEur === null ? 'no price that reaches Slovakia'
      : `from ${eur(v.bestItemEur)}${v.bestItemTotalKnown ? '' : ' + shipping?'}${v.bestTotalEur !== null && v.bestTotalEur !== v.bestItemEur ? ` · known total from ${eur(v.bestTotalEur)}` : ''}`),
    v.gtin ? el('span', { class: 'sub' }, `GTIN ${v.gtin.replace(/^0/, '')}`) : null)));
  const offers = g.variants.flatMap((v) => v.offers.map((o) => ({ ...o, _variant: v.label.replace(/,? ?GTIN \d+$/, '') || '—' })));
  $('#cmp-local-title').textContent = `Shops with a branch in ${state.locName}`;
  $('#cmp-local').replaceChildren(offerTable(sortOffers(offers.filter((o) => o.section === 'local')), true));
  $('#cmp-online').replaceChildren(offerTable(sortOffers(offers.filter((o) => o.section === 'online')), false));
}

init();
