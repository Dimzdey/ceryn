export const PROTOCOL_PREFIX = '@@BENCH@@';

export function sendMessage(message) {
  process.stdout.write(`${PROTOCOL_PREFIX}${JSON.stringify(message)}\n`);
}
