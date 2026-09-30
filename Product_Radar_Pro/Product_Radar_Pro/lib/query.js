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

export function buildQueries(product, aliases = [], retailerDomains = [], maxResults = 20, gdoExtended = true) {
  const seeds = buildAliases(product, aliases);
  const q = [];

  // Query commerciali generiche
  q.push(`"${product}" prezzo`);
  q.push(`"${product}" "al kg"`);
  q.push(`"${product}" offerta supermercato`);
  q.push(`"${product}" "spesa online"`);
  q.push(`"${product}" acquista`);
  q.push(`"${product}" confezione kg`);
  q.push(`"${product}" volantino`);
  q.push(`"${product}" e-commerce`);

  if (seeds[1]) q.push(`"${seeds[1]}" prezzo kg`);
  if (seeds[2]) q.push(`"${seeds[2]}" supermercato`);

  // Domini forniti dall'utente: massima priorità.
  for (const domain of retailerDomains.filter(Boolean).slice(0, 10)) {
    q.push(`site:${domain} "${product}"`);
  }

  // Ricerca GDO estesa: una query per retailer.
  if (gdoExtended) {
    const chosen = KNOWN_RETAILERS.filter(d => !retailerDomains.includes(d));
    for (const domain of chosen) {
      q.push(`site:${domain} "${product}"`);
    }
  }

  // Con GDO estesa arriviamo fino a ~25 query, accettabile con Serper.
  const maxQueries = gdoExtended ? 26 : (maxResults <= 10 ? 8 : maxResults <= 25 ? 12 : 16);
  return [...new Set(q)].slice(0, maxQueries);
}
