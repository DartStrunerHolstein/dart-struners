# Doorgeefprogramma voor Autodarts

Dit programma draait op de computer bij het dartbord, naast Autodarts. Elke pijl die de camera's herkennen, stuurt het door naar De Dart Struners. De telefoon telt dan automatisch mee.

## Eén keer klaarzetten

1. Zet de camera's op het bord en installeer **Autodarts** op de laptop. Kalibreer en controleer in Autodarts dat de pijlen goed herkend worden.
2. Zet deze map op de laptop (of op een USB-stick).
3. Dubbelklik op **START-BORD.bat**. De eerste keer downloadt hij Node.js (eenmalig, ongeveer 30 MB).
4. Beantwoord de vragen:
   - **Link van de website**: `dartstruners.alwaysdata.net`, of de link van een vriendensessie (`…/s/abc123`).
   - **Code**: je beheerderscode (of de sessiecode bij een vriendensessie).
   - **Waar draait Autodarts?** Kies **1** als Autodarts op deze laptop draait, of **2** om het bord in het netwerk te zoeken.

De antwoorden worden bewaard in `bord-instellingen.json`. Daarna start hij meteen.

## Spelen

1. Start Autodarts en daarna **START-BORD.bat**. Laat het venster open.
2. Open op je telefoon de wedstrijd (of het checkout-spel) en zet de knop **Camera** aan. Het bolletje wordt groen.
3. Gooien. Elke pijl verschijnt vanzelf op de telefoon en op de monitor.
4. Pijlen eruit halen = volgende beurt.

**Klopt een pijl niet?** Tik op de telefoon op het vakje van die pijl en kies de goede. Of verbeter hem in Autodarts zelf, dan komt de verbetering ook door.

**Bullen** tik je zoals altijd zelf aan op de telefoon.

## Bij een ander bord / andere locatie

Neem deze map mee op een USB-stick. Start **START-BORD.bat --opnieuw** (of verwijder `bord-instellingen.json`) en kies **Zoeken in het netwerk**, of laat het programma op hun computer draaien met optie 1.

## Testen zonder camera's

Start in een opdrachtvenster: `START-BORD.bat --test`. Dan typ je zelf pijlen (bijv. `T20`, `D16`, `BULL`, `M` voor mis, `W` voor pijlen eruit) en zie je ze op de telefoon verschijnen.

## Bordcode (optioneel)

Wil je niet je beheerderscode op een andere computer achterlaten? Zet in alwaysdata bij Environment ook `BORD_PIN=<eigen code>` en herstart de site. Die code kan alleen pijlen doorgeven.
