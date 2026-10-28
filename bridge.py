# -*- coding: utf-8 -*-
"""HF-Care 瀏覽器版：Web Worker 內之 Python 端橋接（B127 T-A）。

一個 Worker ＝ 一個 Python 行程 ＝ 一位病人的資料目錄（或一個儀表板彙整目錄）。
引擎與網頁程式（hfcare_engine／hfcare_app）原樣載入，本檔只做部署層的事：

* 在 Worker 的記憶體檔案系統上還原／匯出該病人之資料目錄（SQLite 檔）。
* 建立本機臨時帳號並以 Flask test client 登入。身分驗證由 Apps Script 執行；
  這個帳號只存在於這位病人的資料檔內，密碼為亂數、從不顯示、不作為身分依據。
* 把 Service Worker 轉來之 HTTP 請求交給 WSGI 應用，原樣回傳（不跟隨重導）。
* 存檔時交給 Apps Script 之資料（B141）：只送新增之 KPI 事件與去識別教學事件、本病人對各
  ESC 指標之分子分母貢獻（群體統計在伺服器加總）、居家回報代碼之雜湊列。
* 開病人時併入病人在家以代碼送到後台之回報（B141 W07）。
* 一個 Worker 只開一位病人：框內以其他病歷號開啟就診一律拒絕（B141；同一病人同一份真相）。

不改引擎任何判定；不補任何臨床值。
"""
import io
import json
import re
import os
import secrets
import sqlite3
import zipfile


def _as_bytes(x):
    """JS 之 Uint8Array（JsProxy）或 Python bytes → bytes。"""
    if x is None or type(x).__name__ in ("JsNull", "JsUndefined"):
        return None
    if hasattr(x, "to_bytes"):
        return x.to_bytes()
    return bytes(x)


_STATE = {"app": None, "client": None, "cfg": None, "data_dir": None,
          "principal_id": None, "patient_key": None, "pepper": None}

#: 瀏覽器版之職類來源（B141 W09）：控制台「授權名單」為唯一身分與職類來源。
ROLE_SOURCE = "site_authz_list"
#: 伺服器彙總檔之格式（B141 W05；Apps Script 之 dashboard 回傳）。
SERVER_AGG_ENV = "HFCARE_SERVER_AGGREGATES_FILE"

#: 資料目錄內允許匯出的檔案（其餘一律不帶走，例如速率限制之暫存）。
_SNAPSHOT_SUFFIXES = (".db", ".sqlite", ".db-wal", ".sqlite-wal")
_SNAPSHOT_EXCLUDE = ("rate_limit",)


def _sqlite_files(d):
    out = []
    for name in sorted(os.listdir(d)):
        if any(name.startswith(x) for x in _SNAPSHOT_EXCLUDE):
            continue
        if name.endswith((".db", ".sqlite")):
            out.append(os.path.join(d, name))
    return out


def restore(data_dir, zip_bytes=None):
    """清空並還原資料目錄。zip_bytes 為 None 表示新病人（空目錄）。"""
    os.makedirs(data_dir, exist_ok=True)
    for name in os.listdir(data_dir):
        os.remove(os.path.join(data_dir, name))
    zip_bytes = _as_bytes(zip_bytes)
    if zip_bytes:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
            for info in z.infolist():
                base = os.path.basename(info.filename)
                if base != info.filename or not base.endswith(
                        (".db", ".sqlite")):
                    raise ValueError("快照含不允許之檔案：%r" % info.filename)
                with open(os.path.join(data_dir, base), "wb") as fh:
                    fh.write(z.read(info))
    return sorted(os.listdir(data_dir))


def snapshot():
    """以 SQLite 線上備份（backup API）取得每個資料庫之一致性複本，打包為 zip bytes。

    應用之連線可能仍開著（WAL 模式）；backup API 會取得一致之快照而不需關閉連線，
    也不必另帶 -wal／-shm 檔。
    """
    import shutil
    import tempfile
    d = _STATE["data_dir"]
    tmp = tempfile.mkdtemp(prefix="hf_snapshot_")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for path in _sqlite_files(d):
            dst_path = os.path.join(tmp, os.path.basename(path))
            if os.path.exists(dst_path):
                os.remove(dst_path)
            src = sqlite3.connect(path)
            dst = sqlite3.connect(dst_path)
            try:
                src.backup(dst)
            finally:
                dst.close()
                src.close()
            z.write(dst_path, os.path.basename(path))
            os.remove(dst_path)
    shutil.rmtree(tmp, ignore_errors=True)
    return buf.getvalue()


