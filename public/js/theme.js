// Runs before the page paints: pick light or dark from this device's choice or the system setting.
try {
  var t = localStorage.getItem('fc.theme') || 'system';
  if (t === 'system') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* storage blocked: the app sets the theme once it loads */ }
