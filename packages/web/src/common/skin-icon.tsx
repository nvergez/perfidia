import {
  Anchor,
  Box,
  Circle,
  Coins,
  Crown,
  Home,
  Landmark,
  Mountain,
  Pickaxe,
  Shield,
  Ship,
  Swords,
  Tent,
  Trees,
  User,
  Users,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import type { SkinIcon } from "../skins/index.ts";

// The Lucide icon of a skin's generic icon name.

const ICONS: Readonly<Record<SkinIcon, LucideIcon>> = Object.freeze({
  landmark: Landmark,
  trees: Trees,
  pickaxe: Pickaxe,
  coins: Coins,
  warehouse: Warehouse,
  swords: Swords,
  ship: Ship,
  shield: Shield,
  user: User,
  users: Users,
  anchor: Anchor,
  crown: Crown,
  mountain: Mountain,
  home: Home,
  tent: Tent,
  box: Box,
  circle: Circle,
});

export function SkinIconView({
  icon,
  className,
}: {
  readonly icon: SkinIcon;
  readonly className?: string;
}) {
  const Icon = ICONS[icon];
  return <Icon aria-hidden="true" className={className} />;
}