def _kpi_seq(event_id):
    m = re.fullmatch(r"KPIEV-(\d+)", str(event_id or ""))
    return int(m.group(1)) if m else None


def kpi_rows_since(after_seq=0):
    """B141（B-30）：序號大於 after_seq 之 KPI 事件（只送新增者）。

    回傳 JSON {rows, max_seq, unparsable}。事件編號為本資料檔之流水號（KPIEV-000001 起）；
    編號無法解析者不送，計數照實回傳（後台記入操作紀錄），不靜默略過。"""
    rows = json.loads(kpi_rows())
    after = int(after_seq or 0)
    seqs = [_kpi_seq(r.get("event_id")) for r in rows]
    out = [r for r, q in zip(rows, seqs) if q is not None and q > after]
    mx = max([after] + [q for q in seqs if q is not None])
    return json.dumps({"rows": out, "max_seq": mx,
                       "unparsable": sum(1 for q in seqs if q is None)}, ensure_ascii=False)


#: 教學事件匯出之欄位（B141，B-25）：教學成效儀表板（cbme_universal.teaching_dashboard）
#: 所需之欄位；回饋、行動計畫、重評時點三項自由文字只以「有無」匯出，不帶文字。
TEACH_EXPORT_FIELDS = ("event_type", "learner_role", "training_stage", "activity",
                       "competency_area", "observation_mode", "supervision_level",
                       "assessment_mode", "learner_ref", "observer_ref", "observation_ref",
                       "reassessment_due_date", "timestamp")


def teaching_rows_since(after_id=0):
    """B141：本病人資料檔中編號大於 after_id 之教學事件（去識別）。回傳 JSON {rows, max_id}。"""
    path = _STATE["cfg"].teaching_events_db
    after = int(after_id or 0)
    if not os.path.exists(path):
        return json.dumps({"rows": [], "max_id": after})
    c = sqlite3.connect(path)
    try:
        got = c.execute("SELECT id, payload FROM teaching_event WHERE id>? ORDER BY id",
                        (after,)).fetchall()
    finally:
        c.close()
    rows = []
    for rid, payload in got:
        ev = json.loads(payload)
        row = {k: ev.get(k) for k in TEACH_EXPORT_FIELDS}
        row.update(row_id=rid, has_feedback=bool(ev.get("feedback")),
                   has_action_plan=bool(ev.get("action_plan")),
                   has_reassessment_due=bool(ev.get("reassessment_due")))
        rows.append(row)
    return json.dumps({"rows": rows, "max_id": max([after] + [r["row_id"] for r in rows])},
                      ensure_ascii=False)


