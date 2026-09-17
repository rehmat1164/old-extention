const DOWNLOAD_SESSION_KEY = 'autoMetaCopy_downloadSession';

const failedPage = document.getElementById('failedPromptsPage');
const panel = failedPage?.querySelector('#aiRetryStatusPanel');
const topTab = document.getElementById('failedPromptsTopTab');
const phaseLabel = failedPage?.querySelector('#aiRetryPhaseLabel');
const totalNum = failedPage?.querySelector('#aiRetryTotalNum');
const successNum = failedPage?.querySelector('#aiRetrySuccessNum');
const leftNum = failedPage?.querySelector('#aiRetryLeftNum');
const promptList = failedPage?.querySelector('#aiRetryPromptList');
const bulkOriginalBtn = failedPage?.querySelector('#copyAllFailedPromptsBtn');
const bulkAiBtn = failedPage?.querySelector('#copyAllAiFailedPromptsBtn');

const PHASE_LABELS = {
  live: 'Failed prompts detected during automation',
  sending: 'Sending failed prompts to NVIDIA Qwen AI...',
  retrying: 'Retrying AI-edited prompts on Meta AI...',
  round2: 'Round 2: sending still-failed prompts to AI...',
  retrying2: 'Round 2 retry in progress...',
  round3: 'Round 3: using object-only safe fallback...',
  retrying3: 'Round 3 fallback retry in progress...',
  done: 'AI retry complete.',
  waiting: 'Waiting for failed prompts...'
};

const STATUS_LABELS = {
  queued: 'Queued',
  sending: 'Sending to AI',
  edited: 'AI Edited',
  retrying: 'Retrying',
  success: 'Fixed',
  failed: 'Failed',
  timeout: 'Timed Out',
  failed2: 'Round 2 Fail',
  unrecoverable: 'Unrecoverable'
};

function esc(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function promptNumber(fp) {
  const index = Number(fp?.index);
  return Number.isFinite(index) ? index + 1 : Number(fp?.promptNumber || 1);
}

function normalizePrompt(fp) {
  const edited = fp.editedPrompt || fp.aiEditedPrompt || '';
  const original = fp.originalPrompt || (edited && edited !== fp.prompt ? fp.prompt : '') || fp.prompt || '';
  return {
    ...fp,
    promptNumber: promptNumber(fp),
    originalPrompt: original,
    editedPrompt: edited,
    status: fp.status || 'queued'
  };
}

function textForPrompt(item, type) {
  const prompt = normalizePrompt(item);
  return type === 'ai'
    ? (prompt.editedPrompt || '')
    : (prompt.originalPrompt || prompt.prompt || '');
}

async function copyText(text, button) {
  const value = String(text || '').trim();
  if (!value) return;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch (_) {
        copied = false;
      }
    }
    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.left = '-1000px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      copied = document.execCommand('copy');
      textarea.remove();
    }
    if (!copied) throw new Error('Clipboard copy was blocked');
    if (button) {
      const oldTitle = button.title;
      const icon = button.querySelector('.material-symbols-rounded');
      const oldIcon = icon?.textContent;
      button.classList.add('copied');
      if (icon) icon.textContent = 'check';
      button.title = 'Copied';
      setTimeout(() => {
        button.classList.remove('copied');
        if (icon && oldIcon) icon.textContent = oldIcon;
        button.title = oldTitle;
      }, 1100);
    }
  } catch (error) {
    console.warn('[AI Retry Panel] copy failed:', error);
  }
}

function buildLiveStateFromSession(session) {
  const failedPrompts = (session?.prompts || [])
    .filter(prompt => ['failed', 'timeout', 'unrecoverable'].includes(prompt.status))
    .map(prompt => normalizePrompt({
      index: Number(prompt.index),
      prompt: prompt.prompt || '',
      originalPrompt: prompt.originalPrompt || prompt.prompt || '',
      editedPrompt: prompt.aiEditedPrompt || '',
      status: prompt.status || 'failed',
      round: prompt.aiEditedPrompt ? 2 : 1,
      retryReason: prompt.retryReason || ''
    }));

  return failedPrompts.length ? { phase: 'live', failedPrompts } : null;
}

