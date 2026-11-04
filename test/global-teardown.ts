export default async function globalTeardown() {
  await Promise.all((globalThis.__TEST_CONTAINERS__ ?? []).map((container) => container.stop()));
}
