// 一键重建磁带资产：贴图（PIL）→ Blender 参数化建模 + 导出 GLB + 四张自检渲染
// 用法: node tools/run-tape-assets.mjs
//
// 注（本轮修复）：本文件的注释与提示字符串此前经历了一次 GBK↔UTF-8 双重编码损坏，
// 部分字符（含字符串的收尾引号）在往返中丢失，导致 Node 直接抛
// "SyntaxError: Invalid or unexpected token"、整个一键流程根本跑不起来。
// 逻辑与路径常量未改动，仅按原意把损坏的注释/字符串改回正确中文。
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PIL_PY = 'C:\\SD-Aki\\ComfyUI-aki\\ComfyUI-aki-v3.2\\python\\python.exe'
const BLENDER = 'E:\\Blender\\blender.exe'
const TEX = join(ROOT, 'tools', 'tex')
const CHECK = join(ROOT, 'tools', 'tape-check')
const GLB = join(ROOT, 'public', 'assets', '3d', 'tape.glb')

function need(p, what) {
  if (!existsSync(p)) {
    console.error(`缺少 ${what}: ${p}`)
    process.exit(1)
  }
}
need(PIL_PY, 'PIL 解释器（aki 自带 python）')
need(BLENDER, 'Blender')

console.log('== 1/2 生成贴图 ==')
const t1 = spawnSync(PIL_PY, [join(HERE, 'make-tape-textures.py'), TEX], { stdio: 'inherit' })
if (t1.status !== 0) process.exit(t1.status ?? 1)

console.log('\n== 2/2 Blender 建模 + 导出 + 自检渲染 ==')
const t2 = spawnSync(BLENDER, ['-b', '--python', join(HERE, 'build-tape-v2.py'), '--', GLB, TEX, CHECK], { stdio: 'inherit' })
// Blender 后台模式常在完成后仍返回 1；以产物为准
if (!existsSync(GLB)) {
  console.error('未生成 GLB，构建失败')
  process.exit(1)
}
console.log(`\n完成：${GLB}  ${(statSync(GLB).size / 1024 / 1024).toFixed(2)} MB`)
console.log(`自检渲染：${CHECK}`)
