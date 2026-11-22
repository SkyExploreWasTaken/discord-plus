import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type APIEmbed,
} from 'discord.js'

// ---------------------------------------------------------------------------
// Argument helpers

export type Args = Record<string, unknown>

export function str(a: Args, k: string): string | undefined
export function str(a: Args, k: string, required: true): string
export function str(a: Args, k: string, required = false): string | undefined {
  const v = a[k]
  if (v === undefined || v === null || v === '') {
    if (required) throw new Error(`missing required argument: ${k}`)
    return undefined
  }
  if (typeof v !== 'string') throw new Error(`${k} must be a string`)
  return v
}

export function num(a: Args, k: string, min?: number, max?: number): number | undefined {
  const v = a[k]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${k} must be a number`)
  if (min !== undefined && n < min) throw new Error(`${k} must be at least ${min}`)
  if (max !== undefined && n > max) throw new Error(`${k} must be at most ${max}`)
  return n
}

export function bool(a: Args, k: string): boolean | undefined {
  const v = a[k]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  throw new Error(`${k} must be true or false`)
}

export function strArr(a: Args, k: string): string[] {
  const v = a[k]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${k} must be an array of strings`)
  return v as string[]
}

/** Names are user-controlled; keep them on one line inside tool results. */
export function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200)
}

export function reasonOf(a: Args): string {
  const r = str(a, 'reason')
  return `discord-plus${r ? `: ${r}` : ''}`.slice(0, 512)
}

export const SNOWFLAKE = /^\d{17,20}$/

export function idFrom(ref: string, mention: RegExp): string | null {
  const t = ref.trim()
  if (SNOWFLAKE.test(t)) return t
  const m = mention.exec(t)
  return m ? m[1]! : null
}

export const PERM_KEYS = Object.keys(PermissionFlagsBits) as (keyof typeof PermissionFlagsBits)[]

export function permName(raw: string): keyof typeof PermissionFlagsBits {
  const norm = raw.replace(/[_\s-]/g, '').toLowerCase()
  const hit = PERM_KEYS.find(k => k.toLowerCase() === norm)
  if (!hit) throw new Error(`unknown permission "${clean(raw)}" (examples: ViewChannel, SendMessages, ManageMessages)`)
  return hit
}

export function permBits(names: string[]): bigint {
  return names.reduce((acc, n) => acc | PermissionFlagsBits[permName(n)], 0n)
}

export function parseColor(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const m = /^#?([0-9a-f]{6})$/i.exec(v.trim())
    if (m) return parseInt(m[1]!, 16)
  }
  throw new Error('color must be a hex string like #5865F2')
}

export function httpUrl(v: unknown, k: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) throw new Error(`${k} must be an http(s) URL`)
  return v
}

export function buildEmbeds(raw: unknown): APIEmbed[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('embeds must be an array')
  if (raw.length > 10) throw new Error('Discord allows at most 10 embeds per message')
  return raw.map((e, i) => {
    if (typeof e !== 'object' || !e) throw new Error(`embeds[${i}] must be an object`)
    const o = e as Record<string, unknown>
    const embed: APIEmbed = {}
    if (typeof o.title === 'string') embed.title = o.title.slice(0, 256)
    if (typeof o.description === 'string') embed.description = o.description.slice(0, 4096)
    const url = httpUrl(o.url, `embeds[${i}].url`)
    if (url) embed.url = url
    const color = parseColor(o.color)
    if (color !== undefined) embed.color = color
    if (typeof o.footer === 'string') embed.footer = { text: o.footer.slice(0, 2048) }
    if (typeof o.author === 'string') embed.author = { name: o.author.slice(0, 256) }
    const image = httpUrl(o.image, `embeds[${i}].image`)
    if (image) embed.image = { url: image }
    const thumb = httpUrl(o.thumbnail, `embeds[${i}].thumbnail`)
    if (thumb) embed.thumbnail = { url: thumb }
    if (o.timestamp === true) embed.timestamp = new Date().toISOString()
    else if (typeof o.timestamp === 'string') embed.timestamp = new Date(o.timestamp).toISOString()
    if (Array.isArray(o.fields)) {
      if (o.fields.length > 25) throw new Error(`embeds[${i}] has more than 25 fields`)
      embed.fields = o.fields.map((f: any) => ({
        name: String(f?.name ?? '').slice(0, 256) || '​',
        value: String(f?.value ?? '').slice(0, 1024) || '​',
        inline: !!f?.inline,
      }))
    }
    return embed
  })
}

export function buildLinkButtons(raw: unknown): ActionRowBuilder<ButtonBuilder>[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('buttons must be an array')
  if (raw.length > 25) throw new Error('at most 25 buttons')
  const rows: ActionRowBuilder<ButtonBuilder>[] = []
  raw.forEach((b, i) => {
    const label = typeof b?.label === 'string' ? b.label.slice(0, 80) : ''
    const url = httpUrl(b?.url, `buttons[${i}].url`)
    if (!label || !url) throw new Error(`buttons[${i}] needs a label and a url`)
    if (i % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>())
    rows[rows.length - 1]!.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url))
  })
  return rows
}

export function fmtDate(d: Date | null | undefined): string {
  return d ? d.toISOString() : '-'
}
