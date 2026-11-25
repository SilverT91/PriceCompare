// Word lists used by the matcher. Tokens are folded (lowercase, no diacritics) before lookup.
// "prefix" lists match any token that starts with the stem (for Slovak/Czech/Polish inflection).

export interface WordClass {
  exact: Set<string>;
  prefix: string[];
}

const wc = (exact: string[], prefix: string[] = []): WordClass => ({ exact: new Set(exact), prefix });

export function inClass(token: string, c: WordClass): boolean {
  if (c.exact.has(token)) return true;
  return c.prefix.some((p) => token.length >= p.length && token.startsWith(p));
}

/** Colour words -> canonical colour. Order matters for prefixes (longer stems first). */
export const COLOURS: [string, string, 'exact' | 'prefix'][] = [
  // [stem, canonical, mode]
  ['modrozelen', 'teal', 'prefix'], ['tyrkys', 'teal', 'prefix'], ['turkis', 'teal', 'prefix'], ['teal', 'teal', 'exact'],
  ['ultramarin', 'ultramarine', 'prefix'],
  ['cier', 'black', 'prefix'], ['cern', 'black', 'prefix'], ['schwarz', 'black', 'prefix'], ['black', 'black', 'exact'],
  ['czarn', 'black', 'prefix'], ['midnight', 'black', 'exact'], ['graphite', 'black', 'exact'], ['graphit', 'black', 'exact'],
  ['biel', 'white', 'prefix'], ['bil', 'white', 'exact'], ['bila', 'white', 'exact'], ['bily', 'white', 'exact'], ['bile', 'white', 'exact'],
  ['weiss', 'white', 'prefix'], ['white', 'white', 'exact'], ['bial', 'white', 'prefix'], ['starlight', 'white', 'exact'],
  ['hellblau', 'light blue', 'exact'], ['svetlomodr', 'light blue', 'prefix'], ['dunkelblau', 'dark blue', 'exact'], ['tmavomodr', 'dark blue', 'prefix'],
  ['modr', 'blue', 'prefix'], ['blau', 'blue', 'prefix'], ['blue', 'blue', 'exact'], ['niebiesk', 'blue', 'prefix'],
  ['ruzov', 'pink', 'prefix'], ['rosa', 'pink', 'exact'], ['pink', 'pink', 'exact'], ['rozow', 'pink', 'prefix'], ['rose', 'pink', 'exact'],
  ['zelen', 'green', 'prefix'], ['grun', 'green', 'exact'], ['gruen', 'green', 'exact'], ['green', 'green', 'exact'], ['zielon', 'green', 'prefix'],
  ['cerven', 'red', 'prefix'], ['rot', 'red', 'exact'], ['red', 'red', 'exact'], ['czerwon', 'red', 'prefix'],
  ['siv', 'grey', 'exact'], ['siva', 'grey', 'exact'], ['sivy', 'grey', 'exact'], ['sive', 'grey', 'exact'], ['sed', 'grey', 'exact'],
  ['seda', 'grey', 'exact'], ['sedy', 'grey', 'exact'], ['grau', 'grey', 'exact'], ['grey', 'grey', 'exact'], ['gray', 'grey', 'exact'], ['szar', 'grey', 'prefix'],
  ['striebr', 'silver', 'prefix'], ['stribr', 'silver', 'prefix'], ['silber', 'silver', 'exact'], ['silver', 'silver', 'exact'], ['srebrn', 'silver', 'prefix'],
  ['zlat', 'gold', 'prefix'], ['gold', 'gold', 'exact'], ['zlot', 'gold', 'prefix'],
  ['fialov', 'purple', 'prefix'], ['lila', 'purple', 'exact'], ['purple', 'purple', 'exact'], ['violet', 'purple', 'prefix'], ['fiolet', 'purple', 'prefix'],
  ['zlt', 'yellow', 'prefix'], ['zlut', 'yellow', 'prefix'], ['gelb', 'yellow', 'exact'], ['yellow', 'yellow', 'exact'], ['zolt', 'yellow', 'prefix'],
  ['oranz', 'orange', 'prefix'], ['orange', 'orange', 'exact'], ['pomarancz', 'orange', 'prefix'],
  ['bezov', 'beige', 'prefix'], ['beige', 'beige', 'exact'], ['bezow', 'beige', 'prefix'], ['wustensand', 'desert', 'exact'], ['desert', 'desert', 'exact'],
  ['titan', 'titanium', 'prefix'], ['natural', 'natural', 'exact'], ['natur', 'natural', 'exact'],
];

export function colourOf(token: string): string | null {
  for (const [stem, canonical, mode] of COLOURS) {
    if (mode === 'exact' ? token === stem : token.length >= stem.length && token.startsWith(stem)) return canonical;
  }
  return null;
}

