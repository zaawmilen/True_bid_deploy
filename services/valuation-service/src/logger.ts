export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

export interface LogFields {
  [key: string]: unknown;
}

const SERVICE_NAME = "valuation-service";

function emit(level: LogLevel, message: string, fields: LogFields): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "WARN" || level === "ERROR" || level === "FATAL") {
    console.error(line);
  } else {
    console.log(line);
  }
}

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
