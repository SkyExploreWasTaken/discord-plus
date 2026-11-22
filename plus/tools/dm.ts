import {
  ChannelType,
  type Message,
} from 'discord.js'
import { statSync } from 'fs'
import { B, GUILD, S, SA, def } from '../registry.ts'
import { resolveGuild, resolveMember } from '../scope.ts'
import { type AccessLike, deps, isAdmin, loadContacts, noteInbound, ownerId, saveContacts, tellOwner } from '../state.ts'
import { bool, clean, idFrom, str, strArr } from '../util.ts'

// Flood guard: max messages per contact per minute before we stop delivering.
const CONTACT_RATE = 8
const contactHits = new Map<string, number[]>()

/**
 * Called by server.ts before the official gate. Returns true when the message was a DM from a
 * contact and has been handled here (delivered or rate-limited); false lets the official gate run.
 */
export async function plusContactInbound(msg: Message): Promise<boolean> {
  if (msg.channel.type !== ChannelType.DM) return false
  const sender = msg.author.id
  if (sender === ownerId()) return false
  const access = deps.loadAccess() as AccessLike & { dmPolicy?: string }
  if (access.dmPolicy === 'disabled' || access.allowFrom.includes(sender)) return false
  const contacts = loadContacts()
  // Admins' DMs are delivered like a contact's without needing send_dm first.
  if (!contacts[sender] && isAdmin(sender)) {
    const now = new Date().toISOString()
    contacts[sender] = { username: msg.author.username, dmChannelId: msg.channelId, since: now, lastAt: now }
  }
  const c = contacts[sender]
  if (!c) return false

  const now = Date.now()
  const hits = (contactHits.get(sender) ?? []).filter(t => now - t < 60_000)
  hits.push(now)
  contactHits.set(sender, hits)
  if (hits.length > CONTACT_RATE) {
    if (hits.length === CONTACT_RATE + 1) await tellOwner(`⚠️ ${msg.author.username} is sending a lot of DMs; pausing delivery for a minute.`)
    return true
  }

  c.lastAt = new Date().toISOString()
  c.dmChannelId = msg.channelId
  c.username = msg.author.username
  saveContacts(contacts)

  const atts = [...msg.attachments.values()].map(a => `${(a.name ?? a.id).replace(/[\[\]\r\n;]/g, '_')} (${a.contentType ?? 'unknown'})`)
  noteInbound(msg)
  if ('sendTyping' in msg.channel) void msg.channel.sendTyping().catch(() => {})
  deps.deliver(msg.content || (atts.length ? '(attachment)' : ''), {
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.author.username,
    user_id: sender,
    ts: msg.createdAt.toISOString(),
    dm_contact: 'true',
    ...(atts.length ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
  })
  return true
}

// ----- Direct messages to server members ------------------------------------

def({
  name: 'send_dm',
  tier: 'chat',
  description:
    'DM a member of a server shared with the owner. Starting a conversation with someone new is owner only and makes them a DM contact: their DM replies then reach you (marked dm_contact="true"). Answer a contact with this tool (pass their user id), not reply. While a contact wrote last you may only DM that contact. Failed sends are reported to the owner.',
  properties: {
    user: S('User id, <@id> mention, or exact username/nickname of a member.'),
    guild_id: GUILD,
    text: S('Message text (up to 2000 characters).'),
    files: SA('Absolute file paths to attach (max 10, 25MB each).'),
  },
  required: ['user', 'text'],
  async run(a, ctx) {
    const ref = str(a, 'user', true)
    const text = str(a, 'text', true)
    if (text.length > 2000) throw new Error('text over 2000 characters: split it into several send_dm calls')
    const files = strArr(a, 'files')
    if (files.length > 10) throw new Error('Discord allows max 10 attachments per message')
    for (const f of files) {
      deps.assertSendable(f)
      if (statSync(f).size > 25 * 1024 * 1024) throw new Error(`file too large: ${f}`)
    }

    const contacts = loadContacts()
    let userId = idFrom(ref, /^<@!?(\d+)>$/)
    if (!userId || !contacts[userId]) {
      // Not a known contact: resolve through a shared server.
      const guild = await resolveGuild(a, ctx)
      userId = (await resolveMember(guild, ref)).id
    }
    if (userId === ownerId()) throw new Error('that is the owner: use reply in the owner DM instead')
    const user = await deps.client.users.fetch(userId)
    if (user.bot) throw new Error('refusing to DM a bot')

    const isContact = !!contacts[userId]
    if (!isContact) ctx.escalate('starting a DM with a new contact')
    else if (!ctx.actor.privileged && ctx.actor.trigger?.userId !== userId) {
      ctx.escalate('DMing a contact other than the one who wrote last')
    }
    // A new contact was resolved via resolveGuild + resolveMember above, so they are a member
    // of a server the owner is in.

    let sent
    try {
      sent = await user.send({ content: text, ...(files.length ? { files } : {}), allowedMentions: { parse: ['users'] } })
    } catch (err) {
      const code = (err as { code?: number }).code
      const why =
        code === 50007
          ? 'they do not accept DMs from server members (or blocked the bot)'
          : err instanceof Error ? err.message : String(err)
      await tellOwner(`⚠️ Couldn't DM **${clean(user.username)}** (${userId}): ${why}\nMessage was:\n${text}`)
      throw new Error(`could not DM ${user.username}: ${why} (the owner was told)`)
    }
    deps.noteSent(sent.id)
    const now = new Date().toISOString()
    const c = loadContacts()
    c[userId] = { ...c[userId], username: user.username, dmChannelId: sent.channelId, since: c[userId]?.since ?? now, lastAt: now }
    saveContacts(c)
    return `DM sent to ${clean(user.username)} (message id: ${sent.id}). ${isContact ? '' : 'They are now a DM contact: their replies will reach you. '}A copy was sent to the owner.`
  },
})

def({
  name: 'list_dm_contacts',
  tier: 'admin',
  description: 'List DM contacts (people whose DMs reach you because the owner had you DM them).',
  properties: {},
  async run() {
    const c = loadContacts()
    const rows = Object.entries(c).map(
      ([id, v]) =>
        `${clean(v.username)} (${id}) since ${v.since}, last activity ${v.lastAt}`,
    )
    return rows.join('\n') || '(no DM contacts)'
  },
})

def({
  name: 'remove_dm_contact',
  tier: 'admin',
  description: 'Stop receiving DMs from a contact. You can still be told to DM them again later.',
  properties: { user: S('User id of the contact.') },
  required: ['user'],
  async run(a) {
    const id = idFrom(str(a, 'user', true), /^<@!?(\d+)>$/)
    const c = loadContacts()
    if (!id || !c[id]) throw new Error('not a DM contact (pass their user id)')
    const name = c[id]!.username
    delete c[id]
    saveContacts(c)
    return `removed ${clean(name)} (${id}) from DM contacts`
  },
})
