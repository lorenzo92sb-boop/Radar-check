import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { normalizeText } from "./query.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154 Safari/537.36";

function toNumber(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().replace(/[^\d,.\-]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function plausiblePrice(n) {
  return n !== null && n >= 0.20 && n <= 500;
}
function plausibleProduceKgPrice(n) {
  return n !== null && n >= 0.20 && n <= 50;
}

function parseCaliber(text) {
  const patterns = [
    /\bcal(?:ibro)?\.?\s*[:\-]?\s*(\d{2,3})\s*[\/\-]\s*(\d{2,3})\b/i,
    /\b(\d{2,3})\s*[\/\-]\s*(\d{2,3})\b(?=\s*(?:mm|calibro|cal\.?)?)/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

function weightCandidates(text) {
  const out = [];

  // 1 kg, 900 g, 4,3 kg
  const rx1 = /(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grammi)\b/gi;
  let m;
  while ((m = rx1.exec(text)) !== null) {
    const start = Math.max(0, m.index - 25);
    const before = text.slice(start, m.index).toLowerCase();
    if (/(calibro|cal\.?|pezzatura)\s*[\d\s\/\-]*$/i.test(before)) continue;

    const value = toNumber(m[1]);
    if (value === null) continue;

    const unit = m[2].toLowerCase();
    const kg = unit === "kg" ? value : value / 1000;
    if (kg <= 0 || kg > 25) continue;

    out.push({ raw: `${m[1]} ${m[2]}`, kg, index: m.index });
  }

  // kg 1 / kg.1 / kg. 1 / kg 1,50
  const rx2 = /\bkg\s*[\.:]?\s*(\d+(?:[.,]\d+)?)\b/gi;
  while ((m = rx2.exec(text)) !== null) {
    const value = toNumber(m[1]);
    if (value === null || value <= 0 || value > 25) continue;

    // Evita "€ 2,44 al kg 1" se appare come costrutto di prezzo.
    const before = text.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
    if (/(€|eur|al\s+|per\s+)$/i.test(before)) continue;

    out.push({ raw: `${m[1]} kg`, kg: value, index: m.index });
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

function parseUnitPrice(text) {
  const patterns = [
    /(?:€\s*)?(\d{1,3}(?:[.,]\d{1,2}))\s*€?\s*(?:\/|al|per)\s*kg\b/i,
    /(?:€\s*)?(\d{1,3}(?:[.,]\d{1,2}))\s*(?:€\/kg|eur\/kg)\b/i,
    /\b(?:al\s+kg|kg)\s*[:\-]?\s*€?\s*(\d{1,3}(?:[.,]\d{1,2}))\b/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = toNumber(m[1]);
      if (plausibleProduceKgPrice(n)) return n;
    }
  }
  return null;
}

function parseGenericPrices(text) {
  const out = [];
  const patterns = [
    /€\s*(\d{1,3}(?:[.,]\d{1,2}))/gi,
    /(\d{1,3}(?:[.,]\d{1,2}))\s*€/gi
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const n = toNumber(m[1]);
      if (plausiblePrice(n)) out.push({ value: n, index: m.index });
    }
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function detectPromotion(text) {
  return /\b(offerta|promo|promozione|sconto|volantino|sottocosto|speciale|prezzo\s+speciale)\b/i.test(text);
}

function parseDate(text) {
  const month =
    "(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)";
  const patterns = [
    new RegExp(`\\b(\\d{1,2}\\s+${month}\\s+\\d{4})\\b`, "i"),
    /\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})\b/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

function parseOrigin(text) {
  const patterns = [
    /\borigine\s*[:\-]?\s*([A-Za-zÀ-ÿ' ]{2,35}?)(?=\s{2,}|[,;|]|$)/i,
    /\bprovenienza\s*[:\-]?\s*([A-Za-zÀ-ÿ' ]{2,35}?)(?=\s{2,}|[,;|]|$)/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = m[1].trim();
      if (v.length >= 2 && v.length <= 35) return v;
    }
  }
  return null;
}

export function extractCommercialFields(text = "") {
  const clean = String(text).replace(/\s+/g, " ").trim();
  const caliber = parseCaliber(clean);
  const weights = weightCandidates(clean);
  const weight = weights[0] || null;
  const priceKgExplicit = parseUnitPrice(clean);
  const prices = parseGenericPrices(clean);

  let packPrice = null;
  if (prices.length) {
    for (const p of prices) {
      const ctx = clean.slice(Math.max(0, p.index - 25), p.index + 45);
      if (/(\/\s*kg|al\s+kg|per\s+kg|€\/kg|eur\/kg)/i.test(ctx)) continue;
      packPrice = p.value;
      break;
    }
  }

  let priceKg = priceKgExplicit;
  let computedKg = false;

  if (
    priceKg === null &&
    packPrice !== null &&
    weight?.kg &&
    weight.kg >= 0.05 &&
    weight.kg <= 25
  ) {
    const computed = packPrice / weight.kg;
    if (plausibleProduceKgPrice(computed)) {
      priceKg = Math.round(computed * 100) / 100;
      computedKg = true;
    }
  }

  return {
    packPrice,
    priceKg,
    priceKgComputed: computedKg,
    format: weight?.raw || null,
    weightKg: weight?.kg || null,
    caliber,
    promotion: detectPromotion(clean),
    detectedDate: parseDate(clean),
    origin: parseOrigin(clean)
  };
}

function walkJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const x of node) walkJsonLd(x, out);
  } else if (typeof node === "object") {
    out.push(node);
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") walkJsonLd(v, out);
    }
  }
  return out;
}

function parseJsonLd($) {
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).text().trim();
    if (!txt) return;
    try {
      const data = JSON.parse(txt);
      walkJsonLd(data, nodes);
    } catch {}
  });
  return nodes;
}

function aliasScore(text, aliases) {
  const hay = normalizeText(text);
  let score = 0;
  for (const a of aliases) {
    for (const tok of normalizeText(a).split(" ").filter(x => x.length >= 3)) {
      if (hay.includes(tok)) score++;
    }
  }
  return score;
}

function pickProductNode(nodes, aliases) {
  let best = null;
  let bestScore = -1;
  for (const n of nodes) {
    const type = Array.isArray(n["@type"]) ? n["@type"].join(" ") : String(n["@type"] || "");
    if (!/product/i.test(type)) continue;
    const text = `${n.name || ""} ${n.description || ""} ${n.sku || ""}`;
    const score = aliasScore(text, aliases);
    if (score > bestScore) {
      best = n;
      bestScore = score;
    }
  }
  return best;
}

function offerFromProduct(node) {
  if (!node) return {};
  let offers = node.offers;
  if (!offers) return {};
  if (Array.isArray(offers)) offers = offers[0] || {};
  const price =
    toNumber(offers.price) ??
    toNumber(offers.lowPrice) ??
    toNumber(offers.highPrice);

  return {
    price: plausiblePrice(price) ? price : null,
    currency: offers.priceCurrency || null,
    availability: offers.availability
      ? String(offers.availability).split("/").pop()
      : null,
    priceValidUntil: offers.priceValidUntil || null,
    validFrom: offers.validFrom || null
  };
}

function structuredWeight(node) {
  if (!node?.weight) return null;
  if (typeof node.weight === "string") {
    return weightCandidates(node.weight)[0] || null;
  }
  const value = toNumber(node.weight.value);
  const unit = String(node.weight.unitCode || node.weight.unitText || "").toLowerCase();
  if (value === null) return null;
  if (/kg|kilogram/.test(unit) && value <= 25) return { raw: `${value} kg`, kg: value };
  if (/g|gram/.test(unit) && value <= 25000) return { raw: `${value} g`, kg: value / 1000 };
  return null;
}

function textFromPage($) {
  $("script:not([type='application/ld+json']), style, noscript, svg").remove();
  return $("body").text().replace(/\s+/g, " ").trim().slice(0, 150000);
}

function hostName(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function blockedPage(title = "", body = "") {
  const text = `${title} ${body.slice(0, 1200)}`.toLowerCase();
  return /\b(access denied|forbidden|captcha|verify you are human|cloudflare|temporarily blocked|403 forbidden)\b/i.test(text);
}

async function fetchStatic(url) {
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "it-IT,it;q=0.9,en;q=0.6"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15000)
  });

  const ct = r.headers.get("content-type") || "";
  if (!r.ok || !ct.includes("text/html")) return null;
  return { html: await r.text(), finalUrl: r.url };
}

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browserPromise;
}

