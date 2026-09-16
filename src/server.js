import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
const VERSION = '1.8.5';
const PORT = Number(process.env.PORT) || 3000;
const BASE = 'https://dramaexpress.net';
const UA = `Mozilla/5.0 (compatible; Nuvio-DramaExpress-Addon/${VERSION})`;
const CACHE_MS = 10 * 60 * 1000;
const CATALOG_CACHE_MS = 30 * 60 * 1000;
const DISCOVERY_CACHE_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const RESOLVE_DEADLINE_MS = 7000;
const PROBE_TIMEOUT_MS = 2000;
const DEBUG_FETCH_TIMEOUT_MS = 2500;
const MAX_PAGE = 1000;
const PAGE_SIZE = 100;
const MAX_SCRIPT_FETCHES = 4;
const MAX_API_FETCHES = 8;
const MAX_INLINE_SCAN = 20;
const MAX_DISCOVERED_FETCHES = 12;
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

function normalizeUrlValue(value) {
  return decodeEscaped(String(value || ''))
    .trim()
    .replace(/^[\"'`<>()]+/, '')
    .replace(/[\"'`<>(),;]+$/g, '')
    .replace(/\\+$/g, '');
}

function addCandidate(list, value, base, kind = 'unknown') {
  if (!value || typeof value !== 'string') return;
  const cleaned = normalizeUrlValue(value);
  if (!cleaned) return;
  let u = /^https?:\/\//i.test(cleaned) ? cleaned : abs(cleaned, base);
  if (!u || isBadUrl(u) || list.some(x => x.url === u)) return;
  list.push({ url: u, kind });
}

function extractAbsoluteUrls(text, base, kind, list) {
  const raw = decodeEscaped(text);
  // Only keep URLs that have a realistic player/media/API shape. Do not turn
  // social-share links, schema.org, site navigation, or CDN image hosts into
  // resolver candidates.
  for (const m of raw.matchAll(/https?:\/\/[^"'<>\s\\]+/g)) {
    const u = normalizeUrlValue(m[0]);
    if (/\.(?:m3u8|mp4)(?:\?|$)/i.test(u) || /(?:player|embed|iframe|stream|video|playback|media|playlist|\.json(?:\?|$)|\/api(?:\/|\?|$)|\/ajax(?:\/|\?|$)|\/graphql(?:\/|\?|$))/i.test(u)) {
      addCandidate(list, u, base, kind);
    }
  }
}

function mediaCandidates(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $('video source[src], video[src], source[src], track[src]').each((_, el) => addCandidate(out, $(el).attr('src'), pageUrl, 'media'));
  $('iframe[src], frame[src], embed[src], object[data], [data-video], [data-video-url], [data-player], [data-player-url], [data-stream], [data-src*=".m3u8"], [data-src*=".mp4"]').each((_, el) => {
    addCandidate(out,
      $(el).attr('src') || $(el).attr('data') || $(el).attr('data-src') || $(el).attr('data-video') ||
      $(el).attr('data-video-url') || $(el).attr('data-player') || $(el).attr('data-player-url') || $(el).attr('data-stream'),
      pageUrl, 'embed');
  });
  for (const c of extractEmbeddedJson(html, pageUrl)) addCandidate(out, c.url, pageUrl, c.kind);
  for (const c of extractRuntimeUrls(html, pageUrl)) addCandidate(out, c.url, pageUrl, c.kind);
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

function extractRuntimeUrls(text, pageUrl) {
  const out = [];
  const raw = decodeEscaped(text);
  const add = (value, kind = 'runtime') => addCandidate(out, value, pageUrl, kind);

  // URLs passed to fetch/axios/XHR and common player APIs.
  const callRe = /(?:fetch|axios\.(?:get|post|request)|open)\s*\(\s*[`"']([^`"']+)[`"']/gi;
  for (const m of raw.matchAll(callRe)) add(m[1], 'api');

  // Relative/absolute endpoint strings containing video/player/episode semantics.
  const endpointRe = /(?:https?:\/\/[^\s"'`<>]+|\/(?:api|ajax|graphql|player|play|video|stream|episode|episodes|media|source|v1|v2)[^\s"'`<>]*)/gi;
  for (const m of raw.matchAll(endpointRe)) add(m[0], 'api');

  // NetShort-style playback fields and signed playback URLs.
  const fieldRe = /(?:playUrl|backupPlayUrl|play_url|playbackUrl|playback_url|videoUrl|video_url|streamUrl|stream_url|m3u8Url|m3u8_url|mediaUrl|media_url|episodeUrl|episode_url|playerUrl|player_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi;
  for (const m of raw.matchAll(fieldRe)) add(m[1], 'config');

  // JSON-like strings that contain a direct CDN URL even when the key is minified.
  const directMediaRe = /https?:\/\/[^\s"'`<>\\]+(?:\.m3u8(?:\?[^\s"'`<>\\]*)?|\.mp4(?:\?[^\s"'`<>\\]*)?)/gi;
  for (const m of raw.matchAll(directMediaRe)) add(m[0], 'media');

  return out;
}

function extractEmbeddedJson(html, pageUrl) {
  const out = [];
  const $ = cheerio.load(html);
  $('script[type="application/json"], script[type="application/ld+json"], script#__NEXT_DATA__, script[id*="__NEXT_DATA__"], script[id*="data"]')
    .slice(0, MAX_INLINE_SCAN)
    .each((_, el) => {
      const txt = $(el).text();
      if (!txt) return;
      try {
        const json = JSON.parse(txt);
        urlsFromObject(json, pageUrl, out);
      } catch {}
      for (const c of extractRuntimeUrls(txt, pageUrl)) out.push(c.url);
      for (const c of extractConfigUrls(txt, pageUrl)) out.push(c.url);
    });
  return [...new Set(out)].map(url => ({ url, kind: /m3u8|mp4/i.test(url) ? 'media' : 'embedded' }));
}

function extractPlayerLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  $('iframe[src], frame[src], embed[src], object[data], video[src], source[src], link[href], [data-src], [data-url], [data-href], [data-endpoint], [data-api], [data-play], [data-video], [data-stream], [data-player]')
    .each((_, el) => {
      const value = $(el).attr('src') || $(el).attr('data') || $(el).attr('href') ||
        $(el).attr('data-src') || $(el).attr('data-url') || $(el).attr('data-href') ||
        $(el).attr('data-endpoint') || $(el).attr('data-api') || $(el).attr('data-play') ||
        $(el).attr('data-video') || $(el).attr('data-stream') || $(el).attr('data-player');
      if (!value) return;
      const u = abs(normalizeUrlValue(value), pageUrl);
      if (!u || isBadUrl(u) || out.some(x => x === u)) return;
      if (/iframe|frame|embed|video|source/i.test(el.tagName || '') || /player|play|video|stream|episode|api|ajax|media/i.test(u)) out.push(u);
    });
  return out.slice(0, MAX_DISCOVERED_FETCHES);
}

function extractApiUrls(html, pageUrl) {
  const out = [];
  const add = value => {
    if (!value || typeof value !== 'string') return;
    const u = abs(decodeEscaped(value.trim()), pageUrl);
    if (!u || isBadUrl(u) || out.includes(u)) return;
    if (/\/api(?:\/|\?|$)|\/ajax(?:\/|\?|$)|\/graphql(?:\/|\?|$)|\.json(?:\?|$)|(?:player|playback|stream|video|media)/i.test(u)) out.push(u);
  };
  // Only inspect actual script/data attributes and JS fetch/XHR strings.
  const $ = cheerio.load(html);
  $('script:not([src])').slice(0, MAX_INLINE_SCAN).each((_, el) => {
    const txt = $(el).text() || '';
    for (const m of txt.matchAll(/(?:https?:\/\/[^"'<>\s]+|\/(?:api|ajax|graphql|player|play|video|stream|media|episode|episodes)[^"'<>\s]*)/gi)) add(m[0]);
  });
  $('*[data-api], *[data-endpoint], *[data-play], *[data-player], *[data-stream], *[data-video]').each((_, el) => {
    for (const k of ['data-api','data-endpoint','data-play','data-player','data-stream','data-video']) add($(el).attr(k));
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
  const candidates = [...mediaCandidates(html, url), ...extractConfigUrls(html, url)];
  const discovered = extractPlayerLinks(html, url);
  const runtime = extractRuntimeUrls(html, url);
  return {
    html,
    candidates: candidates.sort((a,b) => rank(b) - rank(a)),
    apiUrls: [...new Set([...extractApiUrls(html, url), ...discovered.filter(u => /api|ajax|graphql|play|video|stream|episode|media/i.test(u)), ...runtime.filter(x => x.kind === 'api').map(x => x.url)])].slice(0, MAX_DISCOVERED_FETCHES),
    scriptUrls: extractScriptUrls(html, url),
    playerLinks: discovered
  };
}

async function resolveDramaExpressEpisode(episodeUrl, depth = 0, seen = new Set(), debug = null, deadline = Date.now() + RESOLVE_DEADLINE_MS) {
  if (Date.now() >= deadline || depth > 4 || seen.has(episodeUrl)) return null;
  seen.add(episodeUrl);
  if (debug) debug.visited.push(episodeUrl);

  let info;
  try { info = await inspectPage(episodeUrl, depth ? [...seen][Math.max(0, seen.size - 2)] : BASE); }
  catch (e) { if (debug) debug.errors.push(`${episodeUrl}: ${e.message}`); return null; }

  if (debug) {
    debug.candidates.push(...info.candidates.slice(0, 40).map(x => ({ ...x, source: episodeUrl })));
    debug.apiUrls.push(...info.apiUrls);
    debug.scriptUrls.push(...info.scriptUrls);
    debug.playerLinks.push(...(info.playerLinks || []));
  }

  const directCandidates = info.candidates.filter(c => /(?:m3u8|mp4|stream|video|playback|media|player|embed)/i.test(c.url));
  for (const c of directCandidates.slice(0, 8)) {
    if (Date.now() >= deadline) return null;
    if (await probeMediaUrl(c.url, episodeUrl)) return { url: c.url, referer: episodeUrl };
  }

  for (const api of info.apiUrls.slice(0, MAX_API_FETCHES)) {
    if (Date.now() >= deadline) return null;
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
    if (Date.now() >= deadline) return null;
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

  for (const player of (info.playerLinks || []).slice(0, MAX_DISCOVERED_FETCHES)) {
    if (Date.now() >= deadline) return null;
    if (seen.has(player)) continue;
    try {
      const body = await fetchText(player, { referer: episodeUrl }, false);
      const playerCandidates = [
        ...extractConfigUrls(body, player),
        ...mediaCandidates(body, player),
        ...extractEmbeddedJson(body, player),
        ...extractRuntimeUrls(body, player)
      ];
      if (debug) debug.playerResponses.push({ url: player, candidates: playerCandidates.slice(0, 40).map(x => x.url || x) });
      for (const c of playerCandidates) {
        const u = typeof c === 'string' ? c : c.url;
        if (u && await probeMediaUrl(u, player)) return { url: u, referer: player };
      }
      const nested = await resolveDramaExpressEpisode(player, depth + 1, seen, debug, deadline);
      if (nested) return nested;
    } catch (e) {
      if (debug) debug.errors.push(`${player}: ${e.message}`);
    }
  }

  for (const c of info.candidates.filter(x => x.kind === 'embed').slice(0, 5)) {
    if (Date.now() >= deadline) return null;
    try {
      const nested = await resolveDramaExpressEpisode(c.url, depth + 1, seen, debug, deadline);
      if (nested) return nested;
    } catch {}
  }
  return null;
}

async function testUpstream(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEBUG_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8', accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      redirect: 'follow', signal: controller.signal
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, elapsedMs: Date.now()-started, finalUrl: r.url, contentType: r.headers.get('content-type') || '', bytes: Buffer.byteLength(body), preview: body.slice(0, 300) };
  } catch (e) {
    return { ok: false, elapsedMs: Date.now()-started, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(timer); }
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

    const resolved = await resolveDramaExpressEpisode(ep.href, 0, new Set(), null, Date.now() + RESOLVE_DEADLINE_MS);
    if (!resolved?.url) return res.json({ streams: [] });

    res.json({ streams: [{
      title: ep.title || `Episode ${n}`,
      url: proxyUrl(req, resolved.url, resolved.referer || ep.href),
      behaviorHints: { bingeGroup: 'dramaexpress', videoOrientation: 'portrait' }
    }] });
  } catch (e) { res.status(502).json({ streams: [], error: e.message }); }
});

app.get('/debug-upstream', async (req, res) => {
  const url = String(req.query.url || `${BASE}/series/upgrade/episode-1`);
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'Bad URL' });
  res.json({ version: VERSION, target: url, ...(await testUpstream(url)) });
});

app.get('/stream-debug/series/:id.json', async (req, res) => {
  const started = Date.now();
  const hardDeadline = started + RESOLVE_DEADLINE_MS;
  const debug = { ok: true, version: VERSION, episode: null, visited: [], candidates: [], apiUrls: [], apiResponses: [], scriptUrls: [], scriptResponses: [], playerLinks: [], playerResponses: [], errors: [], deadlineMs: RESOLVE_DEADLINE_MS, timedOut: false, stream: null, streamReferer: null, resolved: false, proxyStream: null };
  try {
    const decodedId = decodeId(req.params.id);
    const [seriesId, epPart] = decodedId.split(':ep:');
    const slug = seriesSlugFromId(seriesId);
    const pageUrl = `${BASE}/series/${slug}`;
    if (Date.now() >= hardDeadline) throw new Error('resolver deadline exceeded before metadata fetch');
    const m = await fetchHtml(pageUrl);
    if (Date.now() >= hardDeadline) throw new Error('resolver deadline exceeded after metadata fetch');
    const n = Number(epPart || 1);
    const parsed = parseMeta(m, pageUrl);
    const ep = parsed.episodes.find(x => x.number === n) || parsed.episodes[n - 1];
    if (!ep) return res.json({ ...debug, ok: false, stage: 'episode', message: 'Episode not found', totalMs: Date.now()-started });
    debug.episode = ep.href;
    const resolved = await resolveDramaExpressEpisode(ep.href, 0, new Set(), debug, hardDeadline);
    debug.timedOut = Date.now() >= hardDeadline && !resolved?.url;
    debug.stream = resolved?.url || null;
    debug.streamReferer = resolved?.referer || null;
    debug.resolved = Boolean(resolved?.url);
    debug.proxyStream = resolved?.url ? proxyUrl(req, resolved.url, resolved.referer || ep.href) : null;
    debug.totalMs = Date.now() - started;
    return res.json(debug);
  } catch (e) {
    debug.ok = false;
    debug.errors.push(e.message);
    debug.timedOut = Date.now() >= hardDeadline || /deadline|timeout/i.test(e.message);
    debug.totalMs = Date.now() - started;
    return res.json(debug);
  }
});

app.get('/health', (_, res) => res.json({ ok: true, version: VERSION, port: PORT }));
app.get('/', (_, res) => res.type('text').send(`Nuvio DramaExpress addon ${VERSION} is running. Use /manifest.json`));
app.listen(PORT, '0.0.0.0', () => console.log(`DramaExpress addon ${VERSION} listening on 0.0.0.0:${PORT}`));
