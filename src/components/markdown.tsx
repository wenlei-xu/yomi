import React, { Fragment } from 'react'
import { splitEmoticons } from './emoticons'

export function EmoticonText({ text }: { text: string }) {
  return <>{splitEmoticons(text).map((part, index) => typeof part === 'string' ? part
    : <img key={index} className="inline-emoticon" src={part.src} alt={part.code} title={part.name} draggable={false}/>)}</>
}

const safeProtocols = new Set(['http:', 'https:', 'mailto:'])

function safeHref(value: string): string | null {
  try {
    const parsed = new URL(value, 'https://yomi.invalid')
    return safeProtocols.has(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}

function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>]+)/g
  const result: React.ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = tokens.exec(text))) {
    if (match.index > cursor) result.push(<EmoticonText key={`${keyPrefix}-text-${cursor}`} text={text.slice(cursor, match.index)}/>)
    const token = match[0]
    const key = `${keyPrefix}-${match.index}`
    if (token.startsWith('`')) {
      result.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      result.push(<strong key={key}><EmoticonText text={token.slice(2, -2)}/></strong>)
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      const href = link ? safeHref(link[2]) : null
      result.push(href
        ? <a key={key} href={href} onClick={openExternal}><EmoticonText text={link![1]}/></a>
        : token)
    } else {
      const href = safeHref(token)
      result.push(href
        ? <a key={key} href={href} onClick={openExternal}>{token}</a>
        : token)
    }
    cursor = tokens.lastIndex
  }
  if (cursor < text.length) result.push(<EmoticonText key={`${keyPrefix}-tail`} text={text.slice(cursor)}/>)
  return result
}

export function MarkdownText({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const nodes: React.ReactNode[] = []
  let code: string[] | null = null
  let list: string[] = []
  let listKind: 'ul' | 'ol' | null = null

  const flushList = () => {
    if (!list.length || !listKind) return
    const Tag = listKind
    nodes.push(
      <Tag key={`list-${nodes.length}`}>
        {list.map((item, index) => <li key={`${item}-${index}`}>{inline(item, `li-${nodes.length}-${index}`)}</li>)}
      </Tag>
    )
    list = []
    listKind = null
  }

  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      flushList()
      if (code) {
        nodes.push(<pre key={`code-${index}`}><code>{code.join('\n')}</code></pre>)
        code = null
      } else {
        code = []
      }
      return
    }
    if (code) {
      code.push(line)
      return
    }
    const unordered = /^\s*[-*]\s+(.+)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (unordered || ordered) {
      const kind = unordered ? 'ul' : 'ol'
      if (listKind && listKind !== kind) flushList()
      listKind = kind
      list.push((unordered || ordered)![1])
      return
    }
    flushList()
    if (!line.trim()) {
      nodes.push(<br key={`br-${index}`} />)
      return
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const Tag = `h${level}` as keyof JSX.IntrinsicElements
      nodes.push(React.createElement(Tag, { key: `heading-${index}` }, inline(heading[2], `heading-${index}`)))
      return
    }
    if (line.startsWith('> ')) {
      nodes.push(<blockquote key={`quote-${index}`}>{inline(line.slice(2), `quote-${index}`)}</blockquote>)
      return
    }
    nodes.push(<Fragment key={`p-${index}`}>{inline(line, `p-${index}`)}<br /></Fragment>)
  })
  flushList()
  const unfinishedCode = code as string[] | null
  if (unfinishedCode) nodes.push(<pre key="code-tail"><code>{unfinishedCode.join('\n')}</code></pre>)
  return <div className="markdown">{nodes}</div>
}

function openExternal(event: React.MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault()
  const href = event.currentTarget.href
  const parsed = safeHref(href)
  if (!parsed) return
  window.open(parsed, '_blank', 'noopener,noreferrer')
}
