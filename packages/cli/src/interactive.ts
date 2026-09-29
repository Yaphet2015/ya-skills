// Interactive skill picker for `yk install` (no explicit skill names).
// Rendering and key handling are delegated to @clack/prompts: line wrapping,
// terminal width, resize, and ctrl+c chunking are the framework's job, not
// ours. Pure pieces (option construction, dependency expansion) stay exported
// for unit tests; only `selectSkillsInteractively` touches the terminal.

import * as p from "@clack/prompts";
import { resolveSkillInstallOrder, type CatalogSkill, type SkillCatalog } from "@ya-skills/core";
import { skillNameWidth } from "./skill-list.js";

// What Enter on the confirm screen will actually install: selected skills plus
// dependencies, in dependency-first install order.
export function confirmSkillsFor(catalog: SkillCatalog, selected: string[]): CatalogSkill[] {
  return resolveSkillInstallOrder(catalog, selected);
}

// Picker options: padded name as label (keeps the list visually aligned),
// description plus dependency suffix as hint (deps must be visible before
// install because dependencies are installed implicitly).
export function pickerOptions(catalog: SkillCatalog) {
  const width = skillNameWidth(catalog.skills);
  return catalog.skills.map((skill) => ({
    value: skill.name,
    label: skill.name.padEnd(width),
    hint: skill.dependsOn.length > 0 ? `${skill.description} · ${skill.dependsOn.join(", ")}` : skill.description
  }));
}

export type PromptResult =
  | { canceled: true }
  | { canceled: false; selected: string[] };

export async function selectSkillsInteractively(catalog: SkillCatalog): Promise<PromptResult> {
  if (catalog.skills.length === 0) {
    throw new Error("The skill catalog is empty");
  }
  const selected = await p.multiselect({
    message: "Select skills to install",
    options: pickerOptions(catalog),
    required: true
  });
  if (p.isCancel(selected)) {
    return { canceled: true };
  }
  const planned = confirmSkillsFor(catalog, [...selected]);
  const proceed = await p.confirm({
    message: `Install ${planned.length} skill(s), including dependencies?`
  });
  if (p.isCancel(proceed) || !proceed) {
    return { canceled: true };
  }
  return { canceled: false, selected: [...selected] };
}
