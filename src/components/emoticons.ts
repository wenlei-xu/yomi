import catalog from '../../public/assets/emoticons/catalog.json'

export interface Emoticon { name: string; code: string; src: string }

const order = `微笑 撇嘴 色 发呆 得意 流泪 害羞 闭嘴 睡 大哭 尴尬 发怒 调皮 呲牙 惊讶 难过 囧 抓狂 吐 偷笑 愉快 白眼 傲慢 困 惊恐 憨笑 悠闲 咒骂 疑问 嘘 晕 衰 骷髅 敲打 再见 擦汗 抠鼻 鼓掌 坏笑 右哼哼 鄙视 委屈 快哭了 阴险 亲亲 可怜 笑脸 生病 脸红 破涕为笑 恐惧 失望 无语 嘿哈 捂脸 奸笑 机智 皱眉 耶 吃瓜 加油 汗 天啊 Emm 社会社会 旺柴 好的 打脸 哇 翻白眼 666 让我看看 叹气 苦涩 裂开 嘴唇 爱心 心碎 拥抱 强 弱 握手 胜利 抱拳 勾引 拳头 OK 合十 啤酒 咖啡 蛋糕 玫瑰 凋谢 菜刀 炸弹 便便 月亮 太阳 庆祝 礼物 红包 發 福 烟花 爆竹 猪头 跳跳 发抖 转圈`.split(' ')
export const emoticons: Emoticon[] = order.map(name => {
  const entry = catalog.find(item => item.name === name)
  if (!entry) throw new Error(`Missing emoticon: ${name}`)
  return { name, code: `[${name}]`, src: `/assets/emoticons/${entry.file}` }
})

const byCode = new Map(emoticons.map(item => [item.code, item]))
for (const [alias, name] of Object.entries({ 可爱: '笑脸', 笑哭: '破涕为笑', doge: '旺柴', Doge: '旺柴', 赞: '强' })) {
  byCode.set(`[${alias}]`, byCode.get(`[${name}]`)!)
}

export function splitEmoticons(text: string): (string | Emoticon)[] {
  const result: (string | Emoticon)[] = []
  const pattern = /\[[^\[\]\n]{1,12}\]/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const item = byCode.get(match[0])
    if (!item) continue
    if (match.index! > cursor) result.push(text.slice(cursor, match.index))
    result.push({ ...item, code: match[0] })
    cursor = match.index! + match[0].length
  }
  if (cursor < text.length) result.push(text.slice(cursor))
  return result
}

export function deleteBefore(text: string, start: number, end = start): { text: string; cursor: number } {
  if (start !== end) return { text: text.slice(0, start) + text.slice(end), cursor: start }
  const before = text.slice(0, start)
  const last = splitEmoticons(before).at(-1)
  const length = typeof last === 'object' ? last.code.length
    : typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(before)].at(-1)?.segment.length ?? 0
      : Array.from(before).at(-1)?.length ?? 0
  return { text: text.slice(0, start - length) + text.slice(end), cursor: start - length }
}
