// === HTML: captura autor, título, texto, rating, data e resposta do dev ===
async function fetchHtmlSeeAllFull(appId, country = 'br') {
  const url = `https://apps.apple.com/${country}/app/id${appId}?see-all=reviews`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await res.text();

  const blocks = html.split(/we-customer-review(?:__|-)body/gi);
  const out = [];

  const get = (re, s) => {
    const m = re.exec(s);
    return m ? m[1] : null;
  };
  const clean = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  for (const chunk of blocks) {
    const author = clean(get(/we-customer-review__user[^>]*>([^<]+)/i, chunk) || '');
    const title  = clean(get(/we-customer-review__title[^>]*>([\s\S]*?)<\/h3>/i, chunk) || '');
    const text   = clean(get(/<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>/i, chunk) ||
                         get(/<p[^>]*>([\s\S]*?)<\/p>/i, chunk) || '');

    // rating: tenta aria-label="2 de 5" (ou "2,0 de 5")
    let rating = null;
    const mR = /aria-label="(\d+)(?:[.,]\d+)?\s*de\s*5"/i.exec(chunk);
    if (mR) rating = parseInt(mR[1], 10);

    // data: pega dd/mm/aaaa que aparece junto do autor
    let review_date = null;
    const mD = /(\d{2})\/(\d{2})\/(\d{4})/.exec(chunk);
    if (mD) {
      const [, dd, mm, yyyy] = mD;
      review_date = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`).toISOString();
    }

    // resposta do dev
    let dev = null;
    const devBlock = /(Resposta do desenvolvedor|Developer Response)[\s\S]*?(<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>|<p[^>]*>([\s\S]*?)<\/p>)/i.exec(chunk);
    if (devBlock) {
      const g = /<span[^>]*class="[^"]*we-clamp[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(devBlock[0]) ||
                /<p[^>]*>([\s\S]*?)<\/p>/i.exec(devBlock[0]);
      if (g) dev = clean(g[1]);
    }

    if (author && (text || title)) {
      out.push({
        platform: 'ios',
        author,
        title,
        text,
        rating,
        review_date,
        raw: { html: true, _dev_response_text: dev }
      });
    }
  }
  // dedupe bruto dentro do HTML
  const map = new Map();
  for (const it of out) {
    const key = `${it.author.toLowerCase()}|${it.text.toLowerCase().slice(0,120)}|${(it.review_date||'').slice(0,10)}`;
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

// === Coletor principal: RSS + HTML (union + dedupe por assinatura) ===
async function collectIOS(appId, pages = 3, country = 'br') {
  // 1) RSS (mais recentes) — loja certa com país no PATH
  const rssRows = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${p}/id=${appId}/sortby=mostrecent/json`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`RSS ${p} ${res.status}`);
      const data = await res.json();
      const entries = Array.isArray(data?.feed?.entry) ? data.feed.entry : [];

      for (const e of entries) {
        if (e?.['im:name']) continue; // pula metadado do app
        const rid    = e?.id?.label || e?.id?.attributes?.['im:id'] || null;
        const author = e?.author?.name?.label || null;
        const rating = e?.['im:rating']?.label ? Number(e['im:rating'].label) : null;
        const title  = e?.title?.label || null;
        const text   = e?.content?.label || null;
        const date   = e?.updated?.label || e?.['im:releaseDate']?.label || null;

        if (!author && !text && !title) continue;

        rssRows.push({
          review_id: rid,
          author, rating, title, text,
          review_date: date ? new Date(Date.parse(date)).toISOString() : null,
          country, lang: LANG,
          raw: { rss: e }
        });
      }

      if (!entries.length) break;
    } catch (e) {
      if (p === 1) console.error('RSS error page 1:', e?.message || e);
      break;
    }
  }

  // 2) HTML completo (para cobrir casos que o RSS não traz)
  let htmlRows = [];
  try { htmlRows = await fetchHtmlSeeAllFull(appId, country); } catch {}

  // 3) UNION + DEDUPE por assinatura (autor + prefixo texto + dia)
  const norm = (s) => (s||'').toString().toLowerCase().replace(/\s+/g, ' ').trim();
  const sig  = (r) => `${norm(r.author)}|${norm(r.text).slice(0,120)}|${(r.review_date||'').slice(0,10)}`;

  const bySig = new Map();

  // Preferir RSS (tem review_id); copiar dev do HTML quando existir
  for (const r of [...rssRows, ...htmlRows]) {
    const k = sig(r);
    if (!bySig.has(k)) { bySig.set(k, r); continue; }

    const prev = bySig.get(k);
    // se este tem review_id e o anterior não, substitui, preservando dev_response_text
    if (r.review_id && !prev.review_id) {
      const merged = { ...r, raw: { ...(r.raw||{}) } };
      if (prev.raw?._dev_response_text && !merged.raw?._dev_response_text) {
        merged.raw._dev_response_text = prev.raw._dev_response_text;
      }
      bySig.set(k, merged);
    } else {
      // só injeta dev_response_text se ainda não tiver
      const dev = r.raw?._dev_response_text;
      if (dev && !(prev.raw||{})._dev_response_text) {
        prev.raw = prev.raw || {};
        prev.raw._dev_response_text = dev;
      }
    }
  }

  const merged = [...bySig.values()];
  console.log(`iOS collected: rss=${rssRows.length} html=${htmlRows.length} merged=${merged.length}`);
  return merged;
}
