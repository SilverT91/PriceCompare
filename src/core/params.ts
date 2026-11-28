// Product parameters for computers and phones (docs/plan-parameters.md, phase 1): processor or chip,
// graphics card and its memory, RAM, storage, screen, power supply, operating system.
//
// Read only from what a shop publishes, in this order of trust:
// 1. named values in the page's JSON-LD (`additionalProperty`: NAY's "Veľkosť pamäte RAM = 64,00 GB");
// 2. the offer's title ("HP PC OMEN 45L GT22-3582nc, Ultra 9-285K, 64GB DDR5, 2TB SSD, RTX 5080 16GB");
// 3. the JSON-LD description ("Pamäť RAM: DDR5 16 GB • Úložný priestor: SSD: 512 GB").
// Nothing is guessed: a parameter a shop does not state is absent, and the page says "not stated".
// Standard web APIs only (src/core).

import { fold } from './text.ts';

export const PARAM_KEYS = ['cpu', 'gpu', 'vram_gb', 'ram_gb', 'storage_gb', 'screen_in', 'psu_w', 'os'] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];
/** Where a value was read: the page's named values, the title, or the page's description. */
export type ParamSource = 'properties' | 'title' | 'description';
export interface ParamValue {
  value: string | number;
  source: ParamSource;
}
export type Params = Partial<Record<ParamKey, ParamValue>>;
/** The numeric parameters (GB, inches, watts); the others are names. */
export const NUMERIC: ReadonlySet<ParamKey> = new Set(['vram_gb', 'ram_gb', 'storage_gb', 'screen_in', 'psu_w']);

const PRIORITY: Record<ParamSource, number> = { properties: 0, title: 1, description: 2 };

/** Phones are told apart by their words; everything else with a processor or a graphics card reads as a computer. */
const PHONE_RE = /\b(iphone|smartfon|smartphone|mobilny telefon|mobilni telefon|telefon|galaxy [saz]\d|galaxy z|pixel \d|redmi|poco|oneplus|motorola|moto g|honor \d|xiaomi \d)/;

export function isPhone(title: string): boolean {
  return PHONE_RE.test(fold(title));
}

// ---- numbers ---------------------------------------------------------------------------------------

/**
 * "16 384 MB" -> 16, "64,00 GB" -> 64, "2 048 GB" -> 2048, "2TB" -> 2000, "2,5 TB" -> 2500, "512SSD" -> 512.
 * Null without GB/TB/MB. A space inside a number is a thousands separator in MB ("24 576 MB" is a
 * graphics card's 24 GB), and in GB or TB only when the groups make a usual capacity ("2 048",
 * "2 000"), so "iPhone 16 128GB" stays 128.
 */
export function capacityGb(text: string): number | null {
  const grouped = /(?<![\d.,])(\d{1,3})[ \u00a0\u202f](\d{3})\s*(mb)\b/i.exec(text)
    ?? /(?<![\d.,])(\d{1,2})[ \u00a0\u202f](000|024|048|096|192|384|536|768)\s*(tb|gb|mb)\b/i.exec(text);
  const plain = /(\d+(?:[.,]\d+)?)\s*(tb|gb|mb)\b/i.exec(text);
  const ssd = /(?<![\d.])(\d{3,4})\s*(?=ssd\b)/i.exec(text);
  const [num, unitRaw] = grouped ? [grouped[1] + grouped[2], grouped[3]] : plain ? [plain[1], plain[2]] : ssd ? [ssd[1], 'gb'] : [null, null];
  if (num === null || unitRaw === null) return null;
  const n = Number(num.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = unitRaw.toLowerCase();
  const gb = unit === 'tb' ? n * 1000 : unit === 'mb' ? n / 1024 : n;
  return Math.round(gb * 100) / 100;
}

/** Cut a text at commas, except a decimal comma ("4,7 GHz", "64,00 GB"): "DDR5,1TB" is two parts. */
function commaParts(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ',') continue;
    if (/\d/.test(text[i + 1] ?? '') && /(?:^|[^\p{L}\d.])\d+$/u.test(text.slice(from, i))) continue;
    out.push(text.slice(from, i));
    from = i + 1;
  }
  out.push(text.slice(from));
  return out;
}

