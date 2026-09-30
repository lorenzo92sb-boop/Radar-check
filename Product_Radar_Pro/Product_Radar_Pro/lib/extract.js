import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { normalizeText } from "./query.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36";

function num(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/[^\d,.\-]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) {
    return Number(s.replace(/\./g, "").replace(",", "."));
  }
  if (s.includes(",")) return Number(s.replace(",", "."));
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function walkJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const x of node) walkJsonLd(x, out);
  } else if (typeof node === "object") {
    out.push(node);
    for (const v of Object.values(node)) {
      if (typeof v === "object") walkJsonLd(v, out);
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

function pickProductFromJsonLd(nodes, aliases) {
  const aliasNorms = aliases.map(normalizeText);
  let best = null;
  let bestScore = -1;

  for (const n of nodes) {
    const type = Array.isArray(n["@type"]) ? n["@type"].join(" ") : String(n["@type"] || "");
    if (!/product|offer/i.test(type)) continue;

    const name = String(n.name || n.itemOffered?.name || "");
    const desc = String(n.description || "");
    const hay = normalizeText(`${name} ${desc}`);
    let score = 0;
    for (const a of aliasNorms) {
      for (const tok of a.split(" ").filter(x => x.length >= 3)) {
        if (hay.includes(tok)) score++;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

function extractOffer(node) {
  if (!node) return {};
  let offer = node.offers || node;
  if (Array.isArray(offer)) offer = offer[0] || {};
  if (offer && offer["@type"] && !/offer/i.test(String(offer["@type"])) && node.offers) {
    offer = node.offers;
  }
  const price = num(offer?.price ?? offer?.lowPrice ?? offer?.highPrice);
  const currency = offer?.priceCurrency || null;
  const availability = offer?.availability ? String(offer.availability).split("/").pop() : null;
  return { price, currency, availability };
}

function extractTextFields(text) {
  const t = text.replace(/\s+/g, " ").trim();

  const eurPatterns = [
    /(?:€\s*)?(\d{1,3}(?:[.,]\d{2}))\s*(?:€)?\s*(?:\/|al|per)\s*kg\b/i,
    /(?:prezzo\s*)?(?:€\s*)?(\d{1,3}(?:[.,]\d{2}))\s*€/i,
    /€\s*(\d{1,3}(?:[.,]\d{2}))/i
  ];

  let priceKg = null;
  let price = null;

  const mkg = t.match(eurPatterns[0]);
  if (mkg) priceKg = num(mkg[1]);

  for (const p of eurPatterns.slice(1)) {
    const m = t.match(p);
    if (m) {
      price = num(m[1]);
      break;
    }
  }

  const formatMatch = t.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grammi|pz|pezzi|confezioni?)\b/i);
  const format = formatMatch ? `${formatMatch[1]} ${formatMatch[2]}` : null;

  const promo = /\b(offerta|promo|promozione|sconto|volantino|sottocosto|speciale)\b/i.test(t);
  const unavailable = /\b(non disponibile|esaurito|sold out|temporaneamente non disponibile)\b/i.test(t);

  const dateMatch = t.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}\s+(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+\d{4})\b/i);

  return {
    price,
    priceKg,
    format,
    promo,
    availabilityText: unavailable ? "Non disponibile" : null,
    detectedDate: dateMatch ? dateMatch[1] : null
  };
}

function scoreRelevance(text, aliases, exclusions) {
  const hay = normalizeText(text);
  let positive = 0;
  let matched = new Set();

  for (const alias of aliases) {
    const toks = normalizeText(alias).split(" ").filter(x => x.length >= 3);
    for (const tok of toks) {
      if (hay.includes(tok)) {
        positive += 2;
        matched.add(tok);
      }
    }
  }

  let negative = 0;
  for (const x of exclusions.map(normalizeText).filter(Boolean)) {
    if (hay.includes(x)) negative += 4;
  }

  return {
    score: positive - negative,
    matched: [...matched]
  };
}

function hostName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
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
  const html = await r.text();
  return { html, finalUrl: r.url };
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
  const context = await browser.newContext({
    userAgent: UA,
    locale: "it-IT"
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(1200);
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl };
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

function parseHtml(html, finalUrl, original, aliases, exclusions) {
  const $ = cheerio.load(html);

  $("script:not([type='application/ld+json']), style, noscript, svg").remove();

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").text().trim() ||
    original.title ||
    "";

  const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 120000);
  const allText = `${title} ${original.snippet || ""} ${bodyText}`;

  const rel = scoreRelevance(allText, aliases, exclusions);
  const textFields = extractTextFields(allText);

  const nodes = parseJsonLd($);
  const productNode = pickProductFromJsonLd(nodes, aliases);
  const offer = extractOffer(productNode);

  const metaPrice =
    num($('meta[property="product:price:amount"]').attr("content")) ??
    num($('meta[itemprop="price"]').attr("content")) ??
    null;

  let price = offer.price ?? metaPrice ?? textFields.price;
  let currency = offer.currency || $('meta[property="product:price:currency"]').attr("content") || (price ? "EUR" : null);

  const productName = productNode?.name || title;
  const brand =
    productNode?.brand?.name ||
    (typeof productNode?.brand === "string" ? productNode.brand : null) ||
    null;

  const sku = productNode?.sku || productNode?.gtin13 || productNode?.gtin || null;

  const availability = offer.availability || textFields.availabilityText || null;

  const evidenceBase = bodyText || original.snippet || "";
  const firstToken = normalizeText(aliases[0] || "").split(" ").find(x => x.length >= 3) || "";
  let pos = firstToken ? normalizeText(evidenceBase).indexOf(firstToken) : -1;
  if (pos < 0) pos = 0;
  const evidence = evidenceBase.slice(Math.max(0, pos - 180), Math.max(0, pos - 180) + 900);

  return {
    queryTitle: original.title || "",
    title: productName || title,
    url: finalUrl || original.url,
    domain: hostName(finalUrl || original.url),
    provider: original.provider || "",
    snippet: original.snippet || "",
    price,
    priceKg: textFields.priceKg,
    currency,
    format: textFields.format,
    promotion: textFields.promo,
    availability,
    brand,
    sku,
    detectedDate: textFields.detectedDate,
    relevanceScore: rel.score,
    matchedTokens: rel.matched,
    evidence,
    usedBrowser: false
  };
}

export async function analyzeResult(original, aliases, exclusions, allowBrowser = true) {
  let staticData = null;
  try {
    staticData = await fetchStatic(original.url);
  } catch {}

  if (staticData) {
    const parsed = parseHtml(staticData.html, staticData.finalUrl, original, aliases, exclusions);
    if (!allowBrowser || (parsed.relevanceScore >= 6 && (parsed.price !== null || parsed.priceKg !== null))) {
      return parsed;
    }
  }

  if (allowBrowser) {
    try {
      const rendered = await fetchRendered(original.url);
      if (rendered) {
        const parsed = parseHtml(rendered.html, rendered.finalUrl, original, aliases, exclusions);
        parsed.usedBrowser = true;
        return parsed;
      }
    } catch {}
  }

  if (staticData) {
    return parseHtml(staticData.html, staticData.finalUrl, original, aliases, exclusions);
  }

  const fallback = `${original.title || ""} ${original.snippet || ""}`;
  const rel = scoreRelevance(fallback, aliases, exclusions);
  const tf = extractTextFields(fallback);

  return {
    queryTitle: original.title || "",
    title: original.title || "",
    url: original.url,
    domain: hostName(original.url),
    provider: original.provider || "",
    snippet: original.snippet || "",
    price: tf.price,
    priceKg: tf.priceKg,
    currency: tf.price || tf.priceKg ? "EUR" : null,
    format: tf.format,
    promotion: tf.promo,
    availability: tf.availabilityText,
    brand: null,
    sku: null,
    detectedDate: tf.detectedDate,
    relevanceScore: rel.score,
    matchedTokens: rel.matched,
    evidence: original.snippet || "",
    usedBrowser: false
  };
}

export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}