// connectors / prepositions (sk, cs, de, pl, en)
const CONNECTOR_WORDS = [
  'a', 'i', 'o', 's', 'v', 'vo', 'z', 'ze', 'na', 'pre', 'do', 'od', 'und', 'mit', 'fur', 'fuer', 'for', 'the', 'of', 'and', 'with',
  'w', 'dla', 'inkl', 'incl', 'vcetne', 'vratane', 'x', 'by', 'in', 'im', 'der', 'die', 'das',
];
const CATEGORY_EXACT = [
  // phones
  'telefon', 'telefony', 'smartfon', 'smartfony', 'smartphone', 'handy', 'mobil', 'phone', 'dual', 'sim', 'esim', 'nano',
  '5g', '4g', 'lte', 'nfc', 'wifi', 'android',
  // toothbrushes
  'kefka', 'kefky', 'kefku', 'kefiek', 'kartacek', 'kartacky', 'kartacku', 'toothbrush', 'szczoteczka', 'zebow', 'elektryczna', 'elektryczny',
  // tools
  'aku', 'akku', 'vrtacka', 'vrtacky', 'skrutkovac', 'sroubovak', 'wiertarka', 'wkretarka', 'wiertarkowkretarka', 'drill', 'driver',
  'bohrschrauber', 'akkubohrschrauber', 'vrtaci', 'akumulator', 'akumulatorovy', 'akumulatorova',
];
// Line words that are part of many model names ("Bosch Professional", "Oral-B Professional Care",
// "Oral-B iO Series 9", which shops also write "iO 9" and "iO9").
const LINE_WORDS = ['professional', 'profesional', 'profi', 'series', 'serie', 'seria', 'serii'];
// generic shop and marketing words
const GENERIC_WORDS = [
  'nove', 'novy', 'nova', 'new', 'neu', 'neue', 'nowy', 'nowa', 'original', 'originalny', 'originalni', 'edition', 'edicia', 'edice',
  'model', 'verzia', 'verze', 'version', 'cashback', 'akcia', 'akce', 'darcek', 'zdarma', 'gratis', 'eu', 'sk', 'cz', 'de', 'pl', 'at',
  'distribucia', 'distribuce', 'cena', 'pri', 'nakupe', 'min', 'za', 'ks1', 'zaruka', 'zaruky', 'garancia', 'mesiacov', 'rokov', 'rok',
];
/** Brand tokens and how the brand is written (a corrected query uses this spelling). */
export const BRAND_SPELLING: Record<string, string> = {
  apple: 'Apple', samsung: 'Samsung', xiaomi: 'Xiaomi', google: 'Google', motorola: 'Motorola', nokia: 'Nokia', sony: 'Sony',
  huawei: 'Huawei', honor: 'Honor', oneplus: 'OnePlus', bosch: 'Bosch', makita: 'Makita', dewalt: 'DeWalt', metabo: 'Metabo',
  milwaukee: 'Milwaukee', einhell: 'Einhell', ryobi: 'Ryobi', stanley: 'Stanley', oralb: 'Oral-B', braun: 'Braun', philips: 'Philips',
  sonicare: 'Sonicare', panasonic: 'Panasonic', lg: 'LG', tefal: 'Tefal', rowenta: 'Rowenta', dyson: 'Dyson', electrolux: 'Electrolux',
  whirlpool: 'Whirlpool', nivea: 'Nivea', ikea: 'IKEA', lenovo: 'Lenovo', asus: 'Asus', acer: 'Acer', hp: 'HP', dell: 'Dell',
  jbl: 'JBL', garmin: 'Garmin',
};
/** Brand names: a brand word never tells two models of that brand apart, but it does name the product family. */
export const BRANDS = new Set(Object.keys(BRAND_SPELLING));
const CATEGORY_PREFIX = [
  'mobiln', 'telefo', 'smartf', 'chytr', 'inteligent', 'dotyk',
  'zubn', 'zahnburst', 'zahnbuerst', 'elektr', 'electr', 'oscil', 'rotac', 'rotier', 'rotuj', 'dospel', 'erwachs', 'osobn',
  'vrtack', 'skrutkov', 'sroubov', 'akumulator', 'bezuhl', 'bezuhlik',
];

/** Words that say nothing about which product it is: categories, connectors, marketing, specs. */
export const NEUTRAL = wc([...CONNECTOR_WORDS, ...CATEGORY_EXACT, ...LINE_WORDS, ...GENERIC_WORDS, ...BRANDS], CATEGORY_PREFIX);

/**
 * The part of NEUTRAL a model name can do without: category and shop words ("elektrická zubná
 * kefka", "akcia"). Brand, line and connector words are not in it.
 */
export const CATEGORY_WORDS = wc([...CATEGORY_EXACT, ...GENERIC_WORDS], CATEGORY_PREFIX);

/** Line words ("Professional", "Series"): neutral for matching, but part of a model's name. */
export const LINE_WORD_CLASS = wc(LINE_WORDS);

/** Tier/model words: a title with one the query lacks is a different model. */
export const MODEL_WORDS = wc(
  ['pro', 'plus', 'max', 'mini', 'ultra', 'lite', 'air', 'fe', 'neo', 'prime', 'slim', 'edge', 'fold', 'flip', 'note',
    'kids', 'kid', 'junior', 'jr', 'teen', 'child', 'children', 'deti', 'dzieci', 'fc', 'xl', 'xxl', 'compact', 'kompakt'],
  ['detsk', 'detsk', 'kinder', 'dzieci', 'dziec'],
);

