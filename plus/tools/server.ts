import {
  ChannelType,
  PermissionFlagsBits,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
} from 'discord.js'
import { B, GUILD, N, REASON, S, SA, def } from '../registry.ts'
import { CHANNEL_TYPE_NAMES, CREATABLE_TYPES, eligibleGuilds, optedInGuildIds, resolveChannel, resolveGuild, resolveMember, resolveRole } from '../scope.ts'
import { deps } from '../state.ts'
import { bool, clean, fmtDate, num, parseColor, permBits, permName, reasonOf, str, strArr } from '../util.ts'

// ----- Server info (read) ------------------------------------------------

def({
  name: 'list_servers',
  tier: 'read',
  description: 'List the servers the bot shares with the owner (the servers Discord Plus can act on).',
  properties: {},
  async run(_a, ctx) {
    let list = await eligibleGuilds()
    if (!ctx.actor.privileged) {
      const opted = await optedInGuildIds()
      list = list.filter(g => opted.has(g.id))
    }
    if (!list.length) return '(no servers)'
    return list.map(g => `${clean(g.name)} (id: ${g.id}, ${g.memberCount} members)`).join('\n')
  },
})

def({
  name: 'server_info',
  tier: 'read',
  description: 'Show server details: owner, member count, boosts, channel and role counts, features.',
  properties: { guild_id: GUILD },
  async run(a, ctx) {
    const g = await (await resolveGuild(a, ctx)).fetch()
    const channels = await g.channels.fetch()
    return [
      `${clean(g.name)} (id: ${g.id})`,
      `owner: ${g.ownerId}`,
      `members: ${g.memberCount}`,
      `created: ${fmtDate(g.createdAt)}`,
      `boost tier: ${g.premiumTier}, boosts: ${g.premiumSubscriptionCount ?? 0}`,
      `channels: ${channels.size}, roles: ${g.roles.cache.size}`,
      `verification level: ${g.verificationLevel}`,
      `features: ${g.features.join(', ') || '-'}`,
    ].join('\n')
  },
})

def({
  name: 'list_channels',
  tier: 'read',
  description: 'List the channels of a server, grouped by category, with ids and types.',
  properties: { guild_id: GUILD },
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const all = [...(await g.channels.fetch()).values()].filter((c): c is NonNullable<typeof c> => !!c)
    const opted = deps.loadAccess().groups
    const line = (c: GuildBasedChannel) =>
      `${c.type === ChannelType.GuildCategory || !c.parentId ? '' : '  '}#${clean(c.name)} (${CHANNEL_TYPE_NAMES[c.type] ?? c.type}, id: ${c.id})${c.id in opted ? ' [opted in]' : ''}`
    const pos = (c: any) => c.rawPosition ?? 0
    const cats = all.filter(c => c.type === ChannelType.GuildCategory).sort((x, y) => pos(x) - pos(y))
    const out: string[] = []
    for (const c of all.filter(c => c.type !== ChannelType.GuildCategory && !c.parentId).sort((x, y) => pos(x) - pos(y))) out.push(line(c))
    for (const cat of cats) {
      out.push(line(cat))
      for (const c of all.filter(c => c.parentId === cat.id).sort((x, y) => pos(x) - pos(y))) out.push(line(c))
    }
    return out.join('\n') || '(no channels)'
  },
})

def({
  name: 'list_roles',
  tier: 'read',
  description: 'List the roles of a server, highest first, with ids, colors and key permissions.',
  properties: { guild_id: GUILD },
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const roles = [...(await g.roles.fetch()).values()].sort((x, y) => y.position - x.position)
    return roles
      .map(r => {
        const flags = [
          r.permissions.has(PermissionFlagsBits.Administrator) ? 'Administrator' : '',
          r.managed ? 'managed' : '',
          r.hoist ? 'hoisted' : '',
          r.mentionable ? 'mentionable' : '',
        ].filter(Boolean)
        return `@${clean(r.name)} (id: ${r.id}, pos ${r.position}, ${r.hexColor}${flags.length ? ', ' + flags.join(', ') : ''})`
      })
      .join('\n')
  },
})

// ----- Server structure ---------------------------------------------------

