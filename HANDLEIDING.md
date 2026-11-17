# De Dart Struners online zetten

Met deze handleiding zet je De Dart Struners op internet. Daarna heb je één vaste link die werkt op je telefoon, op de monitor in de dartruimte en voor medespelers die thuis meekijken.

Reken op ongeveer 20 minuten. Je hebt twee gratis accounts nodig (GitHub en Render) en een betaalpas of creditcard voor Render.

---

## Wat zit er in deze map

| Bestand | Wat het doet |
|---|---|
| `server.js` | Het programmaatje dat de app online aanbiedt en de stand bewaart |
| `public/index.html` | De app zelf |
| `render.yaml` | De instellingen voor Render, zodat je bijna niets zelf hoeft in te stellen |
| `package.json` | Vertelt Render hoe de app gestart wordt |

Er hoeven geen extra programma's geïnstalleerd te worden.

---

## Stap 1: GitHub-account en opslagplaats

GitHub is de plek waar je bestanden staan. Render haalt de app daar op.

1. Ga naar **github.com** en maak een gratis account aan. Heb je er al een, log dan in.
2. Klik rechtsboven op **+** en kies **New repository**.
3. Vul bij *Repository name* in: `dart-struners`.
4. Kies **Private**, zodat alleen jij de bestanden ziet.
5. Klik op **Create repository**.
6. Klik op de pagina die verschijnt op de link **uploading an existing file**.
7. Pak het zip-bestand uit op je computer. Sleep **de inhoud** van de map naar het venster: `server.js`, `package.json`, `render.yaml`, `HANDLEIDING.md` en de map `public`.
   Let op: sleep niet de map zelf, maar wat erin zit. Controleer dat `public/index.html` in de lijst staat.
8. Klik onderaan op **Commit changes**.

---

## Stap 2: Render-account en de app starten

Render draait de app voor je op internet.

1. Ga naar **render.com** en kies **Get Started**. Meld je aan met **GitHub**, dan zijn ze meteen aan elkaar gekoppeld.
2. Voeg bij *Billing* een betaalmethode toe. De app draait op het *Starter*-abonnement met 1 GB opslag. Kijk op render.com/pricing voor de actuele prijs. Bij het maken van deze handleiding was dat ongeveer $7 per maand plus een paar dubbeltjes voor de opslag.
3. Klik op **New +** en kies **Blueprint**.
4. Kies je opslagplaats `dart-struners`. Geef Render toestemming als daarom gevraagd wordt.
5. Render leest `render.yaml` en vraagt om **ADMIN_PIN**. Vul hier je **beheerderscode** in, minimaal 4 tekens.
   Iedereen met deze code kan scores invoeren en uitslagen veranderen, dus kies iets dat je niet zomaar raadt, en schrijf het op.
6. Klik op **Apply**. Render bouwt en start de app. Dat duurt een paar minuten.
7. Als het klaar is, staat er bovenaan een link, ongeveer zo: `https://dart-struners.onrender.com`. Dat is jouw app.

---

## Stap 3: Je gegevens overzetten vanuit claude.ai

1. Open je huidige app op claude.ai.
2. Scrol naar onderen en klik op **Gegevens exporteren**, daarna op **Kopieer**.
3. Open de nieuwe online app en log in met je beheerderscode.
4. Scrol naar onderen naar **Gegevens** en kies **Importeren door plakken**.
5. Plak de tekst en klik op **Importeren**.

Je spelers, competitie en uitslagen staan nu online.

---

## Gebruiken

| Wie | Link | Wat ze kunnen |
|---|---|---|
| Jij (beheerder) | `https://…onrender.com` | Inloggen met de code, scores invoeren, alles beheren |
| Monitor in de dartruimte | `https://…onrender.com/monitor` | Groot scorebord met live stand. Kies *Start met geluid* voor de omroeper |
| Medespelers | `https://…onrender.com/kijk` | Live meekijken op hun telefoon, zonder code. Ze kunnen niets veranderen |

Onderaan de app staan de links met een **Kopieer**-knop, zodat je ze makkelijk kunt delen.

### Vriendensessies
Op het inlogscherm staat **Nieuwe sessie starten**. Vrienden krijgen dan een eigen link (`…/s/abc123`) met een eigen sessiecode, los van de competitie. In een sessie kies je **Toernooi**, **1 tegen 1** of het **Checkout-spel**. Elke sessie heeft ook een eigen monitor- en meekijklink. Een sessie die 30 dagen niet gebruikt wordt, verdwijnt vanzelf.

### Checkout-spel
Voor 1 of 2 spelers. Je krijgt een getal tussen 41 en 60 en hebt 3 pijlen om uit te gooien. De app toont de mogelijke routes. Gelukt? Dan volgt een nieuw getal. Mis je, dan blijft het getal staan (bij 2 spelers is de ander aan de beurt). Met **Stoppen** zie je de uitslag.

### Solo en korte spellen
Onder **1 tegen 1** kies je ook **Solo**: alleen oefenen met een aantal legs (1, 3, 5 of 10). Je ziet je gemiddelde en het aantal pijlen. Bij elk spel kun je nu ook **101** en **201** kiezen.

### Bullen
Bij elke wedstrijd vraagt de app eerst wie het dichtst bij de bull gooide. Die speler begint de eerste leg; daarna wisselt het per leg.

### Chat voor kijkers
Op de meekijkpagina kunnen kijkers chatten met alleen een naam. Nieuwe berichten verschijnen ook even op de monitor. Je kunt als beheerder berichten verwijderen of de chat uitzetten. Elke ochtend om 6 uur begint de chat leeg.

**Tip:** zet de app op het beginscherm van je telefoon. Open de link, kies in het menu van je browser **Toevoegen aan beginscherm**, en hij opent voortaan als een gewone app.

---

## Goed om te weten

- **Reservekopie:** klik af en toe op **Exporteren** onderaan de app. Dan heb je een bestand met alle gegevens.
- **Code vergeten of wijzigen:** in Render ga je naar je app, dan **Environment**, en pas je `ADMIN_PIN` aan. De app herstart vanzelf.
- **Te vaak een verkeerde code:** na 5 foute pogingen wacht de app 5 minuten voordat je het opnieuw kunt proberen.
- **Bijwerken:** krijg je van mij een nieuwe versie, vervang dan in GitHub de gewijzigde bestanden (*Add file → Upload files*). Render werkt de app daarna vanzelf bij.
- **Stoppen:** in Render kun je de app pauzeren (*Suspend*) of verwijderen. Dan betaal je ook niet meer.

---

## Later: automatisch tellen met de camera's

Als je Autodarts-camera's thuis goed werken, bouwen we hierop verder. De online server krijgt dan een koppeling met Autodarts, zodat pijlen automatisch binnenkomen, ook op andere locaties met Autodarts-camera's.
