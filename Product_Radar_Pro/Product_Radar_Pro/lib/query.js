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

const DEFAULT_GDO_GROUPS = [
  ["carrefour.it", "conad.it", "coop.it", "bennet.com", "despar.it"],
  ["esselunga.it", "pamretailpro.it", "tigros.it", "iper.it", "famila.it"],
  ["decoacasa.multicedi.it", "penny.it", "mdspa.it", "lidl.it", "eurospin.it"]
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

function siteGroupQuery(product, domains) {
  const parts = domains.map(d => `site:${d}`).join(" OR ");
  return `"${product}" (${parts})`;
}

export function buildQueries(product, aliases = [], retailerDomains = [], maxResults = 20) {
  const seeds = buildAliases(product, aliases);
  const q = [];

  // Ricerca commerciale generica
  q.push(`"${product}" prezzo`);
  q.push(`"${product}" "al kg"`);
  q.push(`"${product}" offerta supermercato`);
  q.push(`"${product}" "spesa online"`);
  q.push(`"${product}" acquista shop`);
  q.push(`"${product}" confezione kg`);

  if (seeds[1]) q.push(`"${seeds[1]}" prezzo kg`);
  if (seeds[2]) q.push(`"${seeds[2]}" supermercato offerta`);

  // GDO principali: poche query di gruppo, molto più efficienti di 15 query singole.
  for (const group of DEFAULT_GDO_GROUPS) {
    q.push(siteGroupQuery(product, group));
  }

  // Domini scelti dall'utente: priorità alta.
  for (const domain of retailerDomains.filter(Boolean).slice(0, 8)) {
    q.push(`site:${domain} "${product}"`);
    if (seeds[1]) q.push(`site:${domain} "${seeds[1]}"`);
  }

  const maxQueries = maxResults <= 10 ? 8 : maxResults <= 25 ? 12 : 16;
  return [...new Set(q)].slice(0, maxQueries);
}
