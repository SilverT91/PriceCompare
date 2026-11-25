// Query correction: a brand typed with one wrong, missing or extra letter ("Iral b" for "Oral-B",
// "Bosh" for "Bosch") is searched as the brand. Conservative on purpose: only a word (or two
// neighbouring words joined) that is no word the matcher knows, has no digit, has at least four
// letters and is exactly one edit away from exactly one brand of five or more letters. The search shows what it searched
// for and offers the search exactly as typed.

import { editDistance, tokenize } from './text.ts';
import { ACCESSORY_WORDS, BRAND_SPELLING, BRANDS, colourOf, conditionOfToken, inClass, MODEL_WORDS, NEUTRAL, PACKAGE_WORDS } from './vocab.ts';

export interface QueryCorrection {
  /** What the search uses. */
  query: string;
  /** What was typed. */
  typed: string;
  corrected: boolean;
}

/** A word of the vocabulary: brand, line, category, connector, tier, package, accessory, colour or condition word. */
function knownWord(t: string): boolean {
  return BRANDS.has(t) || inClass(t, NEUTRAL) || inClass(t, MODEL_WORDS) || inClass(t, PACKAGE_WORDS) || inClass(t, ACCESSORY_WORDS)
    || colourOf(t) !== null || conditionOfToken(t) !== null;
}

/**
 * The one brand one edit away from the token, or null (none, or more than one). Only brands of five
 * or more letters: one edit from a four-letter brand is too often a common word ("doll", "cell" and
 * "Dell"; "song" and "Sony"; "idea" and "IKEA").
 */
function nearBrand(token: string): string | null {
  if (token.length < 4) return null;
  const hits = [...BRANDS].filter((b) => b.length >= 5 && Math.abs(b.length - token.length) <= 1 && editDistance(b, token) === 1);
  return hits.length === 1 ? hits[0] : null;
}

/** The single token of a word, when the word is letters only and not a known word ("Iral", "b"); else null. */
function unknownLetters(word: string): string | null {
  const toks = tokenize(word);
  return toks.length === 1 && /^[a-z]+$/.test(toks[0]) && !knownWord(toks[0]) ? toks[0] : null;
}

export function correctQuery(typed: string): QueryCorrection {
  const words = typed.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const a = unknownLetters(words[i]);
    const b = i + 1 < words.length ? unknownLetters(words[i + 1]) : null;
    // A brand written as two words ("Oral b") is no typo.
    if (a && b && BRANDS.has(a + b)) {
      out.push(words[i], words[i + 1]);
      i++;
      continue;
    }
    // Two words joined first, so "Orall b" becomes "Oral-B" and not "Oral-B b".
    const pair = a && b ? nearBrand(a + b) : null;
    if (pair) {
      out.push(BRAND_SPELLING[pair]);
      i++;
      continue;
    }
    const one = a ? nearBrand(a) : null;
    out.push(one ? BRAND_SPELLING[one] : words[i]);
  }
  const query = out.join(' ');
  const corrected = query !== words.join(' ');
  return { query: corrected ? query : typed.trim(), typed, corrected };
}
