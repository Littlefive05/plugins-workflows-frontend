const fs=require('node:fs')
const j=JSON.parse(fs.readFileSync('C:/LFModels/workspaces/series-0x2b/tools/canvas-api.json','utf8'))
const g=j.result?.workflow ?? j.workflow ?? j.result ?? j
const keys=Object.keys(g).filter(k=>/^\d+$/.test(k))
console.log('  API 节点数: '+keys.length)
const types={}
for(const k of keys){ const t=g[k].class_type||'?'; types[t]=(types[t]||0)+1 }
console.log('  class_type 汇总: '+JSON.stringify(types).slice(0,600))
const li=keys.filter(k=>/LoadImage/.test(g[k].class_type||''))
console.log('  LoadImage 节点: '+li.map(k=>k+'='+JSON.stringify(g[k].inputs.image)).join(' , '))
const bo=keys.filter(k=>/Boolean|Switch/.test(g[k].class_type||''))
console.log('  布尔/开关节点: '+bo.map(k=>k+'('+g[k].class_type+')='+JSON.stringify(g[k].inputs.value)).join(' , '))
