// SERIES 0x2B — 用本机 ComfyUI（MiniMax Music 3 / minimax_music3）生成 4 条真实主轨
//
// 模板来自 tools/music-api.json —— 从 ComfyUI /history 里捞出的一条真实跑通的音乐图
// （那次产出 output/series0x2b/main_lofi_00001.flac）。本脚本只改 3 个地方：
//   · node 13 MiniMaxMusic3TextEncode : caption（风格/配器）+ seed + max_duration
//   · node 9  KSampler                : seed（必须与 13 的 seed 一致）
//   · node 50 SaveAudio               : filename_prefix（每条一个，便于回收产物）
//   · node 60 AudioAdjustVolume       : volume（peak 归一化的粗调）
// 其余节点（模型/CLIP/VAE 加载、解码链）原样不动，保证与已验证跑通的那次一致。
//
// 产物：flac（ComfyUI 侧）→ ffmpeg 转 128kbps mp3 → public/assets/audio/main-0N.mp3
//
// 用法：
//   node tools/gen-mains.mjs                 # 生成 4 条（已存在且非空的会跳过）
//   node tools/gen-mains.mjs --force         # 忽略已有文件，重新生成
//   node tools/gen-mains.mjs --only=2        # 只生成第 2 条
//   node tools/gen-mains.mjs --no-convert    # 只生成 flac，不转 mp3
//   node tools/gen-mains.mjs --report        # 不生成，只按 ffprobe/volumedetect 实测产物
//
// 硬约束：任一条捞不到 / 生成失败，都如实报错并退出非 0，绝不静音占位。

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const AUDIO_DIR = join(ROOT, 'public', 'assets', 'audio')
const TEMPLATE = join(HERE, 'music-api.json')

const BASE = 'http://127.0.0.1:8188'
const FFMPEG_FALLBACK =
  'C:\\Users\\28011\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe'
const FFPROBE_FALLBACK = FFMPEG_FALLBACK.replace(/ffmpeg\.exe$/, 'ffprobe.exe')

const ARGS = process.argv.slice(2)
const has = (f) => ARGS.includes(f)
const val = (name) => {
  const a = ARGS.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : undefined
}

function which(exe, fallback) {
  const r = spawnSync(exe, ['-version'], { encoding: 'utf8' })
  if (r.status === 0) return exe
  if (existsSync(fallback)) return fallback
  throw new Error(`找不到 ${exe}`)
}
const FFMPEG = which('ffmpeg', FFMPEG_FALLBACK)
const FFPROBE = which('ffprobe', FFPROBE_FALLBACK)

// ---------------------------------------------------------------------------
// 4 条主轨的定义：同一 lo-fi 家族（与站点冷清气质一致），
// 但在【情绪 + 配器 + 律动】三个维度上刻意拉开，让"选曲"真的有区别。
// 每条都明确要求"有头有尾 / 完整收尾"，避免被模型裁掉尾巴。
// lyrics 保持与已验证那次一致的无实义结构标记（纯器乐，无唱词）。
// ---------------------------------------------------------------------------
const COMMON_TAIL =
  'instrumental only, no vocals, no speech, no lyrics, no singing, no choir, no hiss, no noise, no clipping'
const STRUCTURE =
  'complete finished track with a clear intro and a definite ending, the piece resolves and stops cleanly rather than being cut off mid-phrase'

