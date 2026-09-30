import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pLimit from "p-limit";
import XLSX from "xlsx";

import { buildAliases, buildQueries } from "./lib/query.js";
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

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const x of items) {
    const k = canonical(x.url);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function hostName(url = "") {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

function n(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[^\d,.\-]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) return Number(s.replace(/\./g, "").replace(",", "."));
  if (s.includes(",")) return Number(s.replace(",", "."));
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

function quickExtract(item, aliases, exclusions) {
  const text = `${item.title || ""} ${item.snippet || ""}`.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  let score = 0;
  const matched = new Set();
  for (const alias of aliases) {
    for (const tok of String(alias).toLowerCase().split(/\s+/).filter(x => x.length >= 3)) {
      if (lower.includes(tok)) {
        score += 2;
        matched.add(tok);
      }
    }
  }
  for (const ex of exclusions) {
    if (ex && lower.includes(String(ex).toLowerCase())) score -= 4;
  }

  const kgMatch = text.match(/(?:€\s*)?(\d{1,3}(?:[.,]\d{2}))\s*(?:€)?\s*(?:\/|al|per)\s*kg\b/i);
  const priceMatch = text.match(/(?:€\s*)?(\d{1,3}(?:[.,]\d{2}))\s*€/i) || text.match(/€\s*(\d{1,3}(?:[.,]\d{2}))/i);
  const formatMatch = text.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grammi|pz|pezzi|confezioni?)\b/i);

  return {
    queryTitle: item.title || "",
    title: item.title || "",
    url: item.url || "",
    domain: hostName(item.url),
    provider: item.provider || "",
    snippet: item.snippet || "",
    price: priceMatch ? n(priceMatch[1]) : null,
    priceKg: kgMatch ? n(kgMatch[1]) : null,
    currency: (priceMatch || kgMatch) ? "EUR" : null,
    format: formatMatch ? `${formatMatch[1]} ${formatMatch[2]}` : null,
    promotion: /\b(offerta|promo|promozione|sconto|volantino|sottocosto)\b/i.test(text),
    availability: null,
    brand: null,
    sku: null,
    detectedDate: null,
    relevanceScore: score,
    matchedTokens: [...matched],
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

    // Fase 1: discovery veloce. Poche query, Serper prioritario.
    const searchLimit = pLimit(2);
    const rawBatches = await Promise.all(
      queries.map(q => searchLimit(() => multiSearch(q, 10)))
    );

    const raw = dedupe(rawBatches.flat()).slice(0, maxPages);

    // Restituisce sempre una base di risultati da titoli/snippet.
    let results = raw
      .map(item => quickExtract(item, expandedAliases, exclusions))
      .filter(x => (x.relevanceScore ?? 0) >= 2);

    // Fase 2 opzionale: analisi profonda solo delle prime N pagine.
    if (browserPages > 0 && raw.length > 0) {
      const deepCandidates = raw.slice(0, Math.min(browserPages, raw.length));
      const analyzeLimit = pLimit(2);

      const deep = await Promise.all(
        deepCandidates.map(item =>
          analyzeLimit(() => analyzeResult(item, expandedAliases, exclusions, true))
        )
      );

      const deepByUrl = new Map(deep.map(x => [canonical(x.url), x]));
      results = results.map(x => deepByUrl.get(canonical(x.url)) || x);

      // Aggiunge eventuali risultati deep non presenti nei quick.
      for (const x of deep) {
        if (!results.some(r => canonical(r.url) === canonical(x.url))) results.push(x);
      }
    }

    const byKey = new Map();
    for (const x of results) {
      if ((x.relevanceScore ?? 0) < 2) continue;
      const k = resultKey(x);
      const old = byKey.get(k);
      if (!old || (x.relevanceScore ?? 0) > (old.relevanceScore ?? 0)) byKey.set(k, x);
    }

    results = [...byKey.values()].sort((a, b) => {
      const ap = (a.price !== null || a.priceKg !== null) ? 1 : 0;
      const bp = (b.price !== null || b.priceKg !== null) ? 1 : 0;
      if (bp !== ap) return bp - ap;
      return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
    });

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
    "Data trovata": x.detectedDate || "",
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
    brave: Boolean(process.env.BRAVE_API_KEY),
    version: "2.0"
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Product Radar Pro v2 attivo sulla porta ${port}`);
});
