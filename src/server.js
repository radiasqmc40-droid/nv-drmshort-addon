import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
const VERSION = '1.8.2';
const PORT = Number(process.env.PORT) || 3000;
const BASE = 'https://dramaexpress.net';
const UA = `Mozilla/5.0 (compatible; Nuvio-DramaExpress-Addon/${VERSION})`;
const CACHE_MS = 10 * 60 * 1000;
const CATALOG_CACHE_MS = 30 * 60 * 1000;
const DISCOVERY_CACHE_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const PROBE_TIMEOUT_MS = 7000;
const MAX_PAGE = 1000;
const PAGE_SIZE = 100;
const MAX_SCRIPT_FETCHES = 8;
const MAX_API_FETCHES = 20;
const MAX_PROXY_BYTES = 25 * 1024 * 1024;

const htmlCache = new Map();
const catalogCache = new Map();
let discoveredCatalogs = null;
let discoveredAt = 0;

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
function abs(u, base = BASE) { try { return new URL(u, base).href; } catch { return null; } }
function slugFromUrl(u) { try { return new URL(u).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } }
function idForUrl(u) { return `dex:${slugFromUrl(u)}`; }
function decodeId(id) { try { return decodeURIComponent(id); } catch { return id; } }
function seriesSlugFromId(id) { return decodeId(id).replace(/^dex:/, '').trim(); }
function labelFromSlug(slug) { return clean(slug.replace(/[-_]+/g, ' ')).replace(/\b\w/g, c => c.toUpperCase()); }

async function fetchText(url, extraHeaders = {}, cacheable = true) {
  const key = `${url}|${extraHeaders.referer || ''}`;
  const now = Date.now();
  const hit = htmlCache.get(key);
  if (cacheable && hit && now - hit.time < CACHE_MS) return hit.text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept-language': 'en-US,en;q=0.8',
        accept: '*/*',
        ...extraHeaders
      },
      redirect: 'follow',
      signal: controller.signal
    });
    if (!r.ok) throw new Error(`Upstream ${r.status} for ${url}`);
    const text = await r.text();
    if (cacheable) htmlCache.set(key, { time: now, text });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url, headers = {}) { return fetchText(url, headers, true); }

async function discoverCatalogs(force = false) {
  const now = Date.now();
  if (!force && discoveredCatalogs && now - discoveredAt < DISCOVERY_CACHE_MS) return discoveredCatalogs;

  const found = new Map();
  const add = (type, href, label) => {
    try {
      const u = new URL(href, BASE);
      const parts = u.pathname.split('/').filter(Boolean);
      if (!['category', 'source'].includes(parts[0]) || !parts[1]) return;
      const slug = parts[1].toLowerCase();
      const id = type === 'category' ? slug : `source-${slug}`;
      if (!found.has(id)) found.set(id, {
        id, type, path: `/${parts[0]}/${slug}`, name: clean(label) || labelFromSlug(slug)
      });
    } catch {}
  };

  for (const path of ['/categories', '/sources', '/']) {
    try {
      const html = await fetchHtml(BASE + path);
      const $ = cheerio.load(html);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = clean($(el).text());
        if (/\/category\//i.test(href)) add('category', href, text);
        else if (/\/source\//i.test(href)) add('source', href, text);
      });
    } catch {}
  }

  if (!found.size) throw new Error('Could not discover DramaExpress categories/sources');
  discoveredCatalogs = Object.fromEntries([...found.values()].map(x => [x.id, x]));
  discoveredAt = now;
  return discoveredCatalogs;
}

async function catalogIndex() { return discoverCatalogs(false); }

function parseSeriesCards(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, el) => {
    const href = abs($(el).attr('href'));
    if (!href || !new URL(href).pathname.includes('/series/')) return;
    const slug = slugFromUrl(href);
    if (!slug || seen.has(slug)) return;
    const card = $(el);
    const img = card.find('img').first();
    const title = clean(card.find('h2,h3,h4,[class*="title"]').first().text()) ||
      clean(img.attr('alt')) || clean(card.text()).split('EP ')[0];
    if (!title) return;
    seen.add(slug);
    out.push({
      id: idForUrl(href), type: 'series', name: title,
      poster: abs(img.attr('src') || img.attr('data-src')), href
    });
  });
  return out;
}

