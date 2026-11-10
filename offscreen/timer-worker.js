// Timers for the offscreen document. Its own main-thread timers get intensively throttled (one wake-up per minute)
// after it has been hidden and silent for 5 minutes; worker timers are not.
self.onmessage = e => {
  const {id, ms} = e.data;
  setTimeout(() => self.postMessage(id), ms);
};
