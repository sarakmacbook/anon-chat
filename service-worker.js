// Anon Chat service worker — handles web push notifications
self.addEventListener('push', function (event) {
  let data = { title: 'Anon Chat', body: 'New message' };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) {}

  const options = {
    body: data.body || 'New message',
    icon: '/icon.png',
    badge: '/icon.png',
    tag: data.room || 'anon-chat',
    renotify: true,
    data: { room: data.room || 'private' }
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Anon Chat', options)
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
