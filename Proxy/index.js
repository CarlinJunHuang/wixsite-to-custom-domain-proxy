// Azure Functions - HTTP reverse proxy for Wix site (CommonJS)
// Focus: P2 remove Wix banner completely, P3 smooth in-page anchor scroll
// Node.js 20 (Azure Functions v4)

const {
  ORIGIN,
  SITE_PATH,
  PUBLIC_HOST,
  PUBLIC_BASE = "",
  PUBLIC_ORIGIN = PUBLIC_HOST,
  FAVICON_URL,
  OG_IMAGE_URL = FAVICON_URL,
  LOGO_ALT_NAMES = [],
  SITE_TITLE,
  SITE_DESCRIPTION
} = require("../config");

const fs = require("fs");
const pathLib = require("path");

const TIMEOUT_MS = 30000;
const ALLOW_METHODS = "GET,HEAD,POST,OPTIONS,PUT,PATCH,DELETE";

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ORIGIN_HOST = new URL(ORIGIN).hostname;
const ALLOWED_HOSTS = [
  "static.wixstatic.com","static-origin.wixstatic.com",
  "video.wixstatic.com","video-orig.wixstatic.com",
  "static.parastorage.com","siteassets.parastorage.com","pages.parastorage.com",
  ORIGIN_HOST
];
const ALLOWED_HOSTS_RE = new RegExp("^https://(?:" + ALLOWED_HOSTS.map(esc).join("|") + ")/");
const hostPat = "(?:" + ALLOWED_HOSTS.map(h => h.replace(/\./g, "\\.")).join("|") + ")";
const PATH_PREFIX_RE = new RegExp("^" + esc(SITE_PATH) + "(\\/|$)");
const stripSitePrefix = s => (typeof s === "string") ? s.replace(PATH_PREFIX_RE, "/") : s;

const HOP = new Set([
  "connection","keep-alive","proxy-authenticate","proxy-authorization",
  "te","trailer","transfer-encoding","upgrade","expect","pragma"
]);

const STATIC_EXTS = new Set([
  ".js",".css",".png",".jpg",".jpeg",".webp",".gif",".svg",".ico",".woff",".woff2",".ttf"
]);

function fileExt(p){ const i=p.lastIndexOf("."); return i>=0?p.slice(i).toLowerCase():""; }
const looksHtml = p => !/\.(js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf)(\?|$)/i.test(p);

async function fetchRetry(url, init, tries=2){
  let lastErr;
  for (let i=0;i<tries;i++){
    const c = new AbortController();
    const t = setTimeout(()=>c.abort(), TIMEOUT_MS);
    try{
      const r = await fetch(url, {...init, signal:c.signal});
      clearTimeout(t);
      if (r.status === 429 || r.status >= 500){
        lastErr = new Error("Upstream "+r.status);
        await new Promise(res=>setTimeout(res, 400*(i+1)));
        continue;
      }
      return r;
    }catch(err){
      clearTimeout(t);
      lastErr = err;
      await new Promise(res=>setTimeout(res, 400*(i+1)));
    }
  }
  throw lastErr;
}

// Strip any "path-like" keys in objects that start with SITE_PATH by removing the prefix (supports deep/nested structures)
function stripPathMapKeysDeep(o, depth = 0) {
  if (!o || typeof o !== "object" || depth > 6) return;
  if (Array.isArray(o)) { o.forEach(v => stripPathMapKeysDeep(v, depth + 1)); return; }

  const keys = Object.keys(o);
  let needRemap = false;
  for (const k of keys) {
    if (typeof k === "string" && PATH_PREFIX_RE.test(k)) { needRemap = true; break; }
  }
  if (needRemap) {
    const remap = {};
    for (const k of keys) {
      const nk = typeof k === "string" ? k.replace(PATH_PREFIX_RE, "/") : k;
      remap[nk] = o[k];
    }
    // Replace in place
    for (const k of keys) delete o[k];
    Object.assign(o, remap);
  }
  // Continue recursion / descend further
  for (const k of Object.keys(o)) stripPathMapKeysDeep(o[k], depth + 1);
}


function safeJsonForHtml(s){
  return String(s)
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/<!--/g, "<\\!--")
    .replace(/<\/?noscript>/gi, "");
}


process.on("unhandledRejection", e => console.error("UNHANDLED", e));
process.on("uncaughtException",  e => console.error("UNCAUGHT",  e));