const TRACKS = [
  {
    n: 1,
    name: 'warm-dusty',
    caption: [
      'lo-fi instrumental, warm mellow and intimate',
      'soft muffled boom bap drums, dusty vinyl crackle, gentle tape wow and flutter',
      'mellow Rhodes electric piano, warm upright bass, brushed hats',
      'hazy nostalgic late night mood, restrained and clean',
      'warm saturated analog low end, rolled-off gentle treble',
      'slow relaxed head-nod groove around 72 BPM',
    ].join(', '),
  },
  {
    n: 2,
    name: 'cold-detached',
    caption: [
      'lo-fi instrumental, cold detached and spacious',
      'sparse hollow drum machine hits, cold room reverb, faint tape hiss',
      'distant detuned electric piano, dry sub bass, cold glassy pads',
      'clinical melancholy, minimal and empty, late night isolation',
      'narrow muted frequency range, no brightness, no warmth',
      'slow dragging half-time pulse around 64 BPM',
    ].join(', '),
  },
  {
    n: 3,
    name: 'wistful-melodic',
    caption: [
      'lo-fi instrumental, wistful and melodic, gently melancholic',
      'soft dusty breakbeat, vinyl surface noise, warm tape saturation',
      'expressive muted trumpet-like lead, warm double bass, mellow vibraphone',
      'bittersweet nostalgic mood, melodic and expressive, tender and calm',
      'soft rounded transients, gentle analog compression',
      'medium laid-back groove around 80 BPM',
    ].join(', '),
  },
  {
    n: 4,
    name: 'dub-heavy',
    caption: [
      'lo-fi instrumental, deep heavy and hypnotic, dub influenced',
      'slow heavy dusty drums, deep sub bass, tape delay echoes, vinyl crackle',
      'sparse muted guitar skank, low wobbling bass, warm analog organ swells',
      'nocturnal hypnotic mood, spacious and meditative, dark and calm',
      'deep saturated low end, heavily filtered highs',
      'very slow meditative groove around 68 BPM',
    ].join(', '),
  },
].map((t, i) => ({
  ...t,
  // seed 沿用已验证那次的 11009 作为基底，4 条各不相同
  seed: 11009 + i * 7919,
  seconds: 132,          // ≥ 2 分钟（132s = 2:12），与已验证那次的 max_duration 一致
}))

const LYRICS = '[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n'

// 时长下限（秒）。素材要求"每条 ≥ 2 分钟"，低于它一律判失败、不冒充交付。
// 可用 --min-duration=N 放宽，仅用于"实测提示词对时长的影响"这类实验。
const MINDUR = val('min-duration') ? Number(val('min-duration')) : 120

/** 允许用 --tracks=<file.json> 覆盖上面的曲目表（用于实测不同提示词对时长的影响，
 *  不必改脚本本身）。文件格式：[{n, name, caption, seed, seconds, volume?}, ...] */
function loadTracks() {
  const f = val('tracks')
  if (!f) return TRACKS
  const raw = JSON.parse(readFileSync(resolve(f), 'utf8'))
  if (!Array.isArray(raw) || !raw.length) throw new Error('--tracks 文件必须是曲目数组')
  return raw
}

// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function buildGraph(tpl, t) {
  const g = JSON.parse(JSON.stringify(tpl))
  const enc = g['13'], ks = g['9'], save = g['50']
  if (!enc || enc.class_type !== 'MiniMaxMusic3TextEncode') throw new Error('模板 node 13 不是 MiniMaxMusic3TextEncode')
  if (!ks || ks.class_type !== 'KSampler') throw new Error('模板 node 9 不是 KSampler')
  if (!save || save.class_type !== 'SaveAudio') throw new Error('模板 node 50 不是 SaveAudio')

  enc.inputs.caption = `${t.caption}, ${STRUCTURE}, ${COMMON_TAIL}`
  enc.inputs.lyrics = LYRICS
  enc.inputs.seed = t.seed
  enc.inputs.max_duration = t.seconds
  // KSampler 的 seed 必须与文本编码器一致（两处都喂种子，模板里原来就是同一个值）
  ks.inputs.seed = t.seed
  save.inputs.filename_prefix = `series0x2b/main-${String(t.n).padStart(2, '0')}_${t.name}`

  // AudioAdjustVolume 的 volume 保持模板值（-3dB），逐条可覆盖
  if (t.volume !== undefined && g['60']) g['60'].inputs.volume = t.volume
  return g
}

