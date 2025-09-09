// index.mjs
import 'dotenv/config';
import gplay from 'google-play-scraper';
import axios from 'axios';

const APP_ID       = process.env.ANDROID_APP_ID;
const WORKER_URL   = process.env.WORKER_IMPORT_URL; // .../api/import/android
const TOKEN        = process.env.IMPORT_TOKEN;
const MAX_REVIEWS  = Number(process.env.MAX_REVIEWS || 160);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchAllReviews() {
  const out = [];
  let next = undefined;

  while (out.length < MAX_REVIEWS) {
    const resp = await gplay.reviews({
      appId: APP_ID,
      sort: gplay.sort.NEWEST,
      num: 40,                 // por página
      paginate: true,
      nextPaginationToken: next,
      throttle: 10,            // reduz paralelismo interno da lib
      requestOptions: {        // evita estourar em 30s
        timeout: { request: 120000 }  // 120s
      },
      lang: 'pt', country: 'br'
    });

    // a lib pode devolver array OU {data, nextPaginationToken}
    const pageData = Array.isArray(resp) ? resp : resp.data;
    out.push(...pageData);

    next = Array.isArray(resp) ? undefined : resp.nextPaginationToken;
    if (!next) break;

    // backoff leve entre páginas
    await sleep(1500 + Math.random() * 1500);
  }

  return out.slice(0, MAX_REVIEWS);
}

function normalize(rows) {
  return rows
    .map(r => ({
      // campos com fallback para variações da lib
      review_id: r.reviewId || r.id,
      author: r.userName || r.author || null,
      rating: r.score ?? r.rating ?? null,
      title: r.title || null,
      text: r.text || '',
      version: r.reviewCreatedVersion || r.version || null,
      review_date: r.date ? new Date(r.date).toISOString() : null,
      raw: r,
    }))
    .filter(x => x.review_id && x.text);
}

async function postWithRetry(url, body, headers, attempts = 4) {
  let delay = 1500;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await axios.post(url, body, {
        headers,
        timeout: 120000,                // 120s no POST
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: (s) => s >= 200 && s < 500  // deixa ver mensagens de erro
      });
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data || err.message;
      console.log(`POST attempt ${i} failed${status ? ` (${status})` : ''}: ${msg}`);
      if (i === attempts) throw err;
      await sleep(delay + Math.random() * 500);
      delay *= 2;
    }
  }
}

async function run() {
  if (!APP_ID || !WORKER_URL || !TOKEN) {
    console.error('Faltam variáveis ANDROID_APP_ID / WORKER_IMPORT_URL / IMPORT_TOKEN');
    process.exit(1);
  }

  console.log('Fetching reviews from Google Play…');
  const rows = await fetchAllReviews();
  console.log(`Fetched ${rows.length} raw reviews`);

  const payload = normalize(rows);
  console.log(`Normalized ${payload.length} reviews`);

  const res = await postWithRetry(
    WORKER_URL,
    payload,
    { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
  );

  console.log(`POST ${WORKER_URL} -> ${res.status}`, res.data);
  if (res.status >= 400) process.exit(1);
}

run().catch(err => {
  console.error('Fatal:', err.response?.status, err.response?.data || err.message);
  process.exit(1);
});
