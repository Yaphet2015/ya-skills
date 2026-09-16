import * as sdk from "/Users/phaethon/workspace/personal/ya-skills/packages/computer-runtime/node_modules/@trycua/cua-driver/dist/index.js";
import {readFileSync,writeFileSync,rmSync} from "node:fs";
const root="/tmp/ya-native-20260916/matrix-cancel";
const before=JSON.parse(readFileSync(`${root}/state.json`,"utf8"));
rmSync(`${root}/entered.json`,{force:true});rmSync(`${root}/release`,{force:true});
const driver=sdk.CuaDriver.create(undefined);
const result:any={before,started:Date.now()};
try {
 const s=await driver.getWindowState(sdk.GetWindowStateInput.new({pid:before.pid,windowId:BigInt(before.windowId),includeAccessibilityTree:true,includeScreenshot:false}));
 const elements=s.elements as any[];
 result.elements=elements;
 const matches=elements.filter(e=>e.label==="Block Increment" || e.title==="Block Increment");
 if(matches.length!==1) throw new Error("one Block Increment element required");
 const token=matches[0].elementToken;
 if(typeof token!=="string") throw new Error("elementToken missing");
 result.click=await driver.click(sdk.ClickInput.new({target:new sdk.ActionTarget.Window({pid:before.pid,windowId:BigInt(before.windowId)}),position:new sdk.ClickPosition.Element({elementToken:token}),deliveryMode:sdk.InputDeliveryMode.Background,button:sdk.ClickButton.Left,count:1}));
} catch(e:any) { result.error={string:String(e),tag:e.tag,inner:e.inner,props:Object.fromEntries(Object.getOwnPropertyNames(e).filter(k=>k!=="stack").map(k=>[k,e[k]]))}; }
finally { result.ended=Date.now();writeFileSync(`${root}/release`,"release");await Bun.sleep(150);result.after=JSON.parse(readFileSync(`${root}/state.json`,"utf8")); await driver.shutdown();driver.uniffiDestroy();writeFileSync(`${root}/raw-ax-timeout.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result)); }
