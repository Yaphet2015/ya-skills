export default {
  apiVersion: 1,
  id: 'fixture-fail',
  name: 'failing fixture',
  tests: [
    {
      id: 'boom',
      name: 'fails the run and stops the file',
      async run() {
        throw new Error('fixture failure');
      }
    },
    {
      id: 'never',
      name: 'must not run after a failure',
      async run() {
        throw new Error('must not run');
      }
    }
  ]
};
