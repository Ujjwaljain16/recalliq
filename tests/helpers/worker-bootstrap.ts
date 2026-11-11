import { register } from 'tsx/esm/api';

// Worker threads do not honour `--import tsx`, and Node's built-in type stripping cannot map the `.js`
// import specifiers used throughout src/ to their `.ts` files. Registering tsx here, before the worker
// body is imported, fixes both. The specifier is a variable so that tsc does not try to resolve it.
register();
const worker = new URL('./concurrency-worker.ts', import.meta.url).href;
await import(worker);
