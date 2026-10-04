const B='http://127.0.0.1:8188'
const oi = await (await fetch(B+'/object_info/LoadImage',{signal:AbortSignal.timeout(30000)})).json()
const opts = oi?.LoadImage?.input?.required?.image?.[0] ?? []
console.log('  可选图数量: '+opts.length)
console.log('  含 tape_threeview.png ? '+opts.includes('tape_threeview.png'))
console.log('  含 taped* 的: '+opts.filter(o=>/tape/i.test(o)).join(', '))
