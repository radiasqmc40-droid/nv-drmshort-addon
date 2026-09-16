import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT) || 3000;
const VERSION = "2.0.2";
const PUBLIC_API = "https://dramabos.live";

const SOURCES = [
  ["DramaBox", "dramabox"],
  ["FlareFlow", "flareflow"],
  ["FlickReels", "flickreels"],
  ["GoodShort", "goodshort"],
  ["JoyReels", "joyreels"],
  ["KalosTV", "kalostv"],
  ["MoboReels", "moboreels"],
  ["MoreShort", "moreshort"],
  ["MyDramaWave", "mydramawave"],
  ["NetShort", "netshort"],
  ["PetaDrama", "petadrama"],
  ["Reelshort", "reelshort"],
  ["Shortical", "shortical"],
  ["ShortTV", "shorttv"],
  ["ShortWave", "shortswave"],
  ["Stardust", "stardusttv"],
  ["StoryReel", "storyreel"]
];

const PUBLIC_PROVIDERS = new Map([
  ["dramabox", "dramabox"],
  ["flareflow", "flareflow"],
  ["flickreels", "flickreels"],
  ["goodshort", "goodshort"],
  ["joyreels", "joyreels"],
  ["kalostv", "kalostv"],
  ["moboreels", "moboreels"],
  ["netshort", "netshort"],
  ["reelshort", "reelshort"],
  ["stardusttv", "stardusttv"],
  ["shortswave", "shortswave"]
]);

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function getJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "NV-Drama-Short/2.0.2" }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return fallback;
}

function normalizeItems(payload) {
  const arr = Array.isArray(payload) ? payload :
    payload?.data?.list || payload?.data?.items || payload?.list ||
    payload?.items || payload?.results || [];
  return arr.map((x, i) => ({
    id: String(pick(x, ["id", "bookId", "dramaId", "seriesId"], i + 1)),
    type: "series",
    name: pick(x, ["name", "title", "bookName", "dramaName"], "Untitled"),
    poster: pick(x, ["poster", "cover", "coverUrl", "thumbnail", "image"], "")
  }));
}

async function catalog(provider, search = "") {
  const p = PUBLIC_PROVIDERS.get(provider);
  if (!p) return [];
  const q = search ? `?keyword=${encodeURIComponent(search)}` : "";
  const data = await getJSON(`${PUBLIC_API}/${p}/api/v1/search${q}`);
  return normalizeItems(data).map(x => ({ ...x, id: `${provider}:${x.id}` }));
}

async function meta(provider, id) {
  const p = PUBLIC_PROVIDERS.get(provider);
  if (!p) throw new Error("Public playback API not verified for this source");
  const data = await getJSON(`${PUBLIC_API}/${p}/api/v1/detail/${encodeURIComponent(id)}`);
  const d = data?.data ?? data;
  return {
    id: `${provider}:${id}`,
    type: "series",
    name: pick(d, ["name", "title", "bookName", "dramaName"], "Untitled"),
    poster: pick(d, ["poster", "cover", "coverUrl", "thumbnail", "image"], ""),
    description: pick(d, ["description", "desc", "synopsis"], ""),
    background: pick(d, ["background", "backdrop", "cover"], ""),
    genres: d?.genres || d?.tags || [],
    videos: []
  };
}

async function episodes(provider, id) {
  const p = PUBLIC_PROVIDERS.get(provider);
  if (!p) throw new Error("Public playback API not verified for this source");
  const data = await getJSON(`${PUBLIC_API}/${p}/api/v1/episodes/${encodeURIComponent(id)}`);
  return data?.data?.episodes || data?.episodes || data?.data || data || [];
}

function extractUrl(x) {
  if (typeof x === "string") return x.startsWith("http") ? x : "";
  return pick(x, ["url", "playUrl", "play_url", "videoUrl", "video_url", "m3u8", "streamUrl"], "");
}

async function stream(provider, id, ep) {
  const p = PUBLIC_PROVIDERS.get(provider);
  if (!p) throw new Error("Public playback API not verified for this source");
  const data = await getJSON(`${PUBLIC_API}/${p}/api/v1/play/${encodeURIComponent(id)}/${encodeURIComponent(ep)}`);
  const root = data?.data ?? data;
  const candidates = [
    extractUrl(root),
    extractUrl(root?.video),
    extractUrl(root?.stream),
    ...(Array.isArray(root?.sources) ? root.sources.map(extractUrl) : [])
  ].filter(Boolean);
  const url = candidates.find(u => /\.m3u8(\?|$)/i.test(u)) || candidates[0];
  if (!url) throw new Error("No public stream URL returned");
  return { url, type: /\.m3u8(\?|$)/i.test(url) ? "hls" : "mp4" };
}

function splitId(raw) {
  const s = decodeURIComponent(raw || "");
  const i = s.indexOf(":");
  return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : ["", s];
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*"
      });
      return res.end();
    }

    const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = u.pathname;

    if (path === "/health") return send(res, 200, { ok: true, version: VERSION });
    if (path === "/") return send(res, 200, {
      ok: true, name: "NV Drama Short Public", version: VERSION,
      dramaExpress: false,
      sources: SOURCES.map(([name, id]) => ({ name, id, publicApi: PUBLIC_PROVIDERS.has(id) }))
    });
    if (path === "/manifest.json") return send(res, 200, manifest);

    let m = path.match(/^\/catalog\/series\/([^/]+)\.json$/);
    if (m) {
      const [provider] = splitId(m[1]);
      const search = u.searchParams.get("search") || u.searchParams.get("q") || "";
      const skip = Number(u.searchParams.get("skip") || 0);
      const items = await catalog(provider, search);
      return send(res, 200, { metas: items.slice(skip, skip + 100) });
    }

    m = path.match(/^\/meta\/series\/([^/]+)\.json$/);
    if (m) {
      const [provider, id] = splitId(m[1]);
      return send(res, 200, { meta: await meta(provider, id) });
    }

    m = path.match(/^\/stream\/series\/([^/]+)\.json$/);
    if (m) {
      const [provider, id] = splitId(m[1]);
      const ep = u.searchParams.get("episode") || u.searchParams.get("ep") || "1";
      return send(res, 200, { streams: [await stream(provider, id, ep)] });
    }

    m = path.match(/^\/episodes\/([^/]+)\.json$/);
    if (m) {
      const [provider, id] = splitId(m[1]);
      return send(res, 200, { episodes: await episodes(provider, id) });
    }

    return send(res, 404, { error: "Not found" });
  } catch (e) {
    return send(res, 502, { error: String(e?.message || e) });
  }
});

console.log(`Starting NV Drama Short Public ${VERSION} on port ${PORT}...`);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`LISTENING ${PORT}`);
});
