import type { Logger } from '../shared/infrastructure.js';

/**
 * A JSON-lines logger on stdout and stderr. Callers pass structured fields and a short message; none of them
 * ever passes a secret, and request bodies and message text are never logged.
 */
export function createLogger(
  base: object = {},
  write: (level: string, line: string) => void = (level, line) => {
    (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
  },
): Logger {
  const emit = (level: string, fields: object, message?: string): void => {
    write(
      level,
      JSON.stringify({ level, time: new Date().toISOString(), ...base, ...fields, msg: message }),
    );
  };
  return {
    info: (o, m) => emit('info', o, m),
    warn: (o, m) => emit('warn', o, m),
    error: (o, m) => emit('error', o, m),
    child: (b) => createLogger({ ...base, ...b }, write),
  };
}

export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
