import 'dotenv/config';
import gplay from 'google-play-scraper';
import axios from 'axios';

function normalizeBase(u) {
  if (!u) return '';
  let s = String(u).trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return 'https:' + s;
  return 'https://' + s.replace(/^\/+/, '');
}

const APP_ID  = process.env.ANDROID_APP_ID;
const BASE    = normalizeBase(process.env.WORKER_URL || '');
const FULL    = normalizeBase(process.env.WORKER_IMPORT_URL || '');
const IMPORT_URL = FULL || (BASE ? (BASE + '/api/import/android') : '');

const TOKEN   = process.env.IMPORT_TOKEN;
const PAGES   = Number(process.env.ANDROID_PAGES || 2);
const LANG    = process.env.LANG || 'pt';
const COUNTRY = (process.env.COUNTRY || 'br').toLowerCase();

function toIso(d){ try { return d ? new Date(d).toISOString() : null } catch { return null; } }
function mask(u){ return u ? u.replace(/^(https?):\/\/([^/]+)/i, (_m, p1) => `${p1}://***`) : u; }

if (!APP_ID || !IMPORT_URL || !TOKEN) {
  console.error('Faltam variáveis ANDROID_APP_ID / WORKER_IMPORT_URL ou WORKER_URL / IMPORT_TOKEN');
  console.error({ has_APP_ID: !!APP_ID, has_IMPORT_URL: !!IMPORT_URL, has_TOKEN: !!TOKEN });
  process.exit(1);
}

async function collectAndroid(appId, pages=1){
  const out = [];
  let token = undefined;
  for (let i=0; i<pages; i++){
    const res = await gplay.reviews({
      appId,
      sort: gplay.sort.NEWEST,
      num: 200,
      paginate: true,
      nextPaginationToken: token,
      lang: LANG,
      country: COUNTRY.toUpperCase()
    });
    token = res.nextPaginationToken;
    for (const r of res.data){
      out.push({
        review_id: r.reviewId,
        author: r.userName || null,
        rating: r.score ?? null,
        title: r.title ?? null,
        text: r.text || '',
        version: r.appVersion || null,
        country: COUNTRY,
        lang: LANG,
        review_date: toIso(r.date),
        raw: {
          reviewId: r.reviewId,
          userName: r.userName,
          score: r.score,
          text: r.text,
          date: toIso(r.date),
          appVersion: r.appVersion,
          replyText: r.replyText || null,
          replyDate: toIso(r.replyDate),
          _dev_response_text: r.replyText || null,
          _src: 'google-play-scraper'
        }
      });
    }
    if (!token) break;
  }
  return out;
}

async function run(){
  console.log('Config:', { APP_ID, IMPORT_URL: mask(IMPORT_URL), PAGES, LANG, COUNTRY });
  const rows = await collectAndroid(APP_ID, PAGES);
  console.log('Collected', rows.length, 'android reviews');
  if (!rows.length) { console.log('Nothing to send.'); return; }

  const resp = await axios.post(IMPORT_URL, rows, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  console.log('Importer -> Worker response:', resp.status, resp.data);
}

run().catch(err => { console.error(err?.response?.data || err.message || err); process.exit(1); });
