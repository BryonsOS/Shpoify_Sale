/* Sick Sales — daily online + merch trailer reports.
   Plain JS, no build step. All data goes through PIN-checked Supabase RPCs (see supabase/migrations). */
(function () {
  "use strict";

  var CFG = window.SALES_CONFIG;
  var PIN_KEY = "sickSales.pin";

  var state = {
    pin: null,
    channels: null,
    reports: [],
    events: [],
    report: { channel: "online", id: null, source: "manual", sentAt: null },
    logChannel: "all",
    totalsChannel: "online",
    settingsChannel: "online",
    settingsDraft: null,
    editingEventId: null,
  };

  // ---------- small helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "class") n.className = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function store(get, val) {
    try {
      if (get) return localStorage.getItem(PIN_KEY);
      if (val == null) localStorage.removeItem(PIN_KEY); else localStorage.setItem(PIN_KEY, val);
    } catch (e) { return null; }
  }

  // Dates are plain "YYYY-MM-DD" strings in local time.
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parse(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
  function today() { return ymd(new Date()); }
  function dayDiff(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function shortDate(s) { var d = parse(s); return (d.getMonth() + 1) + "-" + d.getDate() + "-" + String(d.getFullYear()).slice(2); }
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function niceDate(s) { var d = parse(s); return DOW[d.getDay()] + " " + (d.getMonth() + 1) + "/" + d.getDate() + "/" + String(d.getFullYear()).slice(2); }
  function rangeText(a, b) { return a === b ? shortDate(a) : shortDate(a) + " to " + shortDate(b); }

  // The normal cadence: Monday reports cover Fri–Sun, other days cover yesterday.
  function defaultRange() {
    var t = today(), dow = parse(t).getDay();
    if (dow === 1) return { start: addDays(t, -3), end: addDays(t, -1) };
    return { start: addDays(t, -1), end: addDays(t, -1) };
  }
  function lastWeekend() {
    var t = today(), dow = parse(t).getDay();
    var back = dow === 0 ? 7 : dow; // most recent Sunday strictly before today
    var sun = addDays(t, -back);
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
  function emailMoney(n) { n = round2(Number(n) || 0); return n === 0 ? "$0" : fmtMoney(n); }
  function fmtInt(n) { return n == null || n === "" ? "—" : whole.format(Number(n)); }

  function toast(text) {
    var t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 2200);
  }
  function msg(id, text, kind) { var m = $(id); m.textContent = text || ""; m.className = "msg" + (kind ? " " + kind : ""); }

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
    store(false, null);
    showLogin(text);
  }
  function start(pin, remember) {
    state.pin = pin;
    return load().then(function () {
      if (remember) store(false, pin);
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

  // ---------- tabs ----------
  var booted = false;
  function initApp() {
    if (!booted) {
      booted = true;
      document.querySelectorAll(".tab").forEach(function (b) {
        b.addEventListener("click", function () { showTab(b.dataset.tab); });
      });
      bindReport(); bindLog(); bindTotals(); bindEvents(); bindSettings();
      var r = defaultRange();
      newReport("online", r.start, r.end);
      setTotalsRange("this-week");
    }
    showTab("report");
  }
  function showTab(name) {
    document.querySelectorAll(".tab").forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === name)); });
    document.querySelectorAll(".view").forEach(function (v) { v.hidden = v.dataset.view !== name; });
    if (name === "log") renderLog();
    if (name === "totals") renderTotals();
    if (name === "events") renderEvents();
    if (name === "settings") renderSettings();
    window.scrollTo(0, 0);
  }
  function setSeg(id, value) {
    document.querySelectorAll("#" + id + " button").forEach(function (b) { b.classList.toggle("on", b.dataset.channel === value); });
  }
  function onSeg(id, fn) {
    document.querySelectorAll("#" + id + " button").forEach(function (b) {
      b.addEventListener("click", function () { fn(b.dataset.channel); });
    });
  }

  function chCfg(ch) { return state.channels[ch]; }
  function emailOrder(cfg) {
    var keys = cfg.categories.map(function (c) { return c.key; });
    var order = (cfg.email_order || []).filter(function (k) { return k === "visits" || k === "other" || k === "total" || keys.indexOf(k) >= 0; });
    keys.forEach(function (k) { if (order.indexOf(k) < 0) order.splice(Math.max(order.indexOf("other"), 0), 0, k); });
    ["visits", "other", "total"].forEach(function (k) { if (order.indexOf(k) < 0) k === "visits" ? order.unshift(k) : order.push(k); });
    return order;
  }
  function emailLines(cfg, d) {
    var labels = {};
    cfg.categories.forEach(function (c) { labels[c.key] = c.label; });
    return emailOrder(cfg).map(function (k) {
      if (k === "visits") return (d.visitsLabel || cfg.visits_label) + " " + (d.visits == null ? "—" : whole.format(d.visits));
      if (k === "other") return "Other " + emailMoney(d.other);
      if (k === "total") return "Total " + emailMoney(d.total);
      return labels[k] + " " + emailMoney(d.categories[k]);
    });
  }
  function recipients(s) {
    return (s || "").split(/[;,\n]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function mailtoHref(to, cc, subject, body) {
    var q = [];
    if (recipients(cc).length) q.push("cc=" + recipients(cc).map(encodeURIComponent).join(","));
    q.push("subject=" + encodeURIComponent(subject));
    q.push("body=" + encodeURIComponent(body.replace(/\n/g, "\r\n")));
    return "mailto:" + recipients(to).map(encodeURIComponent).join(",") + "?" + q.join("&");
  }
  function copyText(text) {
    function fallback() {
      var ta = el("textarea", { readonly: "" });
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0"; ta.style.top = "0";
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? "Copied" : "Couldn't copy. Select the text and press Ctrl/Cmd+C.");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, fallback);
    } else fallback();
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
    $("btn-copy").addEventListener("click", function () { copyText($("e-body").textContent); });
    $("btn-mail").addEventListener("click", function () { openReportEmail(); });
  }

  function formRange() {
    var s = $("f-start").value, e = $("f-end").value || s;
    return { start: s, end: e };
  }
  function findReport(ch, s, e) {
    return state.reports.filter(function (r) { return r.channel === ch && r.start_date === s && r.end_date === e; })[0];
  }

  function renderCatInputs(ch) {
    var box = $("f-cats");
    box.innerHTML = "";
    chCfg(ch).categories.forEach(function (c) {
      box.appendChild(el("label", { class: "field" }, [
        el("span", { text: c.label + " ($)" }),
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
    updateReportCalc();
  }
  function applyChannelChrome(ch) {
    var cfg = chCfg(ch);
    $("l-visits").textContent = cfg.visits_label;
    $("shopify-box").hidden = ch !== "online";
    $("ftc-row").hidden = ch !== "online";
    $("f-total").classList.add("num");
    $("f-visits").classList.add("num");
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
    $("f-notes").value = r.notes || "";
    setEditing(r);
    updateReportCalc();
  }
  function setEditing(r) {
    var b = $("report-banner");
    $("btn-delete").hidden = !r;
    $("report-title").textContent = r ? "Edit report" : "New report";
    if (r) {
      var src = r.source === "excel" ? " Imported from the old spreadsheet." : r.source === "shopify" ? " Filled from the nightly Shopify pull." : "";
      b.textContent = "A report for these dates is already saved. Changes will update it." + src;
      b.className = "banner info";
      b.hidden = false;
    } else b.hidden = true;
    $("sent-note").textContent = r && r.sent_at ? "Emailed " + new Date(r.sent_at).toLocaleString() : "";
  }
  function onDatesChanged() {
    var r = formRange();
    if (!r.start) return updateReportCalc();
    if (r.end < r.start) { $("f-end").value = ""; r.end = r.start; }
    var existing = findReport(state.report.channel, r.start, r.end);
    if (existing) { fillReport(existing); msg("pull-msg", ""); return; }
    if (state.report.id) { // moved off a saved report: start fresh on the new dates
      newReport(state.report.channel, r.start, r.end);
      return;
    }
    msg("pull-msg", "");
    updateReportCalc();
  }

  function readForm() {
    var r = formRange();
    var cats = {};
    var bad = [];
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
      channel: state.report.channel,
      start: r.start, end: r.end,
      visits: visits == null || Number.isNaN(visits) ? null : Math.round(visits),
      total: t,
      totalMissing: total == null,
      categories: cats,
      other: round2(t - sumCats(cats)),
      ftc: ftc == null || Number.isNaN(ftc) ? null : Math.round(ftc),
      fts: fts == null || Number.isNaN(fts) ? null : round2(fts),
      notes: $("f-notes").value.trim(),
      bad: bad,
    };
  }
  function reportEmail(d) {
    var cfg = chCfg(d.channel);
    var range = d.start ? rangeText(d.start, d.end) : "";
    var body = [range ? range + " (" + cfg.label + ")" : "(" + cfg.label + ")"].concat(emailLines(cfg, d)).join("\n");
    return { to: cfg.to || "", cc: cfg.cc || "", subject: (cfg.subject_prefix || "") + (range || cfg.label), body: body };
  }
  function updateReportCalc() {
    var d = readForm();
    $("f-other").textContent = fmtMoney(d.other);
    var neg = d.other < -0.004;
    $("f-other").parentNode.classList.toggle("bad", neg);
    $("other-warn").hidden = !neg;
    document.querySelectorAll("#report-form input").forEach(function (i) { i.removeAttribute("aria-invalid"); });
    d.bad.forEach(function (i) { i.setAttribute("aria-invalid", "true"); });
    var em = reportEmail(d);
    $("e-to").textContent = em.to || "—";
    $("e-cc").textContent = em.cc || "—";
    $("e-subject").textContent = em.subject;
    $("e-body").textContent = em.body;
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
      notes: d.notes, source: state.report.source,
    };
    msg("report-msg", "Saving…");
    // Open the mail window now, inside the click, so pop-up blockers allow it.
    var em = thenEmail ? reportEmail(d) : null;
    if (em) window.location.href = mailtoHref(em.to, em.cc, em.subject, em.body);
    call("sales_save_report", { p_row: row }).then(function (res) {
      if (res.state === "duplicate") throw new Error("A report for these dates already exists. Open it from the Log.");
      if (res.state !== "ok") throw new Error("Couldn't save (" + res.state + ").");
      return (em ? call("sales_mark_sent", { p_id: res.id }) : Promise.resolve()).then(function () { return res.id; });
    }).then(function (id) {
      return load().then(function () {
        var saved = state.reports.filter(function (r) { return r.id === id; })[0];
        if (saved) fillReport(saved);
        msg("report-msg", em ? "Saved and opened in your email app." : "Saved.", "ok");
        toast("Report saved");
      });
    }).catch(function (err) { if (err.message !== "auth") msg("report-msg", err.message, "err"); });
  }
  function openReportEmail() {
    var d = readForm();
    var em = reportEmail(d);
    window.location.href = mailtoHref(em.to, em.cc, em.subject, em.body);
    if (state.report.id) {
      call("sales_mark_sent", { p_id: state.report.id }).then(load).then(function () {
        var r = state.reports.filter(function (x) { return x.id === state.report.id; })[0];
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
    onSeg("log-channel", function (ch) { state.logChannel = ch; renderLog(); });
  }
  function renderLog() {
    setSeg("log-channel", state.logChannel);
    var body = $("log-body");
    body.innerHTML = "";
    var rows = state.reports.filter(function (r) { return state.logChannel === "all" || r.channel === state.logChannel; });
    if (!rows.length) {
      body.appendChild(el("tr", null, [el("td", { colspan: "5", class: "muted", text: "No reports yet." })]));
      return;
    }
    rows.forEach(function (r) {
      var dates = r.start_date === r.end_date ? niceDate(r.start_date) : niceDate(r.start_date) + " – " + niceDate(r.end_date);
      var status = el("td");
      status.appendChild(el("span", r.other < -0.004 ? { class: "badge badge-warn", text: "Check" } : { class: "badge badge-ok", text: "OK" }));
      if (r.sent_at) status.appendChild(el("span", { class: "badge badge-muted", text: "Emailed" }));
      if (r.source !== "manual") status.appendChild(el("span", { class: "badge badge-muted", text: r.source === "excel" ? "Excel" : "Shopify" }));
      var tr = el("tr", { tabindex: "0" }, [
        el("td", { text: dates }),
        el("td", null, [el("span", { class: "badge badge-" + r.channel, text: chCfg(r.channel).label })]),
        el("td", { class: "num", text: fmtInt(r.visits) }),
        el("td", { class: "num", text: fmtMoney(r.total) }),
        status,
      ]);
      function open() { fillReport(r); msg("report-msg", ""); msg("pull-msg", ""); showTab("report"); }
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
      body.appendChild(tr);
    });
  }

  // ---------- Totals ----------
  function bindTotals() {
    onSeg("totals-channel", function (ch) { state.totalsChannel = ch; renderTotals(); });
    document.querySelectorAll("[data-range]").forEach(function (b) {
      b.addEventListener("click", function () { setTotalsRange(b.dataset.range); renderTotals(); });
    });
    ["t-from", "t-to"].forEach(function (id) { $(id).addEventListener("change", function () {
      document.querySelectorAll("[data-range]").forEach(function (b) { b.classList.remove("on"); });
      renderTotals();
    }); });
    $("t-copy").addEventListener("click", function () { copyText($("te-body").textContent); });
    $("t-mail").addEventListener("click", function () {
      var em = totalsEmail();
      window.location.href = mailtoHref(em.to, em.cc, em.subject, em.body);
    });
  }
  function setTotalsRange(kind) {
    var t = today(), d = parse(t), from, to;
    var mondayOffset = (d.getDay() + 6) % 7;
    if (kind === "this-week") { from = addDays(t, -mondayOffset); to = addDays(from, 6); }
    else if (kind === "last-week") { from = addDays(t, -mondayOffset - 7); to = addDays(from, 6); }
    else if (kind === "this-month") { from = ymd(new Date(d.getFullYear(), d.getMonth(), 1)); to = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
    else if (kind === "last-month") { from = ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)); to = ymd(new Date(d.getFullYear(), d.getMonth(), 0)); }
    else { from = d.getFullYear() + "-01-01"; to = t; }
    $("t-from").value = from; $("t-to").value = to;
    document.querySelectorAll("[data-range]").forEach(function (b) { b.classList.toggle("on", b.dataset.range === kind); });
  }
  // Same rule as the old weekly sheet: a report counts if its end date falls in the range.
  function aggregate(ch, from, to) {
    var cfg = chCfg(ch);
    var rows = state.reports.filter(function (r) { return r.channel === ch && r.end_date >= from && r.end_date <= to; });
    var cats = {};
    cfg.categories.forEach(function (c) { cats[c.key] = 0; });
    var agg = { count: rows.length, visits: 0, visitsKnown: false, total: 0, categories: cats, other: 0, covered: {} };
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
    return agg;
  }
  function totalsEmail() {
    var ch = state.totalsChannel, cfg = chCfg(ch);
    var from = $("t-from").value, to = $("t-to").value;
    var a = aggregate(ch, from, to);
    var head = rangeText(from, to) + " (" + cfg.label + ")";
    var body = [head].concat(emailLines(cfg, {
      visits: a.visits, visitsLabel: "Total " + cfg.visits_label.replace(/^Number of /i, ""),
      total: a.total, categories: a.categories, other: a.other,
    })).join("\n");
    return { to: cfg.to || "", cc: cfg.cc || "", subject: cfg.label + " Sales Summary — " + rangeText(from, to), body: body, agg: a };
  }
  function renderTotals() {
    setSeg("totals-channel", state.totalsChannel);
    var from = $("t-from").value, to = $("t-to").value;
    var table = $("t-table");
    table.innerHTML = "";
    if (!from || !to || to < from) { $("t-note").textContent = "Pick a valid date range."; return; }
    var cfg = chCfg(state.totalsChannel);
    var em = totalsEmail(), a = em.agg;
    var tb = el("tbody");
    tb.appendChild(el("tr", null, [el("td", { text: cfg.visits_label }), el("td", { class: "num", text: fmtInt(a.visits) })]));
    cfg.categories.forEach(function (c) {
      tb.appendChild(el("tr", null, [el("td", { text: c.label }), el("td", { class: "num", text: fmtMoney(a.categories[c.key]) })]));
    });
    tb.appendChild(el("tr", null, [el("td", { text: "Other" }), el("td", { class: "num", text: fmtMoney(a.other) })]));
    tb.appendChild(el("tr", { class: "total" }, [el("td", { text: "Total" }), el("td", { class: "num", text: fmtMoney(a.total) })]));
    table.appendChild(tb);

    var lastDay = to < today() ? to : addDays(today(), -1);
    var missing = 0;
    for (var d = from; d <= lastDay; d = addDays(d, 1)) if (!a.covered[d]) missing++;
    var note = a.count + (a.count === 1 ? " report" : " reports") + " in this range.";
    if (missing && state.totalsChannel === "online") note += " " + missing + (missing === 1 ? " day has" : " days have") + " no report, so the totals may be short.";
    $("t-note").textContent = note;

    $("te-to").textContent = em.to || "—";
    $("te-cc").textContent = em.cc || "—";
    $("te-subject").textContent = em.subject;
    $("te-body").textContent = em.body;
  }

  // ---------- Events ----------
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
    var list = $("events-list");
    list.innerHTML = "";
    if (!state.events.length) list.appendChild(el("div", { class: "card muted", text: "No events yet. Add one to track its sales." }));
    state.events.forEach(function (ev) {
      var parts = [], grand = 0;
      ["trailer", "online"].forEach(function (ch) {
        var a = aggregate(ch, ev.start_date, ev.end_date);
        if (!a.count) return;
        grand += a.total;
        var cfg = chCfg(ch);
        var grid = el("div", { class: "event-grid" });
        grid.appendChild(el("div", null, [el("span", { text: cfg.visits_label }), fmtInt(a.visits)]));
        cfg.categories.forEach(function (c) { grid.appendChild(el("div", null, [el("span", { text: c.label }), fmtMoney(a.categories[c.key])])); });
        grid.appendChild(el("div", null, [el("span", { text: "Other" }), fmtMoney(a.other)]));
        grid.appendChild(el("div", null, [el("span", { text: "Total" }), el("strong", { text: fmtMoney(a.total) })]));
        parts.push(el("div", { class: "event-sub", text: cfg.label + " · " + a.count + (a.count === 1 ? " report" : " reports") }));
        parts.push(grid);
      });
      var card = el("div", { class: "card" }, [
        el("div", { class: "event-head" }, [
          el("h2", { text: ev.name }),
          el("span", { class: "event-total", text: fmtMoney(grand) }),
        ]),
        el("div", { class: "muted small", text: niceDate(ev.start_date) + " – " + niceDate(ev.end_date) + (ev.notes ? " · " + ev.notes : "") }),
      ].concat(parts.length ? parts : [el("p", { class: "muted small", text: "No reports in these dates yet." })]).concat([
        el("div", { class: "event-actions" }, [
          el("button", { type: "button", class: "btn btn-sm", text: "Email trailer totals", onclick: function () { openTotals("trailer", ev.start_date, ev.end_date); } }),
          el("button", { type: "button", class: "btn btn-sm", text: "Email online totals", onclick: function () { openTotals("online", ev.start_date, ev.end_date); } }),
          el("button", { type: "button", class: "btn btn-sm btn-ghost", text: "Edit", onclick: function () { editEvent(ev); } }),
        ]),
      ]));
      list.appendChild(card);
    });
  }
  function openTotals(ch, from, to) {
    state.totalsChannel = ch;
    $("t-from").value = from; $("t-to").value = to;
    document.querySelectorAll("[data-range]").forEach(function (b) { b.classList.remove("on"); });
    showTab("totals");
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
        var r = formRange();
        if (!state.report.id) newReport(state.report.channel, r.start, r.end);
        else fillReport(state.reports.filter(function (x) { return x.id === state.report.id; })[0] || state.reports[0]);
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
        var remembered = !!store(true);
        state.pin = a;
        if (remembered) store(false, a);
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
    $("s-to").value = cfg.to || "";
    $("s-cc").value = cfg.cc || "";
    $("s-subject").value = cfg.subject_prefix || "";
    $("s-visits").value = cfg.visits_label || "";
    var box = $("s-cats");
    box.innerHTML = "";
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
    cfg.to = $("s-to").value.trim();
    cfg.cc = $("s-cc").value.trim();
    cfg.subject_prefix = $("s-subject").value;
    cfg.visits_label = $("s-visits").value.trim() || cfg.visits_label;
    document.querySelectorAll("#s-cats input").forEach(function (inp) {
      cfg.categories[+inp.dataset.i].label = inp.value;
    });
  }

  // ---------- boot ----------
  var saved = store(true);
  if (saved) {
    start(saved, true).catch(function (err) { if (err.message !== "auth") showLogin(err.message); });
  } else showLogin();
})();
