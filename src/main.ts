import './style.css'
import { Stage, type TapeState } from './scene/stage'
import { Crawler } from './scene/crawler'
import { AudioEngine } from './audio/engine'
import { IDENTITY, SPEC_LINES, DENSE_LINES, READOUT, STATES } from './data/catalog'

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T
// 查询参数必须最先声明：主循环里也用到它，晚声明会触发 TDZ 异常并让整个模块崩掉
const params = new URLSearchParams(location.search)

// 强制从第一幕开始：关掉浏览器的滚动位置恢复（否则在第二/三幕刷新会直接从那一幕开始），
// 并显式回到顶部。带 ?act=N 的深链会在后面自己再定位一次。
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
scrollTo(0, 0)
/** 一次性调试参数：应用后从地址栏摘掉，避免刷新时被钉住（看起来像"启动不在第一幕"） */
function stripParams(keys: string[]) {
  const u = new URL(location.href)
  let hit = false
  for (const k of keys) if (u.searchParams.has(k)) { u.searchParams.delete(k); hit = true }
  if (hit) history.replaceState(null, '', u.toString())
}

const stage = new Stage($<HTMLCanvasElement>('#gl') as HTMLCanvasElement)
const crawler = new Crawler($<HTMLCanvasElement>('#cv') as HTMLCanvasElement)
const audio = new AudioEngine()

let act = 1
let actLockUntil = 0
let tapeState: TapeState = 0
let forcedState: TapeState | null = null
let playing = false
let elapsed = 0
let scopeT = 0

/* ---------------- 填充文字层 ---------------- */
function fillStatic() {
  $('#hud-title').textContent = `${IDENTITY.name} / ${IDENTITY.pipeline}`
  $('#a1-dense').innerHTML = DENSE_LINES.map(l => `<div>${l}</div>`).join('')
  $('#a2-kv').innerHTML = READOUT.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')
  $('#a3-kv').innerHTML = [
    ['SERIES', '0x2B'], ['MODE', 'REF-GRAPH'], ['SOURCE', 'SPEC LAYER'],
    ['LOOP', 'ON'], ['POINTER', 'TRACKED'], ['BODY', 'CRAWLER01'],
    ['EDGE-TYPE', 'CITATION'], ['DEPTH', '02'],
  ].map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')
  $('#boot-spec').textContent = `${IDENTITY.series} · ${IDENTITY.name} · ${IDENTITY.revision}`
}

/* ---------------- 打字机（ACT 01） ---------------- */
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function typeInto(el: HTMLElement, text: string, cps = 34) {
  el.textContent = ''
  for (let i = 0; i < text.length; i++) {
    el.textContent += text[i]
    if (i % 2 === 0) audio.sfx('type')
    await sleep(1000 / cps)
  }
}

async function runIntro() {
  await typeInto($('#a1-ttl'), 'BLEND-TAPE', 22)
  const spec = $('#a1-spec')
  spec.innerHTML = ''
  for (const line of SPEC_LINES) {
    const row = document.createElement('div')
    row.innerHTML = `<i>·</i> `
    const span = document.createElement('span')
    row.appendChild(span)
    spec.appendChild(row)
    await typeInto(span, line, 90)
    if (Math.random() < 0.4) audio.sfx('paper')
  }
}

/* ---------------- 幕切换 ---------------- */
const sections = Array.from(document.querySelectorAll<HTMLElement>('.act'))

/** 分幕几何缓存：只在加载/尺寸变化时量一次，避免滚动时反复强制回流（卡顿主因之一） */
let geom: Array<{ c: number; h: number }> = []
let measuredVH = 0
function measureSections() {
  measuredVH = innerHeight
  geom = sections.map(s => ({ c: s.offsetTop + s.offsetHeight / 2, h: s.offsetHeight }))
}
const PAPER = [236, 232, 223]      // 米白
const VOID = [6, 7, 10]            // 黑

/** 全屏黑色遮罩（"幕布"）：只用它的 opacity 做米白→黑的过渡。
 *  为什么不用 body 背景色：改 body 背景会整页重绘（第三幕那层有 3 万个元素），
 *  而改遮罩 opacity 是纯合成操作，不触发重绘 —— 既顺滑，又能把第三幕首次栅格化的卡顿盖过去 */
