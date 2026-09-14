# AR Cue Familiarization — Meta Quest 3

A five-minute WebXR passthrough demonstration built with Three.js. The app locates headset-supplied floor and table surfaces, asks the user to confirm the room setup, and introduces five visual and audio features using the supplied delivery bag and focus moon models.

## Five features

Each feature lasts 60 seconds: a semi-transparent white title appears for 3 seconds, then disappears before the objects appear. The title sits 1.4 m away and covers 40% of the projected view area; small transparent captions identify each variation.

1. **Two types of objects:** delivery bag and focus moon together.
2. **Size:** one delivery bag at 14, 28, and 48 cm on its longest side.
3. **Distance and placement:** near, middle, far, tabletop, and floor positions.
4. **Motion:** still, slow floating, faster floating, approaching, and receding.
5. **Sound:** matched appearance cycles with silence, one subtle chime, or repeated spatial chimes.

## Setup

Use **Node.js 22.12+** and **PowerShell 7.4+** on Windows. From the project folder:

```powershell
npm ci
pwsh -File scripts/setup-https.ps1
npm run dev
```

The HTTPS script creates a local development certificate and prints the Quest URL on port **5182**. Run it again after changing Wi-Fi networks, then restart the development server. Use `-IpAddress <Wi-Fi IPv4>` if automatic address selection is ambiguous.

Open the printed HTTPS URL in **Meta Quest Browser on the same Wi-Fi** as the computer. Accept the local certificate warning, or provide a certificate trusted by the headset. Local network traffic to the server must be allowed.

For the desktop preview, open [https://localhost:5182/](https://localhost:5182/). Desktop playback uses a simulated room.

## Room setup

1. Select **Enter passthrough AR** and allow room access.
2. Look around to locate the floor and table. Confirm highlighted unlabelled surfaces with a trigger: floor first, then table.
3. If surfaces are missing, press **Left Y** for room capture when supported, or complete **Space Setup / Room Setup** in Quest settings and re-enter AR.
4. Check the marked surfaces, face the table with clear floor nearby, and press a trigger to begin. Remain comfortably in place; look down for the floor example.

## Controls

| Input | Action |
| --- | --- |
| Either trigger | Confirm, start, pause/resume, or restart after completion |
| Left X / Right A | Previous / next feature |
| Right B | Replay the current feature and its title |
| Left Y | Rescan the room |
| Browser Exit AR | Exit the immersive session |
| Desktop Space / arrows / R | Pause/resume / previous-next / replay |

Desktop buttons provide the same playback actions. Drag and scroll to inspect the landing preview.

## Verification

```powershell
npm test
npm run build
npm run test:browser
```

Browser checks require a running development server, Playwright (`npm install --no-save playwright`), and Chromium (`npx playwright install chromium`). Reports and screenshots are saved in `.codex-run/browser/`.

Physical Quest 3 operation has not yet been validated. Desktop and mocked-XR checks do not establish real passthrough, room alignment, viewing comfort, or audible headset output. Placement uses available plane boundaries; hit-test-only setup has unknown surface extents and does not provide full-room collision avoidance or physical occlusion.
