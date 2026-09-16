// Смоук-тест отрисовки: гоняем весь путь render() на минимальной
// заглушке DOM. Ловит ошибки в графиках и разметке до открытия браузера.
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('public/app.js', 'utf8');
const code = src.slice(0, src.indexOf('/* ── запуск'))
  + '\nglobalThis.api = { render, renderKpis, renderLead, renderTicker, renderGeo,' +
  ' renderDiscounts, renderChannels, renderSku, renderCustomers,' +
  ' renderSignals, renderScope, periods, state, indexData, setD: d => { D = d; } };';

let created = 0, clock = 0;
function node(tag = 'div') {
  created++;
  const n = {
    tag, children: [], _html: '', textContent: '', style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
    setAttribute() {}, getAttribute: () => '', removeAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, remove() {},
    querySelector: () => node(), querySelectorAll: () => [],
    getTotalLength: () => 100,
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    set hidden(v) {}, get hidden() { return false; },
    set onclick(v) {},
  };
  return n;
}

const ctx = {
  document: { getElementById: () => node(), createElementNS: (ns, t) => node(t),
              createElement: t => node(t), querySelectorAll: () => [] },
  window: {}, Intl, Math, console, innerWidth: 1280,
  // время двигается, иначе счётчики в countUp не доходят до конца
  requestAnimationFrame: fn => { clock += 60; fn(clock); },
  performance: { now: () => clock },
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

const read = n => JSON.parse(fs.readFileSync(`public/data/${n}.json`, 'utf8'));
const meta = read('meta'), facts = read('facts'), orders = read('orders');
const { api } = ctx;
api.setD({
  meta, products: read('products'), subcats: read('subcategories'),
  customers: read('customers'), facts: facts.rows, orders: orders.rows,
});
api.indexData();

const regionIx = i => i % meta.dims.regions.length;
const segmentIx = i => i % meta.dims.segments.length;
const subcatIx = i => i % meta.dims.subcategories.length;

const cases = [
  ['год, все фильтры сброшены', { period: 'year', region: null, segment: null, disc: null, subcategory: null, metric: 'sales' }],
  ['год, метрика маржа', { period: 'year', metric: 'profit' }],
  ['квартал, все регионы', { period: 'quarter', metric: 'sales' }],
  ['год, фильтр региона 0', { period: 'year', region: regionIx(0), metric: 'sales' }],
  ['квартал, фильтр региона 3', { period: 'quarter', region: regionIx(3), metric: 'profit' }],
  ['год, фильтр канала', { period: 'year', region: null, segment: segmentIx(1) }],
  ['год, фильтр скидки over20', { period: 'year', segment: null, disc: meta.dims.discounts.indexOf('over20') }],
  ['год, фильтр подкатегории (список товаров)', { period: 'year', disc: null, subcategory: subcatIx(2) }],
  ['год, регион + канал + подкатегория вместе', { period: 'year', region: regionIx(1), segment: segmentIx(2), subcategory: subcatIx(5) }],
  ['выбран клиент (детальная карточка)', { selectedCustomer: 0 }],
];

let ok = true;
for (const [name, st] of cases) {
  Object.assign(api.state, st);
  const before = created;
  try {
    api.render();
    console.log(`OK   ${name.padEnd(38)} создано узлов: ${created - before}`);
  } catch (e) {
    ok = false;
    console.log(`FAIL ${name.padEnd(38)} ${e.stack}`);
  }
}

// разворачивание списка сигналов
api.state.showAllSignals = true;
try { api.renderSignals(api.periods()); console.log('OK   развёрнутые сигналы'); }
catch (e) { ok = false; console.log('FAIL развёрнутые сигналы: ' + e.message); }

// SKU: сначала список подкатегорий, потом клик внутрь конкретной подкатегории
api.state.subcategory = null;
try { api.renderSku(api.periods()); console.log('OK   SKU: список подкатегорий'); }
catch (e) { ok = false; console.log('FAIL SKU (подкатегории): ' + e.stack); }
api.state.subcategory = subcatIx(0);
try { api.renderSku(api.periods()); console.log('OK   SKU: товары внутри подкатегории'); }
catch (e) { ok = false; console.log('FAIL SKU (товары): ' + e.stack); }
api.state.subcategory = null;

console.log(ok ? '\nОТРИСОВКА БЕЗ ОШИБОК' : '\nЕСТЬ ОШИБКИ ОТРИСОВКИ');
process.exit(ok ? 0 : 1);
