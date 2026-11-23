/**
 * 把网页 HTML 变成可读文本。够模型读懂正文即可，不做完整 DOM 解析：
 * 去掉脚本、样式、注释和标签，块级元素换行，压缩空白。
 */
export const htmlToText = (html: string): string => {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, lines) => line || lines[index - 1] !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 从 HTML 里取标题；取不到返回空串 */
export const htmlTitle = (html: string): string => {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]).replace(/\s+/g, ' ').trim() : ''
}
