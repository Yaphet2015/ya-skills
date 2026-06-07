import type { CatalogSkill, SkillCatalog } from "./types.js";

export function resolveSkillInstallOrder(catalog: SkillCatalog, skillNames: string[]): CatalogSkill[] {
  const ordered: CatalogSkill[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  for (const name of skillNames) {
    visit(name, []);
  }

  return ordered;

  function visit(name: string, path: string[]) {
    if (done.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name].join(" -> ");
      throw new Error(`Skill dependency cycle detected: ${cycle}`);
    }

    const skill = catalog.byName.get(name);
    if (!skill) {
      throw new Error(`Unknown skill: ${name}`);
    }

    visiting.add(name);
    for (const dependencyName of skill.dependsOn) {
      visit(dependencyName, [...path, name]);
    }
    visiting.delete(name);
    done.add(name);
    ordered.push(skill);
  }
}
