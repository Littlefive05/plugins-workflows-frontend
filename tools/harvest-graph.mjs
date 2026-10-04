import fs from 'node:fs'
const B='http://127.0.0.1:8188'
const ID='4b0d92a9-b8fd-4c39-bf1d-6018d9c72887'
const h=await (await fetch(`${B}/history/${ID}`,{signal:AbortSignal.timeout(40000)})).json()
const e=h[ID]
if(!e){ console.log('  ❌ 无该 history 条目'); process.exit(1) }
const p=e.prompt
const g = Array.isArray(p) ? p[2] : (p && p.graph) ? p.graph : p
if(!g || typeof g!=='object'){ console.log('  ❌ 取不到图'); process.exit(1) }
const keys=Object.keys(g).filter(k=>/^\d+$/.test(k))
console.log('  ✅ 取回 API 图: '+keys.length+' 节点')
fs.writeFileSync('C:/LFModels/workspaces/series-0x2b/tools/trellis-api.json', JSON.stringify(g,null,2))
for(const k of keys){ const ct=g[k].class_type||''; if(/LoadImage|PrimitiveBoolean|Save3D/i.test(ct)) console.log('    '+k+' '+ct+' '+JSON.stringify(g[k].inputs).slice(0,120)) }
