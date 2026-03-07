import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnvironment, importFresh } from '../support/test-env.ts';

const env = setupTestEnvironment('backend-unit-agent-chat-title');

test('first outbound image message with caption auto-titles the conversation', async () => {
  const { store } = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
  const {
    createAgentConversation,
    saveAgentConversationMessage,
  } = await importFresh<typeof import('../../src/services/agent-chat.ts')>(
    '../../src/services/agent-chat.ts',
  );

  await store.init();

  const conversation = createAgentConversation('agent-1');
  saveAgentConversationMessage({
    conversationId: conversation.id as string,
    direction: 'outbound',
    content: 'Check this screenshot please',
    type: 'image',
    attachments: [
      {
        type: 'image',
        fileName: 'screenshot.png',
        mimeType: 'image/png',
        fileSize: 123,
        storagePath: '/chat-uploads/screenshot.png',
      },
    ],
  });

  const updated = store.getById('conversations', conversation.id as string);
  assert.equal(updated?.subject, 'Check this screenshot please');
});

test('first outbound image message without caption auto-titles from filenames', async () => {
  const { store } = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
  const {
    createAgentConversation,
    saveAgentConversationMessage,
  } = await importFresh<typeof import('../../src/services/agent-chat.ts')>(
    '../../src/services/agent-chat.ts',
  );

  await store.init();

  const conversation = createAgentConversation('agent-1');
  saveAgentConversationMessage({
    conversationId: conversation.id as string,
    direction: 'outbound',
    content: '',
    type: 'image',
    attachments: [
      {
        type: 'image',
        fileName: 'whiteboard.jpg',
        mimeType: 'image/jpeg',
        fileSize: 456,
        storagePath: '/chat-uploads/whiteboard.jpg',
      },
    ],
  });

  const updated = store.getById('conversations', conversation.id as string);
  assert.equal(updated?.subject, 'Image: whiteboard.jpg');
});

after(async () => {
  const { store } = await importFresh<typeof import('../../src/db/index.ts')>('../../src/db/index.ts');
  await store.flush();
  env.cleanup();
});
