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

export async function searchBrave(query, count = 20) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(count, 20)));
    url.searchParams.set("country", "it");
    url.searchParams.set("search_lang", "it");
    const r = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": key
      }
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.web?.results || []).map(x => ({
      title: x.title || "",
      url: x.url || "",
      snippet: x.description || "",
      provider: "Brave"
    }));
  } catch {
    return [];
  }
}

export async function searchSerper(query, count = 20) {
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
        num: Math.min(count, 20)
      })
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.organic || []).map(x => ({
      title: x.title || "",
      url: x.link || "",
      snippet: x.snippet || "",
      provider: "Google/Serper"
    }));
  } catch {
    return [];
  }
}

export async function searchDuckDuckGo(query, count = 20) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.6"
      },
      redirect: "follow"
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

export async function searchBing(query, count = 20) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=it&setlang=it`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.6"
      }
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

export async function multiSearch(query, count = 20) {
  const providers = [
    searchBrave(query, count),
    searchSerper(query, count),
    searchDuckDuckGo(query, count),
    searchBing(query, count)
  ];

  const results = (await Promise.allSettled(providers))
    .flatMap(x => x.status === "fulfilled" ? x.value : []);

  const seen = new Set();
  const out = [];
  for (const item of results) {
    if (!item.url) continue;
    const key = item.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, count * 3);
}
