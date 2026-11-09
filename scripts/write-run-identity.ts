import * as fs from 'fs';
import { writeRunIdentity, annotateRunResults } from '../src/utils/run-identity';

const suite = process.argv[2];
if (suite !== 'CLI' && suite !== 'Security') throw new Error('Expected CLI or Security suite');
writeRunIdentity(process.argv[3] || 'allure-results', suite);
// Optional fourth argument is a pre-pass file list, or --all for fresh local results.
if (process.argv[4]) {
  const previous = process.argv[4] === '--all' ? [] : fs.readFileSync(process.argv[4], 'utf8').split('\n');
  annotateRunResults(process.argv[3] || 'allure-results', suite, previous);
}