/** Package/bundle words: a different package of the same model is a different product. */
export const PACKAGE_WORDS = wc(
  ['duo', 'duopack', 'trio', 'family', 'twin', 'twinpack', 'doppelpack', 'doppel', 'dvojbalenie', 'dvojbaleni', 'multipack',
    'pack', 'set', 'sada', 'sady', 'souprava', 'suprava', 'supravy', 'zestaw', 'kit', 'bundle', 'combo', 'komplet', 'solo', 'bez', 'ohne', 'bare', 'body',
    'lboxx', 'kufor', 'kufr', 'koffer', 'walizka', 'taska', 'tasche', 'travel', 'reise', 'cestovne', 'cestovni', 'cestovny', 'puzdrom',
    'dielna', 'dielny', 'dilna', 'dilny', 'teilig', 'tlg', 'czesciowy',
    // "s batériou", "s akumulátorom", "2 akumulátory", "mit Akkus": the battery is in the box
    'bateriou', 'bateriami', 'baterii', 'akumulatorom', 'akumulatormi', 'akumulatory', 'akumulatorami', 'akkus', 'akumulatorem'],
  ['prislusenst', 'prislusenst', 'zubehor', 'akcesori'],
);

/**
 * One word for a pack of two, however it is written: "duo", "duopack", "doublepack", "twinpack",
 * "doppelpack", "dvojbalenie" are all "duo". The matcher also reads the two-word forms ("Duo Pack",
 * "double pack") this way (matcher.ts, packTokens).
 */
const TWO_PACK_WORDS = new Set(['duo', 'duopack', 'doublepack', 'twinpack', 'doppelpack', 'dvojbalenie', 'dvojbaleni']);
export const twoPack = (token: string): string => (TWO_PACK_WORDS.has(token) ? 'duo' : token);

/**
 * Package words that only say "a set" without saying which ("Súprava ... Duo Pack"): next to the
 * two-pack word they add nothing. Not in it: words for another package (trio, family, multipack,
 * "kit", which for tools means with batteries, cases), the "without" words (solo, bez, ohne, bare,
 * body) and battery words.
 */
export const GENERIC_SET_WORDS = new Set(['set', 'sada', 'sady', 'souprava', 'suprava', 'supravy', 'zestaw', 'bundle', 'combo', 'komplet', 'pack']);

/** Accessory/spare-part words: the title is for a part, not the product itself. */
export const ACCESSORY_WORDS = wc(
  ['hlavice', 'hlavica', 'hlavic', 'heads', 'refill', 'kryt', 'puzdro', 'pouzdro', 'obal', 'case', 'hulle', 'cover', 'etui',
    'folia', 'folie', 'sklo', 'glass', 'protector', 'charger', 'kabel', 'cable', 'adapter', 'drziak', 'drzak', 'stojan',
    'halter', 'stand', 'koncovky', 'koncovka', 'nastavec', 'nastavce', 'bit', 'bity', 'vrtaky', 'vrtak', 'kotuc', 'baterie'],
  ['nahradn', 'aufsteck', 'nabijac', 'nabijec', 'ladeger', 'ladowark', 'ochrann', 'tvrden', 'koncov', 'koncowk', 'naplne', 'ersatz'],
);

/** Used / refurbished / unpacked / damaged markers. */
export const CONDITION_WORDS: [RegExp, 'used' | 'refurbished' | 'damaged' | 'unknown_used'][] = [
  [/^(refurbished|refurb|renewed|repasovan\w*|generalkovan\w*|odnowion\w*|obnoven\w*|wiederaufbereitet\w*|generalüberholt)$/, 'refurbished'],
  // The adjective "použitý / použitá / použité ..." (sk, cs), not the noun "použitie / použití" ("Použitie:
  // Pre dospelých" = use: for adults) or the verb "použiť / použít".
  [/^(pouzit(?:y|a|e|eho|ej|emu|u|om|ou|em|ych|ym|ymi)|pouzivan\w*|gebraucht\w*|uzywan\w*|used|secondhand|bazar\w*|bazarov\w*)$/, 'used'],
  [/^(rozbalen\w*|vystaven\w*|powystawow\w*|bware|outlet|demo|vratene|vraceno|vratenie)$/, 'unknown_used'],
  [/^(poskoden\w*|poskozen\w*|kozmetick\w*|kosmetick\w*|uszkodzon\w*|beschadigt\w*|damaged|defekt\w*)$/, 'damaged'],
];

export function conditionOfToken(token: string): 'used' | 'refurbished' | 'damaged' | 'unknown_used' | null {
  for (const [re, c] of CONDITION_WORDS) if (re.test(token)) return c;
  return null;
}

/** Units whose value defines a separate variant (storage, volume, battery capacity). */
export const VARIANT_UNITS = /^\d+(?:\.\d+)?(gb|tb|mb|ml|l|g|kg|mah|ah|wh|w|v)$/;
/** Units that are specs, not variants (screen size). */
export const NEUTRAL_UNITS = /^\d+(?:\.\d+)?(in|mm|cm|m)$/;
