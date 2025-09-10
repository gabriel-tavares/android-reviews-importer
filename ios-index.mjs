import 'dotenv/config';

function normalizeBase(u) {
  if (!u) return '';
  let s = String(u).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  return 'https://' + s.replace(/^\/+/, '');
}

const APP_ID  = process.env.IOS_APP_ID;
const BASE    = normalizeBase(process.env.WORKER_URL || '');
const FULL    = normalizeBase(process.env.WORKER_IMPORT_URL || '');
const IMPORT_URL = FULL || (BASE ? (BASE + '/api/import/ios') : '');

const TOKEN   = process.env.IMPORT_TOKEN;
const PAGES   = Number(process.env.IOS_PAGES || 3);
const LOCALE  = (process.env.LOCALE || 'br').toLowerCase(); // e.g., br
const LANG    = process.env.LANG || 'pt_BR';
const COUNTRY = (process.env.COUNTRY || 'br').toLowerCase();

if (!APP_ID || !IMPORT_URL || !TOKEN) {
  console.error('Faltam variáveis IOS_APP_ID / WORKER_IMPORT_URL ou WORKER_URL / IMPORT_TOKEN');
  console.error({ has_APP_ID: !!APP_ID, has_IMPORT_URL: !!IMPORT_URL, has_TOKEN: !!TOKEN });
  process.exit(1);
}

function toIso(d){ try { return d ? new Date(d).toISOString() : null } catch { return null; } }
function norm(s){ return (s || '').toString().replace(/\s+/g,' ').trim(); }
function stripTags(t){ return t ? t.replace(/<[^>]+>/g, '') : ''; }
function startsWithLoose(a,b){ a=norm(a).toLowerCase(); b=norm(b).toLowerCase(); if(!a||!b) return false; return a.startsWith(b) || b.startsWith(a) || a.includes(b.slice(0,30)) || b.includes(a.slice(0,30)); }

async function fetchRssPage(appId, page=1, locale='br'){
  const url = `https://itunes.apple.com/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json?l=pt&cc=${locale}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`RSS ${page} ${res.status}`);
  const data = await res.json();
  const entries = Array.isArray(data?.feed?.entry) ? data.feed.entry : [];
  const out = [];
  // first entry can be app metadata; skip if doesn't have review fields
  for (const e of entries){
    const hasReview = e?.content?.label || e?.title?.label;
    if (!hasReview) continue;
    const rid = e?.id?.label || e?.id?.attributes?.['im:id'] || null;
    const author = e?.author?.name?.label || null;
    const rating = e?.['im:rating']?.label ? Number(e['im:rating'].label) : null;
    const title = e?.title?.label || null;
    const text = e?.content?.label || null;
    const date = e?.updated?.label || e?.['im:voteSum']?.label || null;

    out.push({
      review_id: rid,
      author,
      rating,
      title,
      text,
      review_date: toIso(date),
      country: locale,
      lang: LANG,
      raw: { rss: e }
    });
  }
  return out;
}

async function fetchHtmlSeeAll(appId, locale='br'){
  const url = `https://apps.apple.com/${locale}/app/id${appId}?see-all=reviews`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }});
  const html = await res.text();
  // Heurística: capturar blocos com texto do review e resposta do dev
  const blocks = html.split(/we-customer-review(_|-)body/gi);
  const items = [];
  for (const chunk of blocks){
    const userMatch = chunk.match(/we-customer-review__user[^>]*>([^<]+)/i);
    const textMatch = chunk.match(/<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const devBlock = chunk.match(/(Resposta do desenvolvedor|Developer Response)[\s\S]*?(<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>|<p[^>]*>([\s\S]*?)<\/p>)/i);
    const author = userMatch ? norm(stripTags(userMatch[1])) : null;
    const text = textMatch ? norm(stripTags(textMatch[1])) : null;
    let dev = null;
    if (devBlock) {
      const g = devBlock[0].match(/<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || devBlock[0].match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (g) dev = norm(stripTags(g[1]));
    }
    if (author && (text || dev)) items.push({ author, text, dev });
  }
  // dedup
  const map = new Map();
  for (const it of items) {
    const key = `${it.author}|${it.text||''}`.toLowerCase();
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

function mergeDevReplies(rssRows, htmlEntries){
  const out = rssRows.map(r => ({...r}));
  for (const r of out){
    const author = r.author;
    const text = r.text || r.title || '';
    const hit = htmlEntries.find(e => e.author.toLowerCase() === (author||'').toLowerCase() && startsWithLoose(e.text||'', text));
    if (hit && hit.dev) {
      r.raw = r.raw || {};
      r.raw._dev_response_text = hit.dev;
    }
  }
  return out;
}

async function collectIOS(appId, pages=3, locale='br'){
  const rssRows = [];
  for (let p=1; p<=pages; p++) {
    try {
      const rows = await fetchRssPage(appId, p, locale);
      if (!rows.length) break;
      rssRows.push(...rows);
    } catch (e) {
      if (p===1) console.error('RSS error page 1:', e?.message || e);
      break;
    }
  }
  let htmlEntries = [];
  try { htmlEntries = await fetchHtmlSeeAll(appId, locale); } catch {}
  const merged = mergeDevReplies(rssRows, htmlEntries);
  return merged;
}

async function run(){
  console.log('Config:', { APP_ID, IMPORT_URL, PAGES, LOCALE });
  const rows = await collectIOS(APP_ID, PAGES, LOCALE);
  console.log('Collected', rows.length, 'ios reviews');
  if (!rows.length) { console.log('Nothing to send.'); return; }
  const resp = await fetch(IMPORT_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(rows)
  });
  const data = await resp.json().catch(()=> ({}));
  console.log('Importer -> Worker response:', resp.status, data);
}

run().catch(err => { console.error(err?.response?.data || err.message || err); process.exit(1); });
