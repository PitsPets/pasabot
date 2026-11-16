/** The default profile's name is the web's, in the owner's language (the server sends an empty name, no English). */
import { describe, expect, it } from 'vitest';
import { profileName } from '../web/index.js';

describe('browser profile names', () => {
  it('an unnamed (default) profile is named by the web in the app language; a named one keeps its name', () => {
    const t = (k: string) => (k === 'profile.defaultName' ? 'Agenten-Browser' : k);
    expect(profileName({ name: '' }, t)).toBe('Agenten-Browser');
    expect(profileName({ name: 'Shopping' }, t)).toBe('Shopping');
  });
});
