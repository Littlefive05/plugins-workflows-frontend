// 临时探针：解析交付的 GLB，核对节点命名前缀与材质/贴图是否完好
// 用法: node tools/glb-probe.cjs public/assets/3d/tape.glb
const fs = require('node:fs')
const file = process.argv[2]
const b = fs.readFileSync(file)
const jsonLen = b.readUInt32LE(12)
const j = JSON.parse(b.slice(20, 20 + jsonLen).toString('utf8'))
const names = (j.nodes || []).map((n) => n.name || '(unnamed)')
const cnt = {}
for (const n of names) {
  const pre = n.replace(/\d+$/, '').replace(/_$/, '')
  cnt[pre] = (cnt[pre] || 0) + 1
}
console.log('  节点总数       ', names.length)
console.log('  === 全部节点名（按名排序）===')
for (const n of [...names].sort()) console.log('    ' + n)
console.log('  命名前缀 Top14 ', Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}×${v}`).join('  '))
console.log('  bandseg 节点   ', names.filter((n) => /bandseg/i.test(n)).join(', ') || '(无)')
console.log('  label 前缀节点 ', names.filter((n) => /^label/i.test(n)).join(', ') || '(无)')
console.log('  材质/图像/纹理 ', `${(j.materials || []).length} / ${(j.images || []).length} / ${(j.textures || []).length}`)
for (const m of (j.materials || []).slice(0, 12)) {
  const p = m.pbrMetallicRoughness || {}
  console.log(`    - ${m.name || '?'}  baseColor=${JSON.stringify(p.baseColorFactor)}  有贴图=${!!p.baseColorTexture}  metallic=${p.metallicFactor}  rough=${p.roughnessFactor}`)
}