async function fetchRendered(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA, locale: "it-IT" });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 22000 });
    await page.waitForTimeout(900);
    return { html: await page.content(), finalUrl: page.url() };
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

function parseHtml(html, finalUrl, original, aliases, exclusions, rendered = false) {
  const $ = cheerio.load(html);
  const bodyText = textFromPage($);

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim() ||
    original.title ||
    "";

  if (blockedPage(title, bodyText)) {
    return {
      blocked: true,
      title: original.title || title,
      url: finalUrl || original.url,
      domain: hostName(finalUrl || original.url),
      provider: original.provider || "",
      verification: "Accesso bloccato - uso snippet Google"
    };
  }

  const allText = `${title} ${original.snippet || ""} ${bodyText}`;

  for (const ex of exclusions) {
    const e = normalizeText(ex);
    if (e && normalizeText(`${title} ${original.snippet || ""}`).includes(e)) {
      return null;
    }
  }

  const nodes = parseJsonLd($);
  const productNode = pickProductNode(nodes, aliases);
  const offer = offerFromProduct(productNode);
  const textFields = extractCommercialFields(allText);
  const structuredW = structuredWeight(productNode);

  let packPrice = offer.price ?? textFields.packPrice;
  let format = structuredW?.raw ?? textFields.format;
  let weightKg = structuredW?.kg ?? textFields.weightKg;
  let priceKg = textFields.priceKg;
  let priceKgComputed = textFields.priceKgComputed;

  if (
    priceKg === null &&
    packPrice !== null &&
    weightKg &&
    weightKg >= 0.05 &&
    weightKg <= 25
  ) {
    const computed = packPrice / weightKg;
    if (plausibleProduceKgPrice(computed)) {
      priceKg = Math.round(computed * 100) / 100;
      priceKgComputed = true;
    }
  }

  const productName = productNode?.name || title;
  const brand =
    productNode?.brand?.name ||
    (typeof productNode?.brand === "string" ? productNode.brand : null) ||
    null;

  const sku = productNode?.sku || productNode?.gtin13 || productNode?.gtin || null;

  const dateHint =
    offer.priceValidUntil ||
    offer.validFrom ||
    productNode?.dateModified ||
    productNode?.datePublished ||
    textFields.detectedDate ||
    null;

  let confidence = "Media";
  if (productNode && packPrice !== null) confidence = "Alta";
  else if (priceKg !== null && aliasScore(`${productName} ${bodyText.slice(0,3000)}`, aliases) >= 2) confidence = "Alta";
  else if (packPrice === null && priceKg === null) confidence = "Bassa";

  return {
    blocked: false,
    queryTitle: original.title || "",
    title: productName || title,
    url: finalUrl || original.url,
    domain: hostName(finalUrl || original.url),
    provider: original.provider || "",
    snippet: original.snippet || "",
    packPrice,
    price: packPrice,
    priceKg,
    priceKgComputed,
    currency: offer.currency || (packPrice !== null || priceKg !== null ? "EUR" : null),
    format,
    weightKg,
    caliber: textFields.caliber,
    promotion: textFields.promotion,
    availability: offer.availability || null,
    brand,
    sku,
    detectedDate: dateHint,
    origin: textFields.origin,
    verification: rendered ? "Pagina verificata (browser)" : "Pagina verificata",
    confidence,
    evidence: bodyText.slice(0, 800),
    usedBrowser: rendered
  };
}

export async function analyzeResult(original, aliases, exclusions, allowBrowser = true) {
  let staticData = null;
  try {
    staticData = await fetchStatic(original.url);
  } catch {}

  if (staticData) {
    const parsed = parseHtml(
      staticData.html,
      staticData.finalUrl,
      original,
      aliases,
      exclusions,
      false
    );

    if (parsed?.blocked) {
      // Prova il browser solo se richiesto, altrimenti torna "blocked".
      if (!allowBrowser) return parsed;
    } else if (
      parsed &&
      (
        parsed.confidence === "Alta" ||
        parsed.price !== null ||
        parsed.priceKg !== null
      )
    ) {
      return parsed;
    }
  }

  if (allowBrowser) {
    try {
      const rendered = await fetchRendered(original.url);
      if (rendered) {
        return parseHtml(
          rendered.html,
          rendered.finalUrl,
          original,
          aliases,
          exclusions,
          true
        );
      }
    } catch {}
  }

  if (staticData) {
    return parseHtml(
      staticData.html,
      staticData.finalUrl,
      original,
      aliases,
      exclusions,
      false
    );
  }

  return null;
}
