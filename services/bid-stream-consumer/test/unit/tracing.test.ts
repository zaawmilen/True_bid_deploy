import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE } from '@opentelemetry/semantic-conventions';
import { buildResource, getOtlpEndpoint } from '../../src/tracing.js';

describe('buildResource', () => {
  it('throws on an empty service name rather than silently emitting unlabeled spans', () => {
    expect(() => buildResource('')).toThrow();
  });

  it('produces a resource that a real tracer provider actually tags spans with', () => {
    // This is the meaningful test: not "does buildResource return an
    // object with the right shape", but "if I hand this resource to a
    // real OTel provider and emit a span, does that span actually carry
    // our service name" - proven with an in-memory exporter instead of
    // a live collector.
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      resource: buildResource('cost-engine'),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    const tracer = provider.getTracer('test');
    const span = tracer.startSpan('test-span');
    span.end();

    const [recorded] = exporter.getFinishedSpans();
    expect(recorded.name).toBe('test-span');
    expect(recorded.resource.attributes[ATTR_SERVICE_NAME]).toBe('cost-engine');
    expect(recorded.resource.attributes[ATTR_SERVICE_NAMESPACE]).toBe('truebid');
  });

  it('gives each service its own distinct resource (no accidental sharing)', () => {
    const exporter = new InMemorySpanExporter();

    const providerA = new NodeTracerProvider({
      resource: buildResource('cost-engine'),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const providerB = new NodeTracerProvider({
      resource: buildResource('anomaly-service'),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    providerA.getTracer('test').startSpan('a').end();
    providerB.getTracer('test').startSpan('b').end();

    const [spanA, spanB] = exporter.getFinishedSpans();
    expect(spanA.resource.attributes[ATTR_SERVICE_NAME]).toBe('cost-engine');
    expect(spanB.resource.attributes[ATTR_SERVICE_NAME]).toBe('anomaly-service');
  });
});

describe('getOtlpEndpoint', () => {
  const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  afterEach(() => {
    if (original === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
  });

  it('defaults to the Jaeger OTLP/HTTP receiver on the compose network', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(getOtlpEndpoint()).toBe('http://jaeger:4318');
  });

  it('respects an explicit override', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel-collector:4318';
    expect(getOtlpEndpoint()).toBe('http://otel-collector:4318');
  });
});
