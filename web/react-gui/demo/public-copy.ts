import type {i18n as I18nInstance} from 'i18next';

type PublicCopy = {requestSaved: string; emptyRuns: string; sensorAdvice: string; loginHelp: string; accountLinkHelp: string; weatherData: string; weatherConditions: string; cropCoefficient: string; locationAvailable: string; locationUnavailable: string; invalidAccountLink: string; invalidEmail: string; trendNoteMeasured?: string};

const PUBLIC_COPY: Record<string, PublicCopy> = {
  en: {requestSaved: 'Saved.', emptyRuns: 'No valve runs recorded yet.', sensorAdvice: 'Sensor advice', loginHelp: 'Sign in with Demo farmer / demo or create a local account.', accountLinkHelp: 'Enter the server URL and your account credentials.', weatherData: 'Weather data', weatherConditions: 'Weather conditions', cropCoefficient: 'Crop coefficient', locationAvailable: 'Location is available.', locationUnavailable: 'Unable to select the farm location.', invalidAccountLink: 'Enter a server URL, username, and password.', invalidEmail: 'Enter a valid email address.'},
  'de-CH': {requestSaved: 'Gespeichert.', emptyRuns: 'Noch keine Ventilläufe aufgezeichnet.', sensorAdvice: 'Sensorhinweis', loginHelp: 'Melden Sie sich mit Demo farmer / demo an oder erstellen Sie ein lokales Konto.', accountLinkHelp: 'Geben Sie die Server-URL und Ihre Zugangsdaten ein.', weatherData: 'Wetterdaten', weatherConditions: 'Wetterbedingungen', cropCoefficient: 'Kulturkoeffizient', locationAvailable: 'Standort ist verfügbar.', locationUnavailable: 'Der Standort des Betriebs kann nicht ausgewählt werden.', invalidAccountLink: 'Geben Sie die Server-URL, den Benutzernamen und das Passwort ein.', invalidEmail: 'Geben Sie eine gültige E-Mail-Adresse ein.'},
  fr: {requestSaved: 'Enregistrée.', emptyRuns: 'Aucune ouverture de vanne enregistrée pour le moment.', sensorAdvice: 'Conseil des capteurs', loginHelp: 'Connectez-vous avec Demo farmer / demo ou créez un compte local.', accountLinkHelp: 'Saisissez l’URL du serveur et les identifiants de votre compte.', weatherData: 'Données météo', weatherConditions: 'Conditions météo', cropCoefficient: 'Coefficient cultural', locationAvailable: 'La position est disponible.', locationUnavailable: 'Impossible de sélectionner la position de la ferme.', invalidAccountLink: 'Saisissez l’URL du serveur, le nom d’utilisateur et le mot de passe.', invalidEmail: 'Saisissez une adresse e-mail valide.'},
  it: {requestSaved: 'Salvata.', emptyRuns: 'Nessuna apertura della valvola registrata.', sensorAdvice: 'Consiglio dei sensori', loginHelp: 'Accedi con Demo farmer / demo oppure crea un account locale.', accountLinkHelp: 'Inserisci l’URL del server e le credenziali del tuo account.', weatherData: 'Dati meteo', weatherConditions: 'Condizioni meteo', cropCoefficient: 'Coefficiente colturale', locationAvailable: 'La posizione è disponibile.', locationUnavailable: 'Impossibile selezionare la posizione dell’azienda agricola.', invalidAccountLink: 'Inserisci l’URL del server, il nome utente e la password.', invalidEmail: 'Inserisci un indirizzo e-mail valido.'},
  es: {requestSaved: 'Guardada.', emptyRuns: 'Todavía no hay aperturas de válvula registradas.', sensorAdvice: 'Recomendación de los sensores', loginHelp: 'Inicia sesión con Demo farmer / demo o crea una cuenta local.', accountLinkHelp: 'Introduce la URL del servidor y las credenciales de tu cuenta.', weatherData: 'Datos meteorológicos', weatherConditions: 'Condiciones meteorológicas', cropCoefficient: 'Coeficiente de cultivo', locationAvailable: 'La ubicación está disponible.', locationUnavailable: 'No se puede seleccionar la ubicación de la finca.', invalidAccountLink: 'Introduce la URL del servidor, el nombre de usuario y la contraseña.', invalidEmail: 'Introduce una dirección de correo electrónico válida.'},
  pt: {requestSaved: 'Guardado.', emptyRuns: 'Ainda não há aberturas de válvula registadas.', sensorAdvice: 'Recomendação dos sensores', loginHelp: 'Inicie sessão com Demo farmer / demo ou crie uma conta local.', accountLinkHelp: 'Introduza o URL do servidor e as credenciais da sua conta.', weatherData: 'Dados meteorológicos', weatherConditions: 'Condições meteorológicas', cropCoefficient: 'Coeficiente cultural', locationAvailable: 'A localização está disponível.', locationUnavailable: 'Não é possível selecionar a localização da quinta.', invalidAccountLink: 'Introduza o URL do servidor, o nome de utilizador e a palavra-passe.', invalidEmail: 'Introduza um endereço de e-mail válido.'},
  lg: {requestSaved: 'Kiterekeddwa.', emptyRuns: 'Tewali kufukirira kwa vvaalu kuwandiikiddwa.', sensorAdvice: 'Amagezi agava mu bipima', loginHelp: 'Yingira ng’okozesa Demo farmer / demo oba okole akawunti ey’omu kitundu.', accountLinkHelp: 'Teekamu URL ya seva n’ebikozesebwa mu akawunti yo.', weatherData: 'Ebikwata ku mbeera y’obudde', weatherConditions: 'Embeera y’obudde', cropCoefficient: 'Omugerageranyo gw’ekirime', locationAvailable: 'Ekifo kisobola okukozesebwa.', locationUnavailable: 'Tekisobose kulonda kifo kya faamu.', invalidAccountLink: 'Teekamu URL ya seva, erinnya ly’omukozesa n’ekigambo ky’okuyingira.', invalidEmail: 'Teekamu endagiriro ya email entuufu.', trendNoteMeasured: 'Geraageranya enkuba n’amazzi agakozeseddwa mu kufukirira agapimiddwa mu wiiki ewedde.'},
};

