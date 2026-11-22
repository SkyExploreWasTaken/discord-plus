import {
  PermissionFlagsBits,
  type GuildMember,
} from 'discord.js'
import { join } from 'path'
import { GUILD, N, REASON, S, SA, def } from '../registry.ts'
import { notOwner, resolveGuild, resolveMember, resolveRole } from '../scope.ts'
import { clean, fmtDate, idFrom, num, reasonOf, str, strArr } from '../util.ts'

// ----- Members -------------------------------------------------------------

function memberLine(m: GuildMember): string {
  const roles = m.roles.cache.filter(r => r.id !== m.guild.id).map(r => clean(r.name))
  return `${clean(m.user.username)}${m.nickname ? ` "${clean(m.nickname)}"` : ''} (id: ${m.id}${m.user.bot ? ', bot' : ''}) roles: ${roles.join(', ') || '-'}`
}

def({
  name: 'find_members',
  tier: 'read',
  description:
    'Search members by username/nickname prefix, or list members when query is empty. Listing everyone needs the Server Members intent enabled in the Developer Portal.',
  properties: { guild_id: GUILD, query: S('Name prefix to search.'), limit: N('Max results (default 25, max 100).') },
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const limit = num(a, 'limit', 1, 100) ?? 25
    const q = str(a, 'query')
    let res
    try {
      res = q ? await g.members.search({ query: q, limit }) : await g.members.list({ limit })
    } catch (err) {
      if ((err as { code?: number }).code === 50001) {
        throw new Error('missing access: enable "Server Members Intent" for the bot in the Discord Developer Portal')
      }
      throw err
    }
    return [...res.values()].map(memberLine).join('\n') || '(no members found)'
  },
})

def({
  name: 'member_info',
  tier: 'read',
  description: 'Details about one member: names, roles, join date, timeout status.',
  properties: { guild_id: GUILD, member: S('User id, <@id> mention, or exact username/nickname.') },
  required: ['member'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const m = await resolveMember(g, str(a, 'member', true))
    return [
      memberLine(m),
      `display name: ${clean(m.displayName)}`,
      `account created: ${fmtDate(m.user.createdAt)}`,
      `joined: ${fmtDate(m.joinedAt)}`,
      `timed out until: ${m.communicationDisabledUntil && m.communicationDisabledUntil > new Date() ? fmtDate(m.communicationDisabledUntil) : '-'}`,
      `administrator: ${m.permissions.has(PermissionFlagsBits.Administrator)}`,
    ].join('\n')
  },
})

def({
  name: 'set_nickname',
  tier: 'admin',
  description: 'Set or clear a member nickname (empty nickname resets it).',
  properties: { guild_id: GUILD, member: S('User id, mention or exact name.'), nickname: S('New nickname; omit or empty to reset.'), reason: REASON },
  required: ['member'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const m = await resolveMember(g, str(a, 'member', true))
    const nick = str(a, 'nickname') ?? null
    await m.setNickname(nick, reasonOf(a))
    return nick ? `nickname of ${clean(m.user.username)} set to "${clean(nick)}"` : `nickname of ${clean(m.user.username)} reset`
  },
})

def({
  name: 'edit_member_roles',
  tier: 'admin',
  description: 'Add and/or remove roles of a member.',
  properties: {
    guild_id: GUILD,
    member: S('User id, mention or exact name.'),
    add: SA('Roles to add (id, <@&id> or name).'),
    remove: SA('Roles to remove (id, <@&id> or name).'),
    reason: REASON,
  },
  required: ['member'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const m = await resolveMember(g, str(a, 'member', true))
    const add = await Promise.all(strArr(a, 'add').map(r => resolveRole(g, r)))
    const remove = await Promise.all(strArr(a, 'remove').map(r => resolveRole(g, r)))
    if (!add.length && !remove.length) throw new Error('pass add and/or remove')
    if (remove.length) notOwner(m.id, 'remove roles from')
    if (add.length) await m.roles.add(add, reasonOf(a))
    if (remove.length) await m.roles.remove(remove, reasonOf(a))
    return `${clean(m.user.username)}: added [${add.map(r => clean(r.name)).join(', ')}], removed [${remove.map(r => clean(r.name)).join(', ')}]`
  },
})

def({
  name: 'timeout_member',
  tier: 'admin',
  description: 'Time out a member (they cannot talk or react) for N minutes, max 40320 (28 days). minutes 0 removes the timeout.',
  properties: { guild_id: GUILD, member: S('User id, mention or exact name.'), minutes: N('Duration in minutes; 0 to remove.'), reason: REASON },
  required: ['member', 'minutes'],
  destructive: true,
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const m = await resolveMember(g, str(a, 'member', true))
    notOwner(m.id, 'time out')
    const minutes = num(a, 'minutes', 0, 40320)!
    await m.timeout(minutes === 0 ? null : minutes * 60_000, reasonOf(a))
    return minutes === 0 ? `timeout removed for ${clean(m.user.username)}` : `${clean(m.user.username)} timed out for ${minutes} min`
  },
})

def({
  name: 'kick_member',
  tier: 'admin',
  description: 'Kick a member from the server.',
  properties: { guild_id: GUILD, member: S('User id, mention or exact name.'), reason: REASON },
  required: ['member'],
  destructive: true,
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const m = await resolveMember(g, str(a, 'member', true))
    notOwner(m.id, 'kick')
    await m.kick(reasonOf(a))
    return `kicked ${clean(m.user.username)} (${m.id})`
  },
})

def({
  name: 'ban_user',
  tier: 'admin',
  description: 'Ban a user (member or not) from the server, optionally deleting their recent messages.',
  properties: {
    guild_id: GUILD,
    user: S('User id, mention, or exact name of a current member.'),
    delete_message_hours: N('Delete their messages from the last N hours (0-168). Default 0.'),
    reason: REASON,
  },
  required: ['user'],
  destructive: true,
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const ref = str(a, 'user', true)
    const id = idFrom(ref, /^<@!?(\d+)>$/) ?? (await resolveMember(g, ref)).id
    notOwner(id, 'ban')
    const hours = num(a, 'delete_message_hours', 0, 168) ?? 0
    await g.bans.create(id, { deleteMessageSeconds: hours * 3600, reason: reasonOf(a) })
    return `banned ${id}`
  },
})

def({
  name: 'unban_user',
  tier: 'admin',
  description: 'Remove a ban.',
  properties: { guild_id: GUILD, user: S('User id.'), reason: REASON },
  required: ['user'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const id = idFrom(str(a, 'user', true), /^<@!?(\d+)>$/)
    if (!id) throw new Error('user must be a user id')
    await g.bans.remove(id, reasonOf(a))
    return `unbanned ${id}`
  },
})

def({
  name: 'list_bans',
  tier: 'admin',
  description: 'List banned users with ban reasons.',
  properties: { guild_id: GUILD, limit: N('Max results (default 50, max 1000).') },
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const bans = await g.bans.fetch({ limit: num(a, 'limit', 1, 1000) ?? 50 })
    return [...bans.values()].map(b => `${clean(b.user.username)} (${b.user.id}): ${clean(b.reason) || '-'}`).join('\n') || '(no bans)'
  },
})
