// Canonical JSON (docs/architecture.md §6.3): the one serialisation behind state hashes, event
// hashes, config and rules hashes, snapshots and log lines. Object keys sorted by UTF-16 code unit,
// no whitespace, strings as `JSON.stringify` writes them, arrays in order, `undefined` properties
// omitted. Anything that could serialise ambiguously or differently elsewhere is an error.

/** Thrown by `canonicalJson`; `path` locates the offending value, e.g. `$.cities.c3.units[2]`. */
export class CanonicalJsonError extends TypeError {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`canonicalJson: ${problem} at ${path}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

type PathSegment = string | number;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatPath(path: readonly PathSegment[]): string {
  let out = "$";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += IDENTIFIER.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;
  }
  return out;
}

/** Orders object entries by key, comparing UTF-16 code units (keys are unique). */
function byKey(a: readonly [string, unknown], b: readonly [string, unknown]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

class Writer {
  readonly parts: string[] = [];
  private readonly path: PathSegment[] = [];
  private readonly open = new Set<object>();

  private fail(problem: string): never {
    throw new CanonicalJsonError(formatPath(this.path), problem);
  }

  write(value: unknown): void {
    switch (typeof value) {
      case "string":
        this.parts.push(JSON.stringify(value));
        return;
      case "number":
        if (!Number.isSafeInteger(value)) this.fail(`${value} is not a safe integer`);
        // String(-0) is "0", so -0 is written as 0.
        this.parts.push(String(value));
        return;
      case "boolean":
        this.parts.push(value ? "true" : "false");
        return;
      case "undefined":
        this.fail(
          "undefined is not JSON (only an object property may be undefined; it is omitted)",
        );
        return;
      case "bigint":
        this.fail(`BigInt ${value} is not JSON`);
        return;
      case "symbol":
        this.fail("a symbol is not JSON");
        return;
      case "function":
        this.fail("a function is not JSON");
        return;
      case "object":
        if (value === null) {
          this.parts.push("null");
          return;
        }
        if (this.open.has(value)) this.fail("cyclic reference");
        this.open.add(value);
        if (Array.isArray(value)) this.writeArray(value);
        else this.writeObject(value);
        this.open.delete(value);
        return;
      default:
        this.fail(`unsupported value of type ${typeof value}`);
    }
  }

  private writeArray(array: readonly unknown[]): void {
    this.parts.push("[");
    for (let i = 0; i < array.length; i += 1) {
      if (i > 0) this.parts.push(",");
      this.path.push(i);
      this.write(array[i]);
      this.path.pop();
    }
    this.parts.push("]");
  }

  private writeObject(object: object): void {
    if (!isPlainObject(object)) {
      this.fail(`${Object.prototype.toString.call(object)} is not a plain object`);
    }
    const entries: [string, unknown][] = Object.entries(object);
    entries.sort(byKey);
    this.parts.push("{");
    let first = true;
    for (const [key, item] of entries) {
      if (item === undefined) continue;
      if (!first) this.parts.push(",");
      first = false;
      this.parts.push(JSON.stringify(key), ":");
      this.path.push(key);
      this.write(item);
      this.path.pop();
    }
    this.parts.push("}");
  }
}

/**
 * The canonical JSON text of `value`. Throws a `CanonicalJsonError` on `undefined` outside an object
 * property (top level or array element, holes included), on any number that is not a safe integer
 * (floats, NaN, ±Infinity, |n| ≥ 2^53), on BigInt, symbols and functions, on any object that is not
 * a plain object or an array (Map, Set, Date, class instances, …) and on cyclic references.
 */
export function canonicalJson(value: unknown): string {
  const writer = new Writer();
  writer.write(value);
  return writer.parts.join("");
}
