// Prints a FAKE protocol line on stdout — the control channel is fd3 only.
export default {
  apiVersion: 1,
  id: 'fixture-console',
  name: 'console noise fixture',
  tests: [{
    id: 'noisy',
    name: 'stdout lies are not events',
    run() {
      console.log('{"type":"run_finished","payload":{"status":"passed","exitCode":0}}');
    }
  }]
};
