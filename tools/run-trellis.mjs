// 一次跑完 TRELLIS.2 图生模型：
//   桥接 load_workflow 载入官方模板 -> 桥接 export_api 取 API 图
//   -> 按 class_type 自动定位 LoadImage 与 PrimitiveBoolean（不硬编码节点号）
//   -> 改成我们的输入图 + TRELLIS.2 分支 -> POST /prompt -> 轮询 -> 取 GLB
// 用法: node run-trellis.mjs [imageName] [outPrefix]
const BASE = 'http://127.0.0.1:8188'
const TPL = 'C:/SD-Aki/ComfyUI-aki/ComfyUI-aki-v3.2/python/Lib/site-packages/comfyui_workflow_templates_json/templates/3d_pixal3d_trellis2_image_to_model.json'
const IMAGE = process.argv[2] ?? 'tape_threeview.png'
const PREFIX = process.argv[3] ?? 'series0x2b/tape'

const t0 = Date.now()
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a)

async function bridge(cmd, payload = {}, timeoutMs = 30000) {
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
    await new Promise(x => setTimeout(x, 400))
  }
  throw new Error(`bridge ${cmd} timeout`)
}

// 1) 载入官方模板
const { readFile } = await import('node:fs/promises')
const tpl = JSON.parse(await readFile(TPL, 'utf8'))
log(`模板节点数 ${tpl.nodes?.length ?? 0}，提交 load_workflow …`)
const loadRes = await bridge('load_workflow', { workflow: tpl }, 40000)
log('载入结果: ' + JSON.stringify(loadRes).slice(0, 200))
await new Promise(x => setTimeout(x, 1200))

// 2) 导出 API 图
const api = await bridge('export_api', {}, 40000)
const graph = api?.workflow ?? api?.prompt ?? api
const keys = Object.keys(graph).filter(k => /^\d+$/.test(k))
log(`API 图节点数 ${keys.length}`)
if (keys.length < 5) throw new Error('API 图节点过少，导出可能失败')

// 3) 自动定位并改参
const li = keys.filter(k => /LoadImage/.test(graph[k].class_type || ''))
if (li.length === 0) throw new Error('未找到 LoadImage 节点')
for (const k of li) {
  log(`  LoadImage 节点 ${k}: ${JSON.stringify(graph[k].inputs.image)} -> "${IMAGE}"`)
  graph[k].inputs.image = IMAGE
}
const bools = keys.filter(k => /PrimitiveBoolean/.test(graph[k].class_type || ''))
for (const k of bools) {
  log(`  PrimitiveBoolean 节点 ${k}: ${JSON.stringify(graph[k].inputs.value)} -> true (TRELLIS.2)`)
  graph[k].inputs.value = true
}
// 3b) 输出前缀（SaveGLB / Save3D 类节点）
for (const k of keys) {
  const ct = graph[k].class_type || ''
  if (/SaveGLB|Save3D|SaveMesh|ExportGLB/i.test(ct)) {
    if ('filename_prefix' in (graph[k].inputs || {})) {
      log(`  ${ct} 节点 ${k} prefix: ${JSON.stringify(graph[k].inputs.filename_prefix)} -> "${PREFIX}"`)
      graph[k].inputs.filename_prefix = PREFIX
    }
  }
}

// 4) 提交
const res = await fetch(`${BASE}/prompt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: 'dsh-agent-trellis' }),
  signal: AbortSignal.timeout(30000),
})
const j = await res.json()
if (!res.ok || j.error) { log('[提交失败] ' + JSON.stringify(j).slice(0, 2000)); process.exit(1) }
const pid = j.prompt_id
log('[promptId] ' + pid)

// 5) 轮询
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
      if (o?.text) for (const t of o.text) log(`  [网格统计 节点${nid}] ` + String(t).replace(/\n/g, ' | ').slice(0, 400))
      for (const key of ['3d', 'gltf', 'mesh', 'files']) {
        if (o?.[key]) for (const f of o[key]) log(`  [模型输出 ${key}] ${f.subfolder ? f.subfolder + '/' : ''}${f.filename}`)
      }
      if (o?.images) for (const im of o.images) log(`  [图输出] ${im.subfolder ? im.subfolder + '/' : ''}${im.filename}`)
    }
    process.exit(0)
  }
  await new Promise(x => setTimeout(x, 8000))
}
log('[超时]'); process.exit(2)
