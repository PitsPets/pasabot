/**
 * @pasabot/ui — design tokens and shared React components. Presentational only: no fetching, no i18n lookups
 * (callers pass already translated labels), so the shell and any module web code can use them.
 * Import `@pasabot/ui/styles.css` once (the shell does).
 */

export {
  AgentAvatar,
  type AgentAvatarProps,
  type AgentAvatarSvgOptions,
  AVATAR_PALETTE,
  type AvatarColor,
  type AvatarShape,
  type AvatarState,
  agentAccentColor,
  agentAvatarSvg,
  avatarSeed,
} from './avatar/index.js';
export {
  BRAIN_TONE_IDS,
  BrandTile,
  type BrandTileProps,
  brainTone,
  markFamily,
  type ResolvedMark,
  resolveMark,
} from './brand-tile.js';
export {
  type AgentStatus,
  ApprovalCard,
  type ApprovalCardProps,
  Avatar,
  Badge,
  Button,
  type ButtonProps,
  blobColor,
  Card,
  ConnectionPill,
  DecisionBar,
  Field,
  HelperCard,
  type HelperCardAction,
  type HelperCardProps,
  type HelperCardState,
  type HelperCardVariant,
  Segmented,
  Sheet,
} from './components.js';
export { BRAND_MARKS, type MarkKind } from './icons/brands.js';
export { ICON_NAMES, ICONS, Icon, type IconName, iconName } from './icons/icons.js';
export { LogoLockup, type LogoLockupProps, LogoMark, type LogoMarkProps } from './logo.js';
export { safeHref, safeImageSrc } from './safe-url.js';
export { type ChipTone, IconTile, ListRow, Menu, type MenuItem, StatusChip, Switch } from './shell.js';
export { type ThemeTokens, tokens } from './tokens.js';
