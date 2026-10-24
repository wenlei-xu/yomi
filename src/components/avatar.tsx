import type { CSSProperties } from 'react'
import type { Actor, Conversation } from '../domain/types'

type AvatarTone = {
  background: string
  status: string
}

const tones: AvatarTone[] = [
  { background: 'linear-gradient(135deg, #00A8F0, #006FAE)', status: '#6EC56A' },
  { background: 'linear-gradient(135deg, #FF7A6B, #D95649)', status: '#F4B740' },
  { background: 'linear-gradient(135deg, #8A78C8, #66539D)', status: '#8A78C8' },
  { background: 'linear-gradient(135deg, #F4B740, #C88F1F)', status: '#F4B740' },
  { background: 'linear-gradient(135deg, #52B788, #2D7A59)', status: '#6EC56A' }
]

function toneFor(value: string): AvatarTone {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return tones[hash % tones.length]
}

export function Avatar({
  actor,
  name,
  avatarData,
  size = 48,
  showStatus = true,
  status,
  ringColor = 'var(--paper)',
  className = ''
}: {
  actor?: Actor | null
  name?: string
  avatarData?: string
  size?: number
  showStatus?: boolean
  status?: string
  ringColor?: string
  className?: string
}) {
  const displayName = actor?.name || name || 'Y'
  const imageData = avatarData ?? actor?.avatarData ?? ''
  const tone = toneFor(actor?.id || displayName)
  const dotSize = Math.max(9, Math.round(size * 0.24))
  const style: CSSProperties = {
    width: size,
    height: size,
    background: imageData ? 'transparent' : (actor?.color || tone.background),
    fontSize: Math.round(size * 0.36)
  }
  return (
    <span className={`avatar-round ${className}`} style={style} aria-label={displayName}>
      {imageData
        ? <img src={imageData} alt="" />
        : <span>{displayName.trim().slice(0, 1).toUpperCase()}</span>}
      {showStatus && (
        <i
          className="presence-dot"
          style={{
            width: dotSize,
            height: dotSize,
            background: status || tone.status,
            boxShadow: `0 0 0 ${Math.max(2, Math.round(dotSize / 4))}px ${ringColor}`
          }}
        />
      )}
    </span>
  )
}

export function AvatarStack({
  actors,
  names = [],
  size = 42,
  max = 4
}: {
  actors: Actor[]
  names?: string[]
  size?: number
  max?: number
}) {
  const visible = actors.slice(0, max)
  const overflow = Math.max(0, (actors.length || names.length) - visible.length)
  if (!visible.length && !names.length) {
    return <Avatar name="群" size={size} showStatus={false} />
  }
  const entries: Array<Actor | { id: string; name: string }> = visible.length
    ? visible
    : names.slice(0, max).map((name, index) => ({ id: `name-${index}`, name }))
  return (
    <span className="avatar-stack" aria-label={names.join('、') || '群聊'}>
      {entries.map((entry, index) => (
        <span
          className="avatar-stack-item"
          key={entry.id}
          style={{ marginLeft: index ? -Math.round(size * 0.34) : 0 }}
        >
          <Avatar
            actor={'kind' in entry ? entry : null}
            name={entry.name}
            size={size}
            showStatus={false}
            ringColor="var(--cloud)"
          />
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="avatar-overflow"
          style={{ width: size, height: size, marginLeft: -Math.round(size * 0.34) }}
        >+{overflow}</span>
      )}
    </span>
  )
}

export function conversationAvatar(
  conversation: Conversation,
  actors: Actor[]
): { actor: Actor | null; names: string[] } {
  const agentIds = conversation.members.filter(id => id !== 'local-user')
  const members = agentIds
    .map(id => actors.find(actor => actor.id === id))
    .filter((actor): actor is Actor => Boolean(actor))
  if (conversation.kind === 'direct' && members[0]) {
    return { actor: members[0], names: members.map(item => item.name) }
  }
  return {
    actor: null,
    names: members.length
      ? members.map(item => item.name)
      : conversation.memberNames.filter(name => name !== '我')
  }
}
