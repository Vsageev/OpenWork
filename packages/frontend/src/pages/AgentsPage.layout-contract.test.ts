import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cssPath = fileURLToPath(new URL('./AgentsPage.module.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

function failContract(options: {
  componentName: string;
  stateInput: string;
  contractName: string;
  expected: string;
  actual: string;
}): never {
  throw new Error(
    `${options.componentName} layout contract violated: stateInput=${options.stateInput} classOrContractName=${options.contractName} expected=${options.expected} actual=${options.actual}`,
  );
}

function ruleBody(selector: string, source = css): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!match) {
    failContract({
      componentName: 'AgentsPage',
      stateInput: 'css-module',
      contractName: selector,
      expected: 'rule exists',
      actual: 'missing',
    });
  }
  return match?.[1] ?? '';
}

function optionalRuleBody(selector: string, source = css): string | null {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? null;
}

function mediaBody(query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) {
    failContract({
      componentName: 'AgentsPage',
      stateInput: 'css-module',
      contractName: query,
      expected: 'media query exists',
      actual: 'missing',
    });
  }
  const blockStart = css.indexOf('{', start);
  let depth = 0;
  for (let index = blockStart; index < css.length; index += 1) {
    const char = css[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return css.slice(blockStart + 1, index);
  }
  throw new Error(`Unclosed media query ${query}`);
}

function expectContractContains(options: {
  componentName: string;
  stateInput: string;
  contractName: string;
  actual: string;
  expected: string;
}) {
  if (!options.actual.includes(options.expected)) {
    failContract({
      componentName: options.componentName,
      stateInput: options.stateInput,
      contractName: options.contractName,
      expected: options.expected,
      actual: options.actual.trim().replace(/\s+/g, ' '),
    });
  }
}

function expectContractNotMatches(options: {
  componentName: string;
  stateInput: string;
  contractName: string;
  actual: string;
  forbidden: RegExp;
}) {
  if (options.forbidden.test(options.actual)) {
    failContract({
      componentName: options.componentName,
      stateInput: options.stateInput,
      contractName: options.contractName,
      expected: `not ${options.forbidden}`,
      actual: options.actual.trim().replace(/\s+/g, ' '),
    });
  }
}

