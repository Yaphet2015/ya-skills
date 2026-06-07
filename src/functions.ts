type FunctionHandler = (args: string[]) => Promise<string | void> | string | void;

export type RegisteredFunction = {
  domain: string;
  action: string;
  description: string;
  run: FunctionHandler;
};

export type FunctionRegistry = {
  list(): RegisteredFunction[];
  run(domain: string, action: string, args: string[]): Promise<string | void>;
};

export function createFunctionRegistry(): FunctionRegistry {
  const functions: RegisteredFunction[] = [
    {
      domain: "demo",
      action: "echo",
      description: "Print the provided arguments.",
      run: (args) => args.join(" ")
    }
  ];
  const byCommand = new Map(functions.map((fn) => [`${fn.domain} ${fn.action}`, fn]));

  return {
    list() {
      return functions;
    },
    async run(domain, action, args) {
      const fn = byCommand.get(`${domain} ${action}`);
      if (!fn) {
        throw new Error(`Unknown function command: ${domain} ${action}`);
      }
      return fn.run(args);
    }
  };
}
