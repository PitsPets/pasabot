/**
 * Settings home > "This app" (owner only, Windows and Linux): Quit PasaBot and Open at sign-in, so the app works
 * fully without a tray icon. The desktop launcher offers them (server `GET /api/v1/desktop`, desktop-bridge.ts); a
 * server without it (Docker, `pasabot start`) and the macOS app (its own menus have both) offer nothing, and then
 * nothing is drawn.
 */
import { Button, Icon, Switch } from '@pasabot/ui';
import { useEffect, useState } from 'react';
import { api, post } from '../app/api.js';
import { useT } from '../app/i18n.js';

interface DesktopView {
  quit: boolean;
  autostart: boolean;
  autostartAvailable: boolean;
}

export function AppControls() {
  const t = useT();
  const [v, setV] = useState<DesktopView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [quitting, setQuitting] = useState(false);
  useEffect(() => {
    let live = true;
    api<DesktopView>('/api/v1/desktop')
      .then((r) => live && setV(r))
      .catch(() => live && setV(null));
    return () => {
      live = false;
    };
  }, []);
  if (!v || (!v.quit && !v.autostartAvailable)) return null;

  const setSignIn = async (on: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      const r = await post<DesktopView>('/api/v1/desktop/autostart', { on });
      setV(r);
      if (r.autostart !== on) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const quit = async () => {
    setFailed(false);
    try {
      await post('/api/v1/desktop/quit');
      setQuitting(true);
    } catch {
      setFailed(true);
    }
  };

  return (
    <section className="bk-card panel set-advanced" aria-labelledby="set-app" data-testid="settings-app">
      <h2 id="set-app" className="row-ic">
        <Icon name="monitor" />
        <span>{t('settings.app.title')}</span>
      </h2>
      {v.autostartAvailable && (
        <div className="set-advanced-row">
          <div>
            <p>{t('settings.app.signIn')}</p>
            <p className="muted">{t('settings.app.signInHint')}</p>
          </div>
          <Switch
            checked={v.autostart}
            onChange={(on) => void setSignIn(on)}
            disabled={busy || quitting}
            label={v.autostart ? t('settings.switchOn') : t('settings.switchOff')}
            ariaLabel={t('settings.app.signIn')}
            testId="settings-app-signin"
          />
        </div>
      )}
      {v.quit && (
        <div className="set-advanced-row">
          <p className="muted">{quitting ? t('settings.app.quitting') : t('settings.app.quitHint')}</p>
          <Button onClick={() => void quit()} disabled={quitting} data-testid="settings-app-quit">
            <Icon name="stop" />
            <span>{t('settings.app.quit')}</span>
          </Button>
        </div>
      )}
      {failed && (
        <p className="muted" role="alert">
          {t('settings.app.failed')}
        </p>
      )}
    </section>
  );
}