function watts(text: string): number | null {
  const m = /(\d{1,2}[  ]?\d{3}|\d{3,4})\s*w\b/i.exec(text);
  return m ? Number(m[1].replace(/[  ]/g, '')) : null;
}

function inches(text: string): number | null {
  const m = /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:"|''|”|″|-?\s?palc\w*|-?\s?inch\w*|-?\s?zoll)/i.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  return n >= 3 && n <= 100 ? n : null;
}

// ---- names -------------------------------------------------------------------------------------------

const GPU_RE = /\b((?:nvidia\s*)?(?:geforce\s+)?rtx\s*(?:pro\s*)?(?:a\s?\d{3,4}|\d{3,4})[a-z]*(?:\s+(?:ti|super|ada|blackwell|bl|sff)\b)*|(?:nvidia\s+)?rtx\s+a\d{3,4}|(?:amd\s+)?radeon\s+(?:pro\s+|rx\s+)?[a-z]?\d{3,4}[a-z]*(?:\s+xtx?)?|(?:amd\s+)?radeon\s+\d{3,4}s|(?:intel\s+)?arc\s+[ab]?\d{3}[a-z]*|(?:intel\s+)?(?:uhd\s+|iris\s+xe\s+)?graphics)\b/i;
const CPU_RE = /\b((?:intel\s+)?core\s+(?:ultra\s+)?[iu]?\d(?:[\s-]+\d{3,5}[a-z]*)?(?:\s+(?:plus|vpro))?|(?:intel\s+)?(?:core\s+)?(?:ultra\s*\d|u[3579])[\s-]+\d{3}[a-z]*(?:\s+(?:plus|vpro))?|(?:amd\s+)?ryzen\s+(?:ai\s+)?(?:max\+?\s+)?(?:pro\s+)?\d{1,3}(?:\s+(?:pro\s+)?\d{3,4}[a-z0-9]*)?|apple\s+m\d(?:\s+(?:pro|max|ultra))?|(?:qualcomm\s+)?snapdragon\s+(?:x\s+(?:elite|plus)|\d+(?:\s+gen\s+\d)?|8\s+elite)|(?:mediatek\s+)?dimensity\s+\d{3,4}\+?|exynos\s+\d{3,4}|apple\s+a\d{2}(?:\s+(?:bionic|pro))?|(?:google\s+)?tensor\s+g\d|(?:intel\s+)?xeon\s+[a-z]?\d?[\s-]?\d{3,5}[a-z]*)\b/i;
const OS_RE = /\b(windows\s*1[01](?:\s*(?:pro|home))?|win\s*1[01]\s*(?:pro|home)?|w1[01]\s*(?:pro|home|p|h)\b|w1[01]p|w1[01]h|ubuntu|linux|freedos|bez\s+(?:os|operacneho\s+systemu)|no\s+os|android(?:\s+\d+)?|ios(?:\s+\d+)?|chrome\s*os|macos)\b/i;

function tidy(s: string): string {
  return s.replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
}

/** "W11P", "Win11Pro", "Windows 11 Pro" -> "Windows 11 Pro"; "bez OS" -> "no OS". */
function osName(raw: string): string {
  const f = fold(raw).replace(/\s+/g, ' ').trim();
  const win = /^(?:windows|win|w)\s*(1[01])\s*(pro|home|p|h)?$/.exec(f.replace(/^windows\s*/, 'windows ').replace(/^(win|w)(1[01])/, '$1 $2'));
  if (win) {
    const ed = win[2] ? (win[2].startsWith('p') ? ' Pro' : ' Home') : '';
    return `Windows ${win[1]}${ed}`;
  }
  if (/^(bez|no)\b/.test(f)) return 'no OS';
  if (f === 'freedos') return 'FreeDOS';
  if (f === 'linux' || f === 'ubuntu') return f === 'linux' ? 'Linux' : 'Ubuntu';
  if (f.startsWith('android')) return tidy(raw).replace(/^android/i, 'Android');
  if (f.startsWith('ios')) return tidy(raw).replace(/^ios/i, 'iOS');
  return tidy(raw);
}

