export default {
  apiVersion: 1,
  id: 'fixture-sync-hang',
  name: 'sync hang fixture',
  tests: [{ id: 'spin', name: 'blocks the event loop forever', run() { while (true) {} }]
};