export function applyPublicCopy(instance: I18nInstance): void {
  for (const [language, copy] of Object.entries(PUBLIC_COPY)) {
    instance.addResourceBundle(language, 'settings', {requestSaved: copy.requestSaved}, true, true);
    instance.addResourceBundle(language, 'devices', {
      irrigationOutcomes: {empty: copy.emptyRuns},
      zone: {water: {drivenByBalance: copy.sensorAdvice}},
      environment: {
        water: {...(copy.trendNoteMeasured ? {trendNoteMeasured: copy.trendNoteMeasured} : {})},
        source: {meteoswiss: 'MeteoSwiss', illustrative: copy.weatherData, weatherData: copy.weatherData, weatherConditions: copy.weatherConditions, cropCoefficient: copy.cropCoefficient},
        description: {weatherConditions: copy.weatherConditions},
      },
      zoneConfig: {locationAvailable: copy.locationAvailable, locationUnavailable: copy.locationUnavailable},
    }, true, true);
    instance.addResourceBundle(language, 'auth', {login: {demoHelp: copy.loginHelp}}, true, true);
    instance.addResourceBundle(language, 'accountLink', {
      form: {demoNotice: copy.accountLinkHelp},
      errors: {publicInvalidAccountLink: copy.invalidAccountLink, publicInvalidEmail: copy.invalidEmail},
    }, true, true);
    instance.addResourceBundle(language, 'history', {history: {source: {weatherData: copy.weatherData}}}, true, true);
    instance.addResourceBundle(language, 'common', {analysis: {tray: {weatherData: copy.weatherData}}}, true, true);
  }
}