const veil = document.createElement('div')
veil.id = 'veil'
document.body.appendChild(veil)

const lastO: number[] = []
let lastVeil = -1
let fadeIdle = 0
/** 渐变转场：透明度 + 微位移（用缓存几何，零回流）+ 幕布不透明度 */
function updateFade() {
  // 视口高度变了就复量：缓存若在错误的视口下量过（实测遇到过 innerHeight=167 的情况），
  // 所有分幕中心与渐变都会算错
  if (!geom.length || innerHeight !== measuredVH) measureSections()
  const mid = scrollY + innerHeight / 2
  sections.forEach((s, i) => {
    const g = geom[i]
    if (!g) return
    const d = Math.abs(mid - g.c) / innerHeight
    const o = Math.max(0, Math.min(1, 1 - d * 1.05))
    // 只在数值真的变化时才写样式（本函数现在是每帧调用）
    if (Math.abs((lastO[i] ?? -1) - o) > 0.002) {
      lastO[i] = o
      s.style.opacity = o.toFixed(3)
      s.style.transform = `translateY(${(((g.c - mid) / innerHeight) * 26).toFixed(1)}px)`
      s.dataset.fade = o > 0.45 ? 'in' : 'out'
      s.classList.add('animating')
      fadeIdle = 14
    }
  })
  // 幕布：第二幕居中 = 0，第三幕居中 = 1（随滚动连续变化）
  const c2 = geom[1]?.c ?? 0
  const c3 = geom[2]?.c ?? c2 + innerHeight
  const t = Math.max(0, Math.min(1, (mid - c2) / Math.max(1, c3 - c2)))
  if (Math.abs(lastVeil - t) > 0.002) {
    lastVeil = t
    veil.style.opacity = t.toFixed(3)
    veil.classList.add('animating')
    fadeIdle = 14
  }
}

function detectAct() {
  updateFade()
  // 深链定位期间锁定，别让滚动推导出的幕号把 ?act=N 覆盖掉
  if (performance.now() < actLockUntil) return
  const mid = innerHeight * 0.5
  let found = 1
  for (const s of sections) {
    const r = s.getBoundingClientRect()
    if (r.top <= mid && r.bottom >= mid) found = Number(s.dataset.act)
  }
  if (found !== act) {
    const prev = act
    act = found
    document.body.dataset.act = String(act)
    stage.setAct(act)
    document.querySelectorAll('#hud-rail .tick').forEach(t => {
      t.classList.toggle('on', Number((t as HTMLElement).dataset.act) === act)
    })
    audio.sfx(act === 3 ? 'paper' : 'switch')
    // 叙事：进入第二幕 = 装载磁带（播放）并从 step0（REST）开始；离开 = 停机；回到第一幕 = 静置
    if (act === 2) { setState(0); setPlaying(true) }
    else if (prev === 2) setPlaying(false)
    if (act === 1) setState(0)
    // ?state=N 指定的状态优先级最高（验证用）：吸附+平滑滚动会让 detectAct 晚触发并覆盖它
    if (forcedState != null) setState(forcedState)
  }
  const doc = document.documentElement
  const p = Math.min(1, scrollY / Math.max(1, doc.scrollHeight - innerHeight))
  ;($('#rail-fill') as HTMLElement).style.height = `${(p * 100).toFixed(1)}%`
}

/* ---------------- 传输控制 ---------------- */
function setPlaying(on: boolean, hard = false) {
  if (on !== playing) {
    playing = on
    stage.setPlaying(on)
    document.querySelectorAll('.tb').forEach(b => {
      const t = (b as HTMLElement).dataset.t
      if (t === 'play') b.classList.toggle('on', on)
      if (t === 'stop') b.classList.toggle('on', !on)
    })
    $('#hud-mode').textContent = on ? 'PLAY' : 'STANDBY'
  }
  // 音频必须【每次调用都执行】（早退会跳过交接，见 README 的 bug 记录）。
  // hard=true 是传输条 STOP：主轨+次轨一起静音；否则是"交接回次轨"。
  if (on) audio.engageTape()
  else if (hard) audio.stopAll()
  else audio.disengageTape()
}

