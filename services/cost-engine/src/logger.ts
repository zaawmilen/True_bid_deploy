// Structured logging so `docker compose logs cost-engine` produces
// machine-parseable JSON lines instead of ad hoc strings - the same shape
// every other service in this repo uses, so a log aggregator downstream
// can treat all five services uniformly.
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export interface LogFields {
  [key: string]: unknown;
}

const SERVICE_NAME = "cost-engine";

function emit(level: LogLevel, message: string, fields: LogFields): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  // WARN and above go to stderr so `docker compose logs` (and any log
  // pipeline that splits stdout/stderr) can separate problems from
  // routine traffic without parsing the JSON first.
  if (level === "WARN" || level === "ERROR" || level === "FATAL") {
    console.error(line);
  } else {
    console.log(line);
  }
}

// Normalizes a caught `unknown` into loggable fields - callers previously
// did `console.error("...", err)` with an Error object appended raw; this
// pulls out just the message/stack so it round-trips through JSON.stringify.
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack };
  }
  return { error: String(err) };
}

export const logger = {
  debug: (message: string, fields: LogFields = {}): void => emit("DEBUG", message, fields),
  info: (message: string, fields: LogFields = {}): void => emit("INFO", message, fields),
  warn: (message: string, fields: LogFields = {}): void => emit("WARN", message, fields),
  error: (message: string, fields: LogFields = {}): void => emit("ERROR", message, fields),
  fatal: (message: string, fields: LogFields = {}): void => emit("FATAL", message, fields),
};
