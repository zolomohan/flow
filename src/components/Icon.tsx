import {
  AlertCircle, ArrowDownLeft, ArrowLeftRight, ArrowRight, ArrowUpRight, Banknote,
  Bitcoin, Briefcase, Building2, CalendarDays, CarFront, Check, ChevronDown,
  ChevronLeft, ChevronRight, ChevronsUpDown, CircleDashed, Clapperboard, Coins,
  CornerUpLeft, CreditCard, Download, Equal, Gem, Gift, GraduationCap, Grid2x2,
  HeartPulse, House, Inbox, Landmark, LayoutDashboard, ListFilter, Moon,
  MoreHorizontal, Pencil, Percent, PiggyBank, Plane, Plus, Receipt, RefreshCw,
  Repeat, Scale, Search, Settings, ShoppingBag, ShoppingBasket, Smartphone,
  Sparkles, Split, Store, Sun, Tags, Trash2, TrendingDown, TrendingUp, Undo2,
  Users, Utensils, Wallet, WalletCards, X, Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * A closed registry rather than a dynamic import, so the bundle only carries
 * glyphs we actually offer in the pickers.
 */
export const ICONS: Record<string, LucideIcon> = {
  'alert-circle': AlertCircle,
  'arrow-down-left': ArrowDownLeft,
  'arrow-left-right': ArrowLeftRight,
  'arrow-right': ArrowRight,
  'arrow-up-right': ArrowUpRight,
  banknote: Banknote,
  bitcoin: Bitcoin,
  briefcase: Briefcase,
  'building-2': Building2,
  'calendar-days': CalendarDays,
  'car-front': CarFront,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevrons-up-down': ChevronsUpDown,
  'circle-dashed': CircleDashed,
  clapperboard: Clapperboard,
  coins: Coins,
  gem: Gem,
  'refresh-cw': RefreshCw,
  'corner-up-left': CornerUpLeft,
  'credit-card': CreditCard,
  download: Download,
  equal: Equal,
  gift: Gift,
  'graduation-cap': GraduationCap,
  'grid-2x2': Grid2x2,
  'heart-pulse': HeartPulse,
  house: House,
  inbox: Inbox,
  landmark: Landmark,
  'layout-dashboard': LayoutDashboard,
  'list-filter': ListFilter,
  moon: Moon,
  'more-horizontal': MoreHorizontal,
  pencil: Pencil,
  percent: Percent,
  'piggy-bank': PiggyBank,
  plane: Plane,
  plus: Plus,
  receipt: Receipt,
  repeat: Repeat,
  scale: Scale,
  search: Search,
  settings: Settings,
  'shopping-bag': ShoppingBag,
  'shopping-basket': ShoppingBasket,
  smartphone: Smartphone,
  sparkles: Sparkles,
  split: Split,
  store: Store,
  sun: Sun,
  tags: Tags,
  'trash-2': Trash2,
  'trending-down': TrendingDown,
  'trending-up': TrendingUp,
  'undo-2': Undo2,
  users: Users,
  utensils: Utensils,
  wallet: Wallet,
  'wallet-cards': WalletCards,
  x: X,
  zap: Zap,
};

/** Icon names offered when creating a category. */
export const CATEGORY_ICONS = [
  'utensils', 'shopping-basket', 'car-front', 'shopping-bag', 'zap', 'house',
  'heart-pulse', 'clapperboard', 'plane', 'graduation-cap', 'repeat', 'receipt',
  'gift', 'briefcase', 'store', 'piggy-bank', 'trending-up', 'undo-2',
  'coins', 'smartphone', 'tags', 'circle-dashed',
];

/** Icon names offered when creating an account. */
export const ACCOUNT_ICONS = [
  'landmark', 'building-2', 'credit-card', 'wallet', 'wallet-cards', 'banknote',
  'coins', 'piggy-bank', 'trending-up', 'smartphone', 'bitcoin', 'briefcase',
];

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.9,
  className,
}: {
  name: string | null | undefined;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const Glyph = ICONS[name ?? ''] ?? CircleDashed;
  return <Glyph size={size} strokeWidth={strokeWidth} className={className} />;
}
