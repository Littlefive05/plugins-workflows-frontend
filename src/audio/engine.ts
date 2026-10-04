// SERIES 0x2B — 音频引擎
//  · BED  次轨：全站背景，无缝循环，常驻播放
//  · MAIN 主轨：仅磁带触发时播放（从 0 开始）
//  · 压低：磁带启动 → BED 增益下降 + 低通闭合（“伪装渐出”，但音乐不停、原位继续）
//          磁带关闭 → BED 原位渐入 + 低通打开
//  · 音效：Web Audio 参数化合成。逐声随机化（频率/滤波/Q/时长/包络），
//          因此同类音效不会重复；刻意不使用脉冲/方波哔声（用户明确否决）。
//  · 主轨：共 4 条【完整曲目，有头有尾】，可在运行中交叉淡化切换（selectTrack）。
//          切换 = 0.4s 交叉淡化 + 一声机械剪接音效（sfx('reel')）。
//          素材由 ComfyUI 生成后按下面的命名约定落盘；在那之前页面也必须能用，
//          所以加载是【逐条容错】的：缺哪条就跳过哪条，trackCount 只数真正加载成功的。
export type SfxName = 'click' | 'load' | 'head' | 'paper' | 'reel' | 'type' | 'switch' | 'stop'

const BED_URL = '/assets/audio/bed.mp3'
// 主轨 4 条，命名约定固定：索引 i（0..3）↔ main-0(i+1).mp3，顺序即播放顺序。
// 音乐产出后只需把这 4 个文件放到位，本文件不需要改。
const MAIN_URLS = [
  '/assets/audio/main-01.mp3',
  '/assets/audio/main-02.mp3',
  '/assets/audio/main-03.mp3',
  '/assets/audio/main-04.mp3',
] as const

/** 主轨【声明】条数 = 4。素材清单长度，与当前成功加载了几条无关。
 *  前端要渲染 4 个固定按钮时用这个；要"当前有几条真能播"用 engine.trackCount。 */
export const MAIN_TRACK_COUNT = MAIN_URLS.length

export class AudioEngine {
  ctx!: AudioContext
  private bedBuf?: AudioBuffer
  // 主轨缓冲。长度固定 = 声明条数；某条没素材/解码失败则留 undefined。
  // 为什么不用"压缩过的数组"：索引必须稳定对应 main-0N.mp3，
  // 否则前端的第 3 个按钮会莫名其妙去播第 4 条。
  private mainBufs: (AudioBuffer | undefined)[] = new Array(MAIN_URLS.length).fill(undefined)
  private bedSrc?: AudioBufferSourceNode
  private mainSrc?: AudioBufferSourceNode
  // 当前主轨源【私有】的增益节点，只有一个用途：交叉淡化时把【旧源】独立淡出。
  // 为什么需要它：mainGain 是主轨【总线】，旧源和新源都挂在这条总线上，
  // 直接去动 mainGain 会把两条一起淡掉，那就成了"淡出再淡入"而不是交叉淡化。
  // 两个增益相乘（mainGain × mainSrcGain）→ 总线保留原语义，单源可独立包络。
  private mainSrcGain?: GainNode
  // 已选主轨索引（0..3）。读作"下一次 engageTape 会用哪条"。
  // 注意它【不被素材缺失改写】：素材晚到（ComfyUI 生成完刷新页面）时选择依然有效。
  private selTrack = 0

  // 这五个是构造期才拿到真实 GainNode 的对外引用（节点图要等 arm() 建）。
  // 用 declare：只声明类型、不产出 JS 字段初始化，避免与构造器里的赋值冲突。
  // 原来写的是 readonly，但 readonly + 构造器赋值会被 tsc 判成 TS2540（那 5 个既有类型错误）；
  // 这里去掉 readonly 修饰符：外部依然只能读（没有 setter、也没有别处赋值），语义不变。
  declare bedGain: GainNode
  declare mainGain: GainNode
  declare sfxBus: GainNode
  declare hissGain: GainNode
  declare whirGain: GainNode

