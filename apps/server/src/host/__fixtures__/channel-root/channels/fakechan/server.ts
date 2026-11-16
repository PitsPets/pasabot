/** test:sdk fixture: the smallest channel package discovery must hand to the ChannelRegistry. */
export default {
  kind: 'fakechan',
  configSchema: { parse: (v: unknown) => v },
  secretFields: [],
  async connect() {
    throw new Error('fixture channel never connects');
  },
};
