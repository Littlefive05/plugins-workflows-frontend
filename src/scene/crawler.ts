// SERIES 0x2B — ACT 03 爬虫 v8：「一点 + 大长腿的纯 2D 蜘蛛」
//  本轮口径（用户）：
//   · 身体只要【一个圆点】（去掉头胸部第二点），纯 2D
//   · 去掉进食手感（无咀嚼停顿、无碎屑）
//   · 蜘蛛【必须踩着代码块走】：身体被夹在代码文字带内，不允许在空白处行走
//   · 跨半屏要【吐丝飞过去】：默认跟随鼠标所在的一侧，但不过紧；侧别不同就吐丝滑翔过去
//   · 踩掉的代码 = 物理抛落（可见的初速+重力+旋转+小弹跳）→ 依赖 CSS 里给 token 加 inline-block
import { SOURCES } from '../data/source'

interface Tok { col: number; line: number; ch: number; len: number; text: string; kind: string }
interface Foot { x: number; y: number; tx: number; ty: number; step: number; tok: number | null; cool: number; planted: number }
interface Col { el: HTMLDivElement; x: number; w: number; rows: number; oneH: number; offset: number; speed: number }
export interface CrawlStats { eaten: number; dropped: number; left: number; flights: number; jumps: number; flying: boolean; fps: number }

const GUTTER = 54
const LINE_H = 15
const COLS = 2
const RESTORE_MS = 18000
/** 踢飞动画的实际时长：类必须在这之后就摘掉。
 *  原来挂到 RESTORE_MS（18s）才摘 —— 而 CSS 里的 will-change 会让这个 inline-block
 *  白当 18 秒的独立合成层。 */
const KICK_ANIM_MS = 1200
const EMPTY_ELS: HTMLElement[] = []
const DROP_CHANCE = 0.3
const DROP_COOLDOWN = 0.4

const LEG_R = 46
const HIP_R = 6.5
const LEG_ANG = [64, 25, -21, -60]
const BEND = 52 * Math.PI / 180
const KNEE_T = 0.58
const STEP_OUT = 0.84             // 主搜索带（窄带 → 八条腿长短接近）
const STEP_MAX = 1.20
const STEP_OUT_WIDE = 0.64        // 兜底搜索带：放得很宽，让"起跳"成为最后手段
const STEP_MAX_WIDE = 1.44
const SHARE_PENALTY = 26          // 与别的腿踩同一个 token 的扣分（软约束，而不是判失败）
/* 腿长触发阈值要明显宽于搜索带，否则每次搜索都判定"超限"→ 一直起跳 */
const LEG_LIMIT = 0.24
const STEP_DUR = 0.13
const STRIDE = 15
const GAIT: number[][] = [[0, 2, 5, 7], [1, 3, 4, 6]]
const FLY_COOL = 2.6
const JUMP_DUR = 0.42            // 紧急起跳（没有落脚点时立刻跳走）
const ROAM_EATS = 5              // 同一侧连吃这么多就"吃腻"，换到对面
const ROAM_SECONDS = 16          // 同一侧待这么久也换区
const STARTUP_GRACE = 0.7        // 开局这几秒不判定"踩虚空"，先把脚种到代码上

const RE = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|export|default|const|let|var|function|class|new|return|if|else|for|of|in|await|async|this|type|interface|extends|implements|void|as|throw|try|catch|switch|case|break|continue|null|undefined|true|false)\b|\b(\d+(?:\.\d+)?)\b|(<\/?[a-zA-Z][\w-]*)|(#[A-Za-z][\w-]*)|\b([A-Z][A-Za-z0-9_]{2,})\b|\b([a-z_$][A-Za-z0-9_$]{1,})\b/g
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface Piece { ch: number; len: number; cls: string; text: string }
function highlight(line: string): { html: string; pieces: Piece[] } {
  let out = '', last = 0
  const pieces: Piece[] = []
  RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = RE.exec(line))) {
    out += esc(line.slice(last, m.index))
    const txt = m[0]
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'k' : m[4] ? 'n' : m[5] ? 't' : m[6] ? 'i' : m[7] ? 'y' : 'v'
    out += `<i class="${cls}">${esc(txt)}</i>`
    if (cls !== 'c' && txt.length >= 2) pieces.push({ ch: m.index, len: txt.length, cls, text: txt })
    last = m.index + txt.length
  }
  out += esc(line.slice(last))
  return { html: out, pieces }
}

export class Crawler {
  sx = innerWidth / 2
  sy = innerHeight / 2

  private root: HTMLDivElement
  private svg: SVGSVGElement
  private cols: Col[] = []
  private toks: Tok[] = []
  private rowRange: Array<Array<[number, number]>> = []
  private colMaxChars: number[] = []
  /** 每列每行的字符数（用于按行收紧"代码带"，避免走到短行右侧的空白里） */
  private rowChars: number[][] = []
  private eaten = new Map<number, number>()
  private dropped = new Map<number, number>()
  private eatenCount = 0
  private droppedCount = 0
  private varsTotal = 0
  private varsHidden = 0

