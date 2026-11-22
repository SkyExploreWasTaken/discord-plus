// Offline tests for the Discord Plus security gate, audit log and DM contacts.
// Discord is replaced by small stubs; nothing connects to the network. Run with `bun test`.
// Tests share module state (the "who wrote last" trigger), so they run in file order.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { ChannelType } from 'discord.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { callPlusTool, initPlus, isPlusTool, noteInbound, plusContactInbound, plusToolList } from '../plus/index.ts'

const OWNER = '100000000000000001'
const ADMIN = '100000000000000002'
const STRANGER = '222222222222222222'
const ALICE = '333333333333333333' // DM contact, open DMs
const BOB = '444444444444444444' // DM contact, DMs closed

process.env.DISCORD_OWNER_ID = OWNER
process.env.DISCORD_ADMIN_IDS = ADMIN

const stateDir = mkdtempSync(join(tmpdir(), 'discord-plus-test-'))
afterAll(() => rmSync(stateDir, { recursive: true, force: true }))

let ownerInbox: string[] = []
let delivered: { content: string; meta: Record<string, string> }[] = []

const user = (id: string, name: string, dmsClosed = false) => ({
  id,
  username: name,
  bot: false,
  send: async (m: { content: string }) => {
    if (id === OWNER) {
      ownerInbox.push(m.content)
      return { id: '1', channelId: 'owner-dm' }
    }
    if (dmsClosed) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 })
    return { id: '777777777777777777', channelId: `dm-${id}` }
  },
})
const users: Record<string, ReturnType<typeof user>> = {
  [OWNER]: user(OWNER, 'owner'),
  [ADMIN]: user(ADMIN, 'admin'),
  [ALICE]: user(ALICE, 'alice'),
  [BOB]: user(BOB, 'bob', true),
}
const client: any = {
  user: { id: '1' },
  guilds: { cache: new Map() }, // the bot shares no server in these tests
  channels: { fetch: async () => null },
  users: { fetch: async (id: string) => users[id] },
}

initPlus({
  client,
  stateDir,
  loadAccess: () => ({ allowFrom: [OWNER], groups: {}, dmPolicy: 'allowlist' }) as any,
  fetchAllowedChannel: async (id: string) => {
    throw new Error(`channel ${id} is not allowlisted`)
  },
  assertSendable: () => {},
  noteSent: () => {},
  deliver: (content, meta) => delivered.push({ content, meta }),
})

const dm = (id: string, name: string, content = 'hi') =>
  ({
    author: { id, username: name },
    channel: { type: ChannelType.DM, sendTyping: async () => {} },
    channelId: `dm-${id}`,
    id: `msg-${id}-${Math.random()}`,
    guildId: null,
    content,
    attachments: new Map(),
    createdAt: new Date(),
  }) as any

