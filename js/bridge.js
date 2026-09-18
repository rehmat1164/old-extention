export const isExtension = Boolean(globalThis.chrome?.runtime?.id);

export async function call(type, payload = {}) {
  if (!isExtension) throw new Error('Install the test ZIP in Chrome to run automation. This is an interface preview.');
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'The extension did not respond. Reopen the sidebar and try again.');
  return response.data;
}
