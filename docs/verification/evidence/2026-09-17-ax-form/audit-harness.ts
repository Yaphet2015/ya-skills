import { writeFileSync } from 'node:fs';
import { parseAxFormArgs, runAxForm } from '/Users/phaethon/workspace/personal/ya-skills/scripts/probes/computer-use-ax-form.ts';
const sdk=await import('/Users/phaethon/workspace/personal/ya-skills/packages/computer-runtime/node_modules/@trycua/cua-driver/dist/index.js');
const calls:any[]=[];
const methods=['click','callTool','typeText','pressKey','scroll'] as const;
const originals=new Map<string,Function>();
const proto=sdk.CuaDriver.prototype as any;
for(const name of methods){
 const original=proto[name]; originals.set(name,original);
 proto[name]=async function(...args:any[]){
  const entry:any={method:name, ...(name==='callTool'?{tool:args[0]}:{})}; calls.push(entry);
  try{const result=await Reflect.apply(original,this,args);entry.result=result;return result;}
  catch(e){entry.error=String(e);throw e;}
 };
}
try{
 const request=parseAxFormArgs(process.argv.slice(2));
 if(request.kind!=='native')throw Error('explicit native arguments required');
 const report=await runAxForm(request);
 console.log(JSON.stringify(report,null,2));
 if(report.status!=='passed')process.exitCode=1;
}finally{
 for(const [name,original] of originals)proto[name]=original;
 writeFileSync('/private/tmp/yk-ax-form-20260917-native-calls.json',JSON.stringify({note:'Transparent call-through SDK prototype audit; arguments and results forwarded unchanged, no retries.',enums:{route:sdk.ActionRoute,effect:sdk.ActionEffect,delivery:sdk.ActionDeliveryMode},calls},(_,v)=>typeof v==='bigint'?v.toString():v,2),{mode:0o600});
}
