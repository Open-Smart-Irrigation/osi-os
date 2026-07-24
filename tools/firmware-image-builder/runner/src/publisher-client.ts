import { createPublisherClient, type PublisherClient, type PublisherClientOptions } from '../../publisher/client.js';

export type RunnerPublisherClient = PublisherClient;

export function createRunnerPublisherClient(options: PublisherClientOptions): RunnerPublisherClient {
  return createPublisherClient(options);
}
