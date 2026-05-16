import { describe, expect, it } from 'vitest';
import { recordFromLegacyRow, recordsFromLegacyRows } from './native-repository-utils.js';

describe('native repository legacy row normalization', () => {
  it('keeps mapped SQL columns when legacy data is missing newer fields', () => {
    expect(
      recordFromLegacyRow({
        id: 'agent-one',
        name: 'Agent One',
        workspacePath: '/tmp/openwork/agent-one',
        legacyData: {
          name: 'Old Agent Name',
          description: 'from legacy payload',
        },
      }),
    ).toEqual({
      id: 'agent-one',
      name: 'Agent One',
      workspacePath: '/tmp/openwork/agent-one',
      description: 'from legacy payload',
    });
  });

  it('omits legacyData from normalized rows', () => {
    expect(
      recordsFromLegacyRows([
        {
          id: 'user-one',
          email: 'user-one@example.test',
          legacyData: {
            firstName: 'Legacy',
          },
        },
      ]),
    ).toEqual([
      {
        id: 'user-one',
        email: 'user-one@example.test',
        firstName: 'Legacy',
      },
    ]);
  });
});
