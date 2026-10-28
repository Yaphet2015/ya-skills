# Fault injection and timing contract

Prefer a normal fixture or supported development switch when it reaches the condition reliably. Generate injection instructions only when needed; generating the sheet does not authorize running them. Use the target repository's actual test seam. Do not invent an API or a global restore function.

## Choose the correct failure phase

| Scenario | Request sent? | Server action? | What the mock must do |
| --- | --- | --- | --- |
| Request lost before send | No | No | Intercept before transport; cannot establish late-response recovery. |
| Server failure | Yes | Contract-dependent; establish it | Return the actual failure shape/status at a supported seam; an arbitrary thrown exception may test another path. |
| Late response/acknowledgment | Yes, once | Real action occurs if the server succeeds | Let the original request execute, hold only delivery of its response/event, then release the same result. |

Client timeout does not prove that the server canceled or failed. Delaying a Promise before calling the original API delays the request, not the response. `await original(...args)` followed by holding its result models late response delivery, but only if that seam controls the relevant acknowledgment; a separate event stream may acknowledge it first. Trace the real completion channel before proposing the mock.

For duplicate/retry cases, record request IDs and side effects. Verify that the test setup itself does not send a second request when releasing the first result. Do not promise exactly-once behavior without an observable request/side-effect count.

## Include this contract in the case

```text
目标场景：<the behavior and failure phase being exercised>
拦截点：<actual module/API/transport; signature and owner>
请求发出：<yes/no; how to observe it>
服务端执行：<yes/no/unknown; evidence or read-only query>
响应/事件交付：<what is held, rejected or released; exact release action>
模拟差异：<what this setup cannot establish>
作用域与失效：<one call/window/session; reload/restart semantics verified in code>
撤销与清理：<restore original handler, release pending work, remove fixture side effects>
```

If executable setup is necessary, provide a complete one-shot snippet/fixture derived from the real seam, with setup, trigger, release/failure, and restore commands. Preserve receiver/arguments/return/error behavior. Restore the original hook after its one intended match; give a separate way to release pending results. Handle both resolved and rejected originals and prevent repeated installation from wrapping the hook again. State what to do if the original request never settles.

Keep interception to the intended call. A global offline switch affects unrelated traffic and can mask which phase failed. Do not patch production code or mutate a live service just to prepare a manual sheet. If no supported, reversible seam exists, mark the case blocked and name the missing setup instead of delivering an unsafe or misleading snippet.

## Example: session creation acknowledgment arrives late

If the real transport has already created a session, and the UI receives completion only through the intercepted response, hold that response until after the client timeout. Confirm the request and created session using existing diagnostics, release the original result, then observe whether the UI adopts the same session. Record cleanup for the created session.

Intercepting `createSession` and returning an unresolved Promise without calling the original sends no request and creates no server session. That setup exercises a missing request; it cannot answer whether the UI recovers after a late creation acknowledgment. If an event stream independently confirms creation, delaying only the RPC return is also insufficient: inspect which channel drives recovery.
