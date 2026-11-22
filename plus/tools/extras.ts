import {
  ActivityType,
  AuditLogEvent,
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  type GuildBasedChannel,
  type Message,
} from 'discord.js'
import { B, GUILD, N, REASON, S, def } from '../registry.ts'
import { checkGuildScope, resolveChannel, resolveGuild } from '../scope.ts'
import { audit, deps } from '../state.ts'
import { bool, buildEmbeds, clean, fmtDate, httpUrl, num, reasonOf, str } from '../util.ts'

// ----- Webhooks -----------------------------------------------------------

def({
  name: 'list_webhooks',
  tier: 'admin',
  description: 'List webhooks of a server or one channel. Tokens and URLs are never shown.',
  properties: { guild_id: GUILD, channel: S('Optional channel id or name.') },
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const chRef = str(a, 'channel')
    const hooks = chRef ? await ((await resolveChannel(g, chRef)) as any).fetchWebhooks() : await g.fetchWebhooks()
    return (
      [...hooks.values()]
        .map((w: any) => `${clean(w.name)} (id: ${w.id}, channel: ${w.channelId}, by: ${clean(w.owner?.username) || '-'})`)
        .join('\n') || '(no webhooks)'
    )
  },
})

def({
  name: 'create_webhook',
  tier: 'admin',
  description: 'Create a webhook in a channel. Returns its id (use send_webhook_message); the secret URL is not returned.',
  properties: { guild_id: GUILD, channel: S('Channel id or name.'), name: S('Webhook name.'), reason: REASON },
  required: ['channel', 'name'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const ch: any = await resolveChannel(g, str(a, 'channel', true))
    if (!ch.createWebhook) throw new Error('this channel type does not support webhooks')
    const w = await ch.createWebhook({ name: str(a, 'name', true), reason: reasonOf(a) })
    return `created webhook ${clean(w.name)} (id: ${w.id}) in #${clean(ch.name)}`
  },
})

def({
  name: 'send_webhook_message',
  tier: 'admin',
  description: 'Post through a webhook the bot can use (one it created), with a custom name and avatar.',
  properties: {
    webhook_id: S('Webhook id.'),
    text: S('Message text.'),
    username: S('Display name for this message.'),
    avatar_url: S('Avatar image URL for this message.'),
    embeds: { type: 'array', description: 'Same embed format as send_message.', items: { type: 'object' } },
  },
  required: ['webhook_id'],
  async run(a, ctx) {
    const w = await deps.client.fetchWebhook(str(a, 'webhook_id', true))
    if (!w.guildId) throw new Error('webhook has no server')
    const guild = deps.client.guilds.cache.get(w.guildId)
    if (!guild) throw new Error('webhook is in a server the bot is not in')
    await checkGuildScope(guild, ctx)
    if (!w.token) throw new Error('the bot has no token for this webhook (only webhooks the bot created can be used)')
    const text = str(a, 'text')
    const embeds = buildEmbeds(a.embeds)
    if (!text && !embeds.length) throw new Error('nothing to send')
    const sent = await w.send({
      ...(text ? { content: text.slice(0, 2000) } : {}),
      ...(embeds.length ? { embeds } : {}),
      ...(str(a, 'username') ? { username: str(a, 'username') } : {}),
      ...(httpUrl(a.avatar_url, 'avatar_url') ? { avatarURL: httpUrl(a.avatar_url, 'avatar_url') } : {}),
      allowedMentions: { parse: ['users'] },
    })
    return `sent via webhook ${clean(w.name)} (message id: ${sent.id})`
  },
})

def({
  name: 'delete_webhook',
  tier: 'admin',
  description: 'Delete a webhook.',
  properties: { webhook_id: S('Webhook id.'), reason: REASON },
  required: ['webhook_id'],
  destructive: true,
  async run(a, ctx) {
    const w = await deps.client.fetchWebhook(str(a, 'webhook_id', true))
    const guild = w.guildId ? deps.client.guilds.cache.get(w.guildId) : undefined
    if (!guild) throw new Error('webhook is in a server the bot is not in')
    await checkGuildScope(guild, ctx)
    await w.delete(reasonOf(a))
    return `deleted webhook ${clean(w.name)} (${w.id})`
  },
})

// ----- Scheduled events ----------------------------------------------------

