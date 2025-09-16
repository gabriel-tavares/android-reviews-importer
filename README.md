# Reviews Importer Kit (Android + iOS)

Este kit busca as avaliações mais recentes nas lojas e envia para o seu Worker (`/api/import/android` e `/api/import/ios`). 
Ele resolve o problema de "review novo não aparece" garantindo **ordem por mais recentes** e mapeamento de campos coerente com o seu Worker.

## 1) Instalação
```bash
npm i
cp .env.example .env
# edite .env com as URLs do Worker e o IMPORT_TOKEN
```

## 2) Rodar local
```bash
node import-ios.mjs
node import-android.mjs
```

## 3) GitHub Actions (hora em hora)
Use o workflow incluso (abaixo) e defina os *Secrets*:
- `IMPORT_TOKEN`
- `WORKER_IMPORT_URL_IOS`
- `WORKER_IMPORT_URL_ANDROID`
- (opcionais) `ANDROID_APP_ID`, `IOS_APP_ID`

## 4) Teste rápido (iOS — caso Vagner Schmitz)
Se quiser testar manualmente a chegada do review do **Vagner Schmitz**, rode um `curl` (ajuste o token/URL):
```bash
curl -X POST "$WORKER_IMPORT_URL_IOS?token=$IMPORT_TOKEN"     -H "content-type: application/json"     -d '[{
    "author":"Vagner Schmitz",
    "title":"Necessidade de iOS 17.6 não faz sentido",
    "text":"Aplicativo simples, sem processamento. Não faz sentido exigir iOS 17.6 ou superior…",
    "rating": 1,
    "review_date": "2025-09-12T00:00:00.000Z"
  }]'
```
Depois consulte:
`GET /api/reviews?platform=ios&q=Vagner`

## 5) Dicas de diagnóstico
- Se a resposta do import for `empty-payload`, o scraper falhou em buscar os itens.
- Se `inserted=0, updated>0` significa que os itens já existiam e foram atualizados/normalizados.
- Logs do Worker mostram erros de schema/índices. O Worker esperado cria/ajusta as tabelas na primeira chamada.
