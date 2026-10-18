// Supply-chain age check (phase-3 design §5.2): every package version locked in `bun.lock` must have
// been published at least 14 days before today, or be listed below under the security exception
// (a patch release fixing a published advisory that affects our usage, with its reason). It asks the
// npm registry for each package's publish times, so it runs as a CI job only, never under
// `bun test` (tests never touch the network). Usage:
//   bun scripts/check-dep-ages.ts [bun.lock] [--base <old bun.lock>]
// With `--base`, only the versions the base lockfile does not hold are checked (a pull request's
// additions). Exit code 0 when every checked version is old enough, 1 otherwise.

// oxlint-disable no-await-in-loop -- one registry request at a time, politely
const MIN_AGE_DAYS = 14;

/** `name@version` adopted early under the security exception, with the advisory it fixes. */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

const args = process.argv.slice(2);
const baseAt = args.indexOf("--base");
const basePath = baseAt >= 0 ? args[baseAt + 1] : undefined;
const lockPath =
  args.find((a, i) => !a.startsWith("--") && (baseAt < 0 || i !== baseAt + 1)) ?? "bun.lock";

/** The registry versions of a lockfile, by package name. */
async function locked(path: string): Promise<Map<string, Set<string>>> {
  const lock = await Bun.file(path).text();
  // Package entries of bun.lock: `"key": ["name@version", …]`; workspace entries carry no registry
  // version and are skipped.
  const entry = /"[^"]+": \["((?:@[^@"/]+\/)?[^@"]+)@([^"]+)"/g;
  const out = new Map<string, Set<string>>();
  for (const m of lock.matchAll(entry)) {
    const name = m[1];
    const version = m[2];
    if (name === undefined || version === undefined || version.startsWith("workspace:")) continue;
    const set = out.get(name) ?? new Set<string>();
    set.add(version);
    out.set(name, set);
  }
  return out;
}

const versions = await locked(lockPath);
if (basePath !== undefined) {
  const base = await locked(basePath);
  for (const [name, set] of versions) {
    for (const v of base.get(name) ?? []) set.delete(v);
    if (set.size === 0) versions.delete(name);
  }
}

const now = Date.now();
const young: string[] = [];
const unknown: string[] = [];
let checked = 0;
for (const [name, set] of [...versions].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`);
  if (!res.ok) {
    unknown.push(`${name}: registry answered ${res.status}`);
    continue;
  }
  const doc: unknown = await res.json();
  const time: unknown = doc !== null && typeof doc === "object" && "time" in doc ? doc.time : null;
  for (const version of set) {
    checked += 1;
    const key = `${name}@${version}`;
    const published =
      time !== null && typeof time === "object" && Object.hasOwn(time, version)
        ? (Object.entries(time).find(([k]) => k === version)?.[1] as unknown)
        : undefined;
    if (typeof published !== "string") {
      unknown.push(`${key}: no publish time`);
      continue;
    }
    const days = (now - Date.parse(published)) / 86_400_000;
    if (days < MIN_AGE_DAYS && EXCEPTIONS[key] === undefined) {
      young.push(`${key}: published ${published.slice(0, 10)}, ${Math.floor(days)} days ago`);
    }
  }
}

console.log(`${checked} locked versions of ${versions.size} packages checked`);
for (const line of unknown) console.log(`unknown: ${line}`);
for (const line of young) console.log(`younger than ${MIN_AGE_DAYS} days: ${line}`);
process.exit(young.length > 0 || unknown.length > 0 ? 1 : 0);