function setState(n: TapeState) {
  tapeState = n
  stage.setState(n)
  document.querySelectorAll('.sb').forEach(b => b.classList.toggle('on', Number((b as HTMLElement).dataset.state) === n))
  // 顶栏带出真实状态值，便于截图核对（S0/S1/S2）
  $('#hud-title').textContent = `${IDENTITY.name} / ${IDENTITY.pipeline} · S${n}`
  audio.sfx(n === 2 ? 'paper' : 'click')
  // 拆解态顺带把读数切换成“零件级”（与模型实际零件一致：57 件）
  const rows = n === 2
    ? [['PARTS', '57'], ['LABEL', '08'], ['FRAME', '02'], ['REELS', '18'], ['BODY', '22'],
       ['BACK', '07'], ['MESH', 'SEP'], ['GAP', '56mm']]
    : READOUT
  $('#a2-kv').innerHTML = rows.map(([k, v]) => `<div class="row"><span>${k}</span><b>${v}</b></div>`).join('')
}

/* ---------------- SPLIT 态的细虚线引线 + 小方标（照参考视频） ---------------- */
const LAYER_LABEL: Record<string, string> = {
  label: '01 LABEL', framePlate: '02 FRAME', reels: '03 REELS', body: '04 BODY', backPlate: '05 BACK',
}
const leaderSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
leaderSvg.setAttribute('id', 'leaders')
leaderSvg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`)
document.querySelector('#act2')?.appendChild(leaderSvg)

function drawLeaders() {
  const on = act === 2 && tapeState === 2
  leaderSvg.style.opacity = on ? '1' : '0'
  if (!on) return
  leaderSvg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`)
  const out: string[] = []
  stage.layerAnchors().forEach((a, i) => {
    const lx = Math.min(a.x - 150, innerWidth * 0.30) - i * 8
    const ly = a.y + (i - 2) * 6
    out.push(`<path class="ld" d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${(lx + 40).toFixed(1)} ${ly.toFixed(1)} L${lx.toFixed(1)} ${ly.toFixed(1)}"/>`)
    out.push(`<rect class="ld-sq" x="${(lx - 8).toFixed(1)}" y="${(ly - 8).toFixed(1)}" width="16" height="16"/>`)
    out.push(`<text class="ld-tx" x="${(lx - 12).toFixed(1)}" y="${(ly + 5).toFixed(1)}">${LAYER_LABEL[a.name] ?? a.name}</text>`)
  })
  leaderSvg.innerHTML = out.join('')
}

document.querySelectorAll('.tb').forEach(b => {
  b.addEventListener('click', () => {
    const t = (b as HTMLElement).dataset.t
    audio.sfx(t === 'play' ? 'load' : 'click')
    if (t === 'play') { if (!playing && !audio.tapeEngaged) audio.resumeBed(); setPlaying(true) }
    else if (t === 'stop') {
      // 全停：音频全静音 + 计数归零 + 卷轴停 + 磁带回到 REST
      setPlaying(false, true)
      elapsed = 0
      setState(0)
      stage.setPlaying(false)
    }
    else if (t === 'load') { setState(1); if (!playing) setPlaying(true) }
    else if (t === 'side') {
      const el = b as HTMLElement
      el.textContent = el.textContent === 'SIDE A' ? 'SIDE B' : 'SIDE A'
      audio.sfx('switch')
    } else if (t === 'rew' || t === 'ff') {
      elapsed = t === 'rew' ? 0 : elapsed
      if (tapeState === 0) setState(1)
      audio.sfx('reel')
    }
  })
})
document.querySelectorAll('.sb').forEach(b => {
  b.addEventListener('click', () => setState(Number((b as HTMLElement).dataset.state) as TapeState))
})

addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing) }
  if (e.key === '1') setState(0)
  if (e.key === '2') setState(1)
  if (e.key === '3') setState(2)
})

/* ---------------- 指针 + 第一幕拖动旋转 ---------------- */
let dragging = false
let dragMoved = 0
let lastPX = 0
let lastPY = 0

