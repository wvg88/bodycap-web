# Bodycap Web

Bestuur een 3D-skelet met je lichaam voor de webcam, rechtstreeks in de browser. Zonder Blender, zonder iets te installeren behalve Python om de pagina te starten.

```
webcam  →  MediaPipe (web)  →  oplosser met inverse kinematics  →  Three.js-skelet
```

- **Three.js** tekent het skelet (77.648 vertices, 154.476 driehoeken: alle details van het model).
- **MediaPipe Holistic** voor het web herkent je lichaam, handen en gezicht.
- Armen en benen worden opgelost met **inverse kinematics**: je pols en enkel zijn het doel, je elleboog en knie bepalen de buigrichting.

---

## Starten

| Systeem | Wat te doen |
|---|---|
| **macOS** | Dubbelklik `start_mac.command`. De eerste keer: rechtsklik → Open. |
| **Windows** | Dubbelklik `start_windows.bat`. |
| **Zelf** | `python server.py` en open http://localhost:8000 |

De browser opent vanzelf. Klik op **Start camera** en sta de camera toe. De eerste keer worden MediaPipe en het herkenningsmodel gedownload (ongeveer 30 MB); daarna bewaart de browser ze.

Gebruik Chrome, Edge of Safari. Open `index.html` niet rechtstreeks: een pagina mag de camera alleen gebruiken via `http://localhost` of https.

## Gebruiken

1. Ga zo staan dat je **hele lichaam** in beeld is, op 2,5 tot 3 meter van de camera. Zijn alleen je romp en armen in beeld, dan blijven de benen staan.
2. Klik op **Kalibreer** (of druk op **C**). Je krijgt 3 seconden om recht te gaan staan en naar de camera te kijken. Dat corrigeert een camera die scheef, te hoog of te laag staat.
3. Beweeg. Draai met de muis om het skelet heen, zoom met het scrollwiel.

## Bediening

| Onderdeel | Opties |
|---|---|
| **Camera** | Camera kiezen · camerabeeld tonen · herkende punten over het beeld · gezichtsmesh over het beeld · groter/kleiner · herkenning pauzeren |
| **Besturing** | Kalibreer · Wis kalibratie · Rustpose |
| **Onderdelen** | Romp, Hoofd, Armen, Vingers, Benen los aan/uit · Verplaatsing (met schaal) · Gezicht (alleen bij een model met shape keys) |
| | **Inverse kinematics** voor armen en benen · **Voeten op de vloer houden** · **Spiegelen** · **Zichtbaarheid** (onzekere lichaamsdelen blijven staan) |
| **Herkenning** | Smoothing 1–9 · model (Holistic of losse modellen) · nauwkeurigheid · rekenen op GPU of processor · aparte thread |
| **Opnemen** | Start/stop opnemen · afspelen · **download als .glb met animatie** (te importeren in Blender) |
| **Weergave** | Schaduwen · botten tonen · vloer · beeldkwaliteit · camerastandpunt herstellen |
| **Model** | Ander .glb-model laden (ook door het op de pagina te slepen) · botkoppeling per lichaamsdeel |

### Sneltoetsen

| Toets | Functie |
|---|---|
| **C** | Kalibreren |
| **R** | Rustpose |
| **I** | Inverse kinematics aan of uit |
| **V** | Camerabeeld tonen of verbergen |
| **P** | Herkende punten tonen of verbergen |
| **M** | Gezichtsmesh tonen of verbergen |
| **+** / **−** | Meer of minder smoothing |
| **Spatie** | Herkenning pauzeren |

## Soepel beeld

De app is zo gebouwd dat het skelet vloeiend blijft bewegen, ook als de herkenning trager is dan je scherm:

- **De herkenning draait in een aparte thread** (web worker). Het tekenen wacht er nooit op.
- **Het skelet beweegt elk beeld soepel naar de laatst gemeten houding toe.** Ook bij 20 herkenningen per seconde ziet de beweging er op 60 fps vloeiend uit.
- **Het model is verkleind zonder details te verliezen**: 0,7 MB in plaats van 5,3 MB voor de ruwe export, met alle 154.476 driehoeken. Het skelet telt 59 botten in plaats van de 411 van de Rigify-rig.
- **Beeldkwaliteit "Automatisch"** tekent iets minder scherp als de snelheid onder 45 fps zakt, en weer scherper als er ruimte is.

Bovenin zie je drie snelheden: **Beeld** (tekenen), **Herkenning** en **Camera**. Is de herkenning traag?

