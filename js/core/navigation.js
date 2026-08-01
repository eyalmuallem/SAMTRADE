const VIEW_TITLES = {
  dashboard: 'ראשי',
  portfolio: 'תמונת מצב',
  market: 'נתוני מניות',
  journal: 'יומן',
  statistics: 'סטטיסטיקות',
  history: 'היסטוריה',
  settings: 'הגדרות'
};

export function initNavigation(onChange) {
  const buttons = [...document.querySelectorAll('[data-view-target]')];
  const views = [...document.querySelectorAll('[data-view]')];

  function show(name) {
    const viewName = Object.prototype.hasOwnProperty.call(VIEW_TITLES, name) ? name : 'dashboard';

    buttons.forEach(button => {
      button.classList.toggle('active', button.dataset.viewTarget === viewName);
    });

    views.forEach(view => {
      view.classList.toggle('active', view.dataset.view === viewName);
    });

    document.title = `SAMTRADE · ${VIEW_TITLES[viewName]}`;
    history.replaceState(null, '', `#${viewName}`);
    if (onChange) onChange(viewName);
  }

  buttons.forEach(button => {
    button.addEventListener('click', () => show(button.dataset.viewTarget));
  });

  const initial = location.hash.slice(1);
  show(Object.prototype.hasOwnProperty.call(VIEW_TITLES, initial) ? initial : 'dashboard');
  return show;
}
