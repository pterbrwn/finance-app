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
    if(!dirty){closeDialog(dialog);return;}
    askConfirm({message:'Discard your unsaved changes?',confirmLabel:'Discard changes',cancelLabel:'Keep editing',danger:true},documentRef).then(ok=>{if(ok&&dialog.isConnected)closeDialog(dialog);});
  });
  dialog.addEventListener('click', event => {
    const closeControl=event.target.closest('[data-close],[data-cancel],[id^="cancel-"]');
    if(!closeControl||dialog.dataset.discardConfirmed==='true')return;
    const dirty=[...dialog.querySelectorAll('form')].some(form=>form.dataset.dirty==='true');
    if(!dirty)return;
    event.preventDefault();event.stopImmediatePropagation();
    askConfirm({message:'Discard your unsaved changes?',confirmLabel:'Discard changes',cancelLabel:'Keep editing',danger:true},documentRef).then(ok=>{if(!ok||!dialog.isConnected)return;dialog.dataset.discardConfirmed='true';closeControl.click();if(dialog.isConnected)dialog.dataset.discardConfirmed='';});
  }, true);
  documentRef.body.append(dialog);
  dialog.showModal();
}

export function askConfirm({title='Please confirm',message='',confirmLabel='Confirm',cancelLabel='Cancel',danger=false}={},documentRef=document){
  return new Promise(resolve=>{
    const opener=documentRef.activeElement,dialog=documentRef.createElement('dialog'),form=documentRef.createElement('form'),heading=documentRef.createElement('h2'),text=documentRef.createElement('p'),controls=documentRef.createElement('div'),cancel=documentRef.createElement('button'),ok=documentRef.createElement('button');
    dialog.className='confirm-dialog';dialog.setAttribute('role','alertdialog');
    heading.id='confirm-heading-'+Math.random().toString(36).slice(2);text.id=heading.id+'-text';dialog.setAttribute('aria-labelledby',heading.id);dialog.setAttribute('aria-describedby',text.id);
    heading.textContent=title;text.textContent=message;text.dataset.confirmMessage='true';
    controls.className='controls';cancel.type='button';cancel.className='btn';cancel.dataset.confirmCancel='true';cancel.textContent=cancelLabel;ok.type='submit';ok.className='btn primary'+(danger?' danger':'');ok.dataset.confirmOk='true';ok.textContent=confirmLabel;
    controls.append(cancel,ok);form.append(heading,text,controls);dialog.append(form);
    let settled=false;const finish=value=>{if(settled)return;settled=true;dialog.close();dialog.remove();if(opener?.isConnected)opener.focus({preventScroll:true});resolve(value);};
    cancel.addEventListener('click',()=>finish(false));form.addEventListener('submit',event=>{event.preventDefault();finish(true);});
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
    dialog.addEventListener('click',event=>{if(event.target===dialog)finish(false);});
    documentRef.body.append(dialog);dialog.showModal();(danger?cancel:ok).focus();
  });
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
