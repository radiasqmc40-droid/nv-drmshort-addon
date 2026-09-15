import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BASE = 'https://dramaexpress.net';
const UA = 'Mozilla/5.0 (compatible; Nuvio-DramaExpress-Addon/1.2)';
const CACHE_MS = 10 * 60 * 1000;
const CATALOG_CACHE_MS = 30 * 60 * 1000;
const DISCOVERY_CACHE_MS = 30 * 60 * 1000;
const MAX_PAGE = 1000;
const PAGE_SIZE = 100;
const catalogCache = new Map();
const cache = new Map();
let discoveredCatalogs = null;
let discoveredAt = 0;

function slugifyId(s) {
  return clean(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function labelFromSlug(slug) {
  return clean(slug.replace(/[-_]+/g, ' ')).replace(/\b\w/g, c => c.toUpperCase());
}

async function discoverCatalogs(force = false) {
  const now = Date.now();
  if (!force && discoveredCatalogs && now - discoveredAt < DISCOVERY_CACHE_MS) return discoveredCatalogs;

  const found = new Map();
  const add = (type, href, label) => {
    try {
      const u = new URL(href, BASE);
      const parts = u.pathname.split('/').filter(Boolean);
      const index = parts[0] === 'category' || parts[0] === 'source' ? 0 : -1;
      if (index < 0 || !parts[1]) return;
      const slug = parts[1].toLowerCase();
      const id = type === 'category' ? slug : `source-${slug}`;
      if (!found.has(id)) found.set(id, { id, type, path: `/${parts[0]}/${slug}`, name: clean(label) || labelFromSlug(slug) });
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

async function catalogIndex() {
  return discoverCatalogs(false);
}

function abs(u) { try { return new URL(u, BASE).href; } catch { return null; } }
function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
function slugFromUrl(u) { try { return new URL(u).pathname.split('/').filter(Boolean).pop() || ''; } catch { return ''; } }
function idForUrl(u) { return `dex:${slugFromUrl(u)}`; }
function decodeId(id) { try { return decodeURIComponent(id); } catch { return id; } }
function seriesSlugFromId(id) { return decodeId(id).replace(/^dex:/, '').trim(); }

async function fetchHtml(url) {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.time < CACHE_MS) return hit.html;
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Upstream ${r.status} for ${url}`);
  const html = await r.text();
  cache.set(url, { time: now, html });
  return html;
}

function parseSeriesCards(html) {
  const $ = cheerio.load(html);
  const seen = new Set(); const out = [];
  $('a[href]').each((_, el) => {
    const href = abs($(el).attr('href'));
    if (!href || !new URL(href).pathname.includes('/series/')) return;
    const slug = slugFromUrl(href); if (!slug || seen.has(slug)) return;
    const card = $(el); const img = card.find('img').first();
    const title = clean(card.find('h2,h3,h4,[class*="title"]').first().text()) || clean(img.attr('alt')) || clean(card.text()).split('EP ')[0];
    if (!title) return;
    seen.add(slug); out.push({ id: idForUrl(href), type: 'series', name: title, poster: abs(img.attr('src') || img.attr('data-src')) || undefined, href });
  });
  return out;
}

function pageUrl(path, page) {
  return BASE + path + (page === 1 ? '' : `?page=${page}`);
}

function discoverMaxPage(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/[?&]page=(\d+)/i);
    if (m) max = Math.max(max, Number(m[1]));
  });
  const text = clean($.root().text());
  for (const m of text.matchAll(/(?:^|\s)(\d{2,4})(?:\s|$)/g)) {
    const n = Number(m[1]);
    if (n > max && n <= MAX_PAGE) max = n;
  }
  return Math.min(max, MAX_PAGE);
}

function parsePage(path, page, html) {
  return parseSeriesCards(html).map(x => ({ ...x, page }));
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
    const url = pageUrl(path, page);
    let html;
    try { html = await fetchHtml(url); } catch { break; }
    if (page === 1) maxPage = discoverMaxPage(html);
    const items = parsePage(path, page, html);
    let added = 0;
    for (const item of items) {
      if (!seen.has(item.id)) { seen.add(item.id); all.push(item); added++; }
    }
    if (!items.length || (page > 1 && added === 0)) break;
    if (all.length >= targetCount) break;
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
  $('a[href*="/category/"]').each((_, el) => { const t = clean($(el).text()); if (t && !genres.includes(t)) genres.push(t); });
  const map = new Map();
  $('a[href]').each((_, el) => {
    const href = abs($(el).attr('href')); const text = clean($(el).text());
    if (!href) return;
    const isEpisode = /\/episode(?:[-_/]|\d)|episode\s*\d+|ep[-_]?\d+/i.test(`${href} ${text}`);
    if (!isEpisode) return;
    const n = episodeNumber(text, href, map.size + 1);
    if (!map.has(n)) map.set(n, { href, title: text || `Episode ${n}`, number: n });
  });
  return { title, description, poster, genres, episodes: [...map.values()].sort((a,b) => a.number - b.number) };
}

function decodeEscaped(s) {
  return s.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\"/g, '"');
}

function mediaCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const candidates = [];
  const add = (u, kind='media') => {
    if (!u || typeof u !== 'string') return;
    u = decodeEscaped(u.trim());
    if (!/^https?:\/\//i.test(u)) u = abs(u);
    if (!u || candidates.some(x => x.url === u)) return;
    candidates.push({ url: u, kind });
  };

  $('video source[src], video[src], source[src]').each((_, el) => add($(el).attr('src')));
  $('iframe[src], video[data-src], [data-video], [data-video-url], [data-src*=".m3u8"], [data-src*=".mp4"]').each((_, el) => {
    add($(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-video') || $(el).attr('data-video-url'), 'embed');
  });
  $('a[href]').each((_, el) => add($(el).attr('href'), 'link'));

  const raw = html.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  const urlRe = /https?:\\?\/\\?\/[^"'<>\s\\]+/g;
  for (const m of raw.matchAll(urlRe)) add(m[0].replace(/\\+$/,''), 'script');
  return candidates;
}

function scoreCandidate(c) {
  const u = c.url.toLowerCase();
  let s = 0;
  if (/\.m3u8(?:\?|$)/.test(u)) s += 100;
  if (/\.mp4(?:\?|$)/.test(u)) s += 90;
  if (/\.m3u8|\.mp4/.test(u)) s += 50;
  if (/dramaboxdb|video|stream|cdn/.test(u)) s += 10;
  if (c.kind === 'media') s += 20;
  if (c.kind === 'embed') s += 5;
  if (/\.jpg|\.jpeg|\.png|\.webp|favicon/.test(u)) s -= 100;
  if (/\/episode\//.test(u) || /dramaexpress\.net/.test(u)) s -= 20;
  return s;
}

async function resolveDramaExpressEpisode(episodeUrl, depth = 0) {
  if (depth > 2) return null;
  const html = await fetchHtml(episodeUrl);
  const candidates = mediaCandidates(html, episodeUrl).sort((a,b) => scoreCandidate(b) - scoreCandidate(a));
  for (const c of candidates) {
    if (/\.(m3u8|mp4)(?:\?|$)/i.test(c.url)) return c.url;
  }
  // Follow public embedded player pages; do not bypass authentication, DRM, or paywalls.
  for (const c of candidates.filter(x => x.kind === 'embed')) {
    try {
      const nested = await resolveDramaExpressEpisode(c.url, depth + 1);
      if (nested) return nested;
    } catch {}
  }
  return candidates[0]?.url || null;
}

async function manifest() {
  const index = await catalogIndex();
  return {
    id: 'com.nv.drmshort.addon', version: '1.6.0', name: 'NV Drama Short',
    description: 'Nuvio addon that dynamically mirrors DramaExpress categories and source catalogs and resolves publicly exposed episode streams from DramaExpress pages.',
    logo: 'https://dramaexpress.net/favicon.ico', resources: ['catalog','meta','stream'], types: ['series'], idPrefixes: ['dex:'],
    catalogs: Object.values(index).map(x => ({ type:'series', id:x.id, name:x.name, extra:[{ name:'search', isRequired:false }, { name:'skip', isRequired:false }] })),
    behaviorHints: { configurable:false, p2pNotSupported:true }
  };
}

app.get('/manifest.json', async (_, res) => {
  try { res.json(await manifest()); } catch (e) { res.status(502).json({ error:e.message }); }
});

app.get('/catalog/series/:id.json', async (req, res) => {
  try {
    const index = await catalogIndex();
    const item = index[req.params.id];
    if (!item) return res.json({ metas: [] });
    const items = await collectPages(item.path, PAGE_SIZE);
    res.json({ metas: items.slice(0, PAGE_SIZE).map(x => ({ id:x.id,type:'series',name:x.name,poster:x.poster })) });
  } catch (e) { res.status(502).json({ metas:[], error:e.message }); }
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
    res.json({ metas: filtered.slice(skip, skip + PAGE_SIZE).map(x => ({ id:x.id,type:'series',name:x.name,poster:x.poster })) });
  } catch (e) { res.status(502).json({ metas:[], error:e.message }); }
});

app.get('/meta/series/:id.json', async (req, res) => {
  try {
    const slug = seriesSlugFromId(req.params.id); const url = `${BASE}/series/${slug}`; const m = parseMeta(await fetchHtml(url), url);
    const videos = m.episodes.map(ep => ({ id:`${req.params.id}:ep:${ep.number}`, title:ep.title || `Episode ${ep.number}`, season:1, episode:ep.number, thumbnail:m.poster, released: undefined }));
    res.json({ meta:{ id:req.params.id,type:'series',name:m.title,poster:m.poster,posterShape:'poster',description:m.description,genres:m.genres,videos } });
  } catch (e) { res.status(502).json({ meta:{id:req.params.id,type:'series',name:req.params.id}, error:e.message }); }
});

app.get('/stream/series/:id.json', async (req, res) => {
  try {
    const decodedId = decodeId(req.params.id); const [seriesId, epPart] = decodedId.split(':ep:'); const slug = seriesSlugFromId(seriesId);
    const pageUrl = `${BASE}/series/${slug}`; const m = parseMeta(await fetchHtml(pageUrl), pageUrl); const n = Number(epPart || 1);
    const ep = m.episodes.find(x => x.number === n) || m.episodes[n - 1]; if (!ep) return res.json({ streams:[] });
    const target = await resolveDramaExpressEpisode(ep.href);
    if (!target) return res.json({ streams:[] });
    const stream = { title:ep.title || `Episode ${n}`, url:target, behaviorHints:{ bingeGroup:'dramaexpress' } };
    if (/\.m3u8(?:\?|$)/i.test(target)) stream.behaviorHints.videoSize = 0;
    res.json({ streams:[stream] });
  } catch (e) { res.status(502).json({ streams:[], error:e.message }); }
});

app.get('/meta/series/:id', async (req, res, next) => {
  if (req.params.id.endsWith('.json')) return next();
  try {
    const id = decodeId(req.params.id);
    const slug = seriesSlugFromId(id);
    const url = `${BASE}/series/${slug}`;
    const m = parseMeta(await fetchHtml(url), url);
    const videos = m.episodes.map(ep => ({ id:`${id}:ep:${ep.number}`, title:ep.title || `Episode ${ep.number}`, season:1, episode:ep.number, thumbnail:m.poster }));
    res.json({ meta:{ id,type:'series',name:m.title,poster:m.poster,posterShape:'poster',description:m.description,genres:m.genres,videos } });
  } catch (e) { res.status(502).json({ meta:{id:req.params.id,type:'series',name:req.params.id}, error:e.message }); }
});

app.get('/health', (_, res) => res.json({ ok:true, version:'1.6.0' }));
app.get('/', (_, res) => res.type('text').send('Nuvio DramaExpress addon is running. Use /manifest.json'));
app.listen(PORT, '0.0.0.0', () => console.log(`DramaExpress addon listening on 0.0.0.0:${PORT}`));
