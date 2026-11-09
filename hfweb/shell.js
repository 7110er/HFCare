/* HF-Care 瀏覽器版外殼（B127 T-A；B141 單一網頁）
 * 同一網頁三種入口（網址 # 切換）：
 *   醫療人員（預設）：Google 帳號登入（Google Identity Services）→ Apps Script 依授權名單核對
 *     → 取得程式包 → 每位病人一個 Worker（引擎原樣執行）→ 畫面框內之請求經 Service Worker 轉到此處
 *     → 交給病人 Worker → 回傳。編輯中之病人：每次寫入後自動回傳雲端（版本號比對；只送新增事件）；
 *     同一病人同時只一人可編輯。
 *   居家回報（#home-report）：病人或家屬以代碼回報；不登入、不載入引擎。
 *   公開衛教（#learn）：控制台開啟時顯示一般衛教。 */
"use strict";
(function () {
  const CFG = window.HF_CONFIG || {};
  // 網站所在路徑：根目錄（帳號.github.io）為 "/"；子路徑（帳號.github.io/hfcare/）為 "/hfcare/"。
  const BASE = location.pathname.replace(/[^/]*$/, "");
  const MODE = String(location.hash || "").replace(/^#/, "");
  // 本外殼不使用任何瀏覽器持久化儲存（本機、分頁、資料庫與快取四類皆不用）：
  // 登入權杖、Google 登入資料與程式包只放記憶體，關閉或重新整理分頁即消失（DEF-B120-FRONTEND-SECURITY-01）。
  const $ = (id) => document.getElementById(id);
  const S = {
    token: null, user: null, pepper: null, engine: null, sitePkgs: null, bridgeSrc: null,
    spare: null,           // 預先啟動、尚未指派病人之 Worker（Promise<W>）
    cur: null,             // 目前病人 {w, key, mode, leaseToken, version, dirty, ...}
    lastActivity: Date.now(), saving: null, saveTimer: null, renewTimer: null,
    leaseMinutes: 10, pub: {}, siteSettings: {}, adoptions: [], siteTables: {},
  };

  /* ───────── 單一分頁：避免兩個分頁各自編輯而互相覆蓋 ───────── */
  const bc = ("BroadcastChannel" in window) ? new BroadcastChannel("hfcare-shell") : null;
  if (bc) {
    bc.onmessage = (e) => { if (e.data === "ping" && MODE === "") bc.postMessage("here"); };
  }

  const VIEWS = ["vLoading", "vLogin", "vPatients", "vHome", "vLearn"];
  function show(view) {
    VIEWS.forEach((v) => { $(v).hidden = (v !== view); });
    document.body.classList.remove("inapp");
    $("app").hidden = true;
  }
  // 進行中訊息顯示掃描中之描記線；err=true 為停止狀態（描記線停止、訊息以警示呈現）。
  function loadMsg(t, err) {
    $("loadMsg").textContent = t; show("vLoading");
    $("vLoading").classList.toggle("err", !!err);
    $("loadMsg").setAttribute("role", err ? "alert" : "status");
  }
  function setSync(text, cls) { const e = $("sync"); e.textContent = text; e.className = cls || ""; }
  function el(tag, attrs, text) {
    const e = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => { if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /* ───────── Apps Script 呼叫（text/plain 以免跨網域預檢） ───────── */
  /*GAS-CALL-BEGIN*/
  // B143（v2.0.0 後續 A-09）：保留 HTTP 狀態與錯誤代碼；只讀之冪等操作遇網路中斷、非 JSON 回應
  //（Apps Script 之 HTML 錯誤頁）或 5xx 時自動重試 2 次。寫入操作不在此重試（存檔另以 saveId 冪等）。
  //: 本網站所需之後台版本（＝同一部署包之 Code.gs 之 HF.VERSION；tests/test_b143_web 守對應）。
  var EXPECTED_BACKEND = "B158-1";
  // B157：首頁與交班清單之讀取亦為冪等（verifyLog 計失敗次數，不重試）。
  var GAS_IDEMPOTENT = ["publicConfig", "loginNonce", "config", "engine", "listPatients", "dashboard", "learn",
                        "home", "listHandoffs", "listTeamPatients", "roster"];
  async function gasCall(fetchFn, url, op, body, sleep) {
    var idem = GAS_IDEMPOTENT.indexOf(op) >= 0, tries = idem ? 3 : 1, last = null;
    for (var i = 0; i < tries; i++) {
      if (i) await sleep(300 * i * i + 200);
      var r;
      try {
        r = await fetchFn(url, { method: "POST", body: body, headers: { "Content-Type": "text/plain;charset=utf-8" },
                                 redirect: "follow" });
      } catch (e) {
        last = Object.assign(new Error("連不到雲端後台（網路或網址設定）"), { code: "NET", status: 0 });
        continue;
      }
      var j = null;
      try { j = await r.json(); } catch (e) {
        last = Object.assign(new Error("雲端後台回應格式錯誤（HTTP " + r.status + "）"),
                             { code: "BADRESP", status: r.status });
        continue;
      }
      if (!j || !j.ok) {
        var err = Object.assign(new Error((j && j.error) || "雲端後台錯誤"),
                                { code: (j && j.code) || "ERR", status: r.status });
        if (idem && r.status >= 500) { last = err; continue; }
        throw err;
      }
      return j;
    }
    last.attempts = tries;
    throw last;
  }
  /*GAS-CALL-END*/
  async function gas(op, args) {
    const body = JSON.stringify(Object.assign({ op, token: S.token }, args || {}));
    try {
      return await gasCall(fetch, CFG.gasUrl, op, body, (ms) => new Promise((res) => setTimeout(res, ms)));
    } catch (e) {
      if (e.code === "AUTH" && op !== "login") { S.token = null; }
      throw e;
    }
  }

  /*HOME-VIEW-BEGIN*/
  // B157（v2.4 §4 H2–H4、§6）：首頁交班與團隊清單之呈現（純函式；tests/test_b157_w5_shell 以 node 執行）。
  // 只呈現後台投影之列舉值與交班碼；不含病歷號、不含任何自由文字。類別與退回原因之中文與
  // hfcare_app/handover.py 之 CATEGORY_CODES／RETURN_REASONS 同表（一致性測試核對）。
  var HV = {
    CAT: { MEDREC: "用藥核對", GDMT_TITRATE: "GDMT 起始／上調", LAB_MONITOR: "腎功能／血鉀複測",
           EDU_TEACHBACK: "衛教與 teach-back", ADHERENCE: "順從度", FOLLOWUP_7D: "出院 7 日追蹤",
           FOLLOWUP_6W: "出院 6 週追蹤", HOME_REPORT: "居家回報確認", REFERRAL: "轉介",
           ASSESS_GAP: "補齊評估缺項", OTHER: "其他" },
    RET: { NOT_MY_ROLE: "非本職類可處理", INSUFFICIENT_INFO: "資訊不足", PATIENT_UNREACHABLE: "聯絡不到病人",
           DUPLICATE: "重複", OFF_DUTY: "不在班", OTHER: "其他" },
    STATUS: { assigned: "待承接", accepted: "已承接", in_progress: "處理中", completed: "已完成", returned: "已退回" }
  };
  function hvEsc(x) { return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function hvTime(iso) {
    var t = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(String(iso || "")) ? iso : String(iso || "") + "Z");
    if (!isFinite(t)) return "";
    return new Date(t + 8 * 3600000).toISOString().slice(5, 16).replace("T", " ");
  }
  function hvOverdueText(r, nowMs) {
    if (!r.overdue) return "";
    var t = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(String(r.due_at || "")) ? r.due_at : String(r.due_at || "") + "Z");
    var h = isFinite(t) ? Math.max(1, Math.floor((nowMs - t) / 3600000)) : 0;
    return "逾時 " + (h ? h + " 小時" : "");
  }
  function hvStatus(r) {
    var s = HV.STATUS[r.status] || r.status;
    if (r.status === "returned") s += "（" + (HV.RET[r.returned_reason] || "未註明") + "）";
    if ((r.status === "accepted" || r.status === "in_progress") && r.accepted_by_name) s += "｜" + r.accepted_by_name;
    return s;
  }
  function hvWho(r) {
    if (r.escalation === "ESCALATED") return "原指定 " + (r.assignee_name || "同仁") + " 逾時，群組可承接";
    if (r.escalation === "TARGET_DISABLED") return "原指定 " + (r.assignee_name || "同仁") + " 已停用，群組可承接";
    return r.assignee_name ? "指定：" + r.assignee_name : "職類群組（" + r.owner_role + "）";
  }
  /** 交班列表格（box＝mine／sent）。每列一鍵【開啟】（data-key；不用行內事件，CSP）。 */
  function handoffTable(rows, box, nowMs) {
    if (!rows || !rows.length) {
      return "<p class='why empty'>" + (box === "sent" ? "目前沒有你交出、尚未完成的項目。" :
        "目前沒有交給你（或你的職類）的項目。") + "</p>";
    }
    return "<table class='htable'><thead><tr><th scope='col'>交班碼</th><th scope='col'>類別</th>" +
      "<th scope='col'>" + (box === "sent" ? "交給" : "指派者") + "</th><th scope='col'>到期</th>" +
      "<th scope='col'>狀態</th><th scope='col'><span class='sr-only'>動作</span></th></tr></thead><tbody>" +
      rows.map(function (r) {
        var od = hvOverdueText(r, nowMs);
        return "<tr class='st-" + hvEsc(r.status) + (od ? " od" : "") + "'><td><code class='hc'>" + hvEsc(r.code) +
          "</code></td><td>" + hvEsc(HV.CAT[r.category_code] || r.category_code) +
          (r.risk_level === "high_risk" ? " <b class='hr'>高風險</b>" : "") +
          (r.care_phase ? "<br><span class='why'>" + hvEsc(r.care_phase) + "</span>" : "") + "</td><td>" +
          (box === "sent" ? hvEsc(hvWho(r)) : hvEsc(r.assigned_by_name) + "（" + hvEsc(r.assigned_role) + "）") +
          "</td><td>" + hvEsc(hvTime(r.due_at) || "—") + (od ? "<br><b class='od'>" + hvEsc(od) + "</b>" : "") +
          "</td><td>" + hvEsc(hvStatus(r)) + (box === "mine" && r.escalation ? "<br><span class='why'>" +
          hvEsc(hvWho(r)) + "</span>" : "") + "</td><td><button type='button' class='sec' data-open='" +
          hvEsc(r.key) + "' data-src='handoff'>開啟</button></td></tr>";
      }).join("") + "</tbody></table>";
  }
  function teamTable(rows) {
    if (!rows || !rows.length) return "<p class='why empty'>沒有符合條件之病人。</p>";
    var st = function (x) {
      if (!x) return "—";
      return [x.phenotype, x.setting, x.age, x.sex].filter(function (v) { return v && v !== "未知" && v !== "未宣告"; })
        .join("／") || "—";
    };
    return "<table class='htable'><thead><tr><th scope='col'>交班碼</th><th scope='col'>分型／場域／年齡層／性別</th>" +
      "<th scope='col'>最後照護</th><th scope='col'>未結任務</th><th scope='col'><span class='sr-only'>動作</span></th>" +
      "</tr></thead><tbody>" + rows.map(function (r) {
        var open = Object.keys(r.openTasks || {}).sort().map(function (k) { return k + " " + r.openTasks[k]; }).join("、");
        return "<tr" + (r.overdue ? " class='od'" : "") + "><td><code class='hc'>" + hvEsc(r.code) + "</code></td><td>" +
          hvEsc(st(r.strata)) + "</td><td>" + hvEsc(hvTime(r.lastEncounterAt)) + "<br><span class='why'>" +
          hvEsc(r.lastCare && r.lastCare.name || "") + (r.lastCare && r.lastCare.role ? "（" + hvEsc(r.lastCare.role) + "）" : "") +
          "</span></td><td>" + hvEsc(open || "—") + (r.overdue ? "<br><b class='od'>逾時 " + hvEsc(r.overdue) + "</b>" : "") +
          (r.editing ? "<br><span class='why'>編輯中：" + hvEsc(r.editing) + "</span>" : "") +
          "</td><td><button type='button' class='sec' data-open='" + hvEsc(r.key) + "' data-src='team'>" +
          (r.participant ? "開啟" : "查看") + "</button></td></tr>";
      }).join("") + "</tbody></table>";
  }
  /** 開檔回應 → 引擎頁首之唯讀原因（空＝可編輯或他人編輯中之既有唯讀）。 */
  function readonlyReason(r, nowMs) {
    if (!r || r.mode === "edit") return "";
    if (r.lockedUntil) {
      var m = Math.max(1, Math.ceil((Date.parse(r.lockedUntil) - nowMs) / 60000));
      return "核對失敗次數過多，約 " + m + " 分鐘內只能唯讀";
    }
    if (r.verifyNeeded) return "尚未核對病歷號";
    return "";
  }
  /** 存檔後狀態列之交班佇列說明（不假綠：拒收者列出 item_id 前 12 碼與原因）。 */
  function handoffSyncNote(r) {
    if (!r) return "";
    var rej = r.handoffRejected || [];
    var t = r.handoffUpserted ? "；交班佇列更新 " + r.handoffUpserted + " 筆" : "";
    if (rej.length) {
      t += "；交班佇列拒收 " + rej.length + " 筆：" + rej.slice(0, 3).map(function (x) {
        return String(x.item_id || "").slice(0, 12) + "（" + String(x.why || "").slice(0, 60) + "）"; }).join("、") +
        (rej.length > 3 ? "…" : "");
    }
    return t;
  }
  /*HOME-VIEW-END*/

  /* ───────── Worker 管理 ───────── */
  function makeWorker() {
    const w = new Worker(BASE + "hfweb/worker.js", { type: "module" });
    let seq = 0; const pend = new Map();
    w.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data; const p = pend.get(id); if (!p) return;
      pend.delete(id); ok ? p.resolve(result) : p.reject(new Error(error));
    };
    const call = (cmd, args, transfer) => new Promise((resolve, reject) => {
      const id = ++seq; pend.set(id, { resolve, reject });
      w.postMessage({ id, cmd, args }, transfer || []);
    });
    return { w, call, kill: () => w.terminate() };
  }
  async function bootWorker() {
    const W = makeWorker();
    await W.call("init", { sitePackages: S.sitePkgs.slice(0), engine: S.engine.slice(0), bridgeSource: S.bridgeSrc });
    return W;
  }
  function prepareSpare() { S.spare = bootWorker(); S.spare.catch(() => { S.spare = null; }); }
  async function takeWorker() {
    if (!S.spare) prepareSpare();
    const W = await S.spare; S.spare = null;
    return W;
  }

  /* ───────── 啟動 ───────── */
  async function sha256Hex(buf) {
    const d = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function b64ToBuf(b64) {
    const s = atob(b64); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  }
  function bufToB64(u8) {
    let s = ""; const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  /* ───────── 醫療人員：Google 登入 ───────── */
  function loadGis() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true;
      s.onload = () => ((window.google && window.google.accounts && window.google.accounts.id)
        ? resolve() : reject(new Error("元件不完整")));
      s.onerror = () => reject(new Error("無法下載"));
      document.head.appendChild(s);
    });
  }
  async function startLogin(msg) {
    show("vLogin");
    $("lnkHome").hidden = !S.pub.homeReport; $("lnkLearn").hidden = !S.pub.learn;
    $("loginMsg").textContent = msg || S.pub.settingsError || "";
    if (!S.pub.clientId) {
      $("loginMsg").textContent = "管理者尚未在控制台「設定」填入 Google 用戶端 ID，暫時無法登入。"; return;
    }
    try { await loadGis(); }
    catch (e) { $("loginMsg").textContent = "Google 登入元件載入失敗（網路或瀏覽器設定）：" + e.message; return; }
    let nonce;
    try { nonce = (await gas("loginNonce")).nonce; } catch (e) { $("loginMsg").textContent = e.message; return; }
    window.google.accounts.id.initialize({ client_id: S.pub.clientId, callback: onCredential, nonce,
      auto_select: false, cancel_on_tap_outside: true, ux_mode: "popup", itp_support: true });
    $("gbtn").textContent = "";
    window.google.accounts.id.renderButton($("gbtn"), { type: "standard", theme: "outline", size: "large",
      text: "signin_with", shape: "rectangular", locale: "zh-TW", width: 280 });
  }
  async function onCredential(resp) {
    try {
      loadMsg("核對授權名單…");
      const r = await gas("login", { idToken: resp && resp.credential });
      S.token = r.token; S.user = { personId: r.personId, name: r.name, role: r.role };
      await afterLogin();
    } catch (err) {
      S.token = null; S.user = null;
      await startLogin(err.message);          // 一次性登入碼已用掉：重新取得並重繪按鈕
    }
  }

  async function afterLogin() {
    loadMsg("讀取設定…");
    const conf = await gas("config");
    // B143：網站與後台（Code.gs）須為同一部署包（與程式包同一約定，fail-closed）——舊版後台缺
    // 本版之職類即時覆核、外部連線授權碼、存檔冪等等行為，靜默沿用會使功能看似存在而實際未生效。
    if (conf.version !== EXPECTED_BACKEND) {
      throw new Error("雲端後台（Code.gs）版本為 " + (conf.version || "未知") + "，本網站需要 " + EXPECTED_BACKEND +
        "。請管理者以同一個部署包之「2_貼到AppsScript/Code.gs」整份重貼，並「部署→管理部署→新版本」。");
    }
    S.pepper = conf.pepper; S.leaseMinutes = conf.leaseMinutes || 10; S.adoptions = conf.adoptions || [];
    S.siteTables = conf.siteTables || {}; S.siteSettings = conf.siteSettings || {};
    S.user = { personId: conf.user.personId, name: conf.user.name, role: conf.user.role };
    const man = await (await fetch(BASE + "hfweb/manifest.json", { cache: "no-cache" })).json();
    if (man.engine_zip.sha256 !== conf.engineSha256) {
      throw new Error("網站版本（" + man.engine_version + "）與雲端程式包（" + conf.engineName +
        "）不一致。請管理者以同一個部署包之「3_程式包」重新上傳（試算表選單 ② 上傳程式包）。");
    }
    // 程式包：每次登入自雲端下載並以 SHA256 核對；只放記憶體，不寫入瀏覽器儲存。
    loadMsg("下載程式包（約 10–40 秒）…");
    const e = await gas("engine");
    const buf = b64ToBuf(e.b64);
    if (await sha256Hex(buf) !== conf.engineSha256) throw new Error("程式包雜湊不符，拒絕載入");
    S.engine = buf;
    loadMsg("下載執行環境（第一次約 13 MB，之後會快取）…");
    S.sitePkgs = await (await fetch(BASE + "hfweb/site-packages.zip")).arrayBuffer();
    S.bridgeSrc = await (await fetch(BASE + "hfweb/bridge.py")).text();
    loadMsg("啟動引擎（約 10–20 秒）…");
    prepareSpare();
    await S.spare;
    $("who").textContent = S.user.name + "（" + S.user.role + "）";
    $("btnOut").hidden = false; $("btnDash").hidden = false;
    await showPatients();
  }

  async function showPatients(msg) {
    show("vPatients");
    $("openMsg").textContent = msg || "";
    $("vConfirm").hidden = true;
    $("pt").textContent = ""; setSync("");
    $("btnClose").hidden = true;
    try {
      const r = await gas("listPatients");
      $("plistH").textContent = "你近 " + r.recentDays + " 天內開啟或存檔過的病人";
      const rows = r.patients;
      $("plist").innerHTML = rows.length ? "<table><thead><tr><th>病人代號</th><th>版本</th><th>最後更新</th><th>目前編輯</th></tr></thead><tbody>" +
        rows.map((p) => "<tr><td><code>" + esc(p.key.slice(0, 10)) + "…</code></td><td>" + esc(p.version) +
          "</td><td>" + esc(taipeiTime(p.updatedAt)) + " " + esc(p.updatedBy || "") +
          "</td><td>" + esc(p.editing || "—") + "</td></tr>").join("") + "</tbody></table>" +
        "<p class='why'>開啟既有病人時，請輸入同一個病歷號。其他同仁照護的病人不列在這裡，仍可輸入病歷號開啟。</p>"
        : "<p class='why'>近期沒有你開啟過的病人。</p>";
    } catch (e) { $("plist").textContent = "讀取病人清單失敗：" + e.message; }
    await showHome();
  }

  /* ───────── B157：首頁交班給我／我交出的／團隊病人清單（後台一次往返） ───────── */
  async function showHome() {
    if (!$("hMine")) return;
    try {
      const h = await gas("home");
      renderHome(h);
    } catch (e) {
      $("hMine").textContent = "讀取交班清單失敗：" + e.message;
    }
  }
  function renderHome(h) {
    const now = Date.now();
    const mine = (h.handoffs || {}).mine || [], sent = (h.handoffs || {}).sent || [];
    $("hMineH").textContent = "交班給我（" + mine.length + "）" + ((h.overdue || {}).mine ? "｜逾時 " + h.overdue.mine : "");
    $("hSentH").textContent = "我交出的（" + sent.length + "）" + ((h.overdue || {}).sent ? "｜逾時 " + h.overdue.sent : "");
    $("hMine").innerHTML = handoffTable(mine, "mine", now);
    $("hSent").innerHTML = handoffTable(sent, "sent", now);
    renderTeam(h.team || [], h.teamScope, h.teamDays);
  }
  function renderTeam(rows, scope, days) {
    $("hTeamH").textContent = "團隊病人清單（" + rows.length + "）" + (scope ? "｜範圍：" + scope + "、近 " + days + " 天" : "");
    $("hTeam").innerHTML = teamTable(rows);
  }
  async function filterTeam() {
    const code = String($("tfCode").value || "").trim().toLowerCase();
    try {
      const r = await gas("listTeamPatients", { setting: $("tfSetting").value, onlyMyRoleTasks: $("tfMine").checked,
                                                onlyOverdue: $("tfOver").checked, code: /^[0-9a-f]{8}$/.test(code) ? code : "" });
      renderTeam(r.patients || [], r.scope, r.days);
    } catch (e) { $("hTeam").textContent = "讀取團隊病人清單失敗：" + e.message; }
  }
  function onHomeClick(ev) {
    const b = ev.target.closest ? ev.target.closest("button[data-open]") : null;
    if (!b) return;
    const key = b.getAttribute("data-open");
    if (!/^[0-9a-f]{16,128}$/.test(key)) return;
    openPatientByKey(key, { source: b.getAttribute("data-src") || "team" })
      .catch((e) => showPatients("開啟失敗：" + e.message));
  }
  function esc(x) { return String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  /* ───────── 開啟病人 ───────── */
  // B141（B-27）：雲端查無此病人時先確認，不因打錯病歷號就建立新病人。
  function askCreate(mrn) {
    show("vPatients");
    $("confirmMsg").textContent = "找不到病歷號「" + mrn + "」之病人。這是一位新病人嗎？請再核對一次病歷號。";
    $("vConfirm").hidden = false;
    $("btnCreate").onclick = () => {
      $("vConfirm").hidden = true;
      openPatient(mrn, true).then(() => { $("mrn").value = ""; })
        .catch((err) => showPatients("開啟失敗：" + err.message));
    };
    $("btnCancel").onclick = () => { $("vConfirm").hidden = true; $("mrn").focus(); };
    $("btnCreate").focus();
  }

  async function openPatient(mrn, create) {
    const W = await takeWorker();
    let opened = false;
    try {
      const key = await W.call("pseudonym", { mrn, pepper: S.pepper });
      loadMsg("向雲端取得病人資料…");
      const r = await gas("openPatient", { key, wantEdit: true, create: !!create, via: "entered" });
      if (!r.exists) { S.spare = Promise.resolve(W); askCreate(mrn); return; }
      // B143（A-03）：職類以後台當下之授權名單為準（原只在登入時讀一次，改職類須重新登入）。
      const roleNote = roleChange(S.user, r);
      if (roleNote) { S.user.role = r.role; $("who").textContent = S.user.name + "（" + S.user.role + "）"; }
      const zip = r.snapshot ? b64ToBuf(r.snapshot) : null;
      const dataDir = "/data/" + key;
      await W.call("restore", { dataDir, zip: zip ? new Uint8Array(zip) : null });
      loadMsg("開啟病人（約 3–8 秒）…");
      await W.call("setup", Object.assign({ dataDir, principalId: S.user.personId, displayName: S.user.name,
                              role: S.user.role, pepper: S.pepper, secretKey: randomKey(),
                              adoptions: S.adoptions, siteTables: S.siteTables,
                              siteSettings: S.siteSettings, patientKey: key }, handoffSetup(r)));
      S.cur = { W, key, mode: r.mode, holder: r.holder, leaseToken: r.leaseToken, version: r.version,
                dirty: false, failed: null, kpiMax: r.kpiMax || 0, teachMax: r.teachMax || 0, pendingAck: null,
                verifyNeeded: !!r.verifyNeeded, lockedUntil: r.lockedUntil || "" };
      // 以病歷號開啟／加入就診（與伺服器版同一路徑：同一病歷號併入同一筆就診）。
      const home = await appRequest("GET", "/", {}, null, true);
      const csrf = (new TextDecoder().decode(home.body).match(/name='csrf' value='([^']+)'/) || [])[1] || "";
      // B143（v2.0.0 後續 A-02）：照護場域由開啟表單帶入（原固定送空字串，畫面恆為「未指定」）。
      const setting = ($("setting") && $("setting").value) || "";
      const form = new URLSearchParams({ mrn, setting, csrf });
      const res = await appRequest("POST", "/", { "content-type": "application/x-www-form-urlencoded" },
                                   new TextEncoder().encode(form.toString()).buffer, true);
      const loc = (res.headers.find((h) => h[0].toLowerCase() === "location") || [])[1];
      if (!loc || !loc.startsWith("/e/")) throw new Error("無法開啟就診（" + res.status + "）");
      // B141 W07：病人在家以代碼送出之回報，於編輯者開啟時併入（存檔成功後才向後台確認）。
      let imported = 0;
      if (S.cur.mode === "edit" && (r.homeReports || []).length) {
        const out = JSON.parse(await W.call("importHomeReports", { json: JSON.stringify(r.homeReports) }));
        S.cur.pendingAck = out;
        imported = out.filter((x) => x.status === "imported").length;
      }
      opened = true;
      enterApp(loc);
      if (roleNote) setSync(roleNote, "busy");
      if (S.cur.mode === "edit") {
        markDirty(); startRenew();      // 新病人／新就診也要落雲端
        if (imported) setSync("已併入居家回報 " + imported + " 筆（同步後確認）", "busy");
      }
    } catch (e) {
      if (!opened) { W.kill(); prepareSpare(); S.cur = null; }
      throw e;
    }
  }
  function randomKey() { const a = new Uint8Array(32); crypto.getRandomValues(a); return bufToB64(a); }
  // B157（W3/W5）：開檔時交給引擎之同仁名單（後台授權名單；不含電郵）、交班覆蓋狀態、唯讀原因。
  function handoffSetup(r) {
    return { roster: r.roster || [], overlay: r.handoffOverlay || {}, readonly: readonlyReason(r, Date.now()) };
  }

  /** B149（C-07）：以假名鍵開啟病人（儀表板缺口連結）。不經病歷號：後台以鍵取檔，導向最近就診。 */
  // B157（S-3）：交班清單、團隊清單亦以此開啟；非參與者由後台回唯讀（須核對病歷號才取得編輯權）。
  async function openPatientByKey(key, opts) {
    const o = opts || {};
    if (S.cur) await closePatient("開啟該病人");
    if (S.cur) return;
    const W = await takeWorker();
    let opened = false;
    try {
      loadMsg("向雲端取得病人資料…");
      const r = await gas("openPatient", { key, wantEdit: true, create: false, via: "key",
                                           verified: !!o.verified, source: o.source || "gap" });
      if (!r.exists) throw new Error("找不到這位病人之資料檔");
      const roleNote = roleChange(S.user, r);
      if (roleNote) { S.user.role = r.role; $("who").textContent = S.user.name + "（" + S.user.role + "）"; }
      const zip = r.snapshot ? b64ToBuf(r.snapshot) : null;
      const dataDir = "/data/" + key;
      await W.call("restore", { dataDir, zip: zip ? new Uint8Array(zip) : null });
      loadMsg("開啟病人（約 3–8 秒）…");
      await W.call("setup", Object.assign({ dataDir, principalId: S.user.personId, displayName: S.user.name,
                              role: S.user.role, pepper: S.pepper, secretKey: randomKey(),
                              adoptions: S.adoptions, siteTables: S.siteTables,
                              siteSettings: S.siteSettings, patientKey: key }, handoffSetup(r)));
      S.cur = { W, key, mode: r.mode, holder: r.holder, leaseToken: r.leaseToken, version: r.version,
                dirty: false, failed: null, kpiMax: r.kpiMax || 0, teachMax: r.teachMax || 0, pendingAck: null,
                verifyNeeded: !!r.verifyNeeded, lockedUntil: r.lockedUntil || "" };
      // B157：非成員以假名鍵開啟原為 404（只有已加入就診者看得到）；依後台決定之模式登錄照護關係。
      const joinKind = r.mode !== "edit" ? "readonly" : (o.verified ? "verified" : "participant");
      const eid = await W.call("joinLatest", { kind: joinKind });
      opened = true;
      enterApp(eid ? "/e/" + eid : "/");
      if (roleNote) setSync(roleNote, "busy");
      if (S.cur.mode === "edit") {
        startRenew();
        if (o.verified) { setSync("編輯中（已核對）", "ok"); }
      }
    } catch (e) {
      if (!opened) { W.kill(); prepareSpare(); S.cur = null; }
      throw e;
    }
  }

  /** B149：儀表板首屏先顯示後台彙總要點（Worker 啟動需數秒；先讓人看到數字）。 */
  function quickSummary(agg) {
    const a = agg || {};
    const esc_ = a.esc || {};
    const withDen = Object.keys(esc_).filter((k) => (esc_[k] || {}).denominator > 0).length;
    const gaps = (a.my_gaps || []).length;
    return "群體統計（後台計算）：" + (a.patients || 0) + " 位病人、" + (a.events || 0) + " 筆事件\n" +
      "有分母之指標 " + withDen + " 項" + (gaps ? "；你近 30 日照護之病人有缺口者 " + gaps + " 位" : "") +
      "\n正在載入完整儀表板…";
  }

  function enterApp(path) {
    const c = S.cur;
    $("pt").textContent = "病人 " + c.key.slice(0, 10) + "…";
    $("btnClose").hidden = false;
    if (c.mode === "edit") setSync("已同步 v" + c.version, "ok");
    else if (c.lockedUntil) setSync("唯讀：核對失敗次數過多（" + taipeiTime(c.lockedUntil) + " 後可再核對）", "ro");
    else if (c.verifyNeeded) setSync("唯讀：尚未核對病歷號", "ro");
    else setSync("唯讀：" + (c.holder || "他人") + " 正在編輯", "ro");
    if ($("btnVerify")) $("btnVerify").hidden = !(c.verifyNeeded && !c.lockedUntil && c.mode !== "edit");
    VIEWS.forEach((v) => { $(v).hidden = true; });
    document.body.classList.add("inapp");
    $("app").hidden = false;
    $("app").src = BASE + path.replace(/^\//, "");
  }
  // B157（W0）：框換至 about:blank 並等候落點；逾時或落點不符回 false。
  function navBlank(timeoutMs) {
    const fr = $("app");
    return new Promise((resolve) => {
      let done = false, t = null, poll = null;
      const finish = () => {
        if (done) return; done = true; fr.removeEventListener("load", finish); clearTimeout(t); clearInterval(poll);
        resolve(arrived(fr.contentWindow, "about:blank", BASE));
      };
      t = setTimeout(finish, timeoutMs || 8000);
      fr.addEventListener("load", finish);
      fr.src = "about:blank";
      poll = setInterval(() => { if (arrived(fr.contentWindow, "about:blank", BASE)) finish(); }, 100);
    });
  }
  // B157（W0）：進入畫面後核對框確實到達目標頁（Worker 首頁約 3–8 秒；上限 120 秒）；
  // 未到即顯示錯誤、外殼不宣稱已切換。
  async function verifyArrival(target) {
    const fr = $("app");
    for (let i = 0; i < 600; i++) {
      if (arrived(fr.contentWindow, target, BASE)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    setSync("畫面未切換到目標頁（" + target + "）；請關閉後重試", "bad");
    $("pt").textContent = "（畫面未切換）";
    return false;
  }

  /* ───────── 畫面框請求之轉接 ───────── */
  async function appRequest(method, path, headers, body, internal) {
    const c = S.cur;
    if (!c) return { status: 409, headers: [["Content-Type", "text/html; charset=utf-8"]],
                     body: new TextEncoder().encode("<meta charset=utf-8><p>尚未開啟病人。</p>") };
    const write = !["GET", "HEAD"].includes(method);
    const loginPath = path === "/login" || path.startsWith("/logout") || path.startsWith("/password");
    if (!internal && loginPath) {
      // 身分由雲端後台管理；框內之登入／登出／改密碼一律導回病人頁。
      return { status: 303, headers: [["Location", BASE]], body: new Uint8Array(0) };
    }
    if (write && c.mode !== "edit" && !internal) {   // 內部開啟就診：唯讀時只在本機，不上傳
      const msg = c.mode === "dashboard" ? "儀表板為唯讀" :
        (c.verifyNeeded || c.lockedUntil) ? "唯讀檢視：請先在上方核對病歷號，核對後才可承接或修改。" :
        "唯讀模式：" + (c.holder || "他人") + " 正在編輯這位病人，你的修改不會儲存。";
      const isJson = (headers["accept"] || "").includes("json") || path.endsWith("/answer");
      return isJson ? { status: 200, headers: [["Content-Type", "application/json"]],
                        body: new TextEncoder().encode(JSON.stringify({ ok: false, error: msg })) }
                    : { status: 423, headers: [["Content-Type", "text/html; charset=utf-8"]],
                        body: new TextEncoder().encode("<meta charset=utf-8><p>" + esc(msg) + "</p>") };
    }
    // B149（C-07）：儀表板「我的照護缺口」之連結 /_open/<假名鍵>——外殼以假名鍵開檔（不送病歷號）。
    const om = /^\/_open\/([A-Za-z0-9_-]{16,128})$/.exec(path.split("?")[0]);
    if (om && !write) {
      setTimeout(() => { openPatientByKey(om[1], { source: "gap" }).catch((e) => loadMsg("無法開啟：" + e.message, true)); }, 0);
      return { status: 200, headers: [["Content-Type", "text/html; charset=utf-8"]],
               body: new TextEncoder().encode("<meta charset=utf-8><p>開啟病人中…</p>") };
    }
    // 內部請求（開啟就診）取應用內路徑；畫面框請求才加網站子路徑前綴。
    const r = await c.W.call("request", { method, path, headers, body, base: internal ? "/" : BASE },
                             body ? [body] : []);
    if (write && c.mode === "edit" && r.status < 400) markDirty();
    S.lastActivity = Date.now();
    return r;
  }

  navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", async (ev) => {
    const m = ev.data; if (!m || m.type !== "hf-request") return;
    const port = ev.ports[0];
    try {
      const r = await appRequest(m.method, m.path, m.headers || {}, m.body, false);
      port.postMessage({ status: r.status, headers: r.headers, body: r.body }, r.body && r.body.buffer ? [r.body.buffer] : []);
    } catch (e) {
      port.postMessage({ status: 500, headers: [["Content-Type", "text/html; charset=utf-8"]],
        body: new TextEncoder().encode("<meta charset=utf-8><p>處理失敗：" + esc(e.message) + "</p>") });
    }
  });

  /* ───────── 雲端同步與編輯權 ───────── */
  function markDirty() {
    const c = S.cur; if (!c || c.mode !== "edit") return;
    c.dirty = true; c.unsynced = (c.unsynced || 0) + 1;
    setSync("未同步：" + c.unsynced + " 項待送出", "busy");   // 「未同步（原因）」保留給失敗（e2e 與畫面同一約定）
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, 3000);
  }
  /*SYNC-OUTCOME-BEGIN*/
  // B130 W08：同步結果之唯一判讀。只有伺服器回傳成功且版本號遞增才算「已同步」；
  // 斷網、租約衝突、版本衝突、伺服器錯誤一律「未同步（原因）」，不顯示已存。
  function syncOutcome(baseVersion, res, err) {
    if (err) {
      var why = (err && err.message) ? err.message : "網路或伺服器沒有回應";
      var ro = !!(err && (err.code === "LEASE" || err.code === "CONFLICT"));
      return { ok: false, text: "未同步（" + why + "）", cls: "bad", readonly: ro, retry: !ro };
    }
    var v = res && Number(res.version);
    if (!res || !isFinite(v) || !(v > Number(baseVersion))) {
      return { ok: false, text: "未同步（伺服器未確認新版本）", cls: "bad", readonly: false, retry: true };
    }
    return { ok: true, text: "已同步 v" + v, cls: "ok", version: v, readonly: false, retry: false };
  }
  /*SYNC-OUTCOME-END*/
  /*SHELL-POLICY-BEGIN*/
  // B143（v2.0.0 後續 A-08）：閒置時有未同步修改者不轉唯讀（原行為：存檔失敗仍轉唯讀，修改遺失）。
  // B143（A-03）：後台回應之職類與外殼不同時以後台為準；後台未回職類（舊版後台）時不改。
  function roleChange(user, res) {
    if (!user || !res || !res.role || res.role === user.role) return "";
    if (res.personId && user.personId && res.personId !== user.personId) {
      throw Object.assign(new Error("登入身分與後台不一致，請重新登入"), { code: "AUTH" });
    }
    return "您的職類已由 " + user.role + " 改為 " + res.role + "（依控制台授權名單）";
  }
  function idleAction(c, now, lastActivity, leaseMinutes) {
    if (!c || c.mode !== "edit") return "none";
    if (now - lastActivity <= leaseMinutes * 60000) return "none";
    return (c.dirty || c.failed) ? "keep_unsynced" : "readonly";
  }
  // 關閉／登出：最後一次存檔失敗而仍有未同步修改時，須明確放棄（列出項數）才關閉。
  function closePrompt(c) {
    if (!c || c.mode !== "edit" || !(c.dirty || c.failed)) return "";
    return "有 " + (c.unsynced || 1) + " 項修改尚未同步到雲端" + (c.failed ? "（" + c.failed + "）" : "") +
           "。按「確定」放棄這些修改並關閉；按「取消」保持開啟，稍後再試。";
  }
  // 存檔失敗之下一步：權杖失效 → 原地重新登入（保留 Worker 與修改）；網路或回應格式錯誤 → 以同一
  // saveId 重試（後台已寫入時回放結果，不誤判版本衝突）；租約或版本衝突 → 唯讀。
  function saveFailureAction(err) {
    var code = err && err.code;
    if (code === "AUTH") return "relogin";
    if (code === "LEASE" || code === "CONFLICT") return "readonly";
    if (code === "NET" || code === "BADRESP") return "retry_same_id";
    return "retry";
  }
  /*SHELL-POLICY-END*/
  /*NAV-GUARD-BEGIN*/
  // B157（v2.4 W0；2026-11-06 實環境重現）：框內頁有未儲存題目（window.PENDING 非空）時，框之
  // beforeunload 擋下換頁，外殼卻已切換標題與狀態——出現「標題已切換、框內仍舊頁」。改為：換頁前由外殼
  // 讀框內 PENDING 並明確詢問；確認才清空並換頁；換頁後核對框內路徑，未到目標即還原外殼狀態。
  function pendingInfo(win) {
    var p = null;
    try { p = win && win.PENDING; } catch (e) { return { n: 0, keys: [], readable: false }; }
    var keys = (p && typeof p === "object") ? Object.keys(p) : [];
    return { n: keys.length, keys: keys, readable: true };
  }
  function navPrompt(n, target) {
    return "目前頁面有 " + n + " 題尚未儲存（輸入後未完成存檔）。按「確定」放棄這些輸入並" +
           (target || "離開") + "；按「取消」留在本頁。";
  }
  // 回 true＝可換頁。confirmFn 回 false＝使用者取消（外殼狀態不得切換）。
  function leaveGuard(win, confirmFn, target) {
    var info = pendingInfo(win);
    if (!info.n) return true;
    if (!confirmFn(navPrompt(info.n, target))) return false;
    try { win.PENDING = {}; } catch (e) { return false; }
    return true;
  }
  // 換頁後之落點核對：target 為應用內路徑（"/dashboard"、"/e/<id>"）或 "about:blank"；base 為網站子路徑。
  function arrived(win, target, base) {
    var href = "", path = "";
    try { href = String(win.location.href); path = String(win.location.pathname); } catch (e) { return false; }
    if (target === "about:blank") return href === "about:blank";
    var want = String(base || "/") + String(target).split("?")[0].replace(/^\//, "");
    return path === want;
  }
  /*NAV-GUARD-END*/
  // B146（E-06）：病人清單之更新時間以台北時間顯示（後台存 UTC ISO；原以字串切片顯示 UTC，差 8 小時）。
  // 無法解析者原樣顯示並標註，不猜時區。
  function taipeiTime(iso) {
    const t = Date.parse(String(iso || ""));
    if (!iso) return "";
    if (isNaN(t)) return String(iso) + "（時間格式無法判讀）";
    const d = new Date(t + 8 * 3600 * 1000);
    const p2 = (n) => ("0" + n).slice(-2);
    return d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate()) + " " +
      p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + "（台北）";
  }
  function randomId() { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, (b) => ("0" + b.toString(16)).slice(-2)).join(""); }
  function syncedAt() {
    const c = S.cur; const e = $("syncAt"); if (!e) return;
    e.textContent = c && c.lastSyncAt ? "最後成功同步 " + c.lastSyncAt : "";
  }
  async function saveNow() {
    const c = S.cur; if (!c || c.mode !== "edit" || !c.dirty) return;
    if (S.saving) { await S.saving; return saveNow(); }
    S.saving = (async () => {
      c.dirty = false; setSync("同步中", "busy");
      const base = c.version;
      const sentUnsynced = c.unsynced || 0;
      if (!c.saveId) c.saveId = randomId();
      try {
        const snap = await c.W.call("snapshot");
        // B141（B-30）：只送後台尚未收到之事件；群體統計所需之本病人指標貢獻與居家代碼雜湊列一併送出。
        const k = JSON.parse(await c.W.call("kpiRowsSince", { after: c.kpiMax }));
        const tch = JSON.parse(await c.W.call("teachRowsSince", { after: c.teachMax }));
        const contrib = JSON.parse(await c.W.call("contrib"));
        const codes = JSON.parse(await c.W.call("homeCodes"));
        // B157（S-5）：交班佇列投影列（全量；只列舉值與識別碼；後台逐列驗證）。
        const handoffRows = JSON.parse(await c.W.call("handoffRows"));
        const args = { key: c.key, leaseToken: c.leaseToken, baseVersion: base, saveId: c.saveId,
                       snapshot: bufToB64(new Uint8Array(snap)), kpiRows: k.rows,
                       kpiUnparsable: k.unparsable, teachRows: tch.rows, contrib, homeCodes: codes, handoffRows };
        let r;
        try { r = await gas("savePatient", args); }
        catch (e1) {
          // 已寫入卻回錯誤頁時，以同一 saveId 再送一次：後台回放第一次之結果（A-09）。
          if (saveFailureAction(e1) !== "retry_same_id") throw e1;
          await new Promise((res) => setTimeout(res, 1500));
          r = await gas("savePatient", args);
        }
        const o = syncOutcome(base, r, null);
        if (!o.ok) { const e = new Error("伺服器未確認新版本"); e.code = "NOVERSION"; throw e; }
        c.version = o.version; c.failed = null; c.kpiMax = r.kpiMax; c.teachMax = r.teachMax;
        c.saveId = null; c.unsynced = Math.max(0, (c.unsynced || 0) - sentUnsynced);
        // 回放：後台存的是第一次送出之快照；之後之修改須再送一次。
        if (r.replay) { c.dirty = true; c.unsynced = Math.max(1, c.unsynced); }
        c.lastSyncAt = new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false });
        syncedAt(); hideRelogin();
        if (c.pendingAck) {
          try { await gas("ackHomeReports", { key: c.key, leaseToken: c.leaseToken, results: c.pendingAck }); c.pendingAck = null; }
          catch (e) { /* 下次存檔再確認；併入以送出時點去重，不會重複 */ }
        }
        const hn = handoffSyncNote(r);
        setSync(c.dirty ? "未同步（有新修改，稍後自動同步）" : o.text + hn,
                c.dirty ? "busy" : ((r.handoffRejected || []).length ? "busy" : "ok"));
        if (c.dirty) { clearTimeout(S.saveTimer); S.saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, 3000); }
      } catch (e) {
        c.dirty = true; c.failed = e.message;
        const o = syncOutcome(base, null, e);
        const act = saveFailureAction(e);
        setSync(o.text, o.cls); syncedAt();
        if (act === "relogin") {
          showRelogin();
        } else if (o.readonly) {
          c.mode = "readonly"; stopRenew(); c.saveId = null;
          alert("未能存到雲端：" + e.message + "\n本次未同步之修改不會保存。請關閉此病人後重新開啟。");
        } else {
          clearTimeout(S.saveTimer); S.saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, 15000);
        }
        throw e;
      } finally { S.saving = null; }
    })();
    return S.saving;
  }
  function startRenew() {
    stopRenew();
    S.renewTimer = setInterval(async () => {
      const c = S.cur; if (!c || c.mode !== "edit") return;
      if (idleAction(c, Date.now(), S.lastActivity, S.leaseMinutes) !== "none") {
        // 閒置逾時：先把未同步內容存上去；仍有未同步修改者保持編輯權與修改（A-08），
        // 只有已全部同步者才釋放編輯權轉唯讀。
        try { await saveNow(); } catch (e) {}
        if (idleAction(c, Date.now(), S.lastActivity, S.leaseMinutes) === "keep_unsynced") {
          setSync("閒置中：有 " + (c.unsynced || 1) + " 項未同步，保持編輯權直到同步成功", "bad");
        } else {
          c.mode = "readonly"; c.holder = "（閒置逾時，編輯權已釋放）"; stopRenew();
          setSync("閒置逾時，已轉唯讀；請關閉後重新開啟", "ro");
          return;
        }
      }
      try { await gas("renewLease", { key: c.key, leaseToken: c.leaseToken }); }
      catch (e) { if (e.code === "LEASE") { c.mode = "readonly"; stopRenew(); setSync("編輯權已失效：" + e.message, "bad"); } }
    }, 120000);
  }
  function stopRenew() { if (S.renewTimer) clearInterval(S.renewTimer); S.renewTimer = null; }

  // B143（A-08）：權杖失效時原地重新登入——保留 Worker、畫面與未同步之修改；登入成功即重送。
  async function showRelogin() {
    const c = S.cur; if (!c) return;
    $("reloginMsg").textContent = "登入已逾時：有 " + (c.unsynced || 1) + " 項修改尚未同步，仍保留在此視窗。" +
      "請重新登入以同步（不會關閉病人）。";
    $("vRelogin").hidden = false;
    try {
      await loadGis();
      const nonce = (await gas("loginNonce")).nonce;
      window.google.accounts.id.initialize({ client_id: S.pub.clientId, callback: onRelogin, nonce,
        auto_select: false, cancel_on_tap_outside: true, ux_mode: "popup", itp_support: true });
      $("gbtn2").textContent = "";
      window.google.accounts.id.renderButton($("gbtn2"), { type: "standard", theme: "outline", size: "large",
        text: "signin_with", shape: "rectangular", locale: "zh-TW", width: 260 });
    } catch (e) { $("reloginMsg").textContent += "（登入元件無法載入：" + e.message + "）"; }
  }
  function hideRelogin() { const v = $("vRelogin"); if (v) v.hidden = true; }
  async function onRelogin(resp) {
    try {
      const r = await gas("login", { idToken: resp && resp.credential });
      if (S.user && r.personId !== S.user.personId) {
        S.token = null;
        await showRelogin();
        $("reloginMsg").textContent = "請以原本之帳號重新登入（目前病人由 " + S.user.name + " 編輯中）。";
        return;
      }
      S.token = r.token; hideRelogin();
      await saveNow();
    } catch (e) {
      $("reloginMsg").textContent = "重新登入失敗：" + e.message;
      showRelogin();
    }
  }
  /* ───────── B157（S-4）：病歷號核對（病歷號只在本機換算比對；後台只收結果） ───────── */
  function showVerify() {
    const c = S.cur; if (!c || !c.verifyNeeded) return;
    $("vVerify").hidden = false; $("verifyMsg").textContent = "";
    $("vmrn").value = ""; $("vmrn").focus();
  }
  function hideVerify() { $("vVerify").hidden = true; $("vmrn").value = ""; if ($("btnVerify")) $("btnVerify").focus(); }
  async function doVerify() {
    const c = S.cur; if (!c) return;
    const mrn = String($("vmrn").value || "");
    $("vmrn").value = "";                                   // 讀取後立即清空；不寫入任何其他位置
    if (!mrn) { $("verifyMsg").textContent = "請輸入病歷號"; return; }
    let same = false;
    try { same = (await c.W.call("pseudonym", { mrn, pepper: S.pepper })) === c.key; } catch (e) { same = false; }
    let r;
    try { r = await gas("verifyLog", { key: c.key, ok: same }); }
    catch (e) { $("verifyMsg").textContent = "無法記錄核對結果：" + e.message; return; }
    if (r.locked) {
      c.lockedUntil = r.lockedUntil || ""; c.verifyNeeded = true;
      $("verifyMsg").textContent = "核對失敗次數過多，" + taipeiTime(r.lockedUntil) + " 前只能唯讀。";
      if ($("btnVerify")) $("btnVerify").hidden = true;
      setSync("唯讀：核對失敗次數過多", "ro");
      return;
    }
    if (!r.verified) {
      $("verifyMsg").textContent = "病歷號與此病人不符，請以 HIS 核對。" +
        (r.failures ? "（" + r.failures + "／" + (r.limit || 5) + "）" : "");
      $("vmrn").focus();
      return;
    }
    $("vVerify").hidden = true;
    const key = c.key;
    await closePatient("核對後重新開啟");
    if (S.cur) return;
    await openPatientByKey(key, { verified: true, source: "verify" });
  }

  async function closePatient(target) {
    const c = S.cur; if (!c) return;
    // B157（W0）：先問框內未儲存題目（取消即什麼都不變：不存檔、不釋放、不切換）。
    if (!leaveGuard($("app").contentWindow, (q) => confirm(q), target || "關閉病人")) {
      setSync("已取消離開：框內仍有未儲存題目", "busy");
      return;
    }
    if (c.mode === "edit") {
      // B130 W08：最後一次存檔失敗時保持開啟（不釋放編輯權、不關閉），狀態列顯示
      // 「未同步（原因）」；使用者可再按一次「存檔並關閉病人」重試。
      try { await saveNow(); } catch (e) { /* 由下方明確放棄確認處理 */ }
      const q = closePrompt(c);
      if (q && !confirm(q)) { setSync("未同步（" + (c.unsynced || 1) + " 項）；病人保持開啟", "bad"); return; }
    }
    // B157（W0）：框須確實離開舊頁才關閉；未離開（框之 beforeunload 擋下等）即還原外殼狀態並告知。
    if (!(await navBlank())) {
      setSync("無法離開目前頁面（框內頁拒絕換頁）；病人保持開啟，請先完成或清除未儲存之題目", "bad");
      return;
    }
    if (c.mode === "edit") {
      try { await gas("releaseLease", { key: c.key, leaseToken: c.leaseToken }); } catch (e) {}
    }
    hideRelogin();
    if ($("btnVerify")) $("btnVerify").hidden = true;
    if ($("vVerify")) { $("vVerify").hidden = true; $("vmrn").value = ""; }
    stopRenew(); clearTimeout(S.saveTimer);
    c.W.kill(); S.cur = null;
    prepareSpare();
    await showPatients();
  }

  /* ───────── 儀表板（群體統計由後台計算；後台只回彙總） ───────── */
  async function openDashboard() {
    if (S.cur) await closePatient("開啟儀表板");
    if (S.cur) return;
    loadMsg("向後台取得群體統計…");
    const d = await gas("dashboard");
    loadMsg(quickSummary(d.aggregates));
    const W = await takeWorker();
    try {
      await W.call("setupDashboard", { dataDir: "/data/_dashboard", aggregates: JSON.stringify(d.aggregates),
                                       principalId: S.user.personId, displayName: S.user.name, role: S.user.role,
                                       pepper: S.pepper, secretKey: randomKey(), adoptions: S.adoptions,
                                       siteTables: S.siteTables, siteSettings: S.siteSettings });
      S.cur = { W, key: "_dashboard", mode: "dashboard", holder: "", version: 0 };
      enterApp("/dashboard");
      $("pt").textContent = "儀表板：" + d.patients + " 位病人、" + d.events + " 筆事件";
      setSync("唯讀", "ro");
    } catch (e) { W.kill(); prepareSpare(); S.cur = null; throw e; }
    await verifyArrival("/dashboard");
  }

  /* ───────── 居家回報（#home-report）：不登入、不載入引擎 ───────── */
  const H = { code: "", nonce: "", form: null };
  function startHome() {
    show("vHome");
    $("homeBanner").textContent = "試用入口，非身分驗證；僅限虛構病例。請勿輸入姓名、電話或病歷號。";
    if (!S.pub.homeReport) {
      $("fHome1").hidden = true;
      $("homeMsg").textContent = "居家回報目前未開放。有不舒服請依衛教單之聯絡方式打電話。";
      return;
    }
    $("fHome1").onsubmit = async (e) => {
      e.preventDefault();
      $("homeMsg").textContent = ""; $("homeDone").textContent = ""; $("homeCrit").textContent = "";
      await homeOpen($("hcode").value);
    };
  }
  async function homeOpen(code) {
    try {
      const r = await gas("homeOpen", { code });
      H.code = code; H.nonce = r.nonce; H.form = r.form;
      $("fHome1").hidden = true;
      renderHomeForm(r.remaining);
    } catch (err) { $("homeMsg").textContent = err.message; }
  }
  function renderHomeForm(remaining) {
    const box = $("homeForm"); box.textContent = "";
    const f = H.form;
    if (remaining <= 0) { box.appendChild(el("p", { class: "bad", role: "alert" }, f.limit_reached)); return; }
    box.appendChild(el("h2", {}, "今天的情況"));
    box.appendChild(el("p", { class: "why" }, "今天還可以回報 " + remaining + " 次。" + (f.intro || "")));
    const form = el("form", { id: "fHome2" });
    f.fields.forEach((fd) => {
      if (fd.type === "number") {
        const id = "h-" + fd.key;
        form.appendChild(el("label", { for: id }, fd.label));
        form.appendChild(el("input", { id, name: fd.key, inputmode: "decimal", autocomplete: "off" }));
      } else {
        const fs = el("fieldset", { class: "hopts" });
        fs.appendChild(el("legend", {}, fd.label));
        fd.options.forEach((o, i) => {
          const id = "h-" + fd.key + "-" + i;
          const lab = el("label", { for: id, class: "popt" });
          lab.appendChild(el("input", { type: "radio", id, name: fd.key, value: o[0] }));
          lab.appendChild(el("span", {}, o[1]));
          fs.appendChild(lab);
        });
        form.appendChild(fs);
      }
    });
    if (f.free_text_note) form.appendChild(el("p", { class: "why" }, f.free_text_note));
    const p = el("p"); p.appendChild(el("button", { type: "submit" }, "送出給護理師看")); form.appendChild(p);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const values = {};
      f.fields.forEach((fd) => {
        if (fd.type === "number") { const v = form.querySelector("[name='" + fd.key + "']").value.trim(); if (v) values[fd.key] = v; }
        else { const c = form.querySelector("[name='" + fd.key + "']:checked"); if (c) values[fd.key] = c.value; }
      });
      $("homeMsg").textContent = "";
      try {
        const r = await gas("homeReport", { code: H.code, nonce: H.nonce, values });
        box.textContent = "";
        if (r.critical) renderCritical(f.critical_help);
        $("homeDone").textContent = (f.sent || "已送出。") + " 今天還可以回報 " + r.remaining + " 次。";
        const again = el("button", { type: "button", class: "sec" }, "再回報一次");
        again.onclick = () => { $("homeDone").textContent = ""; $("homeCrit").textContent = ""; homeOpen(H.code); };
        box.appendChild(again);
      } catch (err) {
        $("homeMsg").textContent = "未送出：" + err.message;
        if (/已送出過|已失效/.test(err.message)) { homeOpen(H.code); }
      }
    };
    box.appendChild(form);
  }
  function renderCritical(c) {
    const box = $("homeCrit"); box.textContent = "";
    const sec = el("section", { class: "alarmcard", role: "alert" });
    sec.appendChild(el("h2", {}, c.title));
    sec.appendChild(el("p", {}, c.lead));
    const ul = el("ul"); (c.items || []).forEach((x) => ul.appendChild(el("li", {}, x))); sec.appendChild(ul);
    box.appendChild(sec);
  }

  /* ───────── 公開衛教（#learn） ───────── */
  async function startLearn() {
    show("vLearn");
    const box = $("learnBody"); box.textContent = "";
    if (!S.pub.learn) { box.appendChild(el("p", {}, "公開衛教頁目前未開放。")); return; }
    try {
      const c = (await gas("learn")).content;
      box.appendChild(el("p", { class: "note", role: "note" }, c.banner));
      box.appendChild(el("h1", {}, c.title));
      c.topics.forEach((t) => {
        const a = el("article", { class: "ltopic" });
        a.appendChild(el("h2", {}, t.name));
        a.appendChild(el("p", {}, t.do));
        a.appendChild(el("p", { class: "why" }, "為什麼：" + t.why));
        a.appendChild(el("p", { class: "why" }, "說說看：" + t.check));
        box.appendChild(a);
      });
      (c.red_flags || []).forEach((lv, i) => {
        const s = el("section", { class: i ? "alarmcard" : "warncard" });
        s.appendChild(el("h2", {}, lv.level));
        const ul = el("ul"); lv.items.forEach((x) => ul.appendChild(el("li", {}, x))); s.appendChild(ul);
        box.appendChild(s);
      });
      box.appendChild(el("p", { class: "why" }, c.footer));
    } catch (e) { box.appendChild(el("p", { class: "bad" }, "讀取失敗：" + e.message)); }
  }

  /* ───────── 事件 ───────── */
  $("fOpen").onsubmit = async (e) => {
    e.preventDefault();
    $("vConfirm").hidden = true;
    const mrn = $("mrn").value.trim(); if (!mrn) return;
    try { await openPatient(mrn, false); if (S.cur) $("mrn").value = ""; }
    catch (err) { await showPatients("開啟失敗：" + err.message); }
  };
  $("btnClose").onclick = () => closePatient().catch((e) => alert(e.message));
  $("btnDiscard").onclick = () => closePatient().catch((e) => alert(e.message));
  $("btnDash").onclick = () => openDashboard().catch((e) => showPatients("儀表板：" + e.message));
  // B157：首頁交班與團隊清單、核對對話框（Esc 關閉；Enter 送出）。
  $("vPatients").addEventListener("click", onHomeClick);
  $("fTeam").onsubmit = (e) => { e.preventDefault(); filterTeam(); };
  $("btnHomeRefresh").onclick = () => showHome();
  $("btnVerify").onclick = () => showVerify();
  $("fVerify").onsubmit = (e) => { e.preventDefault(); doVerify().catch((err) => { $("verifyMsg").textContent = err.message; }); };
  $("btnVerifyCancel").onclick = () => hideVerify();
  $("vVerify").addEventListener("keydown", (e) => { if (e.key === "Escape") hideVerify(); });
  $("btnOut").onclick = async () => {
    if (S.cur) await closePatient();
    if (S.cur) return;
    try { await gas("logout"); } catch (e) {}
    try { if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect(); } catch (e) {}
    S.token = null; S.user = null; location.reload();
  };
  ["mousedown", "keydown", "touchstart"].forEach((t) => document.addEventListener(t, () => { S.lastActivity = Date.now(); }, true));
  window.addEventListener("message", (ev) => { if (ev.source === $("app").contentWindow) S.lastActivity = Date.now(); });
  $("app").addEventListener("load", () => {
    try { const d = $("app").contentDocument;
      ["mousedown", "keydown", "touchstart"].forEach((t) => d.addEventListener(t, () => { S.lastActivity = Date.now(); }, true));
    } catch (e) {}
  });
  // 入口切換（同一網頁；未登入、未開病人時才切換）。
  window.addEventListener("hashchange", () => { if (!S.cur && !S.token) location.reload(); });
  // B130 W08：有未同步修改時一律觸發瀏覽器離開確認；不在此宣稱已存
  //（非同步請求於頁面卸載時不保證送達）。
  window.addEventListener("beforeunload", (e) => {
    if (S.cur && S.cur.dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ───────── 進入點 ───────── */
  async function main() {
    if (!CFG.gasUrl) { loadMsg("尚未設定雲端後台網址：請管理者編輯 hfweb/config.js，填入 Apps Script 網頁應用程式網址。", true); return; }
    try { S.pub = await gas("publicConfig"); }
    catch (e) { loadMsg("連不到雲端後台：" + e.message, true); return; }
    if (S.pub.siteName) $("site").textContent = S.pub.siteName;
    if (MODE === "home-report") { startHome(); return; }
    if (MODE === "learn") { await startLearn(); return; }
    if (!("serviceWorker" in navigator)) { loadMsg("此瀏覽器不支援本系統（需要較新版之 Chrome 或 Edge）。", true); return; }
    if (bc) {
      const other = await new Promise((res) => { const t = setTimeout(() => res(false), 400);
        const h = (e) => { if (e.data === "here") { clearTimeout(t); bc.removeEventListener("message", h); res(true); } };
        bc.addEventListener("message", h); bc.postMessage("ping"); });
      if (other) { loadMsg("HF-Care 已在另一個分頁開啟。請回到那個分頁使用（同時開兩個分頁會互相覆蓋）。", true); return; }
    }
    loadMsg("準備中…");
    await navigator.serviceWorker.register(BASE + "sw.js", { scope: BASE });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((res) => { navigator.serviceWorker.addEventListener("controllerchange", res, { once: true }); setTimeout(res, 3000); });
    }
    await startLogin();
  }
  main().catch((e) => loadMsg("啟動失敗：" + e.message, true));
})();
