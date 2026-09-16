import * as sdk from "/Users/phaethon/workspace/personal/ya-skills/packages/computer-runtime/node_modules/@trycua/cua-driver/dist/index.js";
import { readFileSync, writeFileSync } from "node:fs";
const root = "/tmp/ya-native-type-diagnostic";
const before = JSON.parse(readFileSync(`${root}/state.json`, "utf8"));
if (before.isKeyWindow || before.isMainWindow || before.frontmostPid === before.pid) throw new Error("fixture focus invariant failed");
const driver = sdk.CuaDriver.create(undefined);
const record: any = { before, started: Date.now() };
try {
  record.result = await driver.typeText(sdk.TypeTextInput.new({
    target: new sdk.ActionTarget.Window({ pid: before.pid, windowId: BigInt(before.windowId) }),
    text: "sdk-type-diagnostic"
  }));
} catch (error: any) {
  record.error = { name: error.name, tag: error.tag, message: error.message, inner: error.inner };
} finally {
  await Bun.sleep(500);
  record.after = JSON.parse(readFileSync(`${root}/state.json`, "utf8"));
  record.ended = Date.now();
  await driver.shutdown(); driver.uniffiDestroy();
  writeFileSync(`${root}/raw-type.json`, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
}
