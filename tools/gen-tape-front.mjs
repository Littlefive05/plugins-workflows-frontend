// 磁带【单张正视图】——TRELLIS 图生模型必须喂单视图，喂三视图会把三视图也造成三块板
// 用法: node gen-tape-front.mjs [prefix] [seed]
const BASE = 'http://127.0.0.1:8188'
const PREFIX = process.argv[2] ?? 'series0x2b/tape_front'
const SEED = Number(process.argv[3] ?? 20261004)
const W = 1024, H = 1024

const POS = [
  'single object product photograph, dead-on front view, centered, filling the frame',
  'one vintage compact audio cassette tape, label face toward camera',
  'large clear window in the middle showing both tape reels wound with dark brown magnetic tape, white plastic toothed hubs',
  'blank unprinted white paper label, absolutely no text, no lettering, no numbers, no logos',
  'matte light grey-beige plastic shell, four small flush screws, slightly worn edges',
  'pure white seamless background, flat even studio lighting, soft contact shadow, no reflections',
  'photorealistic, sharp focus, high detail, symmetrical',
].join(', ')

const NEG = [
  'multiple objects, three views, collage, side view, top view, duplicate, repeated',
  'text, lettering, words, numbers, logos, watermark, signature, border, frame',
  'hands, people, dark background, colored lighting, neon, blurred, low quality, distorted',
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

console.log(`[提交] 磁带单张正视图 ${W}x${H} seed=${SEED}`)
const res = await fetch(`${BASE}/prompt`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: 'dsh-agent' }), signal: AbortSignal.timeout(30000),
})
const j = await res.json()
if (!res.ok || j.error) { console.log('[失败] ' + JSON.stringify(j).slice(0, 1200)); process.exit(1) }
const id = j.prompt_id
const t0 = Date.now()
while (Date.now() - t0 < 6 * 60 * 1000) {
  const h = await (await fetch(`${BASE}/history/${id}`, { signal: AbortSignal.timeout(15000) })).json()
  const e = h?.[id]
  if (e) {
    console.log('[状态] ' + e.status?.status_str)
    for (const [, o] of Object.entries(e.outputs ?? {})) for (const im of (o.images ?? [])) console.log(`[输出] ${im.subfolder ? im.subfolder + '/' : ''}${im.filename}`)
    process.exit(0)
  }
  await new Promise(r => setTimeout(r, 2500))
}
console.log('[超时]'); process.exit(2)
