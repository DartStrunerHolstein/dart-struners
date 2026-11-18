# Doorgeefprogramma voor Autodarts

Dit programma draait op de computer bij het dartbord, naast Autodarts. Elke pijl die de camera's herkennen, stuurt het door naar De Dart Struners. Je telefoon, tablet of computer telt dan automatisch mee.

## Starten

1. Start **Autodarts** en controleer dat de herkenning aan staat (*Started*).
2. Dubbelklik op **START-BORD.bat**. De eerste keer downloadt hij Node.js (eenmalig, ongeveer 30 MB).
   Zegt Windows *Windows heeft uw pc beschermd*? Klik op **Meer info** en dan **Toch uitvoeren**.
3. Het programma zoekt Autodarts zelf en laat een **koppelcode** zien, bijvoorbeeld **K7P2**. Laat dit venster open.

## Koppelen (één keer)

Open op je telefoon (of tablet/computer) de wedstrijd of het checkout-spel en tik op **Camera**. Typ de koppelcode en tik op **Koppelen**. Het bolletje wordt groen. Je apparaat onthoudt de code, dus de volgende keer tik je alleen op **Camera**.

Werkt overal: in de competitie, in een vriendensessie en bij het checkout-spel voor iedereen.

## Spelen

- Gooi: elke pijl verschijnt vanzelf.
- Pijlen eruit halen = volgende beurt.
- Klopt een pijl niet? Tik op het vakje en kies de goede.
- **Bullen** tik je zelf aan.
- Camera uit = gewoon zelf invullen.
- Ziet de camera een pijl niet en vul je hem zelf in (bijv. **Mis**)? Dan reset de laptop Autodarts vanzelf, zodat de volgende speler weer gewoon geteld wordt. In het venster staat dan "Autodarts gereset". Met de hand kan het ook: tik in de app onder Camera op **Autodarts resetten**.

## Andere locatie of nieuwe code

Start `START-BORD.bat --opnieuw`. Dan zoekt hij Autodarts opnieuw (op deze computer of in het netwerk) en krijg je een nieuwe koppelcode.

## Testen zonder camera's

Start in een opdrachtvenster: `START-BORD.bat --test`. Dan typ je zelf pijlen (bijv. `T20`, `D16`, `BULL`, `M` voor mis, `W` voor pijlen eruit).

## Gaat er iets mis?

In deze map komt het bestand **bord-log.txt** met wat Autodarts precies doorgaf. Stuur dat (of een foto van het venster) naar Patrick.