def contributions():
    """B141 W04：本病人對各 ESC 指標之分子與分母（伺服器加總為群體統計）。

    各指標之分子分母皆以病人（或該病人之就診、事件、議題）為單位，不同病人之資料檔互不相交，
    因此逐病人加總等於合併計算（一致性測試 test_b141 核對）。"""
    from hfcare_engine import kpi_events as KE
    _STATE["app"].extensions["hfcare"]["kpi_reinstall"]()
    res = KE.compute_all_kpi_metrics()
    # B146（E-05、G5）：除役指標（LOCAL-BAL-3）不進病人貢獻；結構指標（ESC-1.x）以控制台
    # 「結構聲明」工作表於後台計算（院層級，非逐病人加總），亦不進病人貢獻。
    out = {mid: {"numerator": r.get("numerator"), "denominator": r.get("denominator")}
           for mid, r in sorted(res.items())
           if mid not in KE.DEPRECATED_METRICS and not mid.startswith("ESC-1.")}
    # B147（S2-02、BS-07）：時窗型指標之計數與到期日（不含出院日、追蹤日、識別碼）；
    # 後台以台北當日重判到期未追蹤者（不待本病人下次開檔）。
    out["_windows"] = KE.window_contribution()
    # B149（S4；C-06～C-08）：月別（近 12 個月；只送有分母之月份）、分層值、可量測指標之照護缺口。
    from hfcare_engine import kpi_stats as KS
    from hfcare_engine import kpi_measurability as KM
    today = KE.taipei_today()
    out["_monthly"] = KS.monthly_contribution(KS.recent_months(today, 12))
    st = _STATE["app"].extensions["hfcare"]["store"]
    lab = st.latest_answers_by_pseudonym()
    pid = _STATE.get("patient_key") or (sorted(lab)[0] if lab else "")
    strata = KS.strata_of_patients({p: v["answers"] for p, v in lab.items()},
                                   {p: v["setting"] for p, v in lab.items()})
    out["_strata"] = strata.get(pid) or {"phenotype": "未宣告", "setting": "未指定",
                                         "age": "未知", "sex": "未知"}
    if out["_strata"]["setting"] not in ("住院", "門診", "急診", "居家"):
        out["_strata"]["setting"] = "未指定"
    measurable = [m for m in KE.kpi_metric_ids() if KM.permits_rate(m)]
    out["_gaps"] = {"metrics": KS.patient_gaps(pid, measurable) if pid else [], "since": today}
    return json.dumps(out, sort_keys=True, ensure_ascii=False)


def latest_encounter():
    """B149（C-07）：本資料檔最近之就診編號（外殼以假名鍵開檔後導向；不經病歷號）。"""
    return _STATE["app"].extensions["hfcare"]["store"].latest_encounter_id()


def home_codes_export():
    """B141 W07：本資料檔之居家回報代碼雜湊列（後台驗碼用；明碼從未落地）。"""
    return json.dumps(_STATE["app"].extensions["hfcare"]["store"].home_codes_for_backend(),
                      ensure_ascii=False)


def import_home_reports(reports_json):
    """B141 W07：併入病人在家以代碼送到後台之回報。逐筆回傳 imported／duplicate／rejected；
    驗證與共讀入口同一條路（store.add_patient_report），不合者照實回報、不併入。"""
    from hfcare_app.store import StoreError
    st = _STATE["app"].extensions["hfcare"]["store"]
    out = []
    for r in json.loads(reports_json or "[]"):
        rid = str(r.get("id") or "")
        try:
            got = st.import_home_report(str(r.get("encounter_id") or ""), str(r.get("code_id") or ""),
                                        str(r.get("submitted_at") or ""), dict(r.get("values") or {}))
            out.append({"id": rid, "status": "duplicate" if got.get("duplicate") else "imported",
                        "report_id": got.get("report_id")})
        except (StoreError, ValueError, TypeError) as exc:
            out.append({"id": rid, "status": "rejected", "error": str(exc)[:200]})
    return json.dumps(out, ensure_ascii=False)


def kpi_rows():
    """本病人之 KPI 事件（append-only）。回傳 JSON 字串。"""
    path = os.path.join(_STATE["data_dir"], "kpi_events.sqlite")
    if not os.path.exists(path):
        return "[]"
    c = sqlite3.connect(path)
    try:
        rows = c.execute("SELECT payload FROM kpi_event ORDER BY event_id").fetchall()
    finally:
        c.close()
    return json.dumps([json.loads(r[0]) for r in rows], ensure_ascii=False)


