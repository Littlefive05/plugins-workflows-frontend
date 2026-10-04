// 从 ComfyUI /history 里捞出"音乐那条" API 图 → tools/music-api.json
// 目标：找到输出含 series0x2b/main_lofi 或 dsh_music/lofi 的那次运行。
// 用法：node tools/harvest-music-api.mjs [关键词...]
import fs from 'node:fs'

const B = 'http://127.0.0.1:8188'
const OUT = 'C:/LFModels/workspaces/series-0x2b/tools/music-api.json'
const keys = process.argv.slice(2)
const want = keys.length ? keys : ['series0x2b/main_lofi', 'dsh_music/lofi', 'main_lofi', 'lofi_long', 'lofi_full']

console.log('拉取 /history …')
const h = await (await fetch(`${B}/history`, { signal: AbortSignal.timeout(180000) })).json()
const ids = Object.keys(h)
console.log(`history 条目数: ${ids.length}`)

/** 从一个 history entry 里抽出所有输出文件名 */
function outputFiles(e) {
  const names = []
  const outs = e?.outputs ?? {}
  for (const nodeId of Object.keys(outs)) {
    const o = outs[nodeId]
    for (const k of ['audio', 'images', 'gifs', 'video', 'files', 'text']) {
      const arr = o?.[k]
      if (Array.isArray(arr)) for (const it of arr) {
        if (typeof it === 'string') names.push(it)
        else if (it && typeof it === 'object') names.push(it.filename ?? it.subfolder ?? JSON.stringify(it).slice(0, 80))
      }
    }
  }
  return names
}

const hits = []
for (const id of ids) {
  const e = h[id]
  const files = outputFiles(e)
  const blob = JSON.stringify(files)
  if (want.some((w) => blob.includes(w))) hits.push({ id, files, e })
}

console.log(`命中条目: ${hits.length}`)
for (const x of hits) console.log(`  ${x.id}  →  ${JSON.stringify(x.files)}`)

if (!hits.length) {
  // 没命中就列出所有带 audio 输出的条目，便于人工判断
  console.log('\n未命中关键词。以下是所有含 audio 输出的条目：')
  let n = 0
  for (const id of ids) {
    const files = outputFiles(h[id])
    const audio = files.filter((f) => /\.(flac|wav|mp3|ogg|m4a)$/i.test(f))
    if (audio.length) { console.log(`  ${id}  →  ${JSON.stringify(audio)}`); n++ }
  }
  if (!n) console.log('  （没有任何 audio 输出条目）')
  process.exit(2)
}

// 取最新一条命中
hits.sort((a, b) => (b.e?.prompt?.[0] ?? 0) - (a.e?.prompt?.[0] ?? 0))
const best = hits[hits.length - 1]
const p = best.e.prompt
const g = Array.isArray(p) ? p[2] : (p && p.graph) ? p.graph : p
if (!g || typeof g !== 'object') { console.log('❌ 取不到 API 图'); process.exit(1) }
const nodeKeys = Object.keys(g).filter((k) => /^\d+$/.test(k))
console.log(`\n✅ 取回 API 图: ${nodeKeys.length} 节点（来自 ${best.id}）`)
fs.writeFileSync(OUT, JSON.stringify(g, null, 2))
console.log(`已写入 ${OUT}`)
for (const k of nodeKeys) {
  const ct = g[k].class_type || ''
  const ins = JSON.stringify(g[k].inputs ?? {})
  console.log(`  ${k.padStart(4)} ${ct.padEnd(34)} ${ins.length > 160 ? ins.slice(0, 160) + '…' : ins}`)
}
