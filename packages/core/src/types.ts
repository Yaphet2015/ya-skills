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

export type FunctionCommand = {
  domain: string;
  action: string;
  description: string;
  run(args: string[]): Promise<string | void> | string | void;
};

export type FunctionRegistry = {
  list(): FunctionCommand[];
  run(domain: string, action: string, args: string[]): Promise<string | void>;
};
