// 站点文字层：严格「英文缩写 + 数字」，命名走生成管线主题（SERIES 0x2B / BLEND-TAPE / DIFFUSION）

export const IDENTITY = {
  series: 'SERIES 0x2B',
  name: 'BLEND-TAPE',
  pipeline: 'DIFFUSION',
  revision: 'REV r0001',
  index: 'ARCH 0x2B',
}

// 开场逐字打出的规格行（ACT 01）
export const SPEC_LINES = [
  'SERIES 0x2B',
  'TYPE II / HIGH BIAS',
  'BLEND-TAPE',
  'DIFFUSION PIPELINE',
  'REV r0001',
  'NOMINAL 4.76 cm/s',
  'TRK 02 / STEREO',
  'SR 48.0 kHz',
  'BIT 24',
  'LEN 02:12',
  'HUB 330 deg',
  'SCR 04',
  'AZ 90 deg',
  'BIA +0.9 dB',
]

// ACT 01 右侧密排（技术标签墙）
export const DENSE_LINES = [
  'GEN / KREA2-TURBO', 'STEP 08', 'CFG 1.00', 'SAMPLER EULER', 'SCHED SIMPLE',
  'GEN / TRELLIS.2', 'MESH 40k', 'DECIMATE 60k>>40k', 'UNIT m', 'UP +Y',
  'OPT / BLENDER 5.2.2', 'ENGINE CYCLES', 'SAMPLES 032', 'XFORM AgX', 'FPS 24',
  'AUD / MINIMAX-MUSIC3', 'MAIN 132s', 'BED 156s', 'LOOP SEAM 02', 'DUCK -14 dB',
  'SFX / PARAM-SYNTH', 'NO PULSE', 'JITTER +-4%', 'FILT LP 2.4k', 'CALLS 512',
  'HUD / PRIMARY FIXED', 'HUD / SECONDARY PER-ACT', 'PSEUDO-3D CSS', 'GRID 12', 'ACCENT 01',
]

// ACT 02 读数键值
export const READOUT = [
  ['SERIES', '0x2B'],
  ['TYPE', 'II / HIGH'],
  ['SPEED', '4.76'],
  ['TRACKS', '02'],
  ['SIDE', 'A'],
  ['SAMPLE', '48.0k'],
  ['DEPTH', '24'],
  ['LEN', '02:12'],
  ['PEAK', '-0.3'],
  ['RMS', '-14.2'],
  ['HUB', '330'],
  ['SCREWS', '04'],
  ['AZIMUTH', '90'],
  ['BIAS', '+0.9'],
]

export const STATES = [
  { k: 'STATE 00', n: 'REST', d: 'SHELL CLOSED / LABEL FACE UP' },
  { k: 'STATE 01', n: 'HALF', d: 'SHELL OPEN / REELS EXPOSED' },
  { k: 'STATE 02', n: 'SPLIT', d: 'PARTS SEPARATED / EXPLODED' },
]

// ACT 03 爬取条目（渲染为引用网节点）
export const CRAWL_TERMS = [
  'BLEND-TAPE', 'DIFFUSION', 'SERIES 0x2B', 'KREA2', 'TRELLIS.2', 'PIXAL3D',
  'MINIMAX-H3', 'MUSIC3', 'Q34B', 'VAE-DAV', 'CLIP-MINI', 'UNET-FP16',
  'AZ 90', 'BIA +0.9', 'SR 48.0k', 'BIT 24', 'TRK 02', 'HUB 330',
  'SCR 04', 'SPD 4.76', 'PK -0.3', 'RMS -14.2', 'FLT 2.4k', 'JIT 4%',
  'LOOP 02', 'DUCK -14', 'ARM 01', 'PSEUDO-3D', 'GRID 12', 'ACC 01',
  'ACT 01', 'ACT 02', 'ACT 03', 'REV r0001', 'ARCH 0x2B', 'NODE 031',
  'MESH 40k', 'DEC 60>>40', 'CYC 032', 'AGX', 'FPS 24', 'UNIT m',
  'SPEC 12', 'RAIL 03', 'SEAM 00', 'HISS 0.02', 'WHIR 0.04', 'CLICK 0.01',
]

// ACT 03 引用关系（确定性伪随机，保证每次一致）
export function crawlEdges(count: number) {
  const edges: Array<[number, number]> = []
  let s = 0x2b2b
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < count; i++) {
    const n = 2 + Math.floor(rnd() * 2)
    for (let k = 0; k < n; k++) {
      const a = i
      const b = Math.floor(rnd() * count)
      if (a !== b) edges.push([a, b])
    }
  }
  return edges
}
