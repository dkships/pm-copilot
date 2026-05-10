import { describe, expect, it } from "vitest";
import { scrubPii, scrubPiiArray } from "./pii-scrubber.js";

describe("scrubPii", () => {
  describe("SSN", () => {
    it("redacts dashed SSN", () => {
      const r = scrubPii("My SSN is 123-45-6789, please update");
      expect(r.text).toBe("My SSN is [SSN REDACTED], please update");
      expect(r.piiCategoriesFound).toContain("ssn");
    });

    it("redacts space-separated SSN", () => {
      const r = scrubPii("ssn: 123 45 6789");
      expect(r.text).toContain("[SSN REDACTED]");
      expect(r.piiCategoriesFound).toContain("ssn");
    });

    it("does not flag random 9-digit numbers without separators", () => {
      const r = scrubPii("Order number 123456789 was placed");
      expect(r.text).toContain("123456789");
      expect(r.piiCategoriesFound).not.toContain("ssn");
    });
  });

  describe("credit card", () => {
    it("redacts a Luhn-valid 16-digit card with dashes", () => {
      const r = scrubPii("Card 4111-1111-1111-1111 was charged");
      expect(r.text).toContain("[CC REDACTED]");
      expect(r.piiCategoriesFound).toContain("credit_card");
    });

    it("redacts a Luhn-valid card with spaces", () => {
      const r = scrubPii("Card 4111 1111 1111 1111 expired");
      expect(r.text).toContain("[CC REDACTED]");
      expect(r.piiCategoriesFound).toContain("credit_card");
    });

    it("redacts a Luhn-valid 15-digit Amex", () => {
      // 378282246310005 is a published Amex test number, Luhn-valid
      const r = scrubPii("amex 3782-822463-10005");
      expect(r.text).toContain("[CC REDACTED]");
      expect(r.piiCategoriesFound).toContain("credit_card");
    });

    it("does not redact a 16-digit sequence that fails Luhn", () => {
      // 1234-5678-9012-3456 is the textbook Luhn-failing example
      const r = scrubPii("not a card 1234-5678-9012-3456 just digits");
      expect(r.text).not.toContain("[CC REDACTED]");
      expect(r.piiCategoriesFound).not.toContain("credit_card");
    });

    it("does not report credit_card category when Luhn fails", () => {
      const r = scrubPii("1234-5678-9012-3456");
      expect(r.piiCategoriesFound).not.toContain("credit_card");
    });
  });

  describe("email", () => {
    it("redacts a simple email", () => {
      const r = scrubPii("Contact me at john.doe@example.com please");
      expect(r.text).toBe("Contact me at [EMAIL REDACTED] please");
      expect(r.piiCategoriesFound).toContain("email");
    });

    it("redacts emails with plus addressing", () => {
      const r = scrubPii("user+tag@subdomain.example.co.uk");
      expect(r.text).toBe("[EMAIL REDACTED]");
      expect(r.piiCategoriesFound).toContain("email");
    });

    it("redacts multiple emails in one string", () => {
      const r = scrubPii("from a@b.com to c@d.org");
      expect(r.text).toBe("from [EMAIL REDACTED] to [EMAIL REDACTED]");
    });

    it("does not match a bare domain without an @", () => {
      const r = scrubPii("Visit example.com for details");
      expect(r.text).toContain("example.com");
      expect(r.piiCategoriesFound).not.toContain("email");
    });
  });

  describe("phone", () => {
    it("redacts a +1 prefixed phone", () => {
      const r = scrubPii("Call me at +1 (555) 123-4567");
      expect(r.text).toContain("[PHONE REDACTED]");
      expect(r.piiCategoriesFound).toContain("phone");
    });

    it("redacts a dashed phone", () => {
      const r = scrubPii("phone: 555-123-4567");
      expect(r.text).toContain("[PHONE REDACTED]");
      expect(r.piiCategoriesFound).toContain("phone");
    });

    it("redacts an unformatted 10-digit phone", () => {
      const r = scrubPii("text 5551234567 now");
      expect(r.text).toContain("[PHONE REDACTED]");
      expect(r.piiCategoriesFound).toContain("phone");
    });
  });

  describe("combinations", () => {
    it("redacts multiple PII categories in one string", () => {
      const r = scrubPii(
        "I'm john@example.com, ssn 123-45-6789, card 4111-1111-1111-1111, phone 555-123-4567"
      );
      expect(r.text).not.toContain("john@example.com");
      expect(r.text).not.toContain("123-45-6789");
      expect(r.text).not.toContain("4111-1111-1111-1111");
      expect(r.text).not.toContain("555-123-4567");
      expect(r.piiCategoriesFound).toEqual(
        expect.arrayContaining(["email", "ssn", "credit_card", "phone"])
      );
    });

    it("returns the original string and empty categories when no PII present", () => {
      const input = "The booking system is broken when I click submit.";
      const r = scrubPii(input);
      expect(r.text).toBe(input);
      expect(r.piiCategoriesFound).toEqual([]);
    });

    it("handles empty string", () => {
      const r = scrubPii("");
      expect(r.text).toBe("");
      expect(r.piiCategoriesFound).toEqual([]);
    });
  });
});

describe("scrubPiiArray", () => {
  it("scrubs every entry and unions categories found", () => {
    const r = scrubPiiArray([
      "email me at a@b.com",
      "no pii here",
      "card 4111-1111-1111-1111",
    ]);
    expect(r.texts[0]).toContain("[EMAIL REDACTED]");
    expect(r.texts[1]).toBe("no pii here");
    expect(r.texts[2]).toContain("[CC REDACTED]");
    expect(r.piiCategoriesFound).toEqual(
      expect.arrayContaining(["email", "credit_card"])
    );
  });

  it("returns empty categories for an all-clean array", () => {
    const r = scrubPiiArray(["one", "two", "three"]);
    expect(r.piiCategoriesFound).toEqual([]);
  });

  it("handles empty array", () => {
    const r = scrubPiiArray([]);
    expect(r.texts).toEqual([]);
    expect(r.piiCategoriesFound).toEqual([]);
  });
});
