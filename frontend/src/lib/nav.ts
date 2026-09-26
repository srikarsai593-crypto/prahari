import {
  LayoutDashboard,
  Compass,
  Package,
  Boxes,
  Users,
  Siren,
  Play,
  type LucideIcon,
} from 'lucide-react';

export interface NavLink {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_LINKS: NavLink[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/expedition', label: 'Expedition', icon: Compass },
  { href: '/cargo', label: 'Cargo', icon: Package },
  { href: '/inventory', label: 'Inventory', icon: Boxes },
  { href: '/personnel', label: 'Personnel', icon: Users },
  { href: '/emergency', label: 'Emergency', icon: Siren },
];

export const SCENARIO_LINK: NavLink = { href: '/scenario', label: 'Live Scenario', icon: Play };
