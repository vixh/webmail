// Server-side switch for the hotel AI reply. Kept free of imports so any
// route (including /api/config) can ask without pulling in the AI stack.
export function aiReplyEnabled(): boolean {
  return process.env.AI_REPLY_ENABLED === 'true';
}
