// SERIES 0x2B — 3D 舞台 v4
// v4 变更（本轮）：
//  1) 模型换成 Blender 参数化重建 v2（57 个命名零件），按【名称前缀】归入五层
//  2) 三态改为【点击磁带本体】循环切换（射线拾取），不再只靠按钮
//  3) HALF / SPLIT 时整机转为半透明，鼠标所指的层实时实体化
//  4) 修正旋转：卷轴/轮毂必须各绕【自身轴】自转；整机在第二幕不再持续自转（避免零件转速不一致）
import * as THREE from 'three'
import gsap from 'gsap'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export type TapeState = 0 | 1 | 2
export interface LayerAnchor { name: string; x: number; y: number }
type LayerName = 'label' | 'framePlate' | 'reels' | 'body' | 'backPlate'

const MM = 0.001
const TAPE_URL = '/assets/3d/tape.glb'
const TAPE_H = 12.22 * MM

const LAYERS: LayerName[] = ['label', 'framePlate', 'reels', 'body', 'backPlate']

/** 名称前缀 → 层（与 build-tape-v2.py 的 LAYER_BY_PREFIX 保持一致） */
const LAYER_BY_PREFIX: Array<[string, LayerName]> = [
  ['label', 'label'], ['window', 'label'], ['wframe', 'label'], ['screw', 'label'],
  ['frame', 'framePlate'],
  // bandseg_* = 第二幕 HALF 从带仓取出并展开的 4 段带路（每段 = 一个主轨）。
  // 前缀必须写成 'bandseg'【不带下划线】，且必须排在下面的 'body' 兜底之前：
  // 否则这 4 段会静默掉进 body 层，SPLIT 时跟着壳体一起位移并穿模（实测 body 会从 22 变 26）。
  ['bandseg', 'reels'],
  ['spool', 'reels'], ['hub', 'reels'], ['tape_', 'reels'], ['pad', 'reels'],
  ['spring', 'reels'], ['shield', 'reels'], ['rivet', 'reels'], ['idler', 'reels'],
  ['body', 'body'], ['wall', 'body'], ['rib', 'body'], ['recess', 'body'],
  ['capstan', 'body'], ['gpost', 'body'], ['boss', 'body'], ['notch', 'body'], ['chamfer', 'body'],
  ['back', 'backPlate'], ['wp_', 'backPlate'],
]
const layerOf = (n: string): LayerName => {
  for (const [p, l] of LAYER_BY_PREFIX) if (n.startsWith(p)) return l
  return 'body'
}

// HALF 的抬升量：9mm 时"从带仓取出"读不出来 —— 镜头在前上方约 40°，
// 盖板抬高后会像掀向观众的板子把内腔整个挡住（实测：只看得见一块标签板）。
// 抬到 20mm 才有明确的"盖子被拿开、里面露出来"的观感。
const OFF_HALF: Partial<Record<LayerName, number>> = { label: 20 * MM }
const OFF_SPLIT: Record<LayerName, number> = {
  label: 30 * MM, framePlate: 16 * MM, reels: 2 * MM, body: -13 * MM, backPlate: -26 * MM,
}
const CAM_HOME = { y: 0.190, z: 0.280 }
/** HALF 专用机位：退远一点，才能把"抽出来展在前方的带路"整条收进画面 */
const CAM_HALF = { y: 0.215, z: 0.398 }
const CAM_SPLIT = { y: 0.288, z: 0.425 }
const GHOST_OPACITY = 0.5

export class Stage {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera

  /** 点击磁带时的回调（由 main.ts 接管三态推进） */
  onTapeClick: ((x: number, y: number) => void) | null = null
  /** 磁带点击是否启用：ARM 解锁后延迟开启，避免"点 ARM 顺带点到磁带" */
  tapEnabled = false