function pageUrl(path, page) { return BASE + path + (page === 1 ? '' : `?page=${page}`); }
function discoverMaxPage(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $('a[href]').each((_, el) => {
    const m = ($(el).attr('href') || '').match(/[?&]page=(\d+)/i);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return Math.min(max, MAX_PAGE);
}

async function collectPages(path, targetCount = PAGE_SIZE) {
  const cacheKey = `${path}|${targetCount}`;
  const now = Date.now();
  const hit = catalogCache.get(cacheKey);
  if (hit && now - hit.time < CATALOG_CACHE_MS) return hit.items;

  const all = [];
  const seen = new Set();
  let maxPage = 1;
  for (let page = 1; page <= maxPage && page <= MAX_PAGE; page++) {
    let html;
    try { html = await fetchHtml(pageUrl(path, page)); } catch { break; }
    if (page === 1) maxPage = discoverMaxPage(html);
    const items = parseSeriesCards(html);
    let added = 0;
    for (const item of items) {
      if (!seen.has(item.id)) { seen.add(item.id); all.push(item); added++; }
    }
    if (!items.length || (page > 1 && added === 0) || all.length >= targetCount) break;
  }
  catalogCache.set(cacheKey, { time: now, items: all });
  return all;
}

async function refreshCatalogHeads() {
  const index = await catalogIndex();
  for (const item of Object.values(index)) {
    try { await collectPages(item.path, PAGE_SIZE); } catch {}
  }
}
setInterval(() => { refreshCatalogHeads().catch(() => {}); }, CATALOG_CACHE_MS).unref();

function episodeNumber(text, href, fallback) {
  const m = `${text || ''} ${href || ''}`.match(/(?:episode|ep)[\s_-]*(\d+)/i);
  return m ? Number(m[1]) : fallback;
}

function parseMeta(html, url) {
  const $ = cheerio.load(html);
  const title = clean($('h1').first().text()) || clean($('meta[property="og:title"]').attr('content')) || slugFromUrl(url);
  const description = clean($('meta[name="description"]').attr('content')) || clean($('meta[property="og:description"]').attr('content'));
  const poster = abs($('meta[property="og:image"]').attr('content')) || abs($('img').first().attr('src'));
  const genres = [];
  $('a[href*="/category/"]').each((_, el) => {
    const t = clean($(el).text());
    if (t && !genres.includes(t)) genres.push(t);
  });
  const map = new Map();
  $('a[href]').each((_, el) => {
    const href = abs($(el).attr('href'));
    const text = clean($(el).text());
    if (!href) return;
    if (!/\/episode(?:[-_/]|\d)|episode\s*\d+|ep[-_]?\d+/i.test(`${href} ${text}`)) return;
    const n = episodeNumber(text, href, map.size + 1);
    if (!map.has(n)) map.set(n, { href, title: text || `Episode ${n}`, number: n });
  });
  return { title, description, poster, genres, episodes: [...map.values()].sort((a,b) => a.number - b.number) };
}

function decodeEscaped(s) {
  return String(s)
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003a/gi, ':')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003f/gi, '?')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/\\"/g, '"');
}

function isBadUrl(url) {
  return !url || /\.(jpg|jpeg|png|webp|gif|svg|css|js|woff2?)(?:\?|$)/i.test(url) ||
    /favicon|logo|sprite|analytics|doubleclick|google-analytics/i.test(url);
}
function isPlayableUrl(url) { return /\.(m3u8|mp4)(?:\?|$)/i.test(url || ''); }