def build_aggregate(data_dir, groups_json):
    """把各病人之 KPI 事件合入一個彙整目錄（合併計算之參考實作）。

    B141 起外殼之儀表板改用伺服器彙總（後台不回原始事件）；本函式保留為一致性測試之
    「合併計算」對照（逐病人加總須與之相等）。

    各病人資料庫之事件編號各自由 KPIEV-000001 起算，合併時加上病人鍵前綴，
    避免編號相撞；payload 其餘欄位不動（分母以 payload 內之 patient_id 計）。
    """
    restore(data_dir, None)
    from hfcare_app import domain_events as DE
    sink = DE.KpiSqliteSink(os.path.join(data_dir, "kpi_events.sqlite"))
    n = 0
    for grp in json.loads(groups_json):
        key = str(grp["patient_key"])[:12]
        for row in grp.get("rows") or ():
            row = dict(row)
            row["event_id"] = "AGG-%s-%s" % (key, row["event_id"])
            if row.get("source_record_id"):
                row["source_record_id"] = "%s:%s" % (key, row["source_record_id"])
            # B135 D01：工作紀錄事件之冪等鍵與聚合鍵亦加前綴——各病人資料庫之流水號
            # 互不相干，跨病人同鍵不得被投影去重成一筆。
            if row.get("idempotency_key"):
                row["idempotency_key"] = "%s:%s" % (key, row["idempotency_key"])
                row["aggregate_id"] = "%s:%s" % (key, row.get("aggregate_id") or "")
            sink.append_kpi_event(row)
            n += 1
    return n


