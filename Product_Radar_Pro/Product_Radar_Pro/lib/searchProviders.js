import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36";

function cleanUrl(raw = "") {
  try {
    if (raw.includes("uddg=")) {
      const u = new URL(raw, "https://duckduckgo.com");
      return decodeURIComponent(u.searchParams.get("uddg") || raw);
    }
  } catch {}
  return raw;
}

async function safeJsonResponse(r) {
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 180)}`);
  if (!ct.includes("application/json")) {
    throw new Error(`Risposta non JSON (${ct || "content-type assente"}): ${text.slice(0, 180)}`);
  }
  return JSON.parse(text);
}

export async function testSerper(query = "Mela Golden Melinda") {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { ok: false, error: "SERPER_API_KEY non configurata" };

  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: query,
      gl: "it",
      hl: "it",
      num: 10
    }),
    signal: AbortSignal.timeout(12000)
  });

  const data = await safeJsonResponse(r);
  return {
    ok: true,
    organicCount: Array.isArray(data.organic) ? data.organic.length : 0,
    first: (data.organic || []).slice(0, 3).map(x => ({
      title: x.title,
      link: x.link,
      snippet: x.snippet
    }))
  };
}

export async function searchSerper(query, count = 10) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];

  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: query,
        gl: "it",
        hl: "it",
        num: Math.min(count, 10)
      }),
      signal: AbortSignal.timeout(12000)
    });

    const data = await safeJsonResponse(r);
    return (data.organic || []).map(x => ({
      title: x.title || "",
      url: x.link || "",
      snippet: x.snippet || "",
      provider: "Google/Serper"
    }));
  } catch (e) {
    console.error("SERPER_ERROR", query, e?.message || e);
    return [];
  }
}

export async function searchDuckDuckGo(query, count = 10) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return [];
    const html = await r.text();
    const $ = cheerio.load(html);
    const out = [];
    $(".result").each((_, el) => {
      if (out.length >= count) return;
      const a = $(el).find(".result__a").first();
      const title = a.text().trim();
      const href = cleanUrl(a.attr("href") || "");
      const snippet = $(el).find(".result__snippet").text().trim();
      if (title && href) out.push({ title, url: href, snippet, provider: "DuckDuckGo" });
    });
    return out;
  } catch {
    return [];
  }
}

export async function searchBing(query, count = 10) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=it&setlang=it`;
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "it-IT,it;q=0.9" },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return [];
    const html = await r.text();
    const $ = cheerio.load(html);
    const out = [];
    $("li.b_algo").each((_, el) => {
      if (out.length >= count) return;
      const a = $(el).find("h2 a").first();
      const title = a.text().trim();
      const href = a.attr("href") || "";
      const snippet = $(el).find(".b_caption p").first().text().trim();
      if (title && href) out.push({ title, url: href, snippet, provider: "Bing" });
    });
    return out;
  } catch {
    return [];
  }
}

export async function multiSearch(query, count = 10) {
  let results = [];

  // Se Serper è configurato, usa Google/Serper come sorgente principale.
  if (process.env.SERPER_API_KEY) {
    results = await searchSerper(query, count);
  } else {
    const fallbacks = await Promise.allSettled([
      searchDuckDuckGo(query, count),
      searchBing(query, count)
    ]);
    results = fallbacks.flatMap(x => x.status === "fulfilled" ? x.value : []);
  }

  const seen = new Set();
  const out = [];
  for (const item of results) {
    if (!item.url) continue;
    const key = item.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, count);
}
