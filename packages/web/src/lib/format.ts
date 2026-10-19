// Numbers for display, the same in every browser locale: `1,312`, `−4`, `12.5%`.

/** An integer with thousands separators (commas). */
export function fmtInt(n: number): string {
  const v = Math.trunc(n);
  const digits = String(Math.abs(v));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i] ?? "";
  }
  return v < 0 ? `−${out}` : out;
}

/** `n` with its noun, pluralised with `s` unless a plural is given: `1 city`, `3 cities`. */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** Nano-dollars as dollars: `$0.42`, `$12.05`. */
export function fmtUsd(nanoUsd: number): string {
  const cents = Math.round(nanoUsd / 10_000_000);
  const dollars = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return `$${fmtInt(dollars)}.${rest < 10 ? `0${rest}` : String(rest)}`;
}
