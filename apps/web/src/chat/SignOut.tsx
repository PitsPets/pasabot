import { Button, Icon } from '@pasabot/ui';
import { post } from '../app/api.js';
import { useT } from '../app/i18n.js';
import { resetPrefs } from '../app/prefs.js';
import { navigate } from '../app/router.js';
import { resetStore } from '../app/store.js';

export async function signOut() {
  await post('/api/v1/auth/logout').catch(() => {});
  resetStore();
  resetPrefs();
  navigate('/login', true);
  location.reload();
}

export function SignOut() {
  const t = useT();
  const out = signOut;
  return (
    <Button variant="danger" onClick={() => void out()}>
      <Icon name="log-out" />
      <span>{t('settings.signOut')}</span>
    </Button>
  );
}
