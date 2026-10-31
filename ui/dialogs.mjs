const activeSubmissions = new WeakSet();

export function showDialog(dialog, documentRef = document) {
  dialog.returnFocus = documentRef.activeElement;
  for(const form of dialog.querySelectorAll('form')){form.addEventListener('input',()=>{form.dataset.dirty='true';});form.addEventListener('change',()=>{form.dataset.dirty='true';});}
  const heading = dialog.querySelector('h2');
  if (heading) {
    heading.id = heading.id || 'dialog-heading-' + Math.random().toString(36).slice(2);
    dialog.setAttribute('aria-labelledby', heading.id);
  }
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    const dirty=[...dialog.querySelectorAll('form')].some(form=>form.dataset.dirty==='true');
    if(dirty&&!documentRef.defaultView.confirm('Discard your unsaved changes?'))return;
    closeDialog(dialog);
  });
  dialog.addEventListener('click', event => {
    const closeControl=event.target.closest('[data-close],[data-cancel],[id^="cancel-"]');
    if(!closeControl)return;
    const dirty=[...dialog.querySelectorAll('form')].some(form=>form.dataset.dirty==='true');
    if(dirty&&!documentRef.defaultView.confirm('Discard your unsaved changes?')){event.preventDefault();event.stopImmediatePropagation();}
  }, true);
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
