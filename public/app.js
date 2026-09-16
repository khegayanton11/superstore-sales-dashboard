/* ─────────────────────────────────────────────────────────────
   Обзор продаж — логика

   В браузер приезжает одна таблица фактов на зерне
   месяц × регион × сегмент × корзина скидки × товар × клиент.
   Все цифры на странице — свёртка этой таблицы. Отдельных
   предпосчитанных агрегатов нет: разойтись между блоками нечему.
   ───────────────────────────────────────────────────────────── */

const COL = { month: 0, region: 1, segment: 2, disc: 3, product: 4, customer: 5,
              sales: 6, profit: 7, qty: 8 };
const OCOL = { month: 0, region: 1, segment: 2, customer: 3 };

const state = {
  period: 'year', metric: 'sales', showAllSignals: false,
  region: null, segment: null, disc: null, subcategory: null,
  selectedCustomer: null, skuCategory: null,
};
let D = null;
// index товара -> индекс подкатегории/категории; строится в boot() один раз,
// после этого фильтр по подкатегории — целочисленное сравнение, как остальные
let productSubIx = [];
let productCatIx = [];
let subcatByName = new Map();
let medianProductAdi = 0;

// Строит производные индексы поверх D после её загрузки. Отдельная функция
// (не инлайн в boot()), чтобы test_render.mjs мог собрать то же состояние,
// минуя fetch — иначе фильтр по подкатегории в тестовой среде работал бы
// не так, как в браузере.
function indexData() {
  productSubIx = D.products.map(p => D.meta.dims.subcategories.indexOf(p.subcategory));
  productCatIx = D.products.map(p => D.meta.dims.categories.indexOf(p.category));
  subcatByName = new Map(D.subcats.map(s => [s.subcategory, s]));
  const adiVals = D.products.map(p => p.adi).filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  medianProductAdi = adiVals.length ? adiVals[Math.floor(adiVals.length / 2)] : 0;
}

/* ── форматирование ────────────────────────────────────────── */

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const money = v => (v < 0 ? '−' : '') + '$' + nf0.format(Math.abs(Math.round(v)));
const pct = v => (v < 0 ? '−' : '') + nf1.format(Math.abs(v)) + '%';
const pp = v => (v > 0 ? '+' : v < 0 ? '−' : '') + nf1.format(Math.abs(v)) + ' п.п.';
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + nf1.format(Math.abs(v)) + '%';

function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v < 0 ? '−' : '') + nf1.format(a / 1e6) + ' млн';
  if (a >= 1e3) return (v < 0 ? '−' : '') + nf0.format(a / 1e3) + ' тыс.';
  return nf0.format(v);
}

const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
                   'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const DISC_LABELS = { none: 'Без скидки', upto20: 'До 20%', over20: 'Свыше 20%' };
const PRICE_GROUP_LABELS = { low: 'Бюджетные', mid: 'Средние', high: 'Премиум' };
const PATTERN_LABELS = {
  smooth: 'ровный', intermittent: 'редкий', erratic: 'неровный',
  lumpy: 'рваный', 'no-demand': 'нет продаж',
};

/* ── свёртка ───────────────────────────────────────────────── */

const empty = () => ({ sales: 0, profit: 0, qty: 0 });

function add(acc, row) {
  acc.sales  += row[COL.sales];
  acc.profit += row[COL.profit];
  acc.qty    += row[COL.qty];
  return acc;
}

const margin = a => (a.sales > 0 ? 100 * a.profit / a.sales : 0);

/**
 * Единственная точка доступа к таблице фактов.
 *   months   — Set индексов месяцев
 *   groupBy  — индекс колонки, функция(row) или null для общего итога
 *   ignore   — массив имён активных фильтров, которые нужно ВРЕМЕННО не
 *              применять для этого конкретного среза (так свой собственный
 *              разрез региона показывает все регионы, а не только выбранный,
 *              при этом остальные блоки фильтруются по нему как обычно)
 */
function scan({ months, groupBy = null, ignore = [] } = {}) {
  const out = new Map();
  const reg  = ignore.includes('region')      ? null : state.region;
  const seg  = ignore.includes('segment')     ? null : state.segment;
  const disc = ignore.includes('disc')        ? null : state.disc;
  const sub  = ignore.includes('subcategory') ? null : state.subcategory;
  for (let i = 0; i < D.facts.length; i++) {
    const row = D.facts[i];
    if (months && !months.has(row[COL.month])) continue;
    if (reg  !== null && row[COL.region] !== reg) continue;
    if (seg  !== null && row[COL.segment] !== seg) continue;
    if (disc !== null && row[COL.disc] !== disc) continue;
    if (sub  !== null && productSubIx[row[COL.product]] !== sub) continue;
    const key = groupBy === null ? '·'
              : (typeof groupBy === 'function' ? groupBy(row) : row[groupBy]);
    if (key === null || key === undefined) continue;
    let acc = out.get(key);
    if (!acc) out.set(key, acc = empty());
    add(acc, row);
  }
  return out;
}

const total = opts => scan({ ...opts, groupBy: null }).get('·') || empty();

/**
 * Количество заказов — отдельная таблица (orders.json), не столбец в facts.
 * Один заказ почти всегда состоит из нескольких товарных позиций, то есть
 * попадает в несколько строк таблицы фактов; счёт nunique(order_id) на её
 * зерне задваивал заказы (проверено: 3310 вместо истинных 1687 за 2017 год).
 * Заказ целиком лежит в одном месяце/регионе/сегменте/клиенте, поэтому здесь
 * можно фильтровать так же, как в scan(), — расхождений с фактами не будет.
 */
function countOrders({ months, ignore = [] } = {}) {
  const reg = ignore.includes('region')  ? null : state.region;
  const seg = ignore.includes('segment') ? null : state.segment;
  let n = 0;
  for (const o of D.orders) {
    if (months && !months.has(o[OCOL.month])) continue;
    if (reg !== null && o[OCOL.region] !== reg) continue;
    if (seg !== null && o[OCOL.segment] !== seg) continue;
    n++;
  }
  return n;
}

/* ── периоды ───────────────────────────────────────────────── */

function periods() {
  const p = D.meta.periods[state.period];
  const ix = name => D.meta.dims.months.indexOf(name);
  return {
    cur: new Set(p.current.map(ix).filter(i => i >= 0)),
    pri: new Set(p.prior.map(ix).filter(i => i >= 0)),
    curLabel: p.current_label,
    priLabel: p.prior_label,
    curMonths: p.current,
  };
}