addEventListener('pointerdown', e => {
  if (act === 3) return
  if (!stage.hitTest(e.clientX, e.clientY)) return
  dragging = true; dragMoved = 0
  lastPX = e.clientX; lastPY = e.clientY
  stage.setDragging(true)
  document.body.classList.add('dragging')
})

addEventListener('pointermove', e => {
  const cx = e.clientX, cy = e.clientY
  stage.setPointer((cx / innerWidth) * 2 - 1, (cy / innerHeight) * 2 - 1)
  // 按幕分派：指针事件可达 120~240Hz，别在看不见的目标上做无用功
  if (act === 2) stage.setPointerPx(cx, cy)
  if (act === 3) crawler.setPointer(cx, cy)
  if (!dragging) return
  const dx = cx - lastPX, dy = cy - lastPY
  lastPX = cx; lastPY = cy
  dragMoved += Math.abs(dx) + Math.abs(dy)
  stage.dragBy(dx, dy)
}, { passive: true })

addEventListener('pointerup', () => {
  if (!dragging) return
  dragging = false
  stage.setDragging(false)
  document.body.classList.remove('dragging')
  setTimeout(() => { dragMoved = 0 }, 60)      // 让随后的 click 能读到本次位移
})

/* ---------------- 点击磁带：第一幕 → 滚到第二幕 step0；第二幕 → 循环切三态 ---------------- */
function gotoAct2() {
  const el = document.querySelector<HTMLElement>('.act[data-act="2"]')
  if (el) scrollTo({ top: el.offsetTop, behavior: 'smooth' })
  setState(0)                                   // 第二幕从 step0（REST 闭合）开始
  audio.sfx('load')
}

stage.onTapeClick = (x: number, y: number) => {
  if (dragMoved > 8) return                     // 刚才是拖动，不算点击
  if (act === 1) { gotoAct2(); return }
  // 第二幕 HALF：点【带条范围内】= 选曲切轨；点范围外（壳体）= 照旧切三态
  if (act === 2 && tapeState === 1) {
    const band = stage.hitTestBand(x, y)
    if (band != null && band < audio.declaredTrackCount) {
      audio.selectTrack(band)                   // 引擎内部做 0.4s 交叉淡化 + 剪接音效
      return
    }
  }
  const next = ((tapeState + 1) % 3) as TapeState
  audio.sfx(next === 1 ? 'click' : next === 2 ? 'paper' : 'switch')
  setState(next)
}

/* ---------------- 示波器 / 频谱 / 仪表 ---------------- */
const scope = $('#scope') as HTMLCanvasElement
const spec = $('#spectrum') as HTMLCanvasElement
const wave = new Float32Array(420)
const bins = new Uint8Array(96)

function drawScope() {
  const g = scope.getContext('2d')!
  const w = scope.width, h = scope.height
  g.clearRect(0, 0, w, h)
  g.fillStyle = 'rgba(23,24,26,0.04)'
  g.fillRect(0, 0, w, h)
  g.strokeStyle = 'rgba(23,24,26,0.14)'
  g.lineWidth = 1
  for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, (h / 4) * i); g.lineTo(w, (h / 4) * i); g.stroke() }
  audio.wave(wave)
  g.strokeStyle = '#c8372d'
  g.lineWidth = 1.4
  g.beginPath()
  for (let i = 0; i < wave.length; i++) {
    const x = (i / (wave.length - 1)) * w
    const y = h / 2 - wave[i] * (h / 2) * 0.9
    i ? g.lineTo(x, y) : g.moveTo(x, y)
  }
  g.stroke()

  const g2 = spec.getContext('2d')!
  const w2 = spec.width, h2 = spec.height
  g2.clearRect(0, 0, w2, h2)
  audio.spectrum(bins)
  const bw = w2 / bins.length
  for (let i = 0; i < bins.length; i++) {
    const v = bins[i] / 255
    g2.fillStyle = `rgba(23,24,26,${0.14 + v * 0.72})`
    g2.fillRect(i * bw, h2 - v * h2, Math.max(1, bw - 0.7), v * h2)
  }
}

