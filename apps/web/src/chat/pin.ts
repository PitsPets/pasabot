/**
 * The pinned chat: the owner's main helper (the built-in team builder) always sits at the top of the chat list, whatever
 * the activity order or a search, and it cannot be unpinned. Kept apart from Shell so the rule is tested on its own.
 */

/** Is this chat the team builder's own chat (a direct chat, never a helpers' conversation in Team talk)? */
export function isPinnedChat(
  c: { kind: string; settings?: Record<string, unknown> | null },
  agentId: string | null | undefined,
  builder: string | null,
): boolean {
  return (
    !!builder && c.kind === 'direct' && typeof c.settings?.collabFrom !== 'string' && agentId === builder
  );
}

/** The pinned chats first; everything else keeps its order (stable). */
export function pinFirst<T>(chats: readonly T[], pinned: (c: T) => boolean): T[] {
  const top: T[] = [];
  const rest: T[] = [];
  for (const c of chats) (pinned(c) ? top : rest).push(c);
  return [...top, ...rest];
}