function renderPrompt(fp, renderIndex) {
  const item = normalizePrompt(fp);
  const label = STATUS_LABELS[item.status] || item.status;
  const chipCls = `chip-${item.status}`;
  const roundBadge = Number(item.round) > 1
    ? `<span style="font-size:0.6rem;font-weight:900;padding:1px 5px;border-radius:99px;background:#0F3D8C;color:#fff;margin-right:4px">R${esc(item.round)}</span>`
    : '';
  const originalText = item.originalPrompt || item.prompt || '';
  const editedText = item.editedPrompt || '';
  const hasEdit = !!editedText && editedText !== originalText;
  const reason = item.retryReason
    ? `<div class="ai-retry-reason">Reason: ${esc(item.retryReason)}</div>`
    : '';

  return `<div class="ai-retry-prompt-row status-${esc(item.status)}">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span class="ai-retry-prompt-num">Prompt ${esc(item.promptNumber)}</span>
        ${roundBadge}
        <span class="ai-retry-status-chip ${esc(chipCls)}">${esc(label)}</span>
      </div>
      <div class="ai-retry-message-stack">
        <div class="ai-retry-chat-row original">
          <div class="ai-retry-chat-avatar">
            <span class="material-symbols-rounded" style="font-size:15px">person</span>
          </div>
          <div class="ai-retry-message original">
            <div class="ai-retry-message-label">
              <span class="material-symbols-rounded" style="font-size:14px">history</span>
              Original
              <button type="button" class="ai-retry-copy-btn" data-copy-kind="original" data-copy-index="${renderIndex}" title="Copy original prompt">
                <span class="material-symbols-rounded">content_copy</span>
              </button>
            </div>
            <div class="ai-retry-message-body">${esc(originalText)}</div>
          </div>
        </div>
        ${hasEdit ? `<div class="ai-retry-chat-row ai">
          <div class="ai-retry-chat-avatar">
            <span class="material-symbols-rounded" style="font-size:15px">auto_fix_high</span>
          </div>
          <div class="ai-retry-message ai">
            <div class="ai-retry-message-label">
              <span class="material-symbols-rounded" style="font-size:14px">auto_fix_high</span>
              AI Edited
              <button type="button" class="ai-retry-copy-btn ai" data-copy-kind="ai" data-copy-index="${renderIndex}" title="Copy AI edited prompt">
                <span class="material-symbols-rounded">content_copy</span>
              </button>
            </div>
            <div class="ai-retry-message-body">${esc(editedText)}</div>
          </div>
        </div>` : `<div class="ai-retry-edit-preview">AI edited prompt is not available yet.</div>`}
      </div>
      ${reason}
    </div>
  </div>`;
}

function renderPanel(aiState) {
  if (!panel) return;

  const failedPrompts = (aiState?.failedPrompts || []).map(normalizePrompt);
  const phase = aiState?.phase || 'waiting';

  panel.style.display = 'block';
  if (topTab) topTab.style.display = 'flex';
  if (phaseLabel) phaseLabel.textContent = PHASE_LABELS[phase] || phase;

  const total = failedPrompts.length;
  const success = failedPrompts.filter(fp => fp.status === 'success').length;
  const left = failedPrompts.filter(fp => fp.status !== 'success').length;

  if (totalNum) totalNum.textContent = total;
  if (successNum) successNum.textContent = success;
  if (leftNum) leftNum.textContent = left;

  if (!promptList) return;
  latestFailedPrompts = failedPrompts;
  if (!total) {
    promptList.innerHTML = `<div class="ai-retry-empty">
      <span class="material-symbols-rounded">radar</span>
      <span>AI Auto-Retry is on. Waiting for failed prompts to repair.</span>
    </div>`;
    return;
  }

  promptList.innerHTML = failedPrompts.map((prompt, index) => renderPrompt(prompt, index)).join('');
}

function hidePanel() {
  if (panel) panel.style.display = 'none';
  if (promptList) promptList.innerHTML = '';
  latestFailedPrompts = [];
  lastHash = '';
}

let lastHash = '';
let latestFailedPrompts = [];

async function pollAiRetryPanel() {
  try {
    const data = await chrome.storage.local.get([DOWNLOAD_SESSION_KEY, 'aiRetryEnabled']);
    const session = data[DOWNLOAD_SESSION_KEY] || {};
    const hasCurrentSessionPrompts = !!session?.id && Array.isArray(session.prompts) && session.prompts.length > 0;

    if (!hasCurrentSessionPrompts) {
      const emptyState = { phase: 'waiting', failedPrompts: [] };
      const hash = JSON.stringify(emptyState);
      if (hash !== lastHash) {
        lastHash = hash;
        renderPanel(emptyState);
      }
      return;
    }

    const aiState = session.aiRetryState;
    const state = aiState?.failedPrompts?.length ? aiState : buildLiveStateFromSession(session) || {
      phase: 'waiting',
      failedPrompts: []
    };
    const hash = JSON.stringify(state);
    if (hash === lastHash) return;

    lastHash = hash;
    renderPanel(state);
  } catch (error) {
    console.warn('[AI Retry Panel] update failed:', error);
  }
}

if (panel) {
  setInterval(pollAiRetryPanel, 2000);
  pollAiRetryPanel();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[DOWNLOAD_SESSION_KEY] || changes.aiRetryEnabled)) {
      pollAiRetryPanel();
    }
  });

  promptList?.addEventListener('click', event => {
    const button = event.target.closest('[data-copy-kind][data-copy-index]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const item = latestFailedPrompts[Number(button.dataset.copyIndex)];
    copyText(textForPrompt(item, button.dataset.copyKind), button);
  });

  bulkOriginalBtn?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const text = latestFailedPrompts
      .map(item => `Prompt ${item.promptNumber}\n${textForPrompt(item, 'original')}`)
      .filter(Boolean)
      .join('\n\n');
    copyText(text, bulkOriginalBtn);
  });

  bulkAiBtn?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const text = latestFailedPrompts
      .map(item => {
        const ai = textForPrompt(item, 'ai');
        return ai ? `Prompt ${item.promptNumber}\n${ai}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    copyText(text, bulkAiBtn);
  });
}
