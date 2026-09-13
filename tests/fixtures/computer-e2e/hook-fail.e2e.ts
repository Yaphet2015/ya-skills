export default {
  apiVersion: 1,
  id: 'fixture-hook-fail',
  name: 'hook failure fixture',
  async beforeAll() {
    throw new Error('boot failed');
  },
  afterAll() {
    console.log('HOOK_CLEANUP_RAN');
  },
  tests: [
    {
      id: 'never',
      name: 'must not run',
      async run() {
        throw new Error('must not run');
      }
    }
  ]
};
