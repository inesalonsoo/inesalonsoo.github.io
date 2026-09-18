# inesalonsoo.github.io

Personal site of Inés Alonso. Plain HTML/CSS/JS, no build step.

- `index.html` — the page (hero + research, publications, honors, skills)
- `app.js` — seeded 2‑D free‑energy landscape with an ensemble of particles under overdamped Langevin dynamics; each basin links somewhere. Tapping **the uncertainty box** (the glass cube carried over from the original site) measures the system: the box opens, the cat appears, and the ensemble collapses into one basin with probability equal to its occupancy
- `theme.js` — applies dark/light before first paint
- `style.css` — design tokens (`--bg`, `--ink`, `--accent`, …), dark by default with a light theme
- `assets/IAlonso_Resume_2026.pdf` — the résumé the site links to

Share a landscape with `?seed=xxxxxxxx` (8 hex digits). Keyboard: **Space** measure · **R** new landscape · **P** pause.

Local preview: `python -m http.server 8000` and open http://localhost:8000/.
