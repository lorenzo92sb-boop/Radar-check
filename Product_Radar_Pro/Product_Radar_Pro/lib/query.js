const PRODUCE_SYNONYMS = new Map([
  ["mela", ["mele"]],
  ["mele", ["mela"]],
  ["golden", ["golden delicious"]],
  ["golden delicious", ["golden"]],
  ["kiwi", ["kiwifruit"]],
  ["pomodoro", ["pomodori"]],
  ["patata", ["patate"]],
  ["cipolla", ["cipolle"]],
  ["finocchio", ["finocchi"]],
  ["arancia", ["arance"]],
  ["limone", ["limoni"]]
]);

export const KNOWN_RETAILERS = [
  "carrefour.it",
  "conad.it",
  "coop.it",
  "bennet.com",
  "despar.it",
  "esselunga.it",
  "famila.it",
  "iper.it",
  "pamretailpro.it",
  "tigros.it",
  "decoacasa.multicedi.it",
  "penny.it",
  "mdspa.it",
  "lidl.it",
  "eurospin.it"
];

export function normalizeText(s = "") {
  return String(s)
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
        const rx = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        set.add(product.replace(rx, v));
      }
    }
  }

  const words = product.trim().split(/\s+/);
  if (
    words.length >= 3 &&
    /^(mela|mele|pera|pere|kiwi|uva|patata|patate|cipolla|cipolle|pomodoro|pomodori|finocchio|finocchi)$/i.test(words[0])
  ) {
    set.add(words.slice(1).join(" "));
  }

  return [...set].filter(Boolean);
}

function strongestAlias(product, aliases) {
  const all = buildAliases(product, aliases);
  // Preferisce una variante senza il sostantivo generico iniziale:
  // "Golden Melinda" invece di "Mela Golden Melinda".
  const shorter = all
    .filter(x => normalizeText(x).split(" ").length >= 2)
    .sort((a, b) => a.length - b.length);
  return shorter[0] || product;
}

export function buildQueries(product, aliases = [], retailerDomains = [], maxResults = 20, gdoExtended = true) {
  const seeds = buildAliases(product, aliases);
  const retailAlias = strongestAlias(product, aliases);
  const q = [];

  q.push(`"${product}" prezzo`);
  q.push(`"${product}" "al kg"`);
  q.push(`"${product}" offerta supermercato`);
  q.push(`"${product}" "spesa online"`);
  q.push(`"${product}" acquista`);
  q.push(`"${product}" confezione kg`);
  q.push(`"${retailAlias}" prezzo`);
  q.push(`"${retailAlias}" supermercato`);
  q.push(`"${retailAlias}" offerta`);
  q.push(`"${retailAlias}" "spesa online"`);

  if (seeds[1]) q.push(`"${seeds[1]}" prezzo kg`);

  for (const domain of retailerDomains.filter(Boolean).slice(0, 10)) {
    q.push(`site:${domain} "${retailAlias}"`);
  }

  if (gdoExtended) {
    const chosen = KNOWN_RETAILERS.filter(d => !retailerDomains.includes(d));
    for (const domain of chosen) {
      // Non usare la frase troppo restrittiva "Mela Golden Melinda":
      // molti retailer indicizzano "Mele Golden Melinda", "Golden Melinda", ecc.
      q.push(`site:${domain} "${retailAlias}"`);
    }
  }

  const maxQueries = gdoExtended ? 28 : (maxResults <= 10 ? 8 : maxResults <= 25 ? 12 : 16);
  return [...new Set(q)].slice(0, maxQueries);
}