/* ── svg-примитивы ─────────────────────────────────────────── */

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent = null) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
function svgRoot(host, w, h) {
  host.innerHTML = '';
  const s = el('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'xMinYMid meet' });
  host.appendChild(s);
  return s;
}

/* появление
   Разыгрываем count-up/grow/draw только на первой отрисовке страницы.
   render() перестраивает все SVG с нуля на каждый клик фильтра — без этого
   флага любой клик заново проигрывал бы полуторасекундные анимации всех
   графиков и KPI, и страница ощущалась бы медленной при обычной работе
   с фильтрами, а не только при первой загрузке. */
let booted = false;

function animateIn(root) {
  if (!booted) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      root.querySelectorAll('.grow, .pop').forEach((n, i) => {
        n.style.transitionDelay = (i * 45) + 'ms';
        n.classList.add('in');
      });
    }));
  } else {
    root.querySelectorAll('.grow, .pop').forEach(n => n.classList.add('in'));
  }
}
function drawLine(node, dur) {
  const len = node.getTotalLength ? node.getTotalLength() : 900;
  if (!booted) {
    node.setAttribute('stroke-dasharray', len);
    node.setAttribute('stroke-dashoffset', len);
    node.classList.add('draw');
    if (dur) node.style.transitionDuration = dur + 'ms';
    requestAnimationFrame(() => requestAnimationFrame(() => node.setAttribute('stroke-dashoffset', 0)));
  } else {
    node.setAttribute('stroke-dasharray', len);
    node.setAttribute('stroke-dashoffset', 0);
  }
}
function countUp(node, to, fmt, dur = 1200) {
  if (!booted) {
    const t0 = performance.now();
    const tick = t => {
      const k = Math.min(1, (t - t0) / dur);
      node.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } else {
    node.textContent = fmt(to);
  }
}

/* подсказка */
const tipEl = document.getElementById('tip');
function tipOn(node, html) {
  const show = () => { tipEl.innerHTML = html; tipEl.hidden = false; };
  const hide = () => { tipEl.hidden = true; };
  node.addEventListener('mouseenter', show);
  node.addEventListener('mousemove', e => {
    tipEl.style.left = Math.min(e.clientX + 14, innerWidth - 270) + 'px';
    tipEl.style.top = (e.clientY + 16) + 'px';
  });
  node.addEventListener('mouseleave', hide);
  // с клавиатуры и с тача mouseenter не срабатывает вовсе — подсказка была
  // недоступна без мыши; показываем её и по фокусу, у бара под курсором клавиатуры
  node.addEventListener('focus', () => {
    show();
    if (typeof node.getBoundingClientRect === 'function') {
      const r = node.getBoundingClientRect();
      tipEl.style.left = Math.min(r.left, innerWidth - 270) + 'px';
      tipEl.style.top = (r.bottom + 8) + 'px';
    }
  });
  node.addEventListener('blur', hide);
}

/* ── спарклайн ─────────────────────────────────────────────── */

function sparkline(host, values, color) {
  const w = 160, h = 26;
  const s = svgRoot(host, w, h);
  const max = Math.max(...values), min = Math.min(...values, 0);
  const x = i => (i / (values.length - 1)) * w;
  const y = v => h - ((v - min) / (max - min || 1)) * (h - 3) - 1.5;
  drawLine(el('polyline', {
    points: values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    fill: 'none', stroke: color, 'stroke-width': 1.6,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }, s), 1400);
}

/* ── горизонтальные бары: выручка + маржа ──────────────────── */

function barsRevProfit(host, rows, { onClick = null, activeKey = null, labelW = 104, w = 660 } = {}) {
  // labelW/w настраиваются вызывающим кодом: у названий товаров подписи
  // намного длиннее, чем "Central" или "До 20%", и при стандартных 104px
  // текст залезал прямо под сами бары.
  const rowH = 46, padT = 6, padB = 26, valueW = 132;
  const h = padT + rows.length * rowH + padB;
  const plotW = w - labelW - valueW;
  const s = svgRoot(host, w, h);
  const max = Math.max(...rows.map(r => Math.max(r.sales, Math.abs(r.profit))), 1);
  const sx = v => (v / max) * plotW;

  /* сетка */
  const axis = el('g', { class: 'axis' }, s);
  for (let t = 0; t <= 4; t++) {
    const v = max * t / 4, x = labelW + sx(v);
    el('line', { x1: x, y1: padT, x2: x, y2: h - padB }, axis);
    el('text', { x, y: h - padB + 14, 'text-anchor': 'middle' }, axis).textContent = compact(v);
  }

  rows.forEach((r, i) => {
    const y = padT + i * rowH;
    const attrs = { class: onClick ? 'row-hit' : '' };
    if (onClick) {
      // клавиатура: бар — обычный интерактивный элемент, а не только для мыши
      attrs.tabindex = '0';
      attrs.role = 'button';
      attrs['aria-pressed'] = String(activeKey !== null && r.key === activeKey);
      attrs['aria-label'] = `${r.label}: выручка ${money(r.sales)}, маржа ${money(r.profit)} (${pct(margin(r))})`;
    }
    const g = el('g', attrs, s);
    if (activeKey !== null && r.key !== activeKey) g.setAttribute('class', (g.getAttribute('class') + ' is-dim').trim());

    el('rect', { x: 0, y, width: w, height: rowH, fill: 'transparent' }, g);
    el('text', { x: 0, y: y + 21, class: 'bar-label' }, g).textContent = r.label;

    el('rect', { x: labelW, y: y + 8, width: Math.max(sx(r.sales), 1), height: 16,
                 fill: 'var(--rev-soft)', class: 'bar-rev grow' }, g);
    el('rect', { x: labelW, y: y + 24, width: Math.max(sx(Math.abs(r.profit)), 1), height: 10,
                 fill: r.profit < 0 ? 'var(--accent)' : 'var(--prof)', class: 'grow' }, g);

    const vx = labelW + plotW + 12;
    el('text', { x: vx, y: y + 20, class: 'bar-value' }, g).textContent = money(r.sales);
    const m = el('text', { x: vx, y: y + 34, class: 'bar-value' }, g);
    m.textContent = pct(margin(r)) + ' маржи';
    if (r.profit < 0) m.setAttribute('style', 'fill:var(--accent)');

    tipOn(g, r.tipHtml || (`<b>${r.label}</b><br>Выручка ${money(r.sales)}<br>Маржа ${money(r.profit)}` +
             `<br>Маржинальность ${pct(margin(r))}` +
             (r.dSales !== undefined ? `<br>Выручка г/г ${signed(r.dSales)}` : '') +
             (r.dMargin !== undefined ? `<br>Маржинальность г/г ${pp(r.dMargin)}` : '')));
    if (onClick) {
      g.addEventListener('click', () => onClick(r.key));
      g.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(r.key); }
      });
    }
  });
  animateIn(s);
}

