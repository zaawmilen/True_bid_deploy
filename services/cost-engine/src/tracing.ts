// tracing.ts
//
// Distributed tracing bootstrap, identical across all 5 services (only
// the SERVICE_NAME env var differs). Must run BEFORE any other module
// is imported - auto-instrumentation works by patching modules
// (kafkajs, pg, express, http, ioredis) at require()-time, so if
// `import './kafka.js'` happens before this file registers its
// instrumentation, that particular kafkajs instance is never patched
// and silently produces no spans. This is why it's loaded via
// `node --require ./dist/tracing.js dist/index.js`, not a normal
// `import` inside index.ts - see docs/TRACING_INTEGRATION.md.
//
// Exports two pure/testable pieces (buildResource, getOtlpEndpoint) and
// one side-effecting entrypoint (startTracing) that isn't meaningfully
// unit-testable in isolation - starting a real SDK against a real
// collector is what proves it works, not a mock. See
// test/unit/tracing.test.ts for what IS covered here, and
// docs/TRACING_INTEGRATION.md for how to verify the rest against Jaeger.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE } from '@opentelemetry/semantic-conventions';

export function getOtlpEndpoint(): string {
  // Jaeger's all-in-one image exposes an OTLP/HTTP receiver on 4318.
  // Pointed at Jaeger directly rather than a separate otel-collector
  // container - see docs/PRODUCTION_READINESS.md's tracing section for
  // why a standalone collector isn't worth the extra container here.
  return process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://jaeger:4318';
}

/**
 * Builds the OTel Resource identifying which service emitted a given
 * span. `service.namespace` groups all 5 TrueBid services together in
 * backends (like Jaeger's UI) that use it, distinct from unrelated
 * services someone might also be running OTel against on the same host.
 */
export function buildResource(serviceName: string) {
  if (!serviceName) {
    throw new Error('buildResource requires a non-empty service name');
  }
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_NAMESPACE]: 'truebid',
  });
}

let sdk: NodeSDK | undefined;

/**
 * Starts the SDK. Call once, as early as possible (see file header).
 * `serviceName` should match the compose service name exactly
 * (cost-engine, anomaly-service, etc.) so traces line up with the
 * `job` labels Prometheus already uses - one consistent name across
 * both signals, not two different naming schemes to remember.
 */
export function startTracing(serviceName: string): void {
  if (sdk) return; // idempotent - a stray double-require shouldn't double-start

  sdk = new NodeSDK({
    resource: buildResource(serviceName),
    traceExporter: new OTLPTraceExporter({ url: `${getOtlpEndpoint()}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem instrumentation is noisy (every readFile becomes a
        // span) and adds nothing to this project's story - disabled
        // rather than left default-on and ignored.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
      new KafkaJsInstrumentation(),
    ],
  });

  sdk.start();

  // Flush pending spans on shutdown so the last few requests before a
  // restart aren't silently dropped - matters more here than in most
  // demos, since `restart: on-failure` in docker-compose.yml means
  // these services do restart during the Kafka cold-start races
  // documented in BUGS_FOUND.md.
  const shutdown = () => {
    sdk
      ?.shutdown()
      .catch((err) => console.error('Error shutting down OTel SDK', err))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
