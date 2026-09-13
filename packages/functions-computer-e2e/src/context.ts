// Application identity is PROJECT-provided; the generic layer never guesses.

export interface ApplicationInfo {
  name: string;
  revision: string | null;
  dirty: boolean | null;
  environment: string;
}