  private bedLp!: BiquadFilterNode
  private mainAnalyser!: AnalyserNode
  private bedAnalyser!: AnalyserNode
  private hiss?: { src: AudioBufferSourceNode; lp: BiquadFilterNode }
  private whir?: { osc: OscillatorNode; lfo: OscillatorNode; g: GainNode }
  private noiseBuf?: AudioBuffer

  armed = false
  tapeEngaged = false
  private master: GainNode

  constructor() {
    // 先建好节点图（不启动 AudioContext，等用户手势）
    // 这里用一个延迟初始化的占位：真正的 ctx 在 arm() 中创建
    this.master = null as unknown as GainNode
    this.bedGain = null as unknown as GainNode
    this.mainGain = null as unknown as GainNode
    this.sfxBus = null as unknown as GainNode
    this.hissGain = null as unknown as GainNode
    this.whirGain = null as unknown as GainNode
  }

  async arm() {
    if (this.armed) return
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    this.ctx = ctx

    this.master = ctx.createGain()
    this.master.gain.value = 0.9
    this.master.connect(ctx.destination)

    // BED 链：src → gain → lowpass → analyser → master
    this.bedGain = ctx.createGain()
    this.bedGain.gain.value = 0.42
    this.bedLp = ctx.createBiquadFilter()
    this.bedLp.type = 'lowpass'
    this.bedLp.frequency.value = 16000
    this.bedLp.Q.value = 0.4
    this.bedAnalyser = ctx.createAnalyser()
    this.bedAnalyser.fftSize = 1024
    this.bedGain.connect(this.bedLp)
    this.bedLp.connect(this.bedAnalyser)
    this.bedAnalyser.connect(this.master)

    // MAIN 链
    this.mainGain = ctx.createGain()
    this.mainGain.gain.value = 0
    this.mainAnalyser = ctx.createAnalyser()
    this.mainAnalyser.fftSize = 1024
    this.mainGain.connect(this.mainAnalyser)
    this.mainAnalyser.connect(this.master)

    // 音效总线
    this.sfxBus = ctx.createGain()
    this.sfxBus.gain.value = 0.5
    this.sfxBus.connect(this.master)

    // 底噪（磁带走带嘶声）/ 机械低鸣
    this.hissGain = ctx.createGain(); this.hissGain.gain.value = 0
    this.whirGain = ctx.createGain(); this.whirGain.gain.value = 0
    this.hissGain.connect(this.master)
    this.whirGain.connect(this.master)

    // 解码音频
    const load = async (url: string) => {
      const r = await fetch(url)
      const ab = await r.arrayBuffer()
      return await ctx.decodeAudioData(ab)
    }
    // BED + 4 条主轨【并行】加载（沿用原有 load() 与 Promise.all 的并行思路）。
    // 改动原因（原来是一次性 Promise.all([bed, main])，任一条失败就两条全丢）：
    //   1) 4 条主轨是同一批占位素材，必须并行发请求，否则首屏会被串行放大 4 倍；
    //   2) 用 allSettled 做降级：BED 与 MAIN 各自独立成败，
    //      某条主轨 404/解码失败只让它自己缺席，BED 照播、其他主轨照可选。
    //      绝不把 BED 一起拖下水 —— BED 是全站常驻背景，它静音等于整站静音。
    const [bedR, ...mainRs] = await Promise.allSettled([
      load(BED_URL),
      ...MAIN_URLS.map((u) => load(u)),
    ])

    if (bedR.status === 'fulfilled') {
      this.bedBuf = bedR.value
    } else {
      console.warn('[audio] BED 次轨解码失败（本次将没有背景音）', bedR.reason)
    }

    this.mainBufs = mainRs.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      console.warn(`[audio] 主轨 main-${String(i + 1).padStart(2, '0')}.mp3 解码失败，该条降级缺席`, r.reason)
      return undefined
    })
    // 4 条主轨全部缺失（素材还没生成出来的当下就是这个状态）：
    // 只提示，绝不让 BED 或其他环节受影响 —— 页面照常跑，只是磁带里没有主轨音乐。
    const okMains = this.trackCount
    if (okMains === 0) {
      console.warn(`[audio] 4 条主轨均不可用（期望 ${MAIN_TRACK_COUNT} 条）；BED 与合成音效照常工作`)
    } else if (okMains < MAIN_TRACK_COUNT) {
      console.warn(`[audio] 主轨仅 ${okMains}/${MAIN_TRACK_COUNT} 条可用，缺失项会被跳过`)
    }
    // 刻意【不】在这里改写 selTrack：该条素材以后补上（刷新页面）时，用户的选择应当依然有效。

    // BED 起播（无缝循环）
    if (this.bedBuf) {
      const s = ctx.createBufferSource()
      s.buffer = this.bedBuf
      s.loop = true
      s.connect(this.bedGain)
      s.start()
      this.bedSrc = s
    }

    this.noiseBuf = this.makeNoise(ctx, 4)
    this.startHiss()
    this.startWhir()

    this.armed = true
    if (ctx.state === 'suspended') await ctx.resume()
  }

  private makeNoise(ctx: AudioContext, seconds: number) {
    const len = Math.floor(ctx.sampleRate * seconds)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      // 轻微低通化的噪声，避免刺耳
      const w = Math.random() * 2 - 1
      last = last * 0.72 + w * 0.28
      d[i] = last
    }
    return buf
  }

  private startHiss() {
    if (!this.noiseBuf) return
    const ctx = this.ctx
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'bandpass'
    lp.frequency.value = 5200
    lp.Q.value = 0.6
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 1400
    src.connect(hp); hp.connect(lp); lp.connect(this.hissGain)
    src.start()
    this.hiss = { src, lp }
  }

  private startWhir() {
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 42
    const g = ctx.createGain()
    g.gain.value = 1
    const lfo = ctx.createOscillator()
    lfo.type = 'sine'
    lfo.frequency.value = 5.6
    const lfoG = ctx.createGain()
    lfoG.gain.value = 5.5
    lfo.connect(lfoG); lfoG.connect(osc.frequency)
    osc.connect(g); g.connect(this.whirGain)
    osc.start(); lfo.start()
    this.whir = { osc, lfo, g }
  }

  /** 磁带启动：次轨【先渐变静音】，静音完成后主轨才渐入（全部用音频时钟排程，精确无漂移）
   *  次轨的源不停 → 位置保留，回来时原位续接 */
  engageTape() {
    if (!this.armed || this.tapeEngaged) return
    this.tapeEngaged = true
    const ctx = this.ctx, now = ctx.currentTime
    const BED_OUT = 1.6            // 次轨淡到完全静音所需
    const MAIN_IN = 0.9            // 主轨渐入时长
    const t0 = now + BED_OUT + 0.05   // 主轨起播点：次轨静音之后

    // 1) 次轨渐变静音（不是压低，是一路淡到 0；源继续走，位置不变）
    this.bedGain.gain.cancelScheduledValues(now)
    this.bedGain.gain.setValueAtTime(this.bedGain.gain.value, now)
    this.bedGain.gain.linearRampToValueAtTime(0, now + BED_OUT)
    this.bedLp.frequency.cancelScheduledValues(now)
    this.bedLp.frequency.setValueAtTime(this.bedLp.frequency.value, now)
    this.bedLp.frequency.exponentialRampToValueAtTime(600, now + BED_OUT)

    // 2) 主轨：源排程在 t0 起播，增益从 t0 才开始爬升 → 次轨没静音之前听不到主轨
    //    改动：起播的是【当前选中的那条】主轨（selectTrack 在未 engage 时只记索引，
    //    到这里才真正被采用 —— 这是"先选后按磁带"路径的落地点）。
    this.mainSrc = this.spawnMain(t0)
    this.mainGain.gain.cancelScheduledValues(now)
    this.mainGain.gain.setValueAtTime(0, now)
    this.mainGain.gain.setValueAtTime(0, t0)
    this.mainGain.gain.linearRampToValueAtTime(0.62, t0 + MAIN_IN)

    // 走带嘶声与低鸣：与主轨一起进
    this.hissGain.gain.cancelScheduledValues(now)
    this.hissGain.gain.setValueAtTime(this.hissGain.gain.value, now)
    this.hissGain.gain.linearRampToValueAtTime(0, t0)
    this.hissGain.gain.linearRampToValueAtTime(0.05, t0 + MAIN_IN)
    this.whirGain.gain.cancelScheduledValues(now)
    this.whirGain.gain.setValueAtTime(this.whirGain.gain.value, now)
    this.whirGain.gain.linearRampToValueAtTime(0, t0)
    this.whirGain.gain.linearRampToValueAtTime(0.16, t0 + MAIN_IN)

    this.sfx('load')
    this.sfx('head')
  }

  /** 磁带停止：主轨【先渐出到静音】，静音完成后次轨才原位渐入 */
  disengageTape() {
    if (!this.armed || !this.tapeEngaged) return
    this.tapeEngaged = false
    const ctx = this.ctx, now = ctx.currentTime
    const MAIN_OUT = 0.7
    const BED_IN = 1.5
    const t0 = now + MAIN_OUT + 0.05

    // 1) 主轨渐出，到 0 后再停源
    //    这里刻意【只动总线 mainGain】，不再单独动 mainSrcGain：
    //    总线到 0 已经把整条主轨压死，源再挂一会儿也听不见 → 与原来行为完全一致，
    //    交叉淡化那套私有增益不参与"退场"时序，避免两套包络互相干扰。
    this.mainGain.gain.cancelScheduledValues(now)
    this.mainGain.gain.setValueAtTime(this.mainGain.gain.value, now)
    this.mainGain.gain.linearRampToValueAtTime(0, now + MAIN_OUT)
    const src = this.mainSrc
    if (src) setTimeout(() => { try { src.stop() } catch { /* noop */ } }, (MAIN_OUT + 0.2) * 1000)
    this.mainSrc = undefined
    this.mainSrcGain = undefined

    // 2) 次轨：先确保在 t0 时刻已是 0，再由 t0 原位渐入
    this.bedGain.gain.cancelScheduledValues(now)
    this.bedGain.gain.setValueAtTime(this.bedGain.gain.value, now)
    this.bedGain.gain.linearRampToValueAtTime(0, t0)
    this.bedGain.gain.linearRampToValueAtTime(0.42, t0 + BED_IN)
    this.bedLp.frequency.cancelScheduledValues(now)
    this.bedLp.frequency.setValueAtTime(this.bedLp.frequency.value, now)
    this.bedLp.frequency.exponentialRampToValueAtTime(16000, t0 + BED_IN)

    // 走带噪声随主轨一起停
    this.hissGain.gain.cancelScheduledValues(now)
    this.hissGain.gain.setValueAtTime(this.hissGain.gain.value, now)
    this.hissGain.gain.linearRampToValueAtTime(0, now + MAIN_OUT)
    this.whirGain.gain.cancelScheduledValues(now)
    this.whirGain.gain.setValueAtTime(this.whirGain.gain.value, now)
    this.whirGain.gain.linearRampToValueAtTime(0, now + MAIN_OUT)

    this.sfx('head')
    this.sfx('stop')
  }

  /** 全停（传输条 STOP）：主轨与次轨【一起】淡到静音。
   *  注意这与 disengageTape 不同 —— 那个是"交接回次轨"，这个是"整机停机"。 */
  stopAll() {
    if (!this.armed) return
    const now = this.ctx.currentTime
    const out = (g: GainNode, dur: number) => {
      g.gain.cancelScheduledValues(now)
      g.gain.setValueAtTime(g.gain.value, now)
      g.gain.linearRampToValueAtTime(0, now + dur)
    }
    out(this.bedGain, 0.32)
    out(this.mainGain, 0.32)
    out(this.hissGain, 0.32)
    out(this.whirGain, 0.32)
    this.bedLp.frequency.cancelScheduledValues(now)
    this.bedLp.frequency.setValueAtTime(this.bedLp.frequency.value, now)
    this.bedLp.frequency.exponentialRampToValueAtTime(600, now + 0.32)
    const src = this.mainSrc
    if (src) setTimeout(() => { try { src.stop() } catch { /* noop */ } }, 420)
    this.mainSrc = undefined
    this.mainSrcGain = undefined
    this.tapeEngaged = false
  }

  /** 停止后再次播放：次轨原位渐入（位置从未改变） */
  resumeBed() {
    if (!this.armed) return
    const now = this.ctx.currentTime
    this.bedGain.gain.cancelScheduledValues(now)
    this.bedGain.gain.setValueAtTime(this.bedGain.gain.value, now)
    this.bedGain.gain.linearRampToValueAtTime(0.42, now + 0.8)
    this.bedLp.frequency.cancelScheduledValues(now)
    this.bedLp.frequency.setValueAtTime(this.bedLp.frequency.value, now)
    this.bedLp.frequency.exponentialRampToValueAtTime(16000, now + 0.8)
  }

  setBedVolume(v: number) {
    if (!this.armed) return
    const now = this.ctx.currentTime
    this.bedGain.gain.cancelScheduledValues(now)
    this.bedGain.gain.linearRampToValueAtTime(v, now + 0.4)
  }

  setMainVolume(v: number) {
    if (!this.armed || !this.tapeEngaged) return
    this.mainGain.gain.linearRampToValueAtTime(v, this.ctx.currentTime + 0.2)
  }

  /** 参数化音效：每次调用都重新掷参数 → 天然不重复；不用脉冲类 */
  sfx(name: SfxName) {
    if (!this.armed) return
    const ctx = this.ctx, now = ctx.currentTime
    const R = (a: number, b: number) => a + Math.random() * (b - a)
    const out = ctx.createGain()
    out.gain.value = R(0.5, 0.85)
    out.connect(this.sfxBus)

    const noise = (dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, gain: number) => {
      if (!this.noiseBuf) return
      const s = ctx.createBufferSource()
      s.buffer = this.noiseBuf
      s.playbackRate.value = R(0.9, 1.12)
      const bp = ctx.createBiquadFilter()
      bp.type = type
      bp.Q.value = q * R(0.8, 1.25)
      bp.frequency.setValueAtTime(f0 * R(0.9, 1.1), now)
      bp.frequency.exponentialRampToValueAtTime(f1, now + dur)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(gain, now + dur * 0.12)
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur)
      s.connect(bp); bp.connect(g); g.connect(out)
      s.start(now, Math.random() * 3, dur + 0.05)
    }

    const body = (type: OscillatorType, f0: number, f1: number, dur: number, gain: number) => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.setValueAtTime(f0 * R(0.94, 1.07), now)
      o.frequency.exponentialRampToValueAtTime(f1, now + dur)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(gain, now + dur * 0.1)
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur)
      o.connect(g); g.connect(out)
      o.start(now); o.stop(now + dur + 0.05)
    }

    switch (name) {
      case 'click':   // 按键：短促、木质
        noise(0.055, 'bandpass', R(1800, 2600), 700, 1.6, 0.32)
        body('triangle', R(190, 260), 90, 0.06, 0.16)
        break
      case 'switch':  // 拨动：更钝一点
        noise(0.09, 'bandpass', R(900, 1400), 380, 1.1, 0.3)
        body('sine', R(120, 165), 70, 0.11, 0.2)
        break
      case 'load':    // 装载磁带：塑料卡入 + 轻微弹簧
        noise(0.16, 'bandpass', R(500, 800), 220, 0.9, 0.34)
        body('triangle', R(95, 130), 58, 0.2, 0.22)
        setTimeout(() => noise(0.07, 'highpass', 2400, 1600, 0.7, 0.2), 120)
        break
      case 'head':    // 磁头贴合：闷响
        body('sine', R(70, 96), 44, 0.19, 0.3)
        noise(0.1, 'lowpass', 900, 260, 0.7, 0.24)
        break
      case 'stop':    // 停止：机械刹车
        noise(0.2, 'bandpass', 700, 180, 0.8, 0.28)
        body('triangle', 88, 52, 0.22, 0.2)
        break
      case 'reel':    // 卷轴转动的一小段
        noise(0.5, 'bandpass', 320, 260, 0.6, 0.14)
        break
      case 'paper':   // 纸页
        noise(0.34, 'highpass', R(2600, 3600), 1500, 0.5, 0.16)
        break
      case 'type':    // 打字机：极轻的敲击
        noise(0.03, 'bandpass', R(2200, 3400), 1200, 1.8, 0.14)
        break
    }
  }

  /** 起播【当前选中】那条主轨，返回源节点。
   *  源的增益走 mainSrcGain（交叉淡化专用），再汇入主轨总线 mainGain。
   *  单一职责：总线管"磁带整体的进/退"，私有增益管"两条主轨之间的交接"。 */
  private spawnMain(t0: number): AudioBufferSourceNode | undefined {
    const buf = this.mainBufs[this.selTrack]
    if (!buf) return undefined   // 该条缺素材 → 不发声，但绝不影响 BED 与其他主轨
    const ctx = this.ctx
    const s = ctx.createBufferSource()
    s.buffer = buf
    const g = ctx.createGain()
    g.gain.value = 1            // engage 时由总线负责 0→0.62，私有增益保持满开
    s.connect(g)
    g.connect(this.mainGain)
    s.start(t0)
    this.mainSrcGain = g
    return s
  }

  /** 当前【真正可用】的主轨条数 = 已成功解码的条数（0..4）。
   *  按契约：素材缺失时它小于 4，前端据此决定渲染几个可点按钮
   *  （素材还没生成出来时就是 0，页面照常工作、不静音、不报错）。 */
  get trackCount(): number {
    return this.mainBufs.reduce<number>((n, b) => (b ? n + 1 : n), 0)
  }

  /** 主轨【声明】条数（固定 4）：素材清单长度，与当前加载成功了几条无关。
   *  前端要"永远显示 4 个占位按钮（缺失的置灰）"时用这个。 */
  get declaredTrackCount(): number {
    return MAIN_TRACK_COUNT
  }

  /** 当前选中的主轨索引（只读）。未 engage 时它表示"下次会让磁带播哪条"。 */
  get selectedTrack(): number {
    return this.selTrack
  }

  /** 第 i 条主轨是否可用。 */
  trackAvailable(i: number): boolean {
    return !!this.mainBufs[i]
  }

  /** 第 i 条主轨的时长（秒）。该条缺素材或越界返回 0，方便前端直接判空。 */
  trackDuration(i: number): number {
    const b = this.mainBufs[i]
    return b ? b.duration : 0
  }

  /** 第一条可用的主轨索引；一条都没有时返回 -1。
   *  这是"缺素材时退回到已有的那条"的实现入口。 */
  private firstAvailableTrack(): number {
    return this.mainBufs.findIndex((b) => !!b)
  }

  /** 切主轨：交叉淡化 0.4s + 一声机械剪接音效。
   *  未 engage（磁带没在播）时只记录选择，等 engageTape() 用所选那条。 */
  selectTrack(i: number) {
    // 容错：非整数向下取整；越界钳制到【声明条数】范围内
    const n = MAIN_TRACK_COUNT
    const want = Number.isFinite(i) ? Math.min(n - 1, Math.max(0, Math.floor(i))) : this.selTrack
    if (want === this.selTrack) return

    // 目标条缺失（素材还没生成 / 解码失败）→ 不退化成静音，
    // 而是顺位到第一条可用主轨；一条都没有就只记住选择（等素材到了再刷新即可）。
    let next = want
    if (!this.mainBufs[next]) {
      const fallback = this.firstAvailableTrack()
      if (fallback < 0) {
        this.selTrack = next
        console.warn(`[audio] 请求主轨 ${next + 1}，但当前没有任何主轨素材可用；已记录选择，待素材就位`)
        this.sfx('reel')   // 按钮反馈照给，用户点了就有机械声
        return
      }
      next = fallback
    }
    this.selTrack = next
    // 机械剪接音效：用现成的 'reel'（卷轴/走带质感），不是脉冲/方波哔声。
    // 即使未 engage 也响 —— 用户点了按钮就该有机械反馈。
    this.sfx('reel')

    // 未 engage 或音频还没 arm：选择已记录，engageTape() 会用它，这里不做时序
    if (!this.armed || !this.tapeEngaged) return

    const ctx = this.ctx
    const now = ctx.currentTime
    const XFADE = 0.4
    const oldSrc = this.mainSrc
    const oldGain = this.mainSrcGain

    // 新源从 now 起播（对齐到音频时钟，不用 setTimeout 排音频时序）
    const next0 = this.spawnMain(now)
    const nextGain = this.mainSrcGain
    if (next0 && nextGain) {
      nextGain.gain.cancelScheduledValues(now)
      nextGain.gain.setValueAtTime(0, now)              // 从 0 起，避免硬切爆音
      nextGain.gain.linearRampToValueAtTime(1, now + XFADE)
    }

    if (oldSrc && oldGain) {
      // 旧源独立淡出：动的是它自己的私有增益，总线 mainGain 不受影响
      oldGain.gain.cancelScheduledValues(now)
      oldGain.gain.setValueAtTime(oldGain.gain.value, now)
      oldGain.gain.linearRampToValueAtTime(0, now + XFADE)
      // setTimeout 只用于"包络走完后再回收节点"，不是音频时序本身（沿用原文件既有做法）
      setTimeout(() => { try { oldSrc.stop() } catch { /* noop */ } }, (XFADE + 0.1) * 1000)
    }
  }

  /** 环境/频谱数据（HUD 用）。复用临时数组：levels 每帧调用，原来每帧 new 512B（约 30KB/s 垃圾） */
  private zTime = new Uint8Array(512)
  // 显式写成 Uint8Array<ArrayBuffer>：TS 5.7+ 起 getByteFrequencyData 只接受
  // 非 SharedArrayBuffer 的视图，不写就报 TS2345。
  private zFreq: Uint8Array<ArrayBuffer> | null = null

  levels() {
    const z = this.zTime
    let main = 0, bed = 0
    if (this.armed) {
      this.mainAnalyser.getByteTimeDomainData(z)
      for (let i = 0; i < z.length; i++) main += Math.abs(z[i] - 128)
      main = Math.min(1, main / z.length / 42)
      this.bedAnalyser.getByteTimeDomainData(z)
      for (let i = 0; i < z.length; i++) bed += Math.abs(z[i] - 128)
      bed = Math.min(1, bed / z.length / 42)
    }
    return { main, bed }
  }

  wave(out: Float32Array) {
    if (!this.armed) { out.fill(0); return }
    const n = Math.min(out.length, this.mainAnalyser.fftSize)
    if (this.zTime.length < n) this.zTime = new Uint8Array(n)
    const z = this.zTime
    this.mainAnalyser.getByteTimeDomainData(z)
    for (let i = 0; i < out.length; i++) out[i] = (z[Math.floor(i / out.length * n)] - 128) / 128
  }

  spectrum(out: Uint8Array) {
    if (!this.armed) { out.fill(0); return }
    const fb = this.mainAnalyser.frequencyBinCount
    if (!this.zFreq || this.zFreq.length !== fb) this.zFreq = new Uint8Array(fb)
    const z = this.zFreq
    this.mainAnalyser.getByteFrequencyData(z)
    for (let i = 0; i < out.length; i++) {
      const a = Math.floor((i / out.length) ** 2 * z.length)
      out[i] = z[Math.min(a, z.length - 1)]
    }
  }
}
