import {
  ChannelType,
  type Message,
} from 'discord.js'
import { statSync } from 'fs'
import { B, type Ctx, GUILD, N, REASON, S, SA, def } from '../registry.ts'
import { checkGuildScope, resolveChannel, resolveGuild } from '../scope.ts'
import { deps, isAdmin, loadContacts } from '../state.ts'
import { type Args, bool, buildEmbeds, buildLinkButtons, clean, idFrom, num, reasonOf, str, strArr } from '../util.ts'

// ----- Messages -----------------------------------------------------------

def({
  name: 'send_message',
  tier: 'chat',
  description:
    'Send a rich message: text, embeds, link buttons, a poll and/or files. channel can be an id, <#id> or a channel name (with guild_id or the current server). Opted-in channels work for anyone; any other channel is owner only.',
  properties: {
    channel: S('Channel id, <#id> mention, or name like "general".'),
    guild_id: GUILD,
    text: S('Message text, up to 2000 characters.'),
    embeds: {
      type: 'array',
      description:
        'Up to 10 embeds: {title, description, url, color: "#hex", fields: [{name, value, inline}], footer, author, image: url, thumbnail: url, timestamp: true|ISO}.',
      items: { type: 'object' },
    },
    buttons: { type: 'array', description: 'Link buttons: [{label, url}], up to 25.', items: { type: 'object' } },
    poll: {
      type: 'object',
      description: 'A poll: {question, answers: [string], duration_hours (1-768, default 24), multiselect: bool}.',
    },
    reply_to: S('Message id to reply to.'),
    files: SA('Absolute file paths to attach (max 10, 25MB each).'),
    allow_everyone_ping: B('Let @everyone/@here and role mentions ping. Owner only. Default false.'),
  },
  required: ['channel'],
  async run(a, ctx) {
    const ref = str(a, 'channel', true)
    let ch: any
    const id = idFrom(ref, /^<#(\d+)>$/)
    if (id) {
      try {
        ch = await deps.fetchAllowedChannel(id)
      } catch (err) {
        if (!/not allowlisted/.test(String(err))) throw err
        ctx.escalate('channel is not opted in')
        ch = await deps.client.channels.fetch(id)
        if (!ch || !('guild' in ch)) throw new Error(`channel ${id} not found`)
        await checkGuildScope(ch.guild, ctx)
      }
    } else {
      const guild = await resolveGuild(a, ctx)
      const found = await resolveChannel(guild, ref, { category: false })
      try {
        ch = await deps.fetchAllowedChannel(found.id)
      } catch (err) {
        if (!/not allowlisted/.test(String(err))) throw err
        ctx.escalate('channel is not opted in')
        ch = found
      }
    }
    if (!ch || !('send' in ch)) throw new Error('channel is not sendable')

    const text = str(a, 'text')
    if (text && text.length > 2000) throw new Error('text over 2000 characters: split it, or use the reply tool which chunks')
    const embeds = buildEmbeds(a.embeds)
    const components = buildLinkButtons(a.buttons)
    const files = strArr(a, 'files')
    if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')
    for (const f of files) {
      deps.assertSendable(f)
      if (statSync(f).size > 25 * 1024 * 1024) throw new Error(`file too large: ${f}`)
    }
    let poll: any
    if (a.poll !== undefined && a.poll !== null) {
      const p = a.poll as Record<string, unknown>
      const question = str(p, 'question', true)
      const answers = strArr(p, 'answers')
      if (answers.length < 1 || answers.length > 10) throw new Error('poll needs 1-10 answers')
      poll = {
        question: { text: question.slice(0, 300) },
        answers: answers.map(t => ({ text: t.slice(0, 55) })),
        duration: num(p, 'duration_hours', 1, 768) ?? 24,
        allowMultiselect: bool(p, 'multiselect') ?? false,
      }
    }
    if (!text && embeds.length === 0 && !poll && files.length === 0) throw new Error('nothing to send')

    const everyone = bool(a, 'allow_everyone_ping') ?? false
    if (everyone) ctx.escalate('allow_everyone_ping')
    const reply_to = str(a, 'reply_to')
    const sent = await ch.send({
      ...(text ? { content: text } : {}),
      ...(embeds.length ? { embeds } : {}),
      ...(components.length ? { components } : {}),
      ...(files.length ? { files } : {}),
      ...(poll ? { poll } : {}),
      ...(reply_to ? { reply: { messageReference: reply_to, failIfNotExists: false } } : {}),
      allowedMentions: everyone ? { parse: ['users', 'roles', 'everyone'] } : { parse: ['users'] },
    })
    deps.noteSent(sent.id)
    return `sent to #${clean(ch.name ?? ch.id)} (message id: ${sent.id}, channel id: ${ch.id})`
  },
})

async function fetchGuildMessage(a: Args, ctx: Ctx) {
  const guild = await resolveGuild(a, ctx)
  const ch: any = await resolveChannel(guild, str(a, 'channel', true))
  if (!ch.isTextBased?.()) throw new Error('not a text channel')
  return { guild, ch }
}

def({
  name: 'delete_message',
  tier: 'chat',
  description:
    "Delete one message. The bot's own messages in opted-in channels can be deleted by anyone it talks to, and in a DM-contact conversation by that contact or an owner/admin; anything else is owner/admin only.",
  properties: { channel: S('Channel id or name.'), guild_id: GUILD, message_id: S('Message id.'), reason: REASON },
  required: ['channel', 'message_id'],
  destructive: true,
  async run(a, ctx) {
    const chRef = str(a, 'channel', true)
    const chId = idFrom(chRef, /^<#(\d+)>$/)
    let ch: any = null
    if (chId) ch = await deps.fetchAllowedChannel(chId).catch(() => null)
    if (!ch && chId) {
      // DM with a contact/admin (not on the allowlist): the bot may delete its own messages there
      // when the owner/an admin asks, or the person in that DM asks.
      // Cached DM channels can lack recipientId, so prefer the contacts file (it stores each DM channel id).
      const dm: any = await deps.client.channels.fetch(chId, { force: true }).catch(() => null)
      const byFile = Object.entries(loadContacts()).find(([, c]) => c.dmChannelId === chId)?.[0]
      const rid: string | undefined = dm?.type === ChannelType.DM ? (byFile ?? dm.recipientId ?? dm.recipient?.id) : undefined
      if (rid && (loadContacts()[rid] || isAdmin(rid)) && (ctx.actor.privileged || ctx.actor.trigger?.userId === rid)) ch = dm
    }
    const msg = ch ? await ch.messages.fetch(str(a, 'message_id', true)) : null
    if (!msg || msg.author.id !== deps.client.user?.id) {
      ctx.escalate("deleting a message that isn't the bot's own in an opted-in channel")
      const { ch: gch } = await fetchGuildMessage(a, ctx)
      const m = await gch.messages.fetch(str(a, 'message_id', true))
      await m.delete()
      return `deleted message ${m.id} by ${clean(m.author.username)}`
    }
    await msg.delete()
    return `deleted own message ${msg.id}`
  },
})

def({
  name: 'bulk_delete',
  tier: 'admin',
  description:
    'Bulk delete recent messages in a channel (Discord only bulk-deletes messages under 14 days old). Pass count (2-100) for the latest N, or message_ids. Optional from_user limits a count-based delete to one user.',
  properties: {
    channel: S('Channel id or name.'),
    guild_id: GUILD,
    count: N('How many recent messages to scan and delete (2-100).'),
    message_ids: SA('Specific message ids (2-100).'),
    from_user: S('Only delete messages by this user id (with count).'),
  },
  required: ['channel'],
  destructive: true,
  async run(a, ctx) {
    const { ch } = await fetchGuildMessage(a, ctx)
    const ids = strArr(a, 'message_ids')
    let target: any
    if (ids.length) {
      if (ids.length > 100) throw new Error('at most 100 ids')
      target = ids
    } else {
      const count = num(a, 'count', 1, 100)
      if (!count) throw new Error('pass count or message_ids')
      const from = str(a, 'from_user')
      if (from) {
        const msgs = await ch.messages.fetch({ limit: 100 })
        target = [...msgs.values()].filter((m: Message) => m.author.id === from).slice(0, count).map((m: Message) => m.id)
      } else target = count
    }
    const deleted = await ch.bulkDelete(target, true)
    return `deleted ${deleted.size} message(s) in #${clean(ch.name)} (older than 14 days are skipped)`
  },
})

def({
  name: 'pin_message',
  tier: 'admin',
  description: 'Pin or unpin a message.',
  properties: {
    channel: S('Channel id or name.'),
    guild_id: GUILD,
    message_id: S('Message id.'),
    action: { type: 'string', enum: ['pin', 'unpin'], description: 'Default pin.' },
    reason: REASON,
  },
  required: ['channel', 'message_id'],
  async run(a, ctx) {
    const { ch } = await fetchGuildMessage(a, ctx)
    const msg = await ch.messages.fetch(str(a, 'message_id', true))
    if (str(a, 'action') === 'unpin') {
      await msg.unpin(reasonOf(a))
      return `unpinned ${msg.id}`
    }
    await msg.pin(reasonOf(a))
    return `pinned ${msg.id}`
  },
})
