// Shared skill-list rendering: `yk list` and the interactive `yk install`
// picker must show the exact same line body (padded name, description,
// dependency suffix, colors) so the two views stay visually identical.

import type { CatalogSkill } from "@ya-skills/core";

export function shouldColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export function boldCyan(value: string): string {
  return `\x1b[1;36m${value}\x1b[0m`;
}

export function dim(value: string): string {
  return `\x1b[2m${value}\x1b[0m`;
}

export function skillNameWidth(skills: CatalogSkill[]): number {
  return skills.reduce((width, skill) => Math.max(width, skill.name.length), 0);
}

export function formatSkillLine(skill: CatalogSkill, nameWidth: number, color: boolean): string {
  const name = skill.name.padEnd(nameWidth);
  let body = skill.description;
  if (skill.dependsOn.length > 0) {
    body += ` · ${skill.dependsOn.join(", ")}`;
  }
  if (!color) {
    return `${name}  ${body}`;
  }
  return `${boldCyan(name)}  ${dim(body)}`;
}

// Interactive row = cursor marker + checkbox + the exact `yk list` line body.
export function formatSelectionRow(
  skill: CatalogSkill,
  nameWidth: number,
  options: { checked: boolean; cursor: boolean },
  color: boolean
): string {
  const marker = options.cursor ? "❯ " : "  ";
  const checkbox = options.checked ? "[x] " : "[ ] ";
  return `${marker}${checkbox}${formatSkillLine(skill, nameWidth, color)}`;
}