def({
  name: 'create_channel',
  tier: 'admin',
  description: 'Create a channel or category.',
  properties: {
    guild_id: GUILD,
    name: S('Channel name.'),
    type: { type: 'string', enum: Object.keys(CREATABLE_TYPES), description: 'Default text.' },
    category: S('Parent category (id or name).'),
    topic: S('Channel topic (text/announcement/forum).'),
    nsfw: B('Age-restricted.'),
    slowmode_seconds: N('Slowmode, 0-21600.'),
    user_limit: N('Voice user limit, 0-99.'),
    private: B('Hide from @everyone (only roles/members you then allow can see it).'),
    reason: REASON,
  },
  required: ['name'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const typeName = str(a, 'type') ?? 'text'
    const type = CREATABLE_TYPES[typeName]
    if (type === undefined) throw new Error(`type must be one of ${Object.keys(CREATABLE_TYPES).join(', ')}`)
    const catRef = str(a, 'category')
    const parent = catRef ? await resolveChannel(g, catRef, { category: true }) : undefined
    const ch = await g.channels.create({
      name: str(a, 'name', true),
      type: type as any,
      ...(parent ? { parent: parent.id } : {}),
      ...(str(a, 'topic') ? { topic: str(a, 'topic') } : {}),
      ...(bool(a, 'nsfw') !== undefined ? { nsfw: bool(a, 'nsfw') } : {}),
      ...(num(a, 'slowmode_seconds', 0, 21600) !== undefined ? { rateLimitPerUser: num(a, 'slowmode_seconds') } : {}),
      ...(num(a, 'user_limit', 0, 99) !== undefined ? { userLimit: num(a, 'user_limit') } : {}),
      ...(bool(a, 'private')
        ? { permissionOverwrites: [{ id: g.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }] }
        : {}),
      reason: reasonOf(a),
    })
    return `created ${typeName} #${clean(ch.name)} (id: ${ch.id})`
  },
})

def({
  name: 'edit_channel',
  tier: 'admin',
  description: 'Edit a channel or category. Pass only what changes. category "none" moves it out of its category.',
  properties: {
    guild_id: GUILD,
    channel: S('Channel id or name.'),
    name: S('New name.'),
    topic: S('New topic.'),
    category: S('New parent category (id or name), or "none".'),
    nsfw: B('Age-restricted.'),
    slowmode_seconds: N('Slowmode, 0-21600.'),
    user_limit: N('Voice user limit, 0-99.'),
    position: N('New position.'),
    sync_permissions: B('Sync permissions with the (new) category.'),
    reason: REASON,
  },
  required: ['channel'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const ch: any = await resolveChannel(g, str(a, 'channel', true))
    const catRef = str(a, 'category')
    const parent =
      catRef === undefined ? undefined : catRef.toLowerCase() === 'none' ? null : (await resolveChannel(g, catRef, { category: true })).id
    const edit: Record<string, unknown> = { reason: reasonOf(a) }
    if (str(a, 'name')) edit.name = str(a, 'name')
    if (a.topic !== undefined) edit.topic = str(a, 'topic') ?? null
    if (parent !== undefined) edit.parent = parent
    if (bool(a, 'nsfw') !== undefined) edit.nsfw = bool(a, 'nsfw')
    if (num(a, 'slowmode_seconds', 0, 21600) !== undefined) edit.rateLimitPerUser = num(a, 'slowmode_seconds')
    if (num(a, 'user_limit', 0, 99) !== undefined) edit.userLimit = num(a, 'user_limit')
    if (num(a, 'position', 0) !== undefined) edit.position = num(a, 'position')
    if (bool(a, 'sync_permissions') !== undefined) edit.lockPermissions = bool(a, 'sync_permissions')
    if (Object.keys(edit).length === 1) throw new Error('nothing to change')
    const updated = await ch.edit(edit)
    return `edited #${clean(updated.name)} (id: ${updated.id})`
  },
})

def({
  name: 'delete_channel',
  tier: 'admin',
  description: 'Delete a channel or category (a category\'s channels are kept, uncategorized). Cannot be undone.',
  properties: { guild_id: GUILD, channel: S('Channel id or name.'), reason: REASON },
  required: ['channel'],
  destructive: true,
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const ch = await resolveChannel(g, str(a, 'channel', true))
    const name = ch.name
    await ch.delete(reasonOf(a))
    const note = ch.id in deps.loadAccess().groups ? ' It was opted in; remove it from access with /discord-plus:access.' : ''
    return `deleted #${clean(name)} (id: ${ch.id}).${note}`
  },
})

