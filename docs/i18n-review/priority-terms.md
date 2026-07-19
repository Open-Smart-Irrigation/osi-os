# Priority terms for native / domain review

Terms the translators flagged as coined or without in-repo precedent, shown across all
locales so a reviewer can see the divergence. English source first, then each rendering.
Full context for any string is in the per-locale CSV (search the key).

## STREGA valve state: closed-box interval

- **key:** `devices:stregaValve.intervalLabel`
- **en:** Closed-box interval (minutes)
- **de-CH:** Meldeintervall bei geschlossenem Gehäuse (Minuten)
- **fr:** Intervalle boîtier fermé (minutes)
- **it:** Intervallo a scatola chiusa (minuti)
- **es:** Intervalo de caja cerrada (minutos)
- **pt:** Intervalo de caixa fechada (minutos)
- **lg:** Ebbanga ery'okuggala akasanduuko (edakiika)

## STREGA valve note (tamper + intervals)

- **key:** `devices:stregaValve.intervalNote`
- **en:** OSI sets the normal closed-box interval on FPort 11. The opened interval stays fixed at 2 minutes and tamper remains enabled.
- **de-CH:** OSI legt das normale Meldeintervall bei geschlossenem Gehäuse auf FPort 11 fest. Das Intervall bei geöffnetem Gehäuse bleibt fest bei 2 Minuten, und die Manipulationserkennung bleibt aktiviert.
- **fr:** OSI définit l'intervalle normal en boîtier fermé sur le FPort 11. L'intervalle en boîtier ouvert reste fixé à 2 minutes et la détection d'intrusion reste activée.
- **it:** OSI imposta l'intervallo normale a scatola chiusa sulla FPort 11. L'intervallo a scatola aperta rimane fisso a 2 minuti e il rilevamento manomissioni resta attivo.
- **es:** OSI establece el intervalo normal de caja cerrada en FPort 11. El intervalo de caja abierta permanece fijo en 2 minutos y la protección antimanipulación permanece activada.
- **pt:** A OSI define o intervalo normal de caixa fechada no FPort 11. O intervalo de caixa aberta permanece fixo em 2 minutos e a deteção de adulteração permanece ativada.
- **lg:** OSI eteekawo ebbanga ery'obulijjo ery'okuggala akasanduuko ku FPort 11. Ebbanga ery'okuggulawo akasanduuko lisigala ku dakiika 2, era 'tamper' esigala nga ekola.

## Tamper stays enabled phrasing

- **key:** `devices:kiwiSensor.intervalNote`
- **en:** Kiwi interval changes use LoRaWAN FPort 100. Enter whole minutes between 1 and 1440.
- **de-CH:** Kiwi-Intervalländerungen verwenden LoRaWAN FPort 100. Geben Sie eine ganze Zahl von Minuten zwischen 1 und 1440 ein.
- **fr:** Les changements d'intervalle Kiwi utilisent le FPort 100 LoRaWAN. Entrez un nombre entier de minutes entre 1 et 1440.
- **it:** Le modifiche dell'intervallo Kiwi utilizzano LoRaWAN FPort 100. Inserisci un numero intero di minuti tra 1 e 1440.
- **es:** Los cambios de intervalo de Kiwi usan LoRaWAN FPort 100. Introduce un número entero de minutos entre 1 y 1440.
- **pt:** As alterações de intervalo do Kiwi usam o FPort 100 do LoRaWAN. Introduza um número inteiro de minutos entre 1 e 1440.
- **lg:** Enkyukakyuka mu bbanga lya Kiwi zikozesa LoRaWAN FPort 100. Yingiza edakiika enzijuvu wakati wa 1 ne 1440.

## Plot (land unit)

- **key:** `journal:capture.confirm.plot`
- **en:** Plot
- **de-CH:** Parzelle
- **fr:** Parcelle
- **it:** Particella
- **es:** Parcela
- **pt:** Parcela
- **lg:** Omusiri

## Layout (was "Growing setting")

- **key:** `journal:capture.where.layout`
- **en:** Layout
- **de-CH:** Layout
- **fr:** Layout
- **it:** Layout
- **es:** Layout
- **pt:** Layout
- **lg:** Layout

## Draft status

- **key:** `journal:row.status.draft`
- **en:** Draft
- **de-CH:** Entwurf
- **fr:** Brouillon
- **it:** Bozza
- **es:** Borrador
- **pt:** Rascunho
- **lg:** Kitannamala

## Voided status

- **key:** `journal:row.status.voided`
- **en:** Voided
- **de-CH:** Storniert
- **fr:** Annulé
- **it:** Annullato
- **es:** Anulado
- **pt:** Anulado
- **lg:** Kisaziddwamu

## Never seen

- **key:** `devices:stregaValve.neverSeen`
- **en:** Never seen
- **de-CH:** Nie gesehen
- **fr:** Jamais vu
- **it:** Mai rilevato
- **es:** Nunca visto
- **pt:** Nunca visto
- **lg:** Tekalabikangako

## Force sync

- **key:** `accountLink:sync.button`
- **en:** Force sync now
- **de-CH:** Synchronisierung jetzt erzwingen
- **fr:** Forcer la synchronisation maintenant
- **it:** Forza sincronizzazione ora
- **es:** Forzar sincronización ahora
- **pt:** Forçar sincronização agora
- **lg:** Sinkroniza Kaakano

## Additional flags by locale (from the translator reports)

- **de-CH:** *tamper* -> Manipulationserkennung; closed/opened box -> geschlossenem/geoeffnetem Gehaeuse; *Bootstrap* / *Outbox* / *Sync-Token* kept as loanwords.
- **fr:** *tamper* -> detection d'intrusion; box -> boitier ferme/ouvert; *Bootstrap* / *Outbox* kept as loanwords.
- **it:** *tamper* -> rilevamento manomissioni; box -> scatola chiusa/aperta; minute(s) -> minuto/i shorthand.
- **es:** *tamper* -> proteccion antimanipulacion; box -> caja cerrada/abierta; *uplink* / *Bootstrap* / *Outbox* loanwords; note: settings rendered CONFIGURACION here vs Ajustes in settings.json (reconcile).
- **pt:** *tamper* -> detecao de adulteracao; box -> caixa fechada/aberta; *Bootstrap* / *Outbox* loanwords; note: a pre-existing string (waitingForUplink) reads Brazilian (aguardando) vs the European standard elsewhere.
- **lg (live Uganda gateway - highest stakes):** *Omusiri* (plot, newly coined, distinct from *Ekitundu*=zone); *Kitannamala* (draft); *Tekalabikangako* (never seen); valve box -> akasanduuko phrasing (translator deliberately did NOT reuse existing possibly-wrong forms); *tamper* kept as an English loan inside a Luganda sentence; spelling *Ebbanga* vs *Ebanga* inconsistent in the existing file; *eg.* kept over *okugeza* to match shipped convention.
