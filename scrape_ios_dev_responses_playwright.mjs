// Coleta "Resposta do desenvolvedor" na App Store (BR/US/etc) usando Playwright.
// Uso:
//   node scripts/scrape_ios_dev_responses_playwright.mjs --app 1667555669 --country br --limit 400 --out ios_dev_responses.json
//
// Saída: JSON com [{ author, date, title, text, rating, dev_response_text }]

import { chromium } from 'playwright';

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const APP = arg('app', process.env.IOS_APP_ID);
const COUNTRY = (arg('country', 'br') || 'br').toLowerCase();
const LIMIT = parseInt(arg('limit', '400'), 10);
const OUT = arg('out', 'ios_dev_responses.json');

if (!APP) {
  console.error('Missing --app (or IOS_APP_ID env)');
  process.exit(1);
}

const BASE = `https://apps.apple.com/${COUNTRY}/app/id${APP}?see-all=reviews`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0',
    locale: COUNTRY === 'br' ? 'pt-BR' : 'en-US'
  });
  const page = await ctx.newPage();

  console.log('Opening:', BASE);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Aceitar cookies (best-effort)
  try {
    const btn = await page.$('button:has-text("Aceitar"), button:has-text("Accept all"), button:has-text("Accept")');
    if (btn) await btn.click({ timeout: 2000 });
  } catch {}

  // Aguarda render
  await page.waitForTimeout(3000);

  // Rolagem para carregar + reviews
  let rounds = 0;
  const maxRounds = Math.max(5, Math.ceil(LIMIT / 80));
  while (rounds++ < maxRounds) {
    await page.mouse.wheel(0, 12000);
    await page.waitForTimeout(1200);

    const loadMore = await page.$('button:has-text("Carregar mais"), button:has-text("Load more")');
    if (loadMore) {
      try { await loadMore.click({ timeout: 3000 }); await page.waitForTimeout(2000); } catch {}
    }
  }

  // Expande "mais" nas respostas do dev
  const moreBtns = await page.$$('a:has-text("mais"), button:has-text("mais"), a:has-text("more"), button:has-text("more")');
  for (const b of moreBtns) {
    try {
      const txt = (await b.innerText()).toLowerCase();
      if (/(mais|more)/.test(txt)) await b.click({ timeout: 1000 });
    } catch {}
  }
  await page.waitForTimeout(1000);

  // Coleta review cards com "Resposta do desenvolvedor"
  const items = await page.$$eval('article, div[data-test-we-customer-review], .we-customer-review, section', (els) => {
    const out = [];
    const seen = new Set();

    const parseCard = (el) => {
      const text = el.innerText || '';
      if (!/(Resposta do desenvolvedor|Developer Response)/i.test(text)) return null;

      const author = el.querySelector('[data-test-user-name]')?.innerText?.trim()
                   || el.querySelector('.we-customer-review__user')?.innerText?.trim()
                   || null;

      let date = null;
      const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})/);
      if (dateMatch) date = dateMatch[1];

      const title = el.querySelector('[data-test-review-title], h3')?.innerText?.trim()
                  || el.querySelector('.we-customer-review__title')?.innerText?.trim()
                  || null;

      const body = el.querySelector('[data-test-review-body], blockquote, .we-customer-review__body')?.innerText?.trim()
                  || null;

      const ratingStr = el.querySelector('[aria-label*="estrelas"], [aria-label*="stars"]')?.getAttribute('aria-label') || '';
      let rating = null;
      const r1 = ratingStr.match(/(\d+(?:[.,]\d+)?)/);
      if (r1) rating = Number((r1[1] || '').replace(',', '.'));

      let dev = null;
      const labelIdx = text.search(/Resposta do desenvolvedor|Developer Response/i);
      if (labelIdx >= 0) {
        dev = text.slice(labelIdx).replace(/^(Resposta do desenvolvedor|Developer Response)\s*,?\s*/i, '').trim();
      }
      dev = (dev || '').replace(/\bmais\b\s*$/i, '').trim();

      if (!dev) return null;

      return { author, date, title, text: body, rating, dev_response_text: dev };
    };

    for (const el of els) {
      const t = el.innerText || '';
      if (!/(Resposta do desenvolvedor|Developer Response)/i.test(t)) continue;

      const nodeText = t.replace(/\s+/g, ' ').trim();
      if (seen.has(nodeText)) continue;
      seen.add(nodeText);

      const row = parseCard(el);
      if (row && row.dev_response_text) out.push(row);
    }
    return out;
  });

  await browser.close();

  const fs = await import('node:fs');
  fs.writeFileSync(OUT, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`Saved ${items.length} items to ${OUT}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
