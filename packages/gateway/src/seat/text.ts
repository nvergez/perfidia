import type { DomainEvent } from "@perfidia/protocol";
import { copyObject } from "./clean.ts";

// Locale-independent text helpers (§6.5): no Intl, no toLocale*, ASCII case folding only; and
// event copies, so the gateway state never aliases what it receives or hands out (§6.6). Control
// characters are stripped by `clean.ts`'s `stripControl`, the one the presentation uses too.

/** `4340` → `"4,340"`: thousands separated by commas, for integers. */
export function groupDigits(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(n)));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return sign + out;
}

/** Folds ASCII `A`–`Z` to `a`–`z` and leaves every other character as it is. */
export function foldAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** `s` cut to at most `max` characters, ending with `...` when cut. */
export function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`;
}

/** A deep copy of a domain event. */
export function copyEvent(ev: DomainEvent): DomainEvent {
  return {
    t: ev.t,
    type: ev.type,
    public: ev.public,
    to: ev.to.map((r) => ({ p: r.p, as: r.as })),
    data: copyObject(ev.data),
  };
}
