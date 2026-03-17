import type { ChatWidgetConfig, ChatMessage } from './types.js';
import { ChatApiClient } from './api.js';
import { getChatCSS } from './styles.js';

// SVG icons
const CHAT_ICON = `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const SEND_ICON = `<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

const SESSION_KEY = 'ws_chat_session';
const VISITOR_KEY = 'ws_chat_visitor';
const POLL_INTERVAL = 4000;

function getOrCreateSessionId(): string {
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = `wc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(SESSION_KEY, sessionId);
  }
  return sessionId;
}

function getStoredVisitor(): { name?: string; email?: string } | null {
  try {
    const raw = localStorage.getItem(VISITOR_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeVisitor(info: { name?: string; email?: string }): void {
  localStorage.setItem(VISITOR_KEY, JSON.stringify(info));
}

function formatTime(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function renderChatWidget(
  container: HTMLElement,
  config: ChatWidgetConfig,
  api: ChatApiClient,
  widgetId: string,
): void {
  const shadow = container.attachShadow({ mode: 'open' });

  // Inject styles
  const style = document.createElement('style');
  style.textContent = getChatCSS(config.brandColor);
  shadow.appendChild(style);

  const posClass = config.position === 'bottom-left' ? 'left' : 'right';
  const sessionId = getOrCreateSessionId();
  let isOpen = false;
  let messages: ChatMessage[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastMessageCount = 0;
  let chatStarted = false;
  let visitorInfo = getStoredVisitor();
  const needsPreChat = (config.requireName || config.requireEmail) && !visitorInfo;

  // --- Launcher button ---
  const launcher = document.createElement('button');
  launcher.className = `ws-chat-launcher ws-chat-launcher--${posClass}`;
  launcher.innerHTML = CHAT_ICON;
  launcher.setAttribute('aria-label', 'Open chat');
  shadow.appendChild(launcher);

  // --- Chat window ---
  const chatWindow = document.createElement('div');
  chatWindow.className = `ws-chat-window ws-chat-window--${posClass}`;
  shadow.appendChild(chatWindow);

  // Header
  const header = document.createElement('div');
  header.className = 'ws-chat-header';
  header.innerHTML = `
    <div>
      <div class="ws-chat-header-title">${escapeHtml(config.name)}</div>
      <div class="ws-chat-header-subtitle">We typically reply in a few minutes</div>
    </div>
    <button class="ws-chat-close" aria-label="Close chat">${CLOSE_ICON}</button>
  `;
  chatWindow.appendChild(header);

  const closeBtn = header.querySelector('.ws-chat-close')!;

  // Pre-chat form (shown if requireName or requireEmail and no stored visitor)
  const preChatForm = document.createElement('div');
  preChatForm.className = 'ws-chat-prechat';
  preChatForm.style.display = 'none';
  chatWindow.appendChild(preChatForm);

  // Messages area
  const messagesArea = document.createElement('div');
  messagesArea.className = 'ws-chat-messages';
  chatWindow.appendChild(messagesArea);

  // Composer
  const composer = document.createElement('div');
  composer.className = 'ws-chat-composer';
  chatWindow.appendChild(composer);

  const input = document.createElement('textarea');
  input.className = 'ws-chat-input';
  input.placeholder = config.placeholderText || 'Type a message...';
  input.rows = 1;
  composer.appendChild(input);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'ws-chat-send';
  sendBtn.innerHTML = SEND_ICON;
  sendBtn.setAttribute('aria-label', 'Send message');
  sendBtn.disabled = true;
  composer.appendChild(sendBtn);

  // Powered by
  const powered = document.createElement('div');
  powered.className = 'ws-chat-powered';
  powered.textContent = 'Powered by OpenWork';
  chatWindow.appendChild(powered);

  // --- Pre-chat form setup ---
  function setupPreChat(): void {
    preChatForm.innerHTML = '';
    const text = document.createElement('p');
    text.className = 'ws-chat-prechat-text';
    text.textContent = 'Before we start, please tell us a bit about yourself:';
    preChatForm.appendChild(text);

    let nameInput: HTMLInputElement | null = null;
    let emailInput: HTMLInputElement | null = null;

    if (config.requireName) {
      nameInput = document.createElement('input');
      nameInput.className = 'ws-chat-prechat-input';
      nameInput.placeholder = 'Your name';
      nameInput.type = 'text';
      preChatForm.appendChild(nameInput);
    }

    if (config.requireEmail) {
      emailInput = document.createElement('input');
      emailInput.className = 'ws-chat-prechat-input';
      emailInput.placeholder = 'Your email';
      emailInput.type = 'email';
      preChatForm.appendChild(emailInput);
    }

    const submit = document.createElement('button');
    submit.className = 'ws-chat-prechat-submit';
    submit.textContent = 'Start Chat';
    preChatForm.appendChild(submit);

    submit.addEventListener('click', () => {
      const name = nameInput?.value.trim();
      const email = emailInput?.value.trim();

      if (config.requireName && !name) {
        nameInput?.focus();
        return;
      }
      if (config.requireEmail && !email) {
        emailInput?.focus();
        return;
      }

      visitorInfo = { name, email };
      storeVisitor(visitorInfo);
      showChatView();
    });
  }

  // --- Rendering ---
  function renderMessages(): void {
    messagesArea.innerHTML = '';

    if (messages.length === 0) {
      const welcome = document.createElement('div');
      welcome.className = 'ws-chat-welcome';
      welcome.textContent = config.welcomeMessage;
      messagesArea.appendChild(welcome);
      return;
    }

    for (const msg of messages) {
      const msgEl = document.createElement('div');
      msgEl.className = `ws-chat-msg ws-chat-msg--${msg.direction === 'inbound' ? 'inbound' : 'outbound'}`;

      let html = '';
      if (msg.direction === 'outbound' && msg.sender) {
        html += `<div class="ws-chat-msg-sender">${escapeHtml(msg.sender.firstName || 'Agent')}</div>`;
      }
      html += `<div>${escapeHtml(msg.content ?? '')}</div>`;
      html += `<span class="ws-chat-msg-time">${formatTime(msg.createdAt)}</span>`;
      msgEl.innerHTML = html;
      messagesArea.appendChild(msgEl);
    }

    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function showChatView(): void {
    preChatForm.style.display = 'none';
    messagesArea.style.display = 'flex';
    composer.style.display = 'flex';
    chatStarted = true;
    loadMessages();
    startPolling();
  }

  function showPreChatView(): void {
    preChatForm.style.display = 'flex';
    messagesArea.style.display = 'none';
    composer.style.display = 'none';
    setupPreChat();
  }

  // --- API interactions ---
  async function loadMessages(): Promise<void> {
    try {
      const result = await api.getMessages(widgetId, sessionId);
      messages = result.entries;
      lastMessageCount = messages.length;
      renderMessages();
    } catch {
      // Silently fail on initial load
    }
  }

  async function pollForNewMessages(): Promise<void> {
    try {
      const result = await api.getMessages(widgetId, sessionId);
      if (result.entries.length !== lastMessageCount) {
        messages = result.entries;
        lastMessageCount = messages.length;
        renderMessages();
      }
    } catch {
      // Silently fail on polling
    }
  }

  function startPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollForNewMessages, POLL_INTERVAL);
  }

  function stopPolling(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function handleSend(): Promise<void> {
    const content = input.value.trim();
    if (!content) return;

    // Optimistic: show message immediately
    const optimistic: ChatMessage = {
      id: `temp_${Date.now()}`,
      direction: 'inbound',
      content,
      createdAt: new Date().toISOString(),
    };
    messages.push(optimistic);
    renderMessages();

    input.value = '';
    sendBtn.disabled = true;
    autoResizeInput();

    try {
      const result = await api.sendMessage(widgetId, sessionId, content, visitorInfo ?? undefined);

      // Replace optimistic message with real data
      const idx = messages.findIndex((m) => m.id === optimistic.id);
      if (idx >= 0) {
        messages[idx] = { ...optimistic, id: result.messageId ?? optimistic.id };
      }

      // Add auto-greeting response if present
      if (result.greeting) {
        messages.push({
          id: result.greeting.id,
          direction: 'outbound',
          content: result.greeting.content,
          createdAt: result.greeting.createdAt,
        });
      }

      lastMessageCount = messages.length;
      renderMessages();
    } catch {
      // Remove optimistic on failure and show the text back
      messages = messages.filter((m) => m.id !== optimistic.id);
      renderMessages();
      input.value = content;
      sendBtn.disabled = false;
    }
  }

  // --- Auto-resize textarea ---
  function autoResizeInput(): void {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 80) + 'px';
  }

  // --- Toggle open/close ---
  function toggleChat(): void {
    isOpen = !isOpen;

    if (isOpen) {
      chatWindow.classList.add('ws-chat-window--open');
      launcher.innerHTML = CLOSE_ICON;

      if (needsPreChat && !chatStarted) {
        showPreChatView();
      } else {
        showChatView();
      }

      // Focus input after transition
      setTimeout(() => {
        if (chatStarted) input.focus();
      }, 300);
    } else {
      chatWindow.classList.remove('ws-chat-window--open');
      launcher.innerHTML = CHAT_ICON;
      stopPolling();
    }
  }

  // --- Event listeners ---
  launcher.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', toggleChat);

  input.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    autoResizeInput();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  sendBtn.addEventListener('click', handleSend);

  // --- Auto-greeting trigger ---
  if (config.autoGreetingEnabled && !needsPreChat) {
    // If no pre-chat required, we can start the session immediately when opened
    // The auto-greeting will come as part of the first message exchange
  }
}

export function renderChatError(container: HTMLElement, message: string): void {
  const shadow = container.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = getChatCSS('#2D2D2D');
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.className = 'ws-chat-error';
  wrapper.textContent = message;
  shadow.appendChild(wrapper);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
