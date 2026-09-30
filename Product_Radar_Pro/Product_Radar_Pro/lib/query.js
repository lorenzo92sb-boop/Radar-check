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
  ["limone", ["limoni"]],
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

  // Variante utile: rimuove una parola generica iniziale (mela, mele, kiwi, ecc.).
  const words = product.trim().split(/\s+/);
  if (words.length >= 3 && /^(mela|mele|pera|pere|kiwi|uva|patata|patate|cipolla|cipolle|pomodoro|pomodori|finocchio|finocchi)$/i.test(words[0])) {
    set.add(words.slice(1).join(" "));
  }

  return [...set].filter(Boolean);
}

export function buildQueries(product, aliases, retailerDomains = []) {
  const all = new Set();
  const seeds = buildAliases(product, aliases);

  for (const seed of seeds) {
    const q = `"${seed}"`;
    all.add(`${q} prezzo`);
    all.add(`${q} offerta`);
    all.add(`${q} supermercato`);
    all.add(`${q} "spesa online"`);
    all.add(`${q} volantino`);
    all.add(`${q} shop`);
  }

  for (const domain of retailerDomains.filter(Boolean)) {
    for (const seed of seeds.slice(0, 3)) {
      all.add(`site:${domain} "${seed}"`);
    }
  }

  return [...all].slice(0, 60);
}
