import 'dotenv/config';
import store from 'app-store-scraper';
import axios from 'axios';

const APP_ID = process.env.IOS_APP_ID || '1667555669';
const WORKER_URL = process.env.WORKER_IMPORT_URL_IOS;
const TOKEN = process.env.IMPORT_TOKEN;

if (!WORKER_URL || !TOKEN) {
  console.error('Missing WORKER_IMPORT_URL_IOS or IMPORT_TOKEN in env');
  process.exit(1);
}

async function fetchRecent(page = 0, num = 200) {
  // Try to fetch the most recent 200 reviews (app-store-scraper paginates 50/100 per page).
  try {
    const res = await store.reviews({
      id: APP_ID,
      sort: store.sort.RECENT,
      page,            // page index (0..n)
      num,             // requested items (lib will handle per-page internally)
      country: 'br',
      lang: 'pt-BR'
    });
    return res;
  } catch (e) {
    console.error('iOS fetch error:', e?.message || e);
    return [];
  }
}

function mapToWorkerPayload(items) {
  return items.map(r => ({
    // fields expected by the Worker
    review_id: r.id,
    author: r.userName,
    title: r.title,
    text: r.text,
    rating: r.score,
    // dates: library gives Date; worker accepts ISO string
    review_date: r.date ? new Date(r.date).toISOString() : null,
    // developer response (if any)
    developer_response: r.developerResponse || null,
    developer_response_text: r.developerResponse?.text || null,
    developer_response_at: r.developerResponse?.lastModified || null,
    raw: r
  }));
}

async function run() {
  const recent = await fetchRecent(0, 200);
  if (!recent?.length) {
    console.log('No iOS reviews fetched.');
    return;
  }
  const payload = mapToWorkerPayload(recent);
  const { data } = await axios.post(`${WORKER_URL}?token=${encodeURIComponent(TOKEN)}`, payload, {
    headers: { 'content-type': 'application/json' },
    timeout: 60000
  });
  console.log('Worker import (iOS) =>', data);
}

run().catch(err => { console.error(err); process.exit(1); });
