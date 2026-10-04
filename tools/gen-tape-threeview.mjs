// 磁带三视图（Krea2 turbo 配方，来自本机已验证的 dsh测试用.json）
// 用法: node gen-tape-threeview.mjs [prefix] [W] [H] [seed]
// 关键设计：标签刻意留【空白】并要求 no text —— 站点文字层由代码渲染（清晰、可编辑、
// 不受生成模型拼字乱码影响）。
const BASE = 'http://127.0.0.1:8188'

const PREFIX = process.argv[2] ?? 'tape_threeview'
const W = Number(process.argv[3] ?? 1536)
const H = Number(process.argv[4] ?? 1024)
const SEED = Number(process.argv[5] ?? 20261004)

const POS = [
  'industrial design turnaround reference sheet',
  'three orthographic views of a vintage compact audio cassette tape in a horizontal row',
  'left: front view of the label face with a clear window showing the two tape reels, center: the bottom edge with head openings and screw posts, right: the thin side profile',
  'blank unprinted white paper label, absolutely no text, no lettering, no logos, no writing',
  'matte grey-beige plastic shell, slightly worn edges, clean simple mechanical form',
  'pure white seamless background, flat even studio lighting, no shadows, no reflections',
  'photorealistic product photography, sharp focus, high detail',
].join(', ')

const NEG = [
  'low quality, blurry, cluttered, overlapping objects, distorted, warped',
  'text, lettering, words, numbers, logos, labels with writing, watermark, signature, border, frame',
  'dark background, colored lighting, neon glow, hands, people, extra objects',
].join(', ')

const graph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: 'krea2_turbo_fp8.safetensors', weight_dtype: 'default' } },
  '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_4b_bf16.safetensors', type: 'krea2', device: 'default' } },
  '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
  '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: POS } },
  '5': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: NEG } },
  '6': { class_type: 'EmptyLatentImage', inputs: { width: W, height: H, batch_size: 1 } },
  '7': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: SEED, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: PREFIX } },
}

console.log(`[提交] 磁带三视图 ${W}x${H} seed=${SEED} prefix=${PREFIX} (Krea2 turbo 8步 cfg1)`)
const res = await fetch(`${BASE}/prompt`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: 'dsh-agent' }),
  signal: AbortSignal.timeout(30000),
})
const j = await res.json()
if (!res.ok || j.error) { console.log('[失败] ' + JSON.stringify(j).slice(0, 1500)); process.exit(1) }
const id = j.prompt_id
console.log('[promptId] ' + id)

const t0 = Date.now()
while (Date.now() - t0 < 8 * 60 * 1000) {
  const h = await (await fetch(`${BASE}/history/${id}`, { signal: AbortSignal.timeout(15000) })).json()
  const e = h?.[id]
  if (e) {
    console.log('[状态] ' + e.status?.status_str)
    for (const m of (e.status?.messages ?? [])) {
      const s = JSON.stringify(m)
      if (/error|exception/i.test(s)) console.log('  !! ' + s.slice(0, 600))
    }
    for (const [nid, o] of Object.entries(e.outputs ?? {})) {
      for (const im of (o.images ?? [])) {
        console.log(`[输出] ${im.subfolder ? im.subfolder + '/' : ''}${im.filename}`)
      }
    }
    process.exit(0)
  }
  await new Promise(r => setTimeout(r, 3000))
}
console.log('[超时]')
process.exit(2)