async function queue(graph) {
  const body = { prompt: graph, client_id: 'series0x2b-gen-mains' }
  const r = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`POST /prompt HTTP ${r.status}\n原始响应: ${text.slice(0, 1200)}`)
  let j
  try { j = JSON.parse(text) } catch { throw new Error(`POST /prompt 返回非 JSON: ${text.slice(0, 400)}`) }
  if (j.error) throw new Error(`ComfyUI 拒绝该图: ${JSON.stringify(j).slice(0, 1200)}`)
  if (!j.prompt_id) throw new Error(`没有 prompt_id: ${text.slice(0, 400)}`)
  return j.prompt_id
}

/** 轮询 /history/<id>，直到出现该 prompt_id 的条目并带 outputs。 */
async function waitDone(promptId, { timeoutMs = 40 * 60 * 1000, everyMs = 5000, label = '' } = {}) {
  const t0 = Date.now()
  let lastMsg = 0
  while (Date.now() - t0 < timeoutMs) {
    await sleep(everyMs)
    const r = await fetch(`${BASE}/history/${promptId}`, { signal: AbortSignal.timeout(60000) })
    if (!r.ok) continue
    const h = await r.json()
    const e = h[promptId]
    if (e) {
      // status.completed / status_str; 也可能有 execution error
      const st = e.status ?? {}
      const outs = e.outputs ?? {}
      const hasAudio = Object.values(outs).some((o) => Array.isArray(o?.audio) && o.audio.length)
      if (st.status_str === 'error' || st.completed === false && st.status_str === 'error') {
        throw new Error(`[${label}] ComfyUI 执行报错: ${JSON.stringify(st).slice(0, 1500)}`)
      }
      if (hasAudio) return e
    }
    const el = Math.round((Date.now() - t0) / 1000)
    if (el - lastMsg >= 30) { lastMsg = el; console.log(`    …${label} 已等待 ${el}s`) }
  }
  throw new Error(`[${label}] 等待超时（${timeoutMs / 1000}s）`)
}

function findAudio(e) {
  for (const nodeId of Object.keys(e.outputs ?? {})) {
    const a = e.outputs[nodeId]?.audio
    if (Array.isArray(a) && a.length) return a[0]
  }
  return null
}

/** 该 prefix 是否已经有生成好的产物？有就复用，不重复烧一次生成。
 *  先看本地已下载的 flac，再回查 ComfyUI /history（覆盖"生成完但还没下载"的情况）。 */
async function findExisting(prefix, localFlac) {
  if (existsSync(localFlac) && statSync(localFlac).size > 100000) {
    return { via: 'local', item: { filename: localFlac.split(/[\\/]/).pop(), subfolder: '', type: 'output' }, local: true }
  }
  try {
    const h = await (await fetch(`${BASE}/history`, { signal: AbortSignal.timeout(180000) })).json()
    for (const id of Object.keys(h)) {
      const e = h[id]
      for (const nodeId of Object.keys(e.outputs ?? {})) {
        const arr = e.outputs[nodeId]?.audio
        if (!Array.isArray(arr)) continue
        for (const it of arr) {
          if (String(it.filename ?? '').includes(prefix)) return { via: 'history', item: it, promptId: id }
        }
      }
    }
  } catch { /* /history 拿不到就当作没有 */ }
  return null
}

async function downloadView(item, dst) {
  const q = new URLSearchParams({
    filename: item.filename, subfolder: item.subfolder ?? '', type: item.type ?? 'output',
  })
  const url = `${BASE}/view?${q}`
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!r.ok) {
    // 老版本 ComfyUI 可能不暴露 /view 给音频 → 回落到磁盘直读
    const disk = join('C:\\SD-Aki\\ComfyUI-aki\\ComfyUI-aki-v3.2\\ComfyUI', 'output', item.subfolder ?? '', item.filename)
    if (existsSync(disk)) {
      writeFileSync(dst, readFileSync(disk))
      return { via: 'disk', url }
    }
    throw new Error(`下载失败 /view HTTP ${r.status}: ${url}`)
  }
  const buf = Buffer.from(await r.arrayBuffer())
  if (!buf.length) throw new Error('下载到 0 字节: ' + url)
  writeFileSync(dst, buf)
  return { via: 'view', url, bytes: buf.length }
}

