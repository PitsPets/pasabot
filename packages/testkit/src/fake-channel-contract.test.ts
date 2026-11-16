import { FakeChannel, FakeChannelPlatform, runChannelContract } from './index.js';

// runChannelContract(fake): the reference channel adapter must pass its own suite.
runChannelContract('fake', async () => {
  const platform = new FakeChannelPlatform();
  return {
    adapter: new FakeChannel(platform),
    config: { token: platform.token },
    badConfig: { token: 'wrong-token' },
    platform,
    cleanup: async () => {},
  };
});
