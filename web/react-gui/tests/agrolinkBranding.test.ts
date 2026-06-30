import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const reactRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(reactRoot, '..', '..');

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readReactJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(reactRoot, relativePath), 'utf8'));
}

function readJsonAt(root: string, relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function listJsonFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsonFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.json') ? [fullPath] : [];
  });
}

describe('AgroLink branding source contracts', () => {
  it('keeps source locale resources mirrored into the shipped GUI feed bundle', () => {
    const sourceLocaleRoot = path.join(reactRoot, 'public', 'locales');
    const feedLocaleRoot = path.join(repoRoot, 'feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales');

    for (const locale of ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg']) {
      for (const namespace of ['auth.json', 'dashboard.json', 'devices.json', 'history.json']) {
        const relativePath = path.join(locale, namespace);
        assert.deepEqual(
          readJsonAt(feedLocaleRoot, relativePath),
          readJsonAt(sourceLocaleRoot, relativePath),
          `${relativePath} is mirrored into the feed GUI bundle`,
        );
      }
    }
  });

  it('uses AgroLink auth copy in supported brand languages', () => {
    const expectedRegisterSubtitles: Record<string, string> = {
      en: 'Register for AgroLink',
      'de-CH': 'Für AgroLink registrieren',
      fr: "S'inscrire à AgroLink",
      it: 'Registrati ad AgroLink',
      es: 'Regístrate en AgroLink',
      pt: 'Registe-se no AgroLink',
      lg: 'Wandiika mu AgroLink',
    };

    for (const [locale, registerSubtitle] of Object.entries(expectedRegisterSubtitles)) {
      const auth = readReactJson(`public/locales/${locale}/auth.json`);
      assert.equal(auth.login.title, 'AgroLink', `${locale} login title`);
      assert.equal(auth.register.subtitle, registerSubtitle, `${locale} register subtitle`);
    }
  });

  it('does not leave Open Smart Irrigation product copy in locale resources', () => {
    const localeRoot = path.join(reactRoot, 'public', 'locales');
    const offenders = listJsonFiles(localeRoot).filter((filePath) => (
      /open smart irrigation/i.test(fs.readFileSync(filePath, 'utf8'))
    ));

    assert.deepEqual(offenders.map((filePath) => path.relative(reactRoot, filePath)), []);
  });

  it('keeps dormant dashboard title keys aligned with the brand module', () => {
    for (const locale of ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg']) {
      const dashboard = readReactJson(`public/locales/${locale}/dashboard.json`);
      assert.equal(dashboard.title, 'AgroLink Dashboard', `${locale} dashboard title`);
    }
  });

  it('uses zone terminology in dashboard and create-zone copy', () => {
    const expectedDashboardCopy: Record<string, {
      emptyStateSubtitle: string;
      irrigationZones: string;
      unassignedSubtitle: string;
    }> = {
      en: {
        emptyStateSubtitle: 'Get started by creating a zone and adding devices',
        irrigationZones: 'Zones',
        unassignedSubtitle: 'These devices are not assigned to any zone',
      },
      'de-CH': {
        emptyStateSubtitle: 'Erstellen Sie eine Zone und fügen Sie Geräte hinzu',
        irrigationZones: 'Zonen',
        unassignedSubtitle: 'Diese Geräte sind keiner Zone zugewiesen',
      },
      fr: {
        emptyStateSubtitle: 'Commencez par créer une zone et ajouter des appareils',
        irrigationZones: 'Zones',
        unassignedSubtitle: 'Ces appareils ne sont assignés à aucune zone',
      },
      it: {
        emptyStateSubtitle: 'Inizia creando una zona e aggiungendo dispositivi',
        irrigationZones: 'Zone',
        unassignedSubtitle: 'Questi dispositivi non sono assegnati a nessuna zona',
      },
      es: {
        emptyStateSubtitle: 'Comienza creando una zona y añadiendo dispositivos',
        irrigationZones: 'Zonas',
        unassignedSubtitle: 'Estos dispositivos no están asignados a ninguna zona',
      },
      pt: {
        emptyStateSubtitle: 'Comece por criar uma zona e adicionar dispositivos',
        irrigationZones: 'Zonas',
        unassignedSubtitle: 'Estes dispositivos não estão atribuídos a nenhuma zona',
      },
      lg: {
        emptyStateSubtitle: "Tandika nga otondawo ekifo n'okuwaayo ebyuma",
        irrigationZones: 'Ebifo',
        unassignedSubtitle: 'Ebyuma ebino tebiwerekeddwa ku kifo kyonna',
      },
    };

    const expectedCreateZoneTitles: Record<string, string> = {
      en: 'Create Zone',
      'de-CH': 'Zone erstellen',
      fr: 'Créer une zone',
      it: 'Crea zona',
      es: 'Crear zona',
      pt: 'Criar zona',
      lg: 'Tondawo Ekifo',
    };

    for (const [locale, copy] of Object.entries(expectedDashboardCopy)) {
      const dashboard = readReactJson(`public/locales/${locale}/dashboard.json`);
      assert.equal(dashboard.emptyState.subtitle, copy.emptyStateSubtitle, `${locale} dashboard empty state`);
      assert.equal(dashboard.irrigationZones, copy.irrigationZones, `${locale} dashboard zone heading`);
      assert.equal(dashboard.unassignedSubtitle, copy.unassignedSubtitle, `${locale} dashboard unassigned subtitle`);
    }

    for (const [locale, title] of Object.entries(expectedCreateZoneTitles)) {
      const devices = readReactJson(`public/locales/${locale}/devices.json`);
      assert.equal(devices.createZoneModal.title, title, `${locale} create-zone title`);
    }
  });

  it('localizes thematic history empty-zone copy in all bundled locales', () => {
    const expectedNoZonesBody: Record<string, string> = {
      en: 'Create a zone from the legacy dashboard before opening thematic history.',
      'de-CH': 'Erstellen Sie eine Zone im Legacy-Dashboard, bevor Sie die thematische Historie öffnen.',
      fr: "Créez une zone depuis le tableau de bord hérité avant d'ouvrir l'historique thématique.",
      it: 'Crea una zona dalla dashboard legacy prima di aprire la cronologia tematica.',
      es: 'Crea una zona desde el panel heredado antes de abrir el historial temático.',
      pt: 'Crie uma zona no painel legado antes de abrir o histórico temático.',
      lg: "Tondawo ekifo okuva ku dashboard enkadde nga tonnaggula ebyafaayo by'omulamwa.",
    };

    for (const [locale, noZonesBody] of Object.entries(expectedNoZonesBody)) {
      const history = readReactJson(`public/locales/${locale}/history.json`);
      assert.equal(history.history.shell.noZonesBody, noZonesBody, `${locale} history empty-zone copy`);
    }
  });

  it('keeps data export copy polished in secondary bundled locales', () => {
    const expectedExportCopy: Record<string, {
      data: string;
      export: Record<string, string>;
    }> = {
      fr: {
        data: 'Données',
        export: {
          title: 'Export des données',
          selectRange: 'Choisissez une plage de dates pour télécharger les données de la zone.',
          from: 'De',
          to: 'À',
          granularity: 'Granularité',
          raw: 'Brut',
          hourly: 'Horaire',
          daily: 'Quotidien',
          download: 'Télécharger le CSV',
          downloading: 'Préparation...',
          rangeSummary: '{{from}} à {{to}}',
          error: "Échec de l'export",
          tooLarge: 'Plage trop grande. Choisissez une granularité plus large.',
          fullExport: 'Export complet',
        },
      },
      it: {
        data: 'Dati',
        export: {
          title: 'Esporta dati',
          selectRange: "Scegli un intervallo di date per scaricare i dati della zona.",
          from: 'Da',
          to: 'A',
          granularity: 'Granularità',
          raw: 'Grezzi',
          hourly: 'Orario',
          daily: 'Giornaliero',
          download: 'Scarica CSV',
          downloading: 'Preparazione...',
          rangeSummary: '{{from}} a {{to}}',
          error: 'Esportazione non riuscita',
          tooLarge: "Intervallo troppo grande. Scegli una granularità più ampia.",
          fullExport: 'Esportazione completa',
        },
      },
      pt: {
        data: 'Dados',
        export: {
          title: 'Exportar dados',
          selectRange: 'Escolha um intervalo de datas para descarregar dados da zona.',
          from: 'De',
          to: 'Até',
          granularity: 'Granularidade',
          raw: 'Bruto',
          hourly: 'Horário',
          daily: 'Diário',
          download: 'Descarregar CSV',
          downloading: 'A preparar...',
          rangeSummary: '{{from}} até {{to}}',
          error: 'Falha na exportação',
          tooLarge: 'Intervalo demasiado grande. Escolha uma granularidade mais ampla.',
          fullExport: 'Exportação completa',
        },
      },
      lg: {
        data: 'Data',
        export: {
          title: 'Fulumya data',
          selectRange: "Londa ebbanga ly'ennaku okusobola okuwanula data y'ekifo.",
          from: 'Okuva',
          to: 'Okutuuka',
          granularity: "Obuzito bw'obudde",
          raw: 'Ebitali bikyusiddwa',
          hourly: 'Buli saawa',
          daily: 'Buli lunaku',
          download: 'Wanula CSV',
          downloading: 'Kitegekebwa...',
          rangeSummary: '{{from}} okutuuka {{to}}',
          error: 'Okufulumya kulemereddwa',
          tooLarge: 'Ebbanga ddene nnyo. Londa obuzito obunene.',
          fullExport: 'Okufulumya kwonna',
        },
      },
    };

    for (const [locale, expected] of Object.entries(expectedExportCopy)) {
      const devices = readReactJson(`public/locales/${locale}/devices.json`);
      assert.equal(devices.zone.data, expected.data, `${locale} data label`);
      assert.deepEqual(devices.zone.export, expected.export, `${locale} export copy`);
    }
  });

  it('keeps user-visible locale copy on zone terminology', () => {
    const localeRoot = path.join(reactRoot, 'public', 'locales');
    const forbidden = [
      /irrigation zone/i,
      /irrigation zones/i,
      /bewässerungszone/i,
      /bewässerungszonen/i,
      /zone d'irrigation/i,
      /zones d'irrigation/i,
      /zona di irrigazione/i,
      /zone di irrigazione/i,
      /zona de riego/i,
      /zonas de riego/i,
      /zona de rega/i,
      /zonas de rega/i,
      /ekifo ky'okusukkulirira/i,
      /ebifo by'okusukkulirira/i,
    ];

    const offenders = listJsonFiles(localeRoot).flatMap((filePath) => {
      const text = fs.readFileSync(filePath, 'utf8');
      return forbidden
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${path.relative(reactRoot, filePath)} matches ${pattern}`);
    });

    assert.deepEqual(offenders, []);
  });

  it('does not keep the old OSI logo asset after the login screen moved to Agroscope assets', () => {
    assert.equal(fs.existsSync(path.join(reactRoot, 'src/assets/osi_logo.png')), false);
  });

  it('sets the AgroLink SSID only on supported full Raspberry Pi profiles', () => {
    const pi5Ap = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap';
    const pi4Ap = 'conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap';
    const unsupportedPi1Ap = 'conf/full_raspberrypi_bcm27xx_bcm2708/files/etc/uci-defaults/99_config_chirpstack_ap';
    const expectedLine = 'set wireless.default_radio0.ssid="AgroLink-${GWID_END}"';

    assert.ok(readText(pi5Ap).includes(expectedLine), 'Pi 5 AP script uses AgroLink SSID');
    assert.ok(readText(pi4Ap).includes(expectedLine), 'Pi 4 AP script uses AgroLink SSID');
    assert.equal(readText(pi4Ap), readText(pi5Ap), 'supported Pi 4/Pi 5 AP scripts must match');
    assert.doesNotMatch(readText(unsupportedPi1Ap), /AgroLink/);
  });
});
