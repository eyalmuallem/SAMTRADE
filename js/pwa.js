if ('serviceWorker' in navigator) {
  addEventListener('load', async () => {
    try { await navigator.serviceWorker.register('./sw.js'); }
    catch (error) { console.error('Service Worker לא נטען:', error); }
  });
}
