import 'dotenv/config';

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

const PAGES   = Number(process.env.IOS_PAGES || 3);
const COUNTRY = (process.env.COUNTRY || process.env.LOCALE || 'br').toLowerCase();
const LANG    = process.env.LANG || 'pt_BR';

if (!APP_ID || !IMPORT_URL || !TOKEN) {
  console.error('Faltam variáveis IOS_APP_ID / WORKER_IMPORT_URL ou WORKER_URL / IMPORT_TOKEN');
  console.error({ has_APP_ID: !!APP_ID, has_IMPORT_URL: !!IMPORT_URL, has_TOKEN: !!TOKEN });
  process.exit(1);
}

const toIso = (d) => { try { return d ? new Date(d).toISOString() : null; } catch { return null; } };
const norm  = (s) => (s || '').toString().replace(/\s+/g,' ').trim();
const lown  = (s) => norm(s).toLowerCase();

/* ---------------- HTML “ver todas” – pega autor, texto, rating, data e resp. do dev -------- */
// === cole no ios-index.mjs no lugar da sua fetchHtmlSeeAllFull ===
async function fetchHtmlSeeAllFull(appId, country = 'br') {
  const url = `https://apps.apple.com/${country}/app/id${appId}?see-all=reviews`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();

  // pega cada card completo
  const cards = html.match(/<we-customer-review[\s\S]*?<\/we-customer-review>/gi) || [];
  const clean = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const out = [];

  for (const card of cards) {
    const author = clean((/we-customer-review__user[^>]*>([^<]+)/i.exec(card) || [])[1]);
    const title  = clean((/we-customer-review__title[^>]*>([\s\S]*?)<\/h3>/i.exec(card) || [])[1]);
    const text   = clean(
      (/we-customer-review__body[^>]*>([\s\S]*?)<\/p>/i.exec(card) || [])[1] ||
      (/<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(card) || [])[1] ||
      ''
    );
    const rMatch = /aria-label="(\d+)(?:[.,]\d+)?\s*(?:de|out of)\s*5"/i.exec(card);
    const rating = rMatch ? parseInt(rMatch[1], 10) : null;

    // data dd/mm/aaaa (BR) ou yyyy-mm-dd
    let review_date = null;
    const dm = /(\d{2})\/(\d{2})\/(\d{4})/.exec(card) || /(\d{4})-(\d{2})-(\d{2})/.exec(card);
    if (dm) {
      if (dm[1].length === 4) review_date = new Date(`${dm[1]}-${dm[2]}-${dm[3]}T00:00:00Z`).toISOString();
      else review_date = new Date(`${dm[3]}-${dm[2]}-${dm[1]}T00:00:00Z`).toISOString();
    }

    // resposta do dev
    const devM = /(Resposta do desenvolvedor|Developer Response)[\s\S]*?(?:<p[^>]*>|<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>)([\s\S]*?)(?:<\/span>|<\/p>)/i.exec(card);
    const dev = clean(devM ? devM[2] : '');

    if (author && (text || title)) {
      out.push({
        platform: 'ios',
        author, title, text, rating, review_date,
        raw: { html: true, _dev_response_text: dev }
      });
    }
  }

  // dedupe interno do HTML
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const map = new Map();
  for (const it of out) {
    const key = `${norm(it.author)}|${norm(it.text || it.title).slice(0,120)}|${(it.review_date||'').slice(0,10)}`;
    if (!map.has(key)) map.set(key, it);
  }

  // debug: imprime os primeiros autores pra conferir que o Vagner veio
  console.log('HTML authors sample:', [...map.values()].slice(0,6).map(x => x.author));

  return [...map.values()];
}

/* ---------------- RSS BR mais recentes (com país no PATH) ---------------------------------- */
async function fetchRssRecent(appId, page=1, country='br') {
  const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
      review_id: rid,
      author, rating, title, text,
      review_date: toIso(date),
      country, lang: LANG,
      raw: { rss: e }
    });
  }
  return rows;
}

// === AMP JSON API (oficial do site) — pega os mais recentes ===
// Tenta sem autenticação. A Apple costuma aceitar com esses headers.
async function fetchAmpReviews(appId, country = 'br', lang = 'pt-BR', limit = 50, offset = 0) {
  const url = `https://amp-api.apps.apple.com/v1/catalog/${country}/apps/${appId}/reviews?l=${encodeURIComponent(lang)}&platform=web&offset=${offset}&limit=${limit}&sort=mostRecent`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Origin': 'https://apps.apple.com',
      'Referer': `https://apps.apple.com/${country}/app/id${appId}`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`AMP ${res.status}`);
  const data = await res.json();
  const arr = Array.isArray(data?.data) ? data.data : [];
  const out = [];
  for (const x of arr) {
    const a = x?.attributes || {};
    out.push({
      platform: 'ios',
      review_id: x?.id || null,                // ótimo para dedupe
      author: a.userName || a.user || null,
      rating: a.rating != null ? Number(a.rating) : null,
      title: a.title || null,
      text: a.review || a.body || '',
      review_date: a.date ? new Date(a.date).toISOString() : (a.createdDate ? new Date(a.createdDate).toISOString() : null),
      country, lang
    });
  }
  return out;
}


/* ---------------- Coletor principal: RSS + HTML (union + dedupe) --------------------------- */
async function collectIOS(appId, pages = 3, country = 'br') {
  // 1) AMP (mais recentes)
  let amp = [];
  try { amp = await fetchAmpReviews(appId, country, 'pt-BR', 50, 0); }
  catch (e) { console.log('AMP fail:', e?.message || e); }

  // 2) RSS (mais recentes)
  const rss = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const pageRows = await fetchRssRecent(appId, p, country);
      if (!pageRows.length) break;
      rss.push(...pageRows);
    } catch (e) {
      if (p === 1) console.error('RSS error page 1:', e?.message || e);
      break;
    }
  }

  // 3) HTML “see-all” (pega resp. do dev e alguns cards)
  let html = [];
  try { html = await fetchHtmlSeeAllFull(appId, country); } catch {}

  // 4) UNION + DEDUPE por assinatura (autor + prefixo texto + dia)
  const norm = s => (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const sig  = r => `${norm(r.author)}|${norm(r.text || r.title).slice(0,120)}|${(r.review_date||'').slice(0,10)}`;
  const bySig = new Map();

  // Ordem importa: preferimos quem tem review_id (AMP/RSS), e injetamos dev_response do HTML
  for (const r of [...amp, ...rss, ...html]) {
    const k = sig(r);
    if (!bySig.has(k)) { bySig.set(k, r); continue; }
    const prev = bySig.get(k);
    if (r.review_id && !prev.review_id) {
      bySig.set(k, { ...r, raw: { ...(r.raw||{}), ...(prev.raw||{}) } });
    } else if ((r.raw||{})._dev_response_text && !(prev.raw||{})._dev_response_text) {
      prev.raw = prev.raw || {};
      prev.raw._dev_response_text = r.raw._dev_response_text;
    }
  }

  const merged = [...bySig.values()];
  console.log(`iOS collected: amp=${amp.length} rss=${rss.length} html=${html.length} merged=${merged.length}`);
  return merged;
}


/* ---------------- Execução ----------------------------------------------------------------- */
async function run() {
  console.log('Config:', { APP_ID, IMPORT_URL, PAGES, COUNTRY });
  const rows = await collectIOS(APP_ID, PAGES, COUNTRY);
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
