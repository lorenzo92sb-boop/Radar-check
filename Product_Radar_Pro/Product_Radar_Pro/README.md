# Product Radar Pro

Versione potenziata del prototipo product-centric.

## Cosa cambia rispetto alla versione portable
Questa versione non si limita a una singola ricerca HTML. Combina:

- più query generate automaticamente;
- più motori di ricerca;
- ricerca mirata su domini retailer;
- Brave Search API, se configurata;
- Google tramite Serper, se configurato;
- DuckDuckGo e Bing come fallback;
- parsing di Schema.org / JSON-LD dei prodotti;
- estrazione di prezzi, prezzo/kg, formato, promo, disponibilità, marca, SKU/GTIN;
- browser Chromium headless con Playwright per i siti caricati via JavaScript;
- deduplicazione;
- filtri di esclusione;
- storico delle ricerche;
- esportazione Excel.

## Importante
Per essere potente e non richiedere installazioni sul PC dell'utente, questa applicazione va pubblicata su un server/cloud.
Una volta pubblicata si usa semplicemente da browser.

## Prestazioni
Con `maxPages=50` e `browserPages=25`, una ricerca può richiedere circa 1–3 minuti.
Aumentare i valori migliora la copertura ma aumenta tempi e consumo di risorse.

## Motori di ricerca
Senza chiavi API usa Bing e DuckDuckGo come fallback.

Per aumentare molto la copertura, configurare almeno:
- `BRAVE_API_KEY`
- oppure `SERPER_API_KEY`

Se sono presenti entrambe, vengono usate insieme agli altri provider.

## Deploy Docker
Il progetto include un `Dockerfile`.
Qualsiasi piattaforma che esegue container Docker può ospitarlo.

Variabili ambiente:
- `BRAVE_API_KEY`
- `SERPER_API_KEY`
- `CRON_SECRET`

## Render
È incluso anche `render.yaml`.
Il deploy richiede un account Render e un repository Git.

Nota: per mantenere lo storico in modo permanente, associare un disco persistente o sostituire `data/history.jsonl` con PostgreSQL.

## Uso
1. Apri l'URL dell'app.
2. Inserisci il prodotto.
3. Aggiungi alias, se utili.
4. Inserisci parole da escludere.
5. Eventualmente aggiungi domini retailer prioritari.
6. Premi **AVVIA RICERCA POTENZIATA**.
7. Controlla i risultati.
8. Esporta in Excel.

## Limitazioni reali
Nessun crawler può garantire il 100% del web:
- alcuni retailer richiedono CAP, login o selezione del punto vendita;
- alcuni usano protezioni anti-bot;
- prezzi e assortimenti possono cambiare per località;
- alcune pagine non sono indicizzate dai motori;
- alcune condizioni d'uso vietano o limitano lo scraping.

Per i retailer strategici, la soluzione più affidabile resta aggiungere connettori dedicati/API ufficiali dove disponibili.
