import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pLimit from "p-limit";
import XLSX from "xlsx";

import { buildAliases, buildQueries, normalizeText } from "./lib/query.js";
import { multiSearch, testSerper } from "./lib/searchProviders.js";
import { analyzeResult } from "./lib/extract.js";
import { appendRun, readHistory } from "./lib/history.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function canonical(url = "") {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function dedupeRoundRobin(batches, maxItems) {
  const out = [];
  const seen = new Set();
  let index = 0;

  while (out.length < maxItems) {
    let added = false;
    for (const batch of batches) {
      const item = batch[index];
      if (!item) continue;
      const key = canonical(item.url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      added = true;
      if (out.length >= maxItems) break;
    }
    if (!added) break;
    index++;
  }
  return out;
}

function hostName(url = "") {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

function parseNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[^\d,.\-]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) return Number(s.replace(/\./g, "").replace(",", "."));
  if (s.includes(",")) return Number(s.replace(",", "."));
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

function productTokenSet(product, aliases) {
  const generic = new Set([
    "mela","mele","pera","pere","kiwi","uva","frutta","italia","italiano","italiane",
    "delicious","golden"
  ]);
  const tokens = new Set();
  for (const s of [product, ...aliases]) {
    for (const tok of normalizeText(s).split(" ")) {
      if (tok.length >= 3 && !generic.has(tok)) tokens.add(tok);
    }
  }
  return tokens;
}

function isHardExcluded(text, exclusions) {
  const hay = normalizeText(text);
  return exclusions.some(x => {
    const ex = normalizeText(x);
    return ex && hay.includes(ex);
  });
}

function quickExtract(item, product, aliases, exclusions) {
  const text = `${item.title || ""} ${item.snippet || ""}`.replace(/\s+/g, " ").trim();
  const lower = normalizeText(text);
  const domain = hostName(item.url);

  // Exclusion hard: se il titolo/snippet parla di mousse, succo, snack ecc. viene scartato.
  if (isHardExcluded(text, exclusions)) return null;

  const productTokens = productTokenSet(product, aliases);
  let matched = 0;
  for (const tok of productTokens) {
    if (lower.includes(tok)) matched++;
  }

  // "Melinda" è il segnale più importante per questo tipo di ricerca.
  const brandMatch = lower.includes("melinda") ? 5 : 0;

  // Segnali commerciali / retail.
  const commercialWords = [
    "prezzo","offerta","acquista","compra","shop","spesa","supermercato","€","eur",
    "kg","confezione","cassetta","vendita","disponibile","carrello","promo","volantino"
  ];
  let commercial = 0;
  for (const w of commercialWords) {
    if (text.toLowerCase().includes(w.toLowerCase())) commercial++;
  }

  // Penalizza fortemente pagine informative/nutrizionali non commerciali.
  const infoWords = [
    "calorie","dieta","chetogenica","nutrizione","valori nutrizionali","ricetta",
    "openfoodfacts","wikipedia","benefici","proprietà","quante calorie"
  ];
  let infoPenalty = 0;
  for (const w of infoWords) {
    if (lower.includes(normalizeText(w))) infoPenalty += 5;
  }

  // Alcuni domini tipicamente informativi.
  if (/calorie|openfoodfacts|wikipedia|cheto|nutriz/i.test(domain)) infoPenalty += 8;

  let score = (matched * 3) + brandMatch + (commercial * 2) - infoPenalty;

  const kgMatch = text.match(/(?:€\s*)?(\d{1,3}(?:[.,]\d{2}))\s*(?:€)?\s*(?:\/|al|per)\s*kg\b/i);
  const priceMatch =
    text.match(/(?:€\s*)?(\d{1,3}(?:[.,]\d{2}))\s*€/i) ||
    text.match(/€\s*(\d{1,3}(?:[.,]\d{2}))/i);
  const formatMatch = text.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grammi|pz|pezzi|confezioni?)\b/i);

  if (priceMatch || kgMatch) score += 5;

  return {
    queryTitle: item.title || "",
    title: item.title || "",
    url: item.url || "",
    domain,
    provider: item.provider || "",
    snippet: item.snippet || "",
    price: priceMatch ? parseNumber(priceMatch[1]) : null,
    priceKg: kgMatch ? parseNumber(kgMatch[1]) : null,
    currency: (priceMatch || kgMatch) ? "EUR" : null,
    format: formatMatch ? `${formatMatch[1]} ${formatMatch[2]}` : null,
    promotion: /\b(offerta|promo|promozione|sconto|volantino|sottocosto)\b/i.test(text),
    availability: null,
    brand: lower.includes("melinda") ? "Melinda" : null,
    sku: null,
    detectedDate: null,
    relevanceScore: score,
    commercialScore: commercial,
    evidence: item.snippet || "",
    usedBrowser: false,
    quickResult: true
  };
}

function resultKey(x) {
  return `${x.domain}|${String(x.title || "").toLowerCase().replace(/\s+/g, " ").slice(0, 120)}|${x.price ?? ""}|${x.priceKg ?? ""}`;
}

