// Copies text, falling back to a hidden textarea where the async clipboard API
// is unavailable (an insecure origin, an older WebView).
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);

  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.focus();
  el.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy unavailable");
    return Promise.resolve();
  } finally {
    document.body.removeChild(el);
  }
}
