import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
} from 'discord.js'
import { type Ctx } from './registry.ts'
import { deps, isAdmin, ownerId, requireOwnerId } from './state.ts'
import { type Args, clean, idFrom, str } from './util.ts'

// ---------------------------------------------------------------------------
// Scope: servers, channels, members, roles

export const ownerMemberCache = new Map<string, { ok: boolean; at: number }>()

export async function ownerIsMember(guild: Guild): Promise<boolean> {
  const owner = requireOwnerId()
  if (guild.ownerId === owner) return true
  const hit = ownerMemberCache.get(guild.id)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok
  let ok: boolean
  try {
    await guild.members.fetch(owner)
    ok = true
  } catch (err) {
    if ((err as { code?: number }).code !== 10007) throw err // 10007 Unknown Member
    ok = false
  }
  ownerMemberCache.set(guild.id, { ok, at: Date.now() })
  return ok
}

export async function optedInGuildIds(): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const chId of Object.keys(deps.loadAccess().groups)) {
    const ch = await deps.client.channels.fetch(chId).catch(() => null)
    if (ch && 'guildId' in ch && ch.guildId) ids.add(ch.guildId)
  }
  return ids
}

export async function eligibleGuilds(): Promise<Guild[]> {
  const out: Guild[] = []
  for (const g of deps.client.guilds.cache.values()) {
    if (await ownerIsMember(g).catch(() => false)) out.push(g)
  }
  return out
}

export async function resolveGuild(a: Args, ctx: Ctx): Promise<Guild> {
  const id = str(a, 'guild_id')
  let guild: Guild | undefined
  if (id) {
    guild = deps.client.guilds.cache.get(id)
    if (!guild) throw new Error(`the bot is not in a server with id ${id}`)
  } else if (ctx.actor.trigger?.guildId) {
    guild = deps.client.guilds.cache.get(ctx.actor.trigger.guildId)
  }
  if (!guild) {
    const list = await eligibleGuilds()
    if (list.length === 1) guild = list[0]!
    else if (list.length === 0) throw new Error('the bot shares no server with the owner')
    else {
      throw new Error(
        `several servers possible, pass guild_id: ${list.map(g => `${clean(g.name)} (${g.id})`).join(', ')}`,
      )
    }
  }
  await checkGuildScope(guild, ctx)
  return guild
}

export async function checkGuildScope(guild: Guild, ctx: Ctx): Promise<void> {
  if (!(await ownerIsMember(guild))) {
    throw new Error(`server ${guild.id} is out of scope: the owner is not a member`)
  }
  if (!ctx.actor.privileged && !(await optedInGuildIds()).has(guild.id)) {
    throw new Error(`server ${guild.id} is out of scope: it has no opted-in channel`)
  }
}

export const CHANNEL_TYPE_NAMES: Record<number, string> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'media',
  [ChannelType.PublicThread]: 'thread',
  [ChannelType.PrivateThread]: 'private-thread',
  [ChannelType.AnnouncementThread]: 'announcement-thread',
}

export const CREATABLE_TYPES: Record<string, ChannelType> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
}

export async function resolveChannel(guild: Guild, ref: string, opts: { category?: boolean } = {}): Promise<GuildBasedChannel> {
  const id = idFrom(ref, /^<#(\d+)>$/)
  if (id) {
    const ch = await guild.channels.fetch(id).catch(() => null)
    if (!ch) throw new Error(`no channel ${id} in server ${clean(guild.name)}`)
    return ch
  }
  const name = ref.trim().replace(/^#/, '').toLowerCase()
  const all = [...(await guild.channels.fetch()).values()].filter(
    (c): c is NonNullable<typeof c> =>
      !!c && c.name.toLowerCase() === name && (opts.category === undefined || (c.type === ChannelType.GuildCategory) === opts.category),
  )
  if (all.length === 1) return all[0]!
  if (all.length === 0) throw new Error(`no ${opts.category ? 'category' : 'channel'} named "${clean(ref)}" in ${clean(guild.name)}`)
  throw new Error(`several channels named "${clean(ref)}", pass an id: ${all.map(c => `${c.id} (${CHANNEL_TYPE_NAMES[c.type] ?? c.type})`).join(', ')}`)
}

export async function resolveMember(guild: Guild, ref: string): Promise<GuildMember> {
  const id = idFrom(ref, /^<@!?(\d+)>$/)
  if (id) {
    try {
      return await guild.members.fetch(id)
    } catch {
      throw new Error(`user ${id} is not a member of ${clean(guild.name)}`)
    }
  }
  const q = ref.trim().replace(/^@/, '')
  const found = [...(await guild.members.search({ query: q, limit: 10 })).values()]
  const lq = q.toLowerCase()
  const exact = found.filter(m =>
    [m.user.username, m.user.globalName, m.nickname].some(n => n?.toLowerCase() === lq),
  )
  if (exact.length === 1) return exact[0]!
  // Deliberately no guessing on near-matches: these tools can kick and ban.
  const list = (ms: GuildMember[]) =>
    ms.map(m => `${clean(m.user.username)}${m.nickname ? ` "${clean(m.nickname)}"` : ''} (${m.id})`).join(', ')
  if (exact.length > 1) throw new Error(`several members are named "${clean(ref)}", pass a user id: ${list(exact)}`)
  if (found.length === 0) throw new Error(`no member matching "${clean(ref)}"`)
  throw new Error(`no member is named exactly "${clean(ref)}"; closest: ${list(found)}. Pass a user id.`)
}

export async function resolveRole(guild: Guild, ref: string): Promise<Role> {
  const t = ref.trim()
  if (t === '@everyone' || t.toLowerCase() === 'everyone') return guild.roles.everyone
  const id = idFrom(t, /^<@&(\d+)>$/)
  if (id) {
    const r = await guild.roles.fetch(id).catch(() => null)
    if (!r) throw new Error(`no role ${id} in ${clean(guild.name)}`)
    return r
  }
  const name = t.replace(/^@/, '').toLowerCase()
  const all = [...(await guild.roles.fetch()).values()].filter(r => r.name.toLowerCase() === name)
  if (all.length === 1) return all[0]!
  if (all.length === 0) throw new Error(`no role named "${clean(ref)}"`)
  throw new Error(`several roles named "${clean(ref)}", pass an id: ${all.map(r => r.id).join(', ')}`)
}

export function notOwner(userId: string, what: string): void {
  if (userId === ownerId()) throw new Error(`refusing to ${what} the owner`)
  if (isAdmin(userId)) throw new Error(`refusing to ${what} an admin (remove them from DISCORD_ADMIN_IDS first)`)
  if (userId === deps.client.user?.id) throw new Error(`refusing to ${what} the bot itself`)
}
