// bootstrap.ts
// The file actually passed to `node --require`. Kept separate from
// tracing.ts on purpose, so tracing.ts stays pure exports (testable)
// and this one file is the only place a side effect happens on import.
//
//   node --require ./dist/bootstrap.js dist/index.js
//
// SERVICE_NAME should be set per-service in docker-compose.yml to match
// the compose service name exactly (see tracing.ts's startTracing doc
// comment for why that matters).

import { startTracing } from './tracing.js';

const serviceName = process.env.SERVICE_NAME;
if (!serviceName) {
  // Fail loud, not silent - a service running with no traces and no
  // error is much harder to debug than one that refuses to start.
  console.error('SERVICE_NAME must be set to enable tracing (bootstrap.ts)');
  process.exit(1);
}

startTracing(serviceName);