module.exports = async function (context, req) {
  try{
    const rawPath = (req.params && req.params.path) ? ("/"+req.params.path) : "/";
    const path = rawPath;
    const qs = new URLSearchParams(req.query || {}).toString();
    const method = (req.method || "GET").toUpperCase();

    // 0) CORS preflight
    if (method === "OPTIONS"){
      context.res = {
        status: 204,
        headers: {
          "access-control-allow-origin": PUBLIC_HOST,
          "access-control-allow-methods": ALLOW_METHODS,
          "access-control-allow-headers": req.headers?.["access-control-request-headers"] || "*",
          "access-control-max-age": "600"
        }
      };
      return;
    }

    // 1) wixapi relay: /__x/wixapi?u=https://<*.wix.com>/_api/...
    if (path.startsWith("/__x/wixapi")){
      const targetUrl = req.query?.u || "";
      let ok = false;
      try{
        const u = new URL(targetUrl);
        ok = (
          u.hostname.endsWith(".wix.com") || u.hostname === "wix.com" ||
          u.hostname.endsWith(".wixsite.com")
        ) && u.pathname.startsWith("/_api/");
      }catch(_){ ok = false; }
      if (!ok){ context.res = { status:400, body:"bad target" }; return; }

      const init = { method, headers:{}, redirect:"manual" };
      if (method!=="GET" && method!=="HEAD"){
        init.body = req.rawBody ?? (typeof req.body==="string" ? req.body : JSON.stringify(req.body));
      }
      ["content-type","accept","accept-language"].forEach(h=>{
        const v = req.headers?.[h]; if (v) init.headers[h]=v;
      });

      const r = await fetchRetry(targetUrl, init);
      const h = {};
      r.headers.forEach((v,k)=>{ if(!HOP.has(k.toLowerCase())) h[k]=v; });
      h["access-control-allow-origin"] = PUBLIC_HOST;
      if (r.status>=300 && r.status<400) h.location = r.headers.get("location") || "/";

      const ct = (r.headers.get("content-type") || "").toLowerCase();
      let bodyBuf;

      if (/json/.test(ct)) {
        const text = await r.text();
        try {
          const strip = stripSitePrefix;
          const ROUTE_KEYS = new Set([
            "url","href","baseUrl","basePath","publicBaseUrl","routerPublicBaseUrl",
            "appRouterPrefix","prefix","pageUriSEO","canonicalUrl"
          ]);
          const deepStrip = (o, depth=0) => {
            if (!o || typeof o !== "object" || depth>6) return;
            if (Array.isArray(o)) { o.forEach(v => deepStrip(v, depth+1)); return; }
            for (const k of Object.keys(o)) {
              const v = o[k];
              if (ROUTE_KEYS.has(k) && typeof v === "string") o[k] = strip(v);
              else if (v && typeof v === "object") deepStrip(v, depth+1);
            }
          };
          let j = JSON.parse(text);
          deepStrip(j);
          stripPathMapKeysDeep(j);
          h["content-type"] = "application/json; charset=utf-8";
          bodyBuf = Buffer.from(JSON.stringify(j), "utf8");
        } catch {
          bodyBuf = Buffer.from(text, "utf8");
        }
      } else {
        const ab = await r.arrayBuffer();
        bodyBuf = Buffer.from(ab);
      }

      context.res = { status:r.status, headers:h, body:bodyBuf, isRaw:true };
      return;

    }

    // 1.1) assets relay: /__x/asset?u=<absolute-url>
    if (path.startsWith("/__x/asset")){
      const u = (req.query && req.query.u) || "";
      const allow = ALLOWED_HOSTS_RE;
      if (!allow.test(u)){ context.res = { status:400, body:"bad asset url" }; return; }

      // If accidentally routed to asset but is actually wixsite.com/_api -> respond 307 redirect to /__x/wixapi
      try {
        const X = new URL(u);
        if (X.hostname.endsWith('.wixsite.com') && X.pathname.startsWith('/_api/')) {
          context.res = { status: 307, headers: { location: '/__x/wixapi?u=' + encodeURIComponent(u) } };
          return;
        }
      } catch (_){}

      const drop = new Set([
        "content-length","content-encoding","transfer-encoding",
        "x-frame-options","content-security-policy","content-security-policy-report-only",
        "cross-origin-embedder-policy","cross-origin-opener-policy","permissions-policy","report-to","nel"
      ]);

      const r = await fetchRetry(u, { redirect:"manual", headers:{ "Accept":"*/*" }});
      const h = {};
      r.headers.forEach((v,k)=>{ if(!drop.has(k.toLowerCase())) h[k]=v; });
      h["access-control-allow-origin"] = PUBLIC_HOST;

      if (!h["cache-control"]){
        h["cache-control"] = /wixstatic|parastorage/.test(u)
          ? "public, max-age=120"
          : "public, max-age=86400";
      }

      const ct = (h["content-type"] || "").toLowerCase();
      let bodyBuf;

      if (ct.includes("text/css") || /\.css(\?|$)/i.test(u)){
        let css = await r.text();
        css = css.replace(
          /url\((['"]?)(https:\/\/[^)'" ]+)\1\)/g,
          (m,q,abs)=>{
            return /^(https:\/\/static(?:-origin)?\.wixstatic\.com|https:\/\/video(?:-orig)?\.wixstatic\.com|https:\/\/static\.parastorage\.com|https:\/\/siteassets\.parastorage\.com|https:\/\/pages\.parastorage\.com)/.test(abs)
              ? `url(${q}/__x/asset?u=${encodeURIComponent(abs)}${q})`
              : m;
          }
        );
        h["content-type"] = "text/css; charset=utf-8";
        bodyBuf = Buffer.from(css, "utf8");
      }else{
        const isThunderboltPages = /\/pages\/pages\/thunderbolt/i.test(u);

        // Prefer handling Thunderbolt pages JSON first
        if (ct.includes("application/json") || isThunderboltPages) {
          let text = await r.text();
          try {
            let j = JSON.parse(text);

            const strip = stripSitePrefix;

            // 1) Remove the SITE_PATH prefix from pagesMap keys
            if (j.pagesMap && typeof j.pagesMap === "object") {
              const out = {};
              for (const [k, v] of Object.entries(j.pagesMap)) out[strip(k)] = v;
              j.pagesMap = out;
            }

            // 2) Normalize routers / baseUrl / pages[].url
            if (Array.isArray(j.routers)) {
              j.routers.forEach(rt => {
                if (rt.prefix)  rt.prefix  = strip(rt.prefix);
                if (rt.baseUrl) rt.baseUrl = strip(rt.baseUrl);
                if (rt.basePath)rt.basePath= strip(rt.basePath);
                if (Array.isArray(rt.pages)) {
                  rt.pages.forEach(p => {
                    if (p && typeof p.url === "string") p.url = strip(p.url);
                  });
                }
              });
            }
            if (j.baseUrl) j.baseUrl = strip(j.baseUrl);

            const ROUTE_KEYS = new Set([
              'url','baseUrl','basePath','publicBaseUrl','routerPublicBaseUrl','appRouterPrefix','prefix'
            ]);
            function deepStrip(o, depth=0){
              if (!o || typeof o !== 'object' || depth > 6) return;
              if (Array.isArray(o)) { o.forEach(v => deepStrip(v, depth+1)); return; }
              for (const k of Object.keys(o)) {
                const v = o[k];
                if (ROUTE_KEYS.has(k) && typeof v === 'string') o[k] = strip(v);
                else deepStrip(v, depth+1);
              }
            }
            deepStrip(j);

            stripPathMapKeysDeep(j);

            h["content-type"] = "application/json; charset=utf-8";
            const bodyBuf = Buffer.from(JSON.stringify(j), "utf8");
            context.res = { status: r.status, headers: h, body: bodyBuf, isRaw: true };
            return;
          } catch {
            // If parsing fails, fall back to default passthrough
            const bodyBuf = Buffer.from(text, "utf8");
            context.res = { status: r.status, headers: h, body: bodyBuf, isRaw: true };
            return;
          }
        }

        else if (ct.includes("text/css") || /\.css(\?|$)/i.test(u)) {
          let css = await r.text();
          css = css.replace(/url\((['"]?)(https:\/\/[^)'" ]+)\1\)/g, (m,q,abs) => {
            return /^(https:\/\/static(?:-origin)?\.wixstatic\.com|https:\/\/video(?:-orig)?\.wixstatic\.com|https:\/\/static\.parastorage\.com|https:\/\/siteassets\.parastorage\.com|https:\/\/pages\.parastorage\.com)/.test(abs)
              ? `url(${q}/__x/asset?u=${encodeURIComponent(abs)}${q})`
              : m;
          });
          h["content-type"] = "text/css; charset=utf-8";
          bodyBuf = Buffer.from(css, "utf8");
        }
        else {
          const ab = await r.arrayBuffer();
          bodyBuf = Buffer.from(ab);
        }

      }

      context.res = { status:r.status, headers:h, body:bodyBuf, isRaw:true };
      return;
    }

    // 1.2) worker relay: /__x/worker?u=<absolute-url>
    if (path.startsWith("/__x/worker")){
      const u = (req.query && req.query.u) || "";
      const allow = ALLOWED_HOSTS_RE;
      if (!allow.test(u)){ context.res = { status:400, body:"bad worker url" }; return; }

      if (/\/_api\//i.test(u)) {
        context.res = { status: 400, body: "api must go through /__x/wixapi" };
        return;
      }

      let upstreamUrl = u;
      try {
        const U = new URL(u);
        // If externalBaseUrl, normalize to PUBLIC_ORIGIN
        if (U.searchParams.has('externalBaseUrl')) {
          U.searchParams.set('externalBaseUrl', PUBLIC_ORIGIN);
          upstreamUrl = U.toString();
        }
      } catch (_) {}

      const r = await fetchRetry(upstreamUrl, { redirect:"manual", headers:{ "Accept":"*/*" }});
      let js = await r.text();

      // —— Worker-scope prelude, no regex —— //
      const prelude = `
;(()=>{
  var ALLOWED_HOSTS = ${JSON.stringify(ALLOWED_HOSTS)};
  var WIX  = "${ORIGIN}";
  var SITE = "${SITE_PATH}";

  function normalizeTB(u){
    try{
      var x = new URL(String(u), self.location.origin);
      if (x.searchParams.has('externalBaseUrl')) {
        x.searchParams.set('externalBaseUrl', self.location.origin);
      }
      return x.toString();
    }catch(_){ return u; }
  }
  function mapU(u){
    try{
      var x = new URL(String(u), self.location.origin);
      var host = x.hostname, path = x.pathname || "";

      var isWix = (host === 'wix.com' || host.endsWith('.wix.com'));
      var isWixSite = (host === '${ORIGIN_HOST}');
      if ((isWix || isWixSite) && path.startsWith('/_api/'))
        return '/__x/wixapi?u=' + encodeURIComponent(x.href);

      var ALLOWED = ${JSON.stringify(ALLOWED_HOSTS)};
      if (ALLOWED.indexOf(host) >= 0) return '/__x/asset?u=' + encodeURIComponent(x.href);

      return u;
    }catch(_){ return u; }
  }


  var _is = self.importScripts;
  if (typeof _is === 'function'){
    self.importScripts = function(){ return _is.apply(self, Array.from(arguments).map(mapU)); };
  }
  var _f = self.fetch;
  if (typeof _f === 'function'){
    self.fetch = function(input, init){
      try{
        if (typeof input === 'string') input = mapU(input);
        else if (input && input.url)  input = mapU(input.url);
      }catch(_){}
      return _f(input, init);
    };
  }
})();\n`;
      js = prelude + js;

      context.res = {
        status: 200,
        headers: {
          "content-type": "application/javascript; charset=UTF-8",
          "cache-control": "public, max-age=31536000, immutable"
        },
        body: js
      };
      return;
    }

    // 2) robots / sitemap
    if (path === "/robots.txt"){
      context.res = {
        status: 200,
        headers: { "content-type":"text/plain" },
        body: `User-agent: *\nAllow: /\nSitemap: ${PUBLIC_HOST}/sitemap.xml\n`
      };
      return;
    }
    if (path === "/sitemap.xml"){
      try{
        const r = await fetch(`${ORIGIN}${SITE_PATH}/sitemap.xml`);
        let xml = await r.text();
        xml = xml
          .replace(new RegExp(esc(ORIGIN)+esc(SITE_PATH), "g"), PUBLIC_ORIGIN)
          .replace(new RegExp(esc(ORIGIN), "g"), PUBLIC_HOST);
        context.res = { status:200, headers:{ "content-type":"application/xml" }, body:xml };
      }catch{
        context.res = { status:404, body:"No sitemap" };
      }
      return;
    }

    // 2.1) local assets & favicon
    {
      const routePath = path;
      const assetsDir = pathLib.join(__dirname, "assets");
      const guessType = (p)=>{
        const ext = (p.split(".").pop()||"").toLowerCase();
        return ({
          "png":"image/png","jpg":"image/jpeg","jpeg":"image/jpeg","webp":"image/webp","gif":"image/gif","svg":"image/svg+xml",
          "ico":"image/x-icon","js":"application/javascript","css":"text/css"
        })[ext] || "application/octet-stream";
      };

      if (routePath.startsWith("/assets/")){
        const safe = pathLib.normalize(pathLib.join(assetsDir, routePath.replace("/assets/","")));
        if (!safe.startsWith(assetsDir)){ context.res = { status:403, body:"forbidden" }; return; }
        if (fs.existsSync(safe)){
          const buf = fs.readFileSync(safe);
          context.res = {
            status: 200,
            headers: { "content-type": guessType(safe), "cache-control":"public, max-age=31536000, immutable" },
            body: buf, isRaw:true
          };
          return;
        }else{
          const alt = LOGO_ALT_NAMES[1] ? pathLib.join(assetsDir, LOGO_ALT_NAMES[1]) : null;
          if (alt && fs.existsSync(alt)){
            const buf = fs.readFileSync(alt);
            context.res = {
              status: 200,
              headers: { "content-type": guessType(alt), "cache-control":"public, max-age=31536000, immutable" },
              body: buf, isRaw:true
            };
            return;
          }
          context.res = { status:404, body:"asset not found" };
          return;
        }
      }

      if (routePath === "/favicon.ico"){
        const cand = LOGO_ALT_NAMES.map(n=>pathLib.join(assetsDir, n));
        for (const f of cand){
          if (fs.existsSync(f)){
            const buf = fs.readFileSync(f);
            context.res = {
              status: 200,
              headers: { "content-type": guessType(f), "cache-control":"public, max-age=86400" },
              body: buf, isRaw:true
            };
            return;
          }
        }
        context.res = { status:302, headers:{ location:"https://www.wix.com/favicon.ico" } };
        return;
      }
    }

    // 3) main upstream
    const target = ORIGIN + SITE_PATH + path + (qs ? `?${qs}` : "");
    const init = {
      method,
      redirect: "manual",
      headers: {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
        "Accept": req.headers["accept"] || "*/*",
        "Accept-Language": req.headers["accept-language"] || "en",
        "Referer": PUBLIC_HOST
      }
    };
    if (looksHtml(path)) init.headers["Accept-Encoding"] = "identity";
    if (method!=="GET" && method!=="HEAD"){
      init.body = req.rawBody ?? (typeof req.body==="string" ? req.body : JSON.stringify(req.body));
    }

    // Allow most of header；Filter hop-by-hop / dangerous headers
    const DROP = new Set([
      "host","connection","keep-alive","proxy-authenticate","proxy-authorization",
      "te","trailer","transfer-encoding","upgrade","expect",
      "pragma","content-length","accept-encoding"
    ]);

    for (const [k,v0] of Object.entries(req.headers || {})) {
      const kL = k.toLowerCase();
      if (DROP.has(kL)) continue;

      // Allow：common headers + all x-* + authorization
      const allow =
        kL === "content-type" ||
        kL === "accept" || kL === "accept-language" ||
        kL === "origin" || kL === "referer" || kL === "user-agent" ||
        kL === "authorization" ||
        kL.startsWith("x-");

      if (!allow) continue;

      const v = Array.isArray(v0) ? v0.join(",") : v0;
      if (typeof v === "string" && v.length) init.headers[kL] = v;
    }

    // Ensure origin/referer headers are set
    if (!init.headers["origin"])  init.headers["origin"]  = PUBLIC_HOST;
    if (!init.headers["referer"]) init.headers["referer"] = PUBLIC_HOST + "/";

    const upstream = await fetchRetry(target, init);

    // 4) redirects
    if (upstream.status>=300 && upstream.status<400){
      const loc = upstream.headers.get("location") || "/";
      const mapped = loc
        .replace(new RegExp(`^${esc(ORIGIN)}${esc(SITE_PATH)}`, "i"), PUBLIC_ORIGIN)
        .replace(new RegExp(`^${esc(ORIGIN)}`, "i"), PUBLIC_HOST);
      context.res = { status: upstream.status, headers: { location:mapped } };
      return;
    }

    // 5) copy headers (strip CSP/XFO etc.)
    const resHdr = {};
    upstream.headers.forEach((v,k)=>{
      const kk = k.toLowerCase();
      if (!HOP.has(kk) && ![
        "content-security-policy","content-security-policy-report-only",
        "x-frame-options","permissions-policy",
        "cross-origin-embedder-policy","cross-origin-opener-policy",
        "report-to","nel"
      ].includes(kk)){
        resHdr[kk] = v;
      }
    });
    if (upstream.status === 304){ context.res = { status:304, headers:resHdr }; return; }

    const ctype = upstream.headers.get("content-type") || "";

    // 6) HTML branch
    if ((/text\/html/i).test(ctype)){
      delete resHdr["content-encoding"];
      delete resHdr["content-length"];
      delete resHdr["transfer-encoding"];

      let html = await upstream.text();

      html = html
        .replace(new RegExp(esc(ORIGIN)+esc(SITE_PATH), "g"), PUBLIC_ORIGIN)
        .replace(new RegExp(esc(ORIGIN), "g"), PUBLIC_HOST);
    
      const reAttrs = new RegExp("(\\b(?:src|href))=([\"'])(https?:\\/\\/" + hostPat + "[^\"']+)\\2", "gi");

      function shouldBypassToOrigin(attr, url) {
        try {
          const u = new URL(url);
          const p = u.pathname || "";

          // 1) Do not rewrite HTML pages (keep them cross-origin)
          if (/\.(?:html?)$/i.test(p)) return true;

          // 2) TPA viewer：/services/<app>/viewerWidget.html 或 viewerApp.html
          if (/\/services\/[^/]+\/.*viewer(?:Widget|App)\.html$/i.test(p)) return true;

          // 3) iframe
          if (attr.toLowerCase() === "src" && /\/iframe|\/embed/i.test(p)) return true;

          return false;
        } catch {
          return false;
        }
      }

      html = html.replace(reAttrs, (m, attr, q, abs) => {
        if (shouldBypassToOrigin(attr, abs)) return m;

        return `${attr}="/__x/asset?u=${encodeURIComponent(abs)}"`;
      });

      // Other static resources (js/css/img/font/video…) continue to be proxied same-origin
      html = html.replace(/("clientWorkerUrl"\s*:\s*")(https?:\/\/[^"]+)(")/g,
        (m, p, url, s) => p + "/__x/worker?u=" + encodeURIComponent(url) + s);
      
      // Remove old meta tags (e.g. "Unrecognized feature: 'vr'")
      html = html.replace(/<meta[^>]+http-equiv=["']?(?:permissions-policy|feature-policy)["']?[^>]*>/ig, "");

      // —— Safely rewrite viewer-model (supports serialized) —— //
      function safeJsonForHtml(s){
        return s.replace(/</g,"\\u003C").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
      }
      function stripPathMapKeysDeep(root) {
        const strip = stripSitePrefix;
        const walk = (o, depth=0) => {
          if (!o || typeof o !== "object" || depth > 6) return;
          if (Array.isArray(o)) { o.forEach(v => walk(v, depth+1)); return; }
          // When it includes pagesMap keys, strip the SITE_PATH prefix
          if (o.pagesMap && typeof o.pagesMap === "object") {
            const out = {};
            for (const [k, v] of Object.entries(o.pagesMap)) out[strip(k)] = v;
            o.pagesMap = out;
          }
          for (const k of Object.keys(o)) {
            const v = o[k];
            if (v && typeof v === "object") walk(v, depth+1);
          }
        };
        walk(root);
      }

      function rewriteViewerModelTag(tagId){
        const re = new RegExp(`<script[^>]*\\bid=["']${tagId}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i");
        html = html.replace(re, (m, json)=>{
          try{
            const obj = JSON.parse(json);

            const replAbs = (u)=> typeof u==="string"
              ? u.replace(new RegExp("^"+esc(ORIGIN)+esc(SITE_PATH)), PUBLIC_ORIGIN)
                  .replace(new RegExp("^"+esc(ORIGIN)), PUBLIC_HOST)
              : u;
            const dropSite = (p)=> typeof p==="string"
              ? p.replace(new RegExp("^"+esc(SITE_PATH)), "")
              : p;

            if (obj.requestUrl) obj.requestUrl = PUBLIC_ORIGIN + "/";
            if (obj.site && obj.site.externalBaseUrl) obj.site.externalBaseUrl = PUBLIC_ORIGIN;

            // —— Unified deep traversal: strip SITE_PATH prefix + change domain for absolute links (non-API) + explicitly convert API basePath to /__x/wixapi —— //
            const ROUTE_STR_KEYS = new Set([
              "url","href","baseUrl","basePath","publicBaseUrl",
              "routerPublicBaseUrl","appRouterPrefix","prefix","pageUriSEO","canonicalUrl"
            ]);

            // Reuse helper for stripping SITE_PATH

            // Non-API absolute links: ORIGIN(+SITE_PATH) => PUBLIC_ORIGIN; ORIGIN => PUBLIC_HOST
            const replNonApiAbs = s => {
              if (typeof s !== "string") return s;
              if (s.includes("/_api/")) return s;
              return s
                .replace(new RegExp("^"+esc(ORIGIN)+esc(SITE_PATH)), PUBLIC_ORIGIN)
                .replace(new RegExp("^"+esc(ORIGIN)), PUBLIC_HOST);
            };

            // ★ API basePath (and other absolute URLs pointing to *_api_*): explicitly change to same-origin relay /__x/wixapi?u=...
            const mapApiAbsToRelay = s => {
              if (typeof s !== "string") return s;
              if (!/_api\//.test(s)) return s;
              try {
                const u = new URL(s);
                if (
                  (u.hostname.endsWith(".wix.com") || u.hostname === "wix.com" || u.hostname.endsWith(".wixsite.com"))
                  && u.pathname.startsWith("/_api/")
                ) {
                  return "/__x/wixapi?u=" + encodeURIComponent(s);
                }
              } catch {}
              return s;
            };

            (function deepNormalize(o, depth=0){
              if (!o || typeof o !== "object" || depth>6) return;
              if (Array.isArray(o)) { o.forEach(v => deepNormalize(v, depth+1)); return; }
              for (const k of Object.keys(o)) {
                const v = o[k];
                if (ROUTE_STR_KEYS.has(k) && typeof v === "string") {
                  let nv = v;
                  if (nv.startsWith(SITE_PATH)) nv = stripSitePrefix(nv);
                  // First convert absolute _api links explicitly to the same-origin relay
                  if (/_api\//.test(nv)) nv = mapApiAbsToRelay(nv);
                  // For non-API absolute links, change the root to perform cross-origin replacement
                  nv = replNonApiAbs(nv);
                  o[k] = nv;
                } else if (typeof v === "string") {
                  // Other strings: first convert API absolute links to the same-origin relay, then change roots for non-API links
                  let nv = v;
                  if (/_api\//.test(nv)) nv = mapApiAbsToRelay(nv);
                  nv = replNonApiAbs(nv);
                  o[k] = nv;
                } else {
                  deepNormalize(v, depth+1);
                }
              }
            })(obj);

            // Also strip prefixes from pagesMap keys
            stripPathMapKeysDeep(obj);

            // —— Map Thunderbolt (TB) Worker to same-origin —— //
            if (obj.clientTopology?.clientWorkerUrl) {
              obj.clientTopology.clientWorkerUrl =
                "/__x/worker?u=" + encodeURIComponent(obj.clientTopology.clientWorkerUrl);
            }

            // ★ Fallback: recursively search the entire object for any property named clientWorkerUrl
            (function deepFixWorker(o, depth=0){
              if (!o || typeof o !== 'object' || depth > 5) return;
              for (const k of Object.keys(o)) {
                const v = o[k];
                if (k === 'clientWorkerUrl' && typeof v === 'string' && /^https?:\/\//.test(v)) {
                  o[k] = "/__x/worker?u=" + encodeURIComponent(v);
                } else if (v && typeof v === 'object') {
                  deepFixWorker(v, depth+1);
                }
              }
            })(obj);


            if (obj.siteFeaturesConfigs?.cookiesManager?.cookieSitePath){
              obj.siteFeaturesConfigs.cookiesManager.cookieSitePath = "/";
            }

            // —— Explicitly convert all *_api_* basePath entries in the viewer-model to the same-origin relay —— //
            const vmIsApiUrl = (s) => {
              if (typeof s !== "string" || !/_api\//.test(s)) return false;
              try {
                const u = new URL(s, PUBLIC_HOST); // 允许相对路径判断
                return u.pathname.startsWith("/_api/");
              } catch { return false; }
            };

            const vmMapApiBase = (s) => {
              if (typeof s !== "string" || !/_api\//.test(s)) return s;
              try {
                const u = new URL(s, PUBLIC_HOST);

                // 1) if '/__x/wixapi?u=' return it as is
                if (/^\/__x\/wixapi\?u=/.test(s)) return s;

                // 2) same origin '/_api/...' or `${PUBLIC_HOST}/_api/...`
                if (u.origin === PUBLIC_HOST && u.pathname.startsWith("/_api/")) {
                  const tail = u.pathname.slice("/_api/".length) + (u.search || "");
                  const upstream = ORIGIN + SITE_PATH + "/_api/" + tail;
                  return "/__x/wixapi?u=" + encodeURIComponent(upstream);
                }

                // 3) wixsite.com/_api/...
                //    wix.com/_api/... 或 wixsite.com/_api/...
                if ((u.hostname.endsWith(".wixsite.com") || u.hostname.endsWith(".wix.com") || u.hostname === "wix.com")
                    && u.pathname.startsWith("/_api/")) {
                  return "/__x/wixapi?u=" + encodeURIComponent(u.href);
                }

                return s;
              } catch { return s; }
            };

            (function fixVmApiBasePaths(o, depth=0) {
              if (!o || typeof o !== "object" || depth > 7) return;
              if (Array.isArray(o)) { o.forEach(v => fixVmApiBasePaths(v, depth+1)); return; }

              // Common shape: { urlData: { basePath: "..." } }
              if (o.urlData && typeof o.urlData === "object" && typeof o.urlData.basePath === "string") {
                o.urlData.basePath = vmMapApiBase(o.urlData.basePath);
              }
              // standalone basePath occurrences
              if (typeof o.basePath === "string") {
                o.basePath = vmMapApiBase(o.basePath);
              }

              for (const k of Object.keys(o)) {
                const v = o[k];
                if (v && typeof v === "object") fixVmApiBasePaths(v, depth+1);
              }
            })(obj);

            const sfc = obj.siteFeaturesConfigs || {};
            if (sfc.elementorySupportWixCodeSdk){
              const es = sfc.elementorySupportWixCodeSdk;
              if (es.baseUrl)      es.baseUrl      = replAbs(es.baseUrl);
              if (es.relativePath) es.relativePath = dropSite(es.relativePath);
            }
            if (sfc.dataWixCodeSdk?.cloudDataUrlWithExternalBase){
              sfc.dataWixCodeSdk.cloudDataUrlWithExternalBase = replAbs(sfc.dataWixCodeSdk.cloudDataUrlWithExternalBase);
            }
            if (sfc.multilingual){
              const fix = (u)=>replAbs(u);
              if (sfc.multilingual.originalLanguage?.url) sfc.multilingual.originalLanguage.url = fix(sfc.multilingual.originalLanguage.url);
              if (sfc.multilingual.currentLanguage?.url)  sfc.multilingual.currentLanguage.url  = fix(sfc.multilingual.currentLanguage.url);
              if (Array.isArray(sfc.multilingual.siteLanguages)){
                sfc.multilingual.siteLanguages.forEach(l=>{ if (l.url) l.url = fix(l.url); });
              }
            }

            if (obj.dynamicModelUrl){
              try{
                const u = new URL(obj.dynamicModelUrl);
                if (u.searchParams.has("originUrl")){
                  u.searchParams.set("originUrl", PUBLIC_ORIGIN + "/");
                  obj.dynamicModelUrl = u.toString();
                }
              }catch{}
            }

            stripPathMapKeysDeep(obj);

            // —— Before final serialization: do one safe-pass sanitization for JSON literals —— //
            let raw = JSON.stringify(obj);

            // 1) Strip string values that start with SITE_PATH (only affect JSON string literals enclosed in quotes)
            const jsonStripRe = new RegExp('"' + esc(SITE_PATH) + '(\/[^\"]*)"', 'g');
            raw = raw.replace(jsonStripRe, (_, rest) => "\"/" + rest.replace(/^\//, "") + "\"");

            // 2) For non-API absolute upstream links, replace their root to be cross-origin (ORIGIN(+SITE_PATH)→PUBLIC_ORIGIN; ORIGIN→PUBLIC_HOST)
            raw = raw
              .replace(new RegExp("\"" + esc(ORIGIN + SITE_PATH), "g"), "\"" + PUBLIC_ORIGIN)
              .replace(new RegExp("\"" + esc(ORIGIN), "g"), "\"" + PUBLIC_HOST);

            // ★ Note: API absolute links were explicitly converted to "/__x/wixapi?u=..." in fixVmApiBasePaths step 1), so do not modify API links here.

            const safe = safeJsonForHtml(raw);
            return `<script id="${tagId}" type="application/json">${safe}</script>`;

          }catch(_){
            return m;
          }
        });
      }
      rewriteViewerModelTag("wix-viewer-model");
      rewriteViewerModelTag("wix-viewer-model-serialized");
      function rewriteWarmupDataTag(){
        const re = /<script[^>]*\bid=["']wix-warmup-data["'][^>]*>([\s\S]*?)<\/script>/i;
        html = html.replace(re, (m, json) => {
          try{
            const obj = JSON.parse(json);

            const KEYS = new Set([
              "routerPublicBaseUrl","baseUrl","basePath","publicBaseUrl",
              "appRouterPrefix","prefix",
              "url","href","pageUriSEO","canonicalUrl"
            ]);

            const strip = stripSitePrefix;

            const replNonApiAbs = s => {
              if (typeof s !== "string") return s;
              if (/_api\//.test(s)) {
                // make API links point to the same-origin relay
                try {
                  const u = new URL(s);
                  if (
                    (u.hostname.endsWith(".wix.com") || u.hostname === "wix.com" || u.hostname.endsWith(".wixsite.com"))
                    && u.pathname.startsWith("/_api/")
                  ) {
                    return "/__x/wixapi?u=" + encodeURIComponent(s);
                  }
                } catch {}
                return s; // if not a valid API link, return as is
              }
              return s
                .replace(new RegExp("^"+esc(ORIGIN)+esc(SITE_PATH)), PUBLIC_ORIGIN)
                .replace(new RegExp("^"+esc(ORIGIN)), PUBLIC_HOST);
            };

            const walk = (o, depth=0) => {
              if (!o || typeof o !== "object" || depth>5) return;
              if (Array.isArray(o)) { o.forEach(v => walk(v, depth+1)); return; }
              for (const k of Object.keys(o)) {
                const v = o[k];
                if (KEYS.has(k) && typeof v === "string") {
                  let nv = strip(v);
                  nv = replNonApiAbs(nv);
                  o[k] = nv;
                } else if (v && typeof v === "object") {
                  walk(v, depth+1);
                }
              }
            };
            walk(obj);

            // pagesMap keys: strip SITE_PATH prefix
            stripPathMapKeysDeep(obj);

            const safe = safeJsonForHtml(JSON.stringify(obj));
            return `<script id="wix-warmup-data" type="application/json">${safe}</script>`;
          }catch{ return m; }
        });
      }
      rewriteWarmupDataTag();


      // —— Early boot —— //
      const earlyBoot = `
<script id="wpx-worker-boot">
(function(){
  var WIX  = "${ORIGIN}";
  var SITE = "${SITE_PATH}";

  var ALLOWED_HOSTS = ${JSON.stringify(ALLOWED_HOSTS)};
  function needAsset(u){
    try{
      var x=new URL(String(u), location.href);
      if (x.pathname.startsWith('/_api/')) return false; // ★ API is not asset
      return ALLOWED_HOSTS.indexOf(x.hostname)>=0;
    } catch(_){ return false; }
  }
  function needApi(u){
    try{
      var x=new URL(String(u), location.href);
      // ★ wix.com & wixsite.com - /_api go to /__x/wixapi
      var isWix = (x.hostname==='wix.com' || x.hostname.endsWith('.wix.com'));
      var isWixSite = (x.hostname==='${ORIGIN_HOST}');
      return (isWix || isWixSite) && x.pathname.startsWith('/_api/');
    } catch(_){ return false; }
  }
  function mapAsset(u){ try{ return needAsset(u) ? "/__x/asset?u="+encodeURIComponent(String(u)) : u; }catch(_){ return u; } }
  function mapApi(u){   try{ return needApi(u)   ? "/__x/wixapi?u="+encodeURIComponent(String(u)) : u; }catch(_){ return u; } }

  // ★ Map API to the same-origin relay; if it's same-origin '/_api/...', reconstruct upstream ORIGIN+SITE_PATH then relay
  function mapApi(u){
    try{
      var x = new URL(String(u), location.href);

      // wix / wixsite domain: directly map to /__x/wixapi
      if ((x.hostname.endsWith('.wix.com') || x.hostname==='wix.com' || x.hostname.endsWith('.wixsite.com'))
          && x.pathname.startsWith('/_api/')) {
        return "/__x/wixapi?u="+encodeURIComponent(x.href);
      }

      // same origin '/_api/...'：go back to ORIGIN+SITE_PATH then relay
      if (x.origin === location.origin && x.pathname.startsWith('/_api/')) {
        var tail = x.pathname.slice('/_api/'.length) + (x.search || '');
        var upstream = WIX + SITE + '/_api/' + tail;
        return "/__x/wixapi?u="+encodeURIComponent(upstream);
      }
      return u;
    }catch(_){ return u; }
  }

  try{
    var OW = window.Worker;
    if (typeof OW === "function"){
      window.Worker = function(u, opts){ return new OW(mapAsset(u), opts); };
      window.Worker.prototype = OW.prototype;
      window.Worker.__wpx_patched = true;
    }
    var OSW = window.SharedWorker;
    if (typeof OSW === "function"){
      window.SharedWorker = function(u, opts){ return new OSW(mapAsset(u), opts); };
      window.SharedWorker.prototype = OSW.prototype;
    }
  }catch(_){}

  try{
    var OF = window.fetch;
    var SELF = location.origin + "/__x/";
    window.fetch = function(input, init){
      try{
        var href = typeof input === "string" ? input : (input && input.url);
        if (href && href.indexOf(SELF)!==0){
          if (needAsset(href))      input = "/__x/asset?u="+encodeURIComponent(href);
          else if (needApi(href))   input = mapApi(href);               // ★ use mapApi to map API
        }
      }catch(_){}
      return OF(input, init);
    };
  }catch(_){}

  // The XHR proxy added earlier should also use mapApi; if already present, you can keep it.
  try{
    var XO = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m,u){
      try{
        var href = String(u||'');
        if (needAsset(href))      u = "/__x/asset?u="+encodeURIComponent(href);
        else if (needApi(href))   u = mapApi(href);                     // ★ mapApi as well
      }catch(_){}
      this.__wpx_u = u;
      return XO.apply(this, [m,u]);
    };
  }catch(_){}
})();
</script>`;
      html = html.replace(/<head[^>]*>/i, (m)=> m + earlyBoot);

      // basic SEO meta
      const title = SITE_TITLE;
      const desc  = SITE_DESCRIPTION;
      html = html.replace(/<title>[\s\S]*?<\/title>/i, "");
      if (!/rel=['"]canonical['"]/i.test(html)){
        const cr = `${PUBLIC_HOST}${path}${qs?("?"+qs):""}`;
        html = html.replace(/<head[^>]*>/i, (m)=> `${m}\n<link rel="canonical" href="${cr}">`);
      }
      html = html.replace(/<head[^>]*>/i, (m)=> `${m}
<title>${title}</title>
<link rel="icon" href="${FAVICON_URL}" type="image/png">
<meta name="description" content="${desc}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:type" content="website">
<meta property="og:url" content="${PUBLIC_HOST}${path}${qs?("?"+qs):""}">
<meta name="twitter:card" content="summary_large_image">
`);

      // ---- client-side helpers: mapping + banner remove + smooth anchors
      const inject = `
<script>
(function () {
  var WIX  = "${ORIGIN}";
  var MY   = "${PUBLIC_HOST}";
  var MYO  = "${PUBLIC_ORIGIN}";
  var SITE = "${SITE_PATH}";

  // keep URL clean by default; set true if you want #hash visible
  var USE_HASH = false;

  var EXTRA_ANCHOR_OFFSET_PX = -75;

  // explicit mapping: data-anchor -> selector
  var ANCHOR_OVERRIDE = {
    "dataItem-m1w5r9sf": "#comp-lt8r7eci", // Features
    "dataItem-m1wgo71r": "#SITE_FOOTER"    // Try Now
  };
  var ANCHOR_OFFSET_PX = {}; // leave empty unless you want pixel mapping

  var SKEY = "__wpx_anchor__"; // sessionStorage key for cross-page handoff

  // ===== CSS overrides: kill banner/placeholder; pin header; kill scroll-padding-top =====
  (function ensureCss(){
    var css = ""
      + "html,body{margin:0 !important;padding-top:0 !important;}"
      + "html{scroll-padding-top:0 !important;}"
      + "#WIX_ADS,.MyEGHM,[data-testid='free-domain-banner'],#SITE_HEADER-placeholder,#SITE_BANNER-placeholder{"
      + " display:none !important;visibility:hidden !important;height:0 !important;min-height:0 !important;margin:0 !important;padding:0 !important;}"
      + "#SITE_CONTAINER,#SITE_ROOT{margin-top:0 !important;padding-top:0 !important;}"
      + "#SITE_HEADER,header.SITE_HEADER{position:fixed !important;top:0 !important;left:0 !important;right:0 !important;z-index:2147483000 !important;margin:0 !important;transform:none !important;}"
      + "*:where([id],[data-anchor],[data-anchor-id],[data-section-id],[data-id],[data-item-id]){"
      + "  scroll-margin-top: calc(var(--wpx-header-h,0px) + var(--wpx-extra,0px)) !important;}";
    var s = document.createElement('style');
    s.id = 'wpx-nuke-css';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  })();

  function nukeBanner() {
    ['#WIX_ADS','.MyEGHM','[data-testid="free-domain-banner"]','#SITE_HEADER-placeholder','#SITE_BANNER-placeholder', '#comp-js30vtis', '#pinnedBottomRight']
      .forEach(function (sel) { document.querySelectorAll(sel).forEach(function (el) { try { el.safehide(); } catch(_){} }); });
    [document.documentElement, document.body, document.querySelector('#SITE_CONTAINER'), document.querySelector('#SITE_ROOT')]
      .forEach(function (el) { if (!el) return;
        el.style.setProperty('padding-top','0','important');
        el.style.setProperty('margin-top','0','important'); });
    document.documentElement.style.setProperty('scroll-padding-top','0','important');

    var h = document.getElementById('SITE_HEADER') || document.querySelector('header.SITE_HEADER');
    if (h) { h.style.position='fixed'; h.style.top='0'; h.style.left='0'; h.style.right='0'; h.style.zIndex='2147483000'; h.style.margin='0'; h.style.transform='none'; }
    var hh = h ? Math.round(h.getBoundingClientRect().height || 0) : 0;
    document.documentElement.style.setProperty('--wpx-header-h', hh + 'px');
    document.documentElement.style.setProperty('--wpx-extra', EXTRA_ANCHOR_OFFSET_PX + 'px');
  }

  // ----- helpers -----
  function map(u){ try{ var x=new URL(u,location.href); if(x.href.indexOf(WIX)===0) return x.href.replace(WIX+SITE,MYO).replace(WIX,MY);}catch(e){} return u;}
  var _ps=history.pushState.bind(history); history.pushState=function(s,t,u){ if(u) u=map(u); return _ps(s,t,u); };
  var _rs=history.replaceState.bind(history); history.replaceState=function(s,t,u){ if(u) u=map(u); return _rs(s,t,u); };

  function cssEscape(id){ try{ return (window.CSS&&CSS.escape)?CSS.escape(id):id.replace(/[^a-zA-Z0-9_\-]/g,'\\$&'); }catch(_){ return id; } }
  function headerOffset(){ var h=document.getElementById('SITE_HEADER')||document.querySelector('header.SITE_HEADER'); return h?Math.round(h.getBoundingClientRect().height||0):0; }
  function smoothScrollToEl(el){ var off=headerOffset()+(EXTRA_ANCHOR_OFFSET_PX|0); var y=(window.pageYOffset||document.documentElement.scrollTop||0)+el.getBoundingClientRect().top-off; window.scrollTo({top:y<0?0:y,behavior:'smooth'}); }
  function isHeaderDesc(el){ return !!(el && (el.closest('#SITE_HEADER') || el.closest('header.SITE_HEADER'))); }
  function isHome(){ return location.pathname==="/" || location.pathname==="" ; }

  function wideFind(name){
    if (!name) return null;
    if (ANCHOR_OVERRIDE[name]) { var el0=document.querySelector(ANCHOR_OVERRIDE[name]); if (el0 && !isHeaderDesc(el0)) return el0; }
    var esc=cssEscape(name);
    var strong = [
      '#'+esc,'[id="'+name+'"]','[name="'+name+'"]','[data-anchor-id="'+name+'"]',
      '[data-section-id="'+name+'"]','[data-item-id="'+name+'"]','[data-unique-id="'+name+'"]',
      '[data-comp-id="'+name+'"]','[data-testid="'+name+'"]','[data-hook="'+name+'"]','[id*="'+name+'"]'
    ].join(',');
    var list=document.querySelectorAll(strong);
    for(var i=0;i<list.length;i++){ var el=list[i]; if (el.tagName==='A') continue; if (isHeaderDesc(el)) continue; return el; }
    var pools=document.querySelectorAll('#PAGES_CONTAINER,[data-testid*="mesh-container-content"],main,section,[role="main"],[data-mesh-id]');
    for(var p=0;p<pools.length;p++){ var el2=pools[p].querySelector(strong); if (el2 && el2.tagName!=='A' && !isHeaderDesc(el2)) return el2; }
    return null;
  }

  function resolveAndScroll(name){
    if (typeof ANCHOR_OFFSET_PX!=='undefined' && ANCHOR_OFFSET_PX && Object.prototype.hasOwnProperty.call(ANCHOR_OFFSET_PX,name)) {
      var y0=Math.max(0,(ANCHOR_OFFSET_PX[name]|0)-headerOffset()-(EXTRA_ANCHOR_OFFSET_PX|0));
      window.scrollTo({top:y0,behavior:'smooth'}); return;
    }
    var tries=0,max=80; (function tick(){ var el=wideFind(name); if(el){ smoothScrollToEl(el); return; } tries++; if(tries<max) setTimeout(tick,100); else console.warn('Anchor not found, no-op:',name); })();
  }

  // cross-page handoff on click
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null; if (!a) return;

    // Let TB internal router have priority: do not intercept internal links that have data-* attributes
    if (a.hasAttribute('data-testid') || a.hasAttribute('data-hook') || a.hasAttribute('data-state') || a.hasAttribute('data-mesh-id')) {
      return;
    }

    var href=a.getAttribute('href')||'';
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
    if (a.target && a.target!=='_self') return;

    var u=null; try{ u=new URL(href,location.href);}catch(_){ }

    // 1) Anchors: we perform our own smooth-scroll
    var anchor = a.getAttribute('data-anchor') || (href.charAt(0)==='#'?href.slice(1):(u&&u.hash?u.hash.slice(1):''));
    if (anchor){
      e.preventDefault(); if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      return;
    }

    // 2) 2) Absolute links explicitly pointing to upstream domains (WIX/WIXSITE): we map their domains
    if (u && (u.href.indexOf(WIX)===0)) {
      e.preventDefault();
      var mapped=u.href.replace(WIX+SITE,MYO).replace(WIX,MY);
      if(mapped!==location.href) location.assign(mapped);
      return;
    }

    // 3) Other cases: do not intercept, let TB's router handle them
  }, true);


  // read handoff on load / hash boot
  function bootScroll(){
    try{
      var raw=sessionStorage.getItem(SKEY);
      if (raw){ sessionStorage.removeItem(SKEY); var obj; try{ obj=JSON.parse(raw);}catch(_){obj=null;}
        if (obj && obj.n){ resolveAndScroll(obj.n); return; }
      }
    }catch(_){ }
    if (location.hash && location.hash.length>1){
      var n=location.hash.slice(1);
      if (!USE_HASH) history.replaceState(null,'',location.pathname + location.search);
      resolveAndScroll(n);
    }
  }

  (function enforceFavicon(){
    try{
      var href = "${FAVICON_URL}";
      document.querySelectorAll('link[rel*="icon"]').forEach(function(el){ el.remove(); });
      var link = document.createElement('link');
      link.rel = "icon";
      link.type = "image/png";
      link.href = href;
      (document.head || document.documentElement).appendChild(link);

      var touch = document.createElement('link');
      touch.rel = "apple-touch-icon";
      touch.href = href;
      (document.head || document.documentElement).appendChild(touch);
    }catch(_){}
  })();


  function run(){ nukeBanner(); }
  run();
  new MutationObserver(run).observe(document.documentElement,{childList:true,subtree:true});
  setInterval(run,700);
  window.addEventListener('resize',run);
  window.addEventListener('load', bootScroll);
})();
</script>`;

      html = html.replace(/<\/head>/i, inject + "</head>");

      // send HTML
      resHdr["content-type"] = "text/html; charset=UTF-8";
      context.res = { status: upstream.status, headers: resHdr, body: html };
      return;
    }

    // 7) JS branch
    if (/javascript/i.test(ctype) || fileExt(path)===".js"){
      delete resHdr["content-encoding"];
      delete resHdr["content-length"];
      delete resHdr["transfer-encoding"];
      let js = await upstream.text();
      js = js
        .replace(new RegExp(esc(ORIGIN)+esc(SITE_PATH), "g"), PUBLIC_ORIGIN)
        .replace(new RegExp(esc(ORIGIN), "g"), PUBLIC_HOST);
      resHdr["content-type"] = "application/javascript; charset=UTF-8";
      context.res = { status: upstream.status, headers: resHdr, body: js };
      return;
    }

    // 8) others
    if (STATIC_EXTS.has(fileExt(path)) && !resHdr["cache-control"]){
      resHdr["cache-control"] = "public, max-age=86400";
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    context.res = { status: upstream.status, headers: resHdr, body: buf, isRaw:true };

  }catch(err){
    context.log.error("Proxy error", err);
    context.res = { status:502, headers:{ "content-type":"text/plain" }, body:"Upstream fetch failed." };
  }
};