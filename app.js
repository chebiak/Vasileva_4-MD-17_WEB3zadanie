(function () {
  "use strict";

  var CFG = window.DASHBOARD_CONFIG;
  var CG = "https://api.coingecko.com/api/v3";

  /* ---------- утилиты ---------- */

  function $(sel, root) { return (root || document).querySelector(sel); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function nf(opts) { return new Intl.NumberFormat("ru-RU", opts); }
  function dir(v) { return v > 0 ? "up" : v < 0 ? "down" : "flat"; }

  function clock(ts) { return new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }); }

  function ago(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return "только что";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " мин назад";
    var h = Math.floor(m / 60);
    return h < 24 ? h + " ч назад" : Math.floor(h / 24) + " дн. назад";
  }

  function chg(v) {
    if (v == null || isNaN(v)) return '<span class="chg flat">—</span>';
    var arrow = v > 0 ? "▲ " : v < 0 ? "▼ " : "";
    return '<span class="chg ' + dir(v) + '">' + arrow +
      nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v)) + "%</span>";
  }

  function spark(values) {
    var w = 120, h = 36;
    var vals = (values || []).filter(function (v) { return typeof v === "number"; });
    if (vals.length < 2) return "";
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), span = max - min || 1;
    var pts = vals.map(function (v, i) {
      return ((i / (vals.length - 1)) * w).toFixed(1) + "," + (h - 3 - ((v - min) / span) * (h - 6)).toFixed(1);
    });
    return '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="currentColor" stroke-width="1.7" ' +
      'stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>';
  }

  /* ---------- сеть и кэш ---------- */

  async function getJSON(url, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 12000);
    try {
      var res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function readCache(key) {
    try { var raw = localStorage.getItem("crypto:" + key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }

  function writeCache(key, data) {
    try { localStorage.setItem("crypto:" + key, JSON.stringify({ t: Date.now(), data: data })); } catch (e) { /* хранилище недоступно */ }
  }

  // Свежий кэш отдаём сразу; если сервис упал, показываем устаревший.
  async function cached(key, ttlSec, fn) {
    var c = readCache(key);
    if (c && Date.now() - c.t < ttlSec * 1000) return { data: c.data, stale: false, at: c.t };
    try {
      var data = await fn();
      writeCache(key, data);
      return { data: data, stale: false, at: Date.now() };
    } catch (err) {
      if (c) return { data: c.data, stale: true, at: c.t };
      throw err;
    }
  }

  function explain(err) {
    var m = (err && err.message) || String(err);
    if (err && err.name === "AbortError") return "сервис отвечает слишком долго";
    if (/HTTP 429/.test(m)) return "CoinGecko ограничил частоту запросов — подождите минуту";
    if (/HTTP 404/.test(m)) return "такой монеты или данных для неё нет";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "нет связи с сервисом — проверьте интернет или блокировщик рекламы";
    return m;
  }

  /* ---------- состояние ---------- */

  var savedVs = null;
  try { savedVs = localStorage.getItem("crypto:vs"); } catch (e) { /* без сохранения */ }

  var S = {
    vs: savedVs && CFG.currencies.indexOf(savedVs) > -1 ? savedVs : CFG.vs,
    coin: CFG.defaultCoin,
    days: 7,
    markets: null,
    chart: null,
    known: {}
  };

  var RANGE_LABEL = { 1: "за 24 ч", 7: "за 7 дн.", 30: "за 30 дн.", 90: "за 90 дн.", 365: "за год" };

  function cur() { return S.vs.toUpperCase(); }

  function price(v) {
    if (v == null) return "—";
    var d = v >= 1000 ? 0 : v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
    return nf({ style: "currency", currency: cur(), minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  }

  function bigMoney(v) {
    if (v == null) return "—";
    return nf({ style: "currency", currency: cur(), notation: "compact", maximumFractionDigits: 2 }).format(v);
  }

  function ch24(c) {
    return c.price_change_percentage_24h_in_currency != null ? c.price_change_percentage_24h_in_currency : c.price_change_percentage_24h;
  }

  function chartKey() { return S.coin + ":" + S.vs + ":" + S.days; }

  function coinInfo() {
    var m = S.markets && S.markets.filter(function (c) { return c.id === S.coin; })[0];
    if (m) return { name: m.name, symbol: m.symbol, image: m.image, rank: m.market_cap_rank, m: m };
    var k = S.known[S.coin];
    if (k) return { name: k.name, symbol: k.symbol, image: k.image, rank: k.rank, m: null };
    return { name: S.coin, symbol: "", image: "", rank: null, m: null };
  }

  /* ---------- большой график ---------- */

  function fmtTip(t) {
    var o = S.days <= 90 ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" };
    return new Date(t).toLocaleString("ru-RU", o);
  }

  function fmtAxis(t) {
    var d = new Date(t);
    if (S.days <= 1) return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    if (S.days > 90) return d.toLocaleDateString("ru-RU", { month: "short", year: "2-digit" });
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  }

  function drawChart() {
    var host = $("#chart");
    var pts = S.chart;
    if (!pts || pts.length < 2) return;
    var n = pts.length;
    var W = Math.max(280, host.clientWidth || 600), H = 260, padT = 16, padB = 26;
    var t0 = pts[0][0], tspan = (pts[n - 1][0] - t0) || 1;
    var min = Infinity, max = -Infinity;
    pts.forEach(function (p) { if (p[1] < min) min = p[1]; if (p[1] > max) max = p[1]; });
    var span = (max - min) || 1;
    var lo = min - span * 0.06, rng = (max + span * 0.06) - lo;
    function X(t) { return ((t - t0) / tspan) * W; }
    function Y(v) { return padT + (1 - (v - lo) / rng) * (H - padT - padB); }
    var base = H - padB;

    var line = pts.map(function (p, i) { return (i ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1); }).join("");
    var area = line + "L" + W + "," + base + "L0," + base + "Z";

    var grid = [max, (max + min) / 2, min].map(function (v) {
      var y = Y(v).toFixed(1);
      return '<line x1="0" x2="' + W + '" y1="' + y + '" y2="' + y + '" stroke="rgba(20,20,20,.18)" stroke-dasharray="2 4"/>' +
        '<text x="0" y="' + (Y(v) - 5).toFixed(1) + '" font-size="11" fill="rgba(20,20,20,.6)">' + esc(price(v)) + "</text>";
    }).join("");

    host.innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="График цены">' + grid +
      '<path d="' + area + '" fill="rgba(20,20,20,.12)"/>' +
      '<path d="' + line + '" fill="none" stroke="#141414" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<text x="0" y="' + (H - 7) + '" font-size="11" fill="rgba(20,20,20,.6)">' + esc(fmtAxis(t0)) + "</text>" +
      '<text x="' + W + '" y="' + (H - 7) + '" font-size="11" text-anchor="end" fill="rgba(20,20,20,.6)">' + esc(fmtAxis(pts[n - 1][0])) + "</text>" +
      '<line class="cx" y1="' + padT + '" y2="' + base + '" stroke="#141414" stroke-width="1.2" stroke-dasharray="3 3" visibility="hidden"/>' +
      '<circle class="cd" r="5" fill="#141414" stroke="#C6FF10" stroke-width="2" visibility="hidden"/>' +
      '</svg><div class="tip" hidden></div>';

    var svg = $("svg", host), cx = $(".cx", host), cd = $(".cd", host), tip = $(".tip", host);

    function onMove(e) {
      var r = svg.getBoundingClientRect();
      if (!r.width) return;
      var fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      var t = t0 + fx * tspan, a = 0, b = n - 1;
      while (b - a > 1) { var mid = (a + b) >> 1; if (pts[mid][0] < t) a = mid; else b = mid; }
      var i = (t - pts[a][0] < pts[b][0] - t) ? a : b;
      var px = X(pts[i][0]), py = Y(pts[i][1]);
      cx.setAttribute("x1", px); cx.setAttribute("x2", px); cx.setAttribute("visibility", "visible");
      cd.setAttribute("cx", px); cd.setAttribute("cy", py); cd.setAttribute("visibility", "visible");
      tip.innerHTML = "<strong>" + esc(price(pts[i][1])) + "</strong><span>" + esc(fmtTip(pts[i][0])) + "</span>";
      tip.hidden = false;
      tip.style.left = Math.min(r.width - 70, Math.max(70, px * (r.width / W))) + "px";
      tip.style.top = (py * (r.height / H)) + "px";
    }
    function onLeave() {
      cx.setAttribute("visibility", "hidden"); cd.setAttribute("visibility", "hidden"); tip.hidden = true;
    }
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerdown", onMove);
    svg.addEventListener("pointerleave", onLeave);
  }

  function renderHero() {
    var info = coinInfo(), m = info.m, pts = S.chart;
    $("#hero-coin").innerHTML =
      (info.image ? '<img src="' + esc(info.image) + '" alt="" width="40" height="40">' : "") +
      "<div><strong>" + esc(info.name) + "</strong>" +
      '<div class="sub">' + (info.symbol ? "<span>" + esc(String(info.symbol).toUpperCase()) + "</span>" : "") +
      (info.rank ? "<span>№" + info.rank + " по капитализации</span>" : "") + "</div></div>";

    var last = m ? m.current_price : (pts && pts.length ? pts[pts.length - 1][1] : null);
    var pill = "";
    if (pts && pts.length > 1) {
      var d = ((pts[pts.length - 1][1] - pts[0][1]) / pts[0][1]) * 100;
      pill = '<span class="hpill ' + dir(d) + '">' + (d > 0 ? "▲ " : d < 0 ? "▼ " : "") +
        nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(d)) + "%<small>" + RANGE_LABEL[S.days] + "</small></span>";
    }
    $("#hero-price").innerHTML = last == null ? "" : '<span class="price">' + esc(price(last)) + "</span>" + pill;

    var stats = [];
    if (pts && pts.length) {
      var prices = pts.map(function (p) { return p[1]; });
      stats.push(["Минимум " + RANGE_LABEL[S.days], price(Math.min.apply(null, prices))]);
      stats.push(["Максимум " + RANGE_LABEL[S.days], price(Math.max.apply(null, prices))]);
    }
    if (m) {
      stats.push(["Капитализация", bigMoney(m.market_cap)]);
      stats.push(["Объём за 24 ч", bigMoney(m.total_volume)]);
    }
    $("#hero-stats").innerHTML = stats.map(function (s) { return "<div><dt>" + esc(s[0]) + "</dt><dd>" + esc(s[1]) + "</dd></div>"; }).join("");
  }

  function loadChart() {
    var key = chartKey();
    return cached("chart:" + key, S.days <= 1 ? 60 : 180, async function () {
      var j = await getJSON(CG + "/coins/" + encodeURIComponent(S.coin) + "/market_chart?vs_currency=" + encodeURIComponent(S.vs) + "&days=" + S.days);
      return { prices: j.prices || [] };
    }).then(function (r) { r.key = key; return r; });
  }

  function renderChart(target, data) {
    S.chart = data.prices;
    if (!S.chart.length) { target.innerHTML = '<p class="loading">Для этой монеты нет данных графика</p>'; renderHero(); return; }
    drawChart();
    renderHero();
  }

  /* ---------- весь рынок ---------- */

  function loadGlobal() {
    return cached("global", 120, async function () { return (await getJSON(CG + "/global")).data; });
  }

  function renderGlobal(body, g) {
    var cap = g.total_market_cap && g.total_market_cap[S.vs];
    var vol = g.total_volume && g.total_volume[S.vs];
    var btc = (g.market_cap_percentage && g.market_cap_percentage.btc) || 0;
    var eth = (g.market_cap_percentage && g.market_cap_percentage.eth) || 0;
    var rest = Math.max(0, 100 - btc - eth);
    var f1 = nf({ maximumFractionDigits: 1 });
    body.innerHTML =
      '<dl class="tiles">' +
        '<div class="tile"><dt>Капитализация</dt><dd>' + esc(bigMoney(cap)) + "</dd>" + chg(g.market_cap_change_percentage_24h_usd) + "</div>" +
        '<div class="tile"><dt>Объём за 24 ч</dt><dd>' + esc(bigMoney(vol)) + "</dd></div>" +
        '<div class="tile"><dt>Доля Bitcoin</dt><dd>' + f1.format(btc) + "%</dd></div>" +
        '<div class="tile"><dt>Монет в обороте</dt><dd>' + nf().format(g.active_cryptocurrencies || 0) + "</dd></div>" +
      "</dl>" +
      '<div class="dom" role="img" aria-label="Доли рынка: Bitcoin ' + f1.format(btc) + "%, Ethereum " + f1.format(eth) + '%">' +
        '<i class="b" style="width:' + btc.toFixed(1) + '%"></i><i class="e" style="width:' + eth.toFixed(1) + '%"></i><i class="o" style="width:' + rest.toFixed(1) + '%"></i></div>' +
      '<div class="legend"><span style="--c:#C6FF10">Bitcoin ' + f1.format(btc) + '%</span><span style="--c:#F2F2F2">Ethereum ' +
        f1.format(eth) + '%</span><span style="--c:#3A3A3A">Остальные ' + f1.format(rest) + "%</span></div>";
  }

  /* ---------- индекс страха и жадности ---------- */

  var FNG_RU = {
    "Extreme Fear": "Экстремальный страх", "Fear": "Страх", "Neutral": "Нейтрально",
    "Greed": "Жадность", "Extreme Greed": "Экстремальная жадность"
  };

  function loadFng() {
    return cached("fng", 900, async function () { return (await getJSON("https://api.alternative.me/fng/?limit=30")).data; });
  }

  function renderFng(body, rows) {
    var now = parseInt(rows[0].value, 10);
    function at(i) { return rows[Math.min(i, rows.length - 1)] ? parseInt(rows[Math.min(i, rows.length - 1)].value, 10) : null; }
    var arc = "M 20 100 A 80 80 0 0 1 180 100";
    body.innerHTML =
      '<svg class="gauge" viewBox="0 0 200 118" role="img" aria-label="Индекс ' + now + ' из 100">' +
        '<path d="' + arc + '" fill="none" stroke="#2E2E2E" stroke-width="14" stroke-linecap="round"/>' +
        '<path d="' + arc + '" pathLength="100" fill="none" stroke="#C6FF10" stroke-width="14" stroke-linecap="round" stroke-dasharray="' + now + ' 100"/>' +
        '<text x="100" y="98" text-anchor="middle" font-size="34">' + now + "</text></svg>" +
      '<p class="fng-class">' + esc(FNG_RU[rows[0].value_classification] || rows[0].value_classification) + "</p>" +
      '<ul class="fng-hist">' +
        "<li><span>Вчера</span><span>" + at(1) + "</span></li>" +
        "<li><span>Неделю назад</span><span>" + at(7) + "</span></li>" +
        "<li><span>Месяц назад</span><span>" + at(29) + "</span></li></ul>";
  }

  /* ---------- таблица монет ---------- */

  function loadMarkets() {
    var key = "markets:" + S.vs + ":" + CFG.topCount;
    return cached(key, 90, function () {
      return getJSON(CG + "/coins/markets?vs_currency=" + encodeURIComponent(S.vs) + "&order=market_cap_desc&per_page=" + CFG.topCount +
        "&page=1&sparkline=true&price_change_percentage=1h,24h,7d");
    });
  }

  function drawTable() {
    var body = $("#card-markets .body");
    var list = S.markets || [];
    body.innerHTML = '<table class="mk"><thead><tr>' +
      '<th class="rank">№</th><th>Монета</th><th class="r">Цена</th><th class="r c1h">1 ч</th><th class="r">24 ч</th><th class="r">7 дн.</th>' +
      '<th class="r ccap">Капитализация</th><th class="sp"><span class="sr">График за 7 дней</span></th></tr></thead><tbody>' +
      list.map(function (c) {
        var sp = (c.sparkline_in_7d && c.sparkline_in_7d.price) || [];
        var d7 = c.price_change_percentage_7d_in_currency;
        return '<tr data-id="' + esc(c.id) + '"' + (c.id === S.coin ? ' class="sel" aria-current="true"' : "") + ">" +
          '<td class="rank">' + c.market_cap_rank + "</td>" +
          '<td><button type="button" class="coinbtn" data-id="' + esc(c.id) + '"><img src="' + esc(c.image) + '" alt="" width="26" height="26" loading="lazy">' +
            '<span class="name"><strong>' + esc(c.name) + '</strong><span class="sym">' + esc(String(c.symbol).toUpperCase()) + "</span></span></button></td>" +
          '<td class="r">' + esc(price(c.current_price)) + "</td>" +
          '<td class="r c1h">' + chg(c.price_change_percentage_1h_in_currency) + "</td>" +
          '<td class="r">' + chg(ch24(c)) + "</td>" +
          '<td class="r">' + chg(d7) + "</td>" +
          '<td class="r ccap">' + esc(bigMoney(c.market_cap)) + "</td>" +
          '<td class="sp"><span class="sparkwrap ' + dir(d7 != null ? d7 : (sp.length > 1 ? sp[sp.length - 1] - sp[0] : 0)) + '">' + spark(sp) + "</span></td></tr>";
      }).join("") + "</tbody></table>";
  }

  function renderMarkets(body, list) {
    S.markets = list;
    drawTable();
    renderMovers();
    renderHero();
  }

  function renderMovers() {
    var body = $("#card-movers .body");
    var list = (S.markets || []).filter(function (c) { return ch24(c) != null; })
      .sort(function (a, b) { return ch24(b) - ch24(a); });
    if (list.length < 6) { body.innerHTML = '<p class="loading">Мало данных</p>'; return; }
    function rows(arr) {
      return '<div class="list">' + arr.map(function (c) {
        return '<button type="button" class="rowbtn" data-id="' + esc(c.id) + '"><img src="' + esc(c.image) + '" alt="" width="24" height="24" loading="lazy">' +
          '<span class="name"><strong>' + esc(c.name) + '</strong><span class="sym">' + esc(price(c.current_price)) + "</span></span>" + chg(ch24(c)) + "</button>";
      }).join("") + "</div>";
    }
    body.innerHTML = '<div class="mini"><h3>Растут сильнее всех</h3>' + rows(list.slice(0, 3)) +
      "<h3>Падают сильнее всех</h3>" + rows(list.slice(-3).reverse()) + "</div>";
  }

  /* ---------- «Сейчас ищут» ---------- */

  function loadTrending() {
    return cached("trending", 300, async function () {
      var j = await getJSON(CG + "/search/trending");
      return (j.coins || []).map(function (c) { return c.item; });
    });
  }

  function renderTrending(body, items) {
    items = items.slice(0, CFG.trendingCount);
    items.forEach(function (it) {
      S.known[it.id] = { name: it.name, symbol: it.symbol, image: it.small || it.thumb, rank: it.market_cap_rank };
    });
    body.innerHTML = '<div class="list">' + items.map(function (it) {
      var d = it.data && it.data.price_change_percentage_24h;
      var v = d ? (d[S.vs] != null ? d[S.vs] : d.usd) : null;
      return '<button type="button" class="rowbtn" data-id="' + esc(it.id) + '"><img src="' + esc(it.thumb) + '" alt="" width="24" height="24" loading="lazy">' +
        '<span class="name"><strong>' + esc(it.name) + '</strong><span class="sym">' + esc(String(it.symbol).toUpperCase()) +
        (it.market_cap_rank ? ", №" + it.market_cap_rank : "") + "</span></span>" + chg(v) + "</button>";
    }).join("") + "</div>";
  }

  /* ---------- блоки: загрузка и ошибки ---------- */

  var blocks = [
    { id: "global", label: "Весь рынок", card: "card-global", load: loadGlobal, render: renderGlobal },
    { id: "fng", label: "Страх и жадность", card: "card-fng", load: loadFng, render: renderFng },
    { id: "markets", label: "Крупнейшие монеты", card: "card-markets", load: loadMarkets, render: renderMarkets },
    { id: "trending", label: "Сейчас ищут", card: "card-trending", load: loadTrending, render: renderTrending },
    { id: "chart", label: "График", card: null, load: loadChart, render: renderChart }
  ];

  async function runBlock(b) {
    var card = b.card ? $("#" + b.card) : null;
    var host = card || $("#hero");
    var target = card ? $(".body", card) : $("#chart");
    var meta = card ? $(".meta", card) : $("#hero-meta");
    host.classList.add("busy");
    try {
      var res = await b.load();
      if (res.key && res.key !== chartKey()) return; // пока грузили, выбор изменился
      b.render(target, res.data);
      b.rendered = true;
      b.ok = !res.stale;
      if (res.stale) {
        meta.className = "meta warn";
        meta.textContent = "Сервис не ответил — показаны сохранённые данные (" + ago(res.at) + ")";
      } else {
        meta.className = "meta";
        meta.textContent = "Обновлено в " + clock(res.at);
      }
    } catch (err) {
      b.ok = false;
      var empty = b.id === "chart" ? !S.chart : !b.rendered;
      if (empty) {
        target.innerHTML = '<div class="err"><p>Не удалось загрузить данные.</p><p class="why">' + esc(explain(err)) +
          '</p><button type="button" class="btn retry">Повторить</button></div>';
        $(".retry", target).addEventListener("click", function () { runBlock(b).then(updateStatus); });
        meta.textContent = "";
      } else {
        meta.className = "meta warn";
        meta.textContent = "Не удалось обновить: " + explain(err);
      }
    } finally {
      host.classList.remove("busy");
    }
  }

  /* ---------- управление ---------- */

  var refreshBtn = $("#refresh");
  var running = false, again = false;

  function updateStatus() {
    var ok = blocks.filter(function (b) { return b.ok; }).length;
    $("#status").textContent = "Блоков с живыми данными: " + ok + " из " + blocks.length + ". Проверено в " + clock(Date.now()) + ".";
    blocks.forEach(function (b) {
      var li = $("#src-" + b.id);
      if (li) li.className = b.ok ? "ok" : "bad";
    });
  }

  async function refreshAll() {
    if (running) { again = true; return; }
    running = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Обновляю…";
    do {
      again = false;
      await Promise.allSettled(blocks.map(runBlock));
    } while (again);
    running = false;
    refreshBtn.disabled = false;
    refreshBtn.textContent = "Обновить";
    updateStatus();
  }

  function byId(id) { return blocks.filter(function (b) { return b.id === id; })[0]; }

  function resetChart() {
    S.chart = null;
    $("#chart").innerHTML = '<p class="loading">Загружаю график…</p>';
    renderHero();
  }

  function selectCoin(id) {
    if (!id || id === S.coin) return;
    S.coin = id;
    resetChart();
    if (S.markets) drawTable();
    runBlock(byId("chart")).then(updateStatus);
    var hero = $("#hero");
    if (hero.getBoundingClientRect().top < 0) {
      var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
      hero.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
    }
  }

  function paintToggle(root, attr, value) {
    Array.prototype.forEach.call(root.querySelectorAll("button"), function (btn) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute(attr) === String(value)));
    });
  }

  function initControls() {
    var cur$ = $("#currency");
    cur$.innerHTML = CFG.currencies.map(function (c) {
      return '<button type="button" data-vs="' + esc(c) + '" aria-pressed="' + (c === S.vs) + '">' + esc(c.toUpperCase()) + "</button>";
    }).join("");
    cur$.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-vs]");
      if (!btn || btn.getAttribute("data-vs") === S.vs) return;
      S.vs = btn.getAttribute("data-vs");
      try { localStorage.setItem("crypto:vs", S.vs); } catch (err) { /* без сохранения */ }
      paintToggle(cur$, "data-vs", S.vs);
      S.markets = null;
      byId("markets").rendered = false;
      $("#card-markets .body").innerHTML = '<p class="loading">Загружаю…</p>';
      resetChart();
      refreshAll();
    });

    var ranges = $("#ranges");
    ranges.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-days]");
      if (!btn || Number(btn.getAttribute("data-days")) === S.days) return;
      S.days = Number(btn.getAttribute("data-days"));
      paintToggle(ranges, "data-days", S.days);
      resetChart();
      runBlock(byId("chart")).then(updateStatus);
    });

    ["#card-markets .body", "#card-movers .body", "#card-trending .body"].forEach(function (sel) {
      $(sel).addEventListener("click", function (e) {
        var t = e.target.closest("[data-id]");
        if (t) selectCoin(t.getAttribute("data-id"));
      });
    });

    $("#sources").innerHTML = blocks.map(function (b) { return '<li id="src-' + b.id + '">' + esc(b.label) + "</li>"; }).join("");
    refreshBtn.addEventListener("click", refreshAll);

    var host = $("#chart");
    if (window.ResizeObserver) new ResizeObserver(function () { drawChart(); }).observe(host);
    else window.addEventListener("resize", drawChart);
  }

  /* ---------- старт ---------- */

  initControls();
  renderHero();
  refreshAll();
  setInterval(function () { if (!document.hidden) refreshAll(); }, (CFG.refreshSeconds || 120) * 1000);
})();