function addCandidate(list, value, base, kind = 'unknown') {
  if (!value || typeof value !== 'string') return;
  let u = decodeEscaped(value.trim().replace(/["'<>]+$/g, ''));
  if (!/^https?:\/\//i.test(u)) u = abs(u, base);
  if (!u || isBadUrl(u) || list.some(x => x.url === u)) return;
  list.push({ url: u, kind });
}

function extractAbsoluteUrls(text, base, kind, list) {
  const raw = decodeEscaped(text);
  for (const m of raw.matchAll(/https?:\/\/[^"'<>\s\\]+/g)) addCandidate(list, m[0], base, kind);
}

function mediaCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $('video source[src], video[src], source[src]').each((_, el) => addCandidate(out, $(el).attr('src'), pageUrl, 'media'));
  $('iframe[src], [data-video], [data-video-url], [data-player], [data-player-url], [data-stream], [data-src*=".m3u8"], [data-src*=".mp4"]').each((_, el) => {
    addCandidate(out,
      $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-video') ||
      $(el).attr('data-video-url') || $(el).attr('data-player') || $(el).attr('data-player-url') || $(el).attr('data-stream'),
      pageUrl, 'embed');
  });
  extractAbsoluteUrls(html, pageUrl, 'script', out);
  return out;
}

function extractConfigUrls(text, pageUrl) {
  const out = [];
  const keyRe = /(?:["']?(?:file|source|src|url|playbackUrl|playback_url|hls|stream|streamUrl|stream_url|videoUrl|video_url|video|playUrl|play_url|m3u8|mp4|mediaUrl|media_url)["']?)\s*[:=]\s*["']([^"']+)["']/gi;
  for (const m of text.matchAll(keyRe)) addCandidate(out, m[1], pageUrl, 'config');
  const mediaRe = /(?:https?:\/\/[^"' \s<>]+|\/(?:[^"' \s<>]+\.(?:m3u8|mp4)(?:\?[^"' \s<>]*)?))/gi;
  for (const m of text.matchAll(mediaRe)) addCandidate(out, m[0], pageUrl, 'media');
  return out;
}

function extractApiUrls(html, pageUrl) {
  const out = [];
  const add = value => {
    if (!value || typeof value !== 'string') return;
    const u = abs(decodeEscaped(value.trim()), pageUrl);
    if (!u || isBadUrl(u) || out.includes(u)) return;
    if (/\/api(?:\/|\?|$)|\/ajax(?:\/|\?|$)|\/graphql(?:\/|\?|$)|\.json(?:\?|$)/i.test(u)) out.push(u);
  };
  for (const m of decodeEscaped(html).matchAll(/(?:https?:\/\/[^"'<> \s]+|\/(?:[^"'<> \s]+(?:\/api\/|\/ajax\/|\/graphql\/|\.json(?:\?|$))[^"'<> \s]*))/gi)) add(m[0]);
  const $ = cheerio.load(html);
  $('script[src]').each((_, el) => {
    const src = abs($(el).attr('src'), pageUrl);
    if (src && /api|ajax|graphql|\.json/i.test(src) && !out.includes(src)) out.push(src);
  });
  return out.slice(0, MAX_API_FETCHES);
}

function extractScriptUrls(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $('script[src]').each((_, el) => {
    const u = abs($(el).attr('src'), pageUrl);
    if (u && !isBadUrl(u) && !out.includes(u)) out.push(u);
  });
  return out.slice(0, MAX_SCRIPT_FETCHES);
}

function urlsFromObject(value, base, out = [], depth = 0) {
  if (depth > 7 || out.length >= 80) return out;
  if (typeof value === 'string') {
    const decoded = decodeEscaped(value);
    if (/^https?:\/\//i.test(decoded) || /^\//.test(decoded)) {
      const u = abs(decoded, base);
      if (u && !isBadUrl(u) && /m3u8|mp4|stream|video|playback|media|source|file|url/i.test(decoded)) out.push(u);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) urlsFromObject(v, base, out, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (/url|src|file|video|stream|play|hls|media|source/i.test(key)) urlsFromObject(v, base, out, depth + 1);
      else if (depth < 3) urlsFromObject(v, base, out, depth + 1);
    }
  }
  return out;
}

async function probeMediaUrl(url, referer) {
  if (!/^https?:\/\//i.test(url || '') || isBadUrl(url)) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, video/*, */*',
        ...(referer ? { referer, origin: (() => { try { return new URL(referer).origin; } catch { return BASE; } })() } : {})
      },
      redirect: 'follow', signal: controller.signal
    });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const finalUrl = r.url || url;
    if (!r.ok) return false;
    if (ct.startsWith('video/') || ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl')) return true;
    if (isPlayableUrl(finalUrl)) return true;
    const sample = (await r.text()).slice(0, 4096);
    return /#EXTM3U|#EXT-X-TARGETDURATION|#EXT-X-STREAM-INF/i.test(sample);
  } catch {
    return false;
  } finally { clearTimeout(timer); }
}
function rank(c) {
  const u = c.url.toLowerCase();
  let s = 0;
  if (/\.m3u8(?:\?|$)/.test(u)) s += 120;
  if (/\.mp4(?:\?|$)/.test(u)) s += 110;
  if (/m3u8|mp4/.test(u)) s += 60;
  if (/stream|video|hls|playlist|playback|media|cdn/.test(u)) s += 25;
  if (c.kind === 'media') s += 30;
  if (c.kind === 'config') s += 20;
  if (c.kind === 'script') s += 10;
  if (c.kind === 'embed') s += 5;
  return s;
}

async function inspectPage(url, referer) {
  const html = await fetchText(url, { referer: referer || BASE }, false);
  return {
    html,
    candidates: [...mediaCandidates(html, url), ...extractConfigUrls(html, url)].sort((a,b) => rank(b) - rank(a)),
    apiUrls: extractApiUrls(html, url),
    scriptUrls: extractScriptUrls(html, url)
  };
}

async function resolveDramaExpressEpisode(episodeUrl, depth = 0, seen = new Set(), debug = null) {
  if (depth > 4 || seen.has(episodeUrl)) return null;
  seen.add(episodeUrl);
  if (debug) debug.visited.push(episodeUrl);

  let info;
  try { info = await inspectPage(episodeUrl, depth ? [...seen][Math.max(0, seen.size - 2)] : BASE); }
  catch (e) { if (debug) debug.errors.push(`${episodeUrl}: ${e.message}`); return null; }

  if (debug) {
    debug.candidates.push(...info.candidates.slice(0, 40).map(x => ({ ...x, source: episodeUrl })));
    debug.apiUrls.push(...info.apiUrls);
    debug.scriptUrls.push(...info.scriptUrls);
  }

  for (const c of info.candidates.slice(0, 30)) {
    if (await probeMediaUrl(c.url, episodeUrl)) return { url: c.url, referer: episodeUrl };
  }

  for (const api of info.apiUrls.slice(0, MAX_API_FETCHES)) {
    try {
      const body = await fetchText(api, { referer: episodeUrl, accept: 'application/json,text/plain,*/*' }, false);
      if (debug) debug.apiResponses.push({ url: api, preview: body.slice(0, 1200) });
      let json;
      try { json = JSON.parse(body); } catch { json = null; }
      const fromJson = json ? urlsFromObject(json, api) : [];
      const fromText = [...extractConfigUrls(body, api), ...mediaCandidates(body, api)];
      const apiCandidates = [...new Set([...fromJson, ...fromText.map(x => x.url)])];
      for (const u of apiCandidates) {
        if (await probeMediaUrl(u, api)) return { url: u, referer: api };
      }
    } catch (e) {
      if (debug) debug.errors.push(`${api}: ${e.message}`);
    }
  }

  for (const script of info.scriptUrls.slice(0, MAX_SCRIPT_FETCHES)) {
    try {
      const js = await fetchText(script, { referer: episodeUrl }, false);
      const candidates = [...extractConfigUrls(js, script), ...mediaCandidates(js, script)].sort((a,b) => rank(b) - rank(a));
      if (debug) debug.scriptResponses.push({ url: script, candidates: candidates.slice(0, 30).map(x => x.url) });
      for (const c of candidates) {
        if (await probeMediaUrl(c.url, script)) return { url: c.url, referer: script };
      }
    } catch (e) {
      if (debug) debug.errors.push(`${script}: ${e.message}`);
    }
  }

  for (const c of info.candidates.filter(x => x.kind === 'embed').slice(0, 8)) {
    try {
      const nested = await resolveDramaExpressEpisode(c.url, depth + 1, seen, debug);
      if (nested) return nested;
    } catch {}
  }
  return null;
}

function publicOrigin(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function proxyUrl(req, target, referer) {
  const q = new URLSearchParams({ url: target });
  if (referer) q.set('ref', referer);
  return `${publicOrigin(req)}/proxy/media?${q.toString()}`;
}

async function fetchUpstream(url, referer, headers = {}) {
  const h = {
    'user-agent': UA,
    accept: '*/*',
    ...(referer ? {
      referer,
      origin: (() => { try { return new URL(referer).origin; } catch { return BASE; } })()
    } : {}),
    ...headers
  };
  return fetch(url, { headers: h, redirect: 'follow' });
}

function rewriteHlsManifest(body, upstreamUrl, req, referer) {
  const base = upstreamUrl;
  const proxify = value => proxyUrl(req, abs(value, base), referer || upstreamUrl);
  return body.split(/\r?\n/).map(line => {
    if (!line || line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, v) => `URI="${proxify(v)}"`);
    }
    return proxify(line.trim());
  }).join('\n');
}

app.get('/proxy/media', async (req, res) => {
  const target = String(req.query.url || '');
  const referer = String(req.query.ref || '');
  if (!/^https?:\/\//i.test(target)) return res.status(400).send('Bad media URL');

  try {
    const range = req.get('range');
    const upstream = await fetchUpstream(target, referer, range ? { range } : {});
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status).send(`Upstream ${upstream.status}`);
    }

    const ct = (upstream.headers.get('content-type') || '').toLowerCase();
    const looksHls = ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl') || /\.m3u8(?:\?|$)/i.test(upstream.url || target);
    if (looksHls) {
      const body = await upstream.text();
      if (body.length > MAX_PROXY_BYTES) return res.status(502).send('Manifest too large');
      res.setHeader('content-type', ct || 'application/vnd.apple.mpegurl');
      res.setHeader('cache-control', 'no-store');
      return res.send(rewriteHlsManifest(body, upstream.url || target, req, referer));
    }

    const contentLength = Number(upstream.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_PROXY_BYTES) return res.status(502).send('Media too large for proxy');
    res.status(upstream.status);
    for (const h of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('cache-control', 'no-store');
    if (upstream.body) {
      const reader = upstream.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once('drain', resolve));
          }
          res.end();
        } catch { res.destroy(); }
      };
      return pump();
    }
    return res.end();
  } catch (e) {
    res.status(502).send(`Proxy error: ${e.message}`);
  }
});

