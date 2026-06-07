export type FunctionRef = {
  domain: string;
  action: string;
};

export type SkillManifest = {
  name: string;
  description: string;
  dependsOn: string[];
  functions: FunctionRef[];
};

export type CatalogSkill = SkillManifest & {
  dir: string;
};

export type SkillCatalog = {
  skills: CatalogSkill[];
  byName: Map<string, CatalogSkill>;
};
