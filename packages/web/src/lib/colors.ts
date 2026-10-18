// The 12 player colours (phase-3 design §4.5): the Okabe–Ito set, lightened where needed to read on
// the dark theme, extended to 12 for colour-blind viewers, and always paired with a shape and the
// player's id, so colour is never the only cue. A seat's colour index is `SeatInfo.color` (0–11).

export interface PlayerShape {
  readonly name: string;
  /** An SVG path in the box [-1, 1]²: draw it with `transform="translate(x y) scale(r)"`. */
  readonly d: string;
}

export const PLAYER_COLORS = Object.freeze([
  "#E69F00", // orange
  "#56B4E9", // sky blue
  "#2CB67D", // bluish green
  "#F0E442", // yellow
  "#4C8EDA", // blue
  "#E3622B", // vermillion
  "#CC79A7", // reddish purple
  "#A98BEB", // lavender
  "#D8C38F", // sand
  "#3FB8AF", // teal
  "#E07A8F", // rose
  "#C9D1DC", // pale grey
] as const);

export const PLAYER_SHAPES: readonly PlayerShape[] = Object.freeze([
  { name: "circle", d: "M1 0A1 1 0 1 1-1 0A1 1 0 1 1 1 0Z" },
  { name: "square", d: "M-.85-.85H.85V.85H-.85Z" },
  { name: "triangle", d: "M0-1L.95.8H-.95Z" },
  { name: "diamond", d: "M0-1L1 0L0 1L-1 0Z" },
  { name: "pentagon", d: "M0-1L.951-.309L.588.809H-.588L-.951-.309Z" },
  { name: "hexagon", d: "M0-1L.866-.5V.5L0 1L-.866.5V-.5Z" },
  {
    name: "star",
    d: "M0-1L.247-.34L.951-.309L.4.13L.588.809L0 .42L-.588.809L-.4.13L-.951-.309L-.247-.34Z",
  },
  { name: "plus", d: "M-.35-1H.35V-.35H1V.35H.35V1H-.35V.35H-1V-.35H-.35Z" },
  { name: "triangle-down", d: "M0 1L.95-.8H-.95Z" },
  {
    name: "octagon",
    d: "M-.383-.924H.383L.924-.383V.383L.383.924H-.383L-.924.383V-.383Z",
  },
  { name: "bowtie", d: "M-1-.8L1 .8V-.8L-1 .8Z" },
  {
    name: "cross",
    d: "M-1-.6L-.6-1L0-.4L.6-1L1-.6L.4 0L1 .6L.6 1L0 .4L-.6 1L-1 .6L-.4 0Z",
  },
]);

/** A city nobody owns: marble. */
export const NEUTRAL_COLOR = "#8A94A6";

/** The colour of a colour index (wraps past 12). */
export function playerColor(index: number): string {
  const n = PLAYER_COLORS.length;
  return PLAYER_COLORS[((index % n) + n) % n] ?? NEUTRAL_COLOR;
}

/** The shape of a colour index (wraps past 12). */
export function playerShape(index: number): PlayerShape {
  const n = PLAYER_SHAPES.length;
  return (
    PLAYER_SHAPES[((index % n) + n) % n] ?? {
      name: "circle",
      d: "M1 0A1 1 0 1 1-1 0A1 1 0 1 1 1 0Z",
    }
  );
}