app.get("/api/test-serper", async (req, res) => {
  try {
    const q = String(req.query.q || "Mela Golden Melinda");
    const out = await testSerper(q);
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/api/search", async (req, res) => {
  const started = Date.now();

  try {
    const product = String(req.body.product || "").trim();
    if (!product) return res.status(400).json({ error: "Prodotto mancante" });

    const aliases = Array.isArray(req.body.aliases) ? req.body.aliases.filter(Boolean) : [];
    const exclusions = Array.isArray(req.body.exclusions) ? req.body.exclusions.filter(Boolean) : [];
    const retailerDomains = Array.isArray(req.body.retailerDomains) ? req.body.retailerDomains.filter(Boolean) : [];

    const maxPages = Math.min(Math.max(Number(req.body.maxPages || 20), 5), 50);
    const browserPages = Math.min(Math.max(Number(req.body.browserPages || 0), 0), 10);

    const expandedAliases = buildAliases(product, aliases);
    const queries = buildQueries(product, aliases, retailerDomains, maxPages);

    const searchLimit = pLimit(2);
    const rawBatches = await Promise.all(
      queries.map(q => searchLimit(() => multiSearch(q, 10)))
    );

    // Importante: miscela i risultati di tutte le query.
    // Prima i primi 10 arrivavano quasi tutti dalla prima query Google.
    const raw = dedupeRoundRobin(rawBatches, Math.max(maxPages * 3, 20));

    let results = raw
      .map(item => quickExtract(item, product, expandedAliases, exclusions))
      .filter(Boolean)
      .filter(x => (x.relevanceScore ?? 0) >= 6)
      .sort((a, b) => {
        const ap = (a.price !== null || a.priceKg !== null) ? 1 : 0;
        const bp = (b.price !== null || b.priceKg !== null) ? 1 : 0;
        if (bp !== ap) return bp - ap;
        if ((b.commercialScore ?? 0) !== (a.commercialScore ?? 0)) {
          return (b.commercialScore ?? 0) - (a.commercialScore ?? 0);
        }
        return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
      })
      .slice(0, maxPages);

    // Analisi profonda SOLO delle pagine già classificate come buone.
    if (browserPages > 0 && results.length > 0) {
      const candidates = results.slice(0, Math.min(browserPages, results.length));
      const analyzeLimit = pLimit(2);
      const deep = await Promise.all(
        candidates.map(item =>
          analyzeLimit(() => analyzeResult(
            { title: item.title, url: item.url, snippet: item.snippet, provider: item.provider },
            expandedAliases,
            exclusions,
            true
          ))
        )
      );

      const deepByUrl = new Map(deep.map(x => [canonical(x.url), x]));
      results = results.map(x => {
        const d = deepByUrl.get(canonical(x.url));
        if (!d) return x;
        return {
          ...x,
          ...d,
          relevanceScore: Math.max(x.relevanceScore || 0, d.relevanceScore || 0)
        };
      });
    }

    const byKey = new Map();
    for (const x of results) {
      const k = resultKey(x);
      const old = byKey.get(k);
      if (!old || (x.relevanceScore ?? 0) > (old.relevanceScore ?? 0)) byKey.set(k, x);
    }

    results = [...byKey.values()];

    const run = {
      id: `run_${Date.now()}`,
      product,
      aliases: expandedAliases,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      queries: queries.length,
      candidates: raw.length,
      serperEnabled: Boolean(process.env.SERPER_API_KEY),
      results
    };

    appendRun(run);
    res.json(run);
  } catch (e) {
    console.error("SEARCH_ERROR", e);
    res.status(500).json({
      error: "Errore durante la ricerca",
      detail: e?.message || String(e)
    });
  }
});

app.get("/api/history", (req, res) => {
  const product = String(req.query.product || "");
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  res.json(readHistory(product, limit));
});

app.post("/api/export-xlsx", (req, res) => {
  const run = req.body || {};
  const rows = (run.results || []).map(x => ({
    "Data rilevazione": run.createdAt || "",
    "Prodotto cercato": run.product || "",
    "Fonte": x.domain || "",
    "Titolo": x.title || "",
    "Prezzo €": x.price ?? "",
    "Prezzo €/kg": x.priceKg ?? "",
    "Formato": x.format || "",
    "Promozione": x.promotion ? "Sì" : "No",
    "Disponibilità": x.availability || "",
    "Marca": x.brand || "",
    "SKU/GTIN": x.sku || "",
    "Confidenza": x.relevanceScore ?? "",
    "Motore": x.provider || "",
    "URL": x.url || "",
    "Estratto": x.evidence || ""
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Risultati");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  const safe = String(run.product || "Product_Radar").replace(/[^\p{L}\p{N}\-_]+/gu, "_");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}.xlsx"`);
  res.send(buf);
});

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    serper: Boolean(process.env.SERPER_API_KEY),
    version: "3.0"
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Product Radar Pro v3 attivo sulla porta ${port}`);
});
