import express from 'express';
import * as cheerio from 'cheerio';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_API = 'https://dramabos.live';
const PUBLIC_WEB = 'https://everydrama.com';
const VERSION = '2.0.0';
const UA = `Mozilla/5.0 (compatible; Nuvio-Public-Drama-Addon/${VERSION})`;
const FETCH_TIMEOUT_MS = 12000;
const CACHE_MS = 10 * 60 * 1000;
const CATALOG_CACHE_MS = 30 * 60 * 1000;
const PAGE_SIZE = 100;

// Exactly the 17 source catalogs requested by the user. FlexTV is intentionally excluded.
const SOURCES = [
  ['dramabox', 'DramaBox'], ['flareflow', 'FlareFlow'], ['flickreels', 'FlickReels'],
  ['goodshort', 'GoodShort'], ['joyreels', 'JoyReels'], ['kalostv', 'KalosTV'],
  ['moboreels', 'MoboReels'], ['moreshort', 'MoreShort'], ['mydramawave', 'MyDramaWave'],
  ['netshort', 'NetShort'], ['petadrama', 'PetaDrama'], ['reelshort', 'Reelshort'],
  ['shortical', 'Shortical'], ['shorttv', 'ShortTV'], ['shortwave', 'ShortWave'],
  ['stardusttv', 'Stardust'], ['storyreel', 'StoryReel']
];
const SOURCE_MAP = Object.fromEntries(SOURCES.map(([id, name]) => [id, { id, name }]));

// DramaBos publicly documents standard search/detail/episodes/play endpoints for these providers.
// Providers without a documented public endpoint here fall back to EveryDrama, a public aggregator.
const DRAMABOS = {
  dramabox: 'dramabox', flareflow: 'flareflow', flickreels: 'flickreels', goodshort: 'goodshort',
  joyreels: 'joyreels', kalostv: 'kalostv', moboreels: 'moboreels', netshort: 'netshort',
  reelshort: 'reelshort', stardusttv: 'stardusttv', shortwave: 'shortswave'
};

const cache = new Map();
const catalogCache = new Map();
let everyPlatformLinks = null;

function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
function abs(base, u) { try { return new URL(u, base).href; } catch { return null; } }
function encodePart(s) { return encodeURIComponent(String(s)); }
function decodePart(s) { try { return decodeURIComponent(s); } catch { return s; } }
function sourceFromId(id) { return decodePart(id).split(':')[1] || ''; }
function publicId(source, id) { return `pub:${source}:${encodePart(id)}`; }
function parsePublicId(id) {
  const x = decodePart(id);
  const m = x.match(/^pub:([^:]+):(.+)$/);
  return m ? { source: m[1], id: m[2] } : null;
}

async function fetchText(url) {
  const hit = cache.get(url); const now = Date.now();
  if (hit && now - hit.time < CACHE_MS) return hit.body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: controller.signal,
      headers: { 'user-agent': UA, 'accept': 'application/json,text/html;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.8' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.text(); cache.set(url, { time: now, body }); return body;
  } finally { clearTimeout(timer); }
}
async function fetchJson(url) { return JSON.parse(await fetchText(url)); }

function arrayFrom(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  for (const k of ['data','results','items','list','dramas','episodes','chapters','videos']) {
    if (Array.isArray(obj?.[k])) return obj[k];
    if (obj?.data && Array.isArray(obj.data?.[k])) return obj.data[k];
  }
  return [];
}
function findField(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  if (obj.data && typeof obj.data === 'object') for (const k of keys) if (obj.data[k] !== undefined && obj.data[k] !== null) return obj.data[k];
  return fallback;
}
function normalizeDrama(source, raw) {
  const id = String(findField(raw, ['id','dramaId','bookId','code'], '') || '');
  const title = clean(findField(raw, ['title','name','bookName'], 'Untitled'));
  const poster = findField(raw, ['cover','poster','image','thumbnail','coverUrl']);
  const synopsis = clean(findField(raw, ['synopsis','description','desc','summary'], ''));
  const episodes = Number(findField(raw, ['episodes','episodeCount','totalEpisodes','total_episodes','chapters'], 0)) || 0;
  return { id: publicId(source, id), rawId:id, source, type:'series', name:title, poster:poster || undefined, description:synopsis, episodes };
}

