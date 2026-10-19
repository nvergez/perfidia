import type {
  GameTime,
  HourPoint,
  NotebookHistory,
  NotebookVersion,
  PlayerEnt,
  PlayerId,
} from "@perfidia/protocol";

// The dossier's series (phase-3 design §4.2 Pass C, docs/phase3.md §16.4): what the fold keeps per
// seat besides frames and steps, from `match.jsonl` only. Hourly: the seat's score and cities at
// every `ckpt` line (one a game hour) and at the `end` line, as the projection has them there. The notebook's history:
// every version a `note` line made (the gateway fold's notebook after the line, cleaned), each
// stored as an edit of the version before (`spliceOf`: the common head and tail, and the text
// between), a write that leaves the text as it was not counted. A seat keeps its newest versions
// within `NOTEBOOK_HISTORY_MAX_VERSIONS` and `NOTEBOOK_HISTORY_MAX_CHARS` characters of edit text;
// when the oldest is dropped, the next one is stored whole. Pure and deterministic.

/** The most characters of version text a seat's notebook history keeps (a dossier stays under 64 KB gzipped). */
export const NOTEBOOK_HISTORY_MAX_CHARS = 24_000;
/** The most notebook versions a seat keeps. */
export const NOTEBOOK_HISTORY_MAX_VERSIONS = 400;

/** The edit that turns `prev` into `next`: keep `head` and `tail` characters, `text` between. */
export function spliceOf(
  prev: string,
  next: string,
): { readonly head: number; readonly tail: number; readonly text: string } {
  const max = Math.min(prev.length, next.length);
  let head = 0;
  while (head < max && prev.charCodeAt(head) === next.charCodeAt(head)) head += 1;
  // A surrogate pair is never split: the edit starts before a high surrogate it would cut.
  if (head > 0 && isHigh(next.charCodeAt(head - 1))) head -= 1;
  let tail = 0;
  while (
    tail < max - head &&
    prev.charCodeAt(prev.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
  ) {
    tail += 1;
  }
  if (tail > 0 && isLow(next.charCodeAt(next.length - tail))) tail -= 1;
  return { head, tail, text: next.slice(head, next.length - tail) };
}

const isHigh = (c: number): boolean => c >= 0xd8_00 && c <= 0xdb_ff;
const isLow = (c: number): boolean => c >= 0xdc_00 && c <= 0xdf_ff;

/** A seat's notebook versions, newest kept (`NotebookHistory`). */
export class NotebookLog {
  private readonly maxChars: number;
  private readonly maxVersions: number;
  private readonly kept: NotebookVersion[] = [];
  private total = 0;
  private chars = 0;
  /** The whole text of the oldest version kept, and of the newest. */
  private first = "";
  private last = "";

  constructor(o: { readonly maxChars?: number; readonly maxVersions?: number } = {}) {
    this.maxChars = o.maxChars ?? NOTEBOOK_HISTORY_MAX_CHARS;
    this.maxVersions = o.maxVersions ?? NOTEBOOK_HISTORY_MAX_VERSIONS;
  }

  /** Records the notebook after a `note` line; false when its text did not change. */
  add(t: GameTime, turn: number, mode: NotebookVersion["mode"], text: string): boolean {
    if (text === this.last) return false;
    const edit = this.kept.length === 0 ? { head: 0, tail: 0, text } : spliceOf(this.last, text);
    if (this.kept.length === 0) this.first = text;
    this.kept.push({ t, turn, mode, ...edit });
    this.total += 1;
    this.chars += edit.text.length;
    this.last = text;
    while (
      this.kept.length > 1 &&
      (this.kept.length > this.maxVersions || this.chars > this.maxChars)
    ) {
      this.dropOldest();
    }
    return true;
  }

  /** Versions written so far (kept or not). */
  get written(): number {
    return this.total;
  }

  history(): NotebookHistory {
    return { total: this.total, versions: [...this.kept] };
  }

  private dropOldest(): void {
    const gone = this.kept.shift();
    const next = this.kept[0];
    if (gone === undefined || next === undefined) return;
    const whole =
      this.first.slice(0, next.head) + next.text + this.first.slice(this.first.length - next.tail);
    this.chars += whole.length - next.text.length - gone.text.length;
    this.kept[0] = { ...next, head: 0, tail: 0, text: whole };
    this.first = whole;
  }
}

/** Every seat's hourly points and notebook history. */
export class SeatSeries {
  private readonly seats: readonly PlayerId[];
  private readonly points = new Map<PlayerId, HourPoint[]>();
  private readonly notebooks = new Map<PlayerId, NotebookLog>();

  constructor(seats: readonly PlayerId[]) {
    this.seats = seats;
    for (const s of seats) {
      this.points.set(s, []);
      this.notebooks.set(s, new NotebookLog());
    }
  }

  /** A `ckpt` (or `end`) line at `t`: each seat's score and cities in the projection there. */
  checkpoint(t: GameTime, player: (seat: PlayerId) => PlayerEnt | undefined): void {
    for (const s of this.seats) {
      const p = player(s);
      if (p !== undefined) this.points.get(s)?.push({ t, score: p.score, cities: p.cities });
    }
  }

  /** A `note` line: `text` is the seat's notebook after it, cleaned. */
  note(
    seat: PlayerId,
    t: GameTime,
    turn: number,
    mode: NotebookVersion["mode"],
    text: string,
  ): void {
    let log = this.notebooks.get(seat);
    if (log === undefined) {
      log = new NotebookLog();
      this.notebooks.set(seat, log);
    }
    log.add(t, turn, mode, text);
  }

  /** A seat's points so far, in time order. */
  hourly(seat: PlayerId): HourPoint[] {
    return [...(this.points.get(seat) ?? [])];
  }

  /** A seat's notebook history. */
  notebook(seat: PlayerId): NotebookHistory {
    return this.notebooks.get(seat)?.history() ?? { total: 0, versions: [] };
  }

  /** Changes when a seat's points or notebook history change (cheap: no copy). */
  key(seat: PlayerId): string {
    return `${this.points.get(seat)?.length ?? 0}:${this.notebooks.get(seat)?.written ?? 0}`;
  }
}
