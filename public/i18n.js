// Page texts in English and Slovak, and number formats. Plain script, no build step: it defines
// window.I18N before app.js runs. The static texts of index.html carry data-i18n (text),
// data-i18n-placeholder, data-i18n-aria-label or data-i18n-title attributes naming a key below;
// app.js takes everything it writes from here too.
//
// This file holds the Slovak wording of everything the page itself writes. Sentences the server
// builds for a search (shop details, delivery and pickup notes) are in src/core/i18n.ts, and the
// Slovak shop notes in data/shops.sk.yaml.
//
// Language: ?lang=sk|en in the address, else the one chosen before (localStorage), else Slovak when
// the browser's language starts with "sk" or "cs", else English.

(function () {
  const NBSP = ' ';
  /** Slovak plural: 1 -> one, 2 to 4 -> few, 0 and 5 and more -> many. */
  const pl = (n, one, few, many) => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
  const qq = (s) => `„${s}“`;
  const quoted = (xs) => xs.map(qq).join(', ');
  const COND_SK = { used: 'použitý', refurbished: 'repasovaný', damaged: 'poškodený', unknown_used: 'rozbalený / vystavený kus' };

  // City names in the Slovak locative ("v Košiciach"), by location id.
  const IN_CITY_SK = { kosice: 'v Košiciach' };

  const en = {
    // index.html
    langSwitch: 'Language',
    qPlaceholder: 'Product name or a link to it, e.g. Oral-B Pro 3 3000',
    qLabel: 'Product',
    near: 'Near',
    shopsLabel: 'Shops',
    compare: 'Compare',
    whichOne: 'Which one do you mean?',
    nearbyTitle: 'Similar models the shops list',
    nearbyFootnote: 'These models are listed by the shops. A price next to a model was read from one shop page (for at most a few models per search) and is not compared here; it may not be the same product, so check it. “Compare this model” starts a new search for it.',
    otherProducts: 'Other products the shops returned (not what you typed)',
    webShops: 'Web shops',
    comparisonFootnote: 'Prices in EUR at the ECB reference rate, original currency underneath. Totals are item price + pickup in the branch or delivery to Slovakia. Unknown shipping is shown as unknown and never counted as zero; offers with a known total come first. Shops that do not deliver to Slovakia are shown last and not ranked.',
    manualTitle: 'Not checked automatically: open these yourself',
    footer: 'Local tool. Honours robots.txt, waits 3 s between requests to a shop, never gets around bot protection.',

    // statuses of a shop (badges)
    status: {
      pending: 'searching…', ok: 'found', no_match: 'no match', blocked: 'blocked', robots_disallowed: 'robots.txt disallows',
      needs_js: 'needs a browser', needs_search_key: 'needs a search key', no_route: 'no automatic route', error: 'error',
      not_relevant: 'not asked',
    },
    // the status summary line (mirrors src/core/report.ts)
    summary: {
      ok: (n) => `${n} found`, no_match: (n) => `${n} no match`, blocked: (n) => `${n} blocked`,
      needs_js: (n) => `${n} need${n === 1 ? 's' : ''} a browser`, needs_search_key: (n) => `${n} need${n === 1 ? 's' : ''} a search key`,
      robots_disallowed: (n) => `${n} disallowed by robots.txt`, no_route: (n) => `${n} no automatic route`,
      error: (n) => `${n} error${n === 1 ? '' : 's'}`, not_relevant: (n) => `${n} not asked (not relevant)`,
    },
    fit: { exact: 'match', possible: 'possible match, check it', different: 'other product' },
    cond: { used: 'used', refurbished: 'refurbished', damaged: 'damaged', unknown_used: 'unpacked / ex-display' },
    // schema.org availability values; English shows the value with spaces ("In Stock")
    stock: {},
    // shop categories and the groups of the "Shops" menu (labels from the server in English)
    category: {},
    group: {},
    reason: {},
    colour: {},
    // the matcher's reasons by code (the same texts as src/core/i18n.ts, REASONS)
    matchReason: {
      codeStart: (p) => `"${p.token}" found only as the start of "${p.title}"`,
      nearSpelling: (p) => `"${p.token}" ~ "${p.title}"`,
      condition: (p) => `condition: ${p.condition}${p.words.length ? ` (${p.words.join(', ')})` : ''}`,
      insteadOf: (p) => `title has "${p.instead}" where the query has "${p.token}"`,
      titleLacks: (p) => `title lacks ${quotedEn(p.words)}`,
      titleHas: (p) => `title has ${quotedEn(p.words)} that the query lacks`,
      sameOrOlder: (p) => `title says "${p.before} ${p.after}" without "${p.token}": the same model or an older one`,
      variantNotInQuery: (p) => `variant ${p.words.join(', ')} not in the query`,
      extraWords: (p) => `check extra words: ${p.words.join(', ')}`,
    },

    // app.js
    asking: 'Asking the shops…',
    localTitle: (p) => `Shops with a branch in ${p.locName}`,
    fromLink: (p) => `Searched for "${p.query}" (from the link you pasted).`,
    linkShop: (p) => ` The link is to ${p.shop}, which is asked like every other shop.`,
    corrected: (p) => `Searched for "${p.query}" (you typed "${p.typed}"). `,
    asTyped: 'Search exactly as typed',
    searchAll: 'Search all shops instead',
    scope: (p) => `Shops asked: ${p.label}${p.reasons ? ` (guessed from the query: ${p.reasons})` : ''}. `,
    rates: (p) => `Exchange rates: ECB reference rates of ${p.date || 'today'} (${p.list}).`,
    rateItem: (p) => `1 € = ${p.rate} ${p.cur}`,
    ratesUnavailable: (p) => `Exchange rates unavailable (${p.error}); prices in other currencies have no EUR total.`,
    rejected: "This link does not contain the product's name, so nothing was searched. Type or paste the product's name instead.",
    connectionLost: 'Connection to the local server lost.',
    done: (p) => `Done: ${p.n} shops asked.`,
    checking: (p) => `Checking shops: ${p.finished} of ${p.n} finished…`,
    shopsSummary: (p) => `Shops: ${p.list || 'waiting…'}${p.done ? '' : ' (still searching)'}`,
    branchNotVerified: (p) => ` (${p.locName} branch not verified)`,
    none: 'none',
    heureka: 'Heureka.sk ↗',
    heurekaNote: 'comparator; never fetched by this app',
    branchIn: (p) => `branch in ${p.locName}`,
    productMeta: (p) => `${p.shops} shop${p.shops > 1 ? 's' : ''}, ${p.offers} offer${p.offers > 1 ? 's' : ''}, ${p.variants} variant${p.variants > 1 ? 's' : ''}`,
    nearbyNoneDone: 'No shop lists exactly what you typed. Similar models the shops list:',
    nearbyNoneSoFar: 'No shop has listed exactly what you typed so far. Similar models the shops list:',
    noProducts: 'No priced products found. Use the links below to check the shops yourself.',
    waiting: 'Waiting for shops…',
    nothingMatches: 'Nothing matches the query exactly or possibly; see the other products below.',
    nearbyIntro: 'No shop lists exactly what you typed; the products above are possible matches. Similar models the shops list:',
    nearbySummary: (p) => `Similar models the shops list (${p.total > p.n ? `the ${p.n} closest of ${p.total}` : p.n})`,
    // built from the model's arrays; English uses the server's text, which says the same
    differs: (p) => [p.distinguishing.length ? `has ${quotedEn(p.distinguishing)}` : null, p.missing.length ? `lacks ${quotedEn(p.missing)}` : null].filter(Boolean).join(', '),
    listedBy: 'Listed by ',
    nearbyBranch: (p) => ` (branch in ${p.locName})`,
    compareModel: 'Compare this model',
    seenPriceWarning: 'Price of this similar model, read from one shop page. It may not be the same product: check it.',
    seenAt: ' at ',
    seller: (p) => `seller: ${p.seller}`,
    noDelivery: 'does not deliver to Slovakia',
    deliveryNotVerified: 'delivery to SK not verified',
    unknown: 'unknown',
    free: 'free',
    notRanked: 'not ranked',
    open: 'open ↗',
    noOffers: 'No offers for this product.',
    head: { shop: 'Shop', variant: 'Variant', item: 'Item', pickup: 'Pickup', pickupTotal: 'Pickup total', delivered: 'Delivered', deliveryToSk: 'Delivery to SK', total: 'Total', stock: 'Stock', match: 'Match' },
    comparison: (p) => `Comparison: ${p.title}`,
    offers: (p) => ` · ${p.n} offer${p.n > 1 ? 's' : ''}`,
    noPriceReachesSk: 'no price that reaches Slovakia',
    from: (p) => `from ${p.price}${p.known ? '' : ' + shipping?'}`,
    knownTotalFrom: (p) => ` · known total from ${p.price}`,
    cheapestKnownTotal: (p) => `cheapest known total ${p.price}${p.shop ? ` (${p.shop}${p.pickup ? ', pickup' : ''})` : ''}`,
    noKnownTotal: 'no known total',
    colourNotStated: 'colour not stated',
    // product notes (mirror src/core/group.ts, groupNotes)
    noteNoDelivery: (p) => `${p.n} offer${p.n > 1 ? 's' : ''} from shops that do not deliver to Slovakia (not ranked)`,
    noteGtins: (p) => `${p.n} GTIN${p.n > 1 ? 's' : ''}`,
    noteMixed: 'some offers only possibly match: check them',
    noteSomeByName: 'some offers grouped by name only (no GTIN)',
    noteAllByName: 'grouped by name only (no GTIN)',
    // web search credit bars (GET /api/usage)
    usageTitle: 'Web search credit',
    usageCount: (p) => `${p.used} / ${p.limit} ${p.period === 'total' ? 'in total' : 'this month'}`,
    usageValueText: (p) => `${p.used} of ${p.limit} credits used ${p.period === 'total' ? 'in total' : 'this month'}${p.exhausted ? ', used up' : ''}`,
    usageExhausted: 'used up',
    usageFromProvider: 'as reported by the provider',
    usageNote: 'Credits this app used for its own searches; use of the same key elsewhere is not counted.',
    usageNoteProvider: 'Credits this app used for its own searches, except where marked as reported by the provider.',
    usageNoKey: 'Runs without a web search key.',
  };
  function quotedEn(xs) { return xs.map((x) => `"${x}"`).join(', '); }

  const sk = {
    langSwitch: 'Jazyk',
    qPlaceholder: 'Názov produktu alebo odkaz naň, napr. Oral-B Pro 3 3000',
    qLabel: 'Produkt',
    near: 'Mesto',
    shopsLabel: 'Obchody',
    compare: 'Porovnať',
    whichOne: 'Ktorý produkt máte na mysli?',
    nearbyTitle: 'Podobné modely, ktoré obchody ponúkajú',
    nearbyFootnote: 'Tieto modely ponúkajú obchody. Cena pri modeli je prevzatá z jednej stránky obchodu (v jednom hľadaní najviac pri niekoľkých modeloch) a tu sa neporovnáva; nemusí ísť o ten istý produkt, preto si ju overte. Tlačidlo „Porovnať tento model“ spustí nové hľadanie tohto modelu.',
    otherProducts: 'Ďalšie produkty, ktoré obchody našli (nie to, čo ste zadali)',
    webShops: 'Internetové obchody',
    comparisonFootnote: 'Ceny sú v eurách podľa referenčného kurzu ECB, pod nimi je pôvodná mena. Cena spolu je cena tovaru a osobného odberu v predajni alebo doručenia na Slovensko. Neznáma doprava sa uvádza ako neznáma a nikdy sa nepočíta ako nula; ponuky so známou cenou spolu sú prvé. Obchody, ktoré nedoručujú na Slovensko, sú uvedené na konci, mimo poradia.',
    manualTitle: 'Neoverené automaticky: otvorte si sami',
    footer: 'Lokálny nástroj. Rešpektuje robots.txt, medzi požiadavkami na jeden obchod čaká 3 s a nikdy neobchádza ochranu proti robotom.',

    status: {
      pending: 'hľadá sa…', ok: 'nájdené', no_match: 'bez zhody', blocked: 'blokované', robots_disallowed: 'robots.txt nepovoľuje',
      needs_js: 'vyžaduje prehliadač', needs_search_key: 'chýba kľúč vyhľadávania', no_route: 'bez automatického hľadania', error: 'chyba',
      not_relevant: 'mimo výberu',
    },
    summary: {
      ok: (n) => `${n} ${pl(n, 'nájdený', 'nájdené', 'nájdených')}`, no_match: (n) => `${n} bez zhody`,
      blocked: (n) => `${n} ${pl(n, 'blokovaný', 'blokované', 'blokovaných')}`,
      needs_js: (n) => `${n} ${pl(n, 'vyžaduje', 'vyžadujú', 'vyžaduje')} prehliadač`, needs_search_key: (n) => `${n} bez kľúča vyhľadávania`,
      robots_disallowed: (n) => `${n} s obmedzením v robots.txt`, no_route: (n) => `${n} bez automatického hľadania`,
      error: (n) => `${n} ${pl(n, 'chyba', 'chyby', 'chýb')}`, not_relevant: (n) => `${n} mimo výberu (iný sortiment)`,
    },
    fit: { exact: 'zhoda', possible: 'možná zhoda, overte ju', different: 'iný produkt' },
    cond: { used: 'použitý', refurbished: 'repasovaný', damaged: 'poškodený', unknown_used: 'rozbalený / vystavený kus' },
    stock: {
      InStock: 'Skladom', OutOfStock: 'Nie je skladom', LimitedAvailability: 'Obmedzená dostupnosť', InStoreOnly: 'Len v predajni',
      OnlineOnly: 'Len online', PreOrder: 'Predobjednávka', PreSale: 'Predpredaj', BackOrder: 'Na objednávku', SoldOut: 'Vypredané',
      Discontinued: 'Už sa nepredáva', MadeToOrder: 'Na zákazku', Reserved: 'Rezervované',
    },
    category: {
      electronics: 'elektronika', appliances: 'spotrebiče', tools: 'náradie', diy_garden: 'dielňa a záhrada', drugstore: 'drogéria',
      pharmacy: 'lekáreň', beauty: 'kozmetika', furniture: 'nábytok', home: 'domácnosť', books: 'knihy', grocery: 'potraviny',
      general: 'všeobecný sortiment',
    },
    group: {
      auto: 'Podľa hľadania', all: 'Všetky obchody', electronics: 'Elektronika a spotrebiče', tools: 'Náradie, dielňa a záhrada',
      health: 'Drogéria, lekáreň a kozmetika', home: 'Nábytok a domácnosť', books: 'Knihy',
    },
    // why a category was guessed, by the rule id in src/core/categories.ts (CategoryChoice.reasonIds);
    // English uses the server's text
    reason: {
      toothbrush_shaver: 'elektrická zubná kefka / holiaci strojček',
      phone_computer_av: 'telefón / počítač / audio a video',
      pc_part: 'počítačový komponent / príslušenstvo',
      household_appliance: 'domáci spotrebič',
      power_tool: 'elektrické náradie / dielňa',
      drugstore: 'drogéria / kozmetika / lekáreň',
      furniture_home: 'nábytok / domácnosť',
      book: 'kniha',
      brand_electronics: 'značka Apple / Samsung / Sony / LG',
      brand_bosch: 'značka Bosch (náradie a spotrebiče)',
      brand_braun: 'značka Braun',
      brand_pc: 'značka počítačových komponentov a príslušenstva',
      brand_robot_vacuum: 'značka Roborock / iRobot / Ecovacs / Dreame (robotické vysávače)',
      no_hint: 'bez náznaku v hľadanom výraze: všetky obchody',
      all_chosen: 'všetky obchody (zvolené)',
    },
    // the matcher's reasons by code (the same texts as src/core/i18n.ts, REASONS)
    matchReason: {
      codeStart: (p) => `${qq(p.token)} sa našlo len ako začiatok ${qq(p.title)}`,
      nearSpelling: (p) => `${qq(p.token)} ~ ${qq(p.title)} (podobný zápis)`,
      condition: (p) => `stav: ${COND_SK[p.condition] || p.condition}${p.words.length ? ` (${p.words.join(', ')})` : ''}`,
      insteadOf: (p) => `v názve je ${qq(p.instead)} namiesto ${qq(p.token)}`,
      titleLacks: (p) => `v názve chýba ${quoted(p.words)}`,
      titleHas: (p) => `v názve je navyše ${quoted(p.words)}`,
      sameOrOlder: (p) => `v názve je ${qq(`${p.before} ${p.after}`)} bez ${qq(p.token)}: ten istý model alebo starší`,
      variantNotInQuery: (p) => `variant ${p.words.join(', ')} nie je v hľadanom výraze`,
      extraWords: (p) => `overte ďalšie slová: ${p.words.join(', ')}`,
    },
    // canonical colours of src/core/vocab.ts
    colour: {
      teal: 'tyrkysová', ultramarine: 'ultramarínová', black: 'čierna', white: 'biela', 'light blue': 'svetlomodrá', 'dark blue': 'tmavomodrá',
      blue: 'modrá', pink: 'ružová', green: 'zelená', red: 'červená', grey: 'sivá', silver: 'strieborná', gold: 'zlatá', purple: 'fialová',
      yellow: 'žltá', orange: 'oranžová', beige: 'béžová', desert: 'púštna', titanium: 'titánová', natural: 'prírodná',
    },

    asking: 'Prehľadávame obchody…',
    localTitle: (p) => `Obchody s pobočkou ${p.inCity}`,
    fromLink: (p) => `Hľadali sme ${qq(p.query)} (podľa vloženého odkazu).`,
    linkShop: (p) => ` Odkaz vedie do obchodu ${p.shop}, ktorý prehľadávame rovnako ako ostatné.`,
    corrected: (p) => `Hľadali sme ${qq(p.query)} (zadali ste ${qq(p.typed)}). `,
    asTyped: 'Hľadať presne tak, ako ste zadali',
    searchAll: 'Hľadať vo všetkých obchodoch',
    scope: (p) => `Prehľadávané obchody: ${p.label}${p.reasons ? ` (odhad podľa hľadaného výrazu: ${p.reasons})` : ''}. `,
    rates: (p) => (p.date ? `Výmenné kurzy: referenčné kurzy ECB z ${p.date} (${p.list}).` : `Výmenné kurzy: dnešné referenčné kurzy ECB (${p.list}).`),
    rateItem: (p) => `1${NBSP}€ = ${p.rate} ${p.cur}`,
    ratesUnavailable: (p) => `Výmenné kurzy nie sú k dispozícii (${p.error}); ceny v iných menách nemajú cenu v eurách.`,
    rejected: 'Tento odkaz neobsahuje názov produktu, preto sa nič nehľadalo. Zadajte alebo vložte namiesto neho názov produktu.',
    connectionLost: 'Spojenie s lokálnym serverom sa prerušilo.',
    done: (p) => `Hotovo: prehľadali sme ${p.n} ${pl(p.n, 'obchod', 'obchody', 'obchodov')}.`,
    checking: (p) => `Prehľadávame obchody: hotovo ${p.finished} z ${p.n}…`,
    shopsSummary: (p) => `Obchody: ${p.list || 'čaká sa…'}${p.done ? '' : ' (hľadanie pokračuje)'}`,
    branchNotVerified: (p) => ` (pobočka ${p.inCity} neoverená)`,
    none: 'žiadne',
    heureka: 'Heureka.sk ↗',
    heurekaNote: 'porovnávač cien; táto aplikácia z neho nič nenačítava',
    branchIn: (p) => `pobočka ${p.inCity}`,
    productMeta: (p) => `${p.shops} ${pl(p.shops, 'obchod', 'obchody', 'obchodov')}, ${p.offers} ${pl(p.offers, 'ponuka', 'ponuky', 'ponúk')}, ${p.variants} ${pl(p.variants, 'variant', 'varianty', 'variantov')}`,
    nearbyNoneDone: 'Presne to, čo ste zadali, žiadny obchod neponúka. Podobné modely, ktoré obchody ponúkajú:',
    nearbyNoneSoFar: 'Zatiaľ žiadny obchod neponúka presne to, čo ste zadali. Podobné modely, ktoré obchody ponúkajú:',
    noProducts: 'Nenašli sa žiadne produkty s cenou. Obchody si overte sami cez odkazy nižšie.',
    waiting: 'Čakáme na obchody…',
    nothingMatches: 'Hľadaniu nič nezodpovedá presne ani približne; pozrite si ďalšie produkty nižšie.',
    nearbyIntro: 'Presne to, čo ste zadali, žiadny obchod neponúka; produkty vyššie sú možné zhody. Podobné modely, ktoré obchody ponúkajú:',
    nearbySummary: (p) => `Podobné modely, ktoré obchody ponúkajú (${p.total > p.n ? `${p.n} najbližších z ${p.total}` : p.n})`,
    differs: (p) => [p.distinguishing.length ? `navyše ${quoted(p.distinguishing)}` : null, p.missing.length ? `chýba ${quoted(p.missing)}` : null].filter(Boolean).join(', '),
    listedBy: 'V ponuke: ',
    nearbyBranch: (p) => ` (pobočka ${p.inCity})`,
    compareModel: 'Porovnať tento model',
    seenPriceWarning: 'Cena tohto podobného modelu z jednej stránky obchodu. Nemusí ísť o ten istý produkt: overte si ju.',
    seenAt: ' v obchode ',
    seller: (p) => `predajca: ${p.seller}`,
    noDelivery: 'nedoručuje na Slovensko',
    deliveryNotVerified: 'doručenie na Slovensko neoverené',
    unknown: 'neznáme',
    free: 'zadarmo',
    notRanked: 'mimo poradia',
    open: 'otvoriť ↗',
    noOffers: 'K tomuto produktu nie sú žiadne ponuky.',
    head: { shop: 'Obchod', variant: 'Variant', item: 'Cena tovaru', pickup: 'Osobný odber', pickupTotal: 'Spolu s odberom', delivered: 'S doručením', deliveryToSk: 'Doprava na SK', total: 'Spolu', stock: 'Dostupnosť', match: 'Zhoda' },
    comparison: (p) => `Porovnanie: ${p.title}`,
    offers: (p) => ` · ${p.n} ${pl(p.n, 'ponuka', 'ponuky', 'ponúk')}`,
    noPriceReachesSk: 'žiadna cena s doručením na Slovensko',
    from: (p) => `od ${p.price}${p.known ? '' : ' + doprava?'}`,
    knownTotalFrom: (p) => ` · známa cena spolu od ${p.price}`,
    cheapestKnownTotal: (p) => `najnižšia známa cena spolu ${p.price}${p.shop ? ` (${p.shop}${p.pickup ? ', osobný odber' : ''})` : ''}`,
    noKnownTotal: 'cena spolu nie je známa',
    colourNotStated: 'farba neuvedená',
    noteNoDelivery: (p) => `${p.n} ${pl(p.n, 'ponuka', 'ponuky', 'ponúk')} z obchodov, ktoré nedoručujú na Slovensko (mimo poradia)`,
    noteGtins: (p) => `${p.n} ${pl(p.n, 'kód', 'kódy', 'kódov')} GTIN`,
    noteMixed: 'niektoré ponuky sa zhodujú len možno: overte ich',
    noteSomeByName: 'niektoré ponuky sú zoskupené len podľa názvu (bez GTIN)',
    noteAllByName: 'zoskupené len podľa názvu (bez GTIN)',
    usageTitle: 'Kredit webového vyhľadávania',
    usageCount: (p) => `${p.used} / ${p.limit} ${p.period === 'total' ? 'celkovo' : 'tento mesiac'}`,
    usageValueText: (p) => `využité ${p.used} z ${p.limit} ${pl(p.limitN, 'kreditu', 'kreditov', 'kreditov')} ${p.period === 'total' ? 'celkovo' : 'tento mesiac'}${p.exhausted ? ', vyčerpané' : ''}`,
    usageExhausted: 'vyčerpané',
    usageFromProvider: 'podľa údajov služby',
    usageNote: 'Kredity, ktoré táto aplikácia použila na svoje hľadania; iné použitie toho istého kľúča sa nepočíta.',
    usageNoteProvider: 'Kredity, ktoré táto aplikácia použila na svoje hľadania, okrem údajov označených ako údaje služby.',
    usageNoKey: 'Aplikácia beží bez kľúča webového vyhľadávania.',
  };

  const MESSAGES = { en, sk };
  const LANGS = ['sk', 'en'];
  let lang = 'en';

  /** The text for `key` (a top-level key, or "group.sub" for one of the tables) in the current language. */
  function t(key, params) {
    const pick = (dict) => key.split('.').reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), dict);
    let m = pick(MESSAGES[lang]);
    if (m === undefined) m = pick(en);
    if (m === undefined) return key;
    return typeof m === 'function' ? m(params ?? {}) : m;
  }
  /** An entry of one of the tables (status, fit, cond, stock, category, group, reason, colour), or undefined. */
  function lookup(table, id) {
    const v = MESSAGES[lang][table]?.[id];
    return v === undefined ? en[table]?.[id] : v;
  }

  /** One matcher reason ({ code, params }) in the current language; undefined for an unknown code. */
  function reasonText(r) {
    const f = lookup('matchReason', r.code);
    return typeof f === 'function' ? f(r.params) : undefined;
  }

  const skDec = new Intl.NumberFormat('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const skInt = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 0 });
  const skAny = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 6 });
  const enInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

  /** A EUR amount: "297.90 €" / "297,90 €"; "?" when unknown. */
  function eur(n) {
    if (n === null || n === undefined) return '?';
    return lang === 'sk' ? `${skDec.format(n)}${NBSP}€` : `${n.toFixed(2)} €`;
  }
  /** An amount in its own currency, as the shop gave it: "1265 PLN" / "1 265 PLN", "49,90 CZK". */
  function money(n, cur) {
    if (lang !== 'sk') return `${n} ${cur}`;
    return `${Number.isInteger(n) ? skInt.format(n) : skDec.format(n)}${NBSP}${cur === 'EUR' ? '€' : cur}`;
  }
  /** A whole number: "1,000" / "1 000". */
  function int(n) { return (lang === 'sk' ? skInt : enInt).format(n); }
  /** An exchange rate with all its decimals: "24.428" / "24,428". */
  function rate(n) { return lang === 'sk' ? skAny.format(n) : String(n); }
  /** "2026-11-24" -> "24. 11. 2026" in Slovak; unchanged in English. */
  function date(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return lang === 'sk' && m ? `${Number(m[3])}.${NBSP}${Number(m[2])}.${NBSP}${m[1]}` : iso;
  }
  /** "v Košiciach" for a location id (Slovak), with the city name as a fallback. */
  function inCity(id, name) { return IN_CITY_SK[id] || `v meste ${name}`; }

  function storedLang() {
    try {
      const v = window.localStorage.getItem('lang');
      return LANGS.includes(v) ? v : null;
    } catch { return null; }
  }
  /** ?lang= in the address, else the stored choice, else the browser's language (sk or cs -> Slovak), else English. */
  function initialLang() {
    const p = new URLSearchParams(window.location.search).get('lang');
    if (LANGS.includes(p)) return p;
    const stored = storedLang();
    if (stored) return stored;
    const prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    return /^(sk|cs)\b/i.test(prefs[0] || '') ? 'sk' : 'en';
  }

  /** Writes the static texts of the page (data-i18n attributes) in the current language. */
  function apply(root = document) {
    for (const e of root.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
    for (const e of root.querySelectorAll('[data-i18n-placeholder]')) e.setAttribute('placeholder', t(e.dataset.i18nPlaceholder));
    for (const e of root.querySelectorAll('[data-i18n-aria-label]')) e.setAttribute('aria-label', t(e.dataset.i18nAriaLabel));
    for (const e of root.querySelectorAll('[data-i18n-title]')) e.setAttribute('title', t(e.dataset.i18nTitle));
  }

  /** Switches the language: <html lang>, the static texts, the switch buttons; remembered when `remember`. */
  function setLang(l, remember = false) {
    lang = LANGS.includes(l) ? l : 'en';
    document.documentElement.lang = lang;
    if (remember) {
      try { window.localStorage.setItem('lang', lang); } catch { /* storage unavailable: the choice lasts for this page */ }
    }
    apply();
    for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', b.dataset.lang === lang ? 'true' : 'false');
  }

  window.I18N = { t, lookup, reasonText, eur, int, money, rate, date, inCity, initialLang, setLang, apply, getLang: () => lang, LANGS, MESSAGES };
})();
