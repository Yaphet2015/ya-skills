import assert from 'node:assert/strict';
import { value } from './value.ts';
export default async function run() {
  assert.equal(value, 42);
  console.log('EXTERNAL_SUITE_OK');
}