- Kies onder *Herkenning* **Losse modellen** met nauwkeurigheid **Licht**.
- Zet **Vingers** uit als je ze niet nodig hebt (bij de losse modellen draait het handmodel dan niet).
- Houd *Rekenen op* op **Grafische kaart**.
- Zorg voor genoeg licht: veel webcams leveren in het donker minder beelden per seconde.

**Holistic of losse modellen?** Holistic zoekt je handen vanuit je polsen en vindt ze daardoor ook op afstand. Het losse handmodel vindt kleine handen vaak niet als je met je hele lichaam in beeld staat. Daarom is Holistic de standaard.

## Zonder internet werken

```
python tools/maak_offline.py
```

Dit downloadt MediaPipe (30 MB) en de modellen van Google (65 MB) naar deze map en zet `OFFLINE = true` in `js/config.js`. Terug naar internet: `python tools/maak_offline.py --online`.

Three.js zit al in de map (`vendor/three`).

## Een ander model gebruiken

Sleep een `.glb` op de pagina of kies **Ander model laden**. De app herkent de botnamen van Rigify (DEF-botten), een gewone metarig, Mixamo en eenvoudige namen (`hips`, `upper_arm.L`, ...). Onder *Model → Botkoppeling* kun je de koppeling zelf aanpassen.

De app schrijft de stand van elk bot rechtstreeks, los van de hiërarchie in het bestand. Daardoor werkt ook een export waarin de botten niet netjes aan elkaar hangen.

### Hoe het meegeleverde model is gemaakt

`models/human-skeleton.glb` komt uit `human-skeleton.blend`:

```
blender --background human-skeleton.blend --python tools/export_from_blender.py -- skelet_raw.glb
npx gltfpack -i skelet_raw.glb -o models/human-skeleton.glb -cc -kn -km -vp 16 -vn 10
```

Een gewone export van deze Rigify-rig werkt niet goed: de 77 vervormende botten hangen elk aan een eigen hulpbot met constraints, en constraints bestaan niet in glTF. Het script bouwt daarom een schoon skelet van 59 botten op de rustposities van de rig, past de Mirror-modifier toe (de mesh is in het bestand maar half) en laat Subdivision Surface weg.

## Online zetten

Het is een statische website: zet de map op een webserver met **https** (bijvoorbeeld GitHub Pages of Netlify). Zonder https geeft de browser geen toegang tot de camera.

## Hoe het werkt

| Bestand | Wat het doet |
|---|---|
| `js/app.js` | Three.js-scène, bediening, camerabeeld met overlays |
| `js/tracker.js` | Camera, de worker aansturen, punten filteren (One Euro-filter), handen aan de juiste pols koppelen |
| `js/engine.js` + `js/tracker-worker.js` | MediaPipe, in een aparte thread |
| `js/solver.js` | Van punten naar botstanden: assenstelsels voor romp, hoofd en handen, tweebots-IK voor armen en benen, vingers, kalibratie, vloer |
| `js/recorder.js` | Opnemen, afspelen, exporteren als .glb |
| `js/config.js` | Adressen van MediaPipe en de modellen, camera-instelling |
| `server.py` | Kleine webserver met de juiste bestandstypes |

**Inverse kinematics.** Voor een arm is je pols het doel, gemeten vanaf je schouder en omgerekend naar de armlengte van het model. Met de cosinusregel volgt daaruit waar de elleboog moet komen; je eigen elleboog bepaalt naar welke kant hij uitwijkt. Zet je IK uit, dan nemen boven- en onderarm rechtstreeks de gemeten richtingen over.

## Getest

- **Oplosser**: een bekende houding omgezet naar MediaPipe-punten en terug: 0,02 cm afwijking per gewricht, met IK aan en uit, bij een grotere persoon, met een 18° scheve camera plus kalibratie, en gespiegeld.
- **Hele keten** in Chromium met het echte Holistic-model en testbeelden als nep-webcam (krijgerhouding, squat, sprong): houding, links/rechts, handen en vloercontact kloppen.
- **Niet getest**: een echte webcam en een echte grafische kaart. De gemeten snelheden hierboven gelden dus voor de app zelf, niet voor de herkenning op jouw computer.

## Beperkingen

- Eén camera schat diepte. Bewegingen recht naar de camera toe zijn minder precies.
- Het voorover kantelen van het bekken is niet te zien: het bekken blijft rechtop en de buiging komt in de rug.
- Dit skeletmodel heeft geen gezichtsvormen, dus de optie *Gezicht* is uitgeschakeld. Bij een model met ARKit-shape-keys werkt hij wel.

## Licenties

Three.js (MIT) staat in `vendor/three`. MediaPipe (Apache 2.0) en de herkenningsmodellen komen van Google.
