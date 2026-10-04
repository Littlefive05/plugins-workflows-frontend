// 构建时把站点自身的源码内嵌成字符串常量（零运行时请求）
//   → 生成 src/data/source.ts，供第三幕以真实代码行作为"被爬取内容"
// 用法: node tools/embed-sources.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// 站点自身源码（index.html + src 下 6 个文件）
const FILES = [
  'index.html',
  'src/main.ts',
  'src/style.css',
  'src/scene/stage.ts',
  'src/scene/crawler.ts',
  'src/audio/engine.ts',
  'src/data/catalog.ts',
]

const out = []
let totalLines = 0
for (const rel of FILES) {
  const abs = join(ROOT, rel)
  let text = ''
  try {
    text = await readFile(abs, 'utf8')
  } catch (e) {
    console.warn(`  [跳过] ${rel}: ${e.message}`)
    continue
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  // 去掉行尾空白，保留缩进
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''))
  totalLines += trimmed.length
  out.push({ path: rel, lines: trimmed })
  console.log(`  ${rel}  ${trimmed.length} 行`)
}

const ts = `// 本文件由 tools/embed-sources.mjs 自动生成 —— 请勿手改
// 内容 = 站点自身源码，供第三幕以真实代码行作为被爬取内容（构建时内嵌，零运行时请求）
export interface SourceFile { path: string; lines: string[] }
export const SOURCES: SourceFile[] = ${JSON.stringify(out, null, 0)}
`
await writeFile(join(ROOT, 'src/data/source.ts'), ts, 'utf8')
console.log(`\n已写入 src/data/source.ts —— ${out.length} 个文件 / ${totalLines} 行 / ${(ts.length / 1024).toFixed(1)} KB`)
void relative
