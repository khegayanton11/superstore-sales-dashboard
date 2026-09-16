// Прогоняем реальный код страницы в Node: подменяем DOM заглушкой,
// отрезаем блок запуска и сверяем свёртку с эталоном, посчитанным в Python.
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('public/app.js', 'utf8');
const code = src.slice(0, src.indexOf('/* ── запуск'))
  + '\nglobalThis.api = { scan, total, countOrders, margin, computeSignals, customerSegments,' +
  ' periods, state, indexData, setD: d => { D = d; } };';

const stub = { addEventListener() {}, style: {}, textContent: '', innerHTML: '',
               setAttribute() {}, getAttribute: () => '', appendChild() {} };
const ctx = { document: { getElementById: () => stub, createElementNS: () => stub,
                          createElement: () => stub, querySelectorAll: () => [] },
              Intl, Math, console };
vm.createContext(ctx);
vm.runInContext(code, ctx);

const read = n => JSON.parse(fs.readFileSync(`public/data/${n}.json`, 'utf8'));
const meta = read('meta'), products = read('products'), facts = read('facts'), orders = read('orders');
const { api } = ctx;
api.setD({
  meta, products, subcats: read('subcategories'), customers: read('customers'),
  facts: facts.rows, orders: orders.rows,
});
api.indexData();

let ok = true;
const chk = (name, got, want, tol = 1) => {
  const good = Math.abs(got - want) <= tol;
  ok &&= good;
  console.log(`${good ? 'OK  ' : 'FAIL'} ${name.padEnd(30)} ${Math.round(got * 100) / 100}   эталон ${want}`);
};

const P = api.periods();
const cur = api.total({ months: P.cur }), pri = api.total({ months: P.pri });

chk('выручка 2017', cur.sales, 733215);
chk('маржа 2017', cur.profit, 93439);
chk('выручка 2016', pri.sales, 609206);
chk('маржа 2016', pri.profit, 81795);
console.log(`     маржинальность 2017 ${api.margin(cur).toFixed(1)}%  ·  2016 ${api.margin(pri).toFixed(1)}%\n`);

// Заказы считаются отдельной таблицей (orders.json), не столбцом facts —
// nunique(order_id) на зерне фактов задваивал многотоварные заказы. Эталон —
// meta.checks.orders_by_year, посчитанный в build_data.py из сырых данных,
// а не переиспользующий ту же (когда-то ошибочную) логику, что и страница.
chk('заказы 2017 (countOrders)', api.countOrders({ months: P.cur }), meta.checks.orders_by_year.current, 0);
chk('заказы 2016 (countOrders)', api.countOrders({ months: P.pri }), meta.checks.orders_by_year.prior, 0);
chk('orders.json длина = orders_raw', orders.rows.length, meta.checks.orders_raw, 0);

const rc = api.scan({ months: P.cur, groupBy: 1, ignore: ['region'] });
const want = { West: [250128, 43809], East: [213083, 33230], Central: [147098, 7551], South: [122906, 8849] };
for (const [k, a] of rc) {
  const n = meta.dims.regions[k];
  chk(`${n} выручка`, a.sales, want[n][0]);
  chk(`${n} маржа`, a.profit, want[n][1]);
}
chk('сумма регионов = итог', [...rc.values()].reduce((s, a) => s + a.sales, 0), cur.sales, 0.5);

const west = [...rc.keys()].find(k => meta.dims.regions[k] === 'West');
api.state.region = west;
chk('фильтр West', api.total({ months: P.cur }).sales, want.West[0]);
chk('ignore region не фильтрует свой же срез', api.scan({ months: P.cur, groupBy: 1, ignore: ['region'] }).size, 4, 0);
chk('фильтр West сужает заказы', api.countOrders({ months: P.cur }) < meta.checks.orders_by_year.current, true, 0);
api.state.region = null;

const sub = api.scan({ months: P.cur, groupBy: r => products[r[4]].subcategory });
chk('сумма подкатегорий = итог', [...sub.values()].reduce((s, a) => s + a.sales, 0), cur.sales, 0.5);
const disc = api.scan({ months: P.cur, groupBy: 3 });
chk('сумма корзин скидки = итог', [...disc.values()].reduce((s, a) => s + a.sales, 0), cur.sales, 0.5);

// новые измерения фильтра: канал и подкатегория
const bySeg = api.scan({ months: P.cur, groupBy: 2, ignore: ['segment'] });
chk('сумма каналов = итог', [...bySeg.values()].reduce((s, a) => s + a.sales, 0), cur.sales, 0.5);
const consumerIx = meta.dims.segments.indexOf('Consumer');
api.state.segment = consumerIx;
chk('фильтр канала сужает выручку', api.total({ months: P.cur }).sales < cur.sales, true, 0);
chk('фильтр канала не трогает свой же срез (ignore)', api.scan({ months: P.cur, groupBy: 2, ignore: ['segment'] }).size, meta.dims.segments.length, 0);
api.state.segment = null;

const tablesIx = meta.dims.subcategories.indexOf('Tables');
api.state.subcategory = tablesIx;
const tablesTotal = api.total({ months: P.cur });
chk('фильтр подкатегории даёт положительную выручку', tablesTotal.sales > 0, true, 0);
const bySubIgnored = api.scan({ months: P.cur, groupBy: r => products[r[4]].subcategory, ignore: ['subcategory'] });
chk('фильтр подкатегории не трогает свой же срез (ignore)', bySubIgnored.size, sub.size, 0);
api.state.subcategory = null;

// клиенты: активные/новые/замолчавшие, концентрация маржи
const seg = api.customerSegments(P);
chk('активные + замолчавшие <= всех клиентов истории', seg.active <= meta.checks.customers_mart, true, 0);
chk('top10Share в разумных пределах (0..100]', seg.top10Share > 0 && seg.top10Share <= 100, true, 0);

console.log('\n--- сигналы, порядок по эффекту на прибыль ---');
api.computeSignals(P).forEach((s, i) =>
  console.log(`${i + 1}. [${Math.round(s.impact).toString().padStart(6)}] ${s.warn ? '⚠ ' : '  '}${s.title}\n   ${s.body.replace(/<[^>]+>/g, '')}\n`));

console.log(ok ? 'ВСЕ ПРОВЕРКИ ПРОШЛИ' : 'ЕСТЬ РАСХОЖДЕНИЯ');
process.exit(ok ? 0 : 1);