  private tape = new THREE.Group()
  private layers: Partial<Record<LayerName, THREE.Group>> = {}
  private spinners: THREE.Object3D[] = []        // 卷轴 / 轮毂：各自绕自身轴自转
  private mats: Array<{ m: THREE.MeshStandardMaterial; base: number; layer: LayerName }> = []
  private mirror: THREE.Group | null = null
  private floor!: THREE.Mesh
  private raycaster = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private ready = false
  private ghost = false
  private solid: LayerName | null = null
  private pointer = new THREE.Vector2()
  private act = 1
  private playing = false
  private wantState: TapeState = 0
  private clock = new THREE.Clock()
  private baseYaw = 0.34
  /** 第二幕 HALF：从带仓取出并展开的 4 段带路（bandseg_01..04，每段 = 一个主轨） */
  private bandsegs: THREE.Object3D[] = []
  /** 当前三态。HALF 时标签层要保持不透明（见下方收敛循环的说明） */
  private curState: TapeState = 0
  /** 第一幕：自转 + 用户拖动偏移；松手后偏移自适应回归，自转继续 */
  private autoYaw = 0
  private userYaw = 0
  private userPitch = 0
  private dragVel = 0
  private dragging = false
  private spin = 0
  private frameN = 0
  /** 换幕补间期间保持渲染（第三幕补间走完后即停渲染） */
  private stageVisibleUntil = 0

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5))
    this.renderer.setClearAlpha(0)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // 阴影贴图不每帧重算：本场景是动态的（磁带在转），但转速很慢，
    // 每 4 帧更新一次肉眼无差别，开销降到 1/4；换幕/换态时再手动请求一次。
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.02

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.005, 12)
    this.camera.position.set(0, CAM_HOME.y, CAM_HOME.z)

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture

    this.buildLights()
    this.buildFloor()
    this.scene.add(this.tape)
    this.loadTape()

    // 点击磁带本体 → 切三态 / 进第二幕。挂在 window 上（canvas 可能设了 pointer-events:none）
    //
    // ⚠ 必须排除"点的是界面控件"的情况：
    //   ARM 按钮正好在视口正中，而磁带也在正中 —— 点 ARM 解锁的那一刻，
    //   这一次点击会同时命中磁带 → 页面刚解锁就自己跳到第二幕（用户报的"打开默认 Act02"）。
    addEventListener('click', (e) => {
      if (!this.tapEnabled) return                       // 尚未解锁 / 刚解锁的宽限期
      const t = e.target as HTMLElement | null
      if (t && t.closest('button, a, input, select, .sb, .tb, .panel')) return
      if (this.hitTest(e.clientX, e.clientY)) this.onTapeClick?.(e.clientX, e.clientY)
    })
    this.resize()
  }

  private buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a948a, 0.85))
    const key = new THREE.DirectionalLight(0xfff4e6, 2.4)
    key.position.set(-0.20, 0.34, 0.24)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.camera.near = 0.05
    key.shadow.camera.far = 2
    const d = 0.16
    Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d })
    key.shadow.bias = -0.0008
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0xbfd6ff, 0.85); rim.position.set(0.28, 0.16, -0.30)
    this.scene.add(rim)
    const fill = new THREE.DirectionalLight(0xffffff, 0.4); fill.position.set(0.26, 0.12, 0.28)
    this.scene.add(fill)
  }

  private softShadowTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = c.height = 512
    const g = c.getContext('2d')!
    const rg = g.createRadialGradient(256, 256, 10, 256, 256, 250)
    rg.addColorStop(0, 'rgba(0,0,0,0.30)'); rg.addColorStop(0.45, 'rgba(0,0,0,0.10)'); rg.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = rg; g.fillRect(0, 0, 512, 512)
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
    return t
  }

  private buildFloor() {
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(0.30, 0.20),
      new THREE.MeshBasicMaterial({ map: this.softShadowTexture(), transparent: true, depthWrite: false })
    )
    this.floor.rotation.x = -Math.PI / 2
    this.floor.position.y = -TAPE_H / 2 + 0.0004
    this.floor.renderOrder = 2
    this.scene.add(this.floor)
  }

  /* ---------------- 载入模型，按前缀归层，并为每个网格克隆独立材质 ---------------- */
  private loadTape() {
    new GLTFLoader().load(TAPE_URL, (gltf) => {
      const root = gltf.scene
      const meshes: THREE.Mesh[] = []
      root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) meshes.push(m) })
      for (const l of LAYERS) {
        const g = new THREE.Group(); g.name = 'layer_' + l
        this.tape.add(g); this.layers[l] = g
      }
      let tris = 0
      for (const m of meshes) {
        m.castShadow = true; m.receiveShadow = true
        tris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3
        // 分层解析：glTF 会把零件拆成【无名子网格】或给节点名加后缀，
        // 只按自身名字匹配会让它们掉进 'body' 兜底层 —— 实测 5 颗螺钉就是这样：
        // label 层只剩 3 个（应为 8），body 多出 10 个（32 vs 22）。
        // 改为沿父级向上找第一个命中的前缀（找不到才兜底 body）。
        let layer: LayerName = 'body'
        for (let o: THREE.Object3D | null = m; o && o !== this.tape; o = o.parent) {
          if (!o.name) continue
          const hit = LAYER_BY_PREFIX.find(([p]) => o!.name.startsWith(p))
          if (hit) { layer = hit[1]; break }
        }
        // 每个网格一份独立材质：半透明实体化需要按零件单独控制不透明度
        const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial
        const mat = src.clone()
        const base = src.transparent ? Math.max(0.08, src.opacity) : 1
        mat.opacity = base
        mat.depthWrite = true
        m.material = mat
        this.mats.push({ m: mat, base, layer })
        this.layers[layer]!.attach(m)
        if (m.name.startsWith('spool') || m.name.startsWith('hub')) this.spinners.push(m)
      }
      // 收集 4 段带路。每段局部原点就在自己的几何中心，所以"取出"就是纯平移。
      // 方向：壳体前方 = Blender −Y = three 的 **+Z**（glTF 做 Y-up，Blender +Y→three −Z）。
      // 前方净空只有 8.80mm，位移必须超过它才会露出壳外。
      // 只收 Mesh：glTF 里节点与网格可能同名，都收进来会导致同一段被位移两次。
      this.tape.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && /^bandseg_\d+$/.test(o.name)) this.bandsegs.push(o)
      })
      this.tape.position.y = TAPE_H / 2
      this.tape.rotation.y = this.baseYaw
      this.buildMirror()
      this.ready = true
      gsap.killTweensOf(this.tape.scale)
      this.setAct(this.act)
      this.setState(this.wantState, false)
      console.info(`[stage] tape v2: ${meshes.length} parts, ${Math.round(tris / 1000)}k tri, ${this.spinners.length} spinners`)
      // 自检：按层列出成员【名字】（不是数量）—— 只有看到名字才知道谁掉进了兜底层
      console.info('[stage] layers ' + Object.entries(this.layers).map(([k, g]) => {
        const nm: string[] = []
        ;(g as THREE.Group).traverse((o) => { if ((o as THREE.Mesh).isMesh) nm.push(o.name || '(空名)') })
        return `${k}[${nm.length}]=${nm.slice(0, 12).join(',')}`
      }).join(' | ') + ` || bandsegs ${this.bandsegs.length} || 前6个mesh名 ${meshes.slice(0, 6).map((m) => m.name || '(空名)').join(',')}`)
    }, undefined, (e) => console.warn('[stage] 磁带模型加载失败', e))
  }

  private buildMirror() {
    const m = this.tape.clone(true)
    m.traverse((o) => {
      const me = o as THREE.Mesh
      if (!me.isMesh) return
      me.castShadow = false; me.receiveShadow = false
      const src = (Array.isArray(me.material) ? me.material[0] : me.material) as THREE.MeshStandardMaterial
      const c = src.clone()
      c.transparent = true
      c.opacity = src.transparent ? 0.06 : 0.15
      c.side = THREE.BackSide
      c.depthWrite = true
      me.material = c
      me.renderOrder = 1
    })
    m.scale.y = -1
    m.position.y = -TAPE_H / 2
    m.rotation.y = this.baseYaw
    this.mirror = m
    this.tape.parent?.add(m)
  }

  /* ---------------- 三态 ---------------- */
  setState(n: TapeState, animate = true) {
    this.wantState = n
    if (!this.ready) return
    const dur = animate ? 0.95 : 0
    const ease = 'power3.inOut'
    const off = n === 2 ? OFF_SPLIT : n === 1 ? OFF_HALF : null
    for (const l of LAYERS) {
      const g = this.layers[l]
      if (!g) continue
      gsap.to(g.position, { y: off ? off[l] : 0, duration: dur, ease })
    }
    const cam = n === 2 ? CAM_SPLIT : n === 1 ? CAM_HALF : CAM_HOME
    gsap.to(this.camera.position, { y: cam.y, z: cam.z, duration: dur || 0.5, ease: 'power2.inOut' })
    // HALF：把 4 段带路【真正抽出来并展开】。
    //  行程 58~72mm：原来 19~23mm 在 100mm 的机器上只露出一点点，加上带条只有 12mm 宽、
    //  0.16mm 厚，从镜头看几乎不存在（用户报的"抽出带条不存在"）。
    //  四段再在厚度方向错开 ±6mm，读得出"展开成四段"，而不是整条平移。
    const OUT = [0.062, 0.072, 0.066, 0.058]
    this.bandsegs.forEach((o, i) => {
      gsap.to(o.position, {
        z: n === 1 ? OUT[i % OUT.length] : 0,
        y: n === 1 ? (i - 1.5) * 0.004 : 0,
        duration: dur || 0.9,
        ease: 'power2.inOut',
      })
    })
    // 自检：1.2s 后回报"实际"到位情况（不是意图）—— 标签层 y 与四段带路的 z
    if (n === 1) {
      setTimeout(() => console.info(
        `[stage] after HALF: label.y=${this.layers.label?.position.y} `
        + `band z=[${this.bandsegs.map((o) => o.position.z.toFixed(4)).join(', ')}] `
        + `labelChildren=${this.layers.label?.children.length}`), 1200)
    }
    // ghost（整机半透明）只给 SPLIT：HALF 的主角是"被抽出来的带路"，
    // 把壳体也一起压透会把它稀释成背景色 —— 用户报的"只有一块白板、看不到内部"就是这个。
    this.curState = n
    this.setGhost(n === 2)
  }

  /** 半透明模式 + 鼠标实体化 */
  setGhost(on: boolean) {
    if (this.ghost === on) return
    this.ghost = on
    for (const e of this.mats) {
      e.m.transparent = on || e.base < 1
      e.m.depthWrite = !on
      e.m.needsUpdate = true
    }
  }

  setSolid(layer: LayerName | null) { this.solid = layer }

  setPlaying(on: boolean) { this.playing = on }

  setAct(n: number) {
    this.act = n
    this.stageVisibleUntil = performance.now() + 900
    if (n === 1) this.resetDrag()      // 回到第一幕：姿态复位成"完整闭合的整机"
    if (n === 2) {
      // 进入第二幕：把第一幕累积的朝向折到最短路径，随后由主循环平滑转回展示姿态
      const TAU = Math.PI * 2
      const total = this.autoYaw + this.userYaw
      this.autoYaw = ((total + Math.PI) % TAU + TAU) % TAU - Math.PI
      this.userYaw = 0
    }
    const show = n !== 3
    const s = show ? 1 : 0.001
    gsap.to(this.tape.scale, {
      x: s, y: s, z: s, duration: 0.7, ease: 'power2.inOut',
      // 补间走完就真正 visible=false（第 3 幕那 63 个 draw call 彻底不参与渲染）
      onComplete: () => { if (this.tape.scale.x < 0.5) this.tape.visible = false },
    })
    if (show) this.tape.visible = true
    if (this.mirror) {
      const ms = n === 1 ? 1 : 0.001
      if (ms > 0.5) this.mirror.visible = true
      // 镜像副本有 57 个网格：隐藏时必须 visible=false，否则它们仍会被渲染（白费 57 次 draw call）
      gsap.to(this.mirror.scale, {
        x: ms, y: -ms, z: ms, duration: 0.7, ease: 'power2.inOut',
        onComplete: () => { if (this.mirror && this.mirror.scale.x < 0.5) this.mirror.visible = false },
      })
    }
    gsap.to(this.floor.material as THREE.MeshBasicMaterial, { opacity: show ? 1 : 0, duration: 0.7 })
    if (n !== 2) this.setGhost(false)
  }

  setPointer(nx: number, ny: number) { this.pointer.set(nx, ny) }

  /** 按住拖动旋转（第一幕）：把屏幕位移换算成绕 Y / X 的旋转偏移 */
  dragBy(dx: number, dy: number) {
    const dYaw = dx * 0.0065
    this.userYaw += dYaw
    this.dragVel = dYaw
    this.userPitch = Math.max(-0.7, Math.min(0.7, this.userPitch + dy * 0.0042))
  }
  /** 按住 / 松手。松手时把甩动速度转成自转惯性，并让偏移自适应回归 */
  setDragging(on: boolean) {
    if (this.dragging && !on) {
      this.autoYaw += Math.max(-1.6, Math.min(1.6, this.dragVel * 11))
      this.dragVel = 0
    }
    this.dragging = on
  }
  resetDrag() { this.autoYaw = 0; this.userYaw = 0; this.userPitch = 0; this.dragVel = 0 }

  /** 射线拾取：指针是否落在磁带上；同时决定哪一层实体化 */
  private pick(clientX: number, clientY: number): LayerName | null {
    if (!this.ready) return null
    this.ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    const hits = this.raycaster.intersectObject(this.tape, true)
    if (!hits.length) return null
    let o: THREE.Object3D | null = hits[0].object
    while (o && o.parent !== this.tape) o = o.parent
    return (o?.name.replace('layer_', '') as LayerName) ?? null
  }

  hitTest(x: number, y: number) { return this.pick(x, y) !== null }

  /** 第二幕：命中的是第几段带路（0 起），未命中返回 null。
   *  用于"范围内点=选曲、范围外点=切三态"的分派。 */
  hitTestBand(clientX: number, clientY: number): number | null {
    if (!this.ready || !this.bandsegs.length) return null
    this.ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    const hits = this.raycaster.intersectObjects(this.bandsegs, true)
    if (!hits.length) return null
    let o: THREE.Object3D | null = hits[0].object
    while (o && !o.name.startsWith('bandseg')) o = o.parent
    const m = o?.name.match(/bandseg_(\d+)/)
    return m ? Number(m[1]) - 1 : null
  }

  /** 每帧更新鼠标实体化（由 main.ts 的指针事件驱动坐标） */
  updateHover() {
    if (!this.ready || !this.ghost) { this.solid = null; return }
    this.solid = this.pick(this.pointerPx.x, this.pointerPx.y)
  }

  private pointerPx = new THREE.Vector2(innerWidth / 2, innerHeight / 2)
  setPointerPx(x: number, y: number) { this.pointerPx.set(x, y) }

  layerAnchors(): LayerAnchor[] {
    const out: LayerAnchor[] = []
    const v = new THREE.Vector3()
    for (const l of LAYERS) {
      const g = this.layers[l]
      if (!g) continue
      g.getWorldPosition(v)
      const p = v.clone().project(this.camera)
      out.push({ name: l, x: (p.x * 0.5 + 0.5) * innerWidth, y: (-p.y * 0.5 + 0.5) * innerHeight })
    }
    return out
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight, false)
    this.camera.aspect = innerWidth / innerHeight
    this.camera.updateProjectionMatrix()
  }

  start() {
    const loop = () => {
      requestAnimationFrame(loop)
      // 第三幕整屏被代码层占据（#gl 只剩 14% 不透明度），此时完全不必渲染 WebGL：
      // 一个 2880×1620 的 MSAA 缓冲 + 63 个 draw call 每帧白跑。等换幕补间（0.7s）走完再停，
      // 这样停住时留下的最后一帧里磁带已经缩到不可见。
      if (this.act === 3 && performance.now() > this.stageVisibleUntil) return
      const dt = Math.min(this.clock.getDelta(), 0.05)
      const t = this.clock.elapsedTime
      if (this.act !== 3 && this.ready) {
        // 第一幕：持续自转；拖动叠加偏移，松手后偏移自适应回归（自转不中断）
        const drag = this.act === 1
        if (drag) {
          this.autoYaw += dt * 0.14
          if (!this.dragging) {
            const k = Math.min(1, dt * 1.7)
            this.userYaw += (0 - this.userYaw) * k
            this.userPitch += (0 - this.userPitch) * k
          }
        } else {
          // 非第一幕：把第一幕的朝向平滑转回展示姿态（约 0.6s 到位），这就是 1→2 的过渡动作
          const k = Math.min(1, dt * 1.9)
          this.autoYaw += (0 - this.autoYaw) * k
          this.userYaw += (0 - this.userYaw) * k
          this.userPitch += (0 - this.userPitch) * k
        }
        const yawOff = this.autoYaw + this.userYaw
        this.tape.rotation.y = this.baseYaw + yawOff + this.pointer.x * (drag ? 0.05 : 0.22)
        this.tape.rotation.x = (drag ? this.userPitch : -0.015) + this.pointer.y * (drag ? -0.03 : -0.05)
          + (drag ? 0 : Math.sin(t * 0.22) * 0.012)
        this.tape.position.y = TAPE_H / 2 + Math.sin(t * 0.5) * 0.8 * MM
        if (this.mirror && this.mirror.visible) {
          this.mirror.rotation.y = this.tape.rotation.y
          this.mirror.rotation.x = -this.tape.rotation.x
          this.mirror.position.y = -TAPE_H / 2 - Math.sin(t * 0.5) * 0.8 * MM
        }
        this.camera.position.x = this.pointer.x * 0.008
        this.camera.lookAt(0, this.act === 2 ? 0 : 0.002, 0)
        this.updateHover()
      }
      // 阴影每 4 帧更新一次（第一幕在自转，需要跟；其余幕姿态静止，按需更新即可）
      if (++this.frameN % 4 === 0) this.renderer.shadowMap.needsUpdate = true
      // 卷轴 / 轮毂：各自绕自身轴自转（整层绕 Y 转会让两个卷轴公转）
      if (this.playing) {
        this.spin = Math.min(this.spin + dt * 0.8, 1)
        for (const s of this.spinners) s.rotation.y += dt * 2.4 * this.spin
      }
      // 半透明实体化：逐帧向目标不透明度收敛
      for (const e of this.mats) {
        // HALF：整机保持实心（不参与 ghost）。见 setState 里的说明。
        const want = (this.curState !== 1 && this.ghost && e.layer !== this.solid)
          ? Math.min(GHOST_OPACITY, e.base) : e.base
        e.m.opacity += (want - e.m.opacity) * Math.min(1, dt * 7)
      }
      this.renderer.render(this.scene, this.camera)
    }
    loop()
  }
}
