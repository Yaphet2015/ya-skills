import { spawn } from 'node:child_process';
export default {
  apiVersion: 1,
  id: 'fixture-orphan',
  name: 'same-process-group child fixture',
  beforeAll() {
    spawn('/bin/sleep', ['307']); // same group: the supervisor's group kill must reap it
  },
  tests: [{ id: 'hang', name: 'never resolves', run() { return new Promise(() => {}); } }]
};