  private vx = 0; private vy = 0
  private heading = 0
  private feet: Foot[] = []
  private target: { x: number; y: number; tok: number | null } | null = null
  private px = innerWidth / 2; private py = innerHeight / 2
  private tx = this.px; private ty = this.py
  private trail: Array<{ x: number; y: number }> = []
  private idleT = 0
  private flash = 0
  private flashAt = { x: 0, y: 0 }
  private gaitDist = 0
  private gaitSet = 0
  private gaitTimer = 0
  private queue: Array<{ li: number; at: number }> = []
  private dropCool = 0
  private flight: { t: number; dur: number; from: { x: number; y: number }; to: { x: number; y: number }; ctrl: { x: number; y: number }; tok: number | null; silk: boolean } | null = null
  private flyCool = 3
  private flights = 0
  private jumps = 0
  private startup = STARTUP_GRACE
  private targetAge = 0
  private wantFly = false
  private roamWant = false          // 吃腻了 → 强制换到对面
  private sameSideEats = 0
  private sideTimer = 0
  private lastSide = 0

  private chW = 6.9
  private fps = 60
  private last = performance.now()
  private on = false
  private hideTimer = 0

  private body!: SVGCircleElement
  private legs: SVGPolylineElement[] = []
  private knees: SVGCircleElement[] = []
  private hips: SVGCircleElement[] = []
  private footDots: SVGCircleElement[] = []
  private trailEl!: SVGPolylineElement
  private silkEl!: SVGPolylineElement
  private ring!: SVGCircleElement

  constructor(canvas: HTMLCanvasElement) {
    canvas.style.display = 'none'
    const NS = 'http://www.w3.org/2000/svg'
    this.root = document.createElement('div')
    this.root.className = 'crawl-layer'
    this.svg = document.createElementNS(NS, 'svg')
    this.svg.setAttribute('class', 'crawl-spider')
    this.root.appendChild(this.svg)

    const mk = (tag: string, cls: string) => {
      const e = document.createElementNS(NS, tag)
      e.setAttribute('class', cls)
      this.svg.appendChild(e)
      return e
    }
    this.trailEl = mk('polyline', 'sp-silk') as SVGPolylineElement
    this.silkEl = mk('polyline', 'sp-fly') as SVGPolylineElement
    for (let i = 0; i < 8; i++) {
      this.legs.push(mk('polyline', 'sp-leg') as SVGPolylineElement)
      this.hips.push(mk('circle', 'sp-hip') as SVGCircleElement)
      this.knees.push(mk('circle', 'sp-knee') as SVGCircleElement)
      this.footDots.push(mk('circle', 'sp-foot') as SVGCircleElement)
    }
    for (const c of this.hips) c.setAttribute('r', '1.8')
    for (const c of this.footDots) c.setAttribute('r', '1.9')
    // 身体：只有一个圆点
    this.body = mk('circle', 'sp-body') as SVGCircleElement
    this.body.setAttribute('r', '6.6')
    this.ring = mk('circle', 'sp-ring') as SVGCircleElement

    document.body.appendChild(this.root)
    this.measure()
    this.buildContent()
    for (let i = 0; i < 8; i++) {
      const r = this.idealRest(i)
      this.feet.push({ x: r.x, y: r.y, tx: r.x, ty: r.y, step: 0, tok: null, cool: 0, planted: 0 })
    }
    // 开局就把八条腿种到代码上（绝不从虚空起步）
    this.plantFeetAt(this.sx, this.sy)
    this.resize()
  }

  /* ---------------- 纯 2D 腿几何 ---------------- */
  private legAngle(i: number) {
    return this.heading + (i < 4 ? -1 : 1) * (LEG_ANG[i % 4] * Math.PI) / 180
  }
  private idealRest(i: number) {
    const a = this.legAngle(i)
    const r = this.flight ? LEG_R * 0.34 : LEG_R
    return { x: this.sx + Math.cos(a) * r, y: this.sy + Math.sin(a) * r }
  }
  private hipPos(i: number) {
    const a = this.legAngle(i)
    return { x: this.sx + Math.cos(a) * HIP_R, y: this.sy + Math.sin(a) * HIP_R }
  }
  private kneePos(i: number, hip: { x: number; y: number }, foot: { x: number; y: number }) {
    const dx = foot.x - hip.x, dy = foot.y - hip.y
    const len = Math.max(1, Math.hypot(dx, dy))
    const ux = dx / len, uy = dy / len
    const s = i < 4 ? -1 : 1
    const ca = Math.cos(s * BEND), sa = Math.sin(s * BEND)
    return { x: hip.x + (ux * ca - uy * sa) * len * KNEE_T, y: hip.y + (ux * sa + uy * ca) * len * KNEE_T }
  }

