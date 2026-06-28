import { describe, expect, it } from 'vitest';
import { formatNativeActionErrorMessage } from '../src/extension-server.js';

describe('formatNativeActionErrorMessage', () => {
  it('adds a disambiguation hint for strict locator errors', () => {
    const message = formatNativeActionErrorMessage(
      'click',
      'text=Edit',
      new Error('locator.click: Error: strict mode violation: locator("text=Edit") resolved to 3 elements'),
    );

    expect(message).toContain('pilot_click text=Edit failed');
    expect(message).toContain('selector matched multiple elements');
    expect(message).toContain('use a unique @ref');
  });

  it('adds viewport and snapshot hints for actionability timeouts', () => {
    const message = formatNativeActionErrorMessage(
      'click',
      '@e5',
      new Error('locator.click: Timeout 5000ms exceeded. element is outside of the viewport'),
    );

    expect(message).toContain('element is not interactable in the viewport');
    expect(message).toContain('run pilot_snapshot');
  });
});
