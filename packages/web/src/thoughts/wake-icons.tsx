import {
  AlarmClock,
  Bell,
  Eye,
  Flag,
  Hammer,
  Handshake,
  Mail,
  Siren,
  Swords,
  type LucideIcon,
} from "lucide-react";
import { wakeKind, wakeKinds, wakeWords, type WakeKind } from "./wake.ts";

// Why a seat woke, as icons (the Thoughts column's history, the turn detail's wake): one generic
// icon per kind of reason (`wake.ts`), with the reasons in words for screen readers and tooltips.

export const WAKE_ICONS: Readonly<Record<WakeKind, LucideIcon>> = Object.freeze({
  start: Flag,
  alarm: AlarmClock,
  message: Mail,
  diplomacy: Handshake,
  danger: Siren,
  battle: Swords,
  spy: Eye,
  build: Hammer,
  event: Bell,
});

/** The icon of one reason ("queue_empty c24": a hammer). */
export function wakeIcon(reason: string): LucideIcon {
  return WAKE_ICONS[wakeKind(reason)];
}

/** The distinct kinds of a turn's reasons as icons, "Woke for …" in words. */
export function WakeIcons({ reasons }: { readonly reasons: readonly string[] }) {
  const words = reasons.map(wakeWords).join("; ");
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={`Woke for ${words}`}>
      {wakeKinds(reasons).map((k) => {
        const Icon = WAKE_ICONS[k];
        return <Icon key={k} className="size-3" aria-hidden="true" />;
      })}
      <span className="sr-only">Woke for {words}</span>
    </span>
  );
}
