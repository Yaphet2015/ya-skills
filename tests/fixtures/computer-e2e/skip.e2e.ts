export default {
  apiVersion: 1,
  id: 'fixture-skip',
  name: 'runtime skip fixture',
  tests: [
    {
      id: 'conditional',
      name: 'skips at runtime with a reason',
      async run(ctx) {
        ctx.skip('condition not met in this environment');
      }
    }
  ]
};
