# AR Familiarization

A simple Meta Quest 3 WebXR passthrough demonstration: **enter AR, detect a real table, and watch all five features play automatically**. No virtual table is rendered. Playback cannot start without an active AR session and a detected tabletop; there is no desktop playback bypass.

## Sequence

1. **Two types of objects:** delivery bag and focus moon together.
2. **Size:** Small, Medium, and Large, with a 1 : 3.5 : 8 size ratio and no measurement suffix.
3. **Distance and placement:** the nearest, middle, and farthest usable positions on the scanned tabletop.
4. **Motion:** still, slow floating, faster floating, then one arc from far upper left to the table and out to the upper right.
5. **Sound:** one silent appearance, one appearance with a brief chime, then one sustained appearance with seven faster chimes. The captions are **no sound**, **quick sound**, and **repetitive sound**, respectively.

Each feature lasts 18 seconds: a 3-second translucent white English title, then 15 seconds of objects. The full sequence lasts 90 seconds. Category panels are half their previous area (about 6.7% of the projected view), at 1.4 m. Start/end panels use large centred text without smaller subtitles. Size, distance, and sound each have three 5-second variations; motion has four 3.75-second variations. Silent and single-sound objects each appear once, separated by a brief gap; only the final sound condition repeats its short chime, every 0.75 seconds. Stationary objects use the detected tabletop and adapt to its boundary; the final movement deliberately travels above and outside it. All text is English. Audio consists of nonverbal spatial chimes.

## Run

Use Node.js 22.12+ and PowerShell 7.4+ on Windows:

```powershell
npm ci
pwsh -File scripts/setup-https.ps1
npm run dev
```

Open the printed HTTPS URL on port **5182** in Meta Quest Browser, using the same Wi-Fi as the computer. Accept the local development certificate or use a trusted certificate. The network must allow local LAN traffic.

Select **Enter AR**, allow room access, and look steadily at the tabletop. Detection starts playback automatically. If needed and supported, the app opens the headset room scan once. If no table data is available, include the table in Quest **Space Setup** and re-enter. Browser/OS permission prompts still require your response. Use Quest's system controls to exit AR.

To view the entry page on a computer, run `npm run desktop` and open [http://127.0.0.1:5183/](http://127.0.0.1:5183/). This address listens only on the local computer. It does not display a simulated table or play the cues. Use the HTTPS address on Quest 3 for scanning and playback.

## Verify

```powershell
npm test
npm run build
npm run test:browser
```

Browser checks need a running server, Playwright, and Chromium. Install them if needed with `npm install --no-save playwright` and `npx playwright install chromium`.

Desktop and mocked-XR checks do not replace physical Quest testing. The app uses headset-supplied planes or stable hit-test samples, not camera-image recognition. Hit-test-only placement has unknown surface boundaries; full-room collision avoidance and physical occlusion are not provided.