async function buildMeta(id) {
  const slug = seriesSlugFromId(id);
  const url = `${BASE}/series/${slug}`;
  const m = parseMeta(await fetchHtml(url), url);
  const videos = m.episodes.map(ep => ({
    id: `${id}:ep:${ep.number}`,
    title: ep.title || `Episode ${ep.number}`,
    season: 1,
    episode: ep.number,
    thumbnail: m.poster
  }));
  return { id, type: 'series', name: m.title, poster: m.poster, posterShape: 'poster', description: m.description, genres: m.genres, videos };
}

async function manifest() {
  const index = await catalogIndex();
  return {
    id: 'com.nv.drmshort.addon',
    version: VERSION,
    name: 'NV Drama Short',
    description: 'Nuvio addon that dynamically mirrors DramaExpress catalogs and resolves publicly exposed episode streams.',
    logo: `${BASE}/favicon.ico`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    idPrefixes: ['dex:'],
    catalogs: Object.values(index).map(x => ({
      type: 'series', id: x.id, name: x.name,
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
    })),
    behaviorHints: { configurable: false, p2pNotSupported: true }
  };
}

app.get('/manifest.json', async (_, res) => {
  try { res.json(await manifest()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/catalog/series/:id.json', async (req, res) => {
  try {
    const index = await catalogIndex();
    const item = index[req.params.id];
    if (!item) return res.json({ metas: [] });
    const items = await collectPages(item.path, PAGE_SIZE);
    res.json({ metas: items.slice(0, PAGE_SIZE).map(x => ({ id: x.id, type: 'series', name: x.name, poster: x.poster })) });
  } catch (e) { res.status(502).json({ metas: [], error: e.message }); }
});

app.get('/catalog/series/:id/:extra.json', async (req, res) => {
  try {
    const index = await catalogIndex();
    const item = index[req.params.id];
    if (!item) return res.json({ metas: [] });
    const params = new URLSearchParams(req.params.extra);
    const q = clean(params.get('search'));
    const skip = Math.max(0, Number(params.get('skip') || 0));
    const items = await collectPages(item.path, skip + PAGE_SIZE);
    const filtered = q ? items.filter(x => x.name.toLowerCase().includes(q.toLowerCase())) : items;
    res.json({ metas: filtered.slice(skip, skip + PAGE_SIZE).map(x => ({ id: x.id, type: 'series', name: x.name, poster: x.poster })) });
  } catch (e) { res.status(502).json({ metas: [], error: e.message }); }
});

app.get('/meta/series/:id.json', async (req, res) => {
  try { res.json({ meta: await buildMeta(decodeId(req.params.id)) }); }
  catch (e) { res.status(502).json({ meta: { id: req.params.id, type: 'series', name: req.params.id }, error: e.message }); }
});

app.get('/meta/series/:id', async (req, res, next) => {
  if (req.params.id.endsWith('.json')) return next();
  try { res.json({ meta: await buildMeta(decodeId(req.params.id)) }); }
  catch (e) { res.status(502).json({ meta: { id: req.params.id, type: 'series', name: req.params.id }, error: e.message }); }
});

app.get('/stream/series/:id.json', async (req, res) => {
  try {
    const decodedId = decodeId(req.params.id);
    const [seriesId, epPart] = decodedId.split(':ep:');
    const slug = seriesSlugFromId(seriesId);
    const pageUrl = `${BASE}/series/${slug}`;
    const m = parseMeta(await fetchHtml(pageUrl), pageUrl);
    const n = Number(epPart || 1);
    const ep = m.episodes.find(x => x.number === n) || m.episodes[n - 1];
    if (!ep) return res.json({ streams: [] });

    const resolved = await resolveDramaExpressEpisode(ep.href);
    if (!resolved?.url) return res.json({ streams: [] });

    res.json({ streams: [{
      title: ep.title || `Episode ${n}`,
      url: proxyUrl(req, resolved.url, resolved.referer || ep.href),
      behaviorHints: { bingeGroup: 'dramaexpress', videoOrientation: 'portrait' }
    }] });
  } catch (e) { res.status(502).json({ streams: [], error: e.message }); }
});

app.get('/stream-debug/series/:id.json', async (req, res) => {
  try {
    const decodedId = decodeId(req.params.id);
    const [seriesId, epPart] = decodedId.split(':ep:');
    const slug = seriesSlugFromId(seriesId);
    const pageUrl = `${BASE}/series/${slug}`;
    const m = parseMeta(await fetchHtml(pageUrl), pageUrl);
    const n = Number(epPart || 1);
    const ep = m.episodes.find(x => x.number === n) || m.episodes[n - 1];
    if (!ep) return res.json({ ok: false, stage: 'episode', message: 'Episode not found' });

    const debug = {
      ok: true, version: VERSION, episode: ep.href, visited: [], candidates: [],
      apiUrls: [], apiResponses: [], scriptUrls: [], scriptResponses: [], errors: []
    };
    const resolved = await resolveDramaExpressEpisode(ep.href, 0, new Set(), debug);
    debug.stream = resolved?.url || null;
    debug.streamReferer = resolved?.referer || null;
    debug.resolved = Boolean(resolved?.url);
    debug.proxyStream = resolved?.url ? proxyUrl(req, resolved.url, resolved.referer || ep.href) : null;
    res.json(debug);
  } catch (e) { res.status(502).json({ ok: false, version: VERSION, error: e.message }); }
});

app.get('/health', (_, res) => res.json({ ok: true, version: VERSION, port: PORT }));
app.get('/', (_, res) => res.type('text').send(`Nuvio DramaExpress addon ${VERSION} is running. Use /manifest.json`));
app.listen(PORT, '0.0.0.0', () => console.log(`DramaExpress addon ${VERSION} listening on 0.0.0.0:${PORT}`));