describe('AgentsPage layout contract', () => {
  it('fixture qa-layout-desktop keeps the desktop sidebar in normal flex flow beside chat', () => {
    const container = ruleBody('.container');
    expectContractContains({
      componentName: 'AgentsPage',
      stateInput: 'desktop',
      contractName: '.container',
      actual: container,
      expected: 'display: flex',
    });
    expectContractContains({
      componentName: 'AgentsPage',
      stateInput: 'desktop',
      contractName: '.container',
      actual: container,
      expected: 'overflow: hidden',
    });

    const sidebar = ruleBody('.sidebar');
    expectContractContains({
      componentName: 'AgentsPageSidebar',
      stateInput: 'desktop',
      contractName: '.sidebar',
      actual: sidebar,
      expected: 'width: 320px',
    });
    expectContractContains({
      componentName: 'AgentsPageSidebar',
      stateInput: 'desktop',
      contractName: '.sidebar',
      actual: sidebar,
      expected: 'min-width: 320px',
    });
    expectContractContains({
      componentName: 'AgentsPageSidebar',
      stateInput: 'desktop',
      contractName: '.sidebar',
      actual: sidebar,
      expected: 'display: flex',
    });
    expectContractNotMatches({
      componentName: 'AgentsPageSidebar',
      stateInput: 'desktop',
      contractName: '.sidebar',
      actual: sidebar,
      forbidden: /\bposition\s*:\s*(absolute|fixed)\b/,
    });
    expectContractNotMatches({
      componentName: 'AgentsPageSidebar',
      stateInput: 'desktop',
      contractName: '.sidebar',
      actual: sidebar,
      forbidden: /\bz-index\s*:/,
    });

    const chatPanel = ruleBody('.chatPanel');
    for (const expected of ['flex: 1', 'min-width: 0', 'min-height: 0']) {
      expectContractContains({
        componentName: 'AgentsPageChatPanel',
        stateInput: 'desktop',
        contractName: '.chatPanel',
        actual: chatPanel,
        expected,
      });
    }
  });

  it('fixture qa-layout-tablet keeps the narrow/tablet sidebar out of drawer overlay positioning', () => {
    const tablet = mediaBody('(max-width: 1024px)');
    expect(optionalRuleBody('.sidebar', tablet)).toBeNull();
    expect(optionalRuleBody('.chatPanel', tablet)).toBeNull();
    expectContractNotMatches({
      componentName: 'AgentsPageSidebar',
      stateInput: 'tablet-1024',
      contractName: '@media (max-width: 1024px) .sidebar',
      actual: tablet,
      forbidden: /\.sidebar\s*\{[^}]*\bposition\s*:\s*(absolute|fixed)\b/,
    });
    expectContractNotMatches({
      componentName: 'AgentsPageChatPanel',
      stateInput: 'tablet-1024',
      contractName: '@media (max-width: 1024px) .chatPanel',
      actual: tablet,
      forbidden: /\.chatPanel\s*\{[^}]*display\s*:\s*none\b/,
    });
  });

  it('fixture qa-layout-narrow keeps narrow breakpoints from adding drawer overlay positioning', () => {
    for (const [query, stateInput] of [
      ['(max-width: 640px)', 'narrow-640'],
      ['(max-width: 480px)', 'narrow-480'],
    ] as const) {
      const narrow = mediaBody(query);
      expectContractNotMatches({
        componentName: 'AgentsPageSidebar',
        stateInput,
        contractName: `@media ${query} .sidebar`,
        actual: narrow,
        forbidden: /\.sidebar\s*\{[^}]*\bposition\s*:\s*(absolute|fixed)\b/,
      });
      expectContractNotMatches({
        componentName: 'AgentsPageChatPanel',
        stateInput,
        contractName: `@media ${query} .chatPanel`,
        actual: narrow,
        forbidden: /\.chatPanel\s*\{[^}]*display\s*:\s*none\b/,
      });
    }
  });

  it('negative fixture qa-layout-desktop-forced-drawer fails if desktop sidebar is forced into drawer overlay classes', () => {
    expect(() =>
      expectContractNotMatches({
        componentName: 'AgentsPageSidebar',
        stateInput: 'desktop-forced-drawer-overlay',
        contractName: '.sidebar',
        actual: `${ruleBody('.sidebar')}\nposition: fixed;\nz-index: 30;`,
        forbidden: /\bposition\s*:\s*(absolute|fixed)\b/,
      }),
    ).toThrow(
      /AgentsPageSidebar layout contract violated: stateInput=desktop-forced-drawer-overlay classOrContractName=.sidebar expected=not .* actual=.*position: fixed.*z-index: 30/,
    );
  });

  it('fixture qa-layout-mobile-drawer uses mutually exclusive mobile sidebar/chat states as the only drawer exception', () => {
    const mobile = mediaBody('(max-width: 768px)');

    expectContractContains({
      componentName: 'AgentsPage',
      stateInput: 'mobile-drawer',
      contractName: '.container',
      actual: ruleBody('.container', mobile),
      expected: 'flex-direction: column',
    });
    expectContractContains({
      componentName: 'AgentsPage',
      stateInput: 'mobile-drawer',
      contractName: '.container',
      actual: ruleBody('.container', mobile),
      expected: 'position: relative',
    });

    const mobileSidebar = ruleBody('.sidebar', mobile);
    for (const expected of ['width: 100%', 'min-width: 0', 'border-right: none']) {
      expectContractContains({
        componentName: 'AgentsPageSidebar',
        stateInput: 'mobile-drawer',
        contractName: '.sidebar',
        actual: mobileSidebar,
        expected,
      });
    }

    for (const [contractName, expected] of [
      ['.sidebarMobileOpen', 'flex: 1'],
      ['.sidebarMobileHidden', 'display: none'],
      ['.chatPanelMobileHidden', 'display: none'],
      ['.chatPanelMobileOpen', 'display: flex'],
      ['.mobileBackBtn', 'display: flex'],
    ] as const) {
      expectContractContains({
        componentName: 'AgentsPage',
        stateInput: 'mobile-drawer',
        contractName,
        actual: ruleBody(contractName, mobile),
        expected,
      });
    }
  });
});
