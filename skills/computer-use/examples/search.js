// Example computer-use exec flow: search a field, submit, wait for results,
// keep an explicit counter in session state. The script body is an async
// function body — `computer`, `target`, `state`, `log`, and `observe` are
// provided; everything else (awaits, loops, local variables) is plain JS.
//
// Run inside a session:
//   yk computer-use session open --pid 123 --window 456
//   yk computer-use exec --session <ID> --file search.js --request-id r1

// This example assumes the Search field exposes a writable AX value.
// Resolve exactly one fresh field, and do not insert another observation
// between choosing its token and using it.
async function searchField() {
  const view = await observe({ mode: "ax", selector: { text: "Search", match: "exact", role: "AXTextField" } });
  if (view.ax.elements.length !== 1 || !view.ax.elements[0].elementToken) {
    throw new Error("Expected one Search field with a fresh token");
  }
  return view.ax.elements[0].elementToken;
}
await computer.setValue(await searchField(), "penguin");
// If the app requires keyboard events, use addressed type instead of setValue:
// await computer.type("penguin", undefined, { elementToken: await searchField() });
await computer.key("Return", undefined, undefined, { elementToken: await searchField() });

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
