import 'dotenv/config';
import store from 'app-store-scraper';
import axios from 'axios';
import * as cheerio from 'cheerio';

const APP_ID = process.env.IOS_APP_ID || '1667555669';
const WORKER_URL = process.env.WORKER_IMPORT_URL_IOS;
const TOKEN = process.env.IMPORT_TOKEN;
if (!WORKER_URL || !TOKEN) {
  console.error('Missing WORKER_IMPORT_URL_IOS or IMPORT_TOKEN in env');
  process.exit(1);
}

// ---- helpers
const norm = s => (s ?? '').toString().normalize('NFKC').replace(/\s+/g,' ').trim();
const uniqueBy = (arr, keyFn) => {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
};

function mapToWorkerPayload(items) {
  return items.map(r => ({
    review_id: r.id || r.reviewId || r._id || null,
    author: r.userName || r.user || r.author || null,
    title: r.title || null,
    text: r.text || r.content || r.body || null,
    rating: r.score || r.rating || null,
    review_date: r.date ? new Date(r.date).toISOString()
                : r.reviewDate ? new Date(r.reviewDate).toISOString()
                : r.dateISO || null,
    developer_response: r.developerResponse || null,
    developer_response_text: r.developerResponse?.text || r.developerComment || null,
    developer_response_at: r.developerResponse?.lastModified || r.developerCommentLastUpdated || null,
    raw: r
  })).filter(x => x.author && x.text); // sanity filter
}

// ---- 1) API via app-store-scraper (RECENT + HELPFUL, varias páginas)
async function fetchViaLibrary() {
  const all = [];
  const sorts = [store.sort.RECENT, store.sort.HELPFUL];
  for (const s of sorts) {
    for (let page = 0; page < 6; page++) {  // até ~300 itens por sort
      try {
        const res = await store.reviews({
          id: APP_ID,
          sort: s,
          page,
          num: 100,
          country: 'br',
          lang: 'pt-BR'
        });
        if (!Array.isArray(res) || res.length === 0) break;
        all.push(...res);
        if (res.length < 50) break; // a lib costuma paginar em blocos
      } catch (e) {
        console.warn('iOS lib fetch error (page', page, 'sort', s, '):', e?.message || e);
        break;
      }
    }
  }
  return uniqueBy(all, r => `${r.id}|${norm(r.userName)}|${norm(r.title)}|${norm(r.text).slice(0,60)}`);
}

// ---- 2) Fallback HTML (App Store Preview)
async function fetchViaHTML() {
  const url = `https://apps.apple.com/br/app/id${APP_ID}?see-all=reviews`;
  try {
    const { data: html } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
      timeout: 60000
    });
    const $ = cheerio.load(html);
    const items = [];
    $('.we-customer-review').each((_, el) => {
      const author = norm($(el).find('.we-customer-review__user').text());
      const title  = norm($(el).find('.we-customer-review__title').text());
      const text   = norm($(el).find('.we-clamp').text());
      const timeEl = $(el).find('time');
      const dtISO  = timeEl.attr('datetime') || null;
      const ratingAria = $(el).find('.we-star-rating').attr('aria-label') || '';
      const match = ratingAria.match(/(\d+)/);
      const rating = match ? parseInt(match[1],10) : null;
      if (author && text) {
        items.push({
          id: `${author}|${title}|${dtISO||''}`,
          userName: author,
          title,
          text,
          score: rating,
          date: dtISO ? new Date(dtISO) : null
        });
      }
    });
    return items;
  } catch (e) {
    console.warn('iOS HTML fallback error:', e?.message || e);
    return [];
  }
}

async function run() {
  let lib = await fetchViaLibrary();
  console.log('iOS library fetched:', lib.length);
  let all = lib;
  if (all.length === 0) {
    const html = await fetchViaHTML();
    console.log('iOS HTML fallback fetched:', html.length);
    all = html;
  } else if (all.length < 20) {
    // completa com HTML para garantir últimos cards visíveis no Preview
    const html = await fetchViaHTML();
    console.log('iOS HTML extra fetched:', html.length);
    all = uniqueBy([...all, ...html], r => `${norm(r.userName)}|${norm(r.title)}|${norm(r.text).slice(0,80)}`);
  }
  if (!all.length) {
    console.log('No iOS reviews fetched (library + HTML fallback empty).');
    return;
  }
  const payload = mapToWorkerPayload(all);
  // log rápido para debug: lista autores recentes
  const sample = payload.slice(0, 10).map(x => x.author);
  console.log('iOS payload size:', payload.length, 'sample authors:', sample);

  const { data } = await axios.post(`${WORKER_URL}?token=${encodeURIComponent(TOKEN)}`, payload, {
    headers: { 'content-type': 'application/json' },
    timeout: 60000
  });
  console.log('Worker import (iOS) =>', data);
}

run().catch(err => { console.error(err); process.exit(1); });
