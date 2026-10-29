const activeSubmissions = new WeakSet();

export function showDialog(dialog, documentRef = document) {
  dialog.returnFocus = documentRef.activeElement;
  const heading = dialog.querySelector('h2');
  if (heading) {
    heading.id = heading.id || 'dialog-heading-' + Math.random().toString(36).slice(2);
    dialog.setAttribute('aria-labelledby', heading.id);
  }
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    closeDialog(dialog);
  }, { once: true });
  documentRef.body.append(dialog);
  dialog.showModal();
}

export function closeDialog(dialog) {
  const target = dialog.returnFocus;
  dialog.close();
  dialog.remove();
  if (target?.isConnected) target.focus({ preventScroll: true });
}

export async function runDialogSubmit(dialog, button, submit) {
  if (activeSubmissions.has(dialog)) return false;
  activeSubmissions.add(dialog);
  if (button) button.disabled = true;
  try {
    return await submit();
  } finally {
    activeSubmissions.delete(dialog);
    if (dialog.open && button) button.disabled = false;
  }
}
