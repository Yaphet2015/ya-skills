import assert from 'node:assert/strict';

export default {
  apiVersion: 1,
  id: 'fixture-pass',
  name: 'passing fixture',
  tests: [
    {
      id: 'one',
      name: 'asserts inside a step',
      async run(ctx) {
        await ctx.step('compute', async () => {
          assert.equal(1 + 1, 2);
        });
      }
    },
    {
      id: 'two',
      name: 'skipped by declaration',
      skip: 'fixture skip reason',
      async run() {
        throw new Error('must not run');
      }
    }
  ]
};
