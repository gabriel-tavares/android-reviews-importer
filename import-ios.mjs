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

const normISO = (v) => {
  if (!v) return null;
  try { return new Date(v).toISOString(); } catch (_) { return null; }
};

function mapToWorkerPayload(items) {
  return items.map(r => {
    const dt = r.date || r.updated || r.reviewDate || r.dateISO;
    return {
      review_id: r.id,
      author: r.userName,
      title: r.title,
      text: r.text,
      rating: r.score,
      review_date: normISO(dt) || normISO(Date.now()),
      developer_response_text: r.developerResponse?.text || null,
      developer_response_at: r.developerResponse?.lastModified || null,
      raw: { id: r.id, version: r.version, updated: r.updated || dt } // RAW enxuto
    };
  });
}

async function fetchRecent() {
  const res = await store.reviews({
    id: APP_ID,
    sort: store.sort.RECENT,
    page: 0,
    num: 200,
    country: 'br',
    lang: 'pt-BR'
  });
  return res;
}

async function run() {
  const recent = await fetchRecent();
  console.log('iOS library fetched:', recent?.length || 0);
  const payload = mapToWorkerPayload(recent || []);
  console.log('iOS payload size:', payload.length, 'sample authors:', payload.slice(0,10).map(x => x.author));
  const { data } = await axios.post(`${WORKER_URL}?token=${encodeURIComponent(TOKEN)}`, payload, {
    headers: { 'content-type': 'application/json' },
    timeout: 60000
  });
  console.log('Worker import (iOS) =>', data);
}

run().catch(err => { console.error(err); process.exit(1); });