function firstMatch(re: RegExp, text: string): string | null {
  const m = re.exec(text);
  return m ? tidy(m[1]) : null;
}

// ---- named values (JSON-LD additionalProperty) --------------------------------------------------------

/** Property names shops use, folded (no diacritics, lower case), per parameter. The first that fits wins. */
const LABELS: [ParamKey, RegExp][] = [
  ['vram_gb', /pamat\w* (vga|grafick)|grafick\w* pamat|vram|video ?memory|pamiec (karty )?graficzn|grafikspeicher/],
  ['gpu', /oznacenie grafick|grafick\w* (karta|cip|procesor)|graphics( card)?$|^gpu$|karta graficzna|graficzn|grafikkarte|grafika/],
  ['ram_gb', /pamat\w* ram|ram pamat|operacn\w* pamat|^ram$|velkost ram|pamiec ram|arbeitsspeicher|memory size|^pamat$|pamet ram/],
  ['storage_gb', /kapacita (ulozisk|disku|ssd)|ulozn\w* (priestor|kapacit)|^ulozisko$|vnutorn\w* pamat|vnitrni pamet|interna pamat|storage|pojemnosc|speicherkapazit|kapacita pamate/],
  ['cpu', /^procesor$|^processor$|^cpu$|oznacenie procesora|typ procesora|chipset|cipset|^cip$/],
  ['screen_in', /uhloprie[cč]k|uhlopricka|velkost displeja|screen size|przekatna|bildschirmdiagonale|displej$/],
  // Not "Požiadavka výkonu" (power requirement): that need not be the power supply's rating.
  ['psu_w', /zdroj|power supply|netzteil|zasilacz/],
  ['os', /operacn\w* system|system operacyjny|betriebssystem|operating system|^os$/],
];

export interface NamedValue {
  name: string;
  value: string;
}

/** Parameters from a page's named values. A value that does not fit its parameter is skipped. */
export function paramsFromProperties(props: NamedValue[]): Params {
  const out: Params = {};
  const cpuParts: string[] = [];
  for (const p of props) {
    const label = fold(p.name).replace(/\s+/g, ' ').trim();
    const value = tidy(p.value);
    if (!value) continue;
    const key = LABELS.find(([, re]) => re.test(label))?.[0];
    if (!key) continue;
    if (key === 'cpu') {
      // A chipset is the board's ("Intel W880"), unless it names a processor (a phone's "Čipset: Snapdragon 8 Elite").
      if (/chipset|cipset|^cip$/.test(label) && !CPU_RE.test(value)) continue;
      // "Procesor = INTEL Core Ultra 9" and "Označenie procesora = 285K" make one name.
      if (!cpuParts.some((c) => fold(c).includes(fold(value)))) cpuParts.push(value);
      continue;
    }
    if (out[key]) continue;
    const v = valueFor(key, value, false);
    if (v !== null) out[key] = { value: v, source: 'properties' };
  }
  if (cpuParts.length) out.cpu = { value: tidy(cpuParts.join(' ').replace(/^intel\b/i, 'Intel').replace(/^amd\b/i, 'AMD')), source: 'properties' };
  return out;
}

/** A labelled value turned into the parameter's value, or null when it does not fit. */
function valueFor(key: ParamKey, value: string, phone: boolean): string | number | null {
  switch (key) {
    case 'vram_gb':
    case 'ram_gb':
    case 'storage_gb': {
      const gb = capacityGb(value);
      return gb !== null && (key !== 'storage_gb' || gb >= 4) ? gb : null;
    }
    case 'screen_in':
      return inches(value) ?? (/^\d{1,2}([.,]\d{1,2})?$/.test(value.trim()) ? Number(value.replace(',', '.')) : null);
    case 'psu_w':
      return phone ? null : watts(value);
    case 'gpu':
      return firstMatch(GPU_RE, value);
    case 'os': {
      const os = firstMatch(OS_RE, value);
      return os ? osName(os) : null;
    }
    case 'cpu':
      return firstMatch(CPU_RE, value) ?? tidy(value);
  }
}

