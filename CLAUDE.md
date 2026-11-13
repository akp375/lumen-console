# Rules for working in lumen-console

The owner is a RevOps and strategy lead acting as product owner. Work in small steps, explain decisions in plain English, and give exact click-or-run instructions.

## Hard rules (never break these)

- Never run `sudo`.
- Never delete with `rm` or `rm -rf`, even inside this folder. If something needs deleting, explain what and why, and ask the owner first.
- Never install anything globally: no `npm install -g`, no `brew install`, no system-wide installers.
- Never read, create, change or delete anything outside `/Users/a/projects/lumen-console`. If a task seems to need that, stop and ask instead of finding a workaround.
- Never print, copy or send the contents of `.env.local` (it holds secret keys).

## Git

- All work happens on the `dev` branch.
- Never commit to, merge into or push `main` unless the owner explicitly says so.