function fmt(t: number) {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const c = Math.floor((t % 1) * 100)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

/* ---------------- 主循环 ---------------- */
const crawlAuto = params.get('crawl') === 'auto'   // 吸引模式：指针目标自动巡游（也用于验收跟随逻辑）
// 逐帧写 DOM 的节点一次性查好（每帧 7 次 querySelector 是纯浪费）
const elCounter = $('#counter'), elClock = $('#hud-clock')
const elBedLvl = $('#bed-lvl'), elMainLvl = $('#main-lvl'), elA2Live = $('#a2-live')
let liveB: HTMLElement[] | null = null
/* ---------------- LVL 条柱波浪 ---------------- */
const LVL_BARS = 24
const LVL_BAR_W = 4
const LVL_GAP = 4
const lvlCv = $('#lvl') as HTMLCanvasElement
const lvlCtx = lvlCv.getContext('2d')!
const lvlWave = new Float32Array(256)
const lvlBar = new Float32Array(LVL_BARS)
/** 条柱波浪：取样 → 每柱取 RMS → 平滑跟随（平滑是关键，否则还是跳变） */
function drawLvl(neon: boolean) {
  audio.wave(lvlWave)
  const n = lvlWave.length
  const per = Math.floor(n / LVL_BARS)
  const h = lvlCv.height
  let any = false
  for (let i = 0; i < LVL_BARS; i++) {
    let s = 0
    for (let k = 0; k < per; k++) { const v = lvlWave[i * per + k]; s += v * v }
    // 目标高度：RMS 开方后放大，再夹到 1..h
    const rms = Math.sqrt(s / per)
    const t = Math.min(1, rms * 5.2)
    lvlBar[i] += (t - lvlBar[i]) * (t > lvlBar[i] ? 0.45 : 0.18)   // 起得快、落得慢 → 像条柱波
    if (lvlBar[i] > 0.02) any = true
  }
  lvlCtx.clearRect(0, 0, lvlCv.width, h)
  lvlCtx.fillStyle = neon ? '#7fe9ff' : '#c0392b'
  for (let i = 0; i < LVL_BARS; i++) {
    const bh = any ? Math.max(1.5, lvlBar[i] * h) : 1.5
    lvlCtx.fillRect(i * (LVL_BAR_W + LVL_GAP), h - bh, LVL_BAR_W, bh)
  }
}

let prev = performance.now()
let frame = 0
let lastLiveSig = ''
let lastMeterL = -1
let lastMeterR = -1
function loop() {
  const now = performance.now()
  const dt = Math.min((now - prev) / 1000, 0.05)
  prev = now
  frame++

  // 自动巡游：让爬虫沿 Lissajous 轨迹追一个虚拟指针
  if (crawlAuto) {
    const t = now / 1000
    const cx = innerWidth * (0.5 + 0.34 * Math.sin(t * 0.34))
    const cy = innerHeight * (0.5 + 0.30 * Math.sin(t * 0.53 + 1.1))
    crawler.setPointer(cx, cy)
    stage.setPointer((cx / innerWidth) * 2 - 1, (cy / innerHeight) * 2 - 1)
  }

  if (playing) elapsed += dt
  updateFade()      // 每帧都算：几何有自校正（视口变化即复量），零回流，代价 O(1)
  // 转场结束后摘掉 will-change（合成层只在转场期间存在，避免 40MB+ 显存常驻）
  if (fadeIdle > 0 && --fadeIdle === 0) {
    for (const s of sections) s.classList.remove('animating')
    veil.classList.remove('animating')
  }
  // 必须每帧都调用：爬虫内部按 body[data-act] 决定显隐。
  // 之前只在 act===3 时调用 → 滚回前两幕后再没有一帧去隐藏，代码就留在背景上了。
  crawler.draw(dt)

  scopeT += dt
  if (scopeT > 1 / 30) { scopeT = 0; drawScope() }
  drawLeaders()

  const lv = audio.levels()
  // 逐帧写 DOM 很贵（每次都要样式/布局计算）→ 分频 + 只在数值变化时写
  if (frame % 3 === 0) {
    const stamp = fmt(elapsed)                       // fmt 每帧只算一次（原来算了两次）
    elCounter.textContent = stamp
    elClock.textContent = stamp
  }
  if (frame % 6 === 0) {
    elBedLvl.textContent = String(Math.round(lv.bed * 200)).padStart(3, '0')
    elMainLvl.textContent = String(Math.round(lv.main * 200)).padStart(3, '0')
  }
  if (frame % 2 === 0) drawLvl(act === 3)      // 30Hz 足够，且比原来 20Hz 更顺
  if (act === 2 && frame % 6 === 0) {
    const sig = `${(lv.main * 100).toFixed(1)}|${(lv.bed * 100).toFixed(1)}`
    if (sig !== lastLiveSig) {
      lastLiveSig = sig
      // 骨架只建一次，之后只改文字（原来每帧重建 innerHTML → 每帧 HTML 解析 + flex 重新布局）
      if (!liveB) {
        elA2Live.innerHTML = ['LEVEL', 'BED', 'SPEED', 'TENSION', 'TRK']
          .map(k => `<div class="row"><span>${k}</span><b>0.0</b></div>`).join('')
        liveB = Array.from(elA2Live.querySelectorAll<HTMLElement>('.row b'))
        liveB[2].textContent = '4.76'                // SPEED 是常量，写一次即可
      }
      liveB[0].textContent = (lv.main * 100).toFixed(1)
      liveB[1].textContent = (lv.bed * 100).toFixed(1)
      liveB[3].textContent = (0.42 + lv.main * 0.1).toFixed(1)
      // 曲目行：0n / 0N · LEN mm:ss（跟随选中的那段实时变化）
      const ti = audio.selectedTrack
      const td = audio.trackDuration(ti)
      liveB[4].textContent =
        `${String(ti + 1).padStart(2, '0')} / ${String(audio.declaredTrackCount).padStart(2, '0')}`
        + ` · LEN ${String(Math.floor(td / 60)).padStart(2, '0')}:${String(Math.floor(td % 60)).padStart(2, '0')}`
    }
  }

  if (act === 3 && (frame % 8 === 0)) {          // 统计每 8 帧算一次（原本每帧遍历 3 万 token）
    const st = crawler.stats()
    $('#a3-stats').innerHTML =
      `EATEN ${st.eaten}<br>DROPPED ${st.dropped}<br>VARS LEFT ${st.left}<br>FLY ${st.flights} / JUMP ${st.jumps}${st.flying ? ' ·AIR' : ''}<br>POS ${Math.round(crawler.sx)},${Math.round(crawler.sy)}<br>FPS ${st.fps}`
  }

  if (params.get('dbg') === '1') {
    $('#hud-title').textContent =
      `y${Math.round(scrollY)} veil${(veil.style.opacity || '0')} act${act} vh${innerHeight} c[${geom.map(g => Math.round(g.c)).join(',')}]`
  }

  requestAnimationFrame(loop)
}

/* ---------------- 启动 ---------------- */
addEventListener('resize', () => { stage.resize(); crawler.resize(); measureSections(); updateFade() })
// 从后台标签页切回来时视口尺寸可能才变正确，需要复量并重算
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { measureSections(); updateFade() }
})
addEventListener('scroll', detectAct, { passive: true })

