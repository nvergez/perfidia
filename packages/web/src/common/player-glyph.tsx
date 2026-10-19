import { NEUTRAL_COLOR, playerColor, playerShape } from "../lib/colors.ts";
import { cn } from "../lib/cn.ts";

// A player's colour and shape as a small glyph (colour is never the only cue: the shape and the id
// go with it). `color` is the seat's colour index; null draws a neutral (marble) circle.

export function PlayerGlyph({
  color,
  size = 12,
  className,
}: {
  readonly color: number | null;
  readonly size?: number;
  readonly className?: string;
}) {
  const shape = playerShape(color ?? 0);
  const fill = color === null ? NEUTRAL_COLOR : playerColor(color);
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="-1.1 -1.1 2.2 2.2"
      className={cn("inline-block shrink-0 align-[-0.1em]", className)}
    >
      <path d={shape.d} fill={fill} stroke="rgb(0 0 0 / 0.45)" strokeWidth={0.12} />
    </svg>
  );
}
