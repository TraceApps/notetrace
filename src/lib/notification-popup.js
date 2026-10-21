import { writable } from 'svelte/store';

export function createNotificationPopup({ schedule = setTimeout, cancel = clearTimeout, duration = 6000 } = {}) {
  const store = writable(null);
  let timer;
  function dismiss() { cancel(timer); timer = undefined; store.set(null); }
  return {
    subscribe: store.subscribe,
    show(entry) {
      cancel(timer);
      store.set(entry);
      timer = schedule(dismiss, duration);
    },
    dismiss,
  };
}

export const notificationPopup = createNotificationPopup();
