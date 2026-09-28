/* Sick Sales — daily online + merch trailer reports.
   Plain JS, no build step. All data goes through PIN-checked Supabase RPCs (see supabase/migrations). */
(function () {
  "use strict";

  var CFG = window.SALES_CONFIG;
  var PIN_KEY = "sickSales.pin";
  var COMPARE_KEY = "sickSales.emailCompare";
  // Reports created before the app went live were already emailed the old way; don't nag about them.
  var LIVE_SINCE = "2026-09-29";

  var state = {
    pin: null,
    channels: null,
    reports: [],
    events: [],
    tab: "today",
    report: { channel: "online", id: null, source: "manual", sentAt: null },
    logChannel: "all",
    logStatus: "all",
    logMonth: "all",
    totalsChannel: "online",
    settingsChannel: "online",
    settingsDraft: null,
    editingEventId: null,
    eventId: null,
    eventCompareId: undefined,
    emailCompare: false,
  };

  // ---------- small helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k === "style") n.setAttribute("style", v);
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
  function local(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val);
    } catch (e) { return null; }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  // Dates are plain "YYYY-MM-DD" strings in local time.
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parse(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function today() { return ymd(new Date()); }
  function dayDiff(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function weekStart(s) { return addDays(s, -((parse(s).getDay() + 6) % 7)); }
  function shortDate(s) { var d = parse(s); return (d.getMonth() + 1) + "-" + d.getDate() + "-" + String(d.getFullYear()).slice(2); }
  function md(s) { var d = parse(s); return (d.getMonth() + 1) + "/" + d.getDate(); }
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function niceDate(s) { var d = parse(s); return DOW[d.getDay()] + " " + (d.getMonth() + 1) + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(2); }
  function niceRange(a, b) { return a === b ? niceDate(a) : niceDate(a) + " – " + niceDate(b); }
  function rangeText(a, b) { return a === b ? shortDate(a) : shortDate(a) + " to " + shortDate(b); }

  // The normal cadence: Monday reports cover Fri–Sun, other days cover yesterday.
  function defaultRange() {
    var t = today(), dow = parse(t).getDay();
    if (dow === 1) return { start: addDays(t, -3), end: addDays(t, -1) };
    return { start: addDays(t, -1), end: addDays(t, -1) };
  }
  function lastWeekend() {
    var t = today(), dow = parse(t).getDay();
    var sun = addDays(t, -(dow === 0 ? 7 : dow));
    return { start: addDays(sun, -2), end: sun };
  }

  function toNum(v) {
    if (v == null) return null;
    var s = String(v).replace(/[$,\s]/g, "");
    if (s === "") return null;
    var n = Number(s);
    return isFinite(n) ? n : NaN;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  var money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  function fmtMoney(n) { n = Number(n) || 0; return (n < 0 ? "-$" : "$") + money.format(Math.abs(n)); }
  function fmtMoney0(n) { n = Math.round(Number(n) || 0); return (n < 0 ? "-$" : "$") + whole.format(Math.abs(n)); }
  function emailMoney(n) { n = round2(Number(n) || 0); return n === 0 ? "$0" : fmtMoney(n); }
  function fmtInt(n) { return n == null || n === "" ? "—" : whole.format(Number(n)); }
  function fmtCompact(n) {
    var a = Math.abs(n);
    if (a >= 1e6) return "$" + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return "$" + (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
    return "$" + Math.round(n);
  }

  // Change vs a previous value: arrow + percent, never color alone.
  function pctChange(cur, prev) { return prev ? (cur - prev) / Math.abs(prev) : null; }
  function deltaText(cur, prev) {
    var p = pctChange(cur, prev);
    if (p == null) return null;
    var r = Math.round(p * 100);
    if (r === 0) return "no change";
    return (r > 0 ? "▲ " : "▼ ") + Math.abs(r) + "%";
  }
  function deltaEl(cur, prev, suffix) {
    var p = pctChange(cur, prev);
    if (p == null) return null;
    var r = Math.round(p * 100);
    return el("span", { class: "delta-wrap" }, [
      el("span", { class: "delta " + (r > 0 ? "up" : r < 0 ? "down" : "flat"), text: deltaText(cur, prev) }),
      suffix ? el("span", { class: "delta-vs", text: suffix }) : null,
    ]);
  }

  function toast(text) {
    var t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2400);
  }
  function msg(id, text, kind) { var m = $(id); m.textContent = text || ""; m.className = "msg" + (kind ? " " + kind : ""); }
  function icon(kind) {
    var paths = { check: "M5 12.5l4.5 4.5L19 7.5", clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", alert: "M12 8v5M12 16.5v.01M12 3l9.5 17h-19L12 3Z" };
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", paths[kind]); svg.appendChild(p);
    return svg;
  }
  function statusChip(kind, text) {
    var map = { ok: ["status-ok", "check"], wait: ["status-wait", "clock"], bad: ["status-bad", "alert"] };
    return el("span", { class: "status " + map[kind][0] }, [icon(map[kind][1]), text]);
  }

  // ---------- API ----------
  function rpc(fn, args) {
    return fetch(CFG.supabaseUrl + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: CFG.supabaseKey },
      body: JSON.stringify(args),
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && (body.message || body.hint)) || "Request failed (" + r.status + ")");
        return body;
      });
    });
  }
  // Every call carries the PIN; a bad or locked PIN sends the user back to the login screen.
  function call(fn, args) {
    args = Object.assign({ p_pin: state.pin }, args || {});
    return rpc(fn, args).then(function (res) {
      var st = typeof res === "string" ? res : res && res.state;
      if (st === "bad" || st === "locked") {
        logout(st === "locked" ? "Too many wrong tries. Locked for 15 minutes." : "PIN not accepted. Sign in again.");
        throw new Error("auth");
      }
      return res;
    });
  }
  function load() {
    return call("sales_payload").then(function (res) {
      state.channels = res.channels;
      state.reports = (res.reports || []).map(normalizeReport);
      state.events = res.events || [];
    });
  }
  function normalizeReport(r) {
    r.total = Number(r.total) || 0;
    var cats = r.categories || {};
    Object.keys(cats).forEach(function (k) { cats[k] = Number(cats[k]) || 0; });
    r.categories = cats;
    r.other = round2(r.total - sumCats(cats));
    return r;
  }
  function sumCats(cats) { return Object.keys(cats).reduce(function (a, k) { return a + (Number(cats[k]) || 0); }, 0); }
  function reportById(id) { return state.reports.filter(function (r) { return r.id === id; })[0]; }
  function findReport(ch, s, e) {
    return state.reports.filter(function (r) { return r.channel === ch && r.start_date === s && r.end_date === e; })[0];
  }

  // ---------- numbers ----------
  function chCfg(ch) { return state.channels[ch]; }
  // Same rule as the old weekly sheet: a report counts if its end date falls in the range.
  function aggregate(ch, from, to) {
    var cfg = chCfg(ch);
    var rows = state.reports.filter(function (r) { return r.channel === ch && r.end_date >= from && r.end_date <= to; });
    var cats = {};
    cfg.categories.forEach(function (c) { cats[c.key] = 0; });
    var agg = { count: rows.length, rows: rows, visits: 0, visitsKnown: false, total: 0, categories: cats, other: 0, covered: {} };
    rows.forEach(function (r) {
      if (r.visits != null) { agg.visits += r.visits; agg.visitsKnown = true; }
      agg.total += r.total;
      agg.other += r.other;
      Object.keys(r.categories).forEach(function (k) {
        if (k in cats) cats[k] += r.categories[k];
        else agg.other += r.categories[k]; // a category since removed from settings still counts
      });
      for (var day = r.start_date; day <= r.end_date; day = addDays(day, 1)) agg.covered[day] = true;
    });
    if (!agg.visitsKnown) agg.visits = null;
    agg.total = round2(agg.total); agg.other = round2(agg.other);
    Object.keys(cats).forEach(function (k) { cats[k] = round2(cats[k]); });
    return agg;
  }
  function shifted(ch, from, to, days) {
    var a = aggregate(ch, addDays(from, -days), addDays(to, -days));
    return a.count ? a : null;
  }
  function lastWeek(ch, from, to) { return shifted(ch, from, to, 7); }
  function fourWeekAvg(ch, from, to) {
    var sum = 0, n = 0;
    for (var w = 1; w <= 4; w++) { var a = shifted(ch, from, to, 7 * w); if (a) { sum += a.total; n++; } }
    return n ? sum / n : null;
  }
  function sameDaysLastYear(ch, from, to) {
    var f = parse(from), t = parse(to);
    f.setFullYear(f.getFullYear() - 1); t.setFullYear(t.getFullYear() - 1);
    var a = aggregate(ch, ymd(f), ymd(t));
    return a.count ? a : null;
  }

  // ---------- events ----------
  function eventById(id) { return state.events.filter(function (e) { return e.id === id; })[0]; }
  function eventDays(ev) { var out = []; for (var d = ev.start_date; d <= ev.end_date; d = addDays(d, 1)) out.push(d); return out; }
  function eventOn(date) { return state.events.filter(function (e) { return date >= e.start_date && date <= e.end_date; })[0]; }
  function baseName(name) { return name.toLowerCase().replace(/\b(19|20)\d{2}\b/g, "").replace(/\s+/g, " ").trim(); }
  // "Sick Week 2027" is compared with "Sick Week 2026"; otherwise with the event just before it.
  function compareEventFor(ev) {
    var before = state.events.filter(function (e) { return e.id !== ev.id && e.start_date < ev.start_date && aggregate("trailer", e.start_date, e.end_date).count; })
      .sort(function (a, b) { return b.start_date.localeCompare(a.start_date); });
    return before.filter(function (e) { return baseName(e.name) === baseName(ev.name); })[0] || before[0] || null;
  }
  function currentEvent() {
    var t = today();
    var live = eventOn(t) || eventOn(addDays(t, -1));
    if (live) return { ev: live, mode: "live" };
    var soon = state.events.filter(function (e) { return e.start_date > t && dayDiff(t, e.start_date) <= 30; })
      .sort(function (a, b) { return a.start_date.localeCompare(b.start_date); })[0];
    if (soon) return { ev: soon, mode: "soon" };
    var recent = state.events.filter(function (e) { return e.end_date < t && dayDiff(e.end_date, t) <= 7; })[0];
    if (recent) return { ev: recent, mode: "ended" };
    return null;
  }
  function trailerDay(date) {
    return state.reports.filter(function (r) { return r.channel === "trailer" && r.start_date <= date && r.end_date >= date; })[0];
  }

  // ---------- email ----------
  // An email is a header plus sections of {label, value, note} rows; rendered as plain text or a Gmail-friendly table.
  function reportRows(cfg, d, cmp, visitsLabel) {
    var labels = {};
    cfg.categories.forEach(function (c) { labels[c.key] = c.label; });
    return emailOrder(cfg).map(function (k) {
      if (k === "visits") return { label: visitsLabel || cfg.visits_label, value: d.visits == null ? "—" : whole.format(d.visits), note: cmp && d.visits != null && cmp.visits ? deltaText(d.visits, cmp.visits) + " vs last week" : null };
      if (k === "other") return { label: "Other", value: emailMoney(d.other) };
      if (k === "total") return { label: "Total", value: emailMoney(d.total), strong: true, note: cmp ? deltaText(d.total, cmp.total) + " vs last week" : null };
      return { label: labels[k], value: emailMoney(d.categories[k]) };
    });
  }
  function emailText(doc) {
    var lines = [doc.header];
    doc.sections.forEach(function (s, i) {
      if (s.title) { if (i > 0 || doc.header) lines.push(""); lines.push(s.title); }
      s.rows.forEach(function (r) { lines.push(r.label + " " + r.value + (r.note ? " (" + r.note + ")" : "")); });
    });
    return lines.join("\n");
  }
  function emailHtml(doc) {
    var h = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">';
    h += '<p style="margin:0 0 10px;font-weight:bold">' + esc(doc.header) + "</p>";
    doc.sections.forEach(function (s) {
      if (s.title) h += '<p style="margin:14px 0 6px;font-weight:bold;color:#444;text-transform:uppercase;font-size:12px;letter-spacing:.5px">' + esc(s.title) + "</p>";
      h += '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:280px">';
      s.rows.forEach(function (r) {
        var top = r.strong ? "border-top:1px solid #ccc;" : "";
        h += "<tr>" +
          '<td style="' + top + 'padding:5px 24px 5px 0;color:' + (r.strong ? "#111" : "#555") + ';font-weight:' + (r.strong ? "bold" : "normal") + '">' + esc(r.label) + "</td>" +
          '<td style="' + top + 'padding:5px 0;text-align:right;font-weight:bold">' + esc(r.value) + "</td>" +
          '<td style="' + top + 'padding:5px 0 5px 12px;color:#777;font-size:12px">' + (r.note ? esc(r.note) : "") + "</td></tr>";
      });
      h += "</table>";
    });
    return h + "</div>";
  }
  function emailOrder(cfg) {
    var keys = cfg.categories.map(function (c) { return c.key; });
    var order = (cfg.email_order || []).filter(function (k) { return k === "visits" || k === "other" || k === "total" || keys.indexOf(k) >= 0; });
    keys.forEach(function (k) { if (order.indexOf(k) < 0) order.splice(Math.max(order.indexOf("other"), 0), 0, k); });
    ["visits", "other", "total"].forEach(function (k) { if (order.indexOf(k) < 0) { if (k === "visits") order.unshift(k); else order.push(k); } });
    return order;
  }
  function recipients(s) { return (s || "").split(/[;,\n]+/).map(function (x) { return x.trim(); }).filter(Boolean); }
  function mailtoHref(to, cc, subject, body) {
    var q = [];
    if (recipients(cc).length) q.push("cc=" + recipients(cc).map(encodeURIComponent).join(","));
    q.push("subject=" + encodeURIComponent(subject));
    q.push("body=" + encodeURIComponent(body.replace(/\n/g, "\r\n")));
    return "mailto:" + recipients(to).map(encodeURIComponent).join(",") + "?" + q.join("&");
  }
  function openMail(em) { window.location.href = mailtoHref(em.to, em.cc, em.subject, em.text); }
  function showEmail(prefix, em) {
    $(prefix + "-to").textContent = em.to || "—";
    $(prefix + "-cc").textContent = em.cc || "—";
    $(prefix + "-subject").textContent = em.subject;
    $(prefix + "-body").textContent = em.text;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, function () { legacyCopy(text, null); });
    } else legacyCopy(text, null);
  }
  // Rich copy so pasting into Gmail keeps the table; falls back to plain text.
  function copyRich(html, text) {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      var item = new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) });
      navigator.clipboard.write([item]).then(function () { toast("Copied. Paste it into Gmail."); }, function () { legacyCopy(text, html); });
    } else legacyCopy(text, html);
  }
  function legacyCopy(text, html) {
    var ok = false, node;
    try {
      if (html) {
        node = el("div", { contenteditable: "true", style: "position:fixed;left:-9999px;top:0" });
        node.innerHTML = html; // built by emailHtml(), every value escaped
        document.body.appendChild(node);
        var range = document.createRange(); range.selectNodeContents(node);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      } else {
        node = el("textarea", { readonly: true, style: "position:fixed;opacity:0;top:0" });
        node.value = text; document.body.appendChild(node); node.select();
      }
      ok = document.execCommand("copy");
    } catch (e) { ok = false; }
    if (node) document.body.removeChild(node);
    toast(ok ? "Copied" : "Couldn't copy. Select the text and press Ctrl/Cmd+C.");
  }

  // ---------- login ----------
  function showLogin(text) {
    $("app").hidden = true;
    $("login").hidden = false;
    msg("login-msg", text || "", text ? "err" : "");
    $("login-pin").value = "";
    setTimeout(function () { $("login-pin").focus(); }, 0);
  }
  function logout(text) {
    state.pin = null;
    local(PIN_KEY, null);
    showLogin(text);
  }
  function start(pin, remember) {
    state.pin = pin;
    return load().then(function () {
      if (remember) local(PIN_KEY, pin);
      $("login").hidden = true;
      $("app").hidden = false;
      initApp();
    });
  }
  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var pin = $("login-pin").value.trim();
    if (!pin) return;
    msg("login-msg", "Checking…");
    start(pin, $("login-remember").checked).catch(function (err) {
      if (err.message !== "auth") msg("login-msg", err.message, "err");
    });
  });

  // ---------- navigation ----------
  var booted = false;
  function initApp() {
    if (!booted) {
      booted = true;
      document.querySelectorAll("[data-tab]").forEach(function (b) {
        b.addEventListener("click", function () { showTab(b.dataset.tab); });
      });
      document.querySelectorAll("[data-go]").forEach(function (a) {
        a.addEventListener("click", function (e) { e.preventDefault(); showTab(a.dataset.go); });
      });
      state.emailCompare = local(COMPARE_KEY) === "1";
      applyChannelLabels();
      bindReport(); bindLog(); bindTotals(); bindEvents(); bindEventMode(); bindSettings();
      var r = defaultRange();
      newReport("online", r.start, r.end);
      setTotalsRange("this-week");
      var resizeTimer;
      window.addEventListener("resize", function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () { if (["today", "totals", "event"].indexOf(state.tab) >= 0) renderTab(state.tab); }, 150);
      });
    }
    showTab("today");
  }
  function showTab(name) {
    state.tab = name;
    var navName = name === "event" ? "events" : name;
    document.querySelectorAll(".tab, .bn").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === navName); });
    document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.dataset.view !== name; });
    hideTip();
    renderTab(name);
    window.scrollTo(0, 0);
  }
  function renderTab(name) {
    if (name === "today") renderToday();
    if (name === "report") renderReportContext();
    if (name === "log") renderLog();
    if (name === "totals") renderTotals();
    if (name === "events") renderEvents();
    if (name === "event") renderEventMode();
    if (name === "settings") renderSettings();
  }
  function applyChannelLabels() {
    ["online", "trailer"].forEach(function (ch) {
      document.querySelectorAll("#report-channel [data-channel=" + ch + "], #log-channel [data-channel=" + ch + "], #totals-channel [data-channel=" + ch + "], #settings-channel [data-channel=" + ch + "]")
        .forEach(function (b) { b.textContent = chCfg(ch).label; });
    });
  }
  function setSeg(id, value) {
    document.querySelectorAll("#" + id + " button").forEach(function (b) { b.classList.toggle("on", b.dataset.channel === value); });
  }
  function onSeg(id, fn) {
    document.querySelectorAll("#" + id + " button").forEach(function (b) {
      b.addEventListener("click", function () { fn(b.dataset.channel); });
    });
  }
  function openReport(r) { fillReport(r); msg("report-msg", ""); msg("pull-msg", ""); showTab("report"); }
  function openTrailerDay(date) {
    var r = findReport("trailer", date, date);
    if (r) fillReport(r); else newReport("trailer", date, date);
    msg("report-msg", ""); showTab("report");
  }

  // ---------- Today ----------
  function renderToday() {
    var now = new Date(), t = today();
    $("today-date").textContent = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()] + ", " + MONTHS[now.getMonth()] + " " + now.getDate();
    var h = now.getHours();
    $("today-greeting").textContent = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    renderMorningCard();
    renderTodayEvent();
    renderUnsent();
    renderTodayTiles();
    var weeks = [], ws = weekStart(t);
    for (var i = 11; i >= 0; i--) {
      var from = addDays(ws, -7 * i), to = addDays(from, 6), a = aggregate("online", from, to);
      weeks.push({ label: i === 0 ? "This wk" : md(from), title: i === 0 ? "This week so far (" + md(from) + " – " + md(to) + ")" : "Week of " + md(from), value: a.total, partial: i === 0 });
    }
    var done = weeks.slice(0, -1), sum12 = done.reduce(function (a, w) { return a + w.value; }, 0);
    var best = done.reduce(function (b, w) { return w.value > b.value ? w : b; }, done[0]);
    $("today-chart-sub").textContent = sum12 ? "Last 12 weeks · best " + fmtMoney0(best.value) + " (" + best.title.replace("Week of ", "week of ") + ")" : "Last 12 weeks";
    columnChart($("today-chart"), {
      height: 240,
      labels: weeks.map(function (w) { return w.label; }),
      titles: weeks.map(function (w) { return w.title; }),
      series: [{ name: "Online sales", color: "var(--s1)", values: weeks.map(function (w) { return w.value; }) }],
      faded: weeks.map(function (w) { return w.partial; }),
    });
  }
  function renderMorningCard() {
    var box = clear($("today-report"));
    var r = defaultRange(), rep = findReport("online", r.start, r.end), dow = parse(today()).getDay();
    if (!rep) {
      var weekend = dow === 0 || dow === 6;
      box.appendChild(el("div", { class: "hero-label", text: "Online report" }));
      box.appendChild(el("div", { class: "empty" }, [
        el("h2", { text: weekend ? "No report today" : "Not here yet" }),
        el("p", { text: weekend ? "It's the weekend. Monday's report will cover Friday through Sunday." : "The nightly Shopify pull usually lands around 4:15 AM. If it's later than that, enter it by hand." }),
        weekend ? null : el("button", { type: "button", class: "btn btn-primary", text: "Enter " + niceRange(r.start, r.end), onclick: function () { newReport("online", r.start, r.end); showTab("report"); } }),
      ]));
      return;
    }
    var prev = lastWeek("online", rep.start_date, rep.end_date), avg = fourWeekAvg("online", rep.start_date, rep.end_date);
    var status = rep.sent_at ? statusChip("ok", "Emailed " + new Date(rep.sent_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))
      : rep.other < -0.004 ? statusChip("bad", "Needs a check") : statusChip("wait", "Ready to send");
    box.appendChild(el("div", { class: "hero-top" }, [
      el("div", null, [el("div", { class: "hero-label", text: "Online report" }), el("div", { class: "hero-range", text: niceRange(rep.start_date, rep.end_date) })]),
      status,
    ]));
    box.appendChild(el("div", { class: "hero-value", text: fmtMoney(rep.total) }));
    var sub = el("div", { class: "hero-sub" }, [el("span", { text: fmtInt(rep.visits) + " visits" })]);
    if (prev) sub.appendChild(deltaEl(rep.total, prev.total, "vs last week"));
    if (avg) sub.appendChild(deltaEl(rep.total, avg, "vs 4-week avg"));
    box.appendChild(sub);
    var cats = el("div", { class: "hero-cats" });
    chCfg("online").categories.forEach(function (c) {
      cats.appendChild(el("div", null, [el("span", { text: c.label }), el("strong", { text: fmtMoney0(rep.categories[c.key]) })]));
    });
    cats.appendChild(el("div", null, [el("span", { text: "Other" }), el("strong", { text: fmtMoney0(rep.other) })]));
    box.appendChild(cats);
    box.appendChild(el("div", { class: "hero-actions" }, rep.sent_at ? [
      el("button", { type: "button", class: "btn", text: "Open report", onclick: function () { openReport(rep); } }),
    ] : [
      el("button", { type: "button", class: "btn btn-primary btn-lg", text: "Review & send", onclick: function () { openReport(rep); } }),
      el("button", { type: "button", class: "btn btn-lg", text: "Send as is", onclick: function () { sendNow(rep); } }),
    ]));
  }
  function sendNow(rep) {
    var em = reportEmail({ channel: rep.channel, start: rep.start_date, end: rep.end_date, visits: rep.visits, total: rep.total, categories: rep.categories, other: rep.other });
    openMail(em);
    call("sales_mark_sent", { p_id: rep.id }).then(load).then(function () { renderTab(state.tab); toast("Opened in your email app"); })
      .catch(function (err) { if (err.message !== "auth") toast(err.message); });
  }
  function renderTodayEvent() {
    var box = clear($("today-event")), cur = currentEvent();
    if (!cur) return;
    var ev = cur.ev, days = eventDays(ev), a = aggregate("trailer", ev.start_date, ev.end_date);
    var line = cur.mode === "live" ? "Day " + (Math.min(dayDiff(ev.start_date, today()), days.length - 1) + 1) + " of " + days.length
      : cur.mode === "soon" ? "Starts in " + dayDiff(today(), ev.start_date) + (dayDiff(today(), ev.start_date) === 1 ? " day" : " days")
      : "Ended " + niceDate(ev.end_date) + ". Time to send the summary.";
    box.appendChild(el("div", { class: "card" + (cur.mode === "live" ? " event-card-live" : "") }, [
      el("div", { class: "card-head" }, [el("h2", { text: ev.name }), el("span", { class: "muted small", text: line })]),
      el("div", { class: "hero-sub" }, [el("span", { text: "Trailer so far: " + fmtMoney(a.total) }), el("span", { text: a.count + " of " + days.length + " days entered" })]),
      el("div", { class: "hero-actions" }, [
        el("button", { type: "button", class: "btn btn-primary", text: "Open event mode", onclick: function () { openEvent(ev.id); } }),
      ]),
    ]));
  }
  function needsSending(r) { return !r.sent_at && !!r.created_at && r.created_at.slice(0, 10) >= LIVE_SINCE; }
  function renderUnsent() {
    var box = clear($("today-unsent"));
    var r = defaultRange(), hero = findReport("online", r.start, r.end);
    var rows = state.reports.filter(function (x) { return needsSending(x) && x !== hero; })
      .sort(function (a, b) { return b.end_date.localeCompare(a.end_date); }).slice(0, 8);
    if (!rows.length) return;
    var card = el("div", { class: "card" }, [el("div", { class: "card-head" }, [el("h2", { text: "Not emailed yet" }), el("span", { class: "muted small", text: rows.length + (rows.length === 1 ? " report" : " reports") })])]);
    rows.forEach(function (x) {
      card.appendChild(el("div", { class: "list-row" }, [
        el("div", null, [
          el("span", { class: "badge badge-" + x.channel, text: chCfg(x.channel).label }),
          el("span", { text: niceRange(x.start_date, x.end_date) }),
          el("div", { class: "muted small", text: fmtMoney(x.total) }),
        ]),
        el("button", { type: "button", class: "btn btn-sm", text: "Open", onclick: function () { openReport(x); } }),
      ]));
    });
    box.appendChild(card);
  }
  function tile(label, value, deltaNode, note) {
    return el("div", { class: "tile" }, [
      el("div", { class: "tile-label", text: label }),
      el("div", { class: "tile-value", text: value }),
      el("div", { class: "tile-delta" }, [deltaNode || el("span", { text: note || " " })]),
    ]);
  }
  function renderTodayTiles() {
    var box = clear($("today-tiles")), t = today();
    var wk = aggregate("online", addDays(t, -7), addDays(t, -1)), wkPrev = aggregate("online", addDays(t, -14), addDays(t, -8));
    box.appendChild(tile("Online, last 7 days", fmtMoney0(wk.total), wkPrev.count ? deltaEl(wk.total, wkPrev.total, "vs prior 7 days") : null));
    var d = parse(t), ms = ymd(new Date(d.getFullYear(), d.getMonth(), 1));
    var pm = new Date(d.getFullYear(), d.getMonth() - 1, 1), pmEnd = new Date(d.getFullYear(), d.getMonth() - 1, Math.min(d.getDate(), new Date(d.getFullYear(), d.getMonth(), 0).getDate()));
    var mo = aggregate("online", ms, t), moPrev = aggregate("online", ymd(pm), ymd(pmEnd));
    box.appendChild(tile("Online this month", fmtMoney0(mo.total), moPrev.count ? deltaEl(mo.total, moPrev.total, "vs last month") : null));
    var ys = d.getFullYear() + "-01-01";
    var on = aggregate("online", ys, t), tr = aggregate("trailer", ys, t);
    box.appendChild(tile("Online this year", fmtMoney0(on.total), null, on.count + " reports"));
    box.appendChild(tile(chCfg("trailer").label + " this year", fmtMoney0(tr.total), null, tr.count + " days"));
  }

  // ---------- Report form ----------
  function bindReport() {
    onSeg("report-channel", function (ch) {
      if (ch === state.report.channel) return;
      newReport(ch, $("f-start").value, $("f-end").value || $("f-start").value);
    });
    ["f-start", "f-end"].forEach(function (id) { $(id).addEventListener("change", onDatesChanged); });
    document.querySelectorAll("[data-quick]").forEach(function (b) {
      b.addEventListener("click", function () {
        var q = b.dataset.quick, t = today(), r;
        if (q === "yesterday") r = { start: addDays(t, -1), end: addDays(t, -1) };
        else if (q === "weekend") r = lastWeekend();
        else r = { start: t, end: t };
        $("f-start").value = r.start;
        $("f-end").value = r.end === r.start ? "" : r.end;
        onDatesChanged();
      });
    });
    $("report-form").addEventListener("input", function (e) {
      if (e.target.id !== "f-start" && e.target.id !== "f-end") updateReportCalc();
    });
    $("report-form").addEventListener("submit", function (e) { e.preventDefault(); saveReport(false); });
    $("btn-save-email").addEventListener("click", function () { saveReport(true); });
    $("btn-new").addEventListener("click", function () {
      var r = defaultRange();
      newReport(state.report.channel, r.start, r.end);
    });
    $("btn-delete").addEventListener("click", deleteReport);
    $("btn-pull").addEventListener("click", pullShopify);
    $("btn-copy").addEventListener("click", function () { copyText(reportEmail(readForm()).text); });
    $("btn-copy-rich").addEventListener("click", function () { var em = reportEmail(readForm()); copyRich(em.html, em.text); });
    $("btn-mail").addEventListener("click", openReportEmail);
    document.querySelectorAll(".email-compare").forEach(function (c) {
      c.checked = state.emailCompare;
      c.addEventListener("change", function () {
        state.emailCompare = c.checked;
        local(COMPARE_KEY, c.checked ? "1" : "0");
        updateReportCalc();
      });
    });
  }

  function formRange() {
    var s = $("f-start").value, e = $("f-end").value || s;
    return { start: s, end: e };
  }
  function renderCatInputs(ch) {
    var box = clear($("f-cats"));
    chCfg(ch).categories.forEach(function (c) {
      box.appendChild(el("label", { class: "field" }, [
        el("span", null, [c.label + " ($)", el("span", { class: "hint", "data-hint": c.key })]),
        el("input", { type: "text", inputmode: "decimal", "data-cat": c.key, class: "num" }),
      ]));
    });
  }
  function newReport(ch, s, e) {
    state.report = { channel: ch, id: null, source: "manual", sentAt: null };
    setSeg("report-channel", ch);
    renderCatInputs(ch);
    $("f-start").value = s || "";
    $("f-end").value = e && e !== s ? e : "";
    ["f-visits", "f-total", "f-ftc", "f-fts", "f-notes"].forEach(function (id) { $(id).value = ""; });
    applyChannelChrome(ch);
    var existing = s && findReport(ch, s, e || s);
    if (existing) fillReport(existing);
    else setEditing(null);
    msg("report-msg", "");
    msg("pull-msg", "");
    renderReportContext();
    updateReportCalc();
  }
  function applyChannelChrome(ch) {
    $("l-visits").textContent = chCfg(ch).visits_label;
    $("shopify-box").hidden = ch !== "online";
    $("ftc-box").hidden = ch !== "online";
  }
  function fillReport(r) {
    state.report = { channel: r.channel, id: r.id, source: r.source, sentAt: r.sent_at };
    setSeg("report-channel", r.channel);
    renderCatInputs(r.channel);
    applyChannelChrome(r.channel);
    $("f-start").value = r.start_date;
    $("f-end").value = r.end_date === r.start_date ? "" : r.end_date;
    $("f-visits").value = r.visits == null ? "" : r.visits;
    $("f-total").value = r.total;
    document.querySelectorAll("#f-cats [data-cat]").forEach(function (i) {
      var v = r.categories[i.dataset.cat];
      i.value = v == null ? "" : v;
    });
    $("f-ftc").value = r.first_time_customers == null ? "" : r.first_time_customers;
    $("f-fts").value = r.first_time_spend == null ? "" : r.first_time_spend;
    $("ftc-box").open = r.first_time_customers != null;
    $("f-notes").value = r.notes || "";
    setEditing(r);
    renderReportContext();
    updateReportCalc();
  }
  function setEditing(r) {
    var b = $("report-banner");
    $("btn-delete").hidden = !r;
    $("report-title").textContent = r ? "Edit report" : "New report";
    if (r) {
      var src = r.source === "excel" ? " Imported from the old spreadsheet." : r.source === "shopify" ? " Filled in automatically from last night's Shopify pull; check it, then email it." : r.source === "shopify-edited" ? " Started from the nightly Shopify pull, then edited." : "";
      b.textContent = "Saved report." + src + " Changes update it.";
      b.hidden = false;
    } else b.hidden = true;
    $("sent-note").textContent = r && r.sent_at ? "Emailed " + new Date(r.sent_at).toLocaleString() : "";
  }
  function onDatesChanged() {
    var r = formRange();
    if (!r.start) return updateReportCalc();
    if (r.end < r.start) { $("f-end").value = ""; r.end = r.start; }
    var existing = findReport(state.report.channel, r.start, r.end);
    if (existing) { fillReport(existing); msg("pull-msg", ""); renderReportContext(); return; }
    if (state.report.id) { newReport(state.report.channel, r.start, r.end); renderReportContext(); return; }
    msg("pull-msg", "");
    renderReportContext();
    updateReportCalc();
  }

  // Event strip + last event's same-day numbers as hints on the trailer form.
  function reportEventContext() {
    var r = formRange();
    if (state.report.channel !== "trailer" || !r.start) return null;
    var ev = eventOn(r.start);
    if (!ev) return null;
    var idx = dayDiff(ev.start_date, r.start), cmp = compareEventFor(ev);
    var cmpDate = cmp ? addDays(cmp.start_date, idx) : null;
    var cmpRep = cmpDate && cmpDate <= cmp.end_date ? findReport("trailer", cmpDate, cmpDate) : null;
    return { ev: ev, idx: idx, days: eventDays(ev).length, cmp: cmp, cmpRep: cmpRep };
  }
  function renderReportContext() {
    var ctx = reportEventContext(), strip = $("report-event");
    document.querySelectorAll("[data-hint]").forEach(function (h) { h.textContent = ""; });
    if (!ctx) { strip.hidden = true; return; }
    clear(strip).hidden = false;
    strip.appendChild(el("span", null, [el("strong", { text: ctx.ev.name }), " · Day " + (ctx.idx + 1) + " of " + ctx.days]));
    strip.appendChild(el("a", { href: "#", text: "Event mode →", onclick: function (e) { e.preventDefault(); openEvent(ctx.ev.id); } }));
    if (ctx.cmpRep) {
      var yr = (ctx.cmp.name.match(/\b(19|20)\d{2}\b/) || [ctx.cmp.name])[0];
      document.querySelectorAll("[data-hint]").forEach(function (h) {
        var v = ctx.cmpRep.categories[h.dataset.hint];
        h.textContent = v ? yr + ": " + fmtCompact(v) : "";
      });
    }
  }

  function readForm() {
    var r = formRange();
    var cats = {}, bad = [];
    document.querySelectorAll("#f-cats [data-cat]").forEach(function (i) {
      var n = toNum(i.value);
      if (Number.isNaN(n)) bad.push(i);
      cats[i.dataset.cat] = n == null || Number.isNaN(n) ? 0 : round2(n);
    });
    var total = toNum($("f-total").value), visits = toNum($("f-visits").value);
    var ftc = toNum($("f-ftc").value), fts = toNum($("f-fts").value);
    [["f-total", total], ["f-visits", visits], ["f-ftc", ftc], ["f-fts", fts]].forEach(function (p) {
      if (Number.isNaN(p[1])) bad.push($(p[0]));
    });
    var t = Number.isNaN(total) || total == null ? 0 : round2(total);
    return {
      channel: state.report.channel, start: r.start, end: r.end,
      visits: visits == null || Number.isNaN(visits) ? null : Math.round(visits),
      total: t, totalMissing: total == null,
      categories: cats, other: round2(t - sumCats(cats)),
      ftc: ftc == null || Number.isNaN(ftc) ? null : Math.round(ftc),
      fts: fts == null || Number.isNaN(fts) ? null : round2(fts),
      notes: $("f-notes").value.trim(), bad: bad,
    };
  }
  function reportEmail(d) {
    var cfg = chCfg(d.channel);
    var range = d.start ? rangeText(d.start, d.end) : "";
    var cmp = state.emailCompare && d.start ? lastWeek(d.channel, d.start, d.end) : null;
    var doc = { header: range ? range + " (" + cfg.label + ")" : "(" + cfg.label + ")", sections: [{ rows: reportRows(cfg, d, cmp) }] };
    return { to: cfg.to || "", cc: cfg.cc || "", subject: (cfg.subject_prefix || "") + (range || cfg.label), text: emailText(doc), html: emailHtml(doc) };
  }
  function updateReportCalc() {
    var d = readForm();
    $("f-other").textContent = fmtMoney(d.other);
    var neg = d.other < -0.004;
    $("f-other").parentNode.classList.toggle("bad", neg);
    $("other-warn").hidden = !neg;
    document.querySelectorAll("#report-form input").forEach(function (i) { i.removeAttribute("aria-invalid"); });
    d.bad.forEach(function (i) { i.setAttribute("aria-invalid", "true"); });
    // How this compares, while you type.
    var line = $("f-compare"), cmpText = null;
    if (d.start && !d.totalMissing) {
      var ctx = reportEventContext();
      if (ctx && ctx.cmpRep) cmpText = [deltaEl(d.total, ctx.cmpRep.total, "vs " + ctx.cmp.name + " day " + (ctx.idx + 1)), " (" + fmtMoney(ctx.cmpRep.total) + ")"];
      else {
        var prev = lastWeek(d.channel, d.start, d.end);
        if (prev) cmpText = [deltaEl(d.total, prev.total, "vs last week"), " (" + fmtMoney(prev.total) + ")"];
      }
    }
    clear(line).hidden = !cmpText;
    if (cmpText) cmpText.forEach(function (n) { if (n) line.appendChild(typeof n === "string" ? document.createTextNode(n) : n); });
    showEmail("e", reportEmail(d));
  }

  function saveReport(thenEmail) {
    var d = readForm();
    if (!d.start) return msg("report-msg", "Pick a start date.", "err");
    if (d.totalMissing) return msg("report-msg", "Enter the total.", "err");
    if (d.bad.length) { d.bad[0].focus(); return msg("report-msg", "That doesn't look like a number.", "err"); }
    var row = {
      id: state.report.id, channel: d.channel, start_date: d.start, end_date: d.end,
      visits: d.visits, total: d.total, categories: d.categories,
      first_time_customers: d.channel === "online" ? d.ftc : null,
      first_time_spend: d.channel === "online" ? d.fts : null,
      notes: d.notes,
      // Saving an auto-created report by hand marks it edited, so the nightly pull won't overwrite it.
      source: state.report.id && state.report.source === "shopify" ? "shopify-edited" : state.report.source,
    };
    msg("report-msg", "Saving…");
    // Open the mail window now, inside the click, so pop-up blockers allow it.
    var em = thenEmail ? reportEmail(d) : null;
    if (em) openMail(em);
    call("sales_save_report", { p_row: row }).then(function (res) {
      if (res.state === "duplicate") throw new Error("A report for these dates already exists. Open it from the Log.");
      if (res.state !== "ok") throw new Error("Couldn't save (" + res.state + ").");
      return (em ? call("sales_mark_sent", { p_id: res.id }) : Promise.resolve()).then(function () { return res.id; });
    }).then(function (id) {
      return load().then(function () {
        var saved = reportById(id);
        if (saved) fillReport(saved);
        renderReportContext();
        msg("report-msg", em ? "Saved and opened in your email app." : "Saved.", "ok");
        toast("Report saved");
      });
    }).catch(function (err) { if (err.message !== "auth") msg("report-msg", err.message, "err"); });
  }
  function openReportEmail() {
    openMail(reportEmail(readForm()));
    if (state.report.id) {
      var id = state.report.id;
      call("sales_mark_sent", { p_id: id }).then(load).then(function () {
        var r = reportById(id);
        if (r) $("sent-note").textContent = "Emailed " + new Date(r.sent_at).toLocaleString();
      }).catch(function () {});
    }
  }
  function deleteReport() {
    if (!state.report.id) return;
    var r = formRange();
    if (!confirm("Delete the " + chCfg(state.report.channel).label + " report for " + rangeText(r.start, r.end) + "?")) return;
    call("sales_delete_report", { p_id: state.report.id }).then(function (res) {
      if (res !== "ok") throw new Error("Couldn't delete (" + res + ").");
      return load();
    }).then(function () {
      newReport(state.report.channel, r.start, r.end);
      toast("Report deleted");
    }).catch(function (err) { if (err.message !== "auth") msg("report-msg", err.message, "err"); });
  }
  function pullShopify() {
    var r = formRange();
    if (!r.start) return msg("pull-msg", "Pick the dates first.");
    msg("pull-msg", "Looking up…");
    $("btn-pull").disabled = true;
    call("sales_shopify_lookup", { p_start: r.start, p_end: r.end }).then(function (res) {
      if (!res.found) {
        msg("pull-msg", "No Shopify numbers for " + rangeText(r.start, r.end) + " yet. The nightly job pulls the previous day (Fri–Sun on Mondays).");
        return;
      }
      $("f-visits").value = res.visits == null ? "" : res.visits;
      $("f-total").value = res.total;
      document.querySelectorAll("#f-cats [data-cat]").forEach(function (i) {
        if (res.categories[i.dataset.cat] != null) i.value = res.categories[i.dataset.cat];
      });
      $("f-ftc").value = res.first_time_customers == null ? "" : res.first_time_customers;
      $("f-fts").value = res.first_time_spend == null ? "" : res.first_time_spend;
      state.report.source = "shopify";
      var when = res.fetched_at ? " (pulled " + new Date(res.fetched_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + ")" : "";
      msg("pull-msg", "Filled from Shopify: " + res.label + when + ". Check it, then save.");
      updateReportCalc();
    }).catch(function (err) { if (err.message !== "auth") msg("pull-msg", err.message); })
      .then(function () { $("btn-pull").disabled = false; });
  }

  // ---------- Log ----------
  function bindLog() {
    onSeg("log-channel", function (v) { state.logChannel = v; renderLog(); });
    onSeg("log-status", function (v) { state.logStatus = v; renderLog(); });
    $("log-month").addEventListener("change", function () { state.logMonth = $("log-month").value; renderLog(); });
    $("log-csv").addEventListener("click", downloadCsv);
  }
  function logRows() {
    return state.reports.filter(function (r) {
      if (state.logChannel !== "all" && r.channel !== state.logChannel) return false;
      if (state.logStatus === "unsent" && !needsSending(r)) return false;
      if (state.logStatus === "check" && !(r.other < -0.004)) return false;
      if (state.logMonth !== "all" && r.end_date.slice(0, 7) !== state.logMonth) return false;
      return true;
    });
  }
  function renderLog() {
    setSeg("log-channel", state.logChannel);
    setSeg("log-status", state.logStatus);
    var sel = clear($("log-month"));
    sel.appendChild(el("option", { value: "all", text: "All months" }));
    var months = {};
    state.reports.forEach(function (r) { months[r.end_date.slice(0, 7)] = true; });
    Object.keys(months).sort().reverse().forEach(function (m) {
      sel.appendChild(el("option", { value: m, text: MONTHS[+m.slice(5) - 1] + " " + m.slice(0, 4) }));
    });
    if (!months[state.logMonth]) state.logMonth = "all";
    sel.value = state.logMonth;

    var body = clear($("log-body")), rows = logRows();
    if (!rows.length) body.appendChild(el("tr", null, [el("td", { colspan: "5", class: "muted", text: "No reports match." })]));
    rows.forEach(function (r) {
      var status = el("td");
      if (r.other < -0.004) status.appendChild(statusChip("bad", "Check"));
      if (r.sent_at) status.appendChild(el("span", { class: "badge badge-muted", text: "Emailed" }));
      if (r.source !== "manual") status.appendChild(el("span", { class: "badge badge-muted", text: r.source === "excel" ? "Excel" : "Shopify" }));
      if (r.notes) status.appendChild(el("span", { class: "badge badge-muted", title: r.notes, text: "Note" }));
      var tr = el("tr", { tabindex: "0" }, [
        el("td", { text: niceRange(r.start_date, r.end_date) }),
        el("td", null, [el("span", { class: "badge badge-" + r.channel, text: chCfg(r.channel).label })]),
        el("td", { class: "num", text: fmtInt(r.visits) }),
        el("td", { class: "num", text: fmtMoney(r.total) }),
        status,
      ]);
      tr.addEventListener("click", function () { openReport(r); });
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter") openReport(r); });
      body.appendChild(tr);
    });
    var sum = rows.reduce(function (a, r) { return a + r.total; }, 0);
    $("log-foot").textContent = rows.length + (rows.length === 1 ? " report" : " reports") + " · " + fmtMoney(sum) + " total. Tap a row to open it.";
  }
  function downloadCsv() {
    var rows = logRows();
    var keys = [], labels = {};
    ["online", "trailer"].forEach(function (ch) {
      chCfg(ch).categories.forEach(function (c) { if (keys.indexOf(c.key) < 0) { keys.push(c.key); labels[c.key] = c.label; } });
    });
    var head = ["Channel", "Start date", "End date", "Visits / orders", "Total"].concat(keys.map(function (k) { return labels[k]; }))
      .concat(["Other", "First-time customers", "First-time spend", "Emailed at", "Source", "Notes"]);
    var lines = [head];
    rows.slice().reverse().forEach(function (r) {
      lines.push([chCfg(r.channel).label, r.start_date, r.end_date, r.visits == null ? "" : r.visits, r.total.toFixed(2)]
        .concat(keys.map(function (k) { return r.categories[k] == null ? "" : r.categories[k].toFixed(2); }))
        .concat([r.other.toFixed(2), r.first_time_customers == null ? "" : r.first_time_customers,
          r.first_time_spend == null ? "" : Number(r.first_time_spend).toFixed(2), r.sent_at || "", r.source, r.notes || ""]));
    });
    var csv = lines.map(function (l) {
      return l.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(",");
    }).join("\r\n");
    var a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "sick-sales-" + today() + ".csv" });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast("Downloaded " + rows.length + " reports");
  }

  // ---------- Totals ----------
  function bindTotals() {
    onSeg("totals-channel", function (ch) { state.totalsChannel = ch; renderTotals(); });
    document.querySelectorAll("[data-range]").forEach(function (b) {
      b.addEventListener("click", function () { setTotalsRange(b.dataset.range); renderTotals(); });
    });
    ["t-from", "t-to"].forEach(function (id) {
      $(id).addEventListener("change", function () {
        document.querySelectorAll("[data-range]").forEach(function (b) { b.classList.remove("on"); });
        renderTotals();
      });
    });
    $("t-copy").addEventListener("click", function () { copyText(totalsEmail().text); });
    $("t-copy-rich").addEventListener("click", function () { var em = totalsEmail(); copyRich(em.html, em.text); });
    $("t-mail").addEventListener("click", function () { openMail(totalsEmail()); });
  }
  function setTotalsRange(kind) {
    var t = today(), d = parse(t), from, to;
    if (kind === "this-week") { from = weekStart(t); to = addDays(from, 6); }
    else if (kind === "last-week") { from = addDays(weekStart(t), -7); to = addDays(from, 6); }
    else if (kind === "this-month") { from = ymd(new Date(d.getFullYear(), d.getMonth(), 1)); to = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
    else if (kind === "last-month") { from = ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)); to = ymd(new Date(d.getFullYear(), d.getMonth(), 0)); }
    else if (kind === "last-90") { from = addDays(t, -90); to = addDays(t, -1); }
    else { from = d.getFullYear() + "-01-01"; to = t; }
    $("t-from").value = from; $("t-to").value = to;
    document.querySelectorAll("[data-range]").forEach(function (b) { b.classList.toggle("on", b.dataset.range === kind); });
  }
  function seriesFor(cfg) {
    return cfg.categories.map(function (c, i) { return { key: c.key, name: c.label, color: i < 7 ? "var(--s" + (i + 1) + ")" : "var(--s-other)" }; })
      .concat([{ key: "other", name: "Other", color: "var(--s-other)" }]);
  }
  function totalsEmail() {
    var ch = state.totalsChannel, cfg = chCfg(ch);
    var from = $("t-from").value, to = $("t-to").value, a = aggregate(ch, from, to);
    var doc = { header: rangeText(from, to) + " (" + cfg.label + ")", sections: [{ rows: reportRows(cfg, {
      visits: a.visits, total: a.total, categories: a.categories, other: a.other,
    }, null, "Total " + cfg.visits_label.replace(/^Number of /i, "")) }] };
    return { to: cfg.to || "", cc: cfg.cc || "", subject: cfg.label + " Sales Summary — " + rangeText(from, to), text: emailText(doc), html: emailHtml(doc), agg: a };
  }
  function renderTotals() {
    setSeg("totals-channel", state.totalsChannel);
    var from = $("t-from").value, to = $("t-to").value;
    var ch = state.totalsChannel, cfg = chCfg(ch);
    if (!from || !to || to < from) { $("t-note").textContent = "Pick a valid date range."; return; }
    var em = totalsEmail(), a = em.agg;

    // Tiles
    var span = dayDiff(from, to) + 1;
    var prev = aggregate(ch, addDays(from, -span), addDays(from, -1));
    var ly = sameDaysLastYear(ch, from, to);
    var days = Object.keys(a.covered).length;
    var tiles = clear($("t-tiles"));
    tiles.appendChild(tile("Total sales", fmtMoney0(a.total), prev.count ? deltaEl(a.total, prev.total, "vs previous " + span + " days") : null, a.count + " reports"));
    tiles.appendChild(tile("Same dates last year", ly ? fmtMoney0(ly.total) : "—", ly ? deltaEl(a.total, ly.total, "this year") : null, ly ? null : "No data for last year yet"));
    tiles.appendChild(tile(cfg.visits_label.replace(/^Number of /i, ""), fmtInt(a.visits), prev.count && a.visits != null && prev.visits ? deltaEl(a.visits, prev.visits, "vs previous") : null));
    tiles.appendChild(tile("Per day with sales", days ? fmtMoney0(a.total / days) : "—", null, days + (days === 1 ? " day" : " days") + " covered"));

    // Chart: one bar per report for short ranges, per week for long ones.
    var series = seriesFor(cfg), buckets = [];
    var byWeek = span > 45 || a.count > 40;
    if (byWeek) {
      for (var w = weekStart(from); w <= to; w = addDays(w, 7)) {
        var wf = w < from ? from : w, wt = addDays(w, 6) > to ? to : addDays(w, 6), wa = aggregate(ch, wf, wt);
        buckets.push({ label: md(w), title: "Week of " + niceDate(w) + (wa.count ? "" : " (no reports)"), agg: wa });
      }
    } else {
      a.rows.slice().sort(function (x, y) { return x.end_date.localeCompare(y.end_date); }).forEach(function (r) {
        var cats = {};
        cfg.categories.forEach(function (c) { cats[c.key] = r.categories[c.key] || 0; });
        buckets.push({ label: r.start_date === r.end_date ? md(r.start_date) : md(r.start_date) + "–" + md(r.end_date).split("/")[1], title: niceRange(r.start_date, r.end_date), agg: { categories: cats, other: r.other, total: r.total } });
      });
    }
    $("t-chart-title").textContent = byWeek ? "Sales by week" : "Sales by report";
    columnChart($("t-chart"), {
      labels: buckets.map(function (b) { return b.label; }),
      titles: buckets.map(function (b) { return b.title; }),
      series: series.map(function (s) {
        return { name: s.name, color: s.color, values: buckets.map(function (b) { return s.key === "other" ? b.agg.other : b.agg.categories[s.key] || 0; }) };
      }),
      totals: buckets.map(function (b) { return b.agg.total; }),
      stacked: true, height: 240,
    });

    // Category mix
    var mix = clear($("t-mix"));
    var parts = series.map(function (s) { return { name: s.name, color: s.color, value: s.key === "other" ? a.other : a.categories[s.key] }; })
      .sort(function (x, y) { return x.name === "Other" ? 1 : y.name === "Other" ? -1 : y.value - x.value; });
    var maxPart = Math.max.apply(null, parts.map(function (p) { return p.value; }).concat([1]));
    if (!a.total) mix.appendChild(el("p", { class: "chart-empty", text: "No sales in this range." }));
    else parts.forEach(function (p) {
      var share = a.total ? p.value / a.total : 0;
      mix.appendChild(el("div", { class: "mix-row" }, [
        el("span", { class: "mix-label", text: p.name }),
        el("div", { class: "mix-track" }, [el("div", { class: "mix-bar", style: "width:" + Math.max(0, p.value / maxPart * 100).toFixed(1) + "%;background:var(--s1)" })]),
        el("span", { class: "mix-val" }, [fmtMoney0(p.value), el("span", { text: Math.round(share * 100) + "%" })]),
      ]));
    });

    // Table (also the accessible view of the chart)
    var table = clear($("t-table")), tb = el("tbody");
    tb.appendChild(el("tr", null, [el("td", { text: cfg.visits_label }), el("td", { class: "num", text: fmtInt(a.visits) })]));
    series.forEach(function (s) {
      tb.appendChild(el("tr", null, [
        el("td", null, [el("i", { class: "swatch", style: "background:" + s.color }), s.name]),
        el("td", { class: "num", text: fmtMoney(s.key === "other" ? a.other : a.categories[s.key]) }),
      ]));
    });
    tb.appendChild(el("tr", { class: "total" }, [el("td", { text: "Total" }), el("td", { class: "num", text: fmtMoney(a.total) })]));
    table.appendChild(tb);

    var lastDay = to < today() ? to : addDays(today(), -1), missing = 0;
    for (var d = from; d <= lastDay; d = addDays(d, 1)) if (!a.covered[d]) missing++;
    var note = a.count + (a.count === 1 ? " report" : " reports") + " in this range.";
    if (missing && ch === "online") note += " " + missing + (missing === 1 ? " day has" : " days have") + " no report, so the totals may be short.";
    $("t-note").textContent = note;
    showEmail("te", em);
  }

  // ---------- Events list ----------
  function bindEvents() {
    $("event-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var row = { id: state.editingEventId, name: $("ev-name").value.trim(), start_date: $("ev-start").value, end_date: $("ev-end").value, notes: $("ev-notes").value.trim() };
      if (!row.name || !row.start_date || !row.end_date) return msg("event-msg", "Name, start and end are required.", "err");
      if (row.end_date < row.start_date) return msg("event-msg", "End is before start.", "err");
      call("sales_save_event", { p_row: row }).then(function (res) {
        if (res.state !== "ok") throw new Error("Couldn't save (" + res.state + ").");
        return load();
      }).then(function () { resetEventForm(); renderEvents(); toast("Event saved"); })
        .catch(function (err) { if (err.message !== "auth") msg("event-msg", err.message, "err"); });
    });
    $("ev-cancel").addEventListener("click", resetEventForm);
    $("ev-delete").addEventListener("click", function () {
      if (!state.editingEventId || !confirm("Delete this event? Reports are not affected.")) return;
      call("sales_delete_event", { p_id: state.editingEventId }).then(load)
        .then(function () { resetEventForm(); renderEvents(); toast("Event deleted"); })
        .catch(function (err) { if (err.message !== "auth") msg("event-msg", err.message, "err"); });
    });
  }
  function resetEventForm() {
    state.editingEventId = null;
    $("event-form").reset();
    $("event-form-title").textContent = "Add event";
    $("ev-cancel").hidden = true; $("ev-delete").hidden = true;
    msg("event-msg", "");
  }
  function editEvent(ev) {
    state.editingEventId = ev.id;
    $("ev-name").value = ev.name; $("ev-start").value = ev.start_date; $("ev-end").value = ev.end_date; $("ev-notes").value = ev.notes || "";
    $("event-form-title").textContent = "Edit event";
    $("ev-cancel").hidden = false; $("ev-delete").hidden = false;
    msg("event-msg", "");
    $("ev-name").focus();
  }
  function renderEvents() {
    var list = clear($("events-list"));
    if (!state.events.length) list.appendChild(el("div", { class: "card muted", text: "No events yet. Add one to track its sales." }));
    state.events.forEach(function (ev) {
      var parts = [], grand = 0;
      ["trailer", "online"].forEach(function (ch) {
        var a = aggregate(ch, ev.start_date, ev.end_date);
        if (!a.count) return;
        grand += a.total;
        var cfg = chCfg(ch), grid = el("div", { class: "event-grid" });
        grid.appendChild(el("div", null, [el("span", { text: cfg.visits_label }), fmtInt(a.visits)]));
        cfg.categories.forEach(function (c) { grid.appendChild(el("div", null, [el("span", { text: c.label }), fmtMoney(a.categories[c.key])])); });
        grid.appendChild(el("div", null, [el("span", { text: "Other" }), fmtMoney(a.other)]));
        grid.appendChild(el("div", null, [el("span", { text: "Total" }), el("strong", { text: fmtMoney(a.total) })]));
        parts.push(el("div", { class: "event-sub", text: cfg.label + " · " + a.count + (a.count === 1 ? " report" : " reports") }));
        parts.push(grid);
      });
      list.appendChild(el("div", { class: "card" }, [
        el("div", { class: "event-head" }, [el("h2", { text: ev.name }), el("span", { class: "event-total", text: fmtMoney(grand) })]),
        el("div", { class: "muted small", text: niceRange(ev.start_date, ev.end_date) + (ev.notes ? " · " + ev.notes : "") }),
      ].concat(parts.length ? parts : [el("p", { class: "muted small", text: "No reports in these dates yet." })]).concat([
        el("div", { class: "event-actions" }, [
          el("button", { type: "button", class: "btn btn-primary btn-sm", text: "Open event mode", onclick: function () { openEvent(ev.id); } }),
          el("button", { type: "button", class: "btn btn-sm btn-ghost", text: "Edit", onclick: function () { editEvent(ev); } }),
        ]),
      ])));
    });
  }

  // ---------- Event mode ----------
  function bindEventMode() {
    $("ev-compare").addEventListener("change", function () {
      var v = $("ev-compare").value;
      state.eventCompareId = v === "" ? null : Number(v);
      renderEventMode();
    });
    $("ee-copy").addEventListener("click", function () { copyText(eventEmail().text); });
    $("ee-copy-rich").addEventListener("click", function () { var em = eventEmail(); copyRich(em.html, em.text); });
    $("ee-mail").addEventListener("click", function () { openMail(eventEmail()); });
  }
  function openEvent(id) { state.eventId = id; state.eventCompareId = undefined; showTab("event"); }
  function eventCompare(ev) {
    if (state.eventCompareId === null) return null;
    if (state.eventCompareId !== undefined) return eventById(state.eventCompareId) || null;
    return compareEventFor(ev);
  }
  function eventEmail() {
    var ev = eventById(state.eventId), cmp = eventCompare(ev);
    var sections = [], grand = 0, cmpGrand = 0;
    ["trailer", "online"].forEach(function (ch) {
      var a = aggregate(ch, ev.start_date, ev.end_date);
      if (!a.count) return;
      var c = cmp ? aggregate(ch, cmp.start_date, cmp.end_date) : null;
      grand += a.total; if (c) cmpGrand += c.total;
      var rows = reportRows(chCfg(ch), a, null, "Total " + chCfg(ch).visits_label.replace(/^Number of /i, ""));
      if (c && c.count) rows[rows.length - 1].note = deltaText(a.total, c.total) + " vs " + cmp.name;
      sections.push({ title: chCfg(ch).label, rows: rows });
    });
    sections.push({ title: "Event total", rows: [{ label: "Total", value: emailMoney(grand), strong: true, note: cmp && cmpGrand ? deltaText(grand, cmpGrand) + " vs " + cmp.name : null }] });
    var cfg = chCfg("trailer");
    var doc = { header: ev.name + " — " + rangeText(ev.start_date, ev.end_date), sections: sections };
    return { to: cfg.to || "", cc: cfg.cc || "", subject: ev.name + " Sales Summary", text: emailText(doc), html: emailHtml(doc) };
  }
  function renderEventMode() {
    var ev = eventById(state.eventId);
    if (!ev) { showTab("events"); return; }
    var cmp = eventCompare(ev), days = eventDays(ev), t = today();
    $("ev-title").textContent = ev.name;
    $("ev-sub").textContent = niceRange(ev.start_date, ev.end_date) + " · " + days.length + " days" + (ev.notes ? " · " + ev.notes : "");

    var sel = clear($("ev-compare"));
    sel.appendChild(el("option", { value: "", text: "Nothing" }));
    state.events.filter(function (e) { return e.id !== ev.id; }).forEach(function (e) { sel.appendChild(el("option", { value: String(e.id), text: e.name })); });
    sel.value = cmp ? String(cmp.id) : "";

    var tr = aggregate("trailer", ev.start_date, ev.end_date), on = aggregate("online", ev.start_date, ev.end_date);
    var ctr = cmp ? aggregate("trailer", cmp.start_date, cmp.end_date) : null, con = cmp ? aggregate("online", cmp.start_date, cmp.end_date) : null;
    var vs = cmp ? "vs " + cmp.name : "";
    var tiles = clear($("ev-tiles"));
    tiles.appendChild(tile(chCfg("trailer").label + " sales", fmtMoney0(tr.total), ctr && ctr.count ? deltaEl(tr.total, ctr.total, vs) : null, tr.count + " of " + days.length + " days entered"));
    tiles.appendChild(tile(chCfg("trailer").visits_label, fmtInt(tr.visits), ctr && ctr.visits && tr.visits != null ? deltaEl(tr.visits, ctr.visits, vs) : null));
    tiles.appendChild(tile("Online during event", fmtMoney0(on.total), con && con.count ? deltaEl(on.total, con.total, vs) : null, on.count + " reports"));
    tiles.appendChild(tile("Event total", fmtMoney0(tr.total + on.total), cmp && (ctr.total + con.total) ? deltaEl(tr.total + on.total, ctr.total + con.total, vs) : null));

    // Day strip
    var strip = clear($("ev-days"));
    days.forEach(function (d, i) {
      var r = trailerDay(d), single = r && r.start_date === r.end_date;
      var cd = cmp ? addDays(cmp.start_date, i) : null;
      var cr = cd && cd <= cmp.end_date ? findReport("trailer", cd, cd) : null;
      var kids = [el("div", { class: "day-name", text: "Day " + (i + 1) + " · " + DOW[parse(d).getDay()] + " " + md(d) })];
      if (single) {
        kids.push(el("div", { class: "day-value", text: fmtMoney0(r.total) }));
        if (cr) kids.push(el("div", { class: "day-cmp" }, [deltaEl(r.total, cr.total)]));
      } else if (r) kids.push(el("div", { class: "day-missing", text: "In " + md(r.start_date) + "–" + md(r.end_date) + " report" }));
      else kids.push(el("div", { class: "day-missing", text: d > t ? "Upcoming" : "Tap to enter" }));
      strip.appendChild(el("button", { type: "button", class: "day" + (r ? " done" : "") + (d === t ? " today" : ""), onclick: function () { if (r && !single) openReport(r); else openTrailerDay(d); } }, kids));
    });

    // Category comparison
    var cfg = chCfg("trailer"), series = seriesFor(cfg);
    var labels = series.map(function (s) { return s.name; });
    var val = function (a, s) { return s.key === "other" ? a.other : a.categories[s.key] || 0; };
    var chartSeries = [{ name: ev.name, color: "var(--s1)", values: series.map(function (s) { return val(tr, s); }) }];
    if (ctr && ctr.count) chartSeries.push({ name: cmp.name, color: "var(--s2)", values: series.map(function (s) { return val(ctr, s); }) });
    columnChart($("ev-chart"), { labels: labels, titles: labels, series: chartSeries, grouped: true, height: 230 });

    var table = clear($("ev-table"));
    var head = el("tr", null, [el("th", { text: "Category" }), el("th", { class: "num", text: ev.name })]);
    if (chartSeries.length > 1) { head.appendChild(el("th", { class: "num", text: cmp.name })); head.appendChild(el("th", { class: "num", text: "Change" })); }
    table.appendChild(el("thead", null, [head]));
    var tb = el("tbody");
    series.concat([{ key: "total", name: "Total" }]).forEach(function (s) {
      var cur = s.key === "total" ? tr.total : val(tr, s);
      var row = el("tr", { class: s.key === "total" ? "total" : null }, [el("td", { text: s.name }), el("td", { class: "num", text: fmtMoney0(cur) })]);
      if (chartSeries.length > 1) {
        var old = s.key === "total" ? ctr.total : val(ctr, s);
        row.appendChild(el("td", { class: "num", text: fmtMoney0(old) }));
        row.appendChild(el("td", { class: "num" }, [deltaEl(cur, old) || "—"]));
      }
      tb.appendChild(row);
    });
    table.appendChild(tb);
    showEmail("ee", eventEmail());
  }

  // ---------- Settings ----------
  function bindSettings() {
    onSeg("settings-channel", function (ch) { captureSettings(); state.settingsChannel = ch; renderSettingsChannel(); });
    $("s-add-cat").addEventListener("click", function () {
      captureSettings();
      state.settingsDraft[state.settingsChannel].categories.push({ key: "", label: "" });
      renderSettingsChannel();
      var inputs = document.querySelectorAll("#s-cats input");
      inputs[inputs.length - 1].focus();
    });
    $("settings-form").addEventListener("submit", function (e) {
      e.preventDefault();
      captureSettings();
      var draft = state.settingsDraft, problem = null;
      ["online", "trailer"].forEach(function (ch) {
        var cfg = draft[ch], used = {};
        cfg.categories = cfg.categories.filter(function (c) { return c.label.trim(); });
        cfg.categories.forEach(function (c) {
          c.label = c.label.trim();
          if (!c.key) c.key = slug(c.label, used);
          if (used[c.key]) problem = "Two " + cfg.label + " categories have the same name.";
          used[c.key] = true;
        });
        if (!cfg.label.trim()) problem = "Channel name can't be blank.";
        cfg.email_order = emailOrder(cfg);
      });
      if (problem) return msg("settings-msg", problem, "err");
      call("sales_save_channels", { p_channels: draft }).then(function (res) {
        if (res !== "ok") throw new Error("Couldn't save (" + res + ").");
        return load();
      }).then(function () {
        renderSettings();
        applyChannelLabels();
        var r = formRange();
        if (!state.report.id) newReport(state.report.channel, r.start, r.end);
        else { var cur = reportById(state.report.id); if (cur) fillReport(cur); else newReport(state.report.channel, r.start, r.end); }
        msg("settings-msg", "Saved.", "ok");
      }).catch(function (err) { if (err.message !== "auth") msg("settings-msg", err.message, "err"); });
    });
    $("pin-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var a = $("pin-new").value, b = $("pin-new2").value;
      if (a.length < 4) return msg("pin-msg", "Use at least 4 characters.", "err");
      if (a !== b) return msg("pin-msg", "The two PINs don't match.", "err");
      call("sales_change_pin", { p_new_pin: a }).then(function (res) {
        if (res !== "ok") throw new Error("Couldn't change PIN (" + res + ").");
        var remembered = !!local(PIN_KEY);
        state.pin = a;
        if (remembered) local(PIN_KEY, a);
        $("pin-form").reset();
        msg("pin-msg", "PIN changed.", "ok");
      }).catch(function (err) { if (err.message !== "auth") msg("pin-msg", err.message, "err"); });
    });
    $("btn-logout").addEventListener("click", function () { logout(""); });
  }
  function slug(label, used) {
    var base = label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "cat", k = base, i = 2;
    while (used[k]) k = base + i++;
    return k;
  }
  function renderSettings() {
    state.settingsDraft = JSON.parse(JSON.stringify(state.channels));
    msg("settings-msg", ""); msg("pin-msg", "");
    renderSettingsChannel();
  }
  function renderSettingsChannel() {
    var cfg = state.settingsDraft[state.settingsChannel];
    setSeg("settings-channel", state.settingsChannel);
    $("s-label").value = cfg.label || "";
    $("s-to").value = cfg.to || "";
    $("s-cc").value = cfg.cc || "";
    $("s-subject").value = cfg.subject_prefix || "";
    $("s-visits").value = cfg.visits_label || "";
    var box = clear($("s-cats"));
    cfg.categories.forEach(function (c, i) {
      box.appendChild(el("div", { class: "cat-row" }, [
        el("input", { type: "text", value: c.label, "data-i": String(i), "aria-label": "Category name" }),
        el("button", { type: "button", class: "btn btn-ghost btn-sm", text: "Remove", onclick: function () {
          captureSettings();
          cfg.categories.splice(i, 1);
          renderSettingsChannel();
        } }),
      ]));
    });
  }
  function captureSettings() {
    if (!state.settingsDraft) return;
    var cfg = state.settingsDraft[state.settingsChannel];
    cfg.label = $("s-label").value.trim() || cfg.label;
    cfg.to = $("s-to").value.trim();
    cfg.cc = $("s-cc").value.trim();
    cfg.subject_prefix = $("s-subject").value;
    cfg.visits_label = $("s-visits").value.trim() || cfg.visits_label;
    document.querySelectorAll("#s-cats input").forEach(function (inp) {
      cfg.categories[+inp.dataset.i].label = inp.value;
    });
  }

  // ---------- charts ----------
  // Column chart in plain SVG: stacked, grouped or single series. Thin bars (<=24px), 2px surface gaps,
  // 4px rounded tops, hairline grid, a legend for 2+ series, and a hover/focus tooltip per column.
  var SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) n.setAttribute(k, attrs[k]); });
    return n;
  }
  function niceScale(max) {
    if (max <= 0) return { max: 1, step: 1 };
    var raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw))), steps = [1, 2, 2.5, 5, 10], step = mag;
    for (var i = 0; i < steps.length; i++) { if (steps[i] * mag >= raw) { step = steps[i] * mag; break; } }
    return { max: Math.ceil(max / step) * step, step: step };
  }
  function topRounded(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h) + "Z";
  }
  function columnChart(host, o) {
    clear(host);
    var n = o.labels.length;
    var any = o.series.some(function (s) { return s.values.some(function (v) { return v > 0; }); });
    if (!n || !any) { host.appendChild(el("p", { class: "chart-empty", text: "No sales to chart for this range." })); return; }
    var W = Math.max(280, host.clientWidth || 600), H = o.height || 220;
    var m = { l: 46, r: 6, t: 10, b: 26 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    var k = o.series.length;
    var max = 0;
    for (var i = 0; i < n; i++) {
      if (o.stacked) max = Math.max(max, o.series.reduce(function (a, s) { return a + Math.max(0, s.values[i]); }, 0));
      else o.series.forEach(function (s) { max = Math.max(max, s.values[i]); });
    }
    var sc = niceScale(max), y = function (v) { return m.t + ph - (v / sc.max) * ph; };
    var root = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": o.series.map(function (s) { return s.name; }).join(", ") + " chart" });
    for (var t = 0; t <= sc.max + 1e-9; t += sc.step) {
      root.appendChild(svg("line", { x1: m.l, x2: W - m.r, y1: Math.round(y(t)) + 0.5, y2: Math.round(y(t)) + 0.5, class: t === 0 ? "baseline" : "gridline" }));
      var lab = svg("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end", class: "tick" });
      lab.textContent = fmtCompact(t);
      root.appendChild(lab);
    }
    var band = pw / n, every = Math.ceil(n / Math.max(1, Math.floor(pw / 58)));
    var marks = [];
    for (var j = 0; j < n; j++) {
      var cx = m.l + band * j + band / 2, g = svg("g", { class: "mark", "data-i": j, opacity: o.faded && o.faded[j] ? 0.55 : null });
      if (o.stacked || k === 1) {
        var bw = Math.max(3, Math.min(24, band * 0.62)), acc = 0;
        var segs = o.series.map(function (s) { return { color: s.color, v: Math.max(0, s.values[j]) }; }).filter(function (s) { return s.v > 0; });
        segs.forEach(function (s, si) {
          var y0 = y(acc), y1 = y(acc + s.v), top = si === segs.length - 1;
          var h = y0 - y1 - (top ? 0 : 2);
          if (h > 0.4) {
            g.appendChild(top ? svg("path", { d: topRounded(cx - bw / 2, y1, bw, h, 4), fill: s.color })
              : svg("rect", { x: cx - bw / 2, y: y1 + 2, width: bw, height: h, fill: s.color }));
          }
          acc += s.v;
        });
      } else {
        var gw = Math.min(band * 0.8, 24 * k + 2 * (k - 1)), w1 = Math.max(3, (gw - 2 * (k - 1)) / k);
        o.series.forEach(function (s, si) {
          var v = Math.max(0, s.values[j]), x = cx - gw / 2 + si * (w1 + 2), yy = y(v), h = y(0) - yy;
          if (h > 0.4) g.appendChild(svg("path", { d: topRounded(x, yy, w1, h, 4), fill: s.color }));
        });
      }
      root.appendChild(g); marks.push(g);
      if (j % every === 0 || n <= 8) {
        var xl = svg("text", { x: cx, y: H - 8, "text-anchor": "middle", class: "tick" });
        xl.textContent = o.labels[j];
        root.appendChild(xl);
      }
      var hit = svg("rect", { x: m.l + band * j, y: m.t, width: band, height: ph, class: "hit", tabindex: "0", "data-i": j, "aria-label": o.titles ? o.titles[j] : o.labels[j] });
      root.appendChild(hit);
    }
    host.appendChild(root);
    function show(j, evt) {
      host.classList.add("hovering");
      marks.forEach(function (mk, idx) { mk.classList.toggle("lift", idx === j); });
      var rows = o.series.map(function (s) { return { name: s.name, color: s.color, value: fmtMoney(s.values[j]) }; });
      if (o.stacked && o.totals) rows.push({ name: "Total", value: fmtMoney(o.totals[j]), strong: true });
      showTip(evt, o.titles ? o.titles[j] : o.labels[j], rows);
    }
    function hide() { host.classList.remove("hovering"); marks.forEach(function (mk) { mk.classList.remove("lift"); }); hideTip(); }
    root.querySelectorAll(".hit").forEach(function (h) {
      var j = +h.getAttribute("data-i");
      h.addEventListener("pointermove", function (e) { show(j, e); });
      h.addEventListener("pointerleave", hide);
      h.addEventListener("focus", function () { tipAnchor = h; show(j, null); });
      h.addEventListener("blur", hide);
      h.addEventListener("click", function (e) { show(j, e); });
    });
    if (k > 1) {
      var legend = el("div", { class: "legend" });
      o.series.forEach(function (s) { legend.appendChild(el("span", null, [el("i", { style: "background:" + s.color }), s.name])); });
      host.appendChild(legend);
    }
  }
  var tipAnchor = null;
  function showTip(evt, title, rows) {
    var tip = $("tooltip");
    clear(tip).hidden = false;
    tip.appendChild(el("div", { class: "tt-title", text: title }));
    rows.forEach(function (r) {
      tip.appendChild(el("div", { class: "tt-row" }, [
        el("span", { class: "tt-key" }, [r.color ? el("i", { style: "background:" + r.color }) : null, r.name]),
        el("b", { text: r.value }),
      ]));
    });
    var x, yv;
    if (evt && evt.clientX != null) { x = evt.clientX; yv = evt.clientY; }
    else { var b = (tipAnchor || document.activeElement).getBoundingClientRect(); x = b.left + b.width / 2; yv = b.top + 20; }
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = x + 14 + tw > window.innerWidth - 8 ? x - tw - 14 : x + 14;
    var top = Math.max(8, Math.min(yv - th / 2, window.innerHeight - th - 8));
    tip.style.left = Math.max(8, left) + "px"; tip.style.top = top + "px";
  }
  function hideTip() { var tip = $("tooltip"); if (tip) tip.hidden = true; }
  document.addEventListener("scroll", hideTip, { passive: true });

  // ---------- boot ----------
  var saved = local(PIN_KEY);
  if (saved) {
    start(saved, true).catch(function (err) { if (err.message !== "auth") showLogin(err.message); });
  } else showLogin();
})();