fillStatic()
measureSections()
setTimeout(() => { measureSections(); updateFade() }, 600)     // 字体/模型载入后复量一次
stage.setState(0, false)
stage.setAct(1)
setState(0)
document.body.dataset.act = '1'
document.querySelector('#hud-rail .tick[data-act="1"]')?.classList.add('on')
detectAct()
stage.start()
requestAnimationFrame(loop)

$('#arm').addEventListener('click', async () => {
  await audio.arm()
  $('#boot').classList.add('off')
  audio.sfx('load')
  // 延迟开启"点磁带"：ARM 按钮就在视口正中、磁带也在正中，
  // 不设宽限期的话这一次点击会连磁带的处理器一起触发 → 刚解锁就跳到第二幕。
  setTimeout(() => { stage.tapEnabled = true }, 700)
  await sleep(320)
  void runIntro()
})

// 深链/演示模式：?auto=1 跳过遮罩；?act=N 直接定位到第 N 幕
if (params.get('auto') === '1') {
  $('#boot').classList.add('off')
  stage.tapEnabled = true
  void audio.arm().catch(() => { /* 无手势时音频挂起，不影响画面 */ })
  void runIntro()
}
// 深链只在显式带 ?dev=1 时生效。
// 原因：?act=N 会【每次加载都强制定位】到第 N 幕，用户若把带参数的地址存成书签/历史，
// 就会反复出现"打开不是第一幕"，看起来像 bug。加一道闸门后，裸 ?act=2 不再有任何作用。
const devMode = params.get('dev') === '1'
const actParam = devMode ? Number(params.get('act') ?? 0) : 0
if (actParam >= 1 && actParam <= 3) {
  let tries = 0
  const go = () => {
    const el = document.querySelector<HTMLElement>(`.act[data-act="${actParam}"]`)
    if (!el) return
    // 布局可能还在变（字体/模型载入会改变幕高 → 吸附点也变），所以滚完要校验一次，
    // 不符就再滚；否则会被吸附吸到相邻的一幕去
    const target = el.offsetTop
    if (Math.abs(scrollY - target) > 4) scrollTo({ top: target, behavior: 'auto' })
    actLockUntil = performance.now() + 1300
    act = actParam
    document.body.dataset.act = String(act)
    stage.setAct(act)
    document.querySelectorAll('#hud-rail .tick').forEach(t => {
      t.classList.toggle('on', Number((t as HTMLElement).dataset.act) === act)
    })
    if (act === 2) { setState(0); setPlaying(true) }     // 第二幕从 step0（REST）开始
    if (act === 1) setState(0)
    if (forcedState != null) setState(forcedState)
    measureSections()
    updateFade()
  }
  const tick = () => {
    go()
    if (++tries < 7) setTimeout(tick, 200)
  }
  requestAnimationFrame(tick)
  // 深链是一次性的：应用后从地址栏摘掉。否则刷新会永远被 ?act=N 钉在那一幕，
  // 看起来就像"启动不在第一幕"。
  stripParams(['act'])
}
// 启动兜底：没有被指定幕号时，确保停在第一幕。
// 覆盖所有可能的残留原因（地址栏里还挂着 ?act=N、吸附在布局变化后重新吸到别的一幕、
// 首屏布局抖动把 scrollY 顶走）。一旦用户自己开始滚动就立刻收手，不跟用户抢。
if (!(actParam >= 1 && actParam <= 3)) {
  let userMoved = false
  const mark = () => { userMoved = true }
  // 只认"真的有滚动意图"的事件。故意不收 mousedown —— 用户点一下窗口就会把兜底关掉，
  // 那样启动归位就失效了。
  for (const ev of ['wheel', 'touchstart', 'touchmove', 'keydown'] as const) {
    addEventListener(ev, mark, { once: true, passive: true })
  }
  const ensureAct1 = () => {
    if (userMoved) return
    if (scrollY > 8) scrollTo({ top: 0, behavior: 'auto' })
    measureSections()
    if (act !== 1) {
      act = 1
      document.body.dataset.act = '1'
      stage.setAct(1)
      document.querySelectorAll('#hud-rail .tick').forEach(t => {
        t.classList.toggle('on', Number((t as HTMLElement).dataset.act) === 1)
      })
      setState(0)
    }
    updateFade()
  }
  for (const t of [250, 800, 1600, 2600]) setTimeout(ensureAct1, t)
}

// ?y=N：滚到指定像素（辅助排查；不动吸附）
const yParam = Number(params.get('y') ?? -1)
if (yParam >= 0) {
  setTimeout(() => { scrollTo({ top: yParam, behavior: 'auto' }); updateFade() }, 400)
}

// ?state=N 直接定到某一态（用于验收，避免在浏览器里真的点击）
// 和 ?act=N 一样必须带 ?dev=1：否则子代理/我留下的测试地址（?state=2）会让页面
// 一打开就定在 STATE 02 SPLIT，看起来就像"启动落点被改了"。
const stParam = devMode ? Number(params.get('state') ?? -1) : -1
if (stParam >= 0 && stParam <= 2) {
  forcedState = stParam as TapeState
  setTimeout(() => setState(forcedState as TapeState), 120)
  setTimeout(() => setState(forcedState as TapeState), 1200)   // 平滑滚动结束后再压一次
  stripParams(['state'])
}
