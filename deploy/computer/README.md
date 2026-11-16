# deploy/computer — the Xvfb image layer (W16)

The Linux `ComputerDriver` in `modules/computer` needs three helpers on the server's `PATH`: `Xvfb` (a virtual
X display), `xdotool` (pointer and keys) and ImageMagick's `import` (screenshots). This folder holds the image
layer that provides them and the Docker proof of the whole path.

- `Dockerfile`, stage `computer`: node 22 + the three helpers, non-root. The main image (W20) builds on it.
- `Dockerfile`, stage `proof`: adds Python Tk and runs `modules/computer`'s tests with `PASABOT_LIVE_XVFB=1`, which
  turns on `src/xvfb-live.test.ts`: the agent takes a screenshot and clicks the button of `test-app.py` on its own
  Xvfb display through `/mcp` (each action a tier-3 approval), and the owner's viewer endpoint returns the frame.
- `test-app.py`: a 400x200 Tk window that is one button; pressing it prints `pressed` and exits 0.

```sh
deploy/computer/proof.sh        # = the two commands below, from the repo root
docker build -f deploy/computer/Dockerfile --target proof -t pasabot-computer-proof .
docker run --rm pasabot-computer-proof
```

`Dockerfile.dockerignore` (BuildKit reads it for this Dockerfile only) keeps the build context to the sources: a
maintainer's `node_modules` (macOS native builds), local data, keys and screenshots never reach the image, and
`pnpm install` runs fresh inside it. Not run on the macOS build machine (no Docker there): the Linux proof is
unverified until someone runs `proof.sh` on a machine with Docker.

No X server starts at boot: the server starts one Xvfb per agent on that agent's first approved action
(`-displayfd`, so it picks a free display; never the owner's `$DISPLAY`; a per-display `-auth` cookie under
`$PASABOT_HOME`; `-nolisten tcp -nolisten local`) and stops it when the
owner presses Stop display, after 30 idle minutes, or when the server exits. There is no VNC port to publish: the
owner watches in the web app's **Computer** screen.