def({
  name: 'set_channel_permissions',
  tier: 'admin',
  description:
    'Edit a permission overwrite on a channel for a role or member. allow/deny/inherit take permission names like ViewChannel, SendMessages, ManageMessages, Connect. remove: true deletes the whole overwrite.',
  properties: {
    guild_id: GUILD,
    channel: S('Channel id or name.'),
    role: S('Role (id, <@&id>, name, or @everyone). Pass role or member.'),
    member: S('Member (id, mention or exact name). Pass role or member.'),
    allow: SA('Permissions to allow.'),
    deny: SA('Permissions to deny.'),
    inherit: SA('Permissions to reset to inherit.'),
    remove: B('Delete this overwrite entirely.'),
    reason: REASON,
  },
  required: ['channel'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const ch: any = await resolveChannel(g, str(a, 'channel', true))
    const roleRef = str(a, 'role')
    const memberRef = str(a, 'member')
    if (!!roleRef === !!memberRef) throw new Error('pass exactly one of role or member')
    const target: Role | GuildMember = roleRef ? await resolveRole(g, roleRef) : await resolveMember(g, memberRef!)
    const label = roleRef ? `@${clean((target as Role).name)}` : clean((target as GuildMember).user.username)
    if (bool(a, 'remove')) {
      await ch.permissionOverwrites.delete(target.id, reasonOf(a))
      return `removed overwrite for ${label} on #${clean(ch.name)}`
    }
    const changes: Record<string, boolean | null> = {}
    for (const p of strArr(a, 'allow')) changes[permName(p)] = true
    for (const p of strArr(a, 'deny')) changes[permName(p)] = false
    for (const p of strArr(a, 'inherit')) changes[permName(p)] = null
    if (!Object.keys(changes).length) throw new Error('pass allow, deny, inherit or remove')
    await ch.permissionOverwrites.edit(target, changes, { reason: reasonOf(a) })
    return `updated overwrite for ${label} on #${clean(ch.name)}: ${Object.entries(changes).map(([k, v]) => `${k}=${v === null ? 'inherit' : v ? 'allow' : 'deny'}`).join(', ')}`
  },
})

def({
  name: 'create_role',
  tier: 'admin',
  description: 'Create a role.',
  properties: {
    guild_id: GUILD,
    name: S('Role name.'),
    color: S('Hex color like #5865F2.'),
    hoist: B('Show members separately in the member list.'),
    mentionable: B('Anyone can @mention it.'),
    permissions: SA('Permission names, e.g. ["SendMessages", "ManageMessages"]. Default: none.'),
    reason: REASON,
  },
  required: ['name'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const role = await g.roles.create({
      name: str(a, 'name', true),
      color: parseColor(a.color),
      hoist: bool(a, 'hoist') ?? false,
      mentionable: bool(a, 'mentionable') ?? false,
      permissions: permBits(strArr(a, 'permissions')),
      reason: reasonOf(a),
    })
    return `created role @${clean(role.name)} (id: ${role.id})`
  },
})

def({
  name: 'edit_role',
  tier: 'admin',
  description:
    'Edit a role. permissions replaces the whole set; add_permissions/remove_permissions change it. Pass only what changes.',
  properties: {
    guild_id: GUILD,
    role: S('Role id, <@&id> or name.'),
    name: S('New name.'),
    color: S('Hex color.'),
    hoist: B('Show separately.'),
    mentionable: B('Mentionable.'),
    permissions: SA('Replace all permissions with these.'),
    add_permissions: SA('Permissions to add.'),
    remove_permissions: SA('Permissions to remove.'),
    position: N('New position (higher = more powerful).'),
    reason: REASON,
  },
  required: ['role'],
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const role = await resolveRole(g, str(a, 'role', true))
    const edit: Record<string, unknown> = { reason: reasonOf(a) }
    if (str(a, 'name')) edit.name = str(a, 'name')
    if (a.color !== undefined) edit.color = parseColor(a.color)
    if (bool(a, 'hoist') !== undefined) edit.hoist = bool(a, 'hoist')
    if (bool(a, 'mentionable') !== undefined) edit.mentionable = bool(a, 'mentionable')
    if (a.permissions !== undefined || a.add_permissions !== undefined || a.remove_permissions !== undefined) {
      let bits = a.permissions !== undefined ? permBits(strArr(a, 'permissions')) : role.permissions.bitfield
      bits |= permBits(strArr(a, 'add_permissions'))
      bits &= ~permBits(strArr(a, 'remove_permissions'))
      edit.permissions = bits
    }
    if (num(a, 'position', 0) !== undefined) edit.position = num(a, 'position')
    if (Object.keys(edit).length === 1) throw new Error('nothing to change')
    const updated = await role.edit(edit)
    return `edited role @${clean(updated.name)} (id: ${updated.id})`
  },
})

def({
  name: 'delete_role',
  tier: 'admin',
  description: 'Delete a role. Cannot be undone.',
  properties: { guild_id: GUILD, role: S('Role id, <@&id> or name.'), reason: REASON },
  required: ['role'],
  destructive: true,
  async run(a, ctx) {
    const g = await resolveGuild(a, ctx)
    const role = await resolveRole(g, str(a, 'role', true))
    if (role.id === g.roles.everyone.id) throw new Error('cannot delete @everyone')
    await role.delete(reasonOf(a))
    return `deleted role @${clean(role.name)} (${role.id})`
  },
})
