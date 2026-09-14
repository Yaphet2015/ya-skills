---
name: svg-icons
description: Use when the user invokes /svg-icons or asks to generate a unified SVG icon, glyph, composed mark, toolbar icon, or folder-plus-badge icon for UI or docs.
---

# SVG Icons

Generate family-consistent 24-grid outline icons. The agent writes `.icon.json`. The compiler writes SVG. The user never writes either.

**Skill dir:** the directory that contains this file. `compiler.mjs` and `src/` live beside it. Read `docs/spec.md` before drawing.

## Recipe

1. Parse the request: subject, corner badge, named colors. Name the icon by shape (`folder-pencil`), not meaning (`guest-edit`).
2. Search `src/*.icon.json` for an existing name or keyword. Prefer `{ "use": "<name>" }` over redrawing. If one icon already satisfies the request, compile that file and stop drawing.
3. Create a temp dir with `mktemp -d "${TMPDIR:-/tmp}/svg-icons.XXXXXX"`. Write `<name>.icon.json` there. Do not write into the project yet.
4. Compile:

```sh
bun <skill-dir>/compiler.mjs --emit <tmp>/<name>.icon.json -o <tmp>/<name>.svg --library <skill-dir>/src --ink2 '#2563eb'
```

Omit `--ink2` when the drawing uses one ink. Map "蓝色" to `#2563eb` unless the user gave a hex.
5. If compile fails (safe area, gap, grid), fix the JSON and rerun. Do not hand-edit the SVG.
6. Place the SVG only after it exists in temp:
   - User named a path → copy there.
   - Open file / repo clearly owns an icons module → copy there.
   - Otherwise ask once: 用在组件里、资源目录、还是只要文件？ Do not create an icons directory on a guess.

## Two inks

Shapes may set `"ink": 1` (default, `currentColor` or `--ink1`) or `"ink": 2` (`--ink2`). A third ink is a compile error. `{ "use": "pencil", "ink": 2 }` paints the whole glyph with ink 2.

## Example

User: `/svg-icons 文件夹背景右下角放一个代表客编辑的蓝色的笔`

```json
{
  "name": "folder-pencil",
  "title": "Folder pencil",
  "categories": ["content", "actions"],
  "keywords": ["folder", "edit", "guest", "pencil"],
  "shapes": [
    { "use": "folder" },
    { "use": "pencil", "scale": 0.5, "offset": [6, 6], "ink": 2 }
  ]
}
```

If the compiler rejects the offset as outside the safe area, reduce `offset` or keep `scale` at `0.5`. Do not switch to raw SVG.

## Red flags — stop and restart from step 3

| Excuse | Reality |
| --- | --- |
| "Faster to write the path by hand" | Hand paths leave the family. JSON + compiler is the output. |
| "It's just one icon" | One icon still goes through temp + compiler. |
| "Filled gold folder looks clearer" | Outline, stroke 2, round caps. No illustration fills. |
| "They need it in src/ now" | Temp file first, then place. |
| "Blue, gold, and white" | At most two inks. |

Hand-written `d="M..."` paths, extra colors, or writing into the repo before a temp SVG exists means delete that file and start at step 3.