// ---- free text (titles and descriptions) --------------------------------------------------------------

const SCREEN_WORDS = /\b(displej\w*|display|screen|obrazovk\w*|uhloprie\w*|uhlopric\w*|wuxga|fhd|qhd|uhd|wqxga|oled|amoled|ips|retina|lcd|\d+\s*hz)\b/;
const STORAGE_WORDS = /\b(ssd|hdd|nvme|m\.2|emmc|ufs|ulozisk\w*|ulozn\w*|disk|storage|vnutorn\w* pamat|interna pamat)\b/;
const RAM_WORDS = /\b(ram|ddr\d|lpddr\d\w*|ddr\d\w*|operacn\w* pamat|pamat ram|memory|cudimm|sodimm|dimm)\b/;

/**
 * Parameters from a title or a description. The text is cut at commas, bullets, " / ", " | " and
 * semicolons (a decimal comma stays); each part is read on its own: "label: value", a graphics card
 * with its memory, a processor, amounts with what they are (SSD, DDR5), screen, power, system.
 */
export function paramsFromText(text: string, source: ParamSource, phone = isPhone(text)): Params {
  const out: Params = {};
  const set = (k: ParamKey, v: string | number | null) => {
    if (v !== null && v !== '' && out[k] === undefined) out[k] = { value: v, source };
  };
  const clean = text.replace(/[®™]/g, '').replace(/&bull;|•|·/g, ' • ').replace(/\s+/g, ' ');
  // A phone's "8GB/256GB", "12 GB + 512 GB": memory and storage, written together.
  const pair = /(\d{1,2})\s*gb\s*[/+]\s*(\d{2,4})\s*(gb|tb)\b/i.exec(clean);
  if (pair) {
    set('ram_gb', Number(pair[1]));
    set('storage_gb', capacityGb(`${pair[2]} ${pair[3]}`));
  }
  const parts = clean.split(/\s*[•;|]\s*|\s+\/\s+/).flatMap(commaParts).map((s) => s.trim()).filter(Boolean);
  const unlabeled: number[] = [];
  for (const part of parts) {
    const f = fold(part);
    const labelled = /^([^:]{2,40}):\s*(.+)$/.exec(part);
    if (labelled) {
      const label = fold(labelled[1]).trim();
      const key = LABELS.find(([, re]) => re.test(label))?.[0];
      if (key) {
        set(key, valueFor(key, labelled[2], phone));
        continue;
      }
    }
    const gpu = firstMatch(GPU_RE, part);
    if (gpu && !/^graphics$/i.test(gpu)) {
      set('gpu', gpu);
      // "RTX 5080 16GB", "RTX Pro 4000Bl 24GB", "GeForce RTX 5080 (16 GB)": the card's own memory.
      const after = part.slice(part.toLowerCase().indexOf(gpu.toLowerCase().split(' ')[0]));
      const vram = capacityGb(after);
      if (vram !== null && vram <= 128) set('vram_gb', vram);
      continue;
    }
    const cpu = firstMatch(CPU_RE, part);
    if (cpu) set('cpu', cpu);
    const os = firstMatch(OS_RE, part);
    if (os) set('os', osName(os));
    // A size in inches is a screen only next to a screen word ("16" WUXGA", "displej 6,1""): a desktop's "3.5" bay" is not.
    const screen = SCREEN_WORDS.test(f) ? inches(part) : null;
    if (screen !== null) set('screen_in', screen);
    if (!phone) {
      const w = watts(part);
      if (w !== null && w >= 90) set('psu_w', w);
    }
    // "2×16GB DDR5", "2x32GB": a memory kit, counted in total.
    const kit = /(\d)\s*[x×]\s*(\d{1,3})\s*gb/i.exec(part);
    if (kit) {
      set('ram_gb', Number(kit[1]) * Number(kit[2]));
      continue;
    }
    const gb = capacityGb(part);
    if (gb === null) continue;
    if (STORAGE_WORDS.test(f)) set('storage_gb', gb);
    else if (RAM_WORDS.test(f)) set('ram_gb', gb);
    else if (!cpu && !pair) unlabeled.push(gb);
  }
  // Amounts with nothing said about them: in a phone's name the one amount is its storage
  // ("iPhone 16 128GB"); in a computer's list memory comes in the small sizes and disks in the large.
  for (const gb of unlabeled) {
    if (phone) set('storage_gb', gb);
    else if (gb <= 256 && out.ram_gb === undefined) set('ram_gb', gb);
    else if (gb >= 128) set('storage_gb', gb);
  }
  return out;
}

