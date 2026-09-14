import assert from 'node:assert/strict';

// The dependency-free example suite: no npm imports, no desktop calls — it
// proves the runner contract end to end and doubles as a template.
export default {
  apiVersion: 1,
  id: 'pure-example',
  name: 'Pure example suite',
  tests: [
    {
      id: 'arithmetic',
      name: 'plain assertions need no desktop',
      async run(ctx) {
        await ctx.step('compute', async () => {
          assert.equal(1 + 1, 2);
        });
        await ctx.step('read params', async () => {
          assert.ok(typeof ctx.params === 'object');
        });
      }
    },
    {
      id: 'conditional',
      name: 'declared skip keeps exit code honest (2, not 0)',
      skip: 'template placeholder — delete this case in real suites',
      async run() {
        assert.fail('must not run');
      }
    }
  ]
};
