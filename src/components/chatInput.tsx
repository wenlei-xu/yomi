import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { deleteBefore, splitEmoticons } from './emoticons'

export interface ChatInputHandle {
  focus: () => void
  blur: () => void
  insert: (text: string) => void
  backspace: () => void
}

// Persist plain text / [emoticon] codes, never editable HTML.
export function readChatInput(root: Node): string {
  if (root.childNodes.length === 1 && root.firstChild?.nodeName === 'BR') return ''
  let text = ''
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? ''
    else if (child instanceof HTMLImageElement) text += child.dataset.emoticon ?? child.alt
    else if (child.nodeName === 'BR') {
      if (!(child instanceof HTMLElement && child.dataset.tail)) text += '\n'
    } else {
      if (/^(DIV|P)$/.test(child.nodeName) && child.previousSibling) text += '\n'
      text += readChatInput(child)
    }
  }
  return text
}

function writeChatInput(root: HTMLElement, text: string): void {
  const fragment = document.createDocumentFragment()
  for (const part of splitEmoticons(text)) {
    if (typeof part === 'string') fragment.append(document.createTextNode(part))
    else {
      const image = document.createElement('img')
      image.src = part.src
      image.alt = part.code
      image.dataset.emoticon = part.code
      image.className = 'inline-emoticon'
      image.draggable = false
      image.contentEditable = 'false'
      fragment.append(image)
    }
  }
  if (text.endsWith('\n')) {
    const tail = document.createElement('br')
    tail.dataset.tail = 'true'
    fragment.append(tail)
  }
  root.replaceChildren(fragment)
}

function selectionOffsets(root: HTMLElement): [number, number] | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const prefix = document.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = readChatInput(prefix.cloneContents()).length
  prefix.setEnd(range.endContainer, range.endOffset)
  return [start, readChatInput(prefix.cloneContents()).length]
}

function restoreSelection(root: HTMLElement, start: number, end: number): void {
  const point = (offset: number): [Node, number] => {
    for (let i = 0; i < root.childNodes.length; i++) {
      const child = root.childNodes[i]
      const length = child.nodeType === Node.TEXT_NODE ? child.textContent?.length ?? 0
        : child instanceof HTMLImageElement ? child.dataset.emoticon?.length ?? 0 : 0
      if (offset <= length) return child.nodeType === Node.TEXT_NODE
        ? [child, offset] : [root, i + (offset > 0 ? 1 : 0)]
      offset -= length
    }
    return [root, root.childNodes.length]
  }
  const range = document.createRange()
  range.setStart(...point(start))
  range.setEnd(...point(end))
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export const ChatInput = forwardRef<ChatInputHandle, {
  value: string
  disabled: boolean
  placeholder: string
  onChange: (value: string) => void
  onFocus: () => void
  onSend: () => void
}>(function ChatInput({ value, disabled, placeholder, onChange, onFocus, onSend }, ref) {
  const root = useRef<HTMLDivElement>(null)
  const cursor = useRef<[number, number]>([value.length, value.length])
  const composing = useRef(false)
  const remember = () => {
    if (root.current) cursor.current = selectionOffsets(root.current) ?? cursor.current
  }
  const apply = (text: string, start: number, end = start) => {
    if (!root.current || disabled) return
    writeChatInput(root.current, text)
    cursor.current = [start, end]
    if (document.activeElement === root.current) restoreSelection(root.current, start, end)
    onChange(text)
  }
  const insert = (text: string) => {
    if (!root.current) return
    const current = readChatInput(root.current)
    const [start, end] = cursor.current.map(offset => Math.min(offset, current.length))
    apply(current.slice(0, start) + text + current.slice(end), start + text.length)
  }
  const backspace = () => {
    if (!root.current) return
    const current = readChatInput(root.current)
    const [start, end] = cursor.current.map(offset => Math.min(offset, current.length))
    const result = deleteBefore(current, start, end)
    apply(result.text, result.cursor)
  }
  const sync = () => {
    const element = root.current
    if (!element || composing.current) return
    remember()
    const text = readChatInput(element)
    // Leave ordinary typing to the browser; normalize only rich nodes / shortcodes.
    if ([...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && splitEmoticons(node.textContent ?? '').some(part => typeof part !== 'string'))
      || element.querySelector('div,p')) {
      writeChatInput(element, text)
      restoreSelection(element, ...cursor.current)
    }
    onChange(text)
  }

  useLayoutEffect(() => {
    const element = root.current
    if (!element || composing.current || readChatInput(element) === value) return
    writeChatInput(element, value)
    cursor.current = [value.length, value.length]
    if (document.activeElement === element) restoreSelection(element, ...cursor.current)
  }, [value])
  useEffect(() => {
    document.addEventListener('selectionchange', remember)
    return () => document.removeEventListener('selectionchange', remember)
  }, [])
  useImperativeHandle(ref, () => ({
    focus: () => {
      if (disabled || !root.current) return
      root.current.focus()
      restoreSelection(root.current, ...cursor.current)
    },
    blur: () => { remember(); root.current?.blur() }, insert, backspace
  }))

  return <div ref={root} className="chat-text-input" role="textbox" aria-label="消息内容" aria-multiline="true"
    aria-disabled={disabled} contentEditable={!disabled} suppressContentEditableWarning data-placeholder={placeholder}
    data-empty={!value} onInput={sync} onFocus={onFocus} onBlur={remember}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; sync() }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing) return
      if (event.key === 'Enter') {
        event.preventDefault()
        if (event.ctrlKey || event.metaKey) onSend()
        else if (!document.execCommand('insertText', false, '\n')) insert('\n')
      }
      if (event.key === 'Backspace') {
        remember()
        const before = value.slice(0, cursor.current[0])
        if (cursor.current[0] === cursor.current[1] && typeof splitEmoticons(before).at(-1) === 'object') {
          event.preventDefault(); backspace()
        }
      }
    }}
    onPaste={event => {
      event.preventDefault()
      const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
      if (!document.execCommand('insertText', false, text)) insert(text)
    }}
    onCopy={event => {
      const selection = root.current && selectionOffsets(root.current)
      if (!selection || selection[0] === selection[1]) return
      event.preventDefault()
      event.clipboardData.setData('text/plain', value.slice(...selection))
    }}
    onCut={event => {
      const selection = root.current && selectionOffsets(root.current)
      if (!selection || selection[0] === selection[1]) return
      event.preventDefault()
      event.clipboardData.setData('text/plain', value.slice(...selection))
      apply(value.slice(0, selection[0]) + value.slice(selection[1]), selection[0])
    }} onDrop={event => event.preventDefault()} />
})
