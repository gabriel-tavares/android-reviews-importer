// ios-index.mjs — iOS collector (AMP + RSS + HTML)
import 'dotenv/config';

// ------------------- Config -------------------
function normalizeBase(u) {
  if (!u) return '';
  let s = String(u).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  return 'https://' + s.replace(/^\/+/, '');
}

const APP_ID      = process.env.IOS_APP_ID;
const BASE        = normalizeBase(process.env.WORKER_URL || '');
const FULL        = normalizeBase(process.env.WORKER_IMPORT_URL || '');
const IMPORT_URL  = FULL || (BASE ? (BASE + '/api/import/ios') : '');
const TOKEN       = process.env.IMPORT_TOKEN;

const PAGES   = Number(process.env.IOS_PAGES || 5);
const COUNTRY = (process.env.COUNTRY || process.env.LOCALE || 'br').toLowerCase();
const LANG    = process.env.LANG || 'pt-BR';

if (!APP_ID || !IMPORT_URL || !TOKEN) {
  console.error('Faltam variáveis IOS_APP_ID / WORKER_IMPORT_URL ou WORKER_URL / IMPORT_TOKEN');
  console.error({ has_APP_ID: !!APP_ID, has_IMPORT_URL: !!IMPORT_URL, has_TOKEN: !!TOKEN });
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ------------------- Utils -------------------
const toIso = (d) => { try { return d ? new Date(d).toISOString() : null; } catch { return null; } };
const norm  = (s) => (s || '').toString().replace(/\s+/g,' ').trim();
const lown  = (s) => norm(s).toLowerCase();

// ------------------- AMP support -------------------
// Lê widgetKey + storefrontId do HTML (content pode vir com entidades e/ou %encoding)
async function getAppleWebConfig(appId, country = 'br', lang = 'pt-BR') {
  const url = `https://apps.apple.com/${country}/app/id${appId}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': lang } });
  const html = await res.text();

  const m = html.match(/<meta[^>]+name="web-experience-app\/config\/environment"[^>]+content="([^"]+)"/i);
  if (!m) throw new Error('config meta not found');

  let raw = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  if (/^%7B/i.test(raw) || /%22|%7D|%7B/i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch {}
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }

  let cfg;
  try { cfg = JSON.parse(raw); }
  catch { cfg = JSON.parse(JSON.parse(raw)); }

  const widgetKey    = cfg?.APP_STORE_DEFAULTS?.widgetKey ?? cfg?.widgetKey;
  const storefrontId = cfg?.STORE_FRONT?.storefront       ?? cfg?.storefrontId ?? cfg?.storefront;
  if (!widgetKey || !storefrontId) throw new Error('widgetKey/storefrontId not found');
  return { widgetKey, storefrontId };
}

// AMP JSON (mais recentes)
async function fetchAmpReviews(appId, country='br', lang='pt-BR', limit=50, offset=0) {
  const { widgetKey, storefrontId } = await getAppleWebConfig(appId, country, lang);
  const url = `https://amp-api.apps.apple.com/v1/catalog/${country}/apps/${appId}/reviews?l=${encodeURIComponent(lang)}&platform=web&offset=${offset}&limit=${limit}&sort=mostRecent`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Origin': 'https://apps.apple.com',
      'Referer': `https://apps.apple.com/${country}/app/id${appId}`,
      'X-Apple-Widget-Key': widgetKey,
      'X-Apple-Store-Front': storefrontId,
      'Accept-Language': lang
    }
  });
  if (!res.ok) throw new Error(`AMP ${res.status}`);
  const data = await res.json();
  const arr = Array.isArray(data?.data) ? data.data : [];
  return arr.map(x => {
    const a = x?.attributes || {};
    return {
      platform: 'ios',
      review_id: x?.id || null,
      author: a.userName || a.user || null,
      rating: a.rating != null ? Number(a.rating) : null,
      title: a.title || null,
      text: a.review || a.body || '',
      review_date: a.date ? new Date(a.date).toISOString()
               : (a.createdDate ? new Date(a.createdDate).toISOString() : null),
      country, lang,
      raw: { amp: true }
    };
  });
}

// ------------------- RSS (fallback) -------------------
async function fetchRssRecent(appId, page=1, country='br') {
  const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`RSS ${page} ${res.status}`);
  const data = await res.json();
  const entries = Array.isArray(data?.feed?.entry) ? data.feed.entry : [];
  const rows = [];
  for (const e of entries) {
    if (e?.['im:name']) continue; // metadado do app
    const rid    = e?.id?.label || e?.id?.attributes?.['im:id'] || null;
    const author = e?.author?.name?.label || null;
    const rating = e?.['im:rating']?.label ? Number(e['im:rating'].label) : null;
    const title  = e?.title?.label || null;
    const text   = e?.content?.label || null;
    const date   = e?.updated?.label || e?.['im:releaseDate']?.label || null;
    if (!author && !text && !title) continue;
    rows.push({
      platform: 'ios',
      review_id: rid,
      author, rating, title, text,
      review_date: toIso(date),
      country, lang: LANG,
      raw: { rss: true }
    });
  }
  return rows;
}

