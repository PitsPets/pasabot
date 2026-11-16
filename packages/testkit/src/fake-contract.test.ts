import { FakeMemoryBackend, FakeProvider, runMemoryContract, runProviderContract } from './index.js';

// runProviderContract(fake): the reference adapter must pass its own suite.
runProviderContract(new FakeProvider(), { inProcess: true });

// runMemoryContract(fake): the reference memory backend passes the suite every MemoryBackend must pass.
runMemoryContract('fake', () => ({ backend: new FakeMemoryBackend() }));