  /* ---------------- 内容 + 行索引 ---------------- */
  private buildContent() {
    const totals = SOURCES.map(f => f.lines.length + 1)
    const grand = totals.reduce((a, b) => a + b, 0)
    const groups: number[][] = Array.from({ length: COLS }, () => [])
    let acc = 0, ci = 0
    SOURCES.forEach((_, i) => {
      if (ci < COLS - 1 && acc >= grand / COLS) ci++
      groups[ci].push(i); acc += totals[i]
    })
    groups.forEach((fileIdx, c) => {
      const el = document.createElement('div')
      el.className = 'crawl-col'
      this.root.insertBefore(el, this.svg)
      const col: Col = { el, x: 0, w: 0, rows: 0, oneH: 0, offset: c * 137, speed: 20 + c * 4 }
      this.cols.push(col)
      const ranges: Array<[number, number]> = []
      const chars: number[] = []
      let maxChars = 0
      const build = (frag: DocumentFragment) => {
        let row = 0
        for (const fi of fileIdx) {
          const f = SOURCES[fi]
          const head = document.createElement('div')
          head.className = 'cl head'
          head.innerHTML = `<span class="ln">··</span><code>${esc(f.path)}</code>`
          frag.appendChild(head); row++
          chars.push(f.path.length)
          for (const text of f.lines) {
            const div = document.createElement('div')
            div.className = 'cl'
            const { html, pieces } = highlight(text)
            div.innerHTML = `<span class="ln">${String(row).padStart(4, '0')}</span><code>${html}</code>`
            const start = this.toks.length
            for (const p of pieces) {
              this.toks.push({ col: c, line: row, ch: p.ch, len: p.len, text: p.text, kind: p.cls })
              if (p.cls === 'v') this.varsTotal++
            }
            ranges.push([start, this.toks.length])
            chars.push(text.length)
            if (text.length > maxChars) maxChars = text.length
            frag.appendChild(div); row++
          }
        }
        return row
      }
      const frag = document.createDocumentFragment()
      col.rows = build(frag)
      frag.appendChild(frag.cloneNode(true) as DocumentFragment)
      el.appendChild(frag)
      col.oneH = col.rows * LINE_H
      this.rowRange.push(ranges)
      this.colMaxChars.push(maxChars)
      this.rowChars.push(chars)
    })
  }

  private measure() {
    const probe = document.createElement('span')
    probe.className = 'crawl-probe'
    probe.textContent = '0123456789'
    document.body.appendChild(probe)
    const w = probe.getBoundingClientRect().width / 10
    if (w > 2) this.chW = w
    probe.remove()
  }

  setPointer(x: number, y: number) { this.tx = x; this.ty = y }

