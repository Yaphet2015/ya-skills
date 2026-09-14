# Drawing SVG Icons

Canonical authoring guide. The compiler in `compiler.mjs` enforces the numeric contract. Validation is not visual review: look at 16px.

The agent writes `src`-style JSON. Never hand-edit compiled SVG.

## Canvas

24 by 24. Safe area 2 to 22. Every point on the integer or half grid. Stroke 2, round caps. Key shapes, so icons carry even optical weight: circle r 9 at 12,12; square 18 at inset 3; landscape 20 by 16; portrait 16 by 20. Match one.

## Source file

`<name>.icon.json`. `name` is kebab-case and matches the file. `title` is the human name. `categories` from: navigation, actions, status, content, entry-types, agent, controls, shapes. `keywords` for search. `shapes` in draw order.

Name by shape, not meaning: `folder-pencil`, not `guest-edit`. Meaning goes in `keywords`.

## Primitives

| Primitive | Form | Notes |
|---|---|---|
| `line` | `[x1, y1, x2, y2]` | |
| `polyline` | `[[x, y], ...]`, `close: true`, `corner` | Corners rounded by arc; `join: "miter"` for sharp. A point may be `{ "to": [x, y], "r": n, "large", "flip" }` for an arc segment |
| `rect` | `[x, y, w, h]`, `radius` | Radius defaults to 2, or 1 when the shorter side is under 8 |
| `circle` | `[cx, cy, r]` | Radius on the half grid |
| `ellipse` | `[cx, cy, rx, ry]` | |
| `arc` | `[cx, cy, r, from, to]` | Degrees in multiples of 45, clockwise from east |
| `bend` | `[x1, y1, x2, y2, r]`, `large`, `flip` | Arc between two grid points; bulges left of travel unless flipped |
| `quad` | `[x1, y1, cx, cy, x2, y2]` | Quadratic curve; control point on the grid |
| `dot` | `[x, y]` | A round-capped terminal that scales with weight. For a dot that *is* the glyph, use a circle of radius 1 |
| `arrow` | `[x1, y1, x2, y2]`, `head` | Legs 6 by 6 on axis shafts, 8 axis-aligned on diagonals |
| `use` | `"name"`, `offset: [dx, dy]`, `scale: 1 or 0.5` | Inlines another icon's shapes |
| `path` | raw data | Last resort |

## Ink

`"ink": 1` (default) or `"ink": 2` on a shape. At most two inks in one icon. `{ "use": "pencil", "ink": 2 }` paints every inlined shape with ink 2. A third ink is a compiler error.

## Corners

Every polyline vertex and every arrowhead tip is rounded with an arc of radius 2. A corner takes at most 40% of its shorter segment. `corner` on a shape overrides the radius (0 to 4); `join: "miter"` makes it sharp. Sharp direction marks take `corner: 1`.

## Modifiers

`mirror: "x" | "y"` flips across the canvas centre. `rotate` in multiples of 90. `nudge: [dx, dy]` up to 0.5 per axis, optical centring only. Modifiers on `use` other than `offset`, `scale`, and `ink` are not applied to the target; write twins by hand when needed.

## Style

- No faces, no ornament. Fewest strokes that name the thing.
- Judge at 16px. Counters a reader must see want about 4 units of clear space.
- Marks inside frames span about 55 to 60% of the frame.
- Open shapes never end on another stroke's edge. Stop 2 short or cross clean.
- Optical weight over geometric truth. Never change stroke width to fix a heavy or light glyph.
- Do not copy paths from another icon library.

## Checks the compiler enforces

Off-grid point, point outside the safe area, unknown primitive or category, radius larger than half the shorter side, zero-length line, parallel axis-aligned strokes closer than 3 centre to centre, `use` of an unknown icon or a cycle, duplicate names, a file name not matching `name`, an arc angle off 45, a rotate off 90, a nudge over 0.5, ink other than 1 or 2.

## Compile

```sh
bun compiler.mjs --emit <file.icon.json> -o <file.svg> --library src [--ink1 currentColor] [--ink2 '#2563eb']
```

## Neighbours

| Construction | Sources | Keep |
|---|---|---|
| Badges | `circle-check`, `square-check`, `circle-alert` | Frame and internal mark size |
| Folder family | `folder`, `folder-plus`, `folder-x` | Same outline; extra mark is a separate shape |
| Edit | `pencil` | Closed body plus the ferrule line |
| Corner badge | `use` at `scale: 0.5` plus `offset` | Stay inside 2–22 after mapping |
