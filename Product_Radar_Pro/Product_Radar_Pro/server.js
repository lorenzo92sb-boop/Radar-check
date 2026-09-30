import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import pLimit from "p-limit";
import XLSX from "xlsx";

import { buildAliases, buildQueries, normalizeText } from "./lib/query.js";
import { multiSearch, testSerper } from "./lib/searchProviders.js";
import { analyzeResult, extractCommercialFields } from "./lib/extract.js";
import { appendRun, readHistory } from "./lib/history.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const CURRENT_YEAR = new Date().getFullYear();

const RETAILER_MAP = [
  ["bennet.com", "Bennet"],
  ["decoacasa.multicedi.it", "Decò"],
  ["carrefour.it", "Carrefour"],
  ["conad.it", "Conad"],
  ["coop.it", "Coop"],
  ["coopacasa.", "Coop"],
  ["despar.it", "Despar"],
  ["esselunga.it", "Esselunga"],
  ["famila.it", "Famila"],
  ["iper.it", "Iper"],
  ["penny.it", "Penny"],
  ["lidl.it", "Lidl"],
  ["eurospin.it", "Eurospin"],
  ["mdspa.it", "MD"],
  ["tigros.it", "Tigros"],
  ["pamretailpro.it", "Pam"]
];

const BRAND_DOMAINS = [
  "melinda.it",
  "marlene.it",
  "zespri.com",
  "pinkladyapples.com"
];

const GENERIC_PRODUCT_WORDS = new Set([
  "mela","mele","pera","pere","kiwi","uva","frutta","ortofrutta",
  "pomodoro","pomodori","patata","patate","cipolla","cipolle",
  "finocchio","finocchi","arancia","arance","limone","limoni","delicious"
]);

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