  resize() {
    this.svg.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`)
    const colW = Math.floor(innerWidth / COLS)
    this.cols.forEach((c, i) => { c.x = i * colW; c.w = colW; c.el.style.left = c.x + 'px'; c.el.style.width = colW + 'px' })
  }

  /* ---------------- 代码带：蜘蛛只能在这一带里行走 ---------------- */
  private sideOf(x: number) { return x < innerWidth / 2 ? 0 : 1 }
  private bandLeft(c: number) { return this.cols[c].x + GUTTER + 4 }
  /** 右界按【蜘蛛附近几行】的最长行算，而不是整列——否则会走到短行右侧的空白里 */
  private bandRight(c: number, yScreen: number) {
    const col = this.cols[c]
    const rc = this.rowChars[c]
    const cap = col.x + col.w - 6
    if (!rc || !rc.length) return Math.min(cap, col.x + GUTTER + this.colMaxChars[c] * this.chW + 18)
    const row = this.rowAt(yScreen, c)
    let m = 0
    for (let r = row - 4; r <= row + 4; r++) {
      const idx = ((r % rc.length) + rc.length) % rc.length
      if (rc[idx] > m) m = rc[idx]
    }
    return Math.min(cap, col.x + GUTTER + m * this.chW + 22)
  }
  private clampToBand(x: number, y: number) {
    const c = this.sideOf(x)
    const left = this.bandLeft(c)
    const right = Math.max(left + 40, this.bandRight(c, y))
    return {
      x: Math.min(Math.max(x, left), right),
      y: Math.min(Math.max(y, 26), innerHeight - 18),
    }
  }

  private pos(t: Tok) {
    const c = this.cols[t.col]
    return {
      x: (c?.x ?? 0) + GUTTER + t.ch * this.chW + t.len * this.chW * 0.5,
      y: ((t.line * LINE_H + LINE_H / 2) % (c?.oneH || 1)) - (c?.offset ?? 0),
    }
  }

  /** token → DOM 元素。行内的 `code` 元素按行缓存，避免每次 querySelector + Array.from */
  private codeCache: Array<Array<HTMLElement | null>> = []
  private els(t: Tok): HTMLElement[] {
    const c = this.cols[t.col]
    if (!c) return EMPTY_ELS
    const out: HTMLElement[] = []
    for (let b = 0; b < 2; b++) {
      const idx = b * c.rows + t.line
      const rowEl = c.el.children[idx] as HTMLElement | undefined
      if (!rowEl) continue
      let code = this.codeCache[t.col]?.[idx]
      if (code === undefined) {
        code = rowEl.querySelector('code') as HTMLElement | null
        ;(this.codeCache[t.col] ??= [])[idx] = code
      }
      if (!code) continue
      let acc = 0
      // 用 nextSibling 走链，避免 Array.from 每次分配数组
      for (let node = code.firstChild; node; node = node.nextSibling) {
        const el = node as HTMLElement
        const len = node.nodeType === 3 ? (node.textContent ?? '').length : (node.textContent ?? '').length
        if (t.ch >= acc && t.ch < acc + len && el.tagName === 'I') { out.push(el); break }
        acc += len
      }
    }
    return out
  }

  /** 只扫描 [rowFrom,rowTo] 行内的 token（性能关键）；行号按整份内容行数回绕 */
  private scanRows(colIdx: number, rowFrom: number, rowTo: number, fn: (i: number) => void) {
    const ranges = this.rowRange[colIdx]
    if (!ranges || !ranges.length) return
    const n = ranges.length
    for (let r = rowFrom; r <= rowTo; r++) {
      const rr = ((r % n) + n) % n
      const [s, e] = ranges[rr]
      for (let i = s; i < e; i++) fn(i)
    }
  }

  /** 屏幕 y → 内容行号（必须对 oneH 取模：offset 与 y 相加后常超过一份内容的高度） */
  private rowAt(yScreen: number, colIdx: number) {
    const col = this.cols[colIdx]
    const h = col.oneH || 1
    const yc = yScreen + col.offset
    return Math.floor((((yc % h) + h) % h) / LINE_H)
  }

  /* ---------------- 目标（只吃变量） ---------------- */
  private pickTarget() {
    const mySide = this.sideOf(this.sx)
    const jitter = Math.random() * 70        // 一点点随机，避免总咬最近那个而原地抽搐
    let best: { d: number; i: number; x: number; y: number } | null = null
    let other: { d: number; i: number; x: number; y: number } | null = null
    for (let c = 0; c < this.cols.length; c++) {
      const span = Math.ceil(560 / LINE_H)
      const centreRow = this.rowAt(this.sy, c)
      this.scanRows(c, centreRow - span, centreRow + span, (i) => {
        const t = this.toks[i]
        if (t.kind !== 'v' || this.eaten.has(i)) return
        const p = this.pos(t)
        if (p.y < 40 || p.y > innerHeight - 30) return
        if (p.x < this.bandLeft(t.col) || p.x > this.bandRight(t.col, p.y)) return
        const d = Math.hypot(p.x - this.sx, p.y - this.sy) + jitter
        if (d > 560) return
        const e = { d, i, x: p.x, y: p.y }
        if (c === mySide) { if (!best || d < best.d) best = e }
        else if (!other || d < other.d) other = e
      })
    }
    // 优先在自己这一侧觅食；本侧找不到才把目标放到对面，并准备吐丝飞过去
    const pick = best ?? other
    this.wantFly = !best && !!other
    this.target = pick ? { x: pick.x, y: pick.y, tok: pick.i } : null
    this.targetAge = 0
  }

  /** 吐丝飞行的落点：鼠标所在半屏里、离鼠标最近的 token */
  private pickFlyLanding(side: number) {
    const c = side
    const col = this.cols[c]
    let best: { d: number; i: number; x: number; y: number } | null = null
    const span = Math.ceil(innerHeight / LINE_H)
    const centreRow = this.rowAt(this.py, c)
    this.scanRows(c, centreRow - span, centreRow + span, (i) => {
      if (this.eaten.has(i) || (this.dropped.get(i) ?? 0) > performance.now()) return
      const p = this.pos(this.toks[i])
      if (p.y < 40 || p.y > innerHeight - 30) return
      if (p.x < this.bandLeft(c) || p.x > this.bandRight(c, p.y)) return
      const d = Math.hypot(p.x - this.px, p.y - this.py)
      if (!best || d < best.d) best = { d, i, x: p.x, y: p.y }
    })
    return best
  }

  private eat(i: number) {
    for (const el of this.els(this.toks[i])) {
      el.classList.add('eaten')
      setTimeout(() => el.classList.remove('eaten'), RESTORE_MS)
    }
    this.eaten.set(i, performance.now() + RESTORE_MS)
    this.eatenCount++
    if (this.toks[i].kind === 'v') this.varsHidden++
    // "吃腻了"计数：同一侧连吃够数，或待得够久，就换到对面
    const side = this.sideOf(this.sx)
    if (side !== this.lastSide) { this.lastSide = side; this.sameSideEats = 0; this.sideTimer = 0 }
    this.sameSideEats++
    if (this.sameSideEats >= ROAM_EATS) this.roamWant = true
    this.flash = 1
    this.flashAt = { x: this.sx, y: this.sy }
  }

  private kick(i: number) {
    const t = this.toks[i]
    const p = this.pos(t)
    let dx = p.x - this.sx, dy = p.y - this.sy
    const len = Math.max(1, Math.hypot(dx, dy))
    dx /= len; dy /= len
    const mag = 130 + Math.random() * 190
    for (const el of this.els(t)) {
      el.style.setProperty('--kx', `${(dx * mag + (Math.random() - 0.5) * 70).toFixed(0)}px`)
      el.style.setProperty('--kr', `${(Math.random() * 620 - 310).toFixed(0)}deg`)
      el.classList.remove('pressed')
      el.classList.add('kicked')
      // 动画一结束就摘类（数据仍保留 RESTORE_MS，到点才重新长出来）
      setTimeout(() => el.classList.remove('kicked'), KICK_ANIM_MS)
    }
    this.dropped.set(i, performance.now() + RESTORE_MS)
    this.droppedCount++
    if (t.kind === 'v') this.varsHidden++
    void dy
  }

  /** 落点搜索：评分 = |腿长 − 理想 R|
   *  strict=true → 【硬约束】不许踩别的腿已占的 token（默认走这一档）
   *  strict=false → 允许共踩（万不得已时的最后一档，避免"没地方就狂跳"） */
  private findLandingAt(hip: { x: number; y: number }, occupied: Set<number> | null,
                        lo: number, hi: number, strict: boolean) {
    const minR = LEG_R * lo, maxR = LEG_R * hi
    let best: { d: number; i: number; x: number; y: number; dh: number } | null = null
    for (let c = 0; c < this.cols.length; c++) {
      const span = Math.ceil(maxR / LINE_H) + 1
      const centreRow = this.rowAt(hip.y, c)
      this.scanRows(c, centreRow - span, centreRow + span, (k) => {
        if (occupied && occupied.has(k)) {
          if (strict) return
        }
        if (this.eaten.has(k) || (this.dropped.get(k) ?? 0) > performance.now()) return
        const p = this.pos(this.toks[k])
        if (p.y < 30 || p.y > innerHeight - 20) return
        if (p.x < this.bandLeft(c) || p.x > this.bandRight(c, p.y)) return
        const dh = Math.hypot(p.x - hip.x, p.y - hip.y)
        if (dh < minR || dh > maxR) return
        const score = Math.abs(dh - LEG_R) + (occupied && occupied.has(k) ? SHARE_PENALTY : 0)
        if (!best || score < best.d) best = { d: score, i: k, x: p.x, y: p.y, dh }
      })
    }
    return best
  }

  /** 独占优先的三档搜索：窄 → 宽 → 允许共踩 */
  private searchLanding(hip: { x: number; y: number }, occupied: Set<number> | null) {
    return this.findLandingAt(hip, occupied, STEP_OUT, STEP_MAX, true)
      ?? this.findLandingAt(hip, occupied, STEP_OUT_WIDE, STEP_MAX_WIDE, true)
      ?? this.findLandingAt(hip, occupied, STEP_OUT_WIDE, STEP_MAX_WIDE, false)
  }

  /** 把身体放在 (x,y) 时，八条腿里能有几条找到落点（用于挑起跳目的地） */
  private plantScoreAt(x: number, y: number) {
    let n = 0
    for (let i = 0; i < 8; i++) {
      const a = this.heading + (i < 4 ? -1 : 1) * (LEG_ANG[i % 4] * Math.PI) / 180
      const hip = { x: x + Math.cos(a) * HIP_R, y: y + Math.sin(a) * HIP_R }
      if (this.findLandingAt(hip, null, STEP_OUT_WIDE, STEP_MAX_WIDE, false)) n++
    }
    return n
  }

  /** 找一处"能踩住"的代码块作为起跳/飞行目的地。
   *  注意：必须只在【当前可视行】里采样 —— 在整份内容里等距抽样的话，屏内候选几乎是 0 */
  private findJumpSpot(side?: number) {
    let best: { score: number; x: number; y: number; tok: number } | null = null
    for (let c = 0; c < this.cols.length; c++) {
      if (side != null && c !== side) continue
      const r0 = this.rowAt(0, c)
      const rows = this.rowRange[c]
      if (!rows || !rows.length) continue
      const visible = Math.ceil(innerHeight / LINE_H) + 2
      for (let r = r0; r <= r0 + visible; r++) {
        const rr = ((r % rows.length) + rows.length) % rows.length
        const [s, e] = rows[rr]
        for (let i = s; i < e; i += 3) {
          if (this.eaten.has(i) || (this.dropped.get(i) ?? 0) > performance.now()) continue
          const p = this.pos(this.toks[i])
          if (p.y < 60 || p.y > innerHeight - 50) continue
          if (p.x < this.bandLeft(c) || p.x > this.bandRight(c, p.y)) continue
          const d = Math.hypot(p.x - this.sx, p.y - this.sy)
          if (d < 90 || d > 900) continue
          const plants = this.plantScoreAt(p.x, p.y)
          if (plants < 6) continue
          const score = plants * 40 - d * 0.12
          if (!best || score > best.score) best = { score, x: p.x, y: p.y, tok: i }
        }
      }
    }
    return best
  }

  /** 立即起跳（无落脚点时的应急动作，也用于主动换区） */
  private doJump(silk: boolean, side?: number) {
    const spot = this.findJumpSpot(side)
    if (!spot) return false
    const mid = { x: (this.sx + spot.x) / 2, y: Math.min(this.sy, spot.y) - (silk ? 90 : 42) }
    this.flight = { t: 0, dur: silk ? 1.15 : JUMP_DUR, from: { x: this.sx, y: this.sy }, to: { x: spot.x, y: spot.y }, ctrl: mid, tok: spot.tok, silk }
    if (silk) { this.flyCool = FLY_COOL; this.flights++ } else { this.jumps++ }
    return true
  }

  /** 把八条腿直接种到 (x,y) 周围的代码上 */
  private plantFeetAt(x: number, y: number) {
    const occupied = new Set<number>()
    const ox = this.sx, oy = this.sy
    this.sx = x; this.sy = y
    this.feet.forEach((f, i) => {
      // 同样走"独占优先"的三档搜索：先窄带独占，再宽带独占，最后才允许共踩
      const land = this.searchLanding(this.hipPos(i), occupied)
      if (land) {
        f.x = land.x; f.y = land.y; f.tx = land.x; f.ty = land.y; f.tok = land.i
        occupied.add(land.i)
        for (const el of this.els(this.toks[land.i])) el.classList.add('pressed')
      } else {
        const r = this.idealRest(i)
        f.x = r.x; f.y = r.y; f.tx = r.x; f.ty = r.y; f.tok = null
      }
      f.step = 0; f.cool = 0.12
    })
    void ox; void oy
  }

  /** curDh：当前腿长（已有落点时给）。换踩若不能明显改善腿长，就不动 —— 防原地反复触发 */
  private startStep(f: Foot, i: number, occupied: Set<number>, curDh: number | null = null): boolean {
    const hip = this.hipPos(i)
    const land = this.searchLanding(hip, occupied)
    // 连允许共踩都找不到 → 不抬脚，由调用方决定是否【起跳】
    if (!land) return false
    if (curDh != null && Math.abs(land.dh - LEG_R) > Math.abs(curDh - LEG_R) - 5) return false
    if (f.tok != null) {
      occupied.delete(f.tok)
      const prev = f.tok
      for (const el of this.els(this.toks[prev])) el.classList.remove('pressed')
      if (Math.random() < DROP_CHANCE && this.dropCool <= 0) {
        this.dropCool = DROP_COOLDOWN
        this.kick(prev)
      }
      f.tok = null
    }
    f.tx = land.x; f.ty = land.y; f.tok = land.i; occupied.add(land.i)
    f.step = 1
    f.cool = 0.1
    f.planted = performance.now()
    return true
  }

  /* ---------------- 运动：走（限在代码带内）+ 吐丝飞越 ---------------- */
  private stepSpider(dt: number) {
    this.startup = Math.max(0, this.startup - dt)
    // 换区计时：在同一侧待太久也算"吃腻"
    if (this.sideOf(this.sx) !== this.lastSide) { this.lastSide = this.sideOf(this.sx); this.sideTimer = 0 }
    this.sideTimer += dt
    if (this.sideTimer > ROAM_SECONDS) this.roamWant = true
    // 本侧吃完了 / 吃腻了换区 → 吐丝飞到对面那一段代码上
    this.flyCool = Math.max(0, this.flyCool - dt)
    if (!this.flight && this.flyCool <= 0 && (this.wantFly || this.roamWant)) {
      const side = this.wantFly ? null : (1 - this.sideOf(this.sx))   // 吃腻了就指定去对面
      if (this.doJump(true, side ?? undefined)) {
        this.wantFly = false; this.roamWant = false
        this.sameSideEats = 0; this.sideTimer = 0
      } else if (this.wantFly) {
        this.wantFly = false        // 暂且作罢，下次再试
      } else {
        this.roamWant = false
      }
    }

    if (this.flight) {
      const F = this.flight
      F.t += dt
      const p = Math.min(1, F.t / F.dur)
      const e = p * p * (3 - 2 * p)
      const u = 1 - e
      this.sx = u * u * F.from.x + 2 * u * e * F.ctrl.x + e * e * F.to.x
      this.sy = u * u * F.from.y + 2 * u * e * F.ctrl.y + e * e * F.to.y
      this.vx = 0; this.vy = 0
      const ang = Math.atan2(F.to.y - F.from.y, F.to.x - F.from.x)
      this.heading += (ang - this.heading) * Math.min(1, dt * 4)
      // 腿收起（贴住身体）
      this.feet.forEach((f, i) => {
        const r = this.idealRest(i)
        f.x += (r.x - f.x) * Math.min(1, dt * 10)
        f.y += (r.y - f.y) * Math.min(1, dt * 10)
        f.step = 0
      })
      if (F.silk) {
        this.silkEl.setAttribute('points', `${F.from.x.toFixed(1)},${F.from.y.toFixed(1)} ${this.sx.toFixed(1)},${this.sy.toFixed(1)}`)
        this.silkEl.setAttribute('opacity', '0.75')
      } else {
        this.silkEl.setAttribute('opacity', '0')
      }
      if (p >= 1) {
        // 着陆：身体【正落在 token 上】；清掉旧侧的落点，八足归位到新位置周围，
        // 再由步态把脚一条条重新踩到附近的代码上（否则旧脚会横跨半个屏幕）
        for (const f of this.feet) {
          if (f.tok != null) {
            for (const el of this.els(this.toks[f.tok])) el.classList.remove('pressed')
            f.tok = null
          }
          f.step = 0; f.cool = 0.14
        }
        this.sx = F.to.x; this.sy = F.to.y
        this.feet.forEach((f, i) => {
          const r = this.idealRest(i)
          f.x = r.x; f.y = r.y; f.tx = r.x; f.ty = r.y
        })
        if (F.tok != null) {
          for (const el of this.els(this.toks[F.tok])) el.classList.add('pressed')
          this.feet[0].tok = F.tok
          this.feet[0].x = F.to.x; this.feet[0].y = F.to.y
        }
        this.flight = null
        this.target = null
        this.targetAge = 99
        this.gaitDist = 0
        this.silkEl.setAttribute('opacity', '0')
        this.trail.length = 0
      }
      return
    }

    // 常规行走：目标每 0.45s 重评一次（否则会一路走向过期目标，看起来完全不跟鼠标）
    this.targetAge += dt
    if (!this.target || this.targetAge > 0.45 || (this.target.tok != null && this.eaten.has(this.target.tok))) this.pickTarget()
    const tgt = this.target
    if (tgt) {
      const dx = tgt.x - this.sx, dy = tgt.y - this.sy
      const dist = Math.hypot(dx, dy)
      if (dist > 6) {
        this.vx += (((dx / dist) * 88) - this.vx) * Math.min(1, dt * 5)
        this.vy += (((dy / dist) * 88) - this.vy) * Math.min(1, dt * 5)
      } else {
        this.vx *= 0.82; this.vy *= 0.82
        if (tgt.tok != null && !this.eaten.has(tgt.tok)) { this.eat(tgt.tok); this.target = null }
      }
    } else {
      this.vx *= 0.9; this.vy *= 0.9
    }
    const rawX = this.sx + this.vx * dt
    const rawY = this.sy + this.vy * dt
    const cl = this.clampToBand(rawX, rawY)
    const step0x = cl.x - this.sx, step0y = cl.y - this.sy
    this.sx = cl.x; this.sy = cl.y
    const sp = Math.hypot(this.vx, this.vy)
    if (sp > 6) {
      const want = Math.atan2(this.vy, this.vx)
      let d = want - this.heading
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      this.heading += d * Math.min(1, dt * 7)
    }
    if (sp > 14) {
      this.trail.push({ x: this.sx, y: this.sy })
      if (this.trail.length > 22) this.trail.shift()
      this.idleT = 0
    } else {
      this.idleT += dt
      if (this.idleT > 0.6 && this.trail.length) this.trail.shift()
    }

    // 交替四足步态
    this.gaitDist += Math.hypot(step0x, step0y)
    this.gaitTimer = Math.max(0, this.gaitTimer - dt)
    if (this.gaitDist > STRIDE && this.gaitTimer <= 0) {
      this.gaitDist = 0
      this.gaitSet = 1 - this.gaitSet
      this.gaitTimer = 0.42
      GAIT[this.gaitSet].forEach((li, k) => this.queue.push({ li, at: k * 0.05 }))
    }
    if (this.queue.length) {
      for (const q of this.queue) q.at -= dt
      const due = this.queue.filter(q => q.at <= 0)
      if (due.length) {
        this.queue = this.queue.filter(q => q.at > 0)
        const occupied = new Set<number>()
        for (const f of this.feet) if (f.tok != null) occupied.add(f.tok)
        for (const q of due) {
          const f = this.feet[q.li]
          if (f.step <= 0 && f.cool <= 0) this.startStep(f, q.li, occupied)
        }
      }
    }

    let needJump = false
    this.feet.forEach((f, i) => {
      f.cool = Math.max(0, f.cool - dt)
      if (f.step <= 0 && f.tok != null) {
        const t = this.toks[f.tok]
        const alive = t && !this.eaten.has(f.tok) && !((this.dropped.get(f.tok) ?? 0) > performance.now())
        if (alive) { const p = this.pos(t); f.x = p.x; f.y = p.y }
        else f.tok = null
      }
      const hip = this.hipPos(i)
      const legLen = Math.hypot(f.x - hip.x, f.y - hip.y)
      const off = Math.abs(legLen - LEG_R) / LEG_R
      // 需要换踩的两种情况：脚下没东西（可能踩空），或腿长偏离理想值超限
      if (f.step <= 0 && f.cool <= 0 && (f.tok == null || off > LEG_LIMIT)) {
        const occupied = new Set<number>()
        for (const g of this.feet) if (g.tok != null) occupied.add(g.tok)
        const curDh = f.tok != null ? legLen : null
        const moved = this.startStep(f, i, occupied, curDh)
        // 只有"根本没踩住"才起跳；已踩住但换不到更好的位置就原地不动
        if (!moved && f.tok == null) needJump = true
      }
      if (f.step > 0) {
        f.step -= dt / STEP_DUR
        const p = 1 - Math.max(0, f.step)
        const ease = p * p * (3 - 2 * p)
        f.x += (f.tx - f.x) * ease * 0.55
        f.y += (f.ty - f.y) * ease * 0.55
        if (f.step <= 0) {
          f.x = f.tx; f.y = f.ty
          if (f.tok != null) for (const el of this.els(this.toks[f.tok])) el.classList.add('pressed')
        }
      }
    })
    // 一旦没有落脚点 → 立即起跳（跳到另一处能踩住的代码上）
    if (needJump && !this.flight && this.startup <= 0) this.doJump(false)
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.2)
    this.dropCool = Math.max(0, this.dropCool - dt)
  }

  draw(dt: number) {
    const now = performance.now()
    this.fps = this.fps * 0.9 + (1000 / Math.max(1, now - this.last)) * 0.1
    this.last = now
    const want = document.body.dataset.act === '3'
    if (want !== this.on) {
      this.on = want
      this.root.style.opacity = want ? '1' : '0'
      if (want) {
        // 进来：先解除渲染跳过；再稍等一下才淡入 —— 让首次栅格化发生在幕布还黑着的时候，
        // 视觉上就被"背景变黑"盖过去了，不会看到卡顿
        if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = 0 }
        this.root.classList.add('on')
        this.root.style.opacity = '0'
        // 分块揭示：一次性把 2600 行 / 1 万个 inline-block 解除渲染跳过，
        // 会在单个任务里做完整层布局+绘制（可见的顿挫）。两列错开各 90ms，摊到不同帧。
        this.cols.forEach((c, i) => {
          c.el.style.contentVisibility = 'hidden'
          window.setTimeout(() => { c.el.style.contentVisibility = 'visible' }, i * 90)
        })
        window.setTimeout(() => { if (this.on) this.root.style.opacity = '1' }, 260)
      } else {
        // 离开：等淡出结束再跳过渲染（否则看不到淡出）
        if (this.hideTimer) clearTimeout(this.hideTimer)
        this.hideTimer = window.setTimeout(() => { if (!this.on) this.root.classList.remove('on') }, 700)
      }
    }
    this.px += (this.tx - this.px) * Math.min(1, dt * 6)
    this.py += (this.ty - this.py) * Math.min(1, dt * 6)
    if (!want) return
    for (const c of this.cols) {
      c.offset = (c.offset + c.speed * dt) % c.oneH
      c.el.style.transform = `translate3d(0, ${(-c.offset).toFixed(2)}px, 0)`
    }
    for (const [i, until] of this.eaten) if (until < now) { this.eaten.delete(i); if (this.toks[i].kind === 'v') this.varsHidden-- }
    for (const [i, until] of this.dropped) if (until < now) { this.dropped.delete(i); if (this.toks[i].kind === 'v') this.varsHidden-- }
    this.stepSpider(dt)
    this.paint()
  }

  private paint() {
    this.body.setAttribute('cx', String(this.sx)); this.body.setAttribute('cy', String(this.sy))
    this.feet.forEach((f, i) => {
      const hip = this.hipPos(i)
      const knee = this.kneePos(i, hip, f)
      // 不用 toFixed：每帧 8 腿 × ~8 次格式化 = 约 50 个临时字符串；直接字符串化即可
      this.legs[i].setAttribute('points', `${hip.x},${hip.y} ${knee.x},${knee.y} ${f.x},${f.y}`)
      this.hips[i].setAttribute('cx', String(hip.x)); this.hips[i].setAttribute('cy', String(hip.y))
      this.knees[i].setAttribute('cx', String(knee.x)); this.knees[i].setAttribute('cy', String(knee.y))
      this.footDots[i].setAttribute('cx', String(f.x)); this.footDots[i].setAttribute('cy', String(f.y))
      const cls = f.tok != null ? 'sp-foot on' : 'sp-foot'
      // class 写入会触发该节点的样式重算 → 只在真的变化时才写
      if (this.footDots[i].getAttribute('class') !== cls) this.footDots[i].setAttribute('class', cls)
    })
    let pts = ''
    for (const p of this.trail) pts += `${p.x},${p.y} `
    this.trailEl.setAttribute('points', pts)
    if (this.flash > 0) {
      this.ring.setAttribute('cx', String(this.flashAt.x)); this.ring.setAttribute('cy', String(this.flashAt.y))
      this.ring.setAttribute('r', String(6 + (1 - this.flash) * 22))
      this.ring.setAttribute('opacity', String(this.flash * 0.8))
    } else if (this.ring.getAttribute('opacity') !== '0') {
      this.ring.setAttribute('opacity', '0')
    }
  }

  stats(): CrawlStats {
    // O(1)：用增量计数，不再每帧遍历 3 万个 token
    return {
      eaten: this.eatenCount, dropped: this.droppedCount,
      left: Math.max(0, this.varsTotal - this.varsHidden),
      flights: this.flights, jumps: this.jumps, flying: !!this.flight,
      fps: Math.round(this.fps),
    }
  }
}