def({
  name: 'list_events',
  tier: 'read',
  description: 'List scheduled events of a server.',
  properties: { guild_id: GUILD },
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const evs = await g.scheduledEvents.fetch()
    return (
      [...evs.values()]
        .map(e => `${clean(e.name)} (id: ${e.id}) ${fmtDate(e.scheduledStartAt)} → ${fmtDate(e.scheduledEndAt)} @ ${e.channelId ? `<#${e.channelId}>` : clean(e.entityMetadata?.location) || '-'}, ${e.userCount ?? '?'} interested`)
        .join('\n') || '(no events)'
    )
  },
})

def({
  name: 'create_event',
  tier: 'admin',
  description:
    'Create a scheduled event. Give a voice/stage channel, or a location (then end is required). Times are ISO 8601, e.g. 2026-12-01T20:00:00+01:00.',
  properties: {
    guild_id: GUILD,
    name: S('Event name.'),
    start: S('Start time, ISO 8601.'),
    end: S('End time, ISO 8601.'),
    description: S('Description.'),
    channel: S('Voice or stage channel (id or name).'),
    location: S('External location (text or URL).'),
    reason: REASON,
  },
  required: ['name', 'start'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const start = new Date(str(a, 'start', true))
    if (isNaN(start.getTime())) throw new Error('start is not a valid date')
    const endStr = str(a, 'end')
    const end = endStr ? new Date(endStr) : undefined
    if (end && isNaN(end.getTime())) throw new Error('end is not a valid date')
    const chRef = str(a, 'channel')
    const location = str(a, 'location')
    if (!!chRef === !!location) throw new Error('pass exactly one of channel or location')
    let entityType: GuildScheduledEventEntityType
    let channel: GuildBasedChannel | undefined
    if (chRef) {
      channel = await resolveChannel(g, chRef)
      if (channel.type === ChannelType.GuildVoice) entityType = GuildScheduledEventEntityType.Voice
      else if (channel.type === ChannelType.GuildStageVoice) entityType = GuildScheduledEventEntityType.StageInstance
      else throw new Error('channel must be a voice or stage channel')
    } else {
      if (!end) throw new Error('an event with a location needs an end time')
      entityType = GuildScheduledEventEntityType.External
    }
    const ev = await g.scheduledEvents.create({
      name: str(a, 'name', true),
      scheduledStartTime: start,
      ...(end ? { scheduledEndTime: end } : {}),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType,
      ...(str(a, 'description') ? { description: str(a, 'description') } : {}),
      ...(channel ? { channel: channel.id } : {}),
      ...(location ? { entityMetadata: { location } } : {}),
      reason: reasonOf(a),
    } as any)
    return `created event ${clean(ev.name)} (id: ${ev.id}) at ${fmtDate(ev.scheduledStartAt)}`
  },
})

def({
  name: 'delete_event',
  tier: 'admin',
  description: 'Delete a scheduled event.',
  properties: { guild_id: GUILD, event_id: S('Event id.') },
  required: ['event_id'],
  destructive: true,
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const ev = await g.scheduledEvents.fetch(str(a, 'event_id', true))
    await ev.delete()
    return `deleted event ${clean(ev.name)} (${ev.id})`
  },
})

// ----- Invites -------------------------------------------------------------

def({
  name: 'list_invites',
  tier: 'admin',
  description: 'List active invites of a server.',
  properties: { guild_id: GUILD },
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const inv = await g.invites.fetch()
    return (
      [...inv.values()]
        .map(i => `${i.code} → #${clean(i.channel?.name)} by ${clean(i.inviter?.username) || '-'}, uses ${i.uses ?? 0}/${i.maxUses || '∞'}, expires ${fmtDate(i.expiresAt)}`)
        .join('\n') || '(no invites)'
    )
  },
})

def({
  name: 'create_invite',
  tier: 'admin',
  description: 'Create an invite link to a channel.',
  properties: {
    guild_id: GUILD,
    channel: S('Channel id or name.'),
    max_age_hours: N('Hours until it expires (0 = never, max 168). Default 24.'),
    max_uses: N('Max uses (0 = unlimited, max 100). Default 0.'),
    temporary: B('Members joined through it are kicked when they go offline unless given a role.'),
    reason: REASON,
  },
  required: ['channel'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const ch: any = await resolveChannel(g, str(a, 'channel', true))
    if (!ch.createInvite) throw new Error('cannot create an invite to this channel type')
    const inv = await ch.createInvite({
      maxAge: (num(a, 'max_age_hours', 0, 168) ?? 24) * 3600,
      maxUses: num(a, 'max_uses', 0, 100) ?? 0,
      temporary: bool(a, 'temporary') ?? false,
      unique: true,
      reason: reasonOf(a),
    })
    return `invite: https://discord.gg/${inv.code} (expires ${fmtDate(inv.expiresAt)})`
  },
})

