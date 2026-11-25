// Which shops to ask: a query's likely categories from brand and product words (sk, cs, de, pl, en),
// matched against the `categories` of data/shops.yaml. When no rule fires, every shop is asked.

import { fold } from './text.ts';
import type { Shop } from './types.ts';

export interface CategoryGroup {
  id: string;
  label: string;
  categories: string[];
}

export const CATEGORY_GROUPS: CategoryGroup[] = [
  { id: 'electronics', label: 'Electronics & appliances', categories: ['electronics', 'appliances'] },
  { id: 'tools', label: 'Tools, DIY & garden', categories: ['tools', 'diy_garden'] },
  { id: 'health', label: 'Drugstore, pharmacy & beauty', categories: ['drugstore', 'pharmacy', 'beauty'] },
  { id: 'home', label: 'Furniture & home', categories: ['furniture', 'home'] },
  { id: 'books', label: 'Books', categories: ['books'] },
];

interface Rule {
  /** Stable id of the rule: the page translates the reason by it (public/i18n.js, `reason`). */
  id: string;
  /** Why the rule fired, in English (the command line and the English page show it). */
  why: string;
  re: RegExp;
  categories: string[];
  /** Rules with a higher rank win over lower-ranked ones that matched only through a brand. */
  strong?: boolean;
}

const ELECTRONICS = ['electronics', 'appliances'];
const TOOLS = ['tools', 'diy_garden', 'electronics'];
const PERSONAL_CARE_ELECTRIC = ['appliances', 'electronics', 'drugstore', 'pharmacy', 'beauty'];
const HEALTH = ['drugstore', 'pharmacy', 'beauty'];
const HOME = ['furniture', 'home'];

// Patterns run on the folded query (lowercase, no diacritics) with spaces around it.
const RULES: Rule[] = [
  { id: 'toothbrush_shaver', why: 'electric toothbrush / shaver', strong: true, categories: PERSONAL_CARE_ELECTRIC,
    re: /\b(oral ?-?b|sonicare|zubn\w* kef|kefk|kartac|zahnburst|szczotecz|toothbrush|holiac|holic|rasier|shaver|epilat|zastrihov|trimmer|ionic|irigat|munddusch)/ },
  { id: 'phone_computer_av', why: 'phone / computer / audio-video', strong: true, categories: ELECTRONICS,
    re: /\b(iphone|ipad|macbook|imac|airpods|apple watch|galaxy|xiaomi|redmi|poco|pixel \d|smartf|telefon|mobil|notebook|laptop|tablet|televiz|\btv\b|monitor|sluchadl|headphone|kopfhor|sluchawk|playstation|xbox|nintendo|fotoapar|kamera|gopro|router|reproduktor|soundbar|smart ?watch|hodinky|garmin|kindle|ssd|grafick)/ },
  { id: 'pc_part', why: 'computer part / peripheral', strong: true, categories: ELECTRONICS,
    re: /\b(ryzen|threadripper|athlon|core ?i[3579]\b|core ultra|xeon|rtx ?\d|gtx ?\d|geforce|radeon|rx ?\d{3,4}\b|ddr[345]\b|so-?dimm|dimm\b|nvme|hdd\b|procesor|processor|prozessor|grafikkart|zakladn\w* dosk|matic\w* dosk|motherboard|mainboard|plyta glown|napajac\w* zdroj|pc zdroj|power supply|netzteil|zasilacz|pc skrin|pocitacov\w* skrin|pc case|obudowa komputer|mys\b|mysz|mouse|maus\b|klavesnic|keyboard|tastatur|klawiatur|webkamer|webcam|pamat\w* modul)/ },
  { id: 'household_appliance', why: 'household appliance', strong: true, categories: ELECTRONICS,
    re: /\b(prack|pracich|susick|chladnick|mrazni|mikrovln|vysavac|vysavač|robotick|kavovar|espresso|kanvic|fritez|mixer|mixér|zehlick|fen\b|kulma|klimatiz|odvlhc|cistick vzduch|varic|rura|trouba|umyvack|mycka|waschmaschine|staubsauger|kaffeemaschine|pralk|odkurzacz|ekspres)/ },
  { id: 'power_tool', why: 'power tool / DIY', strong: true, categories: TOOLS,
    re: /\b(g(sr|sb|bh|ws|dr|dx|ks|st|op|ka|ll|lm)\s?\d|makita|dewalt|metabo|milwaukee|einhell|ryobi|hilti|festool|stanley|vrtack|vrtac|skrutkov|sroubov|bohrschraub|bohrmasch|akkuschraub|wiertar|wkretar|drill|pila\b|pilka|brusk|uhlov|flex|kosack|kosacka|sekack|plotostrih|krovinorez|tlakov\w* cist|karcher|kärcher|naradie|naradi|werkzeug|narzedz|zahrad|garden|gril)/ },
  { id: 'drugstore', why: 'drugstore / cosmetics / pharmacy', strong: true, categories: HEALTH,
    re: /\b(nivea|krem|šampon|sampon|shampoo|parfum|parfem|toaletn|deodorant|dezodor|zubna pasta|zubni pasta|zahnpasta|plienk|pampers|vitamin|mydlo|kozmetik|kosmetik|make.?up|maskara|ruz na pery|lak na|sprchov|pletov|opalov|vlasov|tablet\w* na|liek|lek\b|sirup|kapsul|doplnok stravy)/ },
  { id: 'furniture_home', why: 'furniture / home', strong: true, categories: HOME,
    re: /\b(stol\b|stolik|stolic|stolick|kreslo|kresl|pohovk|sedack|postel|matrac|skrin|komoda|regal|polica|lampa|svietidl|koberec|zavesy|desk|chair|sofa|tisch|stuhl|schrank|biurko|krzeslo|lozko|szafa|ikea|jysk)/ },
  { id: 'book', why: 'book', strong: true, categories: ['books'],
    re: /\b(kniha|knihy|knih|roman|hobit|tolkien|rowling|harry potter|buch|bucher|ksiazk|ebook|e-kniha|pracovny zosit|ucebnic)/ },
  // Brand-only hints (weaker: they only apply when no product word matched).
  { id: 'brand_electronics', why: 'brand Apple / Samsung / Sony / LG', categories: ELECTRONICS, re: /\b(apple|samsung|sony|\blg\b|huawei|lenovo|asus|acer|dell|\bhp\b|jbl|philips|panasonic|tefal|rowenta|dyson|delonghi|electrolux|whirlpool|sencor|eta)\b/ },
  { id: 'brand_bosch', why: 'brand Bosch (tools and appliances)', categories: ['tools', 'diy_garden', 'electronics', 'appliances'], re: /\bbosch\b/ },
  { id: 'brand_braun', why: 'brand Braun', categories: PERSONAL_CARE_ELECTRIC, re: /\bbraun\b/ },
  { id: 'brand_pc', why: 'brand of computer parts and peripherals', categories: ELECTRONICS,
    re: /\b(logitech|kingston|corsair|gigabyte|msi|nvidia|amd|intel|crucial|seagate|razer|steelseries|hyperx|pny|asrock)\b/ },
  { id: 'brand_robot_vacuum', why: 'brand Roborock / iRobot / Ecovacs / Dreame (robot vacuums)', categories: ELECTRONICS, re: /\b(roborock|irobot|roomba|ecovacs|deebot|dreame)\b/ },
];

