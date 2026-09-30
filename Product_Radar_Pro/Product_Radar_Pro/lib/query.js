const PRODUCE_SYNONYMS = new Map([
  ["mela", ["mele"]],
  ["mele", ["mela"]],
  ["golden", ["golden delicious"]],
  ["golden delicious", ["golden"]],
  ["kiwi", ["kiwifruit"]],
  ["pomodoro", ["pomodori"]],
  ["patata", ["patate"]],
  ["cipolla", ["cipolle"]],
  ["finocchio", ["finocchi"]]
]);

export function normalizeText(s = "") {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildAliases(product, manualAliases = []) {
  const set = new Set([product, ...manualAliases].filter(Boolean).map(x => x.trim()));
  const norm = normalizeText(product);

  for (const [key, vals] of PRODUCE_SYNONYMS.entries()) {
    if (norm.includes(key)) {
      for (const v of vals) {
        set.add(product.replace(new RegExp(key, "i"), v));
      }
    }
  }

  const words = product.trim().split(/\s+/);
  if (words.length >= 3 && /^(mela|mele|pera|pere|kiwi|uva|patata|patate|cipolla|cipolle|pomodoro|pomodori|finocchio|finocchi)$/i.test(words[0])) {
    set.add(words.slice(1).join(" "));
  }

  return [...set].filter(Boolean);
}

export function buildQueries(product, aliases = [], retailerDomains = [], maxPages = 20) {
  const seeds = buildAliases(product, aliases);
  const q = [];

  // Query pensate per trovare PAGINE COMMERCIALI, non pagine informative.
  q.push(`"${product}" prezzo`);
  q.push(`"${product}" offerta`);
  q.push(`"${product}" supermercato`);
  q.push(`"${product}" "spesa online"`);
  q.push(`"${product}" kg`);
  q.push(`"${product}" acquista`);

  if (seeds[1]) q.push(`"${seeds[1]}" prezzo kg`);
  if (seeds[2]) q.push(`"${seeds[2]}" supermercato`);

  // Query mirate ai retailer indicati dall'utente.
  for (const domain of retailerDomains.filter(Boolean).slice(0, 8)) {
    q.push(`site:${domain} "${product}"`);
    if (seeds[1]) q.push(`site:${domain} "${seeds[1]}"`);
  }

  const maxQueries = maxPages <= 10 ? 6 : maxPages <= 25 ? 10 : 14;
  return [...new Set(q)].slice(0, maxQueries);
}