// ------------------- HTML (resposta do dev + cards renderizados) -------------------
async function fetchHtmlSeeAllFull(appId, country='br') {
  const url = `https://apps.apple.com/${country}/app/id${appId}?see-all=reviews&l=${encodeURIComponent(LANG)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': LANG }});
  const html = await res.text();

  const cards = html.match(/<we-customer-review[\s\S]*?<\/we-customer-review>/gi) || [];
  const clean = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g,' ').trim();
  const out = [];

  for (const card of cards) {
    const author = clean((/we-customer-review__user[^>]*>([^<]+)/i.exec(card) || [])[1]);
    const title  = clean((/we-customer-review__title[^>]*>([\s\S]*?)<\/h3>/i.exec(card) || [])[1]);
    const text   = clean(
      (/we-customer-review__body[^>]*>([\s\S]*?)<\/p>/i.exec(card) || [])[1] ||
      (/<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(card) || [])[1] || ''
    );
    const rMatch = /aria-label="(\d+)(?:[.,]\d+)?\s*(?:de|out of)\s*5"/i.exec(card);
    const rating = rMatch ? parseInt(rMatch[1], 10) : null;

    let review_date = null;
    const dm = /(\d{2})\/(\d{2})\/(\d{4})/.exec(card) || /(\d{4})-(\d{2})-(\d{2})/.exec(card);
    if (dm) {
      if (dm[1].length === 4) review_date = new Date(`${dm[1]}-${dm[2]}-${dm[3]}T00:00:00Z`).toISOString();
      else review_date = new Date(`${dm[3]}-${dm[2]}-${dm[1]}T00:00:00Z`).toISOString();
    }

    const devM = /(Resposta do desenvolvedor|Developer Response)[\s\S]*?(?:<p[^>]*>|<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>)([\s\S]*?)(?:<\/span>|<\/p>)/i.exec(card);
    const dev  = clean(devM ? devM[2] : '');

    if (author && (text || title)) {
      out.push({
        platform: 'ios',
        author, title, text, rating, review_date,
        raw: { html: true, _dev_response_text: dev }
      });
    }
  }

  const key = (r) => `${(r.author||'').toLowerCase()}|${(r.text||r.title||'').toLowerCase().slice(0,120)}|${(r.review_date||'').slice(0,10)}`;
  const map = new Map();
  for (const it of out) { const k = key(it); if (!map.has(k)) map.set(k, it); }
  return [...map.values()];
}

// ------------------- Coleta + merge/dedupe -------------------
async function collectIOS(appId, pages=5, country='br') {
  let amp = [];
  try { amp = await fetchAmpReviews(appId, country, LANG, 50, 0); }
  catch (e) { console.log('AMP fail:', e?.message || e); }

  const rss = [];
  for (let p=1; p<=pages; p++) {
    try {
      const pageRows = await fetchRssRecent(appId, p, country);
      if (!pageRows.length) break;
      rss.push(...pageRows);
    } catch (e) {
      if (p === 1) console.error('RSS error page 1:', e?.message || e);
      break;
    }
  }

  let html = [];
  try { html = await fetchHtmlSeeAllFull(appId, country); } catch {}

  const sig = (r) => `${lown(r.author)}|${lown(r.text || r.title).slice(0,120)}|${(r.review_date||'').slice(0,10)}`;
  const bySig = new Map();

  for (const r of [...amp, ...rss, ...html]) {
    const k = sig(r);
    if (!bySig.has(k)) { bySig.set(k, r); continue; }
    const prev = bySig.get(k);
    if (r.review_id && !prev.review_id) {
      const merged = { ...r, raw: { ...(r.raw||{}), ...(prev.raw||{}) } };
      bySig.set(k, merged);
    } else if ((r.raw||{})._dev_response_text && !(prev.raw||{})._dev_response_text) {
      prev.raw = prev.raw || {};
      prev.raw._dev_response_text = r.raw._dev_response_text;
    }
  }

  const merged = [...bySig.values()];
  console.log(`iOS collected: amp=${amp.length} rss=${rss.length} html=${html.length} merged=${merged.length} country=${country}`);
  return merged;
}

// ------------------- Execução -------------------
async function run() {
  console.log('Config:', { APP_ID, IMPORT_URL, PAGES, COUNTRY });
  const rows = await collectIOS(APP_ID, PAGES, COUNTRY);
  if (!rows.length) { console.log('Nothing to send.'); return; }
  const resp = await fetch(IMPORT_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}', 'Content-Type': 'application/json' },
    body: JSON.stringify(rows)
  });
  const data = await resp.json().catch(()=> ({}));
  console.log('Importer -> Worker response:', resp.status, data);
}

run().catch(err => { console.error(err?.response?.data || err.message || err); process.exit(1); });
