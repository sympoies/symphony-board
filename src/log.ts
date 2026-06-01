// Minimal timestamped logger. Operational scripts log through this so the
// always-on Docker loop output correlates with wall-clock time. JSON / contract
// output is written raw to stdout elsewhere and must NOT go through here (a
// timestamp prefix would corrupt machine-consumed output).
const ts = (): string => new Date().toISOString();

export const log = {
  info: (msg: string): void => console.log(`${ts()} ${msg}`),
  warn: (msg: string): void => console.warn(`${ts()} WARN ${msg}`),
  error: (msg: string): void => console.error(`${ts()} ERROR ${msg}`),
};
