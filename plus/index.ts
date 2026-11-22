/**
 * Discord Plus: extra bot tools on top of the official discord channel plugin.
 *
 * Layout
 *   state.ts     owner/admin ids, who triggered the turn, audit log, DM-contact storage
 *   util.ts      argument parsing, embeds/buttons/colors/permissions, formatting
 *   scope.ts     which servers are in scope; resolving channels, members and roles
 *   registry.ts  tool registry, the owner/admin gate and the public API for server.ts
 *   tools/*.ts   the tools, one file per group (each registers itself with def())
 *
 * Security model (enforced here, not in prompts)
 *  - Every tool has a tier:
 *      chat  - same rules as the official reply tool (allowlisted channels only).
 *      read  - read-only server info. Scoped to servers the owner is a member of; when the
 *              latest Discord message is not from the owner or an admin, also limited to
 *              servers that have an opted-in channel in access.json.
 *      admin - anything that changes the server, moderates people or reveals sensitive data.
 *              Only allowed when the owner or an admin (DISCORD_ADMIN_IDS) triggered the turn.
 *  - "Who triggered it" = the sender of the most recent Discord message delivered into the
 *    session. If no Discord message has arrived yet, the request came from the terminal,
 *    which is the owner.
 *  - Admin tools only act on servers where the owner is a member, and never target the owner
 *    or an admin.
 *  - Every admin attempt (allowed, denied, failed) is appended to <state dir>/admin-audit.log.
 *    If that log can't be written, the admin action is refused.
 *  - DM contacts and admins are never added to access.json allowFrom, because allowFrom users
 *    receive and can approve Claude Code permission prompts.
 */

// Tool modules register themselves on import.
import './tools/messages.ts'
import './tools/server.ts'
import './tools/members.ts'
import './tools/dm.ts'
import './tools/extras.ts'

export { initPlus, noteInbound, type PlusDeps } from './state.ts'
export { plusInstructions, plusToolList, isPlusTool, callPlusTool } from './registry.ts'
export { plusContactInbound } from './tools/dm.ts'