/* ── контраст текст/заливка (WCAG relative luminance) ─────────
   Раньше цвет подписи внутри сегмента выбирался по правилу
   `i < 2 ? white : ink` — по порядковому номеру сегмента, а не по тому,
   что там реально нарисовано. Работало только пока палитра случайно была
   отсортирована от тёмного к светлому; при любой другой палитре тёмный
   текст попадал на тёмный сегмент. Считаем контраст по факту. */
function hexToRgb(h) { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function relLuminance(hex) { const [r, g, b] = hexToRgb(hex).map(srgbToLin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function contrastRatio(a, b) { let l1 = relLuminance(a), l2 = relLuminance(b); if (l1 < l2) [l1, l2] = [l2, l1]; return (l1 + 0.05) / (l2 + 0.05); }
function pickTextColor(bgHex) { return contrastRatio(bgHex, '#0e0f10') >= contrastRatio(bgHex, '#ffffff') ? '#0e0f10' : '#ffffff'; }

/* ── две 100%-полосы долей ─────────────────────────────────── */

const REGION_TINTS = ['#0f3a2f', '#1f5747', '#3a7561', '#5c9280'];

function shareBars(host, keys, byKey, colorOf, labelOf) {
  const w = 420, barH = 34, gap = 42, padL = 78;
  // Строка "позиции с убытком не включены" появляется под баром, если у него
  // есть отрицательные значения (нередкое дело для маржи по скидкам, в
  // отличие от регионов) — раньше эта заметка всегда рисовалась внахлёст с
  // легендой, потому что высота SVG не резервировала под неё место.
  const anyNeg = ['sales', 'profit'].some(field => keys.some(k => ((byKey.get(k) || empty())[field]) < 0));
  const h = 2 * barH + gap + 30 + (anyNeg ? 20 : 0);
  const s = svgRoot(host, w, h);
  const plotW = w - padL - 8;

  [['Выручка', 'sales'], ['Маржа', 'profit']].forEach(([title, field], bi) => {
    const y = bi * (barH + gap) + 8;
    const vals = keys.map(k => (byKey.get(k) || empty())[field]);
    const neg = vals.some(v => v < 0);
    const sum = vals.reduce((a, v) => a + Math.max(v, 0), 0) || 1;

    el('text', { x: 0, y: y + barH / 2 + 4, class: 'bar-label' }, s).textContent = title;

    let x = padL;
    keys.forEach((k, i) => {
      const v = Math.max(vals[i], 0);
      const wd = (v / sum) * plotW;
      if (wd <= 0) return;
      const g = el('g', {}, s);
      const fill = colorOf(i);
      el('rect', { x, y, width: Math.max(wd - 1, 1), height: barH, fill, class: 'grow' }, g);
      if (wd > 46) {
        // style, не fill: атрибут fill проигрывает правилу .bar-value{fill:...}
        // из app.css (класс всегда бьёт presentation-атрибут) — подписи были
        // невидимы на тёмных сегментах вне зависимости от pickTextColor()
        el('text', { x: x + wd / 2, y: y + barH / 2 + 4, 'text-anchor': 'middle',
                     style: 'fill:' + pickTextColor(fill), class: 'bar-value' }, g)
          .textContent = nf0.format(100 * v / sum) + '%';
      }
      tipOn(g, `<b>${labelOf(k)}</b><br>${title} ${money(vals[i])}<br>` +
               `доля ${pct(100 * v / sum)}`);
      x += wd;
    });

    if (neg) {
      el('text', { x: padL, y: y + barH + 15, class: 'bar-value', style: 'fill:var(--accent)' }, s)
        .textContent = 'позиции с убытком в долю не включены';
    }
  });

  const lg = el('g', {}, s);
  let lx = padL;
  keys.forEach((k, i) => {
    el('rect', { x: lx, y: h - 12, width: 9, height: 9, fill: colorOf(i) }, lg);
    const label = labelOf(k);
    const t = el('text', { x: lx + 13, y: h - 4, class: 'bar-value' }, lg);
    t.textContent = label;
    lx += 20 + label.length * 6.2;
  });
  animateIn(s);
}

/* ── линии: текущий период vs прошлый ──────────────────────── */

function lineChart(host, series, labels, { curLabel, priLabel, fmt = money }) {
  const w = 900, h = 280, padL = 62, padR = 16, padT = 14, padB = 34;
  const s = svgRoot(host, w, h);
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const all = [...series.cur, ...series.pri];
  const max = Math.max(...all, 0), min = Math.min(...all, 0);
  const x = i => padL + (i / (labels.length - 1)) * plotW;
  const y = v => padT + plotH - ((v - min) / (max - min || 1)) * plotH;

  const axis = el('g', { class: 'axis' }, s);
  for (let t = 0; t <= 4; t++) {
    const v = min + (max - min) * t / 4, yy = y(v);
    el('line', { x1: padL, y1: yy, x2: w - padR, y2: yy }, axis);
    el('text', { x: padL - 10, y: yy + 3.5, 'text-anchor': 'end' }, axis).textContent = compact(v);
  }
  if (min < 0) el('line', { x1: padL, y1: y(0), x2: w - padR, y2: y(0), stroke: 'var(--ink-3)' }, s);
  labels.forEach((lb, i) => {
    el('text', { x: x(i), y: h - 12, 'text-anchor': 'middle' }, axis).textContent = lb;
  });

  const draw = (vals, color, width, dash) => el('polyline', {
    points: vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
    fill: 'none', stroke: color, 'stroke-width': width,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    ...(dash ? { 'stroke-dasharray': dash } : {}),
  }, s);
  const lineP = draw(series.pri, 'var(--prior)', 1.8, null);
  const lineC = draw(series.cur, 'var(--rev)', 2.6, null);
  drawLine(lineP, 1700); drawLine(lineC, 1700);

  series.cur.forEach((v, i) => {
    el('circle', { cx: x(i), cy: y(v), r: 3.6, fill: 'var(--rev)', class: 'pop' }, s);
    const hit = el('rect', { x: x(i) - plotW / labels.length / 2, y: padT,
                             width: plotW / labels.length, height: plotH, fill: 'transparent' }, s);
    const d = series.pri[i] ? 100 * (v / series.pri[i] - 1) : null;
    tipOn(hit, `<b>${labels[i]}</b><br>${curLabel}: ${fmt(v)}<br>${priLabel}: ${fmt(series.pri[i])}` +
               (d === null ? '' : `<br>г/г ${signed(d)}`));
  });

  const lg = el('g', { class: 'axis' }, s);
  el('line', { x1: padL, y1: padT - 4, x2: padL + 16, y2: padT - 4, stroke: 'var(--rev)', 'stroke-width': 2.2 }, lg);
  el('text', { x: padL + 22, y: padT - 1 }, lg).textContent = curLabel;
  el('line', { x1: padL + 78, y1: padT - 4, x2: padL + 94, y2: padT - 4, stroke: 'var(--prior)',
               'stroke-width': 1.6, 'stroke-dasharray': '4 3' }, lg);
  el('text', { x: padL + 100, y: padT - 1 }, lg).textContent = priLabel;
  animateIn(s);
}

/* ── квадрант: рост выручки × сдвиг маржинальности ─────────── */

function quadrant(host, points) {
  const w = 900, h = 320, pad = 56;
  const s = svgRoot(host, w, h);
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const xMax = Math.max(4, ...xs.map(Math.abs)) * 1.25;
  const yMax = Math.max(2, ...ys.map(Math.abs)) * 1.3;
  const X = v => pad + ((v + xMax) / (2 * xMax)) * (w - pad * 2);
  const Y = v => h - pad - ((v + yMax) / (2 * yMax)) * (h - pad * 2);

  const axis = el('g', { class: 'axis' }, s);
  el('rect', { x: X(0), y: Y(0), width: w - pad - X(0), height: h - pad - Y(0),
               fill: 'var(--accent)', opacity: .12 }, s);
  el('text', { x: w - pad - 8, y: h - pad - 10, 'text-anchor': 'end', class: 'axis',
               fill: 'var(--accent)', 'font-size': 10.5 }, s)
    .textContent = 'рост, оплаченный маржой';
  el('line', { x1: pad, y1: Y(0), x2: w - pad, y2: Y(0), stroke: 'var(--ink-3)' }, axis);
  el('line', { x1: X(0), y1: pad, x2: X(0), y2: h - pad, stroke: 'var(--ink-3)' }, axis);
  el('text', { x: w - pad, y: Y(0) - 8, 'text-anchor': 'end' }, axis).textContent = 'выручка, % г/г →';
  el('text', { x: X(0) + 8, y: pad - 4 }, axis).textContent = '↑ маржинальность, п.п. г/г';

  points.forEach(p => {
    const g = el('g', {}, s);
    const bad = p.x > 0 && p.y < 0;
    el('circle', { cx: X(p.x), cy: Y(p.y), r: Math.max(5, Math.sqrt(p.size) / 26),
                   fill: bad ? 'var(--accent)' : 'var(--rev)', opacity: .85, class: 'pop' }, g);
    el('text', { x: X(p.x), y: Y(p.y) - 13, 'text-anchor': 'middle', class: 'bar-label' }, g)
      .textContent = p.label;
    tipOn(g, `<b>${p.label}</b><br>Выручка г/г ${signed(p.x)}<br>Маржинальность ${pp(p.y)}` +
             `<br>Объём ${money(p.size)}`);
  });
  animateIn(s);
}

/* ── сигналы ───────────────────────────────────────────────── */

function computeSignals(P) {
  const out = [];
  const cur = total({ months: P.cur }), pri = total({ months: P.pri });

  /* 1. где скидка перестаёт окупаться */
  const byDisc = scan({ months: P.cur, groupBy: COL.disc, ignore: ['disc'] });
  const names = D.meta.dims.discounts;
  const over = byDisc.get(names.indexOf('over20'));
  const upto = byDisc.get(names.indexOf('upto20'));
  const none = byDisc.get(names.indexOf('none'));
  if (over && over.profit < 0) {
    out.push({
      impact: Math.abs(over.profit), warn: true, figure: pct(margin(over)),
      title: 'Скидка выше 20% работает в убыток',
      body: `Без скидки маржинальность <b>${pct(margin(none))}</b>, до 20% — <b>${pct(margin(upto))}</b>, ` +
            `выше 20% — <b>${pct(margin(over))}</b>. На этих сделках выручка <b>${money(over.sales)}</b> ` +
            `и убыток <b>${money(over.profit)}</b>: без них прибыль периода была бы на ` +
            `<b>${nf0.format(100 * Math.abs(over.profit) / Math.max(cur.profit, 1))}%</b> выше.`,
    });
  }

  /* 2. рост выручки при падении маржинальности */
  const rc = scan({ months: P.cur, groupBy: COL.region, ignore: ['region'] });
  const rp = scan({ months: P.pri, groupBy: COL.region, ignore: ['region'] });
  rc.forEach((c, k) => {
    const p = rp.get(k); if (!p) return;
    const dS = 100 * (c.sales / p.sales - 1), dM = margin(c) - margin(p);
    if (dM <= -2.5) {
      out.push({
        impact: Math.abs(dM) / 100 * c.sales, warn: dS > 0, figure: pp(dM),
        title: `${D.meta.dims.regions[k]}: ${dS > 0 ? 'рост без прибыли' : 'маржа просела'}`,
        body: `Выручка <b>${signed(dS)}</b>, маржинальность <b>${pp(dM)}</b> ` +
              `(${pct(margin(p))} → ${pct(margin(c))}). При марже прошлого года период принёс бы ` +
              `на <b>${money(Math.abs(dM) / 100 * c.sales)}</b> больше прибыли.`,
      });
    }
  });

  /* 3. убыточные подкатегории */
  const sub = scan({ months: P.cur, groupBy: r => D.products[r[COL.product]].subcategory, ignore: ['subcategory'] });
  const losers = [...sub.entries()].filter(([, a]) => a.profit < 0).sort((a, b) => a[1].profit - b[1].profit);
  if (losers.length) {
    const lost = losers.reduce((s, [, a]) => s + a.profit, 0);
    out.push({
      impact: Math.abs(lost), warn: true, figure: money(lost),
      title: `Убыточных подкатегорий: ${losers.length} из ${sub.size}`,
      body: `Суммарный убыток <b>${money(lost)}</b>. Худшая — ${losers[0][0]}: выручка ` +
            `<b>${money(losers[0][1].sales)}</b> при марже <b>${money(losers[0][1].profit)}</b> ` +
            `(${pct(margin(losers[0][1]))}).`,
    });
  }

  /* 4. замолчавшие клиенты — одна функция с блоком «Клиенты», чтобы номера
     в сигналах и в самом блоке не могли разойтись между собой */
  const seg4 = customerSegments(P);
  if (seg4.churned) {
    out.push({
      impact: Math.abs(seg4.churnMargin), warn: true, figure: String(seg4.churned),
      title: `Перестали покупать: ${seg4.churned} клиентов`,
      body: `В прошлом периоде они дали <b>${money(seg4.churnMargin)}</b> маржи. ` +
            `Новых клиентов за период — <b>${seg4.fresh}</b>, активных всего <b>${seg4.active}</b>.`,
    });
  }

  /* 5. общий сдвиг маржинальности */
  const dM = margin(cur) - margin(pri);
  out.push({
    impact: Math.abs(dM) / 100 * cur.sales, warn: dM < 0, figure: pp(dM),
    title: dM < 0 ? 'Выручка растёт быстрее прибыли' : 'Прибыль растёт быстрее выручки',
    body: `Выручка <b>${signed(100 * (cur.sales / pri.sales - 1))}</b>, ` +
          `прибыль <b>${signed(100 * (cur.profit / pri.profit - 1))}</b>, ` +
          `маржинальность <b>${pp(dM)}</b> (${pct(margin(pri))} → ${pct(margin(cur))}).`,
  });

  return out.sort((a, b) => b.impact - a.impact);
}

/* ── отрисовка ─────────────────────────────────────────────── */

function renderKpis(P) {
  const cur = total({ months: P.cur }), pri = total({ months: P.pri });
  const curOrders = countOrders({ months: P.cur }), priOrders = countOrders({ months: P.pri });
  const monthly = scan({ months: P.cur, groupBy: COL.month });
  const spark = P.curMonths.map(m => (monthly.get(D.meta.dims.months.indexOf(m)) || empty()).sales);

  const cards = [
    { label: `Выручка · ${P.curLabel}`, raw: cur.sales, fmt: money, lead: true, spark: true,
      d: 100 * (cur.sales / pri.sales - 1), prior: money(pri.sales) },
    { label: 'Маржа', raw: cur.profit, fmt: money,
      d: 100 * (cur.profit / pri.profit - 1), prior: money(pri.profit) },
    { label: 'Маржинальность', raw: margin(cur), fmt: pct,
      dpp: margin(cur) - margin(pri), prior: pct(margin(pri)) },
    { label: 'Заказов', raw: curOrders, fmt: v => nf0.format(Math.round(v)),
      d: 100 * (curOrders / priOrders - 1), prior: nf0.format(priOrders) },
  ];

  const host = document.getElementById('hero');
  host.innerHTML = '';
  cards.forEach(c => {
    const v = c.dpp !== undefined ? c.dpp : c.d;
    const div = document.createElement('div');
    div.className = 'kpi' + (c.lead ? ' kpi--lead' : '');
    div.innerHTML =
      `<div class="kpi__label">${c.label}</div>` +
      `<div class="kpi__value">—</div>` +
      (c.spark ? '<div class="kpi__spark"></div>' : '') +
      `<div class="kpi__delta ${v >= 0 ? 'up' : 'down'}">` +
        `<span>${v >= 0 ? '▲' : '▼'} ${c.dpp !== undefined ? pp(v) : signed(v)} к ${P.priLabel}</span>` +
        `<span class="kpi__prior">было ${c.prior}</span>` +
      `</div>`;
    host.appendChild(div);
    countUp(div.querySelector('.kpi__value'), c.raw, c.fmt);
    if (c.spark) sparkline(div.querySelector('.kpi__spark'), spark, '#6fc0a7');
  });
}

function renderLead(P, sigs) {
  const top = sigs[0];
  const host = document.getElementById('lead');
  host.className = 'lead' + (top.warn ? '' : ' lead--positive');
  host.innerHTML =
    `<div class="lead__figure">${top.figure}</div>` +
    `<div><div class="lead__tag">Главное за период</div>` +
    `<div class="lead__title">${top.title}</div>` +
    `<div class="lead__body">${top.body}</div></div>`;
}

function renderTicker(P, sigs) {
  const cur = total({ months: P.cur }), pri = total({ months: P.pri });
  const dS = 100 * (cur.sales / pri.sales - 1), dM = margin(cur) - margin(pri);
  const items = [
    `Выручка ${P.curLabel} <b>${money(cur.sales)}</b> ${signed(dS)}`,
    `Маржа <b>${money(cur.profit)}</b>`,
    `Маржинальность <b>${pct(margin(cur))}</b> <span class="hot">${pp(dM)}</span>`,
    `Заказов <b>${nf0.format(countOrders({ months: P.cur }))}</b>`,
    ...sigs.slice(0, 3).map(x => `<span class="hot">${x.figure}</span> ${x.title}`),
  ];
  const html = items.map(t => `<span class="ticker__item">${t} ·</span>`).join('');
  document.getElementById('ticker-track').innerHTML = html + html;
}

function renderSignals(P, sigs) {
  const all = (sigs || computeSignals(P)).slice(1);
  const show = state.showAllSignals ? all : all.slice(0, 3);
  const host = document.getElementById('signals');
  host.innerHTML = '';
  show.forEach(s => {
    const li = document.createElement('li');
    if (s.warn) li.className = 'sig--warn';
    li.innerHTML = `<div class="sig__title">${s.title}</div><div class="sig__body">${s.body}</div>`;
    host.appendChild(li);
  });
  const btn = document.getElementById('signals-more');
  btn.hidden = all.length <= 3;
  btn.textContent = state.showAllSignals ? 'Свернуть' : `Показать все сигналы (${all.length})`;
}

function renderGeo(P) {
  const rc = scan({ months: P.cur, groupBy: COL.region, ignore: ['region'] });
  const rp = scan({ months: P.pri, groupBy: COL.region, ignore: ['region'] });
  const keys = [...rc.keys()].sort((a, b) => rc.get(b).sales - rc.get(a).sales);

  barsRevProfit(document.getElementById('chart-region-bars'),
    keys.map(k => {
      const c = rc.get(k), p = rp.get(k) || empty();
      return { key: k, label: D.meta.dims.regions[k], sales: c.sales, profit: c.profit,
               dSales: p.sales ? 100 * (c.sales / p.sales - 1) : undefined,
               dMargin: p.sales ? margin(c) - margin(p) : undefined };
    }),
    { onClick: k => { state.region = state.region === k ? null : k; render(); },
      activeKey: state.region });

  shareBars(document.getElementById('chart-region-share'), keys, rc, i => REGION_TINTS[i % 4],
    k => D.meta.dims.regions[k]);

  const ix = m => D.meta.dims.months.indexOf(m);
  const mc = scan({ months: P.cur, groupBy: COL.month });
  const mp = scan({ months: P.pri, groupBy: COL.month });
  const f = state.metric;
  const curVals = D.meta.periods[state.period].current.map(m => (mc.get(ix(m)) || empty())[f]);
  const priVals = D.meta.periods[state.period].prior.map(m => (mp.get(ix(m)) || empty())[f]);
  const labels = D.meta.periods[state.period].current.map(m => MONTHS_RU[+m.slice(5) - 1]);

  lineChart(document.getElementById('chart-monthly'),
    { cur: curVals, pri: priVals }, labels,
    { curLabel: P.curLabel, priLabel: P.priLabel });

  const cov = D.meta.periods.coverage[P.curLabel];
  document.getElementById('monthly-note').textContent =
    `серая пунктирная — ${P.priLabel}, сплошная — ${P.curLabel}` +
    (cov && cov.days_missing_at_tail
      ? ` · в данных ${P.curLabel} не хватает последних ${cov.days_missing_at_tail} дн. (последний заказ ${cov.last_order}), последний месяц из-за этого слегка занижен`
      : '');

  quadrant(document.getElementById('chart-quadrant'),
    keys.map(k => {
      const c = rc.get(k), p = rp.get(k) || empty();
      return { label: D.meta.dims.regions[k], size: c.sales,
               x: p.sales ? 100 * (c.sales / p.sales - 1) : 0,
               y: p.sales ? margin(c) - margin(p) : 0 };
    }));
}

/* ── 03 · скидки ───────────────────────────────────────────── */

const DISC_TINTS = ['#1f5747', '#7a5c1c', '#a83a22']; // none / upto20 / over20 — от спокойного к тревожному

function renderDiscounts(P) {
  const dc = scan({ months: P.cur, groupBy: COL.disc, ignore: ['disc'] });
  const order = ['none', 'upto20', 'over20'].map(name => D.meta.dims.discounts.indexOf(name)).filter(i => i >= 0);

  barsRevProfit(document.getElementById('chart-disc-bars'),
    order.filter(k => dc.has(k)).map(k => {
      const c = dc.get(k);
      return { key: k, label: DISC_LABELS[D.meta.dims.discounts[k]], sales: c.sales, profit: c.profit };
    }),
    { onClick: k => { state.disc = state.disc === k ? null : k; render(); }, activeKey: state.disc });

  shareBars(document.getElementById('chart-disc-share'), order.filter(k => dc.has(k)), dc,
    i => DISC_TINTS[i % DISC_TINTS.length],
    k => DISC_LABELS[D.meta.dims.discounts[k]]);

  const overIx = D.meta.dims.discounts.indexOf('over20');
  const over = dc.get(overIx);
  const note = document.getElementById('disc-callout');
  if (over && over.sales > 0) {
    const m = margin(over);
    note.hidden = false;
    note.innerHTML = m < 0
      ? `На скидках свыше 20% в ${P.curLabel} потеряно <b>${money(Math.abs(over.profit))}</b> прибыли ` +
        `при выручке <b>${money(over.sales)}</b> (маржинальность <b>${pct(m)}</b>).`
      : `Скидки свыше 20% в ${P.curLabel} пока в плюсе: маржинальность <b>${pct(m)}</b> ` +
        `при выручке <b>${money(over.sales)}</b>.`;
  } else {
    note.hidden = true;
  }
}

/* ── 04 · каналы ───────────────────────────────────────────── */

function renderChannels(P) {
  const sc = scan({ months: P.cur, groupBy: COL.segment, ignore: ['segment'] });
  const sp = scan({ months: P.pri, groupBy: COL.segment, ignore: ['segment'] });
  const keys = [...sc.keys()].sort((a, b) => sc.get(b).sales - sc.get(a).sales);

  barsRevProfit(document.getElementById('chart-channel-bars'),
    keys.map(k => {
      const c = sc.get(k), p = sp.get(k) || empty();
      return { key: k, label: D.meta.dims.segments[k], sales: c.sales, profit: c.profit,
               dSales: p.sales ? 100 * (c.sales / p.sales - 1) : undefined,
               dMargin: p.sales ? margin(c) - margin(p) : undefined };
    }),
    { onClick: k => { state.segment = state.segment === k ? null : k; render(); }, activeKey: state.segment });

  shareBars(document.getElementById('chart-channel-share'), keys, sc,
    i => REGION_TINTS[i % REGION_TINTS.length], k => D.meta.dims.segments[k]);
}

/* ── 05 · товары ───────────────────────────────────────────── */

function renderSku(P) {
  const pills = document.getElementById('sku-cats');
  if (!pills.dataset.built) {
    pills.dataset.built = '1';
    D.meta.dims.categories.forEach(cat => {
      const b = document.createElement('button');
      b.className = 'chip'; b.textContent = cat;
      b.onclick = () => { state.skuCategory = state.skuCategory === cat ? null : cat; render(); };
      pills.appendChild(b);
    });
  }
  pills.querySelectorAll('.chip').forEach(b => b.classList.toggle('is-on', b.textContent === state.skuCategory));

  const backBtn = document.getElementById('sku-back');
  const subHead = document.getElementById('sku-sub-title');

  if (state.subcategory === null) {
    backBtn.hidden = true;
    subHead.textContent = state.skuCategory ? `Подкатегории · ${state.skuCategory}` : 'Все подкатегории';

    const bySub = scan({
      months: P.cur, ignore: ['subcategory'],
      groupBy: r => {
        const p = D.products[r[COL.product]];
        if (state.skuCategory && p.category !== state.skuCategory) return null;
        return p.subcategory;
      },
    });
    const rows = [...bySub.entries()]
      .sort((a, b) => margin(a[1]) - margin(b[1]))
      .map(([name, a]) => ({
        key: D.meta.dims.subcategories.indexOf(name), label: name, sales: a.sales, profit: a.profit,
        pattern: (subcatByName.get(name) || {}).pattern,
      }));

    barsRevProfit(document.getElementById('chart-sku'), rows,
      { onClick: k => { state.subcategory = state.subcategory === k ? null : k; render(); },
        activeKey: state.subcategory });
  } else {
    backBtn.hidden = false;
    const subName = D.meta.dims.subcategories[state.subcategory];
    subHead.textContent = `Товары · ${subName}`;

    const byProd = scan({ months: P.cur, groupBy: COL.product });
    const rows = [...byProd.entries()]
      .map(([pi, a]) => ({ pi, name: D.products[pi].name, priceGroup: D.products[pi].price_group,
                            pattern: D.products[pi].pattern, sales: a.sales, profit: a.profit }))
      .filter(r => r.sales > 0);
    rows.sort((a, b) => margin(a) - margin(b));
    const worst = rows.slice(0, 5);
    const best = rows.slice(-5).reverse();
    const picked = [...worst, ...best.filter(r => !worst.includes(r))];

    barsRevProfit(document.getElementById('chart-sku'),
      picked.map(r => ({
        key: r.pi, label: r.name.length > 34 ? r.name.slice(0, 34) + '…' : r.name,
        sales: r.sales, profit: r.profit,
        tipHtml: `<b>${r.name}</b><br>Выручка ${money(r.sales)}<br>Маржа ${money(r.profit)} (${pct(margin(r))})` +
                 `<br>Цена: ${PRICE_GROUP_LABELS[r.priceGroup] || r.priceGroup}` +
                 `<br>Спрос: ${PATTERN_LABELS[r.pattern] || r.pattern}`,
      })),
      // названия товаров в разы длиннее, чем "Central" или "До 20%" —
      // стандартных 104px не хватало, текст лез прямо под бары
      { labelW: 260, w: 720 });
  }

  document.getElementById('sku-note').textContent =
    `Классификация спроса ADI×CV² показана на уровне подкатегорий. На уровне товара она статистически ` +
    `пустая: медианный интервал между продажами — ${medianProductAdi.toFixed(1)} мес., типичный товар ` +
    `продаётся раз в ${Math.round(medianProductAdi)} с лишним месяцев, поэтому на карточке товара это ` +
    `только подсказка, а не диагноз.`;
}

/* ── 06 · клиенты ──────────────────────────────────────────── */

/**
 * Первый месяц каждого клиента ВООБЩЕ в истории (по всем годам витрины, с
 * учётом активных фильтров региона/канала/скидки/подкатегории — "новый"
 * значит новый именно в этом срезе). Месяцы закодированы строками "YYYY-MM"
 * и в справочнике отсортированы лексикографически, поэтому сравнение самих
 * строк корректно отражает хронологию.
 */
function firstMonthByCustomer() {
  const reg = state.region, seg = state.segment, disc = state.disc, sub = state.subcategory;
  const first = new Map();
  for (const row of D.facts) {
    if (reg !== null && row[COL.region] !== reg) continue;
    if (seg !== null && row[COL.segment] !== seg) continue;
    if (disc !== null && row[COL.disc] !== disc) continue;
    if (sub !== null && productSubIx[row[COL.product]] !== sub) continue;
    const c = row[COL.customer], mIx = row[COL.month], m = D.meta.dims.months[mIx];
    const cur = first.get(c);
    if (cur === undefined || m < cur) first.set(c, m);
  }
  return first;
}

function customerSegments(P) {
  const cc = scan({ months: P.cur, groupBy: COL.customer });
  const cp = scan({ months: P.pri, groupBy: COL.customer });
  let churned = 0, churnMargin = 0;
  cp.forEach((a, k) => { if (!cc.has(k)) { churned++; churnMargin += a.profit; } });

  // "новый" — первая покупка ВООБЩЕ (по всей истории витрины) пришлась на
  // текущий период, а не просто "не покупал в прошлом периоде": иначе
  // клиент, купивший в 2014-м и вернувшийся сейчас после паузы, тоже
  // считался бы "новым", хотя это win-back, а не новый логотип.
  const first = firstMonthByCustomer();
  let fresh = 0;
  cc.forEach((a, k) => { if (P.cur.has(D.meta.dims.months.indexOf(first.get(k)))) fresh++; });

  const margins = [...cc.values()].map(a => a.profit).sort((a, b) => b - a);
  const totalMargin = margins.reduce((s, v) => s + v, 0);
  const top10Margin = margins.slice(0, 10).reduce((s, v) => s + v, 0);
  return {
    active: cc.size, fresh, churned, churnMargin,
    top10Share: totalMargin ? 100 * top10Margin / totalMargin : 0,
    cc,
  };
}

function renderCustomers(P) {
  const seg = customerSegments(P);

  const statHost = document.getElementById('customer-stats');
  statHost.innerHTML = '';
  [
    { label: `Активны · ${P.curLabel}`, raw: seg.active, fmt: v => nf0.format(Math.round(v)),
      note: `новых за период — ${seg.fresh}` },
    { label: 'Перестали покупать', raw: seg.churned, fmt: v => nf0.format(Math.round(v)),
      note: `маржа ${P.priLabel} года — ${money(seg.churnMargin)}`, warn: seg.churned > 0 },
    { label: 'Топ-10 клиентов', raw: seg.top10Share, fmt: pct, lead: true,
      note: `их доля в марже ${P.curLabel}` },
  ].forEach(c => {
    const div = document.createElement('div');
    div.className = 'kpi' + (c.lead ? ' kpi--lead' : '');
    div.innerHTML =
      `<div class="kpi__label">${c.label}</div>` +
      `<div class="kpi__value">—</div>` +
      `<div class="kpi__delta${c.warn ? ' down' : ''}"><span class="kpi__prior">${c.note}</span></div>`;
    statHost.appendChild(div);
    countUp(div.querySelector('.kpi__value'), c.raw, c.fmt);
  });

  const rows = [...seg.cc.entries()]
    .map(([k, a]) => ({ key: k, name: D.customers[k].name, sales: a.sales, profit: a.profit }))
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 12);

  const listHost = document.getElementById('customer-list');
  listHost.innerHTML = '';
  rows.forEach(r => {
    const li = document.createElement('li');
    li.className = 'custrow' + (state.selectedCustomer === r.key ? ' is-on' : '');
    li.tabIndex = 0;
    li.innerHTML = `<span class="custrow__name">${r.name}</span>` +
      `<span class="custrow__val">${money(r.sales)}</span>` +
      `<span class="custrow__val">${money(r.profit)}</span>`;
    const pick = () => { state.selectedCustomer = state.selectedCustomer === r.key ? null : r.key; render(); };
    li.onclick = pick;
    li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    listHost.appendChild(li);
  });

  renderCustomerDetail(P);
}

function renderCustomerDetail(P) {
  const host = document.getElementById('customer-detail');
  if (state.selectedCustomer === null) { host.hidden = true; return; }
  host.hidden = false;
  const k = state.selectedCustomer;
  const cust = D.customers[k];

  const allMonths = [...D.meta.dims.months.keys()];
  const byMonth = scan({ groupBy: r => (r[COL.customer] === k ? r[COL.month] : null) });
  const series = allMonths.map(mi => (byMonth.get(mi) || empty()).sales);

  const byProduct = scan({ groupBy: r => (r[COL.customer] === k ? r[COL.product] : null) });
  const top = [...byProduct.entries()].sort((a, b) => b[1].sales - a[1].sales).slice(0, 3);

  host.innerHTML =
    `<button class="detail-close" id="customer-detail-close" aria-label="Закрыть">✕</button>` +
    `<h3>${cust.name}</h3>` +
    `<p class="note">вся история по данным витрины</p>` +
    `<div class="chart" id="customer-spark"></div>` +
    `<p class="note">чаще всего покупает: ${top.map(([pi]) => D.products[pi].name).join(' · ') || '—'}</p>`;
  sparkline(document.getElementById('customer-spark'), series.map(v => Math.max(v, 0)), 'var(--rev)');
  document.getElementById('customer-detail-close').onclick = () => { state.selectedCustomer = null; render(); };
}

/* Сводка среза — показывает ВСЕ активные фильтры (не только регион), потому
   что клик по каналу/скидке/подкатегории в своих блоках теперь тоже
   фильтрует всю страницу через тот же scan(), что и регион. */
function renderScope() {
  const host = document.getElementById('scope-geo');
  const parts = [];
  if (state.region !== null) parts.push(['Регион', D.meta.dims.regions[state.region], () => { state.region = null; render(); }]);
  if (state.segment !== null) parts.push(['Канал', D.meta.dims.segments[state.segment], () => { state.segment = null; render(); }]);
  if (state.disc !== null) parts.push(['Скидка', DISC_LABELS[D.meta.dims.discounts[state.disc]] || D.meta.dims.discounts[state.disc], () => { state.disc = null; render(); }]);
  if (state.subcategory !== null) parts.push(['Подкатегория', D.meta.dims.subcategories[state.subcategory], () => { state.subcategory = null; render(); }]);

  if (!parts.length) {
    host.innerHTML = 'Срез: <b>все данные</b>';
  } else {
    host.innerHTML = 'Срез: ' + parts.map(([label, val], i) =>
      `<b>${label}: ${val}</b><button data-i="${i}" class="scope-x">✕</button>`).join('  ·  ') +
      (parts.length > 1 ? '<button id="scope-reset">сбросить всё</button>' : '');
    host.querySelectorAll('.scope-x').forEach(b => { b.onclick = parts[+b.dataset.i][2]; });
    const btn = document.getElementById('scope-reset');
    if (btn) btn.onclick = () => {
      state.region = state.segment = state.disc = state.subcategory = null;
      render();
    };
  }

  document.querySelectorAll('#region-chips .chip').forEach(c => {
    c.classList.toggle('is-on', +c.dataset.region === state.region);
  });
}

function observeReveal() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.reveal, .hero').forEach(n => n.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
  }, { threshold: .1, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal, .hero').forEach(n => io.observe(n));
}

function render() {
  const P = periods();
  const sigs = computeSignals(P); // once per render — renderLead/Ticker/Signals all read the same list
  renderScope();
  renderTicker(P, sigs);
  renderLead(P, sigs);
  renderKpis(P);
  renderSignals(P, sigs);
  renderGeo(P);
  renderDiscounts(P);
  renderChannels(P);
  renderSku(P);
  renderCustomers(P);
}

/* ── запуск ────────────────────────────────────────────────── */

async function boot() {
  const [meta, products, subcats, customers, facts, orders] = await Promise.all(
    ['meta', 'products', 'subcategories', 'customers', 'facts', 'orders']
      .map(n => fetch(`data/${n}.json`, { cache: 'no-cache' }).then(r => {
        if (!r.ok) throw new Error(`data/${n}.json — ${r.status}`);
        return r.json();
      })));

  D = { meta, products, subcats, customers, facts: facts.rows, orders: orders.rows };
  indexData();

  document.getElementById('dateline').style.whiteSpace = 'pre-line';
  document.getElementById('dateline').textContent =
    `${nf0.format(D.facts.length)} строк витрины\n${meta.dims.regions.length} региона · ` +
    `${nf0.format(meta.checks.products_mart)} товаров · ${nf0.format(meta.checks.customers_mart)} клиентов\n` +
    `${meta.periods.data_range[0]} — ${meta.periods.data_range[1]}`;

  document.getElementById('colophon-checks').textContent =
    `Сверка при сборке: выручка ${money(meta.checks.sales_mart)}, ` +
    `расхождение с исходником ${meta.checks.sales_drift_ppm} ppm (округление до центов); ` +
    `товаров ${meta.checks.products_mart}, клиентов ${meta.checks.customers_mart}; ` +
    `удалённых дубликатов ${meta.cleaning.duplicates_dropped}.`;

  const chips = document.getElementById('region-chips');
  meta.dims.regions.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.textContent = name; b.dataset.region = i;
    b.onclick = () => { state.region = state.region === i ? null : i; render(); };
    chips.appendChild(b);
  });

  document.querySelectorAll('#period-switch button').forEach(b => {
    b.onclick = () => {
      state.period = b.dataset.period;
      document.querySelectorAll('#period-switch button').forEach(x => x.classList.toggle('is-on', x === b));
      render();
    };
  });
  document.querySelectorAll('#metric-switch button').forEach(b => {
    b.onclick = () => {
      state.metric = b.dataset.metric;
      document.querySelectorAll('#metric-switch button').forEach(x => x.classList.toggle('is-on', x === b));
      render();
    };
  });
  document.getElementById('signals-more').onclick = () => {
    state.showAllSignals = !state.showAllSignals;
    renderSignals(periods());
  };

  document.getElementById('loading').remove();
  document.getElementById('main').hidden = false;
  render();
  booted = true;
  observeReveal();
}

boot().catch(e => {
  document.getElementById('loading').innerHTML =
    `не удалось загрузить витрину: ${e.message}<br><br>` +
    `страницу нужно открывать через локальный сервер, а не двойным кликом по файлу:<br>` +
    `<code>python3 -m http.server</code> в папке public, затем localhost:8000`;
});
