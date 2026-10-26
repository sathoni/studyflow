/**
 * The one screen without a key (SPEC-v3 §2 "Personal link"): calm, one line
 * of explanation, and a paste field as the fallback. No login, no account.
 */

import { h, fill } from '../ui/dom.ts';
import { adoptKey, extractKey } from '../lib/access.ts';

export function renderNoKey(root: HTMLElement, reason: 'missing' | 'malformed', onKey: () => void): void {
  const input = h('input', {
    class: 'nokey-input',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'Plak hier je link',
    'aria-label': 'Je persoonlijke link',
  });
  const error = h('p', { class: 'nokey-error', role: 'alert' });

  const submit = (event: Event) => {
    event.preventDefault();
    const key = extractKey(input.value);
    if (!key) {
      error.textContent = 'Dat lijkt geen StudyFlow-link. Plak de hele link die je kreeg.';
      return;
    }
    adoptKey(key);
    onKey();
  };

  fill(
    root,
    h(
      'main',
      { class: 'nokey' },
      h('div', { class: 'nokey-logo', 'aria-hidden': 'true' }),
      h('h1', { text: 'Open StudyFlow via je persoonlijke link' }),
      h('p', {
        class: 'nokey-lead',
        text:
          reason === 'malformed'
            ? 'Deze link is niet volledig. Open de link opnieuw, of plak hem hieronder.'
            : 'Tik op de link die je van Claude kreeg. Daarna kan je StudyFlow vanuit Safari op je beginscherm zetten.',
      }),
      h(
        'form',
        { class: 'nokey-form', on: { submit } },
        input,
        h('button', { class: 'btn btn-primary', type: 'submit', text: 'Openen' }),
      ),
      error,
      h('a', { class: 'nokey-demo', href: '#demo', text: 'Bekijk de demo' }),
    ),
  );
}
