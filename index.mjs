import 'dotenv/config';
import gplay from 'google-play-scraper';
import axios from 'axios';

const APP_ID = process.env.ANDROID_APP_ID;
const WORKER_URL = process.env.WORKER_IMPORT_URL;
const TOKEN = process.env.IMPORT_TOKEN;

async function run() {
  const { data } = await gplay.reviews({
    appId: APP_ID,
    sort: gplay.sort.NEWEST,   // MAIS RECENTES
    num: 200,
    lang: 'pt',
    country: 'br'
  });

  const payload = data.map(r => ({
    review_id: r.id,
    author: r.userName,
    rating: r.score,
    text: r.text,
    version: r.version,
    review_date: r.date ? new Date(r.date).toISOString() : null,
    raw: r
  }));

  const res = await axios.post(WORKER_URL, payload, {
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });

  console.log('enviados:', payload.length, '-> inserted:', res.data.inserted);
}

run().catch(err => {
  console.error('erro:', err.response?.status, err.response?.data || err.message);
  process.exit(1);
});