/** Merge parameter sets: for each parameter the most trusted source wins (properties, title, description). */
export function mergeParams(...sets: (Params | undefined)[]): Params {
  const out: Params = {};
  for (const s of sets) {
    if (!s) continue;
    for (const k of PARAM_KEYS) {
      const v = s[k];
      if (v && (!out[k] || PRIORITY[v.source] < PRIORITY[(out[k] as ParamValue).source])) out[k] = v;
    }
  }
  return out;
}

/** An offer's parameters: its page's (named values and description) and its title's. */
export function offerParams(title: string, page?: Params): Params {
  return mergeParams(page, paramsFromText(title, 'title'));
}

/** One parameter of a product: the value most of its offers state, who said it, and other values seen. */
export interface GroupParam {
  value: string | number;
  source: ParamSource;
  shop: string;
  /** Other values offers of the same product state (a conflict is shown, not resolved silently). */
  others: (string | number)[];
}
export type GroupParams = Partial<Record<ParamKey, GroupParam>>;

/**
 * What makes two values of a parameter the same, however a shop writes them: a processor or graphics
 * card by its model numbers ("Ultra 9-285K", "Intel Core Ultra 9 285K", "U9 285K" -> "285k";
 * "RTX Pro 4000Bl", "RTX PRO 4000 Blackwell" -> "pro 4000"), an amount to two significant figures
 * (2,048 GB and 2 TB are one disk), anything else by its folded text.
 */
export function sameKey(k: ParamKey, value: string | number): string {
  if (typeof value === 'number') return String(Number(value.toPrecision(2)));
  const f = fold(value);
  if (k === 'cpu') {
    const nums = f.match(/\b\d{3,5}[a-z]*\b/g);
    if (nums) return nums.join(' ');
  }
  if (k === 'gpu') {
    const num = /\b(a\s?)?(\d{3,4})/.exec(f);
    if (num) return `${/\bpro\b/.test(f) ? 'pro ' : ''}${num[1] ? 'a' : ''}${num[2]}`;
  }
  return f.replace(/\s+/g, ' ').trim();
}

/** The parameters of a product, from its offers (each offer's most trusted value; then the most common). */
export function groupParams(offers: { params?: Params; shopName: string }[]): GroupParams {
  const out: GroupParams = {};
  for (const k of PARAM_KEYS) {
    const seen = new Map<string, { value: string | number; count: number; best: ParamSource; shop: string }>();
    for (const o of offers) {
      const v = o.params?.[k];
      if (!v) continue;
      const key = sameKey(k, v.value);
      const e = seen.get(key);
      if (!e) seen.set(key, { value: v.value, count: 1, best: v.source, shop: o.shopName });
      else {
        e.count++;
        // The same value as the most trusted source writes it.
        if (PRIORITY[v.source] < PRIORITY[e.best]) Object.assign(e, { value: v.value, best: v.source, shop: o.shopName });
      }
    }
    if (!seen.size) continue;
    const ranked = [...seen.values()].sort((a, b) => b.count - a.count || PRIORITY[a.best] - PRIORITY[b.best]);
    out[k] = { value: ranked[0].value, source: ranked[0].best, shop: ranked[0].shop, others: ranked.slice(1).map((r) => r.value) };
  }
  return out;
}