async function dbSearch(source, query, page=1) {
  const p = DRAMABOS[source]; if (!p) return [];
  const url = `${PUBLIC_API}/${p}/api/v1/search?keyword=${encodePart(query || '')}&page=${page}`;
  const data = await fetchJson(url); return arrayFrom(data).map(x => normalizeDrama(source, x)).filter(x => x.rawId);
}
async function dbHome(source, page=1) {
  const p = DRAMABOS[source]; if (!p) return [];
  for (const url of [
    `${PUBLIC_API}/${p}/api/v1/home?page=${page}`,
    `${PUBLIC_API}/${p}/api/v1/discover?page=${page}`
  ]) {
    try { const data = await fetchJson(url); const out = arrayFrom(data).map(x => normalizeDrama(source,x)).filter(x=>x.rawId); if (out.length) return out; } catch {}
  }
  return [];
}

async function discoverEveryPlatforms() {
  if (everyPlatformLinks) return everyPlatformLinks;
  const html = await fetchText(PUBLIC_WEB + '/');
  const $ = cheerio.load(html); const out = {};
  $('a[href]').each((_, el) => {
    const text = clean($(el).text()).toLowerCase();
    const href = abs(PUBLIC_WEB, $(el).attr('href'));
    if (!href) return;
    for (const [id, meta] of SOURCES) {
      if (text === meta.toLowerCase() || text.replace(/\s+/g,'') === meta.toLowerCase().replace(/\s+/g,'')) out[id] = href;
    }
  });
  everyPlatformLinks = out; return out;
}

