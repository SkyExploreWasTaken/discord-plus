import {
  type Client,
  type Message,
} from 'discord.js'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tools } from './registry.ts'

// ---------------------------------------------------------------------------
// Wiring

export type AccessLike = { allowFrom: string[]; groups: Record<string, unknown> }

export type PlusDeps = {
  client: Client
  stateDir: string
  loadAccess: () => AccessLike
  fetchAllowedChannel: (id: string) => Promise<any>
  assertSendable: (path: string) => void
  noteSent: (id: string) => void
  /** Push an inbound message into the session (notifications/claude/channel). */
  deliver: (content: string, meta: Record<string, string>) => void
}

export let deps: PlusDeps
export let AUDIT_FILE = ''
export let CONTACTS_FILE = ''

// The bot owner's Discord user id: DISCORD_OWNER_ID in <state dir>/.env. There is no default.
// Without it, nobody on Discord can use admin tools and server tools refuse to run (fail closed).
// Read lazily: server.ts loads <state dir>/.env after this module is imported.
export function ownerId(): string {
  const v = (process.env.DISCORD_OWNER_ID ?? '').trim()
  return /^\d{17,20}$/.test(v) ? v : ''
}

export function requireOwnerId(): string {
  const id = ownerId()
  if (!id) throw new Error('DISCORD_OWNER_ID is not set: add your Discord user id to ~/.claude/channels/discord-plus/.env')
  return id
}

/**
 * Extra accounts with owner-level rights for the admin tools: DISCORD_ADMIN_IDS in <state dir>/.env
 * (comma-separated user ids). Set by the owner in the terminal only. Admins are NOT added to
 * access.json allowFrom, so they never receive or approve Claude Code permission prompts.
 */
export function adminIds(): Set<string> {
  const ids = (process.env.DISCORD_ADMIN_IDS ?? '').split(',').map(x => x.trim()).filter(x => /^\d{17,20}$/.test(x))
  return new Set([ownerId(), ...ids].filter(Boolean))
}

export function isAdmin(userId: string): boolean {
  return adminIds().has(userId)
}

export function initPlus(d: PlusDeps): void {
  deps = d
  AUDIT_FILE = join(d.stateDir, 'admin-audit.log')
  CONTACTS_FILE = join(d.stateDir, 'dm-contacts.json')
}

// ---------------------------------------------------------------------------
// Who triggered the current turn

export type Trigger = {
  userId: string
  username: string
  chatId: string
  messageId: string
  guildId: string | null
  at: string
}

export let lastTrigger: Trigger | null = null

/** Called by server.ts for every message delivered into the session. */
export function noteInbound(msg: Message): void {
  lastTrigger = {
    userId: msg.author.id,
    username: msg.author.username,
    chatId: msg.channelId,
    messageId: msg.id,
    guildId: msg.guildId ?? null,
    at: new Date().toISOString(),
  }
}

/** privileged = has owner-level rights (the owner or a DISCORD_ADMIN_IDS admin). */
export function actor(): { privileged: boolean; label: string; trigger: Trigger | null } {
  if (!lastTrigger) {
    return { privileged: true, label: 'terminal (no Discord message delivered this session)', trigger: null }
  }
  return {
    privileged: isAdmin(lastTrigger.userId),
    label: `${lastTrigger.username} (${lastTrigger.userId})${lastTrigger.userId !== ownerId() && isAdmin(lastTrigger.userId) ? ' [admin]' : ''}`,
    trigger: lastTrigger,
  }
}

// ---------------------------------------------------------------------------
// Audit log

export function audit(entry: Record<string, unknown>): void {
  mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 })
  appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
}

export function auditSafe(entry: Record<string, unknown>): void {
  try {
    audit(entry)
  } catch (err) {
    process.stderr.write(`discord-plus: failed to write audit log: ${err}\n`)
  }
}

// ---------------------------------------------------------------------------
// DM contacts
//
// People the owner had the bot DM (send_dm). Their DM replies are delivered to the session
// even though they are NOT in access.allowFrom. They are deliberately kept out of allowFrom:
// allowFrom users also receive Claude Code permission prompts and can approve them.
// Contacts never count as the owner, so admin tools stay refused while they wrote last.
// Failed sends and DM floods are reported to the owner. Only send_dm (owner/admin) adds
// contacts; remove_dm_contact (owner) removes them.

export type Contact = {
  username: string
  dmChannelId: string
  since: string
  lastAt: string
}

export function loadContacts(): Record<string, Contact> {
  try {
    return JSON.parse(readFileSync(CONTACTS_FILE, 'utf8'))
  } catch {
    return {}
  }
}

export function saveContacts(c: Record<string, Contact>): void {
  mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 })
  const tmp = CONTACTS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, CONTACTS_FILE)
}

/** Send text to the owner's DM, split to fit Discord's 2000-char limit. Never throws. */
export async function tellOwner(text: string): Promise<void> {
  try {
    const owner = await deps.client.users.fetch(ownerId())
    for (let i = 0; i < text.length; i += 1900) {
      const sent = await owner.send({ content: text.slice(i, i + 1900), allowedMentions: { parse: [] } })
      deps.noteSent(sent.id)
    }
  } catch (err) {
    process.stderr.write(`discord-plus: could not message the owner: ${err}\n`)
  }
}
