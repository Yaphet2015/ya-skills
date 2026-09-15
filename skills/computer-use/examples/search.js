// Example computer-use exec flow: search a field, submit, wait for results,
// keep an explicit counter in session state. The script body is an async
// function body — `computer`, `target`, `state`, `log`, and `observe` are
// provided; everything else (awaits, loops, local variables) is plain JS.
//
// Run inside a session:
//   yk computer-use session open --pid 123 --window 456
//   yk computer-use exec --session <ID> --file search.js --request-id r1

await computer.click({ text: "Search", match: "exact", role: "AXTextField" });
await computer.type("penguin");
await computer.key("Return");

// Local wait: structured predicate polled on this machine, no model round trip.
await computer.wait(
  { kind: "element_exists", selector: { text: "Results", match: "contains" } },
  3000
);

// Optional visual verification when AX labels are ambiguous: observe, then
// look at the returned image yourself and click_point with fresh coordinates.
// const view = await observe({ mode: "both" });
// ... read view.image.path, decide coordinates on THAT image, then:
// await computer.clickPoint({ observationId: view.id, x: 500, y: 300 });

const view = await observe({ mode: "auto" });
state.searches = Number(state.searches ?? 0) + 1;
log({ title: view.title, searches: state.searches });

return { title: view.title, searches: state.searches };
