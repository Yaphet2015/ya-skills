export default {
  apiVersion: 1,
  id: 'fixture-hang',
  name: 'async hang fixture',
  tests: [{ id: 'hang', name: 'never resolves', run() { return new Promise(() => {}); } }]
};
