/**
 * PII Scrubber — strips personally identifiable information before data
 * leaves the MCP server and reaches Claude.
 *
 * Design decisions:
 * - Scrubbing happens at the format layer, BEFORE analysis. This means
 *   theme matching runs on already-scrubbed text. A keyword like "billing"
 *   still matches, but "john@example.com" is gone.
 * - We scrub: SSNs, credit card numbers, email addresses, phone numbers.
 * - We do NOT scrub: names (too many false positives), addresses (same),
 *   or domain-specific identifiers (order IDs, account numbers) since
 *   those are useful for PM analysis and aren't regulated PII.
 * - Patterns are intentionally conservative — better to over-redact than
 *   leak a credit card number to a language model.
 */

export interface ScrubResult {
  text: string;
  piiCategoriesFound: string[];
}

interface PiiPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
  // Optional second check on each match; a match that fails it is kept as-is.
  validate?: (match: string) => boolean;
}

const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 19;
// E.164 allows at most 15 digits; below 8 a "+N ..." run is more likely a
// score or version than a phone number.
const INTL_PHONE_MIN_DIGITS = 8;
const INTL_PHONE_MAX_DIGITS = 15;

function digitCount(match: string): number {
  return match.replace(/\D/g, "").length;
}

function isCardNumber(match: string): boolean {
  const digits = match.replace(/\D/g, "");
  if (digits.length < CARD_MIN_DIGITS || digits.length > CARD_MAX_DIGITS) {
    return false;
  }
  return passesLuhn(digits);
}

function isIntlPhone(match: string): boolean {
  const n = digitCount(match);
  return n >= INTL_PHONE_MIN_DIGITS && n <= INTL_PHONE_MAX_DIGITS;
}

const PII_PATTERNS: PiiPattern[] = [
  // SSN: 123-45-6789, 123 45 6789 or 123.45.6789
  {
    name: "ssn",
    pattern: /\b\d{3}[-\s.]\d{2}[-\s.]\d{4}\b/g,
    replacement: "[SSN REDACTED]",
  },
  // Credit cards: 13-19 digit sequences with up to three separator chars
  // (space, dash, dot, underscore) between digits. Matches Visa/MC (4-4-4-4),
  // Amex (4-6-5), Discover, unseparated and "4111 - 1111 ..." forms.
  // Luhn check filters false positives.
  {
    name: "credit_card",
    pattern: /(?<!\d)(?:\d[-\s._]{0,3}){12,18}\d(?!\d)/g,
    replacement: "[CC REDACTED]",
    validate: isCardNumber,
  },
  // Email addresses. Quantifiers are bounded: an unbounded local part made
  // scanning a long "a.a.a..." run quadratic (20k chars took seconds).
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+\-]{1,256}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,63}\b/g,
    replacement: "[EMAIL REDACTED]",
  },
  // International phone numbers with a + prefix: +44 20 7946 0958,
  // +33 1 42 68 53 00. Chat channels such as WhatsApp carry these.
  {
    name: "phone",
    pattern: /\+\d{1,3}(?:[-.\s]?\(?\d{1,4}\)?){1,6}(?!\d)/g,
    replacement: "[PHONE REDACTED]",
    validate: isIntlPhone,
  },
  // Phone numbers: US formats with optional country code
  // +1 (555) 123-4567, 555-123-4567, 5551234567, (555) 123 4567
  {
    name: "phone",
    pattern:
      /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[PHONE REDACTED]",
  },
];

// Luhn check for credit card validation — reduces false positives on random digit sequences
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

export function scrubPii(text: string): ScrubResult {
  const categoriesFound = new Set<string>();
  let scrubbed = text;

  for (const { name, pattern, replacement, validate } of PII_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;

    if (validate) {
      scrubbed = scrubbed.replace(pattern, (match) => {
        if (!validate(match)) {
          return match;
        }
        categoriesFound.add(name);
        return replacement;
      });
    } else {
      const before = scrubbed;
      scrubbed = scrubbed.replace(pattern, replacement);
      if (scrubbed !== before) {
        categoriesFound.add(name);
      }
    }
  }

  return {
    text: scrubbed,
    piiCategoriesFound: [...categoriesFound],
  };
}

/**
 * Scrub an array of strings, collecting all PII categories found across all items.
 */
export function scrubPiiArray(texts: string[]): { texts: string[]; piiCategoriesFound: string[] } {
  const allCategories = new Set<string>();
  const scrubbed = texts.map((t) => {
    const result = scrubPii(t);
    for (const cat of result.piiCategoriesFound) allCategories.add(cat);
    return result.text;
  });
  return { texts: scrubbed, piiCategoriesFound: [...allCategories] };
}
