// Builds DOM with textContent only, so user text can never become markup.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'data') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

export async function api(method, path, { body, admin } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(admin ? { authorization: `Bearer ${admin}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server. Check your connection and try again.' };
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, data, error: data?.error ?? 'Something went wrong. Try again.' };
}

export function hashParts() {
  const [id, secret] = window.location.hash.slice(1).split('.');
  return { id, secret };
}

export function showMessage(host, text, kind = '') {
  host.replaceChildren(text ? el('p', { class: `message ${kind}`, text, role: 'status' }) : '');
}

export function saveFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = el('a', { href: url, download: name });
  link.click();
  URL.revokeObjectURL(url);
}

export async function copyText(text, button) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = label; }, 1500);
}

export const linesOf = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
export const inviteLink = (formId, code) => `${window.location.origin}/join#${formId}.${code}`;
