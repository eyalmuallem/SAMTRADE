const THEME_STORAGE_KEY = 'samtrade_theme';
export function initTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    const preferred = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = saved || preferred;
  } catch (_) { document.documentElement.dataset.theme = 'light'; }
}
export function getCurrentTheme(){ return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
export function syncThemeControl(){
  const label=document.getElementById('themeLabel'); const button=document.getElementById('themeToggle'); const dark=getCurrentTheme()==='dark';
  if(label) label.textContent=dark?'מצב בהיר':'מצב כהה';
  if(button){ const text=dark?'מעבר למצב בהיר':'מעבר למצב כהה'; button.setAttribute('aria-label',text); button.title=text; }
}
export function setTheme(theme,persist=true){ const value=theme==='dark'?'dark':'light'; document.documentElement.dataset.theme=value; if(persist){try{localStorage.setItem(THEME_STORAGE_KEY,value)}catch(_){}} syncThemeControl(); window.dispatchEvent(new CustomEvent('samtrade:themechange',{detail:{theme:value}})); }
export function toggleTheme(){ setTheme(getCurrentTheme()==='dark'?'light':'dark'); }