def({
  name: 'delete_invite',
  tier: 'admin',
  description: 'Revoke an invite by code.',
  properties: { guild_id: GUILD, code: S('Invite code or discord.gg link.'), reason: REASON },
  required: ['code'],
  destructive: true,
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const code = str(a, 'code', true).replace(/^.*\//, '')
    const inv = await g.invites.fetch({ code, cache: false }).catch(() => null)
    if (!inv) throw new Error(`no invite ${clean(code)} in this server`)
    await g.invites.delete(code, reasonOf(a))
    return `revoked invite ${clean(code)}`
  },
})

// ----- Audit log & presence -----------------------------------------------

def({
  name: 'read_audit_log',
  tier: 'admin',
  description: "Read the server's Discord audit log (who did what). Filter by action name (e.g. MemberKick, MemberBanAdd, ChannelDelete, RoleUpdate, MessageDelete) and/or user id.",
  properties: {
    guild_id: GUILD,
    action: S('AuditLogEvent name, e.g. MemberKick.'),
    user: S('Only entries by this user id.'),
    limit: N('Max entries (default 20, max 100).'),
  },
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const actionName = str(a, 'action')
    let type: AuditLogEvent | undefined
    if (actionName) {
      const key = Object.keys(AuditLogEvent).find(k => isNaN(Number(k)) && k.toLowerCase() === actionName.toLowerCase())
      if (!key) throw new Error(`unknown action "${clean(actionName)}"`)
      type = (AuditLogEvent as any)[key]
    }
    const logs = await g.fetchAuditLogs({
      limit: num(a, 'limit', 1, 100) ?? 20,
      ...(type !== undefined ? { type } : {}),
      ...(str(a, 'user') ? { user: str(a, 'user') } : {}),
    } as any)
    return (
      [...logs.entries.values()]
        .map(e => {
          const changes = (e.changes ?? [])
            .slice(0, 5)
            .map(c => `${c.key}: ${clean(JSON.stringify(c.old ?? null)).slice(0, 60)} → ${clean(JSON.stringify(c.new ?? null)).slice(0, 60)}`)
            .join('; ')
          const action = (AuditLogEvent as any)[e.action] ?? e.action
          return `[${fmtDate(e.createdAt)}] ${action} by ${clean(e.executor?.username) || e.executorId || '-'} target ${e.targetId ?? '-'}${e.reason ? ` reason: ${clean(e.reason)}` : ''}${changes ? ` (${changes})` : ''}`
        })
        .join('\n') || '(no entries)'
    )
  },
})

const ACTIVITY: Record<string, ActivityType> = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
}

def({
  name: 'set_presence',
  tier: 'admin',
  description: "Set the bot's status (online/idle/dnd/invisible) and activity. activity_type custom shows text as a custom status.",
  properties: {
    status: { type: 'string', enum: ['online', 'idle', 'dnd', 'invisible'] },
    activity_type: { type: 'string', enum: Object.keys(ACTIVITY) },
    text: S('Activity text. Omit to clear the activity.'),
  },
  async run(a) {
    const user = deps.client.user
    if (!user) throw new Error('bot not connected yet')
    const status = (str(a, 'status') ?? 'online') as 'online' | 'idle' | 'dnd' | 'invisible'
    const text = str(a, 'text')
    const kind = str(a, 'activity_type') ?? 'custom'
    if (text && ACTIVITY[kind] === undefined) throw new Error(`activity_type must be one of ${Object.keys(ACTIVITY).join(', ')}`)
    user.setPresence({
      status,
      activities: text
        ? [kind === 'custom' ? { name: 'Custom Status', state: text.slice(0, 128), type: ActivityType.Custom } : { name: text.slice(0, 128), type: ACTIVITY[kind]! }]
        : [],
    })
    return `presence set: ${status}${text ? `, ${kind} "${clean(text)}"` : ''}`
  },
})
