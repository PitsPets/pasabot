# @pasabot/ui

Design tokens and shared React components for the PasaBot web app and module web code (direction "Sabay").

- `styles.css`: CSS custom properties (`--bk-*`) for light and dark; dark is the default under 600 px, and
  `<html data-theme="light|dark">` forces either. Component classes are prefixed `bk-`. Logical properties only.
- Components: `Button`, `Card`, `Avatar` (agent colour from its hue, status dot), `Badge`, `ConnectionPill`,
  `Segmented`, `Field`, `ApprovalCard`, `DecisionBar`, `Sheet`. Presentational only: no fetching and no i18n
  lookups, so callers pass translated labels.
- Agent avatars (`avatar/`, W29, direction "Silip"): `agentAvatarSvg(seed, { size })` is a pure, deterministic,
  animation-free SVG string (exports, notifications); `<AgentAvatar agentId salt size shape state label status />`
  adds seeded CSS-only motion (blink, glance; `thinking` / `speaking` / `offline`), none under reduced motion.
  `AVATAR_PALETTE` (8 colours) and `agentAccentColor(seed)` give the agent's accent colour; seed =
  `avatarSeed(agentId, avatarSalt)`. Proof: `vitest run packages/ui/src/avatar`.
- Rules the components keep: nothing under 12 px, 44 px tap targets on touch/phone widths, visible focus rings,
  AA contrast on both themes.
