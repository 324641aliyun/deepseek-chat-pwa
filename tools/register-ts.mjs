import { register } from 'node:module'

// rspack 构建时用 DefinePlugin 注入 __API_ORIGIN__，直接用 node 跑测试时补一个。
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'

register('./ts-resolve.mjs', import.meta.url)
