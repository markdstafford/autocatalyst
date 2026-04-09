import { Service } from './service.js';

export function registerSignalHandlers(service: Service): () => void {
  let stopping = false;

  const handler = () => {
    if (stopping) return; // prevent double-stop
    stopping = true;
    service.stop();
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);

  return () => {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  };
}
