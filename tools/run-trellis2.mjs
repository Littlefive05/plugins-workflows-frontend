// TRELLIS.2 提交器 v2 —— 不再依赖 ComfyUI 前端标签页
//   首次：桥接导出 API 图并存盘 tools/trellis-api.json（长超时，容忍后台标签节流）
//   之后：直接读存好的 API 图 → 打补丁 → POST /prompt（前端关掉也能跑）
// 用法: node run-trellis2.mjs [imageName] [outPrefix]
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const BASE = 'http://127.0.0.1:8188'
const TPL = 'C:/SD-Aki/ComfyUI-aki/ComfyUI-aki-v3.2/python/Lib/site-packages/comfyui_workflow_templates_json/templates/3d_pixal3d_trellis2_image_to_model.json'
const CACHE = 'C:/LFModels/workspaces/series-0x2b/tools/trellis-api.json'
const IMAGE = process.argv[2] ?? 'tape_front.png'
const PREFIX = process.argv[3] ?? 'series0x2b/tape'
const t0 = Date.now()
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a)

async function bridgeWait(cmd, payload = {}, timeoutMs = 180000) {
  const r = await fetch(`${BASE}/dsh-bridge/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cmd, payload }), signal: AbortSignal.timeout(20000),
  })
  const { accepted, id, error } = await r.json()
  if (!accepted) throw new Error(`bridge ${cmd} rejected: ${error || ''}`)
  const s = Date.now()
  while (Date.now() - s < timeoutMs) {
    const rr = await fetch(`${BASE}/dsh-bridge/result/${id}`, { signal: AbortSignal.timeout(10000) })
    const item = await rr.json().catch(() => null)
    if (item && item.error !== 'not_found') {
      if (item.ok === false) throw new Error(item.error || `bridge ${cmd} failed`)
      return item.result
    }
    await new Promise(x => setTimeout(x, 600))
  }
  throw new Error(`bridge ${cmd} timeout after ${timeoutMs}ms`)
}

let graph = null
if (existsSync(CACHE)) {
  graph = JSON.parse(await readFile(CACHE, 'utf8'))
  log(`使用存盘的 API 图（${Object.keys(graph).filter(k => /^\d+$/.test(k)).length} 节点），无需前端`)
} else {
  const tpl = JSON.parse(await readFile(TPL, 'utf8'))
  log(`模板 ${tpl.nodes?.length ?? 0} 节点，桥接载入（长超时）…`)
  await bridgeWait('load_workflow', { workflow: tpl }, 180000)
  await new Promise(x => setTimeout(x, 1500))
  const api = await bridgeWait('export_api', {}, 180000)
  graph = api?.workflow ?? api?.prompt ?? api
  const n = Object.keys(graph).filter(k => /^\d+$/.test(k)).length
  if (n < 5) throw new Error('API 图节点过少')
  await writeFile(CACHE, JSON.stringify(graph, null, 2), 'utf8')
  log(`API 图已存盘（${n} 节点）→ ${CACHE}`)
}

const keys = Object.keys(graph).filter(k => /^\d+$/.test(k))
for (const k of keys) if (/LoadImage/.test(graph[k].class_type || '')) {
  log(`  LoadImage ${k}: -> ${IMAGE}`)
  graph[k].inputs.image = IMAGE
}
for (const k of keys) if (/PrimitiveBoolean/.test(graph[k].class_type || '')) {
  log(`  PrimitiveBoolean ${k}: -> true (TRELLIS.2)`)
  graph[k].inputs.value = true
}
for (const k of keys) {
  const ct = graph[k].class_type || ''
  if (/SaveGLB|Save3D|SaveMesh|ExportGLB/i.test(ct) && 'filename_prefix' in (graph[k].inputs || {})) {
    log(`  ${ct} ${k}: prefix -> ${PREFIX}`)
    graph[k].inputs.filename_prefix = PREFIX
  }
}

const res = await fetch(`${BASE}/prompt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: 'dsh-agent-trellis2' }), signal: AbortSignal.timeout(30000),
})
const j = await res.json()
if (!res.ok || j.error) { log('[提交失败] ' + JSON.stringify(j).slice(0, 2000)); process.exit(1) }
const pid = j.prompt_id
log('[promptId] ' + pid)

const t1 = Date.now()
while (Date.now() - t1 < 30 * 60 * 1000) {
  const h = await (await fetch(`${BASE}/history/${pid}`, { signal: AbortSignal.timeout(15000) })).json()
  const e = h?.[pid]
  if (e) {
    log('[状态] ' + e.status?.status_str)
    for (const m of (e.status?.messages ?? [])) {
      const s = JSON.stringify(m)
      if (/error|exception|oom/i.test(s)) log('  !! ' + s.slice(0, 500))
    }
    for (const [nid, o] of Object.entries(e.outputs ?? {})) {
      if (o?.text) for (const t of o.text) log(`  [网格统计 ${nid}] ` + String(t).replace(/\n/g, ' | ').slice(0, 300))
      for (const key of ['3d', 'gltf', 'mesh']) if (o?.[key]) for (const f of o[key]) log(`  [模型输出] ${f.subfolder ? f.subfolder + '/' : ''}${f.filename}`)
    }
    process.exit(0)
  }
  await new Promise(x => setTimeout(x, 8000))
}
log('[超时]'); process.exit(2)