def setup(data_dir, principal_id, display_name, role, pepper, secret_key,
          adoptions_json="[]", site_tables_json="{}", site_settings_json="{}",
          patient_key="", _aggregates_path=""):
    """在 data_dir 上建立應用、確保本機臨時帳號存在並登入。

    adoptions_json：試算表「站點採納」工作表之具名採納列（可為空）。
    有列時寫成站點採納檔並設 HFCARE_SITE_ADOPTION_FILE；引擎於啟動時覆核
    權責角色與委任紀錄，任何一列不合即不啟動（與伺服器版同一條路徑）。
    site_settings_json（B141 W02）：控制台「設定」之站點值；值域不合即不啟動。
    patient_key（B141）：本 Worker 之病人假名鍵；框內以其他病歷號開啟就診一律拒絕。
    principal_id 為控制台「授權名單」之 person_id；職類每次以名單為準（B141 W09）。
    """
    os.environ.update(
        HFCARE_MODE="prototype", HFCARE_ENVIRONMENT="staging",
        HFCARE_DATA_DIR=data_dir, HFCARE_MRN_PEPPER=pepper,
        HFCARE_SECRET_KEY=secret_key)
    parent = os.path.dirname(os.path.abspath(data_dir))
    settings = json.loads(site_settings_json or "{}")
    if settings:
        spath = os.path.join(parent, "site_settings.json")
        with open(spath, "w", encoding="utf-8") as fh:
            json.dump(settings, fh, ensure_ascii=False)
        os.environ["HFCARE_SITE_SETTINGS_FILE"] = spath
    else:
        os.environ.pop("HFCARE_SITE_SETTINGS_FILE", None)
    if _aggregates_path:
        os.environ[SERVER_AGG_ENV] = _aggregates_path
    else:
        os.environ.pop(SERVER_AGG_ENV, None)
    adoptions = json.loads(adoptions_json or "[]")
    if adoptions:
        path = os.path.join(os.path.dirname(os.path.abspath(data_dir)),
                            "site_adoption.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"adoptions": adoptions}, fh, ensure_ascii=False)
        os.environ["HFCARE_SITE_ADOPTION_FILE"] = path
    else:
        os.environ.pop("HFCARE_SITE_ADOPTION_FILE", None)
    # B132：試算表「藥名對照」（B134 起另含「詞彙」）→ 站點覆寫表檔。
    tables = json.loads(site_tables_json or "{}")
    # B146（G5）：結構聲明鍵存在（即使空列）亦寫檔，讓引擎知道站點表已提供（空＝未聲明，計 0）。
    # B150：指標目標、介入註記（院方填）同一檔。
    if any(tables.get(k) for k in ("drug_name_map", "vocab_zh")) or \
            any(k in tables for k in ("structure_declarations", "metric_targets",
                                      "metric_interventions")):
        tpath = os.path.join(os.path.dirname(os.path.abspath(data_dir)), "site_tables.json")
        with open(tpath, "w", encoding="utf-8") as fh:
            json.dump(tables, fh, ensure_ascii=False)
        os.environ["HFCARE_SITE_TABLES_FILE"] = tpath
    else:
        os.environ.pop("HFCARE_SITE_TABLES_FILE", None)
    from hfcare_app.auth import AuthError, UserStore
    from hfcare_app.app import create_app
    from hfcare_app.config import AppConfig
    cfg = AppConfig(data_dir=data_dir, mode="prototype")
    pre = cfg.preflight()
    if not pre["startup_permitted"]:
        raise RuntimeError("啟動前檢查未通過：" + "、".join(pre["blocking_failures"]))
    users = UserStore(cfg.users_db, persistence=cfg.persistence(),
                      use_default_registry=True)
    pw = "Lx" + secrets.token_urlsafe(24) + "!9"
    if users.get_user(principal_id) is None:
        users.create_user(principal_id, display_name, role, pw,
                          must_change=False, role_source=ROLE_SOURCE)
    else:
        users.set_password(principal_id, pw)
        row = users.get_user(principal_id)
        # B141 W09（POL-26）：原以 local 來源寫入名單職類——非權威來源之提權不生效，
        # 名單把護理師改為醫師後，既有病人檔仍以護理師開啟（B-29）。
        if row["role"] != role or (row.get("role_source") or "local") != ROLE_SOURCE:
            users.set_role(principal_id, role, source=ROLE_SOURCE,
                           reason="控制台授權名單之職類（每次登入以名單為準）",
                           by_principal_id=principal_id)
    app = create_app(cfg)
    client = app.test_client()
    page = client.get("/login").get_data(as_text=True)
    import re
    m = (re.search(r"name='csrf' value='([^']+)'", page)
         or re.search(r'name="csrf" value="([^"]+)"', page))
    r = client.post("/login", data={"principal_id": principal_id,
                                    "password": pw,
                                    "csrf": m.group(1) if m else ""})
    if r.status_code not in (302, 303):
        raise RuntimeError("本機登入失敗（%s）" % r.status_code)
    _STATE.update(app=app, client=client, cfg=cfg, data_dir=data_dir,
                  principal_id=principal_id, patient_key=str(patient_key or "") or None,
                  pepper=pepper)
    return {"engine_version": cfg.engine_version}


def setup_dashboard(data_dir, aggregates_json, principal_id, display_name, role, pepper,
                    secret_key, adoptions_json="[]", site_tables_json="{}",
                    site_settings_json="{}"):
    """B141 W05：儀表板 Worker——以後台計算之群體統計（只有彙總，無任何病人事件）呈現。"""
    agg = json.loads(aggregates_json)
    if not isinstance(agg, dict) or agg.get("schema") != "hfcare.server_aggregates/1":
        raise ValueError("後台彙總格式不符，不呈現儀表板")
    restore(data_dir, None)
    path = os.path.join(os.path.dirname(os.path.abspath(data_dir)), "server_aggregates.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(agg, fh, ensure_ascii=False)
    return setup(data_dir, principal_id, display_name, role, pepper, secret_key,
                 adoptions_json, site_tables_json, site_settings_json, "",
                 _aggregates_path=path)


def pseudonym(mrn, pepper):
    """病歷號 → 假名（與伺服器版同一函式、同一 pepper）。病歷號只在本 Worker 內。"""
    from hfcare_app import phi
    return phi.pseudonymize(str(mrn), str(pepper))


#: 網站位於子路徑（例：https://帳號.github.io/hfcare/）時，應用輸出中寫死之根目錄網址
#: 須加上前綴。只改三種位置：href／action／src 屬性、作答頁之 SAVE_URL、重導 Location。
_ABS_ATTR = re.compile(r"""(\b(?:href|action|src|formaction)=)(['"])/(?!/)""")
_ABS_SAVE = re.compile(r"""(SAVE_URL=)(['"])/(?!/)""")


def rebase_html(text, base):
    """把應用輸出中之根目錄網址改為子路徑網址（base 以 / 結尾；"/" 時原樣）。"""
    if not base or base == "/":
        return text
    text = _ABS_ATTR.sub(lambda m: m.group(1) + m.group(2) + base, text)
    return _ABS_SAVE.sub(lambda m: m.group(1) + m.group(2) + base, text)


_OTHER_PATIENT_MSG = ("此畫面只能開啟目前這位病人（同一個病歷號）。要開啟其他病人，"
                      "請先按上方「存檔並關閉病人」，再輸入另一個病歷號。")


def _other_patient_guard(method, path, ctype, body):
    """B141：一個 Worker（一個病人資料檔）只容一位病人。

    首頁「以病歷號開啟就診」（POST /）之病歷號換算之假名須等於本 Worker 之病人鍵；不符、
    無法解析或非表單格式一律拒絕（fail-closed）。原狀：框內可輸入另一病歷號，另一位病人之
    就診與事件寫進本病人之資料檔，儀表板因而重複計數。"""
    key = _STATE.get("patient_key")
    if not key or str(method).upper() != "POST" or path.split("?", 1)[0] != "/":
        return None
    mrn = ""
    if (ctype or "").split(";")[0].strip().lower() == "application/x-www-form-urlencoded":
        from urllib.parse import parse_qs
        mrn = (parse_qs((body or b"").decode("utf-8", "replace")).get("mrn") or [""])[0]
    if mrn:
        try:
            if pseudonym(mrn, _STATE["pepper"]) == key:
                return None
        except Exception:                       # noqa: BLE001
            # 病歷號格式不合：交給應用以同一函式（phi.pseudonymize）拒收並顯示原因，不建立就診。
            return None
    import base64
    page = ("<!doctype html><meta charset=utf-8><title>HF-Care</title>"
            "<p style='font-family:sans-serif'>" + _OTHER_PATIENT_MSG + "</p>").encode("utf-8")
    return json.dumps({"status": 409, "headers": [["Content-Type", "text/html; charset=utf-8"]],
                       "body_b64": base64.b64encode(page).decode("ascii")})


def request(method, path, headers_json, body, base="/"):
    """把一筆 HTTP 請求交給應用。回傳 JSON 字串（status、headers、body_b64）。

    path 為應用內路徑（已去除網站子路徑）；base 為網站子路徑（例 "/hfcare/"）。
    """
    import base64
    client = _STATE["client"]
    if client is None:
        raise RuntimeError("應用尚未啟動")
    hdr = json.loads(headers_json or "{}")
    ctype = hdr.pop("content-type", None)
    kw = {"method": method, "headers": hdr}
    body = _as_bytes(body)
    blocked = _other_patient_guard(method, path, ctype, body)
    if blocked is not None:
        return blocked
    if body:
        kw["data"] = body
        if ctype:
            kw["content_type"] = ctype
    resp = client.open(path, **kw)
    out_h = []
    for k, v in resp.headers.items():
        lk = k.lower()
        if lk in ("set-cookie", "content-length", "strict-transport-security"):
            continue
        if lk == "content-security-policy":
            # 本版以外殼頁之畫面框（同源）承載應用頁：frame-ancestors 由 'none' 放寬為 'self'，
            # 仍拒絕任何其他網域嵌入（防點擊劫持之目的不變）；CSP 其餘指令原樣保留。
            v = v.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
        elif lk == "x-frame-options":
            v = "SAMEORIGIN"
        if lk == "location":
            # test client 會把相對位置補成 http://localhost/...；還原為路徑。
            for pre in ("http://localhost", "https://localhost"):
                if v.startswith(pre):
                    v = v[len(pre):] or "/"
            if base and base != "/" and v.startswith("/") and not v.startswith("//"):
                v = base + v[1:]
        out_h.append([k, v])
    data = resp.get_data()
    ctype_out = resp.headers.get("Content-Type", "")
    if base and base != "/" and ("text/html" in ctype_out or "javascript" in ctype_out):
        data = rebase_html(data.decode("utf-8"), base).encode("utf-8")
    if "text/html" in ctype_out:
        # 畫面框內之照護頁：品牌頁首由外殼之工作階段狀態列取代（同一身分只出現一次）。
        if b"<body>" in data:
            data = data.replace(b"<body>", b"<body class='embedded'>", 1)
        else:   # B129：頁面自帶 class（例：病人版呈現模式）時併入 embedded
            data = data.replace(b"<body class='", b"<body class='embedded ", 1)
    return json.dumps({"status": resp.status_code, "headers": out_h,
                       "body_b64": base64.b64encode(data).decode("ascii")})
