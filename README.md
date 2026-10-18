# inesalonsoo.github.io

Personal site of Inés Alonso. Plain HTML/CSS/JS, no build step.

- `index.html` — the page (hero + research, publications, honors, skills)
- `app.js` — seeded 2‑D free‑energy landscape with an ensemble of particles under overdamped Langevin dynamics; each basin links somewhere. Tapping **the uncertainty box** (the glass cube carried over from the original site) measures the system: the box opens, the cat appears, and the ensemble collapses into one basin with probability equal to its occupancy
- `theme.js` — applies dark/light before first paint
- `style.css` — design tokens (`--bg`, `--ink`, `--accent`, …), dark by default with a light theme
- The landscape is drawn by a WebGL2 fragment shader so the wells can **breathe**: each depth drifts ±9% on its own 9–15 s period, gently moving the contour rings around every basin (the particles feel it too). Without WebGL2 it falls back to a static CPU render. The cube is animated from JS: idle spin, a hover that slows, lifts and leans toward the pointer, and turning to face you when opened. Reduced motion starts paused (▶ turns everything on); the cube still leans toward a hovering pointer
- The **|résumé⟩** basin is a macrostate: three shallow sub-wells the particles hop between quickly. Hover it (tap on touch, or measure into it) and it resolves into `|industry⟩`, `|phd⟩` and `|cv⟩`, each linking to a PDF
- `assets/IAlonso_Resume_Industry.pdf`, `assets/IAlonso_Resume_PhD.pdf`, `assets/IAlonso_CV.pdf` — the three résumés (exported from the `.docx` sources in `resumes/`, which stay out of git). `assets/IAlonso_Resume_2026.pdf` is a copy of the industry one, so old links keep working

Share a landscape with `?seed=xxxxxxxx` (8 hex digits). Keyboard: **Space** measure · **R** new landscape · **P** pause.

Local preview: `python -m http.server 8000` and open http://localhost:8000/.
