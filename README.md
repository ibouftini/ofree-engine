# ofree-engine

Fast, zero-configuration LaTeX builds on GitHub Actions.

**Status: early development.** This repository currently holds measurement spikes. The engine itself is not usable yet.

## Goal

Beat the most-used LaTeX action, `xu-cheng/latex-action`, on its own ground, on the same documents and the same GitHub-hosted runners:

- the same or higher success rate;
- a lower median job time, both on first runs and on repeat runs;
- fewer billed minutes.

Its median job spends 84 s downloading a 2.3 GiB TeX Live image to compile for 14 s. A typical document needs about 2 % of that image. This engine installs only what each document needs, and reuses it on later runs.

## Layout

| Path | Content |
|---|---|
| `tools/` | Measurement spikes and helpers |
| `bench/samples/` | Small documents used by the spikes |
| `.github/workflows/spike-provision.yml` | Spike: timing of cold and warm TeX Live provisioning against the incumbent |
