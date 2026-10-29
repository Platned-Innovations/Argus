import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export const MONGO_IMAGE = process.env.ARGUS_TEST_MONGO_IMAGE ?? 'mongo:8.0';

/**
 * A plain single-node MongoDB for tests. Argus does not use transactions, so no replica set is needed.
 * The WiredTiger cache is capped so several containers can run side by side.
 * If mongod fails to start, its own output is included in the error so CI logs show the real cause.
 */
export async function startMongo(): Promise<{ container: StartedTestContainer; url: string }> {
  const output: string[] = [];
  try {
    const container = await new GenericContainer(MONGO_IMAGE)
      .withCommand(['mongod', '--bind_ip_all', '--wiredTigerCacheSizeGB', '0.25'])
      // MongoDB 8 refuses to start on Linux 6.19+ kernels (SERVER-121912), which GitHub's runners now use, while
      // TCMalloc per-CPU caches are active. glibc owning rseq turns those caches off and lets mongod start.
      .withEnvironment({ GLIBC_TUNABLES: 'glibc.pthread.rseq=1' })
      .withExposedPorts(27017)
      .withLogConsumer((stream) => stream.on('data', (line: Buffer | string) => output.push(String(line).trimEnd())))
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
      .withStartupTimeout(120_000)
      .start();
    return { container, url: `mongodb://${container.getHost()}:${container.getMappedPort(27017)}/?directConnection=true` };
  } catch (err) {
    const tail = output.slice(-40).join('\n');
    throw new Error(`${err instanceof Error ? err.message : String(err)}\n--- ${MONGO_IMAGE} output ---\n${tail || '(no output)'}`);
  }
}
