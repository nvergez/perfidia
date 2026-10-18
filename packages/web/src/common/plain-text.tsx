import { cn } from "../lib/cn.ts";

// Player-authored text (messages, proposals, thoughts, notes, reasoning, alliance names): rendered
// as plain text only (React escapes it), isolated with <bdi>, wrapped with `white-space: pre-wrap`;
// never markup, never a link made from a URL (phase-3 design §2.6, §6.4).

export function PlainText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return <bdi className={cn("player-text", className)}>{text}</bdi>;
}