function parseEveryDramaCards(html, source) {
  const $ = cheerio.load(html); const out=[]; const seen=new Set();
  $('a[href*="/drama/"]').each((_,el)=>{
    const href=abs(PUBLIC_WEB,$(el).attr('href')); if(!href||seen.has(href)) return;
    const card=$(el); const img=card.find('img').first();
    const title=clean(card.find('h2,h3,h4,[class*="title"]').first().text()) || clean(img.attr('alt')) || clean(card.text()).replace(/\d+\s*Episodes?/i,'');
    if(!title) return; seen.add(href);
    const m=href.match(/\/drama\/([^/?#]+)/i); const rawId=m?.[1]||href;
    const epText=clean(card.text()).match(/(\d+)\s*Episodes?/i); const episodes=epText?Number(epText[1]):0;
    out.push({id:publicId(source,rawId),rawId,source,type:'series',name:title,poster:abs(PUBLIC_WEB,img.attr('src')||img.attr('data-src')),episodes,href});
  });
  return out;
}
async function everyCatalog(source, page=1) {
  const links=await discoverEveryPlatforms(); const root=links[source]; if(!root) return [];
  const urls=[root];
  if(page>1) { urls.push(`${root}${root.includes('?')?'&':'?'}page=${page}`); urls.push(`${root.replace(/\/$/,'')}/page/${page}`); }
  for(const u of urls){ try { const items=parseEveryDramaCards(await fetchText(u),source); if(items.length) return items; } catch {} }
  return [];
}
async function sourceCatalog(source, page=1, query='') {
  const key=`${source}|${page}|${query}`; const hit=catalogCache.get(key); if(hit&&Date.now()-hit.time<CATALOG_CACHE_MS) return hit.items;
  let items=[];
  if(DRAMABOS[source]) items=query?await dbSearch(source,query,page):await dbHome(source,page);
  if(!items.length) items=await everyCatalog(source,page);
  if(query && !DRAMABOS[source]) items=items.filter(x=>x.name.toLowerCase().includes(query.toLowerCase()));
  catalogCache.set(key,{time:Date.now(),items}); return items;
}

async function dbDetail(source,id) { return fetchJson(`${PUBLIC_API}/${DRAMABOS[source]}/api/v1/detail/${encodePart(id)}`); }
async function dbEpisodes(source,id) { return fetchJson(`${PUBLIC_API}/${DRAMABOS[source]}/api/v1/episodes/${encodePart(id)}`); }
function normalizeEpisodes(data, poster) {
  return arrayFrom(data).map((x,i)=>({
    id:String(findField(x,['id','episodeId','chapterId','code'],i+1)),
    number:Number(findField(x,['episode','episodeNumber','index','number','ep'],i+1))||i+1,
    title:clean(findField(x,['title','name'],`Episode ${i+1}`)), thumbnail:findField(x,['thumbnail','cover','image'],poster)
  })).sort((a,b)=>a.number-b.number);
}

async function getMeta(item) {
  if(DRAMABOS[item.source]) {
    try {
      const d=await dbDetail(item.source,item.rawId); const base=d?.data||d;
      const eps=normalizeEpisodes(await dbEpisodes(item.source,item.rawId),item.poster);
      return { ...item, name:clean(findField(base,['title','name'],item.name)), poster:findField(base,['cover','poster','image'],item.poster), description:clean(findField(base,['synopsis','description','desc'],item.description)), videos:eps.map(e=>({id:`${item.id}:ep:${e.number}`,title:e.title,season:1,episode:e.number,thumbnail:e.thumbnail})) };
    } catch {}
  }
  if(item.href) {
    const html=await fetchText(item.href); const $=cheerio.load(html);
    const name=clean($('h1').first().text())||item.name; const poster=abs(PUBLIC_WEB,$('meta[property="og:image"]').attr('content'))||item.poster;
    const desc=clean($('meta[name="description"]').attr('content'))||item.description;
    const total=Number((clean($.root().text()).match(/(\d+)\s*Episodes?/i)||[])[1])||item.episodes;
    return {...item,name,poster,description:desc,videos:Array.from({length:total},(_,i)=>({id:`${item.id}:ep:${i+1}`,title:`Episode ${i+1}`,season:1,episode:i+1,thumbnail:poster}))};
  }
  return {...item,videos:Array.from({length:item.episodes||0},(_,i)=>({id:`${item.id}:ep:${i+1}`,title:`Episode ${i+1}`,season:1,episode:i+1,thumbnail:item.poster}))};
}

function streamUrls(obj,out=[]) {
  if(!obj) return out;
  if(typeof obj==='string') { if(/\.(m3u8|mp4)(?:\?|$)/i.test(obj)||/\/hls\//i.test(obj)) out.push(obj); return out; }
  if(Array.isArray(obj)) { for(const x of obj) streamUrls(x,out); return out; }
  if(typeof obj==='object') for(const [k,v] of Object.entries(obj)) { if(/url|stream|video|play|m3u8|mp4/i.test(k)) streamUrls(v,out); else if(typeof v==='object') streamUrls(v,out); }
  return [...new Set(out)];
}
async function getStream(item, ep) {
  if(DRAMABOS[item.source]) {
    const p=DRAMABOS[item.source];
    const data=await fetchJson(`${PUBLIC_API}/${p}/api/v1/play/${encodePart(item.rawId)}/${Number(ep)}`);
    const urls=streamUrls(data); if(urls.length) return urls[0];
  }
  // Public fallback: parse the EveryDrama episode page for an openly exposed media URL.
  const links=await discoverEveryPlatforms(); const root=links[item.source]; if(!root) return null;
  const items=await everyCatalog(item.source,1); const match=items.find(x=>x.rawId===item.rawId);
  if(!match?.href) return null;
  const html=await fetchText(match.href); const $=cheerio.load(html); const candidates=[];
  $('video[src],video source[src],source[src],iframe[src]').each((_,el)=>candidates.push(abs(PUBLIC_WEB,$(el).attr('src'))));
  for(const c of candidates.filter(Boolean)) if(/\.(m3u8|mp4)(?:\?|$)/i.test(c)) return c;
  const raw=html.replace(/\\\//g,'/'); const re=/https?:[^"'<>\s\\]+(?:m3u8|mp4)(?:\?[^"'<>\s\\]*)?/gi; const m=raw.match(re); return m?.[0]||null;
}

function manifest() {
  return { id:'com.nv.drmshort.addon',version:VERSION,name:'NV Drama Short Public',description:'Nuvio addon using public provider APIs/public pages only; DramaExpress is not used.',logo:'https://everydrama.com/favicon.ico',resources:['catalog','meta','stream'],types:['series'],idPrefixes:['pub:'],catalogs:SOURCES.map(([id,name])=>({type:'series',id,name,extra:[{name:'search',isRequired:false},{name:'skip',isRequired:false}]})),behaviorHints:{configurable:false,p2pNotSupported:true}};
}

app.get('/manifest.json',(_,res)=>res.json(manifest()));
app.get('/catalog/series/:id.json',async(req,res)=>{try{const source=req.params.id; if(!SOURCE_MAP[source])return res.json({metas:[]}); const items=await sourceCatalog(source,1); res.json({metas:items.slice(0,PAGE_SIZE).map(x=>({id:x.id,type:'series',name:x.name,poster:x.poster}))});}catch(e){res.status(502).json({metas:[],error:e.message})}});
app.get('/catalog/series/:id/:extra.json',async(req,res)=>{try{const source=req.params.id; if(!SOURCE_MAP[source])return res.json({metas:[]}); const p=new URLSearchParams(req.params.extra); const q=clean(p.get('search')); const skip=Math.max(0,Number(p.get('skip')||0)); const page=Math.floor(skip/PAGE_SIZE)+1; const items=await sourceCatalog(source,page,q); res.json({metas:items.slice(skip%PAGE_SIZE,(skip%PAGE_SIZE)+PAGE_SIZE).map(x=>({id:x.id,type:'series',name:x.name,poster:x.poster}))});}catch(e){res.status(502).json({metas:[],error:e.message})}});
app.get('/meta/series/:id.json',async(req,res)=>{try{const parsed=parsePublicId(req.params.id); if(!parsed||!SOURCE_MAP[parsed.source])return res.json({meta:{id:req.params.id,type:'series',name:req.params.id}}); let items=await sourceCatalog(parsed.source,1); let item=items.find(x=>x.rawId===parsed.id); if(!item&&DRAMABOS[parsed.source]) { const d=await dbDetail(parsed.source,parsed.id); item=normalizeDrama(parsed.source,d?.data||d); } if(!item)item={id:req.params.id,rawId:parsed.id,source:parsed.source,name:parsed.id}; const m=await getMeta(item); res.json({meta:{id:req.params.id,type:'series',name:m.name,poster:m.poster,posterShape:'poster',description:m.description,videos:m.videos}});}catch(e){res.status(502).json({meta:{id:req.params.id,type:'series',name:req.params.id},error:e.message})}});
app.get('/stream/series/:id.json',async(req,res)=>{try{const x=decodePart(req.params.id); const [base,epPart]=x.split(':ep:'); const parsed=parsePublicId(base); if(!parsed)return res.json({streams:[]}); let items=await sourceCatalog(parsed.source,1); let item=items.find(z=>z.rawId===parsed.id); if(!item)item={id:base,rawId:parsed.id,source:parsed.source,name:parsed.id}; const url=await getStream(item,Number(epPart||1)); if(!url)return res.json({streams:[]}); res.json({streams:[{title:`Episode ${Number(epPart||1)}`,url,behaviorHints:{bingeGroup:parsed.source}}]});}catch(e){res.status(502).json({streams:[],error:e.message})}});
app.get('/health',(_,res)=>res.json({ok:true,version:VERSION,dramaExpress:false,sources:SOURCES.length}));
app.get('/',(_,res)=>res.type('text').send(`Nuvio public drama addon ${VERSION}. DramaExpress disabled.`));
app.listen(PORT,'0.0.0.0',()=>console.log(`Public drama addon listening on 0.0.0.0:${PORT}`));
