import 'dotenv/config';
import gplay from 'google-play-scraper';
import fetch from 'node-fetch';

const APP_ID = process.env.ANDROID_APP_ID;
const IMPORT_URL = process.env.IMPORT_URL;     // .../api/import/android
const IMPORT_TOKEN = process.env.IMPORT_TOKEN; // Bearer

const MAX = 120; // quantos reviews
const rows = [];

let nextPaginationToken = undefined;
while (rows.length < MAX) {
  const page = await gplay.reviews({
    appId: APP_ID,
    sort: gplay.sort.NEWEST,
    num: 40,                  // por página
    paginate: true,
    nextPaginationToken,
    throttle: 10,             // reduz concorrência interna
    requestOptions: {         // <<< AQUI resolve o timeout de 30s
      timeout: { request: 120000 } // 120s
    }
  });

  rows.push(...page.data);
  if (!page.nextPaginationToken) break;
  nextPaginationToken = page.nextPaginationToken;
  await new Promise(r => setTimeout(r, 1500 + Math.random()*1500)); // backoff suave
}

// normaliza o shape que o Worker espera
const payload = rows.map(r => ({
  review_id: r.reviewId,
  author: r.userName,
  rating: r.score,
  title: r.title || null,
  text: r.text || '',
  version: r.reviewCreatedVersion || null,
  date: r.date ? new Date(r.date).toISOString() : null
}));

const resp = await fetch(IMPORT_URL, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${IMPORT_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(payload)
});
const txt = await resp.text();
console.log('POST /api/import/android', resp.status, txt);
if (!resp.ok) process.exit(1);
  process.exit(1);
});