/** The ids of all rules, in order (for the test that every one has a translation). */
export const RULE_IDS: string[] = RULES.map((r) => r.id);

export interface CategoryChoice {
  /** null = all shops */
  categories: string[] | null;
  mode: 'auto' | 'all' | 'group';
  /** In English. */
  reasons: string[];
  /**
   * The same reasons as ids, in the same order, for a translation: a rule id, or "no_hint" (no rule
   * fired), "all_chosen" (all shops chosen), "group_chosen:<group id>" (a group chosen).
   */
  reasonIds: string[];
  label: string;
}

export function guessCategories(query: string): CategoryChoice {
  const q = ` ${fold(query).replace(/[^a-z0-9+ -]+/g, ' ').replace(/\s+/g, ' ')} `;
  const strong = RULES.filter((r) => r.strong && r.re.test(q));
  const fired = strong.length ? strong : RULES.filter((r) => !r.strong && r.re.test(q));
  if (!fired.length) return { categories: null, mode: 'auto', reasons: ['no hint in the query: all shops'], reasonIds: ['no_hint'], label: 'all shops' };
  const cats = [...new Set(fired.flatMap((r) => r.categories))];
  return { categories: cats, mode: 'auto', reasons: fired.map((r) => r.why), reasonIds: fired.map((r) => r.id), label: cats.join(', ') };
}

/** `cat` from the UI/CLI: "auto" (default), "all", or a group id. */
export function chooseCategories(query: string, cat: string | null | undefined): CategoryChoice {
  const c = (cat ?? 'auto').toLowerCase();
  if (c === 'all') return { categories: null, mode: 'all', reasons: ['all shops (chosen)'], reasonIds: ['all_chosen'], label: 'all shops' };
  const g = CATEGORY_GROUPS.find((x) => x.id === c);
  if (g) return { categories: g.categories, mode: 'group', reasons: [`${g.label} (chosen)`], reasonIds: [`group_chosen:${g.id}`], label: g.label };
  return guessCategories(query);
}

/** Shops with "general" (marketplaces, department stores) are asked for every category. */
export function shopIsRelevant(shop: Pick<Shop, 'categories'>, categories: string[] | null): boolean {
  if (!categories) return true;
  if (shop.categories.includes('general')) return true;
  return shop.categories.some((c) => categories.includes(c));
}
