/* HF-Care 瀏覽器版：一個 Worker ＝ 一個 Python 行程（B127 T-A）。
 * 引擎在這裡原樣執行；本檔只負責載入、訊息往返與 scrypt 之補件。 */
import { loadPyodide } from "./pyodide/pyodide.mjs";

// scrypt-js 為 UMD 格式；模組型 Worker 無 importScripts，以 self 為 this 執行一次。
const _scryptReady = fetch(new URL("./vendor/scrypt.js", import.meta.url))
  .then((r) => r.text()).then((t) => { new Function(t).call(self); });

let py = null;
let bridge = null;

/* 瀏覽器版 Python 無 OpenSSL，hashlib.scrypt 不存在。以 scrypt-js 補上同一演算法、
 * 同一參數（n=2^14, r=8, p=1），結果與 CPython 之 hashlib.scrypt 逐位元組相同
 * （由 tests/test_b127_web_runtime.py 以測試向量核對）。不降級、不改參數。 */
const SCRYPT_SHIM = `
import hashlib, js
def _hf_scrypt(password, *, salt, n, r, p, maxmem=0, dklen=64):
    out = js.scrypt.syncScrypt(js.Uint8Array.new(bytes(password)),
                               js.Uint8Array.new(bytes(salt)), n, r, p, dklen)
    return bytes(out.to_bytes())
if not hasattr(hashlib, "scrypt"):
    hashlib.scrypt = _hf_scrypt
`;

async function init(args) {
  const t0 = Date.now();
  await _scryptReady;
  if (!self.scrypt || !self.scrypt.syncScrypt) throw new Error("scrypt-js 載入失敗");
  py = await loadPyodide({ indexURL: new URL("./pyodide/", import.meta.url).href });
  py.runPython(SCRYPT_SHIM);
  py.unpackArchive(args.sitePackages, "zip", { extractDir: "/hfsite" });
  py.unpackArchive(args.engine, "zip", { extractDir: "/app" });
  py.FS.mkdir("/hfweb");
  py.FS.writeFile("/hfweb/bridge.py", args.bridgeSource);
  py.runPython(`
import sys, os
sys.path[0:0] = ["/hfsite", "/app", "/hfweb"]
os.chdir("/app")
import bridge
`);
  bridge = py.pyimport("bridge");
  // 預先載入引擎（最耗時的一步），之後開病人只需建應用。
  py.runPython("import hfcare_app.app");
  return { ms: Date.now() - t0, python: py.version };
}

function b64ToBytes(b64) {
  const s = atob(b64); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

const handlers = {
  init,
  restore: (a) => bridge.restore(a.dataDir, a.zip ? a.zip : undefined).toJs(),
  setup: (a) => bridge.setup(a.dataDir, a.principalId, a.displayName, a.role,
                              a.pepper, a.secretKey, JSON.stringify(a.adoptions || []),
                              JSON.stringify(a.siteTables || {}), JSON.stringify(a.siteSettings || {}),
                              a.patientKey || "")
                   .toJs({ dict_converter: Object.fromEntries }),
  // B141 W05：儀表板 Worker 只載入後台計算之群體統計（無任何病人事件）。
  setupDashboard: (a) => bridge.setup_dashboard(a.dataDir, a.aggregates, a.principalId, a.displayName,
                              a.role, a.pepper, a.secretKey, JSON.stringify(a.adoptions || []),
                              JSON.stringify(a.siteTables || {}), JSON.stringify(a.siteSettings || {}))
                   .toJs({ dict_converter: Object.fromEntries }),
  pseudonym: (a) => bridge.pseudonym(a.mrn, a.pepper),
  request: (a) => {
    const out = JSON.parse(bridge.request(a.method, a.path, JSON.stringify(a.headers || {}),
                                          a.body ? new Uint8Array(a.body) : undefined, a.base || "/"));
    out.body = b64ToBytes(out.body_b64); delete out.body_b64;
    return out;
  },
  snapshot: () => { const p = bridge.snapshot(); const u = p.toJs(); p.destroy(); return u; },
  // B141（B-30）：只交後台尚未收到之事件；本病人之指標貢獻；居家代碼雜湊列；併入居家回報。
  kpiRowsSince: (a) => bridge.kpi_rows_since(a.after || 0),
  teachRowsSince: (a) => bridge.teaching_rows_since(a.after || 0),
  contrib: () => bridge.contributions(),
  // B149（C-07）：以假名鍵開檔後導向最近之就診（不經病歷號）。
  latestEncounter: () => bridge.latest_encounter(),
  homeCodes: () => bridge.home_codes_export(),
  importHomeReports: (a) => bridge.import_home_reports(a.json || "[]"),
};

self.onmessage = async (ev) => {
  const { id, cmd, args } = ev.data;
  try {
    const result = await handlers[cmd](args || {});
    const transfer = (result && result.body && result.body.buffer) ? [result.body.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
