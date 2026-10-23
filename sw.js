/* HF-Care 瀏覽器版 Service Worker（B127 T-A）
 * 把畫面框（iframe）內 HF-Care 網頁之所有請求，轉給外殼頁 → 病人 Worker → 引擎。
 * 外殼自身之靜態檔（/hfweb/、/index.html、/sw.js、/404.html）照常由 GitHub Pages 供應。 */
"use strict";
// 網站可位於根目錄（帳號.github.io）或子路徑（帳號.github.io/hfcare/）；以註冊範圍為準。
const SCOPE = new URL(self.registration.scope).pathname;          // 例 "/" 或 "/hfcare/"
const STATIC = ["hfweb/", "sw.js", "index.html", "404.html", "favicon.ico"];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function isStatic(path) {
  const rel = path.slice(SCOPE.length);
  return STATIC.some((p) => (p.endsWith("/") ? rel.startsWith(p) : rel === p));
}

async function shellClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // 外殼頁為頂層視窗、路徑 / 或 /index.html；框內頁面不是外殼。
  return all.find((c) => c.frameType === "top-level" &&
                         [SCOPE, SCOPE + "index.html"].includes(new URL(c.url).pathname));
}

async function forward(request) {
  const shell = await shellClient();
  if (!shell) {
    return new Response("<meta charset=utf-8><p>HF-Care 外殼頁未開啟，請重新整理。</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((v, k) => { if (k === "content-type" || k === "accept") headers[k] = v; });
  const body = ["GET", "HEAD"].includes(request.method) ? null : await request.arrayBuffer();
  const ch = new MessageChannel();
  const reply = new Promise((resolve) => { ch.port1.onmessage = (ev) => resolve(ev.data); });
  const appPath = "/" + url.pathname.slice(SCOPE.length);          // 應用內路徑
  shell.postMessage({ type: "hf-request", method: request.method,
                      path: appPath + url.search, headers, body }, [ch.port2].concat(body ? [body] : []));
  const r = await reply;
  const h = new Headers();
  for (const [k, v] of r.headers || []) { try { h.append(k, v); } catch (e) { /* 禁用標頭略過 */ } }
  const nullBody = [101, 204, 205, 304].includes(r.status) || (r.status >= 300 && r.status < 400);
  return new Response(nullBody ? null : r.body, { status: r.status, headers: h });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;              // 外部（Apps Script）照常
  if (!url.pathname.startsWith(SCOPE)) return;                   // 範圍外（同網域之其他網站）照常
  if (isStatic(url.pathname)) return;                            // 外殼靜態檔照常
  if (req.mode === "navigate" && req.destination === "document") return;  // 頂層＝外殼
  event.respondWith(forward(req));
});
