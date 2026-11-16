/** Web half of the reference module: fills every WebModule slot once. Imports only types from core. */
import type { WebModule } from '@pasabot/core/web';

const Page = () => (
  <section data-slot="route">
    <h1>Example module</h1>
  </section>
);

const mod: WebModule = {
  id: '_example',
  routes: [{ path: '/example', component: Page, titleKey: '_example:page.title' }],
  navItems: [
    {
      id: 'example',
      labelKey: '_example:nav',
      to: '/example',
      icon: 'sparkle',
      group: 'advanced',
      order: 900,
    },
  ],
  settingsSections: [
    {
      id: 'example',
      labelKey: '_example:settings',
      icon: 'sparkle',
      group: 'advanced',
      component: () => <p data-slot="settings">settings</p>,
    },
  ],
  messageBlockRenderers: {
    '_example.note': ({ block }) => (
      <aside data-slot="block">{String((block.data as { text?: string }).text ?? '')}</aside>
    ),
  },
  composerActions: [{ id: 'example-note', labelKey: '_example:composer', icon: 'note' }],
  chatHeaderWidgets: [{ id: 'example', component: ({ chatId }) => <span data-slot="header">{chatId}</span> }],
  runEventRenderers: { 'example.step': ({ event }) => <span data-slot="run-event">{event.type}</span> },
  approvalPreviews: {
    example_tool: ({ approval }) => <span data-slot="approval-preview">{approval.id}</span>,
  },
  messageFooters: [
    {
      id: 'example-footer',
      component: ({ message }) => <span data-slot="message-footer">{message.id}</span>,
    },
  ],
  dockPanels: [
    { id: 'example', labelKey: '_example:dock', component: () => <div data-slot="dock">dock</div> },
  ],
  onboardingSteps: [
    { id: 'example', order: 900, component: () => <div data-slot="onboarding">onboarding</div> },
  ],
  topBarItems: [
    {
      id: 'example',
      order: 900,
      component: ({ compact }) => <span data-slot="top-bar">{compact ? 'c' : 'top'}</span>,
    },
  ],
  // nothing to decide in the sample; a real module returns its pending owner decisions here
  decisionSources: [{ id: 'example', useItems: () => [] }],
};
export default mod;
