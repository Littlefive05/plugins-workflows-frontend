// 两轨音乐（MiniMax Music 3，复用 dsh_music 已验证的 API 图结构）
//   主轨 MAIN : Lo-Fi 纯音乐，≥2 分钟，仅磁带触发时播放，有头有尾
//   次轨 BED  : 冷清轻音乐纯音乐（非 dreamcore），≥2 分钟，全站背景，结尾衔接开头成循环
// 用法: node run-music.mjs [main|bed|both]
const BASE = 'http://127.0.0.1:8188'

const TRACKS = {
  main: {
    prefix: 'series0x2b/main_lofi',
    seed: 0x2b01,
    seconds: 132.0,
    caption: [
      'lo-fi instrumental, warm mellow and intimate',
      'soft muffled boom bap drums, dusty vinyl crackle, gentle tape wow and flutter',
      'mellow Rhodes electric piano, warm upright bass, brushed hats',
      'hazy nostalgic late night mood, restrained and clean',
      'warm saturated analog low end, rolled-off gentle treble',
      'no hiss, no noise, no vocals, no speech',
    ].join(', '),
  },
  bed: {
    prefix: 'series0x2b/bed_cold',
    seed: 0x2b02,
    seconds: 156.0,
    caption: [
      'cold minimal ambient instrumental, quiet and calm',
      'sparse distant piano notes, soft low drone, airy restrained pad',
      'slow spacious and cold, clinical calm, very sparse',
      'subtle tape hiss and room tone, gentle analog warmth under a cold surface',
      'no drums, no beat, no percussion, no vocals, no speech, no melody hooks',
    ].join(', '),
  },
}

const LYR = '[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n'

function graphFor(t) {
  return {
    '6': { class_type: 'UNETLoader', inputs: { unet_name: 'minimax_music3_dit_fp16.safetensors', weight_dtype: 'default' } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: 'minimax_music3_text_encoder_pruned_int8_convrot.safetensors', type: 'minimax', device: 'default' } },
    '7': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_music3_dav.safetensors' } },
    '13': { class_type: 'MiniMaxMusic3TextEncode', inputs: { clip: ['3', 0], caption: t.caption, lyrics: LYR, seed: t.seed, max_duration: t.seconds, cfg_scale: 1.7, top_k: 50 } },
    '10': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['13', 0] } },
    '15': { class_type: 'EmptyMiniMaxMusic3LatentAudio', inputs: { seconds: ['13', 1], batch_size: 1 } },
    '9': { class_type: 'KSampler', inputs: { model: ['6', 0], seed: t.seed, steps: 30, cfg: 1.7, sampler_name: 'euler', scheduler: 'simple', positive: ['13', 0], negative: ['10', 0], latent_image: ['15', 0], denoise: 1.0 } },
    '12': { class_type: 'VAEDecodeAudio', inputs: { samples: ['9', 0], vae: ['7', 0] } },
    '60': { class_type: 'AudioAdjustVolume', inputs: { audio: ['12', 0], volume: -3 } },
    '50': { class_type: 'SaveAudio', inputs: { audio: ['60', 0], filename_prefix: t.prefix } },
  }
}

async function run(key) {
  const t = TRACKS[key]
  console.log(`\n===== ${key.toUpperCase()}  ${t.seconds}s  seed=${t.seed} =====`)
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graphFor(t), client_id: 'dsh-agent-music' }),
    signal: AbortSignal.timeout(30000),
  })
  const j = await res.json()
  if (!res.ok || j.error) { console.log('[提交失败] ' + JSON.stringify(j).slice(0, 1500)); return null }
  const id = j.prompt_id
  console.log('[promptId] ' + id)

  const t0 = Date.now()
  while (Date.now() - t0 < 25 * 60 * 1000) {
    const h = await (await fetch(`${BASE}/history/${id}`, { signal: AbortSignal.timeout(15000) })).json()
    const e = h?.[id]
    if (e) {
      console.log('[状态] ' + e.status?.status_str)
      for (const m of (e.status?.messages ?? [])) {
        const s = JSON.stringify(m)
        if (/error|exception/i.test(s)) console.log('  !! ' + s.slice(0, 600))
      }
      const outs = []
      for (const [nid, o] of Object.entries(e.outputs ?? {})) {
        for (const a of (o.audio ?? [])) outs.push(`${a.subfolder ? a.subfolder + '/' : ''}${a.filename}`)
        for (const im of (o.images ?? [])) outs.push(`${im.subfolder ? im.subfolder + '/' : ''}${im.filename}`)
      }
      console.log('[输出] ' + (outs.join(', ') || '(无)'))
      return outs
    }
    await new Promise(r => setTimeout(r, 5000))
  }
  console.log('[超时]')
  return null
}

const which = process.argv[2] ?? 'both'
const keys = which === 'both' ? ['bed', 'main'] : [which]
for (const k of keys) await run(k)
console.log('\n[完成]')
