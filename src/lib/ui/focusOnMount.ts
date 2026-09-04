/**
 * Focus an element the moment it mounts; a text field also gets its caret
 * placed at the end.
 *
 * The `autofocus` attribute is not this: Chromium honours it only for
 * elements present at document load, so a dynamically inserted inline editor
 * that relies on it mounts with a dead keyboard: focus stays on whatever
 * button opened the editor, typing goes nowhere, Enter re-presses the button.
 */
export function focusOnMount(node: HTMLElement): void {
  node.focus();
  if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement)) return;
  const end = node.value.length;
  try {
    node.setSelectionRange(end, end);
  } catch {
    /* number/date inputs disallow selection; focus alone is the point */
  }
}
