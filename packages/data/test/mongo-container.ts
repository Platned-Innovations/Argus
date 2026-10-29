import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const MONGO_IMAGE = 'mongo:8.0';

/**
 * A plain single-node MongoDB for tests. Argus does not use transactions, so no replica set is needed;
 * that avoids the replica-set initialisation health check, which is fragile on shared CI runners.
 * The WiredTiger cache is capped so several containers can run side by side.
 */
export async function startMongo(): Promise<{ container: StartedTestContainer; url: string }> {
  const container = await new GenericContainer(MONGO_IMAGE)
    .withCommand(['mongod', '--bind_ip_all', '--wiredTigerCacheSizeGB', '0.25'])
    .withExposedPorts(27017)
    .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
    .withStartupTimeout(120_000)
    .start();
  return { container, url: `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/?directConnection=true` };
}
