import 'dotenv/config';
import gplay from 'google-play-scraper';
import axios from 'axios';

const APP_ID = process.env.ANDROID_APP_ID || 'br.com.icatuseguros.appicatu';
const WORKER_URL = process.env.WORKER_IMPORT_URL_ANDROID;
const TOKEN = process.env.IMPORT_TOKEN;

if (!WORKER_URL || !TOKEN) {
  console.error('Missing WORKER_IMPORT_URL_ANDROID or IMPORT_TOKEN in env');
  process.exit(1);
}

async function fetchRecent(num = 200) {
  try {
    return await gplay.reviews({
      appId: APP_ID,
      sort: gplay.sort.NEWEST, // most recent first
      num,
      lang: 'pt-BR',
      country: 'br'
    });
  } catch (e) {
    console.error('Android fetch error:', e?.message || e);
    return [];
  }
}

function mapToWorkerPayload(items) {
  // library returns { data: [...] } sometimes; normalize
  const arr = Array.isArray(items?.data) ? items.data : Array.isArray(items) ? items : [];
  return arr.map(r => ({
    review_id: r.id || r.reviewId,
    author: r.userName || r.user,
    title: r.title,
    text: r.text || r.content,
    rating: r.score || r.rating,
    version: r.appVersion || r.version,
    review_date: r.date ? new Date(r.date).toISOString() : (r.at || null),
    developer_response_text: r.developerComment || null,
    developer_response_at: r.developerCommentLastUpdated || null,
    raw: r
  }));
}

async function run() {
  const recent = await fetchRecent(200);
  if (!recent || (Array.isArray(recent) && !recent.length)) {
    console.log('No Android reviews fetched.');
    return;
  }
  const payload = mapToWorkerPayload(recent);
  const { data } = await axios.post(`${WORKER_URL}?token=${encodeURIComponent(TOKEN)}`, payload, {
    headers: { 'content-type': 'application/json' },
    timeout: 60000
  });
  console.log('Worker import (Android) =>', data);
}

run().catch(err => { console.error(err); process.exit(1); });
