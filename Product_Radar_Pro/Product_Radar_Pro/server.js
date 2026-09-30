import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pLimit from "p-limit";
import XLSX from "xlsx";

import { buildAliases, buildQueries } from "./lib/query.js";
import { multiSearch } from "./lib/searchProviders.js";
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

function resultKey(x) {
  return `${x.domain}|${String(x.title || "").toLowerCase().replace(/\s+/g, " ").slice(0, 120)}|${x.price ?? ""}|${x.priceKg ?? ""}`;
}

app.post("/api/search", async (req, res) => {
  const started = Date.now();
  const product = String(req.body.product || "").trim();
  if (!product) return res.status(400).json({ error: "Prodotto mancante" });

  const aliases = Array.isArray(req.body.aliases) ? req.body.aliases.filter(Boolean) : [];
  const exclusions = Array.isArray(req.body.exclusions) ? req.body.exclusions.filter(Boolean) : [];
  const retailerDomains = Array.isArray(req.body.retailerDomains) ? req.body.retailerDomains.filter(Boolean) : [];

  const maxPages = Math.min(Math.max(Number(req.body.maxPages || 40), 5), 100);
  const browserPages = Math.min(Math.max(Number(req.body.browserPages || 20), 0), 50);

  const expandedAliases = buildAliases(product, aliases);
  const queries = buildQueries(product, aliases, retailerDomains);

  const searchLimit = pLimit(4);
  const rawBatches = await Promise.all(
    queries.map(q => searchLimit(() => multiSearch(q, 12)))
  );

  const raw = dedupe(rawBatches.flat()).slice(0, maxPages);

  const analyzeLimit = pLimit(4);
  let renderedCount = 0;

  const analyzed = await Promise.all(
    raw.map(item => analyzeLimit(async () => {
      const allowBrowser = renderedCount < browserPages;
      if (allowBrowser) renderedCount++;
      return analyzeResult(item, expandedAliases, exclusions, allowBrowser);
    }))
  );

  const byKey = new Map();
  for (const x of analyzed) {
    // Tiene solo risultati almeno moderatamente pertinenti.
    if ((x.relevanceScore ?? 0) < 2) continue;
    const k = resultKey(x);
    const old = byKey.get(k);
    if (!old || (x.relevanceScore ?? 0) > (old.relevanceScore ?? 0)) byKey.set(k, x);
  }

  const results = [...byKey.values()]
    .sort((a, b) => {
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
    results
  };

  appendRun(run);
  res.json(run);
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
  ws["!cols"] = [
    { wch: 20 }, { wch: 28 }, { wch: 24 }, { wch: 50 },
    { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
    { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 16 },
    { wch: 12 }, { wch: 16 }, { wch: 60 }, { wch: 80 }
  ];
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
    brave: Boolean(process.env.BRAVE_API_KEY),
    serper: Boolean(process.env.SERPER_API_KEY)
  });
});

app.post("/api/cron-search", async (req, res) => {
  const secret = req.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.status(501).json({
    error: "Endpoint predisposto. Configura una lista monitoraggi prima di attivare il cron."
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Product Radar Pro attivo sulla porta ${port}`);
});
