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
}

const PII_PATTERNS: PiiPattern[] = [
  // SSN: 123-45-6789 or 123 45 6789
  {
    name: "ssn",
    pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
    replacement: "[SSN REDACTED]",
  },
  // Credit cards: 13-19 digit sequences with optional separators
  // Covers Visa, MC, Amex, Discover
  {
    name: "credit_card",
    pattern: /\b(?:\d{4}[-\s]?){2,4}\d{1,4}\b/g,
    replacement: "[CC REDACTED]",
    // Post-filter: only redact if the digit-only version is 13-19 digits
  },
  // Email addresses
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[EMAIL REDACTED]",
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

  for (const { name, pattern, replacement } of PII_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;

    if (name === "credit_card") {
      // Special handling: validate with Luhn before redacting
      scrubbed = scrubbed.replace(pattern, (match) => {
        const digitsOnly = match.replace(/\D/g, "");
        if (digitsOnly.length >= 13 && digitsOnly.length <= 19 && passesLuhn(digitsOnly)) {
          categoriesFound.add(name);
          return replacement;
        }
        return match;
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
