import { describe, expect, it } from 'vitest';
import { mcpEnvironmentKey } from '../lib/mcp-config';

describe('MCP environment key names', () => {
  it.each([
    ['My App', 'MY_APP_MAIL_KEY'],
    ['  my-app / production  ', 'MY_APP_PRODUCTION_MAIL_KEY'],
    ['Café assistant', 'CAFE_ASSISTANT_MAIL_KEY'],
    ['123 app', 'APP_123_APP_MAIL_KEY'],
    ['📬', 'APP_MAIL_KEY'],
    ['My "App" ${test}', 'MY_APP_TEST_MAIL_KEY'],
  ])('makes a portable environment name for %s', (name, expected) => {
    expect(mcpEnvironmentKey(name)).toBe(expected);
  });
});
