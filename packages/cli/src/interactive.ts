// Interactive checkbox picker for `yk install` (no explicit skill names).
// Built on Node built-ins only (raw mode + a tiny key parser): the repo ships
// zero runtime dependencies and the compiled binary must stay self-contained.
//
// Pure pieces (state machine, key mapping, confirm expansion) are exported for
// unit tests; only `selectSkillsInteractively` touches the terminal.

import { resolveSkillInstallOrder, type CatalogSkill, type SkillCatalog } from "@ya-skills/core";
import { formatSelectionRow, shouldColor, skillNameWidth } from "./skill-list.js";

export type SelectionState = {
  cursor: number;
  checked: Set<string>;
};

export type SelectionEvent = { kind: "up" | "down" | "space" | "enter" | "escape" };

export type SelectionOutcome =
  | { kind: "continue"; state: SelectionState; hint?: string }
  | { kind: "submit"; selected: string[] }
  | { kind: "cancel" };

export function initialSelectionState(skills: CatalogSkill[]): SelectionState {
  return { cursor: skills.length > 0 ? 0 : -1, checked: new Set() };
}

export function applySelectionEvent(skills: CatalogSkill[], state: SelectionState, event: SelectionEvent): SelectionOutcome {
  if (skills.length === 0) {
    return event.kind === "escape" ? { kind: "cancel" } : { kind: "continue", state };
  }
  switch (event.kind) {
    case "up":
      return { kind: "continue", state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
    case "down":
      return { kind: "continue", state: { ...state, cursor: Math.min(skills.length - 1, state.cursor + 1) } };
    case "space": {
      const checked = new Set(state.checked);
      const name = skills[state.cursor]!.name;
      if (checked.has(name)) {
        checked.delete(name);
      } else {
        checked.add(name);
      }
      return { kind: "continue", state: { ...state, checked } };
    }
    case "enter": {
      if (state.checked.size === 0) {
        return { kind: "continue", state, hint: "Select at least one skill with space." };
      }
      return { kind: "submit", selected: [...state.checked] };
    }
    case "escape":
      return { kind: "cancel" };
  }
}

export type KeyEvent = SelectionEvent | { kind: "interrupt" };

// Minimal raw-key parser (arrows, space, enter, escape, j/k, ctrl+c).
// Bun's readline keypress parser silently drops a key that shares an input
// chunk with \x03 (ctrl+c), so the picker parses stdin bytes itself.
// Trade-off: a lone ESC at the end of a chunk is treated as the Esc key
// (real terminals send Esc presses exactly this way), so an arrow sequence
// split across two chunks is not recognized — terminals send arrows as one
// chunk. Unknown bytes are ignored.
export function createKeyParser(): { push(chunk: string): KeyEvent[] } {
  let pending = "";
  return {
    push(chunk: string): KeyEvent[] {
      pending += chunk;
      const events: KeyEvent[] = [];
      while (pending.length > 0) {
        const head = pending[0]!;
        if (head === "\x03") {
          events.push({ kind: "interrupt" });
          pending = pending.slice(1);
          continue;
        }
        if (head === "\x1b") {
          const next = pending[1];
          if (next === "[") {
            const third = pending[2];
            if (third === undefined) {
              break; // arrow sequence still arriving within this stream
            }
            if (third === "A" || third === "B") {
              events.push({ kind: third === "A" ? "up" : "down" });
            }
            pending = pending.slice(3);
            continue;
          }
          events.push({ kind: "escape" });
          pending = pending.slice(1);
          continue;
        }
        if (head === "\r" || head === "\n") {
          events.push({ kind: "enter" });
          pending = pending.slice(1);
          continue;
        }
        if (head === " ") {
          events.push({ kind: "space" });
          pending = pending.slice(1);
          continue;
        }
        if (head === "j" || head === "k") {
          events.push({ kind: head === "j" ? "down" : "up" });
        }
        pending = pending.slice(1);
      }
      return events;
    }
  };
}

// What Enter on the confirm screen will actually install: selected skills plus
// dependencies, in dependency-first install order.
export function confirmSkillsFor(catalog: SkillCatalog, selected: string[]): CatalogSkill[] {
  return resolveSkillInstallOrder(catalog, selected);
}

export type PromptResult =
  | { canceled: true; reason: "escape" | "interrupt" }
  | { canceled: false; selected: string[] };

export async function selectSkillsInteractively(catalog: SkillCatalog): Promise<PromptResult> {
  const skills = catalog.skills;
  if (skills.length === 0) {
    throw new Error("The skill catalog is empty");
  }
  const out = process.stdout;
  const color = shouldColor();
  const width = skillNameWidth(skills);

  const restore = () => {
    out.write("\x1b[?25h"); // show cursor
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  let frameLines = 0;
  const clearFrame = () => {
    for (let i = 0; i < frameLines; i++) {
      out.write("\x1b[1A\x1b[2K"); // up one line, clear it
    }
    frameLines = 0;
  };
  const drawFrame = (lines: string[]) => {
    out.write(lines.join("\n"));
    frameLines = lines.length;
  };

  let state = initialSelectionState(skills);
  let hint: string | undefined;

  out.write("\x1b[?25l"); // hide cursor
  process.stdin.setRawMode(true);
  process.stdin.resume();

  try {
    // One listener drives both phases. Swapping listeners between phases would
    // drop keys that arrive in the same input burst as the phase-switching
    // Enter (e.g. a fast double Enter would never install).
    return await new Promise<PromptResult>((resolveAll) => {
      let phase: "list" | "confirm" = "list";
      let selectedNames: string[] = [];
      const parser = createKeyParser();

      const renderList = () => {
        drawFrame([
          "",
          hint ?? "(↑/↓ move · space select · Enter confirm · Esc cancel)",
          ...skills.map((skill, index) =>
            formatSelectionRow(skill, width, { checked: state.checked.has(skill.name), cursor: index === state.cursor }, color)
          )
        ]);
      };
      const renderConfirm = () => {
        const confirmList = confirmSkillsFor(catalog, selectedNames);
        drawFrame([
          "",
          "Will install (including dependencies):",
          ...confirmList.map((skill) => `  ${skill.name}`),
          "",
          "(Enter install · Esc cancel)"
        ]);
      };
      renderList();

      const finish = (result: PromptResult) => {
        process.stdin.off("data", onData);
        clearFrame();
        resolveAll(result);
      };

      const onData = (chunk: Buffer | string) => {
        for (const event of parser.push(chunk.toString())) {
          handleEvent(event);
        }
      };
      const handleEvent = (event: KeyEvent) => {
        if (event.kind === "interrupt") {
          finish({ canceled: true, reason: "interrupt" });
          return;
        }
        if (phase === "list") {
          const result = applySelectionEvent(skills, state, event);
          if (result.kind === "cancel") {
            finish({ canceled: true, reason: "escape" });
            return;
          }
          if (result.kind === "submit") {
            selectedNames = result.selected;
            phase = "confirm";
            clearFrame();
            renderConfirm();
            return;
          }
          state = result.state;
          hint = result.hint ?? undefined;
          clearFrame();
          renderList();
          return;
        }
        // Confirm phase: Enter installs, Esc cancels.
        if (event.kind === "escape") {
          finish({ canceled: true, reason: "escape" });
        } else if (event.kind === "enter") {
          finish({ canceled: false, selected: selectedNames });
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    restore();
  }
}
