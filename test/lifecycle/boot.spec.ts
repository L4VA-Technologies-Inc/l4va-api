import { createTestApp, type TestApp } from './helpers/app';

describe('lifecycle test harness', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  it('boots the app and runs a lifecycle tick on an empty database', async () => {
    await expect(t.tick()).resolves.toBeUndefined();
    expect(t.alerts).not.toHaveBeenCalled();
  });
});
