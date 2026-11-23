// Node ESM 解析钩子：仓库源码用 `.js` 后缀导入 `.ts` 文件（rspack 的 extensionAlias 规则），
// 直接用 node 跑测试时需要把不存在的 `.js` 换成同名 `.ts`。
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && context.parentURL) {
    try {
      const url = new URL(specifier, context.parentURL)
      if (!existsSync(fileURLToPath(url))) {
        const candidate = url.href.slice(0, -3) + '.ts'
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(candidate, context)
        }
      }
    } catch {
      // 非文件说明符交给默认解析
    }
  }
  return nextResolve(specifier, context)
}