function hostname(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function retailerName(domain) {
  const row = RETAILER_MAP.find(([needle]) => domain.includes(needle));
  return row ? row[1] : null;
}

function isBrandDomain(domain) {
  return BRAND_DOMAINS.some(d => domain.includes(d));
}

function sourceType(domain, text = "", fields = null) {
  if (retailerName(domain)) return "GDO / Retailer";
  if (isBrandDomain(domain)) return "Produttore / Brand";
  if (/facebook\.com|instagram\.com|tiktok\.com|youtube\.com/i.test(domain)) return "Social";
  if (/volantino|offerte|promo|anteprima|nuovovolantino/i.test(domain)) return "Volantino / Promo";
  if (/calorie|openfoodfacts|wikipedia|nutriz|dieta|ricette?|opinioni/i.test(domain)) return "Informativo";

  const t = normalizeText(text);
  if (
    fields?.packPrice !== null ||
    fields?.priceKg !== null ||
    /\b(acquista|shop|spesa|carrello|consegna|vendita|prezzo|€|eur)\b/i.test(text)
  ) {
    return "E-commerce";
  }
  if (t.includes("frutta") || t.includes("ortofrutta") || t.includes("ortofrutt")) return "E-commerce";
  return "Altro";
}

function yearFromText(text = "") {
  const years = [...String(text).matchAll(/\b(20\d{2})\b/g)]
    .map(m => Number(m[1]))
    .filter(y => y >= 2000 && y <= CURRENT_YEAR + 1);
  if (!years.length) return null;
  return Math.max(...years);
}

function freshness(text = "", searchDate = null) {
  const joined = `${searchDate || ""} ${text || ""}`;
  const y = yearFromText(joined);

  if (/archiv/i.test(joined)) return { label: "Storico", year: y };
  if (y && y < CURRENT_YEAR) return { label: "Storico", year: y };
  if (y === CURRENT_YEAR) return { label: "Corrente", year: y };
  return { label: "Da verificare", year: y };
}

function hardExcluded(text, exclusions) {
  const hay = normalizeText(text);
  return exclusions.some(x => {
    const ex = normalizeText(x);
    return ex && hay.includes(ex);
  });
}

function essentialTokens(product) {
  return normalizeText(product)
    .split(" ")
    .filter(tok => tok.length >= 3 && !GENERIC_PRODUCT_WORDS.has(tok));
}

function titleProductMatch(title, product) {
  const titleNorm = normalizeText(title);
  const required = essentialTokens(product);
  if (!required.length) return true;
  return required.every(tok => titleNorm.includes(tok));
}

function productCoreTokens(product, aliases) {
  const out = new Set();
  for (const s of [product, ...aliases]) {
    for (const tok of normalizeText(s).split(" ")) {
      if (tok.length >= 3 && !GENERIC_PRODUCT_WORDS.has(tok)) out.add(tok);
    }
  }
  return out;
}

function quickExtract(item, product, aliases, exclusions, strictMatch = true) {
  const text = `${item.title || ""} ${item.snippet || ""}`.replace(/\s+/g, " ").trim();
  const domain = hostname(item.url);

  if (hardExcluded(text, exclusions)) return null;

  const exactTitle = titleProductMatch(item.title || "", product);
  if (strictMatch && !exactTitle) return null;

  const normalized = normalizeText(text);
  const coreTokens = productCoreTokens(product, aliases);

  let productMatch = 0;
  for (const tok of coreTokens) {
    if (normalized.includes(tok)) productMatch++;
  }

  const fields = extractCommercialFields(text);
  const type = sourceType(domain, text, fields);

  const commercialSignals = [
    "prezzo","offerta","acquista","compra","shop","spesa","supermercato","€","eur",
    "kg","confezione","cassetta","vendita","disponibile","carrello","promo","volantino"
  ];
  let commercialScore = 0;
  for (const s of commercialSignals) {
    if (text.toLowerCase().includes(s.toLowerCase())) commercialScore++;
  }

  const infoSignals = [
    "calorie","dieta","chetogenica","nutrizione","valori nutrizionali","ricetta",
    "openfoodfacts","wikipedia","benefici","proprietà","opinioni","recensioni"
  ];
  let penalty = 0;
  for (const s of infoSignals) {
    if (normalized.includes(normalizeText(s))) penalty += 8;
  }

  if (type === "Informativo") penalty += 14;
  if (type === "Social") penalty += 5;
  if (type === "Produttore / Brand") penalty += 2;

  const fresh = freshness(text, item.searchDate);

  let score = (productMatch * 4) + (exactTitle ? 10 : 0) + (commercialScore * 2) - penalty;
  if (fields.packPrice !== null || fields.priceKg !== null) score += 6;
  if (type === "GDO / Retailer") score += 9;
  if (type === "E-commerce") score += 4;
  if (fresh.label === "Storico") score -= 6;

  let confidence = "Bassa";
  if (exactTitle && score >= 24 && (fields.packPrice !== null || fields.priceKg !== null)) confidence = "Alta";
  else if (exactTitle && score >= 16) confidence = "Media";

  const retailer = retailerName(domain);

  return {
    title: item.title || "",
    originalTitle: item.title || "",
    url: item.url || "",
    domain,
    retailer,
    sourceType: type,
    provider: item.provider || "",
    snippet: item.snippet || "",
    searchDate: item.searchDate || null,
    exactTitleMatch: exactTitle,
    packPrice: fields.packPrice,
    price: fields.packPrice,
    priceKg: fields.priceKg,
    priceKgComputed: fields.priceKgComputed,
    format: fields.format,
    weightKg: fields.weightKg,
    caliber: fields.caliber,
    promotion: fields.promotion,
    detectedDate: fields.detectedDate || item.searchDate || null,
    origin: fields.origin,
    freshness: fresh.label,
    year: fresh.year,
    verification: "Snippet Google",
    confidence,
    relevanceScore: score,
    commercialScore,
    evidence: item.snippet || ""
  };
}

function semanticKey(x) {
  const title = normalizeText(x.title || "")
    .replace(/\b(archivi|archivio|shop|online|spesa|domicilio|offerta)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return [
    x.domain,
    title.slice(0, 90),
    x.packPrice ?? "",
    x.priceKg ?? "",
    x.format ?? ""
  ].join("|");
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

function dedupeSemantic(results) {
  const byKey = new Map();

  for (const x of results) {
    const key = semanticKey(x);
    const old = byKey.get(key);

    if (!old) {
      byKey.set(key, x);
      continue;
    }

    // Preferisci pagina verificata, poi maggiore confidenza, poi score.
    const rank = y =>
      (String(y.verification || "").startsWith("Pagina verificata") ? 100 : 0) +
      (y.confidence === "Alta" ? 20 : y.confidence === "Media" ? 10 : 0) +
      (y.relevanceScore || 0);

    if (rank(x) > rank(old)) byKey.set(key, x);
  }

  return [...byKey.values()];
}

function removeRedundantArchives(results) {
  const domainsWithCurrent = new Set(
    results.filter(x => x.freshness !== "Storico").map(x => x.domain)
  );
  return results.filter(x => x.freshness !== "Storico" || !domainsWithCurrent.has(x.domain));
}

function sortResults(a, b) {
  const aCurrent = a.freshness === "Corrente" ? 2 : a.freshness === "Da verificare" ? 1 : 0;
  const bCurrent = b.freshness === "Corrente" ? 2 : b.freshness === "Da verificare" ? 1 : 0;
  if (bCurrent !== aCurrent) return bCurrent - aCurrent;

  const typeRank = {
    "GDO / Retailer": 6,
    "E-commerce": 5,
    "Volantino / Promo": 4,
    "Produttore / Brand": 3,
    "Altro": 2,
    "Social": 1,
    "Informativo": 0
  };

  if ((typeRank[b.sourceType] ?? 0) !== (typeRank[a.sourceType] ?? 0)) {
    return (typeRank[b.sourceType] ?? 0) - (typeRank[a.sourceType] ?? 0);
  }

  const aPrice = (a.packPrice !== null || a.priceKg !== null) ? 1 : 0;
  const bPrice = (b.packPrice !== null || b.priceKg !== null) ? 1 : 0;
  if (bPrice !== aPrice) return bPrice - aPrice;

  return (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
}

app.get("/api/test-serper", async (req, res) => {
  try {
    const q = String(req.query.q || "Mela Golden Melinda");
    res.json(await testSerper(q));
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
    const retailerDomains = Array.isArray(req.body.retailerDomains)
      ? req.body.retailerDomains.filter(Boolean)
      : [];

    const strictMatch = req.body.strictMatch !== false;
    const gdoExtended = req.body.gdoExtended !== false;
    const includeSecondary = req.body.includeSecondary === true;

    const maxResults = Math.min(Math.max(Number(req.body.maxPages || 25), 5), 50);
    const deepPages = Math.min(Math.max(Number(req.body.browserPages || 3), 0), 8);

    const expandedAliases = buildAliases(product, aliases);
    const queries = buildQueries(product, aliases, retailerDomains, maxResults, gdoExtended);

    const searchLimit = pLimit(5);
    const batches = await Promise.all(
      queries.map(q => searchLimit(() => multiSearch(q, 10)))
    );

    const raw = dedupeRoundRobin(batches, Math.max(maxResults * 7, 100));

    let results = raw
      .map(item => quickExtract(item, product, expandedAliases, exclusions, strictMatch))
      .filter(Boolean)
      .filter(x => x.relevanceScore >= 12)
      .sort(sortResults);

    results = removeRedundantArchives(dedupeSemantic(results)).sort(sortResults);

    if (deepPages > 0 && results.length > 0) {
      const candidates = results
        .filter(x => !["Social", "Informativo", "Produttore / Brand"].includes(x.sourceType))
        .filter(x => x.freshness !== "Storico")
        .slice(0, deepPages);

      const deepLimit = pLimit(1);
      const deepSettled = await Promise.allSettled(
        candidates.map(item =>
          deepLimit(() =>
            analyzeResult(
              {
                title: item.title,
                url: item.url,
                snippet: item.snippet,
                provider: item.provider
              },
              expandedAliases,
              exclusions,
              true
            )
          )
        )
      );

      const deepByUrl = new Map();
      for (const s of deepSettled) {
        if (s.status !== "fulfilled" || !s.value) continue;
        deepByUrl.set(canonical(s.value.url), s.value);
      }

      results = results.map(x => {
        const d = deepByUrl.get(canonical(x.url));
        if (!d) return x;

        // Non contaminare dati Google con pagine categoria o anti-bot.
        if (d.blocked || d.identityMismatch) {
          return {
            ...x,
            verification: d.verification || x.verification,
            confidence: x.confidence === "Alta" ? "Media" : x.confidence
          };
        }

        const fresh = freshness(`${d.detectedDate || ""} ${d.title || ""}`, x.searchDate);

        return {
          ...x,
          ...d,
          originalTitle: x.originalTitle,
          retailer: x.retailer,
          sourceType: x.sourceType,
          exactTitleMatch: x.exactTitleMatch,
          freshness: fresh.label,
          year: fresh.year,
          relevanceScore: x.relevanceScore,
          confidence: d.confidence || x.confidence
        };
      });
    }

    // Secondo dedupe DOPO la verifica profonda.
    results = dedupeSemantic(results);

    if (!includeSecondary) {
      results = results.filter(x =>
        !["Social", "Informativo", "Produttore / Brand"].includes(x.sourceType)
      );
    }

    results = results
      .filter(x => !strictMatch || x.exactTitleMatch)
      .sort(sortResults)
      .slice(0, maxResults);

    const run = {
      id: `run_${Date.now()}`,
      product,
      aliases: expandedAliases,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      queries: queries.length,
      candidates: raw.length,
      deepRequested: deepPages,
      strictMatch,
      gdoExtended,
      includeSecondary,
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
    "Insegna": x.retailer || "",
    "Fonte": x.domain || "",
    "Tipo fonte": x.sourceType || "",
    "Prodotto trovato": x.title || "",
    "Match titolo": x.exactTitleMatch ? "Esatto" : "Ampio",
    "Prezzo confezione €": x.packPrice ?? "",
    "Prezzo €/kg": x.priceKg ?? "",
    "€/kg calcolato": x.priceKgComputed ? "Sì" : "No",
    "Formato": x.format || "",
    "Calibro": x.caliber || "",
    "Origine": x.origin || "",
    "Promozione": x.promotion ? "Sì" : "No",
    "Data Google/pagina": x.detectedDate || x.searchDate || "",
    "Freschezza": x.freshness || "",
    "Verifica": x.verification || "",
    "Confidenza": x.confidence || "",
    "Motore": x.provider || "",
    "URL": x.url || "",
    "Estratto": x.evidence || ""
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Risultati");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const safe = String(run.product || "Product_Radar")
    .replace(/[^\p{L}\p{N}\-_]+/gu, "_");

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safe}.xlsx"`
  );
  res.send(buf);
});

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    serper: Boolean(process.env.SERPER_API_KEY),
    version: "7.0"
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Product Radar Pro v7 attivo sulla porta ${port}`);
});