function probe(file) {
  const out = spawnSync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration,bit_rate,size',
    '-show_entries', 'stream=codec_name,sample_rate,channels',
    '-of', 'json', file,
  ], { encoding: 'utf8' })
  if (out.status !== 0) throw new Error(`ffprobe 失败: ${(out.stderr || '').slice(-400)}`)
  const j = JSON.parse(out.stdout)
  const f = j.format ?? {}, s = (j.streams ?? [])[0] ?? {}
  return {
    duration: Number(f.duration ?? 0), bitRate: Number(f.bit_rate ?? 0), size: Number(f.size ?? 0),
    codec: String(s.codec_name ?? '?'), sampleRate: Number(s.sample_rate ?? 0), channels: Number(s.channels ?? 0),
  }
}

/** 用 ffmpeg volumedetect 实测峰值与 RMS（不靠估计） */
function volumeDetect(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8' })
  const txt = (r.stderr || '') + (r.stdout || '')
  const grab = (k) => { const m = txt.match(new RegExp(`${k}:\\s*(-?[\\d.]+) dB`)); return m ? Number(m[1]) : null }
  return { meanVolume: grab('mean_volume'), maxVolume: grab('max_volume') }
}

function toMp3(flac, mp3) {
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', flac,
    '-map', 'a:0', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '48000',
    '-map_metadata', '-1', mp3,
  ], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg 转码失败: ${(r.stderr || '').slice(-500)}`)
}

function report(TRACKS) {
  const rows = []
  for (const t of TRACKS) {
    const mp3 = join(AUDIO_DIR, `main-${String(t.n).padStart(2, '0')}.mp3`)
    if (!existsSync(mp3)) { rows.push({ n: t.n, name: t.name, missing: true }); continue }
    const p = probe(mp3)
    const v = volumeDetect(mp3)
    rows.push({
      n: t.n, name: t.name, file: mp3.split(/[\\/]/).pop(),
      seconds: +p.duration.toFixed(3), bitrateKbps: Math.round(p.bitRate / 1000),
      sizeMB: +(p.size / 1048576).toFixed(2), sampleRate: p.sampleRate, channels: p.channels, codec: p.codec,
      peakDb: v.maxVolume, rmsDb: v.meanVolume,
    })
  }
  console.log('\n=========== 4 条主轨实测（ffprobe + volumedetect）===========')
  console.log('#  文件             时长(s)   码率     大小      峰值dB   RMS dB')
  for (const r of rows) {
    if (r.missing) { console.log(`${r.n}  ${(r.name + ' (缺失)').padEnd(16)} ——`); continue }
    console.log(`${r.n}  ${r.file.padEnd(16)} ${String(r.seconds).padStart(7)}  ${String(r.bitrateKbps + 'kbps').padStart(7)}  ${String(r.sizeMB + 'MB').padStart(8)}  ${String(r.peakDb).padStart(6)}  ${String(r.rmsDb).padStart(6)}`)
  }
  return rows
}

async function main() {
  if (!existsSync(TEMPLATE)) throw new Error(`缺少模板 ${TEMPLATE}（先跑 node tools/harvest-music-api.mjs）`)
  const tpl = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  const force = has('--force')
  const only = val('only') ? Number(val('only')) : null
  const noConvert = has('--no-convert')
  const TRACKS = loadTracks()

  if (has('--report')) { report(TRACKS); return }

  mkdirSync(AUDIO_DIR, { recursive: true })
  const targets = TRACKS.filter((t) => (only ? t.n === only : true))

  console.log('源模板节点：' + Object.keys(tpl).length + ' 个')
  console.log(`本次生成 ${targets.length} 条：${targets.map((t) => `main-0${t.n}(${t.name})`).join(', ')}\n`)

  const flacTmp = join(HERE, '_mains-tmp')
  mkdirSync(flacTmp, { recursive: true })

  const jobs = []
  const reuse = []
  for (const t of targets) {
    const mp3 = join(AUDIO_DIR, `main-${String(t.n).padStart(2, '0')}.mp3`)
    const localFlac = join(flacTmp, `main-${String(t.n).padStart(2, '0')}.flac`)
    const prefix = `series0x2b/main-${String(t.n).padStart(2, '0')}_${t.name}`
    if (!force && existsSync(mp3) && statSync(mp3).size > 100000) {
      console.log(`[${t.n}] ${t.name} — mp3 已存在且非空，跳过（--force 可重生成）`)
      continue
    }
    // 已有产物（本地 flac 或 ComfyUI 历史）→ 直接复用，不重复烧生成
    if (!force) {
      const ex = await findExisting(prefix, localFlac)
      if (ex) {
        console.log(`[${t.n}] ${t.name} — 复用已有产物（来源 ${ex.via}${ex.promptId ? ', prompt ' + ex.promptId : ''}${ex.item?.filename ? ', ' + ex.item.filename : ''}）`)
        reuse.push({ t, item: ex.item, local: ex.local })
        continue
      }
    }
    const graph = buildGraph(tpl, t)
    const id = await queue(graph)
    console.log(`[${t.n}] ${t.name} — 已排队 prompt_id=${id}  seed=${t.seed}  max_duration=${t.seconds}s`)
    jobs.push({ t, id })
  }

  /** 每条的生成产物清单，最后一起转码 */
  const produced = []
  for (const { t, item, local } of reuse) {
    const flac = join(flacTmp, `main-${String(t.n).padStart(2, '0')}.flac`)
    if (!local) await downloadView(item, flac)
    const p = probe(flac)
    console.log(`[${t.n}] 复用 → ${item?.filename ?? flac}（${(p.size / 1048576).toFixed(2)}MB，${p.duration.toFixed(2)}s）`)
    if (p.duration < MINDUR) {
      throw new Error(`[${t.n}] 已有产物只有 ${p.duration.toFixed(1)}s，短于 ${MINDUR}s 下限 —— 不冒充交付`)
    }
    produced.push({ t, flac })
  }
  for (const { t, id } of jobs) {
    console.log(`[${t.n}] ${t.name} — 生成中…（MiniMax Music 3 30 步，132s 音频）`)
    const e = await waitDone(id, { label: `main-0${t.n}` })
    const item = findAudio(e)
    if (!item) throw new Error(`[${t.n}] 该次运行没有 audio 输出: ${JSON.stringify(e.outputs).slice(0, 600)}`)
    const flac = join(flacTmp, `main-${String(t.n).padStart(2, '0')}.flac`)
    const dl = await downloadView(item, flac)
    const p = probe(flac)
    console.log(`[${t.n}] 完成 → ${item.filename}（${dl.via}，${(p.size / 1048576).toFixed(2)}MB，${p.duration.toFixed(2)}s）`)
    if (p.duration < MINDUR) {
      throw new Error(`[${t.n}] 生成结果只有 ${p.duration.toFixed(1)}s，短于 ${MINDUR}s 下限 —— 不冒充交付`)
    }
    produced.push({ t, flac })
  }

  if (!noConvert) {
    for (const { t, flac } of produced) {
      const mp3 = join(AUDIO_DIR, `main-${String(t.n).padStart(2, '0')}.mp3`)
      toMp3(flac, mp3)
      console.log(`[${t.n}] 已转 128kbps → ${mp3.split(/[\\/]/).pop()}`)
    }
  }

  report(TRACKS)
  console.log('\n本次使用的提示词（4 条各一行）：')
  for (const t of TRACKS) console.log(`  main-0${t.n} (${t.name}): ${t.caption}`)
}

main().catch((e) => { console.error('\n❌ 生成失败（未做任何静音/占位替代）:\n' + (e && e.stack || e)); process.exitCode = 1 })