const run = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await callPlusTool(name, args)
  return { text: r.content[0]!.text, isError: !!r.isError }
}
const auditLines = () =>
  readFileSync(join(stateDir, 'admin-audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const writeContacts = (c: Record<string, object>) =>
  writeFileSync(join(stateDir, 'dm-contacts.json'), JSON.stringify(c))
const contact = (name: string, extra: object = {}) => ({ username: name, dmChannelId: 'x', since: 'x', lastAt: 'x', ...extra })

beforeEach(() => {
  ownerInbox = []
  delivered = []
  writeContacts({ [ALICE]: contact('alice'), [BOB]: contact('bob') })
})

describe('tool list', () => {
  test('names are unique and admin tools are labelled', () => {
    const list = plusToolList()
    expect(new Set(list.map(t => t.name)).size).toBe(list.length)
    expect(list.find(t => t.name === 'kick_member')!.description.startsWith('[Owner/admin only]')).toBe(true)
    expect(list.find(t => t.name === 'list_roles')!.annotations.readOnlyHint).toBe(true)
    expect(isPlusTool('ban_user')).toBe(true)
    expect(isPlusTool('reply')).toBe(false) // official tools stay in server.ts
  })
})

describe('owner/admin gate', () => {
  // Must run first: no Discord message delivered yet = terminal = owner.
  test('terminal use counts as the owner', async () => {
    const r = await run('kick_member', { member: '123456789012345678' })
    expect(r.text).not.toContain('refused')
    expect(auditLines().at(-1).triggered_by).toContain('terminal')
  })

  test('a stranger is refused and the refusal is logged', async () => {
    noteInbound(dm(STRANGER, 'eve'))
    const r = await run('kick_member', { member: '123456789012345678' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('refused: owner or admin only')
    expect(auditLines().at(-1)).toMatchObject({ tool: 'kick_member', outcome: 'denied' })
  })

  test('a stranger cannot send outside opted-in channels', async () => {
    noteInbound(dm(STRANGER, 'eve'))
    expect((await run('send_message', { channel: '777777777777777777', text: 'x' })).text).toContain('refused')
  })

  test('an admin from DISCORD_ADMIN_IDS passes the gate, tagged [admin]', async () => {
    noteInbound(dm(ADMIN, 'admin'))
    const r = await run('kick_member', { member: '123456789012345678' })
    expect(r.text).not.toContain('refused')
    expect(auditLines().at(-1).triggered_by).toContain('[admin]')
  })

  test('the audit log fails closed', async () => {
    const blocker = join(stateDir, 'not-a-dir')
    writeFileSync(blocker, '')
    initPlus({ client, stateDir: blocker, loadAccess: () => ({ allowFrom: [], groups: {} }), fetchAllowedChannel: async () => null, assertSendable: () => {}, noteSent: () => {}, deliver: () => {} })
    noteInbound(dm(OWNER, 'owner'))
    const r = await run('set_presence', { text: 'x' })
    expect(r.isError).toBe(true)
    // Refused because the log couldn't be written (not because the stub client lacks setPresence).
    expect(r.text).toMatch(/EEXIST|ENOTDIR|ENOENT/)
    // restore
    initPlus({ client, stateDir, loadAccess: () => ({ allowFrom: [OWNER], groups: {}, dmPolicy: 'allowlist' }) as any, fetchAllowedChannel: async (id: string) => { throw new Error(`channel ${id} is not allowlisted`) }, assertSendable: () => {}, noteSent: () => {}, deliver: (content, meta) => delivered.push({ content, meta }) })
  })
})

describe('DM contacts', () => {
  test('only contacts and admins take the contact path', async () => {
    expect(await plusContactInbound(dm(STRANGER, 'eve'))).toBe(false)
    expect(await plusContactInbound(dm(OWNER, 'owner'))).toBe(false)
    expect(await plusContactInbound(dm(ALICE, 'alice', 'hello'))).toBe(true)
    expect(await plusContactInbound(dm(ADMIN, 'admin'))).toBe(true)
    expect(delivered.map(d => d.meta.user_id)).toEqual([ALICE, ADMIN])
    expect(delivered[0]!.meta.dm_contact).toBe('true')
    expect(ownerInbox).toEqual([]) // no copies to the owner
  })

  test('a contact can only get answers to themselves', async () => {
    noteInbound(dm(ALICE, 'alice'))
    expect((await run('send_dm', { user: ALICE, text: 'hi alice' })).isError).toBe(false)
    expect((await run('send_dm', { user: BOB, text: 'psst' })).text).toContain('refused')
    expect((await run('ban_user', { user: BOB })).text).toContain('refused')
    expect(ownerInbox).toEqual([])
  })

  test('a failed DM warns the owner', async () => {
    noteInbound(dm(OWNER, 'owner'))
    const r = await run('send_dm', { user: BOB, text: 'Hello Bob' })
    expect(r.text).toContain('do not accept DMs')
    expect(ownerInbox.some(m => m.startsWith('⚠️') && m.includes('Hello Bob'))).toBe(true)
  })

})
